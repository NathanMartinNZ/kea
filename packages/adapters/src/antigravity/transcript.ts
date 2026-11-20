// Antigravity CLI's transcript (`<configDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`):
// watch roots, path ownership validation (`ownsTranscript`), bounded tail reconciliation (`reconcile`), and incremental
// append-only tailing (`watchTranscript`). Every read goes through `kit/jsonl.ts` (`O_NONBLOCK`, regular-file check,
// capped at `L.transcriptTailBytes`).

import path from 'node:path'
import { L, type AgentEvent } from '@kea/protocol'
import { JsonlTailer, parseLine, readTail } from '../kit/jsonl.ts'
import type { Env, ReconcileResult, SessionRecord, TranscriptWatch, WatchFile } from '../types.ts'
import { brainDir, configDir } from './config.ts'
import { TRANSCRIPT, TRANSCRIPT_EXT } from './contract.ts'

/**
 * The folder under which Antigravity CLI keeps its conversation transcripts (`<HOME>/.gemini/antigravity-cli`), or an
 * empty list when `HOME` is unset or relative.
 */
export function watchRoots(env: Readonly<Env>): string[] {
  const dir = configDir(env)
  return dir ? [dir] : []
}

/**
 * Whether `file` is an Antigravity CLI transcript path strictly inside `<HOME>/.gemini/antigravity-cli/brain/` ending
 * with `.jsonl`. Rejects relative paths, `..` traversals outside the brain directory, and non-`.jsonl` paths.
 */
export function ownsTranscript(file: string, env: Readonly<Env>): boolean {
  const root = brainDir(env)
  if (!root || !path.isAbsolute(file)) return false
  const prefix = path.resolve(root) + path.sep
  const resolved = path.resolve(file)
  return resolved.startsWith(prefix) && resolved.endsWith(TRANSCRIPT_EXT)
}

/**
 * Reconciles a sequence of JSONL lines from the tail of `transcript.jsonl`. Tracks the latest non-empty `model` slug
 * and derives the turn phase from the step records:
 * - `status === 'RUNNING'` → `'working'`
 * - `type === 'USER_INPUT'` or `type === 'GENERIC'` (tool output awaiting a follow-up planner step) → `'working'`
 * - `type === 'PLANNER_RESPONSE' && status === 'DONE'`:
 *   - non-empty `tool_calls` array → `'working'` (tool execution or confirmation still pending)
 *   - empty or absent `tool_calls` → `'finished'`
 * - `type === 'PLANNER_RESPONSE' && status === 'ERROR'` → `'interrupted'`
 */
export function reconcileLines(lines: readonly string[]): ReconcileResult {
  let phase: ReconcileResult['phase'] = null
  let lastModel: string | null = null

  for (const line of lines) {
    const r = parseLine(line)
    if (!r) continue

    const rawModel = r[TRANSCRIPT.modelField]
    if (typeof rawModel === 'string' && rawModel.trim().length > 0) {
      lastModel = rawModel.trim()
    }

    const type = r[TRANSCRIPT.stepTypeField]
    const status = r[TRANSCRIPT.stepStatusField]

    if (status === TRANSCRIPT.running) {
      phase = 'working'
    } else if (type === TRANSCRIPT.userInput || type === TRANSCRIPT.generic) {
      phase = 'working'
    } else if (type === TRANSCRIPT.plannerResponse) {
      if (status === TRANSCRIPT.done) {
        const toolCalls = r[TRANSCRIPT.toolCallsField]
        phase = Array.isArray(toolCalls) && toolCalls.length > 0 ? 'working' : 'finished'
      } else if (status === TRANSCRIPT.error) {
        phase = 'interrupted'
      }
    }
  }

  return {
    phase,
    ...(lastModel !== null ? { model: lastModel } : {}),
  }
}

/**
 * Reads at most the last `L.transcriptTailBytes` of `session.transcriptPath` and returns the reconciled phase and model.
 * Missing, unreadable, or empty files return `{ phase: null }`.
 */
export async function reconcile(session: Pick<SessionRecord, 'transcriptPath'>): Promise<ReconcileResult> {
  if (!session.transcriptPath) return { phase: null }
  const tail = readTail(session.transcriptPath, L.transcriptTailBytes)
  return tail ? reconcileLines(tail.lines) : { phase: null }
}

/** Maps newly appended transcript JSONL lines to `meta` events when a `PLANNER_RESPONSE` step carries a model slug. */
export function eventsOfLines(lines: readonly string[]): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const line of lines) {
    const r = parseLine(line)
    if (!r) continue
    if (r[TRANSCRIPT.stepTypeField] === TRANSCRIPT.plannerResponse) {
      const rawModel = r[TRANSCRIPT.modelField]
      if (typeof rawModel === 'string' && rawModel.trim().length > 0) {
        out.push({ t: 'meta', model: rawModel.trim() })
      }
    }
  }
  return out
}

/**
 * Incrementally tails an append-only `transcript.jsonl` from `from` (or the current end of the file), updating
 * `position` on every read and flushing any trailing bytes on `dispose()`.
 */
export function watchTranscript(
  session: Pick<SessionRecord, 'transcriptPath'>,
  watch: WatchFile,
  emit: (e: AgentEvent) => void,
  from?: number,
): TranscriptWatch {
  const file = session.transcriptPath
  if (!file) return { position: from ?? 0, dispose() {} }
  const tailer = new JsonlTailer(file, from !== undefined ? { from } : {})
  const drain = () => {
    for (;;) {
      const at = tailer.position
      for (const e of eventsOfLines(tailer.read())) emit(e)
      if (tailer.position === at || !tailer.behind) return
    }
  }
  const sub = watch(file, drain)
  drain()
  let done = false
  return {
    get position() {
      return tailer.position
    },
    dispose() {
      if (done) return
      done = true
      sub.dispose()
      drain()
    },
  }
}
