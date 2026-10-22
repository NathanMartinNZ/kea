// Core's database across processes: a writer killed mid-batch, and lost or corrupt databases rebuilt from real holders'
// state files, with core assembled as main.ts assembles it.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runProcess, ulid } from '@kea/kit'
import { L, type Project } from '@kea/protocol'
import { openDatabase } from '@kea/core/src/platform/db/db.ts'
import { checkInvariants } from '@kea/core/src/platform/db/invariants.ts'
import { insertSession, type SessionRow } from '@kea/core/src/sessions/rows.ts'
import { fixtureGitEnv, tinyRepo } from '@kea-tools/repo-factory/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { tempKeaHome } from '../support/helpers.ts'
import { holderAlive, ptyhostHarness, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, startFullCore, type FullCoreUnderTest } from './core-support.ts'
import { createMemoryLogger } from '@kea/kit'

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

function core(h: Harness): FullCoreUnderTest {
  const c = startFullCore(h, { env: testEnv() })
  cleanup.push(() => c.dispose())
  return c
}

function repo(name = 'demo') {
  const r = tinyRepo({ name })
  cleanup.push(() => r.dispose())
  return r
}

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

function linkedWorktree(root: string, slug: string): string {
  const wt = path.join(path.dirname(root), 'worktrees', path.basename(root), slug)
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  gitIn(root, 'worktree', 'add', '-q', '-b', `kea/${slug}`, wt)
  return fs.realpathSync(wt)
}

function session(c: FullCoreUnderTest, projectId: string, over: Partial<SessionRow>): string {
  const id = ulid()
  c.core.db.tx(() =>
    insertSession(c.core.db, {
      id, projectId, slug: `s-${id.slice(-6).toLowerCase()}`, title: 'Session', titleSource: 'user', isolation: 'inplace', cwd: '/', worktreeRoot: null, branch: null,
      baseBranch: null, baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{"prompt":"x"}',
      lifecycle: 'live', endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null,
      sortOrder: 0, pinnedOrder: 0, createdAt: Date.now(), archivedAt: null, ...over,
    }),
  )
  return id
}

const cat = (sessionId: string, kind: 'agent' | 'shell', cwd: string) => ({ sessionId, kind, command: { argv: ['/bin/cat'] }, cwd, cols: 80, rows: 24 })

function removeDb(home: string): void {
  for (const x of ['', '-wal', '-shm']) fs.rmSync(path.join(home, `kea.db${x}`), { force: true })
}

describe('kea.db across processes', () => {
  it('I-DB-1 · SIGKILL a writer during a write burst, 100 times: the database opens clean every time, the invariants hold, and each status batch is wholly there or wholly absent', async () => {
    const SESSIONS = 3
    const EVENTS = 120
    const LANES = L.poolOther
    const ITERATIONS = 100
    const child = path.join(import.meta.dirname, 'core-db-child.ts')
    const homes = await Promise.all(Array.from({ length: LANES }, () => tempKeaHome()))
    cleanup.push(() => Promise.all(homes.map((h) => h.dispose())))
    let killedMidWay = 0

    const iteration = async (file: string, target: number): Promise<void> => {
      let pid = 0
      let commits = 0
      let buf = ''
      const done = runProcess(process.execPath, [child, file, String(SESSIONS), String(EVENTS)], {
        pool: 'other',
        collect: false,
        timeoutMs: 60_000,
        onStdout: (chunk) => {
          buf += chunk.toString('utf8')
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (line.startsWith('pid ')) pid = Number(line.slice(4))
            else if (line.startsWith('c ') && ++commits === target && pid > 0) process.kill(pid, 'SIGKILL') // the test's child
          }
        },
      })
      const r = await done
      expect(r.signal, `the writer was killed (${r.stderr.slice(0, 300)})`).toBe('SIGKILL')

      const log = createMemoryLogger({ process: 'core' })
      const opened = openDatabase({ file, log })
      try {
        expect(opened.setAside, 'never set aside').toBeNull()
        expect(opened.integrityChecked, 'a kill is an unclean shutdown').toBe(true)
        const db = opened.db
        expect(checkInvariants(db)).toEqual([])
        const sessions = db.all<{ id: string; model: string | null }>('SELECT s.id, r.model FROM sessions s JOIN session_runtime r ON r.session_id = s.id ORDER BY s.id')
        expect(sessions.length).toBe(SESSIONS)
        const newest = new Set<number>()
        for (const s of sessions) {
          const counts = db.all<{ b: number; n: number }>("SELECT CAST(substr(event, 2) AS INTEGER) AS b, count(*) AS n FROM status_events WHERE session_id = ? GROUP BY b ORDER BY b", s.id)
          const latest = counts.at(-1)!
          newest.add(latest.b)
          expect(s.model, 'the runtime row and the events came in the same transaction').toBe(`b${latest.b}`)
          // every batch is whole, except the oldest one kept, which the trim may have cut
          for (const c of counts.slice(1)) expect(c.n, `batch ${c.b} of ${s.id}`).toBe(EVENTS)
          expect(counts.reduce((a, c) => a + c.n, 0)).toBeLessThanOrEqual(L.statusEventsPerSession)
        }
        expect(newest.size, 'a batch touched every session or none').toBe(1)
        if ([...newest][0]! >= target) killedMidWay++
      } finally {
        opened.db.close()
      }
    }

    await Promise.all(
      homes.map(async ({ home }, lane) => {
        const file = path.join(home, 'kea.db')
        for (let i = lane; i < ITERATIONS; i += LANES) await iteration(file, 1 + (i % 7))
      }),
    )
    expect(killedMidWay, 'the kills landed while batches were being written').toBeGreaterThan(0)
  })

  it('I-DB-2 · a corrupt kea.db is moved aside and the rebuild runs: the session and its project come back, its holder attached', async () => {
    const h = await harness()
    const demo = repo('demo')
    let c = core(h)
    await c.reconciled()
    const p = (await c.call<{ project: Project }>('projects.add', { path: demo.root })).project
    const s = session(c, p.id, { cwd: demo.root })
    const agent = (await c.core.terminals.launch(cat(s, 'agent', demo.root))).ptyId
    c.crash()

    const file = path.join(h.home, 'kea.db')
    fs.writeFileSync(file, Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * 7919) % 251)))
    c = core(h)
    expect(c.core.opened.setAside).toMatchObject({ path: `${file}.corrupt` })
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true)
    expect(await c.core.rebuilt).toMatchObject({ sessions: 1, projects: 1, ptys: 1 })
    const plan = await c.reconciled()
    expect(plan.attached).toEqual([agent])
    expect(plan.orphans).toEqual([])
    await c.core.started
    expect(c.core.projects.list().map((x) => [x.rootPath, x.name])).toEqual([[demo.root, 'demo']])
    expect(c.core.db.get('SELECT id, lifecycle, isolation FROM sessions')).toEqual({ id: s, lifecycle: 'live', isolation: 'inplace' })
    expect(c.core.terminals.store.get(agent)).toMatchObject({ state: 'running', sessionId: s, kind: 'agent' })
  })
})

