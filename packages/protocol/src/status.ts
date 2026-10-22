// The `status` feature's messages: the normalised agent events every adapter produces, what the window gets of each
// session's status beyond the `sessions` store's runtime fields, the account conditions, and the status calls ("Why
// this status?", reporting a wrong status, Continue all, what the window is viewing).
//
// What crosses the boundary: the `status` store (SessionStatus by session id, live sessions only) and the
// `status.conditions` store (AccountCondition by agent), both snapshot + deltas, and the `statusApi` calls. A session's
// phase, attention items, `unread`, `background` and `failureKind` are in the `sessions` store, written by core's
// status engine through the status batch; the glyph is derived there too (`sessionGlyph`). The attention order
// and the badge count are functions here, so core, the sidebar and `⌘J` agree.
import { z } from 'zod'
import { L } from './generated/limits.ts'
import { defineApi } from './rpc.ts'
import { zFailureKind, zPhase, zStatusSource, type FailureKind } from './enums.ts'
import { zAttentionItem, type SessionView } from './sessions.ts'
import { zSessionId } from './terminal.ts'

// ── normalised agent events ───────────────────────────────────────────────────────────────────────────────

export const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const

/** An agent event: what `adapter.normalise` returns and the status engine consumes. */
export const zAgentEvent = z.discriminatedUnion('t', [
  /**
   * `repeated`: no session started now. The adapter says the running session's start again because it has only now
   * found the transcript's path (Command Code): stored like any start's, and left out of the journal.
   */
  z.object({ t: z.literal('session.started'), agentSessionId: z.string(), transcriptPath: z.string().optional(), source: z.enum(SESSION_START_SOURCES), repeated: z.literal(true).optional() }),
  /** `background`: the agent resumed on its own (a background task finished), not a user prompt. */
  z.object({ t: z.literal('turn.started'), trigger: z.literal('background').optional() }),
  z.object({ t: z.literal('tool.started'), name: z.string(), summary: z.string().optional(), subagent: z.boolean().optional() }),
  z.object({ t: z.literal('tool.finished'), name: z.string(), summary: z.string().optional(), ok: z.boolean(), subagent: z.boolean().optional() }),
  /** `key` = tool + one-line input summary. */
  z.object({ t: z.literal('attention.permission'), key: z.string(), tool: z.string().optional(), summary: z.string().optional() }),
  z.object({ t: z.literal('attention.question'), key: z.string(), summary: z.string().optional() }),
  /** No key: clear all. */
  z.object({ t: z.literal('attention.cleared'), key: z.string().optional() }),
  z.object({ t: z.literal('turn.finished'), lastMessage: z.string().optional(), backgroundWork: z.boolean() }),
  z.object({ t: z.literal('turn.interrupted') }),
  /** `rate_limit`, `auth`, `billing` are account-level. `resetsAt`: wall ms. */
  z.object({ t: z.literal('turn.failed'), error: z.string(), kind: zFailureKind, resetsAt: z.number().optional() }),
  z.object({ t: z.literal('compacting'), active: z.boolean() }),
  z.object({ t: z.literal('session.ended'), reason: z.string().optional() }),
  z.object({
    t: z.literal('meta'),
    title: z.string().optional(),
    titleSource: z.enum(['agent', 'user']).optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    permissionMode: z.string().optional(),
    costUsd: z.number().optional(),
    contextUsedPct: z.number().optional(),
    linesAdded: z.number().optional(),
    linesRemoved: z.number().optional(),
  }),
])
export type AgentEvent = z.infer<typeof zAgentEvent>
export type AgentEventType = AgentEvent['t']
export const AGENT_EVENT_TYPES = [
  'session.started',
  'turn.started',
  'tool.started',
  'tool.finished',
  'attention.permission',
  'attention.question',
  'attention.cleared',
  'turn.finished',
  'turn.interrupted',
  'turn.failed',
  'compacting',
  'session.ended',
  'meta',
] as const satisfies readonly AgentEventType[]

