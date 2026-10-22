// The status phase machine as a kit/Fsm table: the code runs this table row for row, and table.test.ts checks every
// phase × event pair against it (U-ST-1). A pair the table does not list is a no-op.
//
// The machine is pure: `step` takes a session's status and one event and returns the next status and what happened
// (notifications to post or withdraw, an account condition to join, the agent's session ids to store). Precedence by
// tier and the order events are applied in are the session machine's (machine.ts); the database, stores,
// timers and notifications are the engine's (engine.ts).
//
// Rows that move the lifecycle (spawn, PTY exit, holder lost) are driven by the session lifecycle (sessions.ts); here
// the spawn resets the status, and the engine journals the exit and forgets the session's status.

import { createFsm, type FsmDef, type FsmHandler } from '@kea/kit'
import {
  AGENT_EVENT_TYPES,
  isAccountKind,
  L,
  PHASE,
  type AccountKind,
  type AgentEvent,
  type AttentionItem,
  type FailureKind,
  type Phase,
  type StatusFileReading,
  type StatusSource,
} from '@kea/protocol'

/** What a reconcile says the status is: it wins over what the engine holds. */
export interface ReconcileResult {
  phase: Phase
  attention?: AttentionItem[]
  background?: boolean
  unread?: boolean
  failureKind?: FailureKind | null
}

/** The status Fsm's events: the agent's normalised events plus what Kea observes itself. */
export type TableEvent =
  | AgentEvent
  /** "Agent PTY spawned" (create, Resume, Restart). */
  | { t: 'pty.spawned' }
  /** No hook or status-file reading within the trust window after spawn, the agent's trust unconfirmed. */
  | { t: 'trust.timeout' }
  /** "User views the session ≥ L.viewedDwellMs with the window focused". */
  | { t: 'user.viewed' }
  /** "User types into the agent terminal". */
  | { t: 'user.typed' }
  /** Tier 1b: a reading of the agent's live status file; `status` null: the file just registered, no status yet. */
  | StatusFileEvent
  /** A reconcile's result; applied outside the table: it sets the status. */
  | ({ t: 'reconcile' } & ReconcileResult)

/** A tier-1b reading as the table takes it: the adapter's reading, or a file present with no status yet (`status: null`). */
export type StatusFileEvent = { t: 'statusFile'; status: StatusFileReading['status'] | null; waitingFor?: StatusFileReading['waitingFor']; detail?: string }

export type TableEventType = TableEvent['t']

/**
 * Every event type of the table, for the exhaustive pairs in table.test.ts (`reconcile` is not a table event: it sets
 * the status).
 */
export const TABLE_EVENTS = [...AGENT_EVENT_TYPES, 'pty.spawned', 'trust.timeout', 'user.viewed', 'user.typed', 'statusFile'] as const satisfies readonly TableEventType[]

/** A live session's status as the engine holds it: `session_runtime` plus the machine's bookkeeping. */
export interface StatusState {
  phase: Phase
  /** Pending attention items, oldest first. */
  attention: AttentionItem[]
  background: boolean
  /** `background` came from the status file's `shell` (it ends when the file says `idle`). */
  backgroundFromFile: boolean
  /** The status file's last reading was `waiting` (a prompt on screen): leaving it answers that prompt (tier 1b). */
  fileWaiting: boolean
  /**
   * The current turn was started by a hook (`turn.started` from tier 1): its `Stop`, or the adapter's interrupt rule
   * after its grace, ends it, so the status file's `idle` does not. A turn only the file saw start ends with it.
   */
  hookTurn: boolean
  unread: boolean
  failureKind: FailureKind | null
  /** The spinner's tooltip says "compacting". */
  compacting: boolean
  /** The source and wall time of the last change. */
  source: StatusSource | null
  at: number | null
  lastActivityAt: number
  /** The `mono` (ns) of the last tier-1/1b/2 input; null before the first. */
  exactMono: bigint | null
  /** A heuristic (tier 3) input has been seen. */
  sawHeuristic: boolean
  /** The user typed into the agent terminal while blocked, after the last attention event (`mono`, ns). */
  typedMono: bigint | null
  /** The current turn's start (`mono`, ns): N2's turn length. */
  turnMono: bigint | null
  // live metadata reported by the agent (session_runtime; all optional)
  model: string | null
  effort: string | null
  permissionMode: string | null
  costUsd: number | null
  contextPct: number | null
}

