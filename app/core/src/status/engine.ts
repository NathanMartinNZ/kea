// The status engine: normalised agent events in, each live session's phase, attention set and journal out.
//
//   inputs        `ingest` (an adapter's events, with their tier as `source`, the envelope's `mono` and `at`),
//                 `statusFile` (tier 1b), `reconcile`, `userTyped`, `setViewing`; and the session lifecycle,
//                 followed on the `sessions` store: a session turning `live` is "Agent PTY spawned", one leaving it is
//                 the PTY exit or holder loss. Inputs for a session that is not live are ignored.
//   the spawn     is placed at the agent's launch (`launchedAt`, taken just before its PTY is spawned), not when the
//                 session turns live a little later: hooks the agent emits in between are applied in their place
//                 after it, and an input stamped before the launch (an earlier agent's) is dropped
//   clocks        every `mono` is core's monotonic clock (`process.hrtime`, ns). A hook envelope's own stamp is the
//                 helper's clock (CLOCK_UPTIME_RAW on macOS, CLOCK_MONOTONIC on Linux), which stops while the machine
//                 sleeps; the agent service converts it
//   per session   a SessionMachine (machine.ts: the table, precedence by tier, the order inputs are applied in,
//                 the recent-signal ring)
//   out           every change is written through the status batch (the `session_runtime` row and a `status_events` row
//                 per change), after which the `sessions` store re-reads the row (`onCommit`); the `status` store
//                 (unconfirmed, source, compacting, estimated) is set at once; notices (N1…N5, withdrawals) go to the
//                 notification policy (notices.ts)
//   restart       a live session's status is restored from the database and marked unconfirmed until a live
//                 signal, a reconcile or L.unconfirmedStatusMs; unconfirmed, spooled and reconciled changes notify nothing
//   trust with no hook or status-file reading L.trustWindowMs after spawn, the trust question: in a repo whose
//                 trust is not confirmed, or at every launch of an agent that may ask at any launch (`trustGated`). The
//                 first such reading from an agent that keeps its trust per repository confirms the repo's
//                 (`projects.trust_confirmed`). The trust dialog holds hooks back and writes no status file
//   conditions    account-level failures open or join the agent's condition (conditions.ts)

import { Emitter, type Logger } from '@kea/kit'
import {
  isAccountKind,
  KeyedStore,
  L,
  RpcError,
  STATUS_STORE,
  zAttentionItem,
  type AgentEvent,
  type AttentionItem,
  type ExpectedState,
  type Handlers,
  type FailureKind,
  type Lifecycle,
  type Phase,
  type Project,
  type SessionStatus,
  type SessionView,
  type StatusFileReading,
  type StatusSource,
  type WhyEntry,
  statusApi,
} from '@kea/protocol'
import type { RuntimeFields, SessionFields, StatusBatch, StatusEvent, StatusWrite } from '../platform/db/batch.ts'
import type { KeaDb } from '../platform/db/db.ts'
import { SHELL_AGENT } from '../sessions/rebuild.ts'
import { Conditions } from './conditions.ts'
import { Reports, type ReportsOptions } from './reports.ts'
import { SessionMachine, type Applied, type SignalRecord } from './machine.ts'
import type { StatusNotice } from './notices.ts'
import { initialStatus, type Effect, type ReconcileResult, type StatusState, type TableEvent } from './table.ts'

/** One input from an adapter: an envelope's or a signal's normalised events and where they came from. */
export interface StatusInput {
  sessionId: string
  /** The signal tier: `hook` (tier 1), `status-file` (1b), `transcript` (2), `heuristic` (3). */
  source: StatusSource
  events: readonly AgentEvent[]
  /** When it was emitted, on core's monotonic clock (ns; a hook envelope's stamp converted). Default: now. */
  mono?: bigint | number
  /** When it was received: the envelope's `receivedAt` (wall ms; a spooled one keeps its own). Default: now. */
  at?: number
  /**
   * Drained from a spool and emitted before this core started (Kea could not have shown it live): placed by its
   * `mono` like any input, and notifies nothing. A spooled envelope emitted since (a busy core, the intake down) is not.
   */
  spooled?: boolean
  /** The projected envelope or signal, kept in the recent-signal ring for a status report. */
  raw?: unknown
}

