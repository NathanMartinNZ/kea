// Command Code mod event → AgentEvent, as a table with one row per event, plus the
// per-session state the mapping needs: the agent's session ids (`/clear` starts a new one in the same process), the
// permission item the mod's timer raised, and whether a turn is open.
//
// Payloads arrive from kea-mod.ts through kea-helper, projected: strings at most L.hookSummaryMaxChars, a tool
// call's input reduced to its command, path, url or pattern, a run's result to its stop reason and final text.

import type { AgentEvent, FailureKind } from '@kea/protocol'
import type { RawAgentSignal, SessionSignals } from '../types.ts'
import { END_REASONS, FAILURE_STATUS, FAILURE_TEXT, FIELDS, MOD_EVENTS, SESSION_END, SESSION_START, START_SOURCES, STOP_ALREADY_REPORTED, TOOL_SUMMARY_FIELDS, TOOL_WAITING, TRANSCRIPT_EXT, type ModEvent } from './contract.ts'
import { isSessionName, modeFromEvent } from './launch.ts'

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

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** One line describing a tool call's input: its command, file, url or pattern. */
export function toolSummary(p: Payload): string {
  for (const f of TOOL_SUMMARY_FIELDS) {
    const s = str(p, FIELDS[f])
    if (s) return oneLine(s)
  }
  return ''
}

/** An attention key: the tool call's id (the mod names the call of the waiting batch that is being asked about), else tool + summary. */
export function toolKey(p: Payload): string {
  const id = str(p, FIELDS.toolCallId)
  if (id) return id
  const tool = str(p, FIELDS.toolName) ?? ''
  const s = toolSummary(p)
  return s ? `${tool}: ${s}` : tool
}

/** `run_error` → kind: its HTTP status when it has one, else its text; anything unknown is `other`. */
export function failureKind(status: unknown, text: string): FailureKind {
  if (typeof status === 'number' && Object.hasOwn(FAILURE_STATUS, status)) return FAILURE_STATUS[status]!
  return FAILURE_TEXT.find((f) => f.re.test(text))?.kind ?? 'other'
}

/** What a row may read of the session's state. */
interface Ctx {
  /** The key of the permission item the mod's timer raised and nothing has cleared yet. */
  waiting: string | null
  /** The session before this one ended as `replaced` (`/clear`, an in-session resume): the next start is its successor. */
  replaced: boolean
}

type Row = (p: Payload, c: Ctx) => AgentEvent[]

const cleared = (c: Ctx): AgentEvent[] => (c.waiting === null ? [] : [{ t: 'attention.cleared', key: c.waiting }])
const toolStarted = (p: Payload): AgentEvent => ({ t: 'tool.started', name: str(p, FIELDS.toolName) ?? '', summary: toolSummary(p) })
const toolFinished = (p: Payload, ok: boolean): AgentEvent => ({ t: 'tool.finished', name: str(p, FIELDS.toolName) ?? '', summary: toolSummary(p), ok })

/** One row per mod event. `tool_queued` never arrives (the mod keeps it) and maps to nothing if it does. */
export const MOD_MAPPING: Readonly<Record<ModEvent | typeof SESSION_START | typeof SESSION_END | typeof TOOL_WAITING, Row>> = {
  session_start: (p, c) => {
    const src = str(p, FIELDS.source)
    const resumed = src === START_SOURCES[1]
    const tp = str(p, FIELDS.transcript)
    const id = str(p, FIELDS.sessionId)
    if (!id) return []
    // a start that follows a replaced session is `/clear` (a new conversation) or an in-session resume
    return [{ t: 'session.started', agentSessionId: id, ...(tp && tp.endsWith(TRANSCRIPT_EXT) ? { transcriptPath: tp } : {}), source: resumed ? 'resume' : c.replaced ? 'clear' : 'startup' }]
  },
  session_shutdown: (p, c) => {
    const reason = str(p, FIELDS.reason)
    // replaced: the process goes on with another session, whose start follows
    if (reason === END_REASONS.replaced) return cleared(c)
    return [...cleared(c), { t: 'session.ended', ...(reason ? { reason } : {}) }]
  },
  // a run that starts while an item is open: its prompt was answered without an event that says so
  run_start: (_p, c) => [...cleared(c), { t: 'turn.started' }],
  tool_queued: () => [],
  // the prompt moved to another call of the batch (the one before was refused): the new item first, so that at no
  // moment there is none while a prompt is on screen
  kea_tool_waiting: (p, c) => {
    const key = toolKey(p)
    return [{ t: 'attention.permission', key, tool: str(p, FIELDS.toolName) ?? '', summary: toolSummary(p) }, ...(c.waiting !== null && c.waiting !== key ? cleared(c) : [])]
  },
  tool_running: (p, c) => [...cleared(c), toolStarted(p)],
  tool_completed: (p, c) => [...cleared(c), toolFinished(p, true)],
  tool_errored: (p, c) => [...cleared(c), toolFinished(p, false)],
  // a refusal answers one call: it clears the item of that call. An item for another call stays: the mod has just
  // moved it to the next prompt, or the batch is over and its tools' or the run's next event clears it
  tool_denied: (p, c) => (c.waiting !== null && c.waiting === str(p, FIELDS.toolCallId) ? cleared(c) : []),
  tool_hook_blocked: (_p, c) => cleared(c),
  run_end: (p, c) => {
    // an interrupt or an error was reported by its own event, just before
    if ((STOP_ALREADY_REPORTED as readonly string[]).includes(str(p, FIELDS.stopReason) ?? '')) return cleared(c)
    const last = str(p, FIELDS.finalText)
    return [...cleared(c), { t: 'turn.finished', ...(last ? { lastMessage: last } : {}), backgroundWork: false }]
  },
  interrupted: (_p, c) => [...cleared(c), { t: 'turn.interrupted' }],
  run_error: (p, c) => {
    const text = str(p, FIELDS.errorMessage) ?? str(p, FIELDS.error) ?? 'the turn failed'
    return [...cleared(c), { t: 'turn.failed', error: text, kind: failureKind(field(p, FIELDS.errorStatus), `${str(p, FIELDS.errorName) ?? ''} ${text}`) }]
  },
  session_titled: (p) => {
    const title = str(p, FIELDS.title)
    // a name Kea gave the conversation (a launch without the mod, resumed with it) is not its title
    return title && !isSessionName(title) ? [{ t: 'meta', title, titleSource: 'agent' }] : []
  },
  permission_mode_changed: (p) => {
    const mode = str(p, FIELDS.mode)
    return mode ? [{ t: 'meta', permissionMode: modeFromEvent(mode) }] : []
  },
  model_request_start: (p) => {
    const model = str(p, FIELDS.model)
    return model ? [{ t: 'meta', model }] : []
  },
  compaction_start: () => [{ t: 'compacting', active: true }],
  compaction_done: () => [{ t: 'compacting', active: false }],
}