/**
 * Tier 1b: one reading of the agent's live status file, as its adapter maps it. `shell` = idle while a background
 * shell runs (background work). `waitingFor`, for `waiting`: `permission` (a tool permission prompt → a permission
 * item), `question` (the agent asks for input → a question item), `other` (a dialog such as `/model`: not attention),
 * `unknown` (a value the adapter does not know: an estimated question item, shown but never notified: a guess is never
 * loud). `detail`: the adapter's words for the item's summary (an unknown wait's raw value). The engine takes a reading
 * through `StatusEngine.statusFile` (null: a file just registered, no status yet). A `busy` → `idle` change with no
 * `Stop` / `StopFailure` since the turn started (Esc before any output writes neither) is the adapter's to report as a
 * `turn.interrupted` event with source `status-file`, through `StatusEngine.ingest`.
 */
export const STATUS_FILE_STATES = ['busy', 'waiting', 'idle', 'shell'] as const
export const STATUS_FILE_WAITS = ['permission', 'question', 'other', 'unknown'] as const
export const zStatusFileReading = z.object({ status: z.enum(STATUS_FILE_STATES), waitingFor: z.enum(STATUS_FILE_WAITS).optional(), detail: z.string().optional() })
export type StatusFileReading = z.infer<typeof zStatusFileReading>

/** The failure kinds that belong to the account, not the session. */
export const ACCOUNT_KINDS = ['rate_limit', 'auth', 'billing'] as const satisfies readonly FailureKind[]
export type AccountKind = (typeof ACCOUNT_KINDS)[number]
export function isAccountKind(k: FailureKind | null | undefined): k is AccountKind {
  return k === 'rate_limit' || k === 'auth' || k === 'billing'
}

// ── the `status` store ────────────────────────────────────────────────────────────────────────────────────

export const STATUS_STORE = 'status'

/** What the window gets of a live session's status beyond the `sessions` store's runtime fields. */
export const zSessionStatus = z.object({
  sessionId: zSessionId,
  /** Restored from the database after a restart and not yet confirmed by a live signal or a reconcile. */
  unconfirmed: z.boolean(),
  /** The source of the last change (`status_source`); null before the first. */
  source: zStatusSource.nullable(),
  /** Wall ms of the last change (`status_at`). */
  at: z.number().int().nullable(),
  /** The spinner's tooltip says "compacting". */
  compacting: z.boolean(),
  /** Only terminal activity (tier 3) has been seen for this session: "Status is estimated from terminal activity". */
  estimated: z.boolean(),
})
export type SessionStatus = z.infer<typeof zSessionStatus>

// ── account conditions ───────────────────────────────────────────────────────────────────────────────────

export const CONDITIONS_STORE = 'status.conditions'

/**
 * One per agent. `active` while the condition lasts; `reset` once a usage limit's `resetsAt` has passed: the
 * footer line offers Continue all (the reset notification was posted) until the sessions continue or a turn of that
 * agent finishes.
 */
export const CONDITION_STATES = ['active', 'reset'] as const
export const zAccountCondition = z.object({
  agent: z.string(),
  kind: z.enum(ACCOUNT_KINDS),
  state: z.enum(CONDITION_STATES),
  /** Wall ms the condition opened. */
  since: z.number().int(),
  /** Wall ms; only for a usage limit whose reset time is known. */
  resetsAt: z.number().int().nullable(),
  /** The sessions the condition holds (failed with this kind), oldest first. */
  sessionIds: z.array(zSessionId),
})
export type AccountCondition = z.infer<typeof zAccountCondition>

/** The label of a row an account condition holds (and the footer line's words). */
export function conditionLabel(kind: AccountKind): string {
  return kind === 'rate_limit' ? 'limited' : kind === 'auth' ? 'signed out' : 'billing'
}

/** A wall time as the status surfaces show it: `15:00` (local time, 24-hour). */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * What one condition's footer line and menu-bar line say after the agent's name: `limited until 15:00`
 * (`limited since 14:02` without a reset time; `limit reset` once it has reset), `signed out` (`signed out — run
 * claude auth login` given the agent's login command, the `agents` row's `loginCommand`), `billing problem`.
 */
export function conditionText(c: Pick<AccountCondition, 'kind' | 'state' | 'since' | 'resetsAt'>, loginCommand?: string | null): string {
  if (c.kind === 'auth') return loginCommand ? `signed out — run ${loginCommand}` : 'signed out'
  if (c.kind === 'billing') return 'billing problem'
  if (c.state === 'reset') return 'limit reset'
  return c.resetsAt !== null ? `limited until ${clockTime(c.resetsAt)}` : `limited since ${clockTime(c.since)}`
}

