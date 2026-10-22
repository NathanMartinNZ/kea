// Claude Code signal → AgentEvent, as a table with one row per hook event, plus the per-session state the mapping
// needs: the in-tier dedupe of the late `Notification(permission_prompt)`, the agent's session ids (a `/clear` starts a
// new one; the status file's `sessionId` is checked against them) and the open turn tier 1b's interrupt rule reads.
//
// Payloads arrive projected by kea-helper: strings at most L.hookSummaryMaxChars, arrays counted, `tool_input`
// reduced to its command, path, url, pattern or (compact JSON) questions.

import { L, type AgentEvent, type FailureKind, type StatusFileReading } from '@kea/protocol'
import type { RawAgentSignal, SessionSignals } from '../types.ts'
import {
  FAILURE_KINDS,
  FIELDS,
  NOTIFICATION,
  QUESTION_TEXT_RE,
  QUESTION_TOOL,
  START_SOURCES,
  STATUS_FILE,
  STATUS_VALUES,
  TASK_NOTIFICATION_PREFIX,
  WAITING_FOR,
  type HookEvent,
} from './contract.ts'
import { modeFromPayload } from './launch.ts'

type Payload = Record<string, unknown>

/** The value at a dotted path of a (projected) payload. */
export function field(p: Payload, path: string): unknown {
  let v: unknown = p
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
    v = (v as Record<string, unknown>)[k]
  }
  return v
}

function str(p: Payload, path: string): string | undefined {
  const v = field(p, path)
  return typeof v === 'string' ? v : undefined
}

function num(p: Payload, path: string): number {
  const v = field(p, path)
  return typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : 0
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The first question's text of a summarised `tool_input.questions` (compact JSON, possibly cut). */
export function questionText(summary: string | undefined): string | undefined {
  if (!summary) return undefined
  const m = QUESTION_TEXT_RE.exec(summary)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1]
  }
}

/** One line describing a tool call's input: its command, file, url, pattern or question. */
export function toolSummary(p: Payload): string {
  const q = questionText(str(p, FIELDS.toolQuestions))
  const s = str(p, FIELDS.toolCommand) ?? str(p, FIELDS.toolFilePath) ?? str(p, FIELDS.toolUrl) ?? str(p, FIELDS.toolPattern) ?? q ?? ''
  return oneLine(s)
}

/** An attention key: tool name + one-line input summary (`PermissionRequest` has no `tool_use_id`). */
export function toolKey(p: Payload): string {
  const tool = str(p, FIELDS.toolName) ?? ''
  const s = toolSummary(p)
  return s ? `${tool}: ${s}` : tool
}

/** Keys of the attention items a Notification raises (no tool in its payload). */
export const NOTIFICATION_KEYS = { permission: 'notification:permission', question: 'notification:question' } as const

const isSubagent = (p: Payload) => {
  const id = str(p, FIELDS.agentId)
  return id !== undefined && id !== ''
}

/** `StopFailure.error` → kind: anything unknown is `other`. */
export function failureKind(error: string | undefined): FailureKind {
  return (error !== undefined && Object.hasOwn(FAILURE_KINDS, error) ? FAILURE_KINDS[error] : undefined) ?? 'other'
}

/** The per-payload context a row may read: the session's mapping state. */
interface Ctx {
  /** A `PermissionRequest` arrived within L.permissionDedupeMs before this payload. */
  recentPermission: boolean
}

type Row = (p: Payload, c: Ctx) => AgentEvent[]

const toolStarted = (p: Payload): AgentEvent => ({ t: 'tool.started', name: str(p, FIELDS.toolName) ?? '', summary: toolSummary(p), ...(isSubagent(p) ? { subagent: true } : {}) })
const toolFinished = (p: Payload, ok: boolean): AgentEvent => ({ t: 'tool.finished', name: str(p, FIELDS.toolName) ?? '', summary: toolSummary(p), ok, ...(isSubagent(p) ? { subagent: true } : {}) })
const question = (p: Payload): AgentEvent => ({ t: 'attention.question', key: toolKey(p), summary: toolSummary(p) || (str(p, FIELDS.toolName) ?? '') })

