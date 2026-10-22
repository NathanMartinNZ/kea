// Write batching for status: a status change is a `session_runtime` update plus its `status_events` rows. They
// are collected for one store tick (L.storeTickMs, the tick that coalesces store deltas) and committed in one
// transaction; in the same transaction `status_events` is trimmed to the newest L.statusEventsPerSession rows of each
// session that tick touched — never by a statement per insert. A batch is all there or not at all (I-DB-1). Writes for
// a session deleted meanwhile are dropped, so they cannot fail the batch.

import type { FailureKind, Phase, StatusSource } from '@kea/protocol'
import { L } from '@kea/protocol'
import type { KeaDb } from './db.ts'

/** The `session_runtime` columns, as status sets them. */
export interface RuntimeFields {
  phase: Phase
  /** JSON: pending attention items. */
  attention: string
  background: boolean
  failureKind: FailureKind | null
  unread: boolean
  statusSource: StatusSource | null
  statusAt: number | null
  lastActivityAt: number
  model: string | null
  effort: string | null
  permissionMode: string | null
  costUsd: number | null
  contextPct: number | null
}

/** One `status_events` row ("Why this status?"). */
export interface StatusEvent {
  at: number
  source: StatusSource
  /** AgentEvent.t */
  event: string
  /** Short, no file contents. */
  summary: string | null
  phaseAfter: Phase
}

/** What status writes to the `sessions` row (from an agent's `session.started`, and `meta.title`). */
export interface SessionFields {
  agentSessionId?: string
  transcriptPath?: string | null
  /** A title only moves forward (`auto → agent → user`, invariant 4): one that would move it back is not written. */
  title?: { title: string; source: 'agent' | 'user' }
}

export interface StatusWrite {
  sessionId: string
  runtime?: Partial<RuntimeFields>
  events?: readonly StatusEvent[]
  session?: SessionFields
}

/** A `session_runtime` row, its columns aliased to camelCase (RuntimeFields' names; booleans as 0/1). */
type RuntimeRow = Omit<RuntimeFields, 'background' | 'unread'> & { background: number; unread: number }

const SELECT_RUNTIME = `SELECT phase, attention, background, failure_kind AS failureKind, unread, status_source AS statusSource, status_at AS statusAt,
  last_activity_at AS lastActivityAt, model, effort, permission_mode AS permissionMode, cost_usd AS costUsd, context_pct AS contextPct
  FROM session_runtime WHERE session_id = ?`
const UPDATE_RUNTIME = `UPDATE session_runtime SET phase = ?, attention = ?, background = ?, failure_kind = ?, unread = ?, status_source = ?,
  status_at = ?, last_activity_at = ?, model = ?, effort = ?, permission_mode = ?, cost_usd = ?, context_pct = ? WHERE session_id = ?`
const INSERT_EVENT = 'INSERT INTO status_events (session_id, at, source, event, summary, phase_after) VALUES (?, ?, ?, ?, ?, ?)'
// the newest `keep` rows stay: everything older than the keep-th newest goes (nothing when there are fewer)
const TRIM_EVENTS = `DELETE FROM status_events WHERE session_id = ? AND id < (SELECT id FROM status_events WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`
const SESSION_EXISTS = 'SELECT 1 AS ok FROM sessions WHERE id = ?'
const UPDATE_AGENT_SESSION = 'UPDATE sessions SET agent_session_id = ? WHERE id = ?'
const UPDATE_TRANSCRIPT = 'UPDATE sessions SET transcript_path = ? WHERE id = ?'
// the title trigger refuses a backwards move, which would fail the batch: such a title is simply not written
const UPDATE_TITLE_AGENT = `UPDATE sessions SET title = ?, title_source = 'agent' WHERE id = ? AND title_source IN ('auto', 'agent')`
const UPDATE_TITLE_USER = `UPDATE sessions SET title = ?, title_source = 'user' WHERE id = ?`