describe('sessions survive a lost database', () => {
  it('I-SES-3 · kea.db deleted while sessions run: the rebuild restores projects and sessions from the holders’ state files (sessionId, kind, cwd, argv) and the holders are reattached', async () => {
    const h = await harness()
    const demo = repo('demo')
    const wt = linkedWorktree(demo.root, 'fix-auth')
    let c = core(h)
    await c.reconciled()
    const p = (await c.call<{ project: Project }>('projects.add', { path: demo.root })).project
    const s1 = session(c, p.id, { isolation: 'worktree', cwd: wt, worktreeRoot: path.dirname(path.dirname(wt)), slug: 'fix-auth', branch: 'kea/fix-auth', title: 'My title' })
    const s2 = session(c, p.id, { cwd: demo.root })
    const agent1 = (await c.core.terminals.launch(cat(s1, 'agent', wt))).ptyId
    const shell1 = (await c.core.terminals.launch(cat(s1, 'shell', wt))).ptyId
    const agent2 = (await c.core.terminals.launch({ ...cat(s2, 'agent', demo.root), command: { argv: ['/bin/sh', '-c', 'exit 3'] } })).ptyId
    const tab = (await c.core.terminals.launch(cat('shells', 'shell', demo.root))).ptyId // a shells-pane tab: terminals.json, not a session
    await until('the second agent to exit', () => c.core.terminals.store.get(agent2)?.state === 'exited')
    // its holder is let go (it would linger until RELEASE); its state file keeps the exit status
    await c.call('terminal.close', { ptyId: agent2 })
    await until('the second agent’s holder to be gone', () => !holderAlive(h.home, agent2))
    c.dispose()

    // the database goes while the holders run; Kea comes back (ptyhost adopts the holders, core rebuilds)
    removeDb(h.home)
    await h.restart()
    c = core(h)
    expect(c.core.opened.fresh).toBe(true)
    expect(await c.core.rebuilt).toMatchObject({ projects: 1, sessions: 2, ptys: 3, skipped: [] })
    const plan = await c.reconciled()
    expect([...plan.attached].sort()).toEqual([agent1, shell1, tab].sort())
    expect(plan.orphans).toEqual([])
    await c.core.started

    expect(c.core.projects.list()).toMatchObject([{ rootPath: demo.root, name: 'demo', isGit: true }])
    const rows = c.core.db.all<Record<string, unknown>>('SELECT id, slug, title, isolation, cwd, worktree_root AS root, branch, lifecycle, end_reason AS endReason, agent FROM sessions ORDER BY id')
    expect(rows).toEqual(
      [
        { id: s1, slug: 'fix-auth', title: 'Fix auth', isolation: 'worktree', cwd: wt, root: path.dirname(path.dirname(wt)), branch: 'kea/fix-auth', lifecycle: 'live', endReason: null, agent: 'shell' },
        { id: s2, slug: `session-${s2.slice(-6).toLowerCase()}`, title: `Session ${s2.slice(-6).toLowerCase()}`, isolation: 'inplace', cwd: demo.root, root: null, branch: null, lifecycle: 'detached', endReason: 'exited', agent: 'shell' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    )
    const ptys = c.core.db.all<Record<string, unknown>>('SELECT id, kind, state, exit_code AS code, argv FROM ptys ORDER BY id')
    expect(ptys).toEqual(
      [
        { id: agent1, kind: 'agent', state: 'running', code: null, argv: '["/bin/cat"]' },
        { id: shell1, kind: 'shell', state: 'running', code: null, argv: '["/bin/cat"]' },
        { id: agent2, kind: 'agent', state: 'exited', code: 3, argv: '["/bin/sh","-c","exit 3"]' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    )
    expect(c.core.db.get('SELECT count(*) AS n FROM sessions WHERE id = ?', 'shells')).toEqual({ n: 0 })
    expect(checkInvariants(c.core.db)).toEqual([])
    for (const id of [agent1, shell1, tab]) expect(c.core.terminals.store.get(id)?.state, id).toBe('running')
    expect(await c.call('terminal.clear', { ptyId: agent1 }), 'a reattached holder takes calls again').toEqual({ ok: true })
    expect(holderAlive(h.home, agent1)).toBe(true)
  })
})
