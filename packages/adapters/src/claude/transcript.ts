// Claude Code's transcript: the signals hooks cannot give — titles (`ai-title`, `custom-title`), interrupt markers,
// usage → context %, `cost-state` — read only through the kit's JSONL tailer: a watcher reads appended lines, reconcile
// reads the last L.transcriptTailBytes.

import type { AgentEvent } from '@kea/protocol'
import { JsonlTailer, parseLine, readTail } from '../kit/jsonl.ts'
import type { ReconcileResult, SessionRecord, TranscriptWatch, WatchFile } from '../types.ts'
import { COMMAND_RECORD_PREFIXES, CONTEXT_WINDOWS, INTERRUPT_PREFIX, NOT_PROMPT_FLAGS, SLASH_COMMAND_RE, TRANSCRIPT as T } from './contract.ts'

/** What one transcript record says. */
export type TranscriptSignal =
  | { k: 'title'; title: string; source: 'agent' | 'user' }
  | { k: 'interrupt' }
  | { k: 'cost'; usd: number }
  | { k: 'assistant'; model: string | null; contextTokens: number | null; endTurn: boolean; toolUse: boolean }
  | { k: 'user'; toolResult: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The text parts of a message's content (a string, or an array of `{type: 'text', text}` and other blocks). */
function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.filter((c) => isObj(c) && c.type === T.text && typeof c.text === 'string').map((c) => (c as { text: string }).text)
}

function hasBlock(content: unknown, type: string): boolean {
  return Array.isArray(content) && content.some((c) => isObj(c) && c.type === type)
}

/** One record → its signal, or null for records Kea does not read. Sidechain (subagent) records are skipped. */
export function transcriptSignal(r: Record<string, unknown>): TranscriptSignal | null {
  const type = r[T.type]
  if (r[T.sidechain] === true) return null
  if (type === T.aiTitle && typeof r[T.aiTitleField] === 'string' && r[T.aiTitleField]) return { k: 'title', title: r[T.aiTitleField] as string, source: 'agent' }
  if (type === T.customTitle && typeof r[T.customTitleField] === 'string' && r[T.customTitleField]) return { k: 'title', title: r[T.customTitleField] as string, source: 'user' }
  if (type === T.costState) {
    const usd = typeof r[T.costField] === 'number' ? r[T.costField] : r[T.costFieldOld]
    return typeof usd === 'number' && Number.isFinite(usd) ? { k: 'cost', usd } : null
  }
  const m = r[T.message]
  if (!isObj(m)) return null
  if (type === T.user) {
    const t = texts(m[T.content])
    if (t.some((x) => x.startsWith(INTERRUPT_PREFIX))) return { k: 'interrupt' }
    if (NOT_PROMPT_FLAGS.some((f) => r[f] === true)) return null
    if (t.some((x) => SLASH_COMMAND_RE.test(x) || COMMAND_RECORD_PREFIXES.some((p) => x.trimStart().startsWith(p)))) return null
    return { k: 'user', toolResult: hasBlock(m[T.content], T.toolResult) }
  }
  if (type === T.assistant) {
    const u = m[T.usage]
    let contextTokens: number | null = null
    if (isObj(u)) {
      const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
      contextTokens = n(T.inputTokens) + n(T.cacheCreation) + n(T.cacheRead)
    }
    return { k: 'assistant', model: typeof m[T.model] === 'string' ? (m[T.model] as string) : null, contextTokens, endTurn: m[T.stopReason] === T.endTurn, toolUse: hasBlock(m[T.content], T.toolUse) }
  }
  return null
}

/** Context used, in percent of the model's window; null for a model whose window the adapter does not know. */
export function contextPct(model: string | null, tokens: number | null): number | null {
  if (model === null || tokens === null) return null
  let w: (typeof CONTEXT_WINDOWS)[number] | undefined
  for (const x of CONTEXT_WINDOWS) if (model.startsWith(x.prefix) && (!w || x.prefix.length > w.prefix.length)) w = x
  if (!w) return null
  return Math.min(100, Math.round((tokens / w.tokens) * 1000) / 10)
}

/** A signal → the events a watcher emits (the mapping's transcript rows). */
export function transcriptEvents(s: TranscriptSignal): AgentEvent[] {
  switch (s.k) {
    case 'title':
      return [{ t: 'meta', title: s.title, titleSource: s.source }]
    case 'interrupt':
      return [{ t: 'turn.interrupted' }]
    case 'cost':
      return [{ t: 'meta', costUsd: s.usd }]
    case 'assistant': {
      const pct = contextPct(s.model, s.contextTokens)
      return pct === null ? [] : [{ t: 'meta', contextUsedPct: pct }]
    }
    case 'user':
      return []
  }
}

/** The lines → events, in order. */
export function eventsOfLines(lines: readonly string[]): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const l of lines) {
    const r = parseLine(l)
    const s = r ? transcriptSignal(r) : null
    if (s) out.push(...transcriptEvents(s))
  }
  return out
}

/**
 * Reconcile over the tail's lines: the last title (a custom one wins), the cost, the context, and the status the last
 * message implies.
 */
export function reconcileLines(lines: readonly string[]): ReconcileResult {
  let agentTitle: string | null = null
  let userTitle: string | null = null
  let cost: number | null = null
  let ctx: number | null = null
  let model: string | null = null
  let phase: ReconcileResult['phase'] = null
  for (const l of lines) {
    const r = parseLine(l)
    const s = r ? transcriptSignal(r) : null
    if (!s) continue
    switch (s.k) {
      case 'title':
        if (s.source === 'user') userTitle = s.title
        else agentTitle = s.title
        break
      case 'cost':
        cost = s.usd
        break
      case 'interrupt':
        phase = 'interrupted'
        break
      case 'assistant': {
        if (s.model) model = s.model
        const pct = contextPct(s.model, s.contextTokens)
        if (pct !== null) ctx = pct
        // a pending tool use: working or awaiting permission, shown as working until a live signal says otherwise
        phase = s.toolUse ? 'working' : s.endTurn ? 'finished' : 'working'
        break
      }
      case 'user':
        // a prompt or a tool result: the model answers next
        phase = 'working'
        break
    }
  }
  const out: ReconcileResult = { phase }
  if (userTitle !== null) out.title = { title: userTitle, source: 'user' }
  else if (agentTitle !== null) out.title = { title: agentTitle, source: 'agent' }
  if (cost !== null) out.costUsd = cost
  if (ctx !== null) out.contextUsedPct = ctx
  if (model !== null) out.model = model
  return out
}

/** The tail of the stored transcript path (never reconstructed), at most L.transcriptTailBytes read. */
export async function reconcile(session: Pick<SessionRecord, 'transcriptPath'>): Promise<ReconcileResult> {
  if (!session.transcriptPath) return { phase: null }
  const tail = readTail(session.transcriptPath)
  return tail ? reconcileLines(tail.lines) : { phase: null }
}

/**
 * The transcript watcher: from the end of the file as it is now (a fresh session's file starts empty), every
 * appended line's events. The caller owns its life (only while starting, working or blocked).
 */
export function watchTranscript(session: Pick<SessionRecord, 'transcriptPath'>, watch: WatchFile, emit: (e: AgentEvent) => void, from?: number): TranscriptWatch {
  const file = session.transcriptPath
  if (!file) return { position: from ?? 0, dispose() {} }
  const tailer = new JsonlTailer(file, from !== undefined ? { from } : {})
  const drain = () => {
    // read until caught up, one capped read at a time; a read that makes no progress (unreadable) stops it
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
      drain() // a record appended since the last notification (U-AGT-19)
    },
  }
}
