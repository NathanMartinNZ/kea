// The database under faults: kea.db truncated, overwritten or left without its WAL while sessions run, a schema
// migration with live sessions and a downgrade. Real holders and ptyhost (tests/support/holders.ts), core assembled as
// main.ts assembles it (core.ts).

import fs from 'node:fs'
import path from 'node:path'
import { ulid } from '@kea/kit'
import type { Project } from '@kea/protocol'
import { openDatabase } from '@kea/core/src/platform/db/db.ts'
import { checkInvariants } from '@kea/core/src/platform/db/invariants.ts'
import { MIGRATIONS, SCHEMA_VERSION } from '@kea/core/src/platform/db/schema.ts'
import { insertSession } from '@kea/core/src/sessions/rows.ts'
import { createMemoryLogger } from '@kea/kit'
import { tinyRepo } from '@kea-tools/repo-factory/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { holderAlive, ptyhostHarness, testEnv, type Harness } from '../support/holders.ts'
import { ownPtyIds, startFullCore, type FullCoreUnderTest } from '../integration/core-support.ts'

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

/** A live in-place session in `projectId` with its agent PTY running `cat` (a holder that stays up). */
async function liveSession(c: FullCoreUnderTest, projectId: string, cwd: string): Promise<{ sessionId: string; ptyId: string }> {
  const sessionId = ulid()
  c.core.db.tx(() =>
    insertSession(c.core.db, {
      id: sessionId, projectId, slug: `s-${sessionId.slice(-6).toLowerCase()}`, title: 'Session', titleSource: 'user', isolation: 'inplace', cwd, worktreeRoot: null,
      branch: null, baseBranch: null, baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{"prompt":"x"}',
      lifecycle: 'live', endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null, sortOrder: 0, pinnedOrder: 0,
      createdAt: Date.now(), archivedAt: null,
    }),
  )
  const { ptyId } = await c.core.terminals.launch({ sessionId, kind: 'agent', command: { argv: ['/bin/cat'] }, cwd, cols: 80, rows: 24 })
  return { sessionId, ptyId }
}

async function setup(): Promise<{ h: Harness; c: FullCoreUnderTest; root: string; project: Project; first: { sessionId: string; ptyId: string } }> {
  const h = await harness()
  const r = tinyRepo({ name: 'demo' })
  cleanup.push(() => r.dispose())
  const c = core(h)
  await c.reconciled()
  const project = (await c.call<{ project: Project }>('projects.add', { path: r.root })).project
  return { h, c, root: r.root, project, first: await liveSession(c, project.id, r.root) }
}

/** After the fault: every live session back, live, its holder attached; nothing orphaned; the invariants hold. */
async function expectReattached(h: Harness, sessions: { sessionId: string; ptyId: string }[]): Promise<FullCoreUnderTest> {
  const c = core(h)
  const plan = await c.reconciled()
  await c.core.started
  expect([...plan.attached].sort()).toEqual(sessions.map((s) => s.ptyId).sort())
  expect(plan.orphans).toEqual([])
  for (const s of sessions) {
    expect(c.core.db.get<{ lifecycle: string }>('SELECT lifecycle FROM sessions WHERE id = ?', s.sessionId)?.lifecycle, s.sessionId).toBe('live')
    expect(c.core.terminals.store.get(s.ptyId)).toMatchObject({ state: 'running', sessionId: s.sessionId })
    expect(holderAlive(h.home, s.ptyId)).toBe(true)
  }
  expect(c.core.projects.list()).toHaveLength(1)
  expect(checkInvariants(c.core.db)).toEqual([])
  return c
}

describe('kea.db corrupt or incomplete', () => {
  it('C-COR-1 · kea.db truncated → set aside, rebuilt from the holders; live sessions reattached', async () => {
    const { h, c, first } = await setup()
    c.dispose() // a clean shutdown checkpoints everything into kea.db
    const file = path.join(h.home, 'kea.db')
    fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2))
    const after = await expectReattached(h, [first])
    expect(after.core.opened.setAside).toMatchObject({ path: `${file}.corrupt` })
    expect(after.core.opened.fresh).toBe(true)
  })

  it('C-COR-1 · kea.db overwritten with garbage → set aside, rebuilt from the holders; live sessions reattached', async () => {
    const { h, c, first } = await setup()
    c.crash()
    const file = path.join(h.home, 'kea.db')
    fs.writeFileSync(file, Buffer.from(Array.from({ length: fs.statSync(file).size || 8192 }, (_, i) => (i * 104729) % 256)))
    const after = await expectReattached(h, [first])
    expect(after.core.opened.setAside?.reason).toBeTruthy()
  })

  it('C-COR-1 · the WAL deleted → kea.db comes back as of its last checkpoint; the sessions it lost are rebuilt from the holders; all reattached', async () => {
    const { h, c, project, root, first } = await setup()
    c.dispose() // checkpointed: the project and the first session are in kea.db itself
    const again = core(h)
    await again.reconciled()
    const second = await liveSession(again, project.id, root) // only in the WAL
    // what a crash leaves (a closing connection would checkpoint): kea.db as of its last checkpoint; then the WAL goes
    const file = path.join(h.home, 'kea.db')
    const atCrash = fs.readFileSync(file)
    again.dispose()
    fs.writeFileSync(file, atCrash)
    for (const x of ['-wal', '-shm']) fs.rmSync(`${file}${x}`, { force: true })
    const after = await expectReattached(h, [first, second])
    expect(after.core.opened.setAside, 'a consistent older file is kept').toBeNull()
    expect(await after.core.rebuilt).toMatchObject({ sessions: 1, projects: 0 })
  })
})