export interface StatusEngineOptions {
  db: KeaDb
  batch: StatusBatch
  log: Logger
  /** Core's `sessions` store: lifecycle, agent and project of every session. */
  sessions: KeyedStore<SessionView>
  /** Whether a project's repo trust is confirmed. */
  projects: { get(id: string): Pick<Project, 'trustConfirmed'> | undefined }
  /** A project's row changed (its trust was confirmed): read it into the `projects` store again. */
  projectChanged?(projectId: string): void
  /** Wall clock (ms). */
  now?: () => number
  /**
   * Core's monotonic clock (ns): `process.hrtime`. Not the helper's clock, which stops while the machine sleeps: the
   * two differ by the time slept.
   */
  mono?: () => bigint
  /** When the session's agent was launched, on `mono`'s clock (just before its PTY was spawned), or null when unknown (the `shell` pseudo-agent). */
  launchedAt?(sessionId: string): bigint | null
  /**
   * Whether the trust window applies to this session's launch: its agent holds its hooks back until the folder
   * is trusted (adapters say), and the launch can report at all (a launch that cannot, Command Code without its mod,
   * would get the question L.trustWindowMs into every quiet start and nothing could ever answer it), and whose answer
   * the trust is. `repo`: the agent keeps it per repository, so the window runs until an event of such an agent came
   * from the project (`projects.trust_confirmed`, which only such an agent's event sets). `launch`: the agent may ask
   * at any launch, so the window runs at every one and its events leave the project's flag alone (one flag for every
   * agent would leave Command Code's own question unannounced in a project Claude Code had run in, and the reverse).
   * Default: `repo` for every agent but the `shell` pseudo-agent.
   */
  trustGated?(agent: string, sessionId: string): false | 'repo' | 'launch'
  /**
   * Type `text` into a session's agent PTY and press Enter, for Continue all; core passes the terminals'
   * `sendText`. Without it Continue all is unavailable.
   */
  input?(sessionId: string, text: string): Promise<boolean>
  /** `<KEA_HOME>`: status reports go under it. */
  home: string
  /** Kea's version and commit, for a report. */
  version: string
  commit?: string
  /** The parts of a report core's other services hold, and who is told that a report made `reports/`. */
  report?: Pick<ReportsOptions, 'cliVersion' | 'statusFile' | 'agentPty' | 'screen' | 'resources' | 'platform' | 'folderMade'>
}

interface Track {
  id: string
  agent: string
  projectId: string
  machine: SessionMachine
  unconfirmed: boolean
  unconfirmedTimer: ReturnType<typeof setTimeout> | null
  trustTimer: ReturnType<typeof setTimeout> | null
}

/** The text Continue all types, then Enter. */
export const CONTINUE_TEXT = 'continue'

/**
 * Inputs that are journaled even when nothing the window shows changed. Not a start its adapter only repeats to hand
 * over the transcript's path (`repeated`): no session started then, and "Why this status?" would say one did, in the
 * middle of a turn (U-ST-20).
 */
const ALWAYS_JOURNALED: ReadonlySet<string> = new Set(['session.started', 'session.ended'])
const alwaysJournaled = (ev: TableEvent): boolean => ALWAYS_JOURNALED.has(ev.t) && !(ev.t === 'session.started' && ev.repeated === true)

/** Plain-language names of journal events. */
const EVENT_WORDS: Record<string, string> = {
  'session.started': 'agent session started',
  'turn.started': 'turn started',
  'tool.started': 'tool started',
  'tool.finished': 'tool finished',
  'attention.permission': 'permission asked',
  'attention.question': 'question asked',
  'attention.cleared': 'answered',
  'turn.finished': 'turn finished',
  'turn.interrupted': 'interrupted',
  'turn.failed': 'turn failed',
  compacting: 'compacting',
  'session.ended': 'agent session ended',
  'pty.spawned': 'agent started',
  'pty.exited': 'agent ended',
  'trust.timeout': 'no hook in the trust window',
  'user.viewed': 'viewed',
  'user.typed': 'typed in the terminal',
  statusFile: 'status file',
  reconcile: 'reconciled',
}

/** A "Why this status?" line: `hook · permission asked → blocked (Bash: npm test)`. */
export function whyText(e: { source: StatusSource; event: string; summary: string | null; phaseAfter: string }): string {
  return `${e.source} · ${EVENT_WORDS[e.event] ?? e.event} → ${e.phaseAfter}${e.summary ? ` (${e.summary})` : ''}`
}

const clip = (s: string) => (s.length > L.hookSummaryMaxChars ? s.slice(0, L.hookSummaryMaxChars) : s)

