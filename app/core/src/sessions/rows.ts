// The `sessions` table as typed rows: the writer every session insert goes through (its runtime and UI rows come with
// it, by the `sessions_children` trigger, invariant 6, and its sidebar colour is chosen then: colors.ts) and the few
// queries projects need. The session lifecycle builds on these.

import type { EndReason, Isolation, Lifecycle, TitleSource } from '@kea/protocol'
import type { KeaDb } from '../platform/db/db.ts'
import { pickColor, writeColor } from './colors.ts'

/** One `sessions` row, camelCase. */
export interface SessionRow {
  id: string
  projectId: string
  slug: string
  title: string
  titleSource: TitleSource
  isolation: Isolation
  cwd: string
  worktreeRoot: string | null
  branch: string | null
  baseBranch: string | null
  baseCommit: string | null
  portBase: number | null
  agent: string
  agentSessionId: string | null
  transcriptPath: string | null
  /** JSON: LaunchConfig. */
  launchConfig: string
  lifecycle: Lifecycle
  endReason: EndReason | null
  deletedAt: number | null
  snapshotRef: string | null
  creationStep: string | null
  diskBytes: number | null
  diskAt: number | null
  sortOrder: number
  pinnedOrder: number
  createdAt: number
  archivedAt: number | null
}

const INSERT = `INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, worktree_root, branch, base_branch, base_commit,
  port_base, agent, agent_session_id, transcript_path, launch_config, lifecycle, end_reason, deleted_at, snapshot_ref, creation_step, disk_bytes,
  disk_at, sort_order, pinned_order, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/** Insert a session (and, by trigger, its runtime and UI rows) with its colour. The caller holds the transaction. */
export function insertSession(db: KeaDb, r: SessionRow): void {
  const color = pickColor(db, r.projectId)
  db.run(
    INSERT,
    r.id, r.projectId, r.slug, r.title, r.titleSource, r.isolation, r.cwd, r.worktreeRoot, r.branch, r.baseBranch, r.baseCommit,
    r.portBase, r.agent, r.agentSessionId, r.transcriptPath, r.launchConfig, r.lifecycle, r.endReason, r.deletedAt, r.snapshotRef,
    r.creationStep, r.diskBytes, r.diskAt, r.sortOrder, r.pinnedOrder, r.createdAt, r.archivedAt,
  )
  writeColor(db, r.id, color)
}

/** Sessions that keep their project from being removed: creating or live. */
export function runningSessions(db: KeaDb, projectId: string): { sessionId: string; title: string }[] {
  return db.all<{ sessionId: string; title: string }>(
    `SELECT id AS sessionId, title FROM sessions WHERE project_id = ? AND lifecycle IN ('creating', 'live') ORDER BY sort_order, created_at`,
    projectId,
  )
}

/** Every session id of a project. */
export function sessionIdsOf(db: KeaDb, projectId: string): string[] {
  return db.all<{ id: string }>('SELECT id FROM sessions WHERE project_id = ? ORDER BY created_at', projectId).map((r) => r.id)
}

/**
 * Sessions whose agent PTY ended while Kea was away become `detached`: live ones only, with the reason the PTY gives.
 * Their attention and background state go with them (invariant 7).
 */
export function detachSessions(db: KeaDb, ends: readonly { sessionId: string; reason: EndReason }[]): string[] {
  const changed: string[] = []
  if (!ends.length) return changed
  db.tx(() => {
    for (const e of ends) {
      if (db.run(`UPDATE sessions SET lifecycle = 'detached', end_reason = ? WHERE id = ? AND lifecycle = 'live'`, e.reason, e.sessionId) === 0) continue
      db.run(`UPDATE session_runtime SET attention = '[]', background = 0 WHERE session_id = ?`, e.sessionId)
      changed.push(e.sessionId)
    }
  })
  return changed
}

/** The title a slug starts with (`fix-auth-redirect` → "Fix auth redirect"). */
export function titleFromSlug(slug: string): string {
  const words = slug.split('-').filter(Boolean).join(' ')
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug
}
