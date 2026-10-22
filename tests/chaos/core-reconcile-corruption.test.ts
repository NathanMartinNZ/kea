// Launch reconciliation against a KEA_HOME whose holder files lie — stale sockets, state files of dead holders, pids
// that now belong to other programs, state files copied from another KEA_HOME or moved between sessions, records that
// name the wrong session. Real holders, real ptyhost (tests/support/holders.ts), real core.

import fs from 'node:fs'
import path from 'node:path'
import { runDir, runProcess, socketPath } from '@kea/kit'
import { FileRecords } from '@kea/core/src/terminal/records.ts'
import { procsProbe } from '@kea/core/src/terminal/procs.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { holderAlive, holderState, killHolder, ptyhostHarness, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, startCore } from '../integration/core-support.ts'

const US = 1_000_000
const US_PER_MS = 1_000

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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A holder state file written by hand, consistent with `home` unless told otherwise. */
function fakeState(home: string, ptyId: string, sessionId: string, o: { pid: number; pidStartTime: number }): string {
  const dir = path.join(home, 'sessions', sessionId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const json = { protocol: 1, keaVersion: 'test', ptyId, sessionId, kind: 'shell', cwd: home, argv: ['/bin/zsh', '-l'], pid: o.pid, pidStartTime: o.pidStartTime, childPid: null, createdAt: 1, exited: false, exitCode: null, exitSignal: null, refusals: 0, socket: socketPath(runDir(home), ptyId) }
  fs.writeFileSync(path.join(dir, `${ptyId}.json`), JSON.stringify(json), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, `${ptyId}.ring`), 'ring', { mode: 0o600 })
  return dir
}

const cat = (sessionId: string, cwd: string) => ({ sessionId, kind: 'shell' as const, command: { argv: ['/bin/cat'] }, cwd, cols: 80, rows: 24 })

