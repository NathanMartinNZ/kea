// Session cycles leave nothing behind in core, ptyhost or KEA_HOME: core assembled as main.ts assembles it on a temp
// KEA_HOME, a real ptyhost and real holders in this process (tests/integration/core-sessions-support.ts), real git on a
// repo from tools/repo-factory. The agent each session runs is tools/fake-agent (its default turn: probes, the
// alternate screen, a transcript in a throwaway home), started through the agent command. Counts are upper bounds: the
// smallest run that gives the method's warm-ups and checkpoints.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DisposableTracker, resources, setDisposableTracker } from '@kea/kit'
import type { AgentCommand } from '@kea/core/src/sessions/sessions.ts'
import { WORKTREE_TRASH } from '@kea/core/src/worktrees/ops.ts'
import { SETTINGS, type SessionView } from '@kea/protocol'
import { fakeAgentCommand } from '../../tools/fake-agent/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { until } from '../support/holders.ts'
import { createArgs, repo, startSessions, type SessionsUnderTest } from '../integration/core-sessions-support.ts'
import { METHOD, settle } from './ptyhost-leak.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  setDisposableTracker(null)
  for (const c of cleanup.splice(0).reverse()) await c()
})

function tmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

/** The method's run: its warm-ups, then one cycle per checkpoint. */
const CYCLES = METHOD.warmups + METHOD.checkpoints

/** Sessions whose agent is fake-agent, each writing its event log to `<marks>/<sessionId>.ndjson`. */
async function fakeAgentSessions(marks: string, more: Parameters<typeof startSessions>[0] = {}): Promise<SessionsUnderTest> {
  const fakeHome = path.join(marks, 'home')
  fs.mkdirSync(fakeHome)
  const agentCommand: AgentCommand = (x) => {
    const c = fakeAgentCommand('claude', [], { fakeHome, log: path.join(marks, `${x.id}.ndjson`) })
    return { argv: [c.file, ...c.args] }
  }
  const s = await startSessions({ ...more, opts: { ...more.opts, agentCommand } })
  cleanup.push(() => s.dispose())
  return s
}

async function live(s: SessionsUnderTest, id: string): Promise<SessionView> {
  const v = await s.until(id, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

/** Create a session and wait until its fake agent has run its first turn (the transcript record it writes). */
async function createAndRun(s: SessionsUnderTest, marks: string, projectId: string, i: number): Promise<SessionView> {
  const v = await live(s, (await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, `cycle ${i}`))).sessionId)
  const log = path.join(marks, `${v.id}.ndjson`)
  await until(`the fake agent of cycle ${i} ran its turn`, () => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"transcript"'))
  return v
}

/** Open file descriptors of this process (core and ptyhost run in it). */
const fds = () => fs.readdirSync('/dev/fd').length

/** Active handles and timers by type, without the file-system requests that come and go with every read. */
function handles(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of process.getActiveResourcesInfo()) if (!r.startsWith('FSReq')) out[r] = (out[r] ?? 0) + 1
  return out
}

/** The counts that must come back to baseline: core's per-session state and ptyhost's per-PTY rows. */
function counts(s: SessionsUnderTest) {
  const r = resources.report()
  return {
    sessions: s.c.core.sessions.resourceCounts,
    terminals: s.c.core.terminals.resourceCounts,
    status: s.c.core.status.resourceCounts,
    ptys: r['ptyhost.ptys'],
    holderSockets: r['ptyhost.holderSockets'],
    ptyTimers: r['ptyhost.ptyTimers'],
    ptyQueues: r['ptyhost.ptyQueues'],
    checkpoints: r['ptyhost.checkpoints'],
    scopes: r['kit.scopes'],
    timers: r['kit.timers'],
    listeners: r['kit.targetListeners'],
  }
}