/** A fresh status: what a session's status is before its agent is spawned. */
export function initialStatus(at: number): StatusState {
  return {
    phase: 'idle',
    attention: [],
    background: false,
    backgroundFromFile: false,
    fileWaiting: false,
    hookTurn: false,
    unread: false,
    failureKind: null,
    compacting: false,
    source: null,
    at: null,
    lastActivityAt: at,
    exactMono: null,
    sawHeuristic: false,
    typedMono: null,
    turnMono: null,
    model: null,
    effort: null,
    permissionMode: null,
    costUsd: null,
    contextPct: null,
  }
}

export function cloneStatus(s: StatusState): StatusState {
  return { ...s, attention: s.attention.map((a) => ({ ...a })) }
}

/** What a step did besides changing the status: the engine carries these out. */
export type Effect =
  /** N1: the first attention item was added (`trust`: the trust question, notified only when the window is unfocused). */
  | { k: 'N1'; item: AttentionItem; trust: boolean }
  /** N2: the turn finished. `turnMs` null when its start was not seen. */
  | { k: 'N2'; turnMs: number | null; lastMessage: string | null; background: boolean }
  /** N3: the turn failed with a per-session error. */
  | { k: 'N3'; kind: FailureKind; error: string }
  /** Withdraw the notifications of these attention items (all of the session's when `keys` is absent). */
  | { k: 'withdraw'; keys?: string[] }
  /** A hook's item replaced the status file's item for the same prompt: the N1 posted for `from` is now `to`'s (one prompt, one N1). */
  | { k: 'rekey'; from: string; to: string }
  /** The turn failed with an account-level error: open or join the agent's condition. */
  | { k: 'condition'; kind: AccountKind; resetsAt: number | null }
  /** A turn of the agent finished: its condition ends. */
  | { k: 'conditionClear' }
  /** `session.started`: store the agent's session id and transcript path. */
  | { k: 'agentSession'; agentSessionId: string; transcriptPath: string | null }
  /** `meta.title` (a title only moves forward). */
  | { k: 'title'; title: string; source: 'agent' | 'user' }

/** What a handler sees: the status being changed (mutated in place) and the input's facts. */
export interface StepCtx {
  s: StatusState
  source: StatusSource
  at: number
  mono: bigint
  /** The agent was started with a prompt: it stays `starting` until `turn.started`. */
  prompt: boolean
  /** The agent has no turns (the `shell` pseudo-agent): spawned, it is `idle`. */
  noTurns: boolean
  /** The session is being viewed: selected, its window focused and its Agent tab visible. */
  viewing: boolean
  effects: Effect[]
  /** A note for the journal (the user-input rule: `user + heuristic`). */
  note?: string
}

/** The trust-pending question: its key and its words. */
export const TRUST_KEY = 'trust'
export const TRUST_SUMMARY = 'Trust this folder? — answer in the terminal'
/** The tier-1b permission item's key. */
export const STATUS_FILE_KEY = 'status-file'

const clip = (s: string) => (s.length > L.hookSummaryMaxChars ? s.slice(0, L.hookSummaryMaxChars) : s)

/**
 * Add the item for `key`, or refresh it (its summary and source; its time stays, so `⌘J` keeps the oldest first). The
 * first item notifies (N1), unless `estimated` (a prompt the status file only guesses at: Kea never guesses loudly).
 */
