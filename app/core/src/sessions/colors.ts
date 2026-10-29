// Each session's colour in the sidebar: an index into the design's session palette (`L.sessionColors` colours), chosen
// once by core when the session's record is made. A project's sessions in the main list (creating, failed creation,
// live, detached) take the least used colour, the lowest on a tie, so a fresh project's sessions get 0, 1, 2, … and
// then 0 again, and a colour an archive or a delete freed is taken first. Projects count apart.
//
// The colour lives in the session's `session_ui.state` under `color`, beside the file panel's `files`: core writes it
// alone, with `json_set`, and `sessions.setUi` never writes it. A missing or malformed value reads as 0. Sessions made
// before colours existed get theirs once, at core's start (`backfillColors`), before the store is first read.

import { L } from '@kea/protocol'
import type { KeaDb } from '../platform/db/db.ts'

/** The key in `session_ui.state`. */
export const COLOR_UI_KEY = 'color'

/** Lifecycles of the sidebar's main list: the sessions whose colours a new one avoids. */
const MAIN_LIST = `('creating', 'create_failed', 'live', 'detached')`

/** The stored colour of `session_ui` row `u`, or NULL (SQL). */
export const COLOR_SQL = `CASE WHEN json_valid(u.state) THEN json_extract(u.state, '$.${COLOR_UI_KEY}') END`

/** A stored value as a colour, or null when it is not one. */
function asColor(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v % L.sessionColors : null
}

/** How many of the project's main-list sessions (other than `except`) have each colour. */
function counts(db: KeaDb, projectId: string, except: string | null): number[] {
  const n = new Array<number>(L.sessionColors).fill(0)
  const rows = db.all<{ c: unknown }>(
    `SELECT ${COLOR_SQL} AS c FROM sessions s JOIN session_ui u ON u.session_id = s.id WHERE s.project_id = ? AND s.lifecycle IN ${MAIN_LIST} AND s.id IS NOT ?`,
    projectId,
    except,
  )
  for (const r of rows) {
    const c = asColor(r.c)
    if (c !== null) n[c]!++
  }
  return n
}

/** The least used colour, the lowest on a tie. */
function leastUsed(n: readonly number[]): number {
  let best = 0
  for (let i = 1; i < n.length; i++) if (n[i]! < n[best]!) best = i
  return best
}

/** The colour a new session of the project takes now. */
export function pickColor(db: KeaDb, projectId: string, except: string | null = null): number {
  return leastUsed(counts(db, projectId, except))
}

/** Write a session's colour into its `session_ui` row, keeping the rest of the row. The caller holds the transaction. */
export function writeColor(db: KeaDb, sessionId: string, color: number): void {
  db.run(`UPDATE session_ui SET state = json_set(CASE WHEN json_valid(state) THEN state ELSE '{}' END, '$.${COLOR_UI_KEY}', ?) WHERE session_id = ?`, color, sessionId)
}

/** A session's stored colour, or null when it has none. */
export function colorOf(db: KeaDb, sessionId: string): number | null {
  return asColor(db.get<{ c: unknown }>(`SELECT ${COLOR_SQL} AS c FROM session_ui u WHERE u.session_id = ?`, sessionId)?.c)
}

/**
 * A session back in the main list (unarchived, restored) keeps its colour unless another session there has it now and
 * a free one exists; then, or when it has none, it picks again. The caller holds the transaction.
 */
export function keepOrRepick(db: KeaDb, sessionId: string, projectId: string): void {
  const own = colorOf(db, sessionId)
  const n = counts(db, projectId, sessionId)
  if (own !== null && (n[own] === 0 || !n.includes(0))) return
  writeColor(db, sessionId, leastUsed(n))
}

/**
 * Give every session without a colour one: per project, the main list first in the order its sessions were made, then
 * the rest (archived, deleted) the same way. A session that has a colour keeps it. Returns how many were given one.
 */
export function backfillColors(db: KeaDb): number {
  const missing = db.all<{ id: string; projectId: string }>(
    `SELECT s.id, s.project_id AS projectId FROM sessions s JOIN session_ui u ON u.session_id = s.id WHERE ${COLOR_SQL} IS NULL
     ORDER BY s.project_id, CASE WHEN s.lifecycle IN ${MAIN_LIST} THEN 0 ELSE 1 END, s.created_at, s.id`,
  )
  if (missing.length === 0) return 0
  db.tx(() => {
    for (const m of missing) writeColor(db, m.id, pickColor(db, m.projectId, m.id))
  })
  return missing.length
}
