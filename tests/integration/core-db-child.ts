// The writer core-db.test.ts kills: a stand-in for core that writes status batches into `<file>` as fast as it can
// until it is killed. Each batch k sets every session's runtime `model` to `b<k>` and adds EVENTS_PER_SESSION
// `status_events` rows named `b<k>` per session, in one transaction (platform/db/batch.ts). It prints `pid <pid>` once
// and `c <k>` after each commit, so the test can kill it at a commit count of its choosing, mid-way through the next
// batch.
//
//   node tests/integration/core-db-child.ts <kea.db> <sessions> <events per session>

import { createMemoryLogger, ulid } from '@kea/kit'
import { StatusBatch } from '@kea/core/src/platform/db/batch.ts'
import { openDatabase } from '@kea/core/src/platform/db/db.ts'
import { insertSession } from '@kea/core/src/sessions/rows.ts'

const [file, sessionsArg, eventsArg] = process.argv.slice(2)
const SESSIONS = Number(sessionsArg)
const EVENTS_PER_SESSION = Number(eventsArg)
if (!file || !(SESSIONS > 0) || !(EVENTS_PER_SESSION > 0)) throw new Error('usage: core-db-child.ts <kea.db> <sessions> <events per session>')
const { db } = openDatabase({ file, log: createMemoryLogger({ process: 'core' }) })

// first run: one project with live sessions, each with its running agent PTY
if (!db.get('SELECT 1 AS x FROM projects')) {
  db.tx(() => {
    const p = ulid()
    db.run('INSERT INTO projects (id, name, root_path, sort_order, created_at) VALUES (?, ?, ?, 1, 0)', p, 'demo', '/repos/demo')
    for (let i = 0; i < SESSIONS; i++) {
      const s = ulid()
      insertSession(db, {
        id: s, projectId: p, slug: `s${i}`, title: `S${i}`, titleSource: 'auto', isolation: 'inplace', cwd: '/repos/demo', worktreeRoot: null, branch: null,
        baseBranch: null, baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{}', lifecycle: 'live',
        endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null, sortOrder: i, pinnedOrder: 0, createdAt: 0, archivedAt: null,
      })
      db.run("INSERT INTO ptys (id, session_id, kind, argv, state, created_at) VALUES (?, ?, 'agent', '[]', 'running', 0)", `pty${String(i).padStart(7, '0')}`, s)
    }
  })
}
const sessions = db.all<{ id: string }>('SELECT id FROM sessions ORDER BY id').map((r) => r.id)
const last = db.get<{ m: number | null }>("SELECT max(CAST(substr(event, 2) AS INTEGER)) AS m FROM status_events WHERE event LIKE 'b%'")?.m ?? 0

let k = last
const batch = new StatusBatch(db, { onCommit: () => process.stdout.write(`c ${k}\n`) })
process.stdout.write(`pid ${process.pid}\n`)
function next(): void {
  k++
  for (const s of sessions) {
    const events = Array.from({ length: EVENTS_PER_SESSION }, (_, i) => ({ at: k * 1000 + i, source: 'hook' as const, event: `b${k}`, summary: `event ${i} of batch ${k}`, phaseAfter: 'working' as const }))
    batch.queue({ sessionId: s, runtime: { phase: 'working', model: `b${k}`, lastActivityAt: k }, events })
  }
  batch.flush()
  setImmediate(next)
}
next()
