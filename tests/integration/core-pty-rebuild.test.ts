// The first shell after a database rebuild with the real pieces: core assembled as main.ts assembles it, on a temp
// KEA_HOME, wired to a real ptyhost and real holders. A session the database lost is given back by its holders, but
// only once the rebuild has run: a window that connects before that is sent a `sessions` snapshot that lists nothing.
// What the shells pane decides on is therefore core's `terminal.restored`, which is answered after the rebuild and the
// reconciliation and counts the sessions that have a terminal.

import fs from 'node:fs'
import path from 'node:path'
import { ulid } from '@kea/kit'
import type { Project } from '@kea/protocol'
import { insertSession } from '@kea/core/src/sessions/rows.ts'
import { procsProbe, type ProcessProbe } from '@kea/core/src/terminal/procs.ts'
import { tinyRepo } from '@kea-tools/repo-factory/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { ptyhostHarness, testEnv, type Harness } from '../support/holders.ts'
import { ownPtyIds, startFullCore, type FullCoreUnderTest } from './core-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function harness(): Promise<Harness> {
  const h = await ptyhostHarness()
  cleanup.push(async () => {
    for (const id of ownPtyIds(h.home)) h.spawned.add(id)
    await h.dispose()
  })
  return h
}

function core(h: Harness, opts: Parameters<typeof startFullCore>[1] = {}): FullCoreUnderTest {
  const c = startFullCore(h, { env: testEnv(), ...opts })
  cleanup.push(() => c.dispose())
  return c
}

describe('the first shell after a database rebuild', () => {
  it('I-PTY-33 · kea.db lost while a session runs: a window that connects before the rebuild is listed no session, and `terminal.restored`, answered only after it, counts the session the holders gave back, so the shells pane opens no hidden shell', async () => {
    const h = await harness()
    const r = tinyRepo({ name: 'demo' })
    cleanup.push(() => r.dispose())
    const first = core(h)
    await first.reconciled()
    const project = (await first.call<{ project: Project }>('projects.add', { path: r.root })).project
    // a live in-place session whose agent PTY runs `cat` (a holder that stays up), and no plain shell
    const sessionId = ulid()
    first.core.db.tx(() =>
      insertSession(first.core.db, {
        id: sessionId, projectId: project.id, slug: `s-${sessionId.slice(-6).toLowerCase()}`, title: 'Session', titleSource: 'user', isolation: 'inplace', cwd: r.root, worktreeRoot: null,
        branch: null, baseBranch: null, baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{"prompt":"x"}',
        lifecycle: 'live', endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null, sortOrder: 0, pinnedOrder: 0,
        createdAt: Date.now(), archivedAt: null,
      }),
    )
    const { ptyId } = await first.core.terminals.launch({ sessionId, kind: 'agent', command: { argv: ['/bin/cat'] }, cwd: r.root, cols: 80, rows: 24 })
    first.dispose()
    const file = path.join(h.home, 'kea.db')
    fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2))

    // the next core: its rebuild asks which holders are alive, and is answered only when the test lets it
    let asked!: () => void
    const rebuilding = new Promise<void>((done) => (asked = done))
    let answer!: () => void
    const gate = new Promise<void>((done) => (answer = done))
    const probe: ProcessProbe = async (pids) => {
      asked()
      await gate
      return procsProbe(h.helper)(pids)
    }
    const c = core(h, { opts: { probe } })
    expect(c.core.opened.fresh, 'the database was set aside').toBe(true)
    let restored: { shells: number; sessions: number } | null = null
    const answered = c.call<{ shells: number; sessions: number }>('terminal.restored', {}).then((a) => (restored = a))
    await rebuilding
    // what a window that subscribes now is sent: no session, though one is running
    expect([...c.core.sessions.store.values()], 'the first `sessions` snapshot').toEqual([])
    expect(restored, 'not answered before the rebuild').toBeNull()
    answer()
    expect(await answered).toEqual({ shells: 0, sessions: 1 })
    await c.core.started
    expect(c.core.sessions.store.get(sessionId)).toMatchObject({ lifecycle: 'live' })
    expect(c.core.terminals.store.get(ptyId)).toMatchObject({ sessionId, kind: 'agent', state: 'running' })
  })
})