/** One row per hook event. Events not listed (MessageDisplay, PostToolBatch, SubagentStart, …) map to nothing. */
export const HOOK_MAPPING: Readonly<Record<HookEvent | 'SubagentStop', Row>> = {
  SessionStart: (p) => {
    const src = str(p, FIELDS.source)
    const source = (START_SOURCES as readonly string[]).includes(src ?? '') ? (src as (typeof START_SOURCES)[number]) : 'startup'
    const tp = str(p, FIELDS.transcriptPath)
    return [{ t: 'session.started', agentSessionId: str(p, FIELDS.sessionId) ?? '', ...(tp && tp.endsWith('.jsonl') ? { transcriptPath: tp } : {}), source }]
  },
  UserPromptSubmit: (p) => [(str(p, FIELDS.prompt) ?? '').startsWith(TASK_NOTIFICATION_PREFIX) ? { t: 'turn.started', trigger: 'background' } : { t: 'turn.started' }],
  PreToolUse: (p) => (str(p, FIELDS.toolName) === QUESTION_TOOL ? [toolStarted(p), question(p)] : [toolStarted(p)]),
  PermissionRequest: (p) => (str(p, FIELDS.toolName) === QUESTION_TOOL ? [question(p)] : [{ t: 'attention.permission', key: toolKey(p), tool: str(p, FIELDS.toolName) ?? '', summary: toolSummary(p) }]),
  PostToolUse: (p) => [toolFinished(p, true), { t: 'attention.cleared', key: toolKey(p) }],
  PostToolUseFailure: (p) => [toolFinished(p, false), { t: 'attention.cleared', key: toolKey(p) }],
  PermissionDenied: (p) => [toolFinished(p, false), { t: 'attention.cleared', key: toolKey(p) }],
  Notification: (p, c) => {
    const kind = str(p, FIELDS.notificationType)
    const message = str(p, FIELDS.message) ?? ''
    if (kind === NOTIFICATION.permission) return c.recentPermission ? [] : [{ t: 'attention.permission', key: NOTIFICATION_KEYS.permission, summary: message }]
    if (kind === NOTIFICATION.elicitation) return [{ t: 'attention.question', key: NOTIFICATION_KEYS.question, summary: message }]
    return [] // idle_prompt, agent_needs_input and anything new: ignored
  },
  Stop: (p) => {
    if (isSubagent(p)) return [] // subagents fire SubagentStop; never finishes the turn
    const last = str(p, FIELDS.lastAssistantMessage)
    return [{ t: 'turn.finished', ...(last ? { lastMessage: last } : {}), backgroundWork: num(p, FIELDS.backgroundTasks) > 0 || num(p, FIELDS.sessionCrons) > 0 }]
  },
  SubagentStop: () => [],
  StopFailure: (p) => {
    const error = str(p, FIELDS.error)
    const text = str(p, FIELDS.lastAssistantMessage) ?? error ?? 'the turn failed'
    return [{ t: 'turn.failed', error: text, kind: failureKind(error) }]
  },
  PreCompact: () => [{ t: 'compacting', active: true }],
  PostCompact: () => [{ t: 'compacting', active: false }],
  SessionEnd: (p) => {
    const reason = str(p, FIELDS.reason)
    return [{ t: 'session.ended', ...(reason ? { reason } : {}) }]
  },
}

/** Fields any payload may carry that become `meta`: model, title (custom name), effort, permission mode. */
function meta(p: Payload, event: string): AgentEvent | null {
  const m: Extract<AgentEvent, { t: 'meta' }> = { t: 'meta' }
  const mode = str(p, FIELDS.permissionMode)
  if (mode) m.permissionMode = modeFromPayload(mode)
  const effort = str(p, FIELDS.effortLevel)
  if (effort) m.effort = effort
  if (event === 'SessionStart') {
    const model = str(p, FIELDS.model)
    if (model) m.model = model
    const title = str(p, FIELDS.sessionTitle)
    if (title) {
      m.title = title
      m.titleSource = 'user'
    }
  }
  return Object.keys(m).length > 1 ? m : null
}