function addItem(c: StepCtx, kind: 'permission' | 'question', key: string, summary: string, estimated = false): void {
  // the status file only says a prompt is on screen; the hook that names it replaces the file's item (one prompt, one item)
  let replaced: AttentionItem | undefined
  if (c.source !== 'status-file') {
    replaced = c.s.attention.find((a) => a.source === 'status-file')
    c.s.attention = c.s.attention.filter((a) => a.source !== 'status-file')
  }
  const wasEmpty = c.s.attention.length === 0
  const found = c.s.attention.find((a) => a.key === key)
  if (found) {
    found.summary = clip(summary)
    found.source = c.source
    found.kind = kind
    if (estimated) found.estimated = true
    else delete found.estimated
  } else c.s.attention.push({ kind, key, summary: clip(summary), source: c.source, at: c.at, ...(estimated ? { estimated: true as const } : {}) })
  c.s.typedMono = null
  if (!wasEmpty) return
  // the file's item was notified: that notification is this prompt's, now under the hook's key (one prompt, one N1)
  if (replaced && !replaced.estimated && replaced.key !== key) c.effects.push({ k: 'rekey', from: replaced.key, to: key })
  else if (!estimated && !(replaced && !replaced.estimated)) c.effects.push({ k: 'N1', item: { ...c.s.attention[c.s.attention.length - 1]! }, trust: key === TRUST_KEY })
}

/** Remove the items `pred` picks; their notifications are withdrawn. */
function removeItems(c: StepCtx, pred: (a: AttentionItem) => boolean): number {
  const gone = c.s.attention.filter(pred)
  if (gone.length === 0) return 0
  c.s.attention = c.s.attention.filter((a) => !pred(a))
  c.effects.push({ k: 'withdraw', keys: gone.map((a) => a.key) })
  return gone.length
}

function clearAll(c: StepCtx): void {
  if (c.s.attention.length) c.effects.push({ k: 'withdraw' })
  c.s.attention = []
}

/** A heuristic (tier 3) event can never remove an attention item. */
const heuristicBlocked = (c: StepCtx) => c.source === 'heuristic' && c.s.attention.length > 0

const afterAttention = (c: StepCtx): Phase => (c.s.attention.length ? 'blocked' : 'working')

type H<T extends TableEventType> = FsmHandler<Phase, Extract<TableEvent, { t: T }>, StepCtx>

const spawned: H<'pty.spawned'> = (c) => {
  c.s.attention = []
  c.s.unread = false
  c.s.background = false
  c.s.backgroundFromFile = false
  c.s.fileWaiting = false
  c.s.hookTurn = false
  c.s.compacting = false
  c.s.typedMono = null
  c.s.turnMono = null
  return c.noTurns ? 'idle' : 'starting'
}

const sessionStarted: H<'session.started'> = (c, ev, from) => {
  c.effects.push({ k: 'agentSession', agentSessionId: ev.agentSessionId, transcriptPath: ev.transcriptPath ?? null })
  if (from !== 'starting' && from !== 'blocked') return from
  const trust = removeItems(c, (a) => a.key === TRUST_KEY)
  if (c.s.attention.length) return 'blocked'
  if (from === 'blocked' && !trust) return from
  return c.prompt ? 'starting' : 'idle'
}

const trustTimeout: H<'trust.timeout'> = (c) => {
  addItem(c, 'question', TRUST_KEY, TRUST_SUMMARY)
  return 'blocked'
}

const turnStarted: H<'turn.started'> = (c, ev, from) => {
  if (c.source === 'heuristic') {
    // after the user typed while blocked, output flowing (tier 3) clears hook-sourced permission items: the only case
    // where tier 3 may clear attention (after approving, a long tool fires no hook until it finishes)
    if (from === 'blocked' && c.s.typedMono !== null) {
      if (removeItems(c, (a) => a.kind === 'permission' && a.source === 'hook')) c.note = 'user + heuristic'
      c.s.typedMono = null
      if (c.s.attention.length) return 'blocked'
    } else if (c.s.attention.length) return null
  }
  c.s.background = false
  c.s.backgroundFromFile = false
  if (ev.trigger !== 'background') {
    // a new prompt answers everything
    clearAll(c)
    c.s.unread = false
  }
  c.s.turnMono = c.mono
  c.s.hookTurn = c.source === 'hook'
  return afterAttention(c)
}