// ── ordering and counting ────────────────────────────────────────────────────────────────────────────────

type Attn = Pick<SessionView, 'id' | 'lifecycle' | 'endReason' | 'phase' | 'attention' | 'unread' | 'failureKind' | 'lastActivityAt'>

const NONE_HELD: ReadonlySet<string> = new Set()

/** The sessions an account condition holds now: they count once in all, as the condition's own line. */
export function heldSessions(conditions: Iterable<Pick<AccountCondition, 'sessionIds'>>): Set<string> {
  const out = new Set<string>()
  for (const c of conditions) for (const id of c.sessionIds) out.add(id)
  return out
}

/**
 * The attention group of a session: 0 `blocked` (attention set non-empty), 1 `failed` or crashed / lost, 2
 * unread `ready`; null when it does not need the person. A session failed on an account-level kind that a condition
 * holds (`held`, `heldSessions`) is null: the condition stands for it. Once none holds it (the condition
 * cleared while it stayed failed) it is group 1 like any failure.
 */
export function attentionGroup(s: Attn, held: ReadonlySet<string> = NONE_HELD): 0 | 1 | 2 | null {
  if (s.lifecycle === 'live') {
    if (s.attention.length > 0 || s.phase === 'blocked') return 0
    if (s.phase === 'failed') return isAccountKind(s.failureKind) && held.has(s.id) ? null : 1
    if (s.phase === 'ready' && s.unread) return 2
    return null
  }
  if (s.lifecycle === 'detached' && (s.endReason === 'crashed' || s.endReason === 'lost')) return 1
  return null
}

/** When a session started needing the person: its oldest attention item, else its last activity. */
function since(s: Attn): number {
  let at = Number.POSITIVE_INFINITY
  for (const a of s.attention) at = Math.min(at, a.at)
  return Number.isFinite(at) ? at : s.lastActivityAt
}

/**
 * The sessions that need the person, in `⌘J`'s order: blocked, then failed and crashed, then unread ready; oldest
 * first in each. `held`: the sessions account conditions hold (left out, `attentionGroup`).
 */
export function attentionOrder<T extends Attn>(sessions: Iterable<T>, held: ReadonlySet<string> = NONE_HELD): T[] {
  const out: { s: T; g: number; at: number }[] = []
  for (const s of sessions) {
    const g = attentionGroup(s, held)
    if (g !== null) out.push({ s, g, at: since(s) })
  }
  out.sort((a, b) => a.g - b.g || a.at - b.at || (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0))
  return out.map((x) => x.s)
}

/** Sessions that need the person, where the sessions an account condition holds count once in total, as the condition. */
export function badgeCount(sessions: Iterable<Attn>, conditions: Iterable<Pick<AccountCondition, 'sessionIds'>>): number {
  const conds = [...conditions]
  const held = heldSessions(conds)
  let n = 0
  for (const s of sessions) if (attentionGroup(s, held) !== null) n++
  for (const c of conds) if (c.sessionIds.length > 0) n++
  return n
}

// ── reporting a wrong status ─────────────────────────────────────────────────────────────────────────────

/** The report picker: "It should be: working · needs me · finished · idle · ended". */
export const EXPECTED_STATES = ['working', 'needsMe', 'finished', 'idle', 'ended'] as const
export type ExpectedState = (typeof EXPECTED_STATES)[number]

/** The picker's word for a status (the golden a replay checks, U-ST-7). */
export function expectedStateOf(s: Pick<SessionView, 'lifecycle' | 'phase'>): ExpectedState {
  if (s.lifecycle !== 'live') return 'ended'
  switch (s.phase) {
    case 'starting':
    case 'working':
      return 'working'
    case 'blocked':
      return 'needsMe'
    case 'ready':
    case 'failed':
      return 'finished'
    case 'idle':
      return 'idle'
  }
}

// ── report bundles and replay fixtures ──────────────────────────────────────────────────────────────────
// A status and the recent-signal ring as JSON: `mono` stamps (ns) are decimal strings. Core writes them into a report
// bundle; `pnpm fixture:from-report` carries them into `fixtures/status/<id>/`; the replay tests (U-ST-7) read them.

const zMono = z.string().regex(/^\d+$/)