describe('schema migration', () => {
  it('C-UPD-3 · migration N → N+1 with live sessions: it runs, the backup is written, sessions and their holders are intact', async () => {
    const { h, c, first } = await setup()
    const before = c.core.db.all('SELECT * FROM sessions')
    c.dispose()
    const next = { version: SCHEMA_VERSION + 1, name: 'test: one more column and index', sql: 'ALTER TABLE presets ADD COLUMN note TEXT; CREATE INDEX presets_by_agent ON presets(agent);' }
    const after = core(h, { opts: { migrations: [...MIGRATIONS, next] } })
    expect(after.core.opened).toMatchObject({ fromVersion: SCHEMA_VERSION, fresh: false, setAside: null })
    expect(after.core.db.pragma('user_version')).toBe(next.version)
    expect(after.core.db.all('SELECT * FROM sessions'), 'sessions intact').toEqual(before)
    const plan = await after.reconciled()
    expect(plan.attached).toEqual([first.ptyId])
    expect(after.core.terminals.store.get(first.ptyId)).toMatchObject({ state: 'running', sessionId: first.sessionId })
    expect(checkInvariants(after.core.db)).toEqual([])
    // the backup is the database as it was, readable at its own version
    const bak = path.join(h.home, `kea.db.bak-${SCHEMA_VERSION}`)
    expect(fs.existsSync(bak)).toBe(true)
    const copy = path.join(h.home, 'bak-check.db')
    fs.copyFileSync(bak, copy)
    const old = openDatabase({ file: copy, log: createMemoryLogger({ process: 'core' }) })
    expect(old.fromVersion).toBe(SCHEMA_VERSION)
    expect(old.db.all('SELECT * FROM sessions')).toEqual(before)
    old.db.close()
  })

  it('C-UPD-4 · a downgrade with live sessions (build N over build N+1’s database): the newer database is set aside whole and still opens at its own version; build N starts fresh and rebuilds the live sessions from their holders; build N+1 afterwards migrates the rebuilt database', async () => {
    const { h, c, project, root, first } = await setup()
    c.dispose()
    const file = path.join(h.home, 'kea.db')
    const next = { version: SCHEMA_VERSION + 1, name: 'test: one more column and index', sql: 'ALTER TABLE presets ADD COLUMN note TEXT; CREATE INDEX presets_by_agent ON presets(agent);' }
    const newer = core(h, { opts: { migrations: [...MIGRATIONS, next] } })
    await newer.reconciled()
    const second = await liveSession(newer, project.id, root) // a session only build N+1's database knows
    const rows = newer.core.db.all('SELECT id, project_id, title, lifecycle FROM sessions ORDER BY id')
    expect(rows).toHaveLength(2)
    newer.dispose()

    // build N again: it cannot read a newer schema, and must not turn it into its own
    const older = await expectReattached(h, [first, second])
    expect(older.core.opened).toMatchObject({ fresh: true, setAside: { path: `${file}.corrupt`, reason: expect.stringMatching(/schema version \d+ is newer than this build's \d+/) } })
    expect(older.core.db.pragma('user_version')).toBe(SCHEMA_VERSION)
    expect(await older.core.rebuilt).toMatchObject({ sessions: 2, projects: 1 })
    expect(older.log.entries.some((e) => e.level === 'error' && /set aside/.test(e.msg)), 'said in the log').toBe(true)
    // the newer database is whole: at its own version, with every row it had (a copy is opened: the file stays as it is)
    const copy = path.join(h.home, 'aside-check.db')
    for (const x of ['', '-wal', '-shm']) if (fs.existsSync(`${file}.corrupt${x}`)) fs.copyFileSync(`${file}.corrupt${x}`, `${copy}${x}`)
    const kept = openDatabase({ file: copy, log: createMemoryLogger({ process: 'core' }), migrations: [...MIGRATIONS, next] })
    expect(kept).toMatchObject({ fromVersion: next.version, fresh: false, setAside: null })
    expect(kept.db.all('SELECT id, project_id, title, lifecycle FROM sessions ORDER BY id')).toEqual(rows)
    expect(checkInvariants(kept.db)).toEqual([])
    kept.db.close()
    older.dispose()

    // forward again: build N+1 migrates what build N rebuilt (its backup first); the same holders, attached once more
    const again = core(h, { opts: { migrations: [...MIGRATIONS, next] } })
    expect(again.core.opened).toMatchObject({ fromVersion: SCHEMA_VERSION, fresh: false, setAside: null })
    expect(again.core.db.pragma('user_version')).toBe(next.version)
    const plan = await again.reconciled()
    expect([...plan.attached].sort()).toEqual([first.ptyId, second.ptyId].sort())
    expect(plan.orphans).toEqual([])
    for (const s of [first, second]) expect(holderAlive(h.home, s.ptyId), s.ptyId).toBe(true)
    expect(checkInvariants(again.core.db)).toEqual([])
    expect(fs.existsSync(`${file}.corrupt`), 'the set-aside database is still there').toBe(true)
  })
})