describe('session cycles in core and ptyhost', () => {
  it(`L-MEM-9 · create → run fake-agent → delete a session, ×${CYCLES}: disposable tracker empty; core, ptyhost, handles, timers and fds at baseline; no state dir, spool, port block, PTY rows or operation journal left`, async () => {
    const marks = tmpDir('kea-l-mem-9-')
    const s = await fakeAgentSessions(marks)
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const ids: string[] = []
    const cycle = async (i: number) => {
      const v = await createAndRun(s, marks, p.id, i)
      ids.push(v.id)
      expect(await s.call('sessions.delete', { id: v.id, deleteBranch: true, forceBranch: true })).toMatchObject({ deleted: true })
      await s.idle()
    }
    for (let i = 0; i < METHOD.warmups; i++) await cycle(i)
    // `settle` waits for the last child to be let go (the delete's `git branch -D` outlives the call that ran it)
    await settle()
    const before = { counts: counts(s), handles: handles(), fds: fds() }
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    for (let i = METHOD.warmups; i < CYCLES; i++) await cycle(i)
    await s.idle()
    await until('every holder gone', () => (resources.report()['ptyhost.holderSockets'] ?? 0) === 0)
    await settle()

    expect(tracker.report(), 'disposables of the measured cycles all disposed').toBe('')
    expect(counts(s)).toEqual(before.counts)
    expect(handles(), 'active handles and timers').toEqual(before.handles)
    expect(fds(), 'open file descriptors').toBe(before.fds)
    const db = s.c.core.db
    const sessionsDir = path.join(s.h.home, 'sessions')
    expect(fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [], 'no state dir (or spool file in one)').toEqual([])
    const marksOf = ids.map(() => '?').join(', ')
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM sessions WHERE port_base IS NOT NULL`)!.n, 'no port block reserved').toBe(0)
    // the operation journal is cleared; the deleted rows themselves, and the status journal that goes with them, stay
    // for Restore until the retention (the KEA_HOME test below sees them go)
    expect(db.all<{ lifecycle: string; step: string | null }>(`SELECT lifecycle, creation_step AS step FROM sessions WHERE id IN (${marksOf})`, ...ids), 'no journal left').toEqual(ids.map(() => ({ lifecycle: 'deleted', step: null })))
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ptys WHERE session_id IN (${marksOf})`, ...ids)!.n, 'no PTY rows').toBe(0)
  })
})

/** Every file under `dir` with its size, but the capped logs and the database (its rows are checked by count). */
function homeFiles(dir: string): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      const rel = path.relative(dir, f)
      if (rel === 'logs' || /^kea\.db(-wal|-shm)?$/.test(rel)) continue
      if (e.isDirectory()) walk(f)
      else out[rel] = fs.lstatSync(f).size
    }
  }
  walk(dir)
  return out
}

describe('KEA_HOME after session cycles', () => {
  it(`L-MEM-15 · create → run fake-agent → archive → delete, ×${CYCLES}, then past the retention: KEA_HOME back to its baseline but for the capped logs — no state dir, no trash, no checkpoint, no other file left`, async () => {
    const marks = tmpDir('kea-l-mem-15-')
    let clock = Date.now()
    const s = await fakeAgentSessions(marks, { opts: { now: () => clock } })
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const cycle = async (i: number) => {
      const v = await createAndRun(s, marks, p.id, i)
      expect(await s.call('sessions.archive', { id: v.id, confirmed: true })).toMatchObject({ archived: true })
      // archived, the session keeps only its checkpoints and creation log
      const dir = path.join(s.h.home, 'sessions', v.id)
      expect(fs.readdirSync(dir).filter((f) => /\.(ring|json)$/.test(f)), `cycle ${i}: archived, no ring or state file`).toEqual([])
      expect(await s.call('sessions.delete', { id: v.id, deleteBranch: true, forceBranch: true })).toMatchObject({ deleted: true })
      await s.idle()
    }
    for (let i = 0; i < METHOD.warmups; i++) await cycle(i)
    const baseline = homeFiles(s.h.home)
    for (let i = METHOD.warmups; i < CYCLES; i++) await cycle(i)
    await s.idle()
    expect(fs.readdirSync(path.join(s.h.home, 'worktrees', WORKTREE_TRASH)), 'no trash').toEqual([])
    expect(homeFiles(s.h.home), 'the files are the baseline’s').toEqual(baseline)

    // past the retention the deleted rows go: what is left of the cycles is nothing
    const retentionDays = SETTINGS.find((k) => k.key === 'general.deletedRetentionDays')!.default as number
    clock += (retentionDays + 1) * 86_400_000
    await s.relaunch()
    const db = s.c.core.db
    for (const t of ['sessions', 'ptys', 'status_events', 'session_runtime', 'session_ui']) expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n, t).toBe(0)
    expect(homeFiles(s.h.home), 'still the baseline’s after the purge').toEqual(baseline)
  })
})