function summaryOf(ev: TableEvent, after: StatusState, note?: string): string | null {
  let s: string | null = null
  switch (ev.t) {
    case 'attention.permission':
      s = ev.tool && ev.summary ? `${ev.tool}: ${ev.summary}` : (ev.summary ?? ev.tool ?? ev.key)
      break
    case 'attention.question':
      s = ev.summary ?? ev.key
      break
    case 'attention.cleared':
      s = ev.key ?? 'all'
      break
    case 'tool.started':
      s = ev.summary ? `${ev.name}: ${ev.summary}` : ev.name
      break
    case 'turn.started':
      s = ev.trigger === 'background' ? 'background' : null
      break
    case 'turn.finished':
      s = ev.backgroundWork ? 'background tasks running' : null
      break
    case 'turn.failed':
      s = `${ev.kind}: ${ev.error}`
      break
    case 'session.started':
      s = ev.source
      break
    case 'session.ended':
      s = ev.reason ?? null
      break
    case 'compacting':
      s = ev.active ? 'started' : 'done'
      break
    case 'statusFile':
      s = ev.status === null ? 'registered' : ev.waitingFor ? `${ev.status}: ${ev.detail && ev.waitingFor === 'unknown' ? ev.detail : ev.waitingFor}` : ev.status
      break
    case 'trust.timeout':
      s = after.attention.find((a) => a.kind === 'question')?.summary ?? null
      break
  }
  if (note) s = s ? `${s}; ${note}` : note
  return s === null ? null : clip(s)
}

/** The `session_runtime` columns of a status. */
function runtimeOf(s: StatusState): Partial<RuntimeFields> {
  return {
    phase: s.phase,
    attention: JSON.stringify(s.attention),
    background: s.background,
    failureKind: s.failureKind,
    unread: s.unread,
    statusSource: s.source,
    statusAt: s.at,
    lastActivityAt: s.lastActivityAt,
    model: s.model,
    effort: s.effort,
    permissionMode: s.permissionMode,
    costUsd: s.costUsd,
    contextPct: s.contextPct,
  }
}

const sameRuntime = (a: StatusState, b: StatusState) => JSON.stringify(runtimeOf(a)) === JSON.stringify(runtimeOf(b)) && a.compacting === b.compacting

type RuntimeRow = {
  phase: Phase
  attention: string
  background: number
  failure_kind: FailureKind | null
  unread: number
  status_source: StatusSource | null
  status_at: number | null
  last_activity_at: number
  model: string | null
  effort: string | null
  permissionMode: string | null
  cost_usd: number | null
  context_pct: number | null
}

export class StatusEngine {
  /** `status`: SessionStatus by session id, live sessions only. */
  readonly store = new KeyedStore<SessionStatus>(STATUS_STORE)
  readonly conditions: Conditions
  readonly reports: Reports
  /** N1…N5 and withdrawals, for the notification policy (which tells main what to post). */
  readonly notices = new Emitter<StatusNotice>({ name: 'status.notices' })
  /** An agent's tool finished in this session, live (not from the spool): its files may have changed. */
  readonly toolFinished = new Emitter<string>({ name: 'status.toolFinished' })
  private readonly o: StatusEngineOptions
  private readonly now: () => number
  private readonly mono: () => bigint
  // bounded: one per live session
  private readonly tracks = new Map<string, Track>()
  // bounded: one per session in the `sessions` store
  private readonly lifecycles = new Map<string, Lifecycle>()
  private viewing: string | null = null
  private viewTimer: ReturnType<typeof setTimeout> | null = null
  private readonly offSessions: () => void
  private disposed = false

  constructor(o: StatusEngineOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.mono = o.mono ?? (() => process.hrtime.bigint())
    this.conditions = new Conditions({ db: o.db, log: o.log, now: this.now, notify: (n) => this.notices.fire(n) })
    this.reports = new Reports({ ...o.report, home: o.home, db: o.db, log: o.log, version: o.version, commit: o.commit, now: this.now, mono: this.mono, flush: () => o.batch.flush() })
    for (const v of o.sessions.values()) {
      this.lifecycles.set(v.id, v.lifecycle)
      if (v.lifecycle === 'live') this.restore(v)
    }
    this.conditions.load((id, kind) => {
      const s = this.tracks.get(id)?.machine.state
      return !!s && s.phase === 'failed' && s.failureKind === kind
    })
    this.offSessions = o.sessions.onDelta((d) => {
      for (const id of d.del ?? []) this.forget(id)
      for (const [id, v] of Object.entries(d.set ?? {})) this.lifecycleChanged(id, v)
    })
  }