/** core's status of a live session (status/table.ts `StatusState`), as JSON. */
export const zStatusStateJson = z.object({
  phase: zPhase,
  attention: z.array(zAttentionItem),
  background: z.boolean(),
  backgroundFromFile: z.boolean(),
  fileWaiting: z.boolean().default(false),
  hookTurn: z.boolean().default(false),
  unread: z.boolean(),
  failureKind: zFailureKind.nullable(),
  compacting: z.boolean(),
  source: zStatusSource.nullable(),
  at: z.number().nullable(),
  lastActivityAt: z.number(),
  exactMono: zMono.nullable(),
  sawHeuristic: z.boolean(),
  typedMono: zMono.nullable(),
  turnMono: zMono.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: z.string().nullable(),
  costUsd: z.number().nullable(),
  contextPct: z.number().nullable(),
})
export type StatusStateJson = z.infer<typeof zStatusStateJson>

/** One line of `signals.ndjson`: one input of the recent-signal ring, in arrival order (`seq`). */
export const zSignalJson = z.object({
  seq: z.number().int(),
  mono: zMono,
  at: z.number(),
  source: zStatusSource,
  spooled: z.boolean(),
  /** As recorded: agent events and the engine's own (spawn, trust window, viewing, typing, tier 1b, reconcile). */
  events: z.array(z.looseObject({ t: z.string() })),
  raw: z.unknown().optional(),
})
export type SignalJson = z.infer<typeof zSignalJson>

/** What a replay needs besides the signals: the status before the oldest one, and how the agent was started. */
export const zReplayStart = z.object({
  base: zStatusStateJson,
  /** Inputs emitted before this are an earlier agent's; null accepts every one (a restored status). */
  baseMono: zMono.nullable(),
  prompt: z.boolean(),
  noTurns: z.boolean(),
})
export type ReplayStart = z.infer<typeof zReplayStart>

/** `fixtures/status/<id>/fixture.json`: the golden, beside `signals.ndjson`. */
export const zStatusFixture = z.object({
  format: z.literal(1),
  id: z.string(),
  agent: z.string(),
  /** The person's expected state: the golden. */
  expected: z.enum(EXPECTED_STATES),
  note: z.string().nullable(),
  /** What Kea showed when the report was made. */
  reported: z.object({ lifecycle: z.string(), phase: zPhase }),
  start: zReplayStart,
})
export type StatusFixture = z.infer<typeof zStatusFixture>

/** One "Why this status?" line: the journal row and its plain-language text (the window adds the time). */
export const zWhyEntry = z.object({
  at: z.number().int(),
  source: zStatusSource,
  event: z.string(),
  summary: z.string().nullable(),
  phaseAfter: z.string(),
  /** `hook · permission asked → blocked (Bash: npm test)` */
  text: z.string(),
})
export type WhyEntry = z.infer<typeof zWhyEntry>

const zArg = z.object({ id: zSessionId })

/** Methods core serves to the renderer for status. */
export const statusApi = defineApi({
  /**
   * The last L.whyStatusEntries journal entries, oldest first, the current attention items, and whether the
   * status is estimated or unconfirmed.
   */
  'status.why': {
    args: zArg,
    result: z.object({ entries: z.array(zWhyEntry), attention: z.array(zAttentionItem), estimated: z.boolean(), unconfirmed: z.boolean() }),
  },
  /**
   * Write a report bundle to `<KEA_HOME>/reports/<time>-<sessionId>/`. Changes nothing about the session.
   * `ms`: how long the capture took (≤ L.reportCaptureMs).
   */
  'status.report': {
    args: z.object({ id: zSessionId, expected: z.enum(EXPECTED_STATES), note: z.string().max(L.reportNoteMaxChars).optional() }),
    result: z.object({ dir: z.string(), ms: z.number() }),
  },
  /** Continue all: types `continue` + Enter into each session the agent's condition holds (only once it has reset). */
  'status.continueAll': { args: z.object({ agent: z.string().min(1) }), result: z.object({ sessionIds: z.array(zSessionId) }) },
  /**
   * The session being viewed (`isBeingViewed`: selected, the window focused, its Agent tab visible), or null. Viewing
   * one for L.viewedDwellMs marks it read.
   */
  'status.setViewing': { args: z.object({ id: zSessionId.nullable() }), result: z.object({ ok: z.boolean() }) },
})