describe('C-COR-6 · corrupt holder files', () => {
  it('C-COR-6 · stale sockets and dead holders are cleaned up; a reused pid is never signalled; foreign or mismatched holders are never attached', async () => {
    const h = await harness()
    const other = await harness() // another KEA_HOME with a live holder of its own

    // ── first run
    let c = startCore(h, { env: testEnv() })
    await c.reconciled()
    const stale = (await c.t.launch(cat('shells', h.home))).ptyId // killed while Kea is away: its socket stays
    const mismatched = (await c.t.launch(cat('S7', h.home))).ptyId // its record will name another session
    const moved = (await c.t.launch(cat('S9', h.home))).ptyId // its state file will move to another session
    const bystander = await h.spawn({ argv: ['/bin/cat'], sessionId: 'S4' }) // a live holder whose child's pid gets reused
    const foreign = await other.spawn({ argv: ['/bin/cat'], sessionId: 's1' })
    h.spawned.add(mismatched).add(moved) // ended at cleanup even though their files will no longer vouch for them
    c.dispose()
    h.stop()

    // ── while Kea is away
    expect(killHolder(h.home, stale)).toBe(true)
    await until('the killed holder to be gone', () => !holderAlive(h.home, stale))
    const staleSock = socketPath(runDir(h.home), stale)
    expect(fs.existsSync(staleSock)).toBe(true)

    const records = FileRecords.open(h.home, c.log)
    records.put({ ...records.get(mismatched)!, sessionId: 'S8' })

    fs.mkdirSync(path.join(h.home, 'sessions', 'S10'))
    for (const ext of ['json', 'ring']) fs.renameSync(path.join(h.home, 'sessions', 'S9', `${moved}.${ext}`), path.join(h.home, 'sessions', 'S10', `${moved}.${ext}`))

    const dead = (await runProcess('/usr/bin/true', [], { pool: 'other' })).pid! // os-ok: in /usr/bin on both systems
    const nowUs = Date.now() * US_PER_MS
    const deadShellDir = fakeState(h.home, 'deadshell1', 'shells', { pid: dead, pidStartTime: nowUs })
    fakeState(h.home, 'deadrec001', 'S5', { pid: dead, pidStartTime: nowUs })
    const record = (ptyId: string, sessionId: string) => ({ ...records.get(moved)!, ptyId, sessionId, kind: 'shell' as const })
    records.put(record('deadrec001', 'S5'))

    const catPid = bystander.info().childPid!
    const catStart = (await procsProbe(h.helper)([catPid])).get(catPid)!.startSec
    fakeState(h.home, 'reused0001', 'shells', { pid: catPid, pidStartTime: catStart * US }) // right pid and start, not a holder
    fakeState(h.home, 'reused0002', 'S5', { pid: catPid, pidStartTime: (catStart - 5) * US }) // pid reused: another start
    fakeState(h.home, 'reused0003', 'S5', { pid: bystander.info().holderPid!, pidStartTime: (catStart - 5) * US }) // a holder's pid, not this holder
    records.put(record('reused0001', 'shells'))

    const theirs = path.join(other.home, 'sessions', 's1')
    fs.mkdirSync(path.join(h.home, 'sessions', 's1'), { recursive: true })
    for (const ext of ['json', 'ring']) fs.copyFileSync(path.join(theirs, `${foreign.ptyId}.${ext}`), path.join(h.home, 'sessions', 's1', `${foreign.ptyId}.${ext}`))

    cleanup.push(() => {
      // the planted files go first, so cleanup goes only by what the harnesses started
      for (const ext of ['json', 'ring']) fs.rmSync(path.join(h.home, 'sessions', 's1', `${foreign.ptyId}.${ext}`), { force: true })
      for (const id of ['reused0001', 'reused0002', 'reused0003']) for (const dir of ['shells', 'S5']) fs.rmSync(path.join(h.home, 'sessions', dir, `${id}.json`), { force: true })
    })

    // ── relaunch
    await h.restart()
    c = startCore(h, { env: testEnv() })
    cleanup.push(() => c.dispose())
    const plan = await c.reconciled()

    // stale socket and dead holders: cleaned up
    expect(fs.existsSync(staleSock), 'stale socket removed').toBe(false)
    expect(c.t.store.get(stale)?.state).toBe('lost')
    expect(fs.existsSync(path.join(deadShellDir, 'deadshell1.json')) || fs.existsSync(path.join(deadShellDir, 'deadshell1.ring')), 'files of a dead shell nobody records').toBe(false)
    expect(c.t.store.get('deadrec001')?.state, 'a recorded PTY whose holder is gone').toBe('lost')
    expect(fs.existsSync(path.join(h.home, 'sessions', 'S5', 'deadrec001.ring')), 'kept for its session (cold restore)').toBe(true)

    // reused pids: never taken for holders, never signalled
    expect(c.t.store.get('reused0001')?.state).toBe('lost')
    expect(c.t.orphans.has('reused0002') || c.t.orphans.has('reused0003')).toBe(false)
    for (const id of ['reused0002', 'reused0003']) await expect(c.call('terminal.terminateOrphan', { ptyId: id })).rejects.toMatchObject({ code: 'not_found' })
    expect(await c.call('terminal.close', { ptyId: 'reused0001' })).toEqual({ ok: true })
    expect(alive(catPid) && holderAlive(h.home, bystander.ptyId), 'the program now using the pid, and the real holder, are untouched').toBe(true)
    expect(h.manager.get(bystander.ptyId)?.isRunning).toBe(true)

    // another KEA_HOME's state file: never trusted, acted on or deleted
    expect(plan.ignored).toContainEqual({ ptyId: foreign.ptyId, why: 'socket of another KEA_HOME' })
    expect(c.t.orphans.has(foreign.ptyId)).toBe(false)
    await expect(c.call('terminal.terminateOrphan', { ptyId: foreign.ptyId })).rejects.toMatchObject({ code: 'not_found' })
    expect(fs.existsSync(path.join(h.home, 'sessions', 's1', `${foreign.ptyId}.json`))).toBe(true)
    expect(holderAlive(other.home, foreign.ptyId) && foreign.isRunning && !foreign.isDisposed, 'the other home’s holder and its ptyhost are undisturbed').toBe(true)

    // a holder whose session differs from its record, and one whose state file moved: never attached
    expect(c.t.orphans.get(mismatched)).toMatchObject({ reason: 'sessionMismatch', sessionId: 'S7', canAdopt: false })
    expect(c.t.store.get(mismatched)?.state).toBe('lost')
    expect(plan.ignored).toContainEqual({ ptyId: moved, why: `names session S9 but lives in S10` })
    expect(c.t.store.get(moved)?.state).toBe('lost')
    expect(c.t.orphans.has(moved)).toBe(false)
    for (const id of [mismatched, moved]) {
      await c.call('terminal.setVisible', { ptyIds: [id] })
      expect(await c.call('terminal.clear', { ptyId: id })).toEqual({ ok: false })
      expect(await c.call('terminal.close', { ptyId: id })).toEqual({ ok: true })
      expect(c.touched(id), `nothing core sent named ${id}`).toEqual([])
      expect(holderAlive(h.home, id), `${id}'s holder keeps running`).toBe(true)
    }
    expect(plan.attached).toEqual([])

    expect(holderState(h.home, bystander.ptyId)?.pid).toBe(bystander.info().holderPid)
  })
})
