// A million small status writes through core's write batching: the WAL never passes its checkpoint limit, the page
// cache keeps its size, the prepared statements are the same few throughout, status_events stays trimmed, the file
// stops growing and the heap stays flat.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger, ulid } from '@kea/kit'
import { L } from '@kea/protocol'
import { StatusBatch } from '@kea/core/src/platform/db/batch.ts'
import { openDatabase } from '@kea/core/src/platform/db/db.ts'
import { insertSession } from '@kea/core/src/sessions/rows.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { heapUsed, leakCycles } from './ptyhost-leak.ts'

let cleanup: (() => unknown)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

const WRITES = Number(process.env.KEA_L_MEM_10_WRITES ?? 1_000_000)
const SESSIONS = 20
/** Writes per store tick: far above real status traffic, so a million take seconds, not days. */
const PER_TICK = 100

describe('SQLite under a million writes', () => {
  it(`L-MEM-10 · ${WRITES} small status writes: WAL under its checkpoint limit, page cache unchanged, prepared statements constant, events trimmed, heap flat`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-l-mem-10-'))
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'kea.db')
    const { db } = openDatabase({ file, log: createMemoryLogger({ process: 'core' }) })
    cleanup.push(() => db.close())
    const cache = db.pragma('cache_size')
    expect(cache).toBe(-L.dbCacheKib)

    const sessions: string[] = []
    db.tx(() => {
      const p = ulid()
      db.run('INSERT INTO projects (id, name, root_path, sort_order, created_at) VALUES (?, ?, ?, 1, 0)', p, 'demo', '/repos/demo')
      for (let i = 0; i < SESSIONS; i++) {
        const id = ulid()
        sessions.push(id)
        insertSession(db, {
          id, projectId: p, slug: `s${i}`, title: `S${i}`, titleSource: 'auto', isolation: 'inplace', cwd: '/repos/demo', worktreeRoot: null, branch: null,
          baseBranch: null, baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{}', lifecycle: 'live',
          endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null, sortOrder: i, pinnedOrder: 0, createdAt: 0, archivedAt: null,
        })
      }
    })

    const errors: unknown[] = []
    const batch = new StatusBatch(db, { onError: (e) => errors.push(e) })
    cleanup.push(() => batch.dispose())
    let written = 0
    let walMax = 0
    const statements = new Set<number>()
    const fileBytes: number[] = []
    const growth = await leakCycles({
      total: Math.ceil(WRITES / PER_TICK),
      async cycle(tick) {
        for (let i = 0; i < PER_TICK && written < WRITES; i++, written++) {
          const sessionId = sessions[written % SESSIONS]!
          const phase = written % 3 === 0 ? 'blocked' : 'working'
          batch.queue({
            sessionId,
            runtime: { phase, lastActivityAt: written, contextPct: written % 100 },
            events: [{ at: written, source: 'hook', event: 'PostToolUse', summary: `tool ${written % 7} done`, phaseAfter: phase }],
          })
        }
        batch.flush()
        walMax = Math.max(walMax, db.walBytes())
        if (tick >= 1) statements.add(db.stats.statements) // after the first tick has prepared them all
      },
      async measure() {
        expect(db.pragma('cache_size'), 'page cache').toBe(cache)
        fileBytes.push(fs.statSync(file).size)
        return heapUsed()
      },
    })

    expect(errors).toEqual([])
    expect(written).toBe(WRITES)
    expect(batch.pending).toBe(0)
    // SQLite's own passive checkpoints (every 1000 pages) keep reusing the WAL; the TRUNCATE at the limit is the backstop
    expect(walMax, 'never past the checkpoint limit').toBeLessThanOrEqual(L.dbWalTruncateBytes)
    expect(walMax, 'the writes went through the WAL').toBeGreaterThan(0)
    expect([...statements], 'prepared once, reused').toHaveLength(1)
    const kept = db.all<{ n: number }>('SELECT count(*) AS n FROM status_events GROUP BY session_id')
    expect(kept.map((r) => r.n), 'trimmed to the newest per session').toEqual(sessions.map(() => Math.min(L.statusEventsPerSession, WRITES / SESSIONS)))
    expect(fileBytes.at(-1)!, 'the file stops growing once trimming keeps up').toBeLessThanOrEqual(fileBytes[1]! * 1.5)
    expect(growth.ok, `heap growth ${JSON.stringify({ slope: growth.slope, absolute: growth.absolute })}`).toBe(true)
  })
})
