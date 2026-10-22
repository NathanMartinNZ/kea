// Terminal records in the database: core's PTY records, one row each in the `ptys` table. A row belongs to its
// session (deleted with it), and its working directory is the session's `cwd`.
//
// Shell tabs of the `shells` pane have no session (they live under the `shells` pseudo-session), so `RoutedRecords`
// keeps theirs in `<KEA_HOME>/terminals.json` (FileRecords) and every other session's in the database. A PTY of a
// session the database does not have is refused (FK), so a record can never outlive its session.

import type { Logger } from '@kea/kit'
import type { PtyKind, PtyState } from '@kea/protocol'
import type { KeaDb } from '../platform/db/db.ts'
import { SHELLS_SESSION } from './reconcile.ts'
import type { TerminalRecord, TerminalRecords } from './records.ts'

/** A `ptys` row joined with its session's cwd, columns aliased to camelCase. */
type PtyRow = {
  ptyId: string
  sessionId: string
  kind: PtyKind
  title: string | null
  argv: string
  holderPid: number | null
  holderStartedAt: number | null
  childPid: number | null
  cols: number | null
  rows: number | null
  state: PtyState
  exitCode: number | null
  exitSignal: number | null
  tabOrder: number
  createdAt: number
  endedAt: number | null
  cwd: string
}

const LIST = `SELECT p.id AS ptyId, p.session_id AS sessionId, p.kind, p.title, p.argv, p.holder_pid AS holderPid, p.holder_started_at AS holderStartedAt,
  p.child_pid AS childPid, p.cols, p.rows, p.state, p.exit_code AS exitCode, p.exit_signal AS exitSignal, p.tab_order AS tabOrder,
  p.created_at AS createdAt, p.ended_at AS endedAt, s.cwd FROM ptys p JOIN sessions s ON s.id = p.session_id ORDER BY p.session_id, p.tab_order, p.created_at`
const GET = `SELECT p.id AS ptyId, p.session_id AS sessionId, p.kind, p.title, p.argv, p.holder_pid AS holderPid, p.holder_started_at AS holderStartedAt,
  p.child_pid AS childPid, p.cols, p.rows, p.state, p.exit_code AS exitCode, p.exit_signal AS exitSignal, p.tab_order AS tabOrder,
  p.created_at AS createdAt, p.ended_at AS endedAt, s.cwd FROM ptys p JOIN sessions s ON s.id = p.session_id WHERE p.id = ?`
const UPSERT = `INSERT INTO ptys (id, session_id, kind, title, argv, holder_pid, holder_started_at, child_pid, cols, rows, state, exit_code, exit_signal,
  tab_order, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, kind = excluded.kind, title = excluded.title, argv = excluded.argv,
  holder_pid = excluded.holder_pid, holder_started_at = excluded.holder_started_at, child_pid = excluded.child_pid, cols = excluded.cols,
  rows = excluded.rows, state = excluded.state, exit_code = excluded.exit_code, exit_signal = excluded.exit_signal, tab_order = excluded.tab_order,
  created_at = excluded.created_at, ended_at = excluded.ended_at`
const DELETE = 'DELETE FROM ptys WHERE id = ?'

function fromRow(r: PtyRow): TerminalRecord {
  let argv: string[] = []
  try {
    const v = JSON.parse(r.argv) as unknown
    if (Array.isArray(v) && v.every((a) => typeof a === 'string')) argv = v
  } catch {
    // a malformed argv reads as empty; the holder's state file still has the real one
  }
  return { ...r, argv, cols: r.cols ?? 0, rows: r.rows ?? 0 }
}

/** Write one record's row (the caller holds the transaction). */
export function upsertPtyRow(db: KeaDb, r: TerminalRecord): void {
  db.run(UPSERT, r.ptyId, r.sessionId, r.kind, r.title, JSON.stringify(r.argv), r.holderPid, r.holderStartedAt, r.childPid, r.cols || null, r.rows || null, r.state, r.exitCode, r.exitSignal, r.tabOrder, r.createdAt, r.endedAt)
}

/** PTY records on the `ptys` table. Every read goes to the database (one connection, statements prepared once). */
export class DbRecords implements TerminalRecords {
  readonly loaded = true
  private readonly db: KeaDb

  constructor(db: KeaDb) {
    this.db = db
  }

  list(): TerminalRecord[] {
    return this.db.all<PtyRow>(LIST).map(fromRow)
  }

  get(ptyId: string): TerminalRecord | undefined {
    const r = this.db.get<PtyRow>(GET, ptyId)
    return r ? fromRow(r) : undefined
  }

  put(r: TerminalRecord): void {
    this.putMany([r])
  }

  /** All or nothing, in one transaction. Throws for a PTY whose session has no row. */
  putMany(rs: readonly TerminalRecord[]): void {
    if (rs.length) this.db.tx(() => rs.forEach((r) => upsertPtyRow(this.db, r)))
  }

  delete(ptyId: string): void {
    this.db.tx(() => this.db.run(DELETE, ptyId))
  }
}

/**
 * The shells pseudo-session's records in the file, every real session's in the database. A holder found without a
 * record gets one at reconciliation only for the file's part, and only when the file was lost; the database's
 * part is rebuilt from the state files before the first reconciliation.
 */
export class RoutedRecords implements TerminalRecords {
  private readonly file: TerminalRecords
  private readonly db: TerminalRecords
  private readonly log: Logger

  constructor(file: TerminalRecords, db: TerminalRecords, log: Logger) {
    this.file = file
    this.db = db
    this.log = log
  }

  get loaded(): boolean {
    return this.file.loaded
  }

  rebuildsSession(sessionId: string): boolean {
    return sessionId === SHELLS_SESSION && !this.file.loaded
  }

  private of(sessionId: string): TerminalRecords {
    return sessionId === SHELLS_SESSION ? this.file : this.db
  }

  list(): TerminalRecord[] {
    return [...this.file.list(), ...this.db.list()]
  }

  get(ptyId: string): TerminalRecord | undefined {
    return this.file.get(ptyId) ?? this.db.get(ptyId)
  }

  put(r: TerminalRecord): void {
    this.putMany([r])
  }

  putMany(rs: readonly TerminalRecord[]): void {
    const shells = rs.filter((r) => r.sessionId === SHELLS_SESSION)
    const sessions = rs.filter((r) => r.sessionId !== SHELLS_SESSION)
    // a record that moved between the two (it cannot today) would otherwise be in both
    for (const r of rs) {
      const other = r.sessionId === SHELLS_SESSION ? this.db : this.file
      if (other.get(r.ptyId)) other.delete(r.ptyId)
    }
    if (shells.length) this.file.putMany(shells)
    if (sessions.length) {
      try {
        this.db.putMany(sessions)
      } catch (e) {
        this.log.warn('terminal records of sessions the database does not have were not written', { ptyIds: sessions.map((r) => r.ptyId), error: String(e) })
        throw e
      }
    }
  }

  delete(ptyId: string): void {
    const r = this.get(ptyId)
    if (r) this.of(r.sessionId).delete(ptyId)
  }
}