function merge(row: RuntimeRow, p: Partial<RuntimeFields>): unknown[] {
  const cur: RuntimeFields = { ...row, background: row.background !== 0, unread: row.unread !== 0 }
  const v: RuntimeFields = { ...cur, ...p }
  return [v.phase, v.attention, v.background ? 1 : 0, v.failureKind, v.unread ? 1 : 0, v.statusSource, v.statusAt, v.lastActivityAt, v.model, v.effort, v.permissionMode, v.costUsd, v.contextPct]
}

export interface StatusBatchOptions {
  /** Default L.storeTickMs. */
  tickMs?: number
  /** After each commit, with the sessions it touched. */
  onCommit?(sessions: string[]): void
  onError?(e: unknown): void
}

export class StatusBatch {
  private readonly db: KeaDb
  private readonly opts: StatusBatchOptions
  // bounded: one tick of status writes (L.storeTickMs), committed and cleared each tick
  private readonly runtime = new Map<string, Partial<RuntimeFields>>()
  private events: { sessionId: string; e: StatusEvent }[] = [] // bounded: as `runtime`, one tick of events
  private readonly session = new Map<string, SessionFields>() // bounded: as `runtime`, one tick of session fields
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** Transactions committed (U-DB-4, the resource report). */
  commits = 0

  constructor(db: KeaDb, opts: StatusBatchOptions = {}) {
    this.db = db
    this.opts = opts
  }

  /** Queue a write for the current tick. Runtime fields merge latest-wins per field; events keep their order. */
  queue(w: StatusWrite): void {
    if (this.disposed) throw new Error('status batch disposed')
    if (w.runtime) this.runtime.set(w.sessionId, { ...this.runtime.get(w.sessionId), ...w.runtime })
    else if (!this.runtime.has(w.sessionId)) this.runtime.set(w.sessionId, {})
    for (const e of w.events ?? []) this.events.push({ sessionId: w.sessionId, e })
    if (w.session) this.session.set(w.sessionId, { ...this.session.get(w.sessionId), ...w.session })
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.tickMs ?? L.storeTickMs)
  }

  /** Writes waiting for the tick (the resource report). */
  get pending(): number {
    return this.runtime.size + this.events.length + this.session.size
  }

  /** Commit what is queued now, in one transaction. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.runtime.size === 0) return
    const runtime = [...this.runtime]
    const events = this.events
    const session = [...this.session]
    this.runtime.clear()
    this.events = []
    this.session.clear()
    const touched: string[] = []
    try {
      this.db.tx(() => {
        const alive = new Set<string>()
        for (const [id] of runtime) if (this.db.get(SESSION_EXISTS, id)) alive.add(id)
        for (const [id, patch] of runtime) {
          if (!alive.has(id)) continue
          touched.push(id)
          if (Object.keys(patch).length === 0) continue
          const row = this.db.get<RuntimeRow>(SELECT_RUNTIME, id)
          if (row) this.db.run(UPDATE_RUNTIME, ...merge(row, patch), id)
        }
        for (const { sessionId, e } of events) {
          if (alive.has(sessionId)) this.db.run(INSERT_EVENT, sessionId, e.at, e.source, e.event, e.summary, e.phaseAfter)
        }
        for (const [id, f] of session) {
          if (!alive.has(id)) continue
          if (f.agentSessionId !== undefined) this.db.run(UPDATE_AGENT_SESSION, f.agentSessionId, id)
          if (f.transcriptPath !== undefined) this.db.run(UPDATE_TRANSCRIPT, f.transcriptPath, id)
          if (f.title) this.db.run(f.title.source === 'user' ? UPDATE_TITLE_USER : UPDATE_TITLE_AGENT, f.title.title.slice(0, L.titleMaxChars), id)
        }
        for (const id of touched) this.db.run(TRIM_EVENTS, id, id, L.statusEventsPerSession - 1)
      })
      this.commits++
    } catch (e) {
      this.opts.onError?.(e)
      return
    }
    this.opts.onCommit?.(touched)
  }

  /** Commit what is left; later writes are refused. */
  dispose(): void {
    if (this.disposed) return
    this.flush()
    this.disposed = true
  }
}
