// The status engine in-process, for the suites that drive it hard without holders or a ptyhost: an in-memory database,
// core's write batch, a `sessions` store the test moves through the lifecycle, and the engine following it, as core.ts
// wires them. Used by tests/chaos/core-status.test.ts and tests/memory/core-status.test.ts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger, ulid } from '@kea/kit'
import { KeyedStore, type EndReason, type Lifecycle, type SessionView } from '@kea/protocol'
import { StatusBatch } from '@kea/core/src/platform/db/batch.ts'
import { openDatabase, type KeaDb } from '@kea/core/src/platform/db/db.ts'
import { insertSession } from '@kea/core/src/sessions/rows.ts'
import { StatusEngine } from '@kea/core/src/status/engine.ts'

export interface EngineUnderTest {
  db: KeaDb
  batch: StatusBatch
  engine: StatusEngine
  sessions: KeyedStore<SessionView>
  /** A temp KEA_HOME (status reports go under it). */
  home: string
  /** Session ids, live (spawned) unless `live: false`. */
  ids: string[]
  /** Move a session through the lifecycle (as the sessions store shows it). */
  life(id: string, lifecycle: Lifecycle, endReason?: EndReason | null): void
  /** One session's runtime row, after the batch is flushed. */
  runtime(id: string): Record<string, unknown> | undefined
  dispose(): void
}

/**
 * `n` sessions of a turn-taking agent (`fake`) in a trusted project. `mono`: the engine's clock for inputs without one
 * (ns; the spawn's stamp, so inputs stamped after it belong to the new agent).
 */
export function engineUnderTest(o: { sessions: number; live?: boolean; mono?: () => bigint; agent?: string }): EngineUnderTest {
  const log = createMemoryLogger({ process: 'core' })
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-status-')))
  const { db } = openDatabase({ file: ':memory:', log })
  const batch = new StatusBatch(db)
  const sessions = new KeyedStore<SessionView>('sessions')
  const projectId = ulid()
  const ids: string[] = []
  const views = new Map<string, SessionView>()
  db.tx(() => {
    db.run('INSERT INTO projects (id, name, root_path, sort_order, created_at, trust_confirmed) VALUES (?, ?, ?, 1, 0, 1)', projectId, 'demo', '/repos/demo')
    for (let i = 0; i < o.sessions; i++) {
      const id = ulid()
      ids.push(id)
      insertSession(db, {
        id, projectId, slug: `s${i}`, title: `S${i}`, titleSource: 'auto', isolation: 'inplace', cwd: '/repos/demo', worktreeRoot: null, branch: null,
        baseBranch: null, baseCommit: null, portBase: null, agent: o.agent ?? 'fake', agentSessionId: null, transcriptPath: null, launchConfig: '{}',
        lifecycle: 'creating', endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null, sortOrder: i,
        pinnedOrder: 0, createdAt: 0, archivedAt: null,
      })
    }
  })
  const engine = new StatusEngine({
    db,
    batch,
    log,
    sessions,
    projects: { get: () => ({ trustConfirmed: true }) },
    home,
    version: '0.0.0-test',
    ...(o.mono ? { mono: o.mono } : {}),
  })
  const life = (id: string, lifecycle: Lifecycle, endReason: EndReason | null = null) => {
    db.run('UPDATE sessions SET lifecycle = ?, end_reason = ? WHERE id = ?', lifecycle, endReason, id)
    const v = { ...(views.get(id) ?? { id, projectId, agent: o.agent ?? 'fake' }), lifecycle, endReason } as SessionView
    views.set(id, v)
    sessions.set(id, v)
  }
  for (const id of ids) {
    life(id, 'creating')
    if (o.live !== false) life(id, 'live')
  }
  let gone = false
  return {
    db,
    batch,
    engine,
    sessions,
    home,
    ids,
    life,
    runtime(id) {
      batch.flush()
      return db.get('SELECT * FROM session_runtime WHERE session_id = ?', id)
    },
    dispose() {
      if (gone) return
      gone = true
      engine.dispose()
      batch.dispose()
      sessions.dispose()
      db.close()
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}