const toolStarted: H<'tool.started'> = (c, ev, from) => {
  if (ev.subagent) return null // Subagent events never touch the main agent's status
  return from === 'blocked' ? 'blocked' : 'working'
}

const permission: H<'attention.permission'> = (c, ev) => {
  addItem(c, 'permission', ev.key, ev.summary ?? ev.tool ?? ev.key)
  return 'blocked'
}

const question: H<'attention.question'> = (c, ev) => {
  addItem(c, 'question', ev.key, ev.summary ?? ev.key)
  return 'blocked'
}

const cleared: H<'attention.cleared'> = (c, ev) => {
  if (c.source === 'heuristic') return null
  if (ev.key === undefined) clearAll(c)
  else removeItems(c, (a) => a.key === ev.key)
  return afterAttention(c)
}

const turnFinished: H<'turn.finished'> = (c, ev) => {
  if (heuristicBlocked(c)) return null
  clearAll(c)
  c.s.background = ev.backgroundWork
  c.s.backgroundFromFile = false
  c.s.unread = !c.viewing
  const turnMs = turnLength(c)
  c.s.turnMono = null
  c.s.hookTurn = false
  c.effects.push({ k: 'N2', turnMs, lastMessage: ev.lastMessage ?? null, background: ev.backgroundWork })
  c.effects.push({ k: 'conditionClear' })
  return 'ready'
}

const turnInterrupted: H<'turn.interrupted'> = (c) => {
  if (heuristicBlocked(c)) return null
  clearAll(c)
  c.s.unread = false
  c.s.turnMono = null
  c.s.hookTurn = false
  return 'ready'
}

const turnFailed: H<'turn.failed'> = (c, ev) => {
  if (heuristicBlocked(c)) return null
  clearAll(c)
  c.s.unread = true
  c.s.failureKind = ev.kind
  c.s.turnMono = null
  c.s.hookTurn = false
  if (isAccountKind(ev.kind)) c.effects.push({ k: 'condition', kind: ev.kind, resetsAt: ev.resetsAt ?? null })
  else c.effects.push({ k: 'N3', kind: ev.kind, error: clip(ev.error) })
  return 'failed'
}

const compacting: H<'compacting'> = (c, ev, from) => {
  c.s.compacting = ev.active
  return from
}

const sessionEnded: H<'session.ended'> = (_c, _ev, from) => from

const viewed: H<'user.viewed'> = (c, _ev, from) => {
  if (c.s.unread) c.effects.push({ k: 'withdraw' })
  c.s.unread = false
  return from
}

const typed: H<'user.typed'> = (c) => {
  // remembered as "answered by user?": confirmed by the agent's next event, or by the user-input rule
  c.s.typedMono = c.mono
  return 'blocked'
}

/** N2's turn length: from the turn's start when it was seen. */
const turnLength = (c: StepCtx): number | null => (c.s.turnMono !== null && c.mono >= c.s.turnMono ? Number(c.mono - c.s.turnMono) / 1e6 : null)

/**
 * The prompt a `waiting` reading shows, as an item with the status file's key: a permission prompt, or a question; an
 * unknown wait is a question the file only estimates (shown, never notified). False for a dialog (`/model`): not attention.
 */
function filePrompt(c: StepCtx, ev: StatusFileEvent): boolean {
  if (ev.waitingFor === 'permission') addItem(c, 'permission', STATUS_FILE_KEY, ev.detail ?? 'permission')
  else if (ev.waitingFor === 'question') addItem(c, 'question', STATUS_FILE_KEY, ev.detail ?? 'question')
  else if (ev.waitingFor === 'unknown') addItem(c, 'question', STATUS_FILE_KEY, ev.detail ?? 'waiting', true)
  else return false
  return true
}