  // ── inputs ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Apply an adapter's input. The hook intake calls this once per envelope with the adapter's events, `source: 'hook'`,
   * the envelope's `mono` on core's clock and its `receivedAt`; the status file, the transcript watcher and tier-3
   * heuristics with their own tier. False when the session is not live (nothing applied).
   */
  ingest(input: StatusInput): boolean {
    const applied = this.apply(input.sessionId, { source: input.source, events: [...input.events], mono: input.mono, at: input.at, spooled: input.spooled === true, raw: input.raw })
    if (applied && input.spooled !== true && input.events.some((e) => e.t === 'tool.finished')) this.toolFinished.fire(input.sessionId)
    return applied
  }

  /**
   * Tier 1b: a reading of the agent's live status file; null: the file is there with no status yet (just registered),
   * which answers the trust question all the same.
   */
  statusFile(sessionId: string, reading: StatusFileReading | null, o: { mono?: bigint | number; at?: number; raw?: unknown } = {}): boolean {
    const ev: TableEvent = reading ? { t: 'statusFile', ...reading } : { t: 'statusFile', status: null }
    return this.apply(sessionId, { source: 'status-file', events: [ev], mono: o.mono, at: o.at, spooled: false, raw: o.raw })
  }

  /**
   * The result of reconciling with the agent's own record: it wins, the disagreement is journaled, and a
   * restored status is confirmed. Null: the reconcile completed with nothing to say (no usable record, or it
   * failed): the restored status stands, confirmed.
   */
  reconcile(sessionId: string, result: ReconcileResult | null): boolean {
    const ok = result ? this.apply(sessionId, { source: 'reconcile', events: [{ t: 'reconcile', ...result }], spooled: false, quiet: true }) : this.tracks.has(sessionId)
    const t = this.tracks.get(sessionId)
    if (t) this.confirm(t)
    return ok
  }

  /** A keystroke into the session's agent terminal (remembered while blocked). */
  userTyped(sessionId: string): boolean {
    return this.apply(sessionId, { source: 'user', events: [{ t: 'user.typed' }], spooled: false })
  }