/** Is this a known mod event (the rest are counted as unknown)? */
export function knownEvent(p: Payload): boolean {
  const e = str(p, FIELDS.event)
  return e !== undefined && Object.hasOwn(MOD_MAPPING, e)
}

/** A payload → events (pure, given the context). Unknown events give nothing (forward-compatible; counted by the caller). */
export function normalise(p: Payload, c: Ctx = { waiting: null, replaced: false }): AgentEvent[] {
  const event = str(p, FIELDS.event)
  if (!event || !Object.hasOwn(MOD_MAPPING, event)) return []
  return MOD_MAPPING[event as keyof typeof MOD_MAPPING](p, c)
}

/** Every event name the mapping has a row for (the contract's subscriptions and the mod's own three). */
export const MAPPED_EVENTS: readonly string[] = [...MOD_EVENTS, SESSION_START, SESSION_END, TOOL_WAITING]

/**
 * One live Command Code session's signal state (core keeps one per session): the normaliser with the permission item
 * it has open, and the accepted session ids. Command Code has no status file (tier 1b): those methods say nothing.
 */
export class CommandCodeSignals implements SessionSignals {
  /** The launch's id (a resume's; a new conversation has none until the mod's first event), the current one and the one before. */
  private readonly launchId: string | null
  private currentId: string | null
  private previousId: string | null = null
  private waiting: string | null = null
  private replaced = false
  /** How the current session started, for the start repeated with its transcript path. */
  private source: Extract<AgentEvent, { t: 'session.started' }>['source'] = 'startup'
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

  /** The conversation id later resumes target (the latest one, so after `/clear` the new conversation). */
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
    const out = normalise(p, { waiting: this.waiting, replaced: this.replaced })
    if (event === SESSION_END) this.replaced = str(p, FIELDS.reason) === END_REASONS.replaced
    else if (event === SESSION_START) this.replaced = false
    for (const e of out) {
      if (e.t === 'session.started') {
        this.source = e.source
        if (e.agentSessionId !== this.currentId) {
          this.previousId = this.currentId
          this.currentId = e.agentSessionId
        }
      } else if (e.t === 'attention.permission') {
        this.waiting = e.key
      } else if (e.t === 'attention.cleared' && (e.key === undefined || e.key === this.waiting)) {
        this.waiting = null
      }
    }
    const tp = str(p, FIELDS.transcript)
    const transcriptPath = tp && tp.endsWith(TRANSCRIPT_EXT) ? tp : undefined
    const id = str(p, FIELDS.sessionId)
    if (event !== SESSION_START && event !== SESSION_END && id && id !== this.currentId) {
      // an event of another conversation than the one held, with no start before it. Every payload carries the id the
      // mod holds, and the mod takes a new one from `run_start` too (kea-mod.ts), so the CLI went on to another
      // conversation without a session hook (not known to happen on 1.79.2), or the start's hook never reached Kea.
      // That is a start: said as one (journaled), under the new id, with the transcript's path if the mod has it,
      // so that later resumes target this conversation and its transcript is never stored as the one before's. In the
      // same process as another conversation it is what `/clear` is; with none before it, the launch's own start
      this.source = this.currentId === null ? this.source : 'clear'
      this.replaced = false
      this.previousId = this.currentId
      this.currentId = id
      out.unshift({ t: 'session.started', agentSessionId: id, ...(transcriptPath ? { transcriptPath } : {}), source: this.source })
    } else if (event !== SESSION_START && transcriptPath && this.currentId) {
      // a transcript path the mod found later (the file appears with the session's first committed turn): the
      // session's start again, now with its path, which is how core learns a transcript (the phase does not change).
      // Marked as a repeat: nothing started now, so "Why this status?" must not say so in the middle of a turn
      out.unshift({ t: 'session.started', agentSessionId: this.currentId, transcriptPath, source: this.source, repeated: true })
    }
    return out
  }

  statusFile(): { reading: null; registered: boolean; events: AgentEvent[]; interruptCandidate: null } {
    return { reading: null, registered: false, events: [], interruptCandidate: null }
  }

  confirmInterrupt(): AgentEvent[] {
    return []
  }

  turnEnded(): void {
    // nothing here depends on it: the mod reports every way a turn ends
  }
}