/** `busy` with no turn running: the file saw a turn start (hooks off, or a user's Stop hook kept the turn going). A finished turn's N2 goes. */
function fileTurn(c: StepCtx): Phase {
  if (c.s.unread) c.effects.push({ k: 'withdraw' })
  c.s.unread = false
  c.s.background = false
  c.s.backgroundFromFile = false
  c.s.turnMono = c.mono
  c.s.hookTurn = false
  return 'working'
}

/** `idle` / `shell` ending a turn no hook started (the hooks are off): finished, as `turn.finished` without its last message. */
function fileFinished(c: StepCtx, status: 'idle' | 'shell'): Phase {
  clearAll(c)
  c.s.unread = !c.viewing
  const turnMs = turnLength(c)
  c.s.turnMono = null
  c.s.background = false
  c.s.backgroundFromFile = false
  backgroundFromFile(c, status)
  // no `conditionClear`: the file cannot tell a finished turn from a failed one (the condition waits for a Stop)
  c.effects.push({ k: 'N2', turnMs, lastMessage: null, background: c.s.background })
  return 'ready'
}

/**
 * Tier 1b while `blocked` (on something other than the trust question alone). Right after `waiting`, the prompt the file
 * showed was answered: the items of the agent's prompts go, the hook's included (after approving, a long tool fires no
 * hook until it finishes; this supersedes the user-input rule). Otherwise only the file's own items go, and only when
 * nothing else is pending. `trust`: this reading answered the trust question (its withdrawal is a change).
 */
function fileWhileBlocked(c: StepCtx, ev: StatusFileEvent, trust: boolean): Phase | null {
  const keep = trust ? 'blocked' : null
  if (ev.status === null || ev.status === 'waiting') return keep
  const answered = c.s.fileWaiting
  if (!answered && c.s.attention.some((a) => a.source !== 'status-file')) return keep
  if (removeItems(c, (a) => a.source === 'status-file' || (answered && a.source === 'hook')) && answered) c.note = 'answered (status file)'
  if (c.s.attention.length) return 'blocked'
  if (ev.status === 'busy') return 'working'
  backgroundFromFile(c, ev.status)
  return 'ready'
}

/**
 * Tier 1b, a full exact source. Any reading (a file just registered, with no status yet, too) answers the trust
 * question: the trust dialog writes no file. Then: `busy` with no turn running → working; `waiting` on a prompt →
 * blocked from any phase; `idle` / `shell` ending a turn no hook started → ready; `shell` marks background work; at
 * `starting`, `idle` / `shell` say the agent waits at its prompt.
 */
const statusFile: H<'statusFile'> = (c, ev, from) => {
  const trust = removeItems(c, (a) => a.key === TRUST_KEY) > 0
  if (from === 'blocked' && !(trust && c.s.attention.length === 0)) return fileWhileBlocked(c, ev, trust)
  // past the trust dialog (as at session.started), or at the start: the agent at its prompt, or starting with an argv prompt
  const settled: Phase = from === 'blocked' || from === 'starting' ? (c.prompt ? 'starting' : 'idle') : from
  switch (ev.status) {
    case null:
      return from === 'blocked' ? settled : null
    case 'busy':
      return from === 'working' ? null : fileTurn(c)
    case 'waiting':
      if (filePrompt(c, ev)) return 'blocked'
      return from === 'blocked' ? settled : null
    case 'idle':
    case 'shell':
      if (from === 'working') return c.s.hookTurn ? null : fileFinished(c, ev.status)
      if (from !== 'failed') backgroundFromFile(c, ev.status)
      return settled
  }
}

function backgroundFromFile(c: StepCtx, status: StatusFileReading['status'] | null): void {
  if (status === 'shell') {
    c.s.background = true
    c.s.backgroundFromFile = true
  } else if (status === 'idle' && c.s.backgroundFromFile) {
    // only the status file's own background work ends with it (a hook's background tasks stay until the next turn)
    c.s.background = false
    c.s.backgroundFromFile = false
  }
}

type Row = NonNullable<FsmDef<Phase, TableEvent, StepCtx>['transitions'][Phase]>