  /** The session being viewed: selected, its window focused and its Agent tab visible; null for none. */
  setViewing(id: string | null): void {
    if (id === this.viewing) return
    this.viewing = id
    if (this.viewTimer) clearTimeout(this.viewTimer)
    this.viewTimer = null
    if (id === null) return
    // the dwell reads a session: a live one with nothing unread needs none (a turn that ends while it is
    // viewed is read at once); a detached one is looked up when the dwell ends
    if (this.tracks.has(id) && !this.tracks.get(id)!.machine.state.unread) return
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null
      if (this.viewing === id) this.viewed(id)
    }, L.viewedDwellMs)
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────

  /** A live session's status as the engine holds it (tests, reports). */
  state(sessionId: string): StatusState | undefined {
    return this.tracks.get(sessionId)?.machine.state
  }

  /** The session's machine (its recent-signal ring and its base, for a report). */
  machine(sessionId: string): SessionMachine | undefined {
    return this.tracks.get(sessionId)?.machine
  }

  isUnconfirmed(sessionId: string): boolean {
    return this.tracks.get(sessionId)?.unconfirmed ?? false
  }

  /** The session being viewed (as the window last said), or null: for the notification policy. */
  get viewingId(): string | null {
    return this.viewing
  }

  /** "Why this status?": the last L.whyStatusEntries journal entries, oldest first, and the attention items. */
  why(sessionId: string): { entries: WhyEntry[]; attention: AttentionItem[]; estimated: boolean; unconfirmed: boolean } {
    if (!this.o.db.get('SELECT 1 AS ok FROM sessions WHERE id = ?', sessionId)) throw new RpcError('not_found', `no session ${sessionId}`)
    this.o.batch.flush()
    const rows = this.o.db.all<{ at: number; source: StatusSource; event: string; summary: string | null; phase_after: string }>(
      'SELECT at, source, event, summary, phase_after FROM status_events WHERE session_id = ? ORDER BY id DESC LIMIT ?',
      sessionId,
      L.whyStatusEntries,
    )
    const entries = rows.reverse().map((r) => {
      const e = { at: r.at, source: r.source, event: r.event, summary: r.summary, phaseAfter: r.phase_after }
      return { ...e, text: whyText(e) }
    })
    const t = this.tracks.get(sessionId)
    const s = t?.machine.state
    return { entries, attention: s ? s.attention.map((a) => ({ ...a })) : [], estimated: s ? estimated(s) : false, unconfirmed: t?.unconfirmed ?? false }
  }

  /** Continue all: types `continue`, then Enter, into each session the agent's (reset) condition holds. */
  async continueAll(agent: string): Promise<string[]> {
    if (!this.o.input) throw new RpcError('unavailable', 'typing into an agent is not available')
    const held = this.conditions.continueAll(agent)
    const sent: string[] = []
    for (const id of held) {
      const s = this.tracks.get(id)?.machine.state
      // sessions not live or no longer failed with an account-level error are left alone (only on the click)
      if (!s || s.phase !== 'failed' || !isAccountKind(s.failureKind)) continue
      if (await this.o.input(id, CONTINUE_TEXT).catch(() => false)) sent.push(id)
    }
    return sent
  }

  /** Report wrong status: write a report bundle for the session; nothing about it changes. */
  report(sessionId: string, expected: ExpectedState, note?: string): Promise<{ dir: string; ms: number }> {
    const t = this.tracks.get(sessionId)
    return this.reports.write({ sessionId, expected, note: note ?? null, machine: t?.machine ?? null, unconfirmed: t?.unconfirmed ?? false })
  }

  /** The `statusApi` calls. */
  handlers(): Handlers<typeof statusApi> {
    return {
      'status.why': ({ id }) => this.why(id),
      'status.report': ({ id, expected, note }) => this.report(id, expected, note),
      'status.continueAll': async ({ agent }) => ({ sessionIds: await this.continueAll(agent) }),
      'status.setViewing': async ({ id }) => {
        this.setViewing(id)
        return { ok: true }
      },
    }
  }

  /** The `core.status` gauge. */
  get resourceCounts(): { sessions: number; ringEntries: number; timers: number; lifecycles: number; conditions: number; listeners: number } {
    let ringEntries = 0
    let timers = this.viewTimer ? 1 : 0
    for (const t of this.tracks.values()) {
      ringEntries += t.machine.ring.length
      if (t.trustTimer) timers++
      if (t.unconfirmedTimer) timers++
    }
    const c = this.conditions.resourceCounts
    return { sessions: this.tracks.size, ringEntries, timers: timers + c.conditionTimers, lifecycles: this.lifecycles.size, conditions: c.conditions, listeners: this.notices.listenerCount }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offSessions()
    if (this.viewTimer) clearTimeout(this.viewTimer)
    this.viewTimer = null
    for (const t of this.tracks.values()) this.stopTimers(t)
    this.tracks.clear()
    this.lifecycles.clear()
    this.conditions.dispose()
    this.store.dispose()
    this.notices.dispose()
  }

  // ── the lifecycle: spawn, PTY exit, holder lost ───────────────────────────────────────────────

  private lifecycleChanged(id: string, v: SessionView): void {
    const prev = this.lifecycles.get(id)
    this.lifecycles.set(id, v.lifecycle)
    if (prev === v.lifecycle) return
    if (v.lifecycle === 'live') {
      // a row first seen live (a rebuilt session) was not seen spawning: its status is restored
      if (prev === undefined) this.restore(v)
      else this.spawned(v, prev)
    } else if (prev === 'live') this.ended(v)
  }

  /**
   * "Agent PTY spawned": `starting`, the attention set emptied; the trust window starts. The spawn is placed at
   * the agent's launch when known: the session turns live once the spawn is recorded, after the agent may already have
   * fired its first hooks.
   */
  private spawned(v: SessionView, prev: Lifecycle): void {
    this.drop(v.id)
    const noTurns = v.agent === SHELL_AGENT
    const now = this.mono()
    const launched = this.o.launchedAt?.(v.id) ?? null
    const startMono = launched !== null && launched <= now ? launched : now
    const machine = new SessionMachine({ start: initialStatus(this.now()), startMono, prompt: prev === 'creating' && this.launchPrompt(v.id), noTurns })
    const gate = this.trustGate(v.agent, v.id)
    const t: Track = { id: v.id, agent: v.agent, projectId: v.projectId, machine, unconfirmed: false, unconfirmedTimer: null, trustTimer: null }
    this.tracks.set(v.id, t)
    this.apply(v.id, { source: 'reconcile', events: [{ t: 'pty.spawned' }], mono: startMono, spooled: false, quiet: true })
    this.publish(t)
    // per repo: watched until an event of such an agent came from the project. Per launch: watched every time
    if (gate === 'launch' || (gate === 'repo' && !this.o.projects.get(v.projectId)?.trustConfirmed)) {
      t.trustTimer = setTimeout(() => {
        t.trustTimer = null
        this.apply(v.id, { source: 'reconcile', events: [{ t: 'trust.timeout' }], spooled: false })
      }, L.trustWindowMs)
    }
  }

  /** The agent PTY exited or its holder was lost: the session's status goes (lifecycle `detached`, no phase). */
  private ended(v: SessionView): void {
    const t = this.tracks.get(v.id)
    if (!t) return
    const reason = v.endReason ?? 'exited'
    const crashed = reason === 'crashed' || reason === 'lost'
    const at = this.now()
    const quiet = t.unconfirmed
    this.drop(v.id)
    this.conditions.leave(v.id)
    this.write({
      sessionId: v.id,
      runtime: { phase: 'idle', attention: '[]', background: false, failureKind: null, unread: crashed && this.viewing !== v.id, statusSource: reason === 'stopped' ? 'user' : 'reconcile', statusAt: at, lastActivityAt: at },
      events: [{ at, source: reason === 'stopped' ? 'user' : 'reconcile', event: 'pty.exited', summary: reason, phaseAfter: 'idle' }],
    })
    this.notify({ k: 'withdraw', sessionId: v.id })
    if (crashed && !quiet) this.notify({ k: 'N3', sessionId: v.id, reason })
  }

  /** A live session's status from the database, shown at once and unconfirmed until a live signal or a reconcile. */
  private restore(v: SessionView): void {
    const r = this.o.db.get<RuntimeRow>(
      'SELECT phase, attention, background, failure_kind, unread, status_source, status_at, last_activity_at, model, effort, permission_mode AS permissionMode, cost_usd, context_pct FROM session_runtime WHERE session_id = ?',
      v.id,
    )
    const s = initialStatus(this.now())
    if (r) {
      let attention: AttentionItem[] = []
      try {
        const a = JSON.parse(r.attention) as unknown
        if (Array.isArray(a)) attention = a.filter((x) => zAttentionItem.safeParse(x).success) as AttentionItem[]
      } catch {
        attention = []
      }
      Object.assign(s, {
        phase: r.phase,
        attention,
        background: r.background !== 0,
        failureKind: r.failure_kind,
        unread: r.unread !== 0,
        source: r.status_source,
        at: r.status_at,
        lastActivityAt: r.last_activity_at,
        model: r.model,
        effort: r.effort,
        permissionMode: r.permissionMode,
        costUsd: r.cost_usd,
        contextPct: r.context_pct,
      })
    }
    const noTurns = v.agent === SHELL_AGENT
    const machine = new SessionMachine({ start: s, startMono: null, prompt: false, noTurns })
    const t: Track = { id: v.id, agent: v.agent, projectId: v.projectId, machine, unconfirmed: !noTurns, unconfirmedTimer: null, trustTimer: null }
    if (t.unconfirmed) {
      t.unconfirmedTimer = setTimeout(() => {
        t.unconfirmedTimer = null
        this.confirm(t)
      }, L.unconfirmedStatusMs)
    }
    this.tracks.set(v.id, t)
    this.publish(t)
  }

  // ── applying ──────────────────────────────────────────────────────────────────────────────────

  /**
   * `quiet`: notify nothing (a reconcile's result). Kea's own inputs (spawn, the trust window) come as `reconcile`
   * and do not confirm a restored status; viewing and typing (`user`) neither.
   */
  private apply(id: string, inp: { source: StatusSource; events: TableEvent[]; mono?: bigint | number | undefined; at?: number | undefined; spooled: boolean; raw?: unknown; quiet?: boolean }): boolean {
    const t = this.tracks.get(id)
    if (!t || this.disposed) return false
    if (!inp.spooled && inp.source !== 'reconcile' && inp.source !== 'user') this.confirm(t)
    if (inp.source === 'hook' || inp.source === 'status-file') this.trustProven(t)
    const quiet = t.unconfirmed || inp.spooled || inp.quiet === true
    const mono = inp.mono === undefined ? this.mono() : typeof inp.mono === 'bigint' ? inp.mono : BigInt(Math.trunc(inp.mono))
    const at = inp.at ?? this.now()
    const rec: Omit<SignalRecord, 'seq'> = { mono, at, source: inp.source, spooled: inp.spooled, events: inp.events, ...(inp.raw !== undefined ? { raw: capRaw(inp.raw) } : {}) }
    const r = t.machine.apply(rec, this.viewing === id)
    if (r.dropped) {
      this.o.log.debug('status input too late to place', { sessionId: id, source: inp.source })
      return true
    }
    this.carryOut(t, r, quiet, inp.source, at)
    return true
  }

  /** Effects, the journal, the batch and the stores for one applied input. */
  private carryOut(t: Track, r: Applied, quiet: boolean, source: StatusSource, at: number): void {
    const { before, after } = r
    const journal: StatusEvent[] = []
    const session: SessionFields = {}
    // one prompt, one N1: a hook read late, placed before the status file's reading of the same prompt, takes over
    // the notification the file's item had, rather than posting a second one and withdrawing the first
    let fileItem = r.reordered ? before.attention.find((a) => a.source === 'status-file' && !a.estimated && !after.attention.some((b) => b.key === a.key)) : undefined
    let rekeyed: string | null = null
    for (const st of r.steps) {
      if (st.ignored) continue
      for (const e of st.result.effects) {
        if (r.reordered && !consistent(e, after, before)) continue
        if (fileItem && e.k === 'N1') {
          rekeyed = fileItem.key
          this.effect(t, { k: 'rekey', from: fileItem.key, to: e.item.key }, quiet, session)
          fileItem = undefined
          continue
        }
        this.effect(t, e, quiet, session)
      }
      if (st.result.changed || alwaysJournaled(st.ev)) {
        const ph = r.reordered ? after.phase : st.result.state.phase
        const note = [st.result.note, r.reordered ? 'placed by emission time' : undefined].filter(Boolean).join('; ') || undefined
        journal.push({ at, source, event: st.ev.t, summary: summaryOf(st.ev, st.result.state, note), phaseAfter: ph })
      }
    }
    if (r.reordered) {
      // what the reorder changed beyond the input's own effects: items that are gone are withdrawn
      const gone = before.attention.filter((a) => !after.attention.some((b) => b.key === a.key) && a.key !== rekeyed).map((a) => a.key)
      if (gone.length) this.notify({ k: 'withdraw', sessionId: t.id, keys: gone })
    }
    // a session no longer failed with its condition's kind leaves it (a new turn, a reconcile)
    if (before.phase === 'failed' && isAccountKind(before.failureKind) && !(after.phase === 'failed' && after.failureKind === before.failureKind)) this.conditions.leave(t.id)
    const runtimeChanged = !sameRuntime(before, after)
    if (runtimeChanged || journal.length || Object.keys(session).length) this.write({ sessionId: t.id, runtime: runtimeOf(after), events: journal, ...(Object.keys(session).length ? { session } : {}) })
    if (runtimeChanged || before.sawHeuristic !== after.sawHeuristic || before.exactMono !== after.exactMono) this.publish(t)
  }

  private effect(t: Track, e: Effect, quiet: boolean, session: SessionFields): void {
    switch (e.k) {
      case 'N1':
        if (!quiet) this.notify({ k: 'N1', sessionId: t.id, item: e.item, trust: e.trust })
        return
      case 'N2':
        if (!quiet) this.notify({ k: 'N2', sessionId: t.id, turnMs: e.turnMs, lastMessage: e.lastMessage, background: e.background })
        return
      case 'N3':
        if (!quiet) this.notify({ k: 'N3', sessionId: t.id, reason: e.kind })
        return
      case 'withdraw':
        this.notify({ k: 'withdraw', sessionId: t.id, ...(e.keys ? { keys: e.keys } : {}) })
        return
      case 'rekey':
        this.notify({ k: 'rekey', sessionId: t.id, from: e.from, to: e.to })
        return
      case 'condition':
        this.conditions.join(t.agent, t.id, e.kind, e.resetsAt, this.now(), quiet)
        return
      case 'conditionClear':
        this.conditions.clear(t.agent)
        return
      case 'agentSession':
        session.agentSessionId = e.agentSessionId
        if (e.transcriptPath !== null) session.transcriptPath = e.transcriptPath
        return
      case 'title':
        session.title = { title: e.title, source: e.source }
        return
    }
  }

  /** Whose answer this session's trust is (the `trustGated` option); false for the `shell` pseudo-agent, which has no trust question. */
  private trustGate(agent: string, sessionId: string): false | 'repo' | 'launch' {
    if (agent === SHELL_AGENT) return false
    return this.o.trustGated ? this.o.trustGated(agent, sessionId) : 'repo'
  }

  /**
   * The first hook or status-file reading from the agent: the trust window ends and, for an agent that keeps its trust
   * per repository, the repo's trust is confirmed. The trust dialog holds hooks back and writes no status
   * file.
   */
  private trustProven(t: Track): void {
    if (t.trustTimer) clearTimeout(t.trustTimer)
    t.trustTimer = null
    // asked now, not when the session was tracked: a restored session is tracked while core is still being built
    if (this.o.projects.get(t.projectId)?.trustConfirmed || this.trustGate(t.agent, t.id) !== 'repo') return
    try {
      const n = this.o.db.tx(() => this.o.db.run('UPDATE projects SET trust_confirmed = 1 WHERE id = ? AND trust_confirmed = 0', t.projectId))
      if (n > 0) this.o.projectChanged?.(t.projectId)
    } catch (e) {
      this.o.log.warn('project trust not recorded', { projectId: t.projectId, error: String(e) })
    }
  }

  private confirm(t: Track): void {
    if (t.unconfirmedTimer) clearTimeout(t.unconfirmedTimer)
    t.unconfirmedTimer = null
    if (!t.unconfirmed) return
    t.unconfirmed = false
    this.publish(t)
  }

  /** Viewed for the dwell: read; a detached crashed or lost session too. */
  private viewed(id: string): void {
    const t = this.tracks.get(id)
    if (t) {
      // a view that changes nothing is not an input: the recent-signal ring keeps signals
      if (t.machine.state.unread) this.apply(id, { source: 'user', events: [{ t: 'user.viewed' }], spooled: false })
      return
    }
    const r = this.o.db.get<{ unread: number; lifecycle: Lifecycle; end_reason: string | null }>(
      'SELECT r.unread, s.lifecycle, s.end_reason FROM session_runtime r JOIN sessions s ON s.id = r.session_id WHERE r.session_id = ?',
      id,
    )
    if (!r || r.lifecycle !== 'detached' || r.unread === 0) return
    this.write({ sessionId: id, runtime: { unread: false } })
    this.notify({ k: 'withdraw', sessionId: id })
  }

  /** Queue a status write; at shutdown the batch refuses it (nothing is lost that a reconcile cannot rebuild). */
  private write(w: StatusWrite): void {
    try {
      this.o.batch.queue(w)
    } catch (e) {
      this.o.log.warn('status write refused', { sessionId: w.sessionId, error: String(e) })
    }
  }

  private publish(t: Track): void {
    const s = t.machine.state
    const v: SessionStatus = { sessionId: t.id, unconfirmed: t.unconfirmed, source: s.source, at: s.at, compacting: s.compacting, estimated: estimated(s) }
    const cur = this.store.get(t.id)
    if (!cur || JSON.stringify(cur) !== JSON.stringify(v)) this.store.set(t.id, v)
  }

  private notify(n: StatusNotice): void {
    this.notices.fire(n)
  }

  private launchPrompt(id: string): boolean {
    const r = this.o.db.get<{ launch_config: string }>('SELECT launch_config FROM sessions WHERE id = ?', id)
    try {
      const cfg = JSON.parse(r?.launch_config ?? '{}') as { prompt?: unknown }
      return typeof cfg.prompt === 'string' && cfg.prompt.trim() !== ''
    } catch {
      return false
    }
  }

  private stopTimers(t: Track): void {
    if (t.trustTimer) clearTimeout(t.trustTimer)
    if (t.unconfirmedTimer) clearTimeout(t.unconfirmedTimer)
    t.trustTimer = null
    t.unconfirmedTimer = null
  }

  /** The session's status goes (its ring with it). */
  private drop(id: string): void {
    const t = this.tracks.get(id)
    if (!t) return
    this.stopTimers(t)
    this.tracks.delete(id)
    this.store.delete(id)
  }

  private forget(id: string): void {
    this.drop(id)
    this.lifecycles.delete(id)
    this.conditions.leave(id)
    if (this.viewing === id) this.setViewing(null)
  }
}

