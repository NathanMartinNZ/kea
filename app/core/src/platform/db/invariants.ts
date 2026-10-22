// The database's invariants, as queries, each under its number: core runs them after every open (the startup
// self-check: violations are logged as errors, each one a bug) and U-DB-2 checks that each violation is flagged.
//
// What the database alone can show. Invariant 4 (`title_source` only moves forward) is a property of changes, not of
// a state: the `sessions_title_forward` trigger refuses a backward step (schema.ts). The disk and git halves of
// invariant 8 (no worktree on disk; the snapshot ref exists until purged) are checked by the worktree tests.

import { L } from '@kea/protocol'
import type { KeaDb } from './db.ts'

export interface Violation {
  /** The invariant's number (1–8). */
  invariant: number
  /** The rows involved. */
  detail: string
}

type Check = { invariant: number; sql: string; params?: unknown[]; describe(row: Record<string, unknown>): string }

const CHECKS: Check[] = [
  {
    invariant: 1,
    sql: `SELECT s.id, (SELECT count(*) FROM ptys p WHERE p.session_id = s.id AND p.kind = 'agent' AND p.state = 'running') AS n
          FROM sessions s WHERE s.lifecycle = 'live' AND n != 1`,
    describe: (r) => `live session ${r.id} has ${r.n} running agent PTYs (exactly 1 expected)`,
  },
  {
    invariant: 2,
    sql: `SELECT id, port_base FROM sessions WHERE port_base IS NOT NULL AND (port_base < ? OR port_base + ? - 1 > ?)`,
    params: [L.portRangeStart, L.portBlockSize, L.portRangeEnd],
    describe: (r) => `session ${r.id}: port block at ${r.port_base} is outside the session port range`,
  },
  {
    invariant: 2,
    sql: `SELECT a.id AS a, b.id AS b, a.port_base AS pa, b.port_base AS pb FROM sessions a JOIN sessions b ON a.id < b.id
          WHERE a.port_base IS NOT NULL AND b.port_base IS NOT NULL AND abs(a.port_base - b.port_base) < ?`,
    params: [L.portBlockSize],
    describe: (r) => `sessions ${r.a} and ${r.b}: port blocks at ${r.pa} and ${r.pb} overlap`,
  },
  {
    invariant: 3,
    sql: `SELECT id, cwd, worktree_root FROM sessions WHERE isolation = 'worktree' AND lifecycle != 'deleted'
          AND (worktree_root IS NULL OR substr(cwd, 1, length(worktree_root) + 1) != worktree_root || '/')`,
    describe: (r) => `worktree session ${r.id}: cwd ${r.cwd} is not inside its worktree root ${r.worktree_root}`,
  },
  {
    invariant: 5,
    sql: `SELECT "table" AS t, rowid AS r, parent AS p FROM pragma_foreign_key_check`,
    describe: (r) => `${r.t} row ${r.r} refers to a missing ${r.p} row`,
  },
  {
    invariant: 6,
    sql: `SELECT s.id, r.session_id IS NULL AS noRuntime, u.session_id IS NULL AS noUi FROM sessions s
          LEFT JOIN session_runtime r ON r.session_id = s.id LEFT JOIN session_ui u ON u.session_id = s.id
          WHERE r.session_id IS NULL OR u.session_id IS NULL`,
    describe: (r) => `session ${r.id} has no ${r.noRuntime ? 'session_runtime' : 'session_ui'} row`,
  },
  {
    invariant: 7,
    sql: `SELECT s.id, s.lifecycle FROM sessions s JOIN session_runtime r ON r.session_id = s.id
          WHERE s.lifecycle != 'live' AND (r.attention != '[]' OR r.background != 0)`,
    describe: (r) => `session ${r.id} is ${r.lifecycle} but has attention items or background set`,
  },
  {
    invariant: 7,
    sql: `SELECT id, lifecycle, end_reason FROM sessions WHERE end_reason IS NOT NULL AND lifecycle NOT IN ('detached', 'archived', 'deleted')`,
    describe: (r) => `session ${r.id} is ${r.lifecycle} but has end_reason ${r.end_reason}`,
  },
  {
    invariant: 7,
    sql: `SELECT session_id AS id, phase, failure_kind FROM session_runtime WHERE failure_kind IS NOT NULL AND phase != 'failed'`,
    describe: (r) => `session ${r.id}: failure_kind ${r.failure_kind} while phase is ${r.phase}`,
  },
  {
    invariant: 8,
    sql: `SELECT s.id, s.deleted_at, s.port_base, (SELECT count(*) FROM ptys p WHERE p.session_id = s.id AND p.state = 'running') AS running
          FROM sessions s WHERE s.lifecycle = 'deleted' AND (s.deleted_at IS NULL OR s.port_base IS NOT NULL OR running > 0)`,
    describe: (r) =>
      `deleted session ${r.id}: ${[r.deleted_at === null ? 'no deleted_at' : '', r.port_base !== null ? `port block ${r.port_base}` : '', Number(r.running) > 0 ? `${r.running} running PTYs` : ''].filter(Boolean).join(', ')}`,
  },
]

/** Every violation in the database now (an empty list when it is consistent). */
export function checkInvariants(db: KeaDb): Violation[] {
  const out: Violation[] = []
  for (const c of CHECKS) {
    for (const row of db.all<Record<string, unknown>>(c.sql, ...(c.params ?? []))) out.push({ invariant: c.invariant, detail: c.describe(row) })
  }
  return out
}