/**
 * A payload → events (pure, given the context): the row's events, then `meta` when the payload carries any. Unknown
 * events give nothing (forward-compatible; counted by the caller).
 */
export function normalise(p: Payload, c: Ctx = { recentPermission: false }): AgentEvent[] {
  const event = str(p, FIELDS.event)
  if (!event || !Object.hasOwn(HOOK_MAPPING, event)) return []
  const out = HOOK_MAPPING[event as keyof typeof HOOK_MAPPING](p, c)
  const m = meta(p, event)
  return m ? [...out, m] : out
}

/** Is this a known hook event (the rest are counted as unknown)? */
export function knownEvent(p: Payload): boolean {
  const e = str(p, FIELDS.event)
  return e !== undefined && Object.hasOwn(HOOK_MAPPING, e)
}

// ── tier 1b: the status file ──────────────────────────────────────────────────────────────────────────

/** A status file parsed: its session id and Kea's reading of it (null: just registered, no status yet), or why it is not one. */
export type ParsedStatusFile =
  | { ok: true; sessionId: string; pid: number | null; reading: StatusFileReading | null; unknownWait?: true }
  | { ok: false; why: 'unparsable' | 'unknownStatus' }

/**
 * Parse a status file's text: a torn read is unparsable and an unknown `status` is ignored (K-FX-7); a file
 * just registered has no `status` yet (`reading: null`: not an unknown value, and still the agent's file — it proves
 * the trust dialog was answered). A waiting session never reads as not waiting: an unknown `waitingFor` is an
 * estimated question carrying the raw value (`unknown`, counted; shown, never notified).
 */
export function parseStatusFile(text: string): ParsedStatusFile {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return { ok: false, why: 'unparsable' }
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return { ok: false, why: 'unparsable' }
  const r = o as Record<string, unknown>
  const sessionId = r[STATUS_FILE.sessionId]
  const status = r[STATUS_FILE.status]
  if (typeof sessionId !== 'string') return { ok: false, why: 'unparsable' }
  const pid = typeof r[STATUS_FILE.pid] === 'number' ? (r[STATUS_FILE.pid] as number) : null
  if (status === undefined || status === null) return { ok: true, sessionId, pid, reading: null }
  if (typeof status !== 'string' || !(STATUS_VALUES as readonly string[]).includes(status)) return { ok: false, why: 'unknownStatus' }
  if (status !== 'waiting') return { ok: true, sessionId, pid, reading: { status: status as StatusFileReading['status'] } }
  const w = r[STATUS_FILE.waitingFor]
  if (typeof w !== 'string' || !Object.hasOwn(WAITING_FOR, w)) {
    const detail = typeof w === 'string' ? w.slice(0, L.hookSummaryMaxChars) : undefined
    return { ok: true, sessionId, pid, reading: { status: 'waiting', waitingFor: 'unknown', ...(detail ? { detail } : {}) }, unknownWait: true }
  }
  return { ok: true, sessionId, pid, reading: { status: 'waiting', waitingFor: WAITING_FOR[w]!, detail: w } }
}

/**
 * One live Claude session's signal state (core keeps one per session): the hook normaliser with its dedupe, the
 * accepted session ids, and tier 1b's readings with the interrupt rule — a change from `busy`/`waiting` to `idle` or
 * `shell` with no `Stop` or `StopFailure` since the turn's `UserPromptSubmit` is an interrupted turn (Esc before any
 * output, Esc at a permission prompt, Esc during a tool). The interrupt is a candidate until `confirmInterrupt`:
 * a `Stop` delivered a moment after the file changed (hooks and file changes travel separately) cancels it.
 */