/** Estimated: only tier 3 has been seen. */
function estimated(s: StatusState): boolean {
  return s.sawHeuristic && s.exactMono === null
}

/** A reordered input's own effect still holds after the recomputation, and was not carried out already. */
function consistent(e: Effect, after: StatusState, before: StatusState): boolean {
  switch (e.k) {
    case 'N1':
      return after.attention.some((a) => a.key === e.item.key)
    case 'N2':
      // a turn that was already finished when this input came (the status file's idle before a Stop read late) posted its N2
      return after.phase === 'ready' && before.phase !== 'ready'
    case 'conditionClear':
      return after.phase === 'ready'
    case 'rekey':
      return after.attention.some((a) => a.key === e.to)
    case 'N3':
      return after.phase === 'failed' && after.failureKind === e.kind
    case 'condition':
      return after.phase === 'failed' && after.failureKind === e.kind
    case 'withdraw':
      return false // the diff decides (carryOut)
    case 'agentSession':
    case 'title':
      return true
  }
}

/** A raw signal larger than a hook envelope's cap is not kept whole. */
function capRaw(raw: unknown): unknown {
  try {
    const n = Buffer.byteLength(JSON.stringify(raw) ?? '')
    return n <= L.hookEnvelopeMaxBytes ? raw : { oversize: n }
  } catch {
    return { unserialisable: true }
  }
}