/** One row per phase; "any live phase" rows are in every one. */
function row(phase: Phase): Row {
  const r: Record<string, unknown> = {
    'pty.spawned': spawned,
    'session.started': sessionStarted,
    'turn.started': turnStarted,
    'tool.started': toolStarted,
    'attention.permission': permission,
    'attention.question': question,
    'turn.finished': turnFinished,
    'turn.interrupted': turnInterrupted,
    'turn.failed': turnFailed,
    compacting,
    'session.ended': sessionEnded,
    statusFile,
  }
  if (phase === 'starting') r['trust.timeout'] = trustTimeout
  if (phase === 'blocked') {
    r['attention.cleared'] = cleared
    r['user.typed'] = typed
  }
  if (phase === 'ready' || phase === 'failed') r['user.viewed'] = viewed
  return r as Row
}

/** The status table: one row per phase. */
export const STATUS_TABLE: FsmDef<Phase, TableEvent, StepCtx> = {
  initial: 'idle',
  transitions: Object.fromEntries(PHASE.map((p) => [p, row(p)])) as FsmDef<Phase, TableEvent, StepCtx>['transitions'],
}

export interface StepInput {
  source: StatusSource
  at: number
  mono: bigint
  prompt: boolean
  noTurns: boolean
  viewing: boolean
}

export interface StepResult {
  state: StatusState
  effects: Effect[]
  /** The table has a row for this pair (it may still have refused). */
  handled: boolean
  /** Something the window shows changed (phase, attention, unread, background, failure kind, compacting). */
  changed: boolean
  note?: string
}

const shown = (s: StatusState) => `${s.phase}|${s.attention.map((a) => `${a.kind}:${a.key}:${a.summary}`).join(',')}|${s.unread}|${s.background}|${s.failureKind}|${s.compacting}`

/** Apply one event to a status (pure: `prev` is not changed). */
export function step(prev: StatusState, ev: TableEvent, inp: StepInput): StepResult {
  const s = cloneStatus(prev)
  const c: StepCtx = { s, source: inp.source, at: inp.at, mono: inp.mono, prompt: inp.prompt, noTurns: inp.noTurns, viewing: inp.viewing, effects: [] }
  let handled = true
  if (ev.t === 'reconcile') {
    s.phase = ev.phase
    if (ev.attention) s.attention = ev.attention.map((a) => ({ ...a }))
    if (ev.background !== undefined) s.background = ev.background
    if (ev.unread !== undefined) s.unread = ev.unread
    if (ev.failureKind !== undefined) s.failureKind = ev.failureKind
    if (s.phase !== 'blocked') s.attention = []
    else if (s.attention.length === 0) s.phase = 'working' // blocked exactly when the set is non-empty
    s.hookTurn = false // a restored agent's adapter has seen no turn start: the status file may end it
  } else if (ev.t === 'meta') {
    if (ev.model !== undefined) s.model = ev.model
    if (ev.effort !== undefined) s.effort = ev.effort
    if (ev.permissionMode !== undefined) s.permissionMode = ev.permissionMode
    if (ev.costUsd !== undefined) s.costUsd = ev.costUsd
    if (ev.contextUsedPct !== undefined) s.contextPct = ev.contextUsedPct
    if (ev.title) c.effects.push({ k: 'title', title: ev.title, source: ev.titleSource ?? 'agent' })
    handled = false
  } else {
    const fsm = createFsm(STATUS_TABLE, { state: prev.phase })
    const r = fsm.send(ev, c)
    handled = r.handled
    s.phase = r.to
    if (ev.t === 'statusFile') s.fileWaiting = ev.status === 'waiting'
  }
  // `failure_kind` is kept only while `failed`
  if (s.phase !== 'failed') s.failureKind = null
  const changed = shown(prev) !== shown(s)
  if (changed) {
    s.source = inp.source
    s.at = inp.at
    s.lastActivityAt = inp.at
  }
  return { state: s, effects: c.effects, handled, changed, ...(c.note ? { note: c.note } : {}) }
}
