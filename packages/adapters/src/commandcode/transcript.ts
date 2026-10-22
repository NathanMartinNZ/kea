// Command Code's transcript (format version 3): what reconcile reads when Kea starts again and when the agent
// has exited. Live, the session mod reports everything, so there is no transcript watcher: the
// files are read only here, through the kit's readers (at most L.transcriptTailBytes, never whole).
//
//   <config dir>/projects/<slug>/<id>.jsonl               a `session` header, then one `message` record per message
//   <config dir>/projects/<slug>/<id>.meta.json           `{"title": …, "userRenamed"?: true}`
//   <config dir>/projects/<slug>/<id>.checkpoints.jsonl   one record per prompt, written as the prompt is sent
//
// Records are appended only when a model step commits (its prompt, its answer and its tool results together), and an
// interrupted turn leaves none. So the transcript proves one thing: a turn that ended with an answer, when no prompt
// was sent after it. Everything else (a turn under way, an interrupt) is the mod's to say, and the stored status,
// with the mod's spooled events applied first, stands.

import { L } from '@kea/protocol'
import { parseLine, readLastLine, readSmall, readTail } from '../kit/jsonl.ts'
import type { ReconcileResult, SessionRecord } from '../types.ts'
import { CHECKPOINT_AT, CHECKPOINTS_EXT, META_EXT, META_TITLE, META_USER_RENAMED, TRANSCRIPT as T, TRANSCRIPT_DENIED, TRANSCRIPT_ERROR_PREFIX, TRANSCRIPT_EXT } from './contract.ts'
import { isSessionName } from './launch.ts'

/** What one transcript record says (`at`: when it was written, ms; null when the record has no time). */
export type TranscriptSignal = { at: number | null } & (
  | { k: 'assistant'; model: string | null; toolUse: boolean; costUsd: number | null }
  /** A prompt, or tool results (the model answers next). */
  | { k: 'user'; toolResult: boolean }
  /** The person refused a tool: the run ended there. */
  | { k: 'denied' }
  /** The run failed (its error is the record's text). */
  | { k: 'error' }
)

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function blocks(content: unknown, type: string): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter((c): c is Record<string, unknown> => isObj(c) && c[T.type] === type) : []
}

/** The text parts of a content array (a tool result's content is one too). */
function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  return blocks(content, T.text)
    .map((c) => c[T.text])
    .filter((t): t is string => typeof t === 'string')
}

function time(v: unknown): number | null {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? ms : null
}

/** One record → its signal, or null for records Kea does not read (the header, anything of a later format). */
export function transcriptSignal(r: Record<string, unknown>): TranscriptSignal | null {
  if (r[T.type] !== T.record) return null
  const m = r[T.message]
  if (!isObj(m)) return null
  const at = time(r[T.timestamp])
  const content = m[T.content]
  if (m[T.role] === T.assistant) {
    const u = r[T.usage]
    const cost = isObj(u) && typeof u[T.cost] === 'number' && Number.isFinite(u[T.cost]) && (u[T.cost] as number) >= 0 ? (u[T.cost] as number) : null
    return { at, k: 'assistant', model: typeof r[T.model] === 'string' ? (r[T.model] as string) : null, toolUse: blocks(content, T.toolUse).length > 0, costUsd: cost }
  }
  if (m[T.role] !== T.user) return null
  const results = blocks(content, T.toolResult)
  if (results.length) return results.some((b) => texts(b[T.content]).some((t) => t === TRANSCRIPT_DENIED)) ? { at, k: 'denied' } : { at, k: 'user', toolResult: true }
  const meta = m[T.meta]
  if ((!isObj(meta) || meta[T.source] === undefined) && texts(content).some((t) => t.startsWith(TRANSCRIPT_ERROR_PREFIX))) return { at, k: 'error' }
  return { at, k: 'user', toolResult: false }
}

/**
 * Reconcile the tail's lines. `phase`: `finished` when the last record is an answer without a tool call (or a refused
 * tool, which ends the run) and no prompt was sent after it (`promptAt`: the last checkpoint's time, null when there is
 * none); otherwise null, which leaves the stored status. `whole`: the lines are the whole file, so the sum of the
 * records' costs is the conversation's; a sum over a cut tail would be too low, and is left out.
 */
export function reconcileLines(lines: readonly string[], o: { whole?: boolean; promptAt?: number | null } = {}): ReconcileResult {
  let last: TranscriptSignal | null = null
  let model: string | null = null
  let cost: number | null = null
  for (const l of lines) {
    const r = parseLine(l)
    const s = r ? transcriptSignal(r) : null
    if (!s) continue
    last = s
    if (s.k === 'assistant') {
      if (s.model) model = s.model
      if (s.costUsd !== null) cost = (cost ?? 0) + s.costUsd
    }
  }
  const ended = last !== null && (last.k === 'denied' || (last.k === 'assistant' && !last.toolUse))
  // a prompt sent after the last record: a turn the transcript does not show yet (under way, or interrupted)
  const later = last !== null && o.promptAt !== null && o.promptAt !== undefined && (last.at === null || o.promptAt > last.at)
  const out: ReconcileResult = { phase: ended && !later ? 'finished' : null }
  if (model !== null) out.model = model
  if (cost !== null && o.whole !== false) out.costUsd = Math.round(cost * 1e6) / 1e6
  return out
}

/** `<id>.jsonl` → the file beside it with another ending, or null for a path that is not a transcript's. */
export function beside(transcriptPath: string, ext: string): string | null {
  return transcriptPath.endsWith(TRANSCRIPT_EXT) ? transcriptPath.slice(0, -TRANSCRIPT_EXT.length) + ext : null
}

/**
 * The title in a meta file's text and whose it is (`userRenamed`: the person's own); null when there is none, or it is
 * a name Kea itself gave the conversation (launch.ts).
 */
export function metaTitle(text: string): { title: string; source: 'agent' | 'user' } | null {
  const o = parseLine(text.trim())
  const t = o?.[META_TITLE]
  if (typeof t !== 'string') return null
  const title = t.replace(/\s+/g, ' ').trim()
  if (title === '' || isSessionName(title)) return null
  return { title, source: o?.[META_USER_RENAMED] === true ? 'user' : 'agent' }
}

/** When the last prompt was sent, from a checkpoint line; null when the line says nothing usable. */
export function checkpointAt(line: string | null): number | null {
  return line === null ? null : time(parseLine(line)?.[CHECKPOINT_AT])
}

/** The stored transcript path's tail and the two files beside it (never a path Kea made up). */
export async function reconcile(session: Pick<SessionRecord, 'transcriptPath'>): Promise<ReconcileResult> {
  const file = session.transcriptPath
  if (!file) return { phase: null }
  const tail = readTail(file)
  const checkpoints = beside(file, CHECKPOINTS_EXT)
  const promptAt = checkpoints ? checkpointAt(readLastLine(checkpoints, L.transcriptTailBytes)) : null
  const out = tail ? reconcileLines(tail.lines, { whole: tail.bytesRead >= tail.size, promptAt }) : { phase: null }
  const meta = beside(file, META_EXT)
  const text = meta ? readSmall(meta, L.ccMetaFileMaxBytes) : null
  const title = text ? metaTitle(text) : null
  if (title) out.title = title
  return out
}