export class ClaudeSignals implements SessionSignals {
  /** The launch's id, the current one and the one before it: three slots, enough for /clear and resume races. */
  private readonly launchId: string | null
  private currentId: string | null
  private previousId: string | null = null
  private lastPermissionMs = Number.NEGATIVE_INFINITY
  private turnOpen = false
  /** Counts turns, so a candidate interrupt from an earlier turn never ends a later one. */
  private turnSeq = 0
  private last: StatusFileReading | null = null
  readonly ignored = { unknownStatus: 0, unknownWait: 0, foreignSession: 0, unparsable: 0, unknownEvent: 0 }

  constructor(agentSessionId: string | null) {
    this.launchId = agentSessionId
    this.currentId = agentSessionId
  }

  sessionIds(): ReadonlySet<string> {
    const s = new Set<string>()
    for (const id of [this.launchId, this.previousId, this.currentId]) if (id) s.add(id)
    return s
  }

  /** The conversation id later resumes target (updated on /clear). */
  get agentSessionId(): string | null {
    return this.currentId
  }

  hook(raw: RawAgentSignal): AgentEvent[] {
    const p = raw.payload
    if (!knownEvent(p)) {
      this.ignored.unknownEvent++
      return []
    }
    const event = str(p, FIELDS.event)
    const recentPermission = raw.monoMs - this.lastPermissionMs < L.permissionDedupeMs
    const out = normalise(p, { recentPermission })
    if (event === 'PermissionRequest') this.lastPermissionMs = raw.monoMs
    for (const e of out) {
      if (e.t === 'session.started' && e.agentSessionId && e.agentSessionId !== this.currentId) {
        this.previousId = this.currentId
        this.currentId = e.agentSessionId
      } else if (e.t === 'turn.started') {
        this.turnOpen = true
        this.turnSeq++
      } else if (e.t === 'turn.finished' || e.t === 'turn.failed' || e.t === 'turn.interrupted') {
        this.turnOpen = false
      }
    }
    return out
  }

  /** The last reading's status (a Stop while it is `busy` is read again: a Stop hook may keep the turn going). */
  get fileStatus(): StatusFileReading['status'] | null {
    return this.last?.status ?? null
  }

  statusFile(text: string | null, again = false): { reading: StatusFileReading | null; registered: boolean; events: AgentEvent[]; interruptCandidate: number | null } {
    const none = { reading: null, registered: false, events: [], interruptCandidate: null }
    if (text === null) return none // removed: the PTY's exit ends the session
    const f = parseStatusFile(text)
    if (!f.ok) {
      this.ignored[f.why]++
      return none
    }
    if (!this.sessionIds().has(f.sessionId)) {
      this.ignored.foreignSession++
      return none
    }
    if (f.reading === null) return { ...none, registered: true }
    if (f.unknownWait) this.ignored.unknownWait++
    const prev = this.last
    // `again`: the same reading looked at again on purpose (after a Stop) is reported too
    if (prev && prev.status === f.reading.status && prev.waitingFor === f.reading.waitingFor) return again ? { ...none, reading: f.reading } : none
    this.last = f.reading
    const wasActive = prev !== null && (prev.status === 'busy' || prev.status === 'waiting')
    const nowIdle = f.reading.status === 'idle' || f.reading.status === 'shell'
    return { reading: f.reading, registered: false, events: [], interruptCandidate: wasActive && nowIdle && this.turnOpen ? this.turnSeq : null }
  }

  /** The candidate interrupt of turn `seq`, if that turn is still open with no Stop since. */
  confirmInterrupt(seq: number): AgentEvent[] {
    if (!this.turnOpen || this.turnSeq !== seq) return []
    this.turnOpen = false
    return [{ t: 'turn.interrupted' }]
  }

  /** Some other tier saw the turn end (a transcript interrupt marker): tier 1b's candidate is moot. */
  turnEnded(): void {
    this.turnOpen = false
  }
}
