// Core's launch reconciliation against real holders: ptyhost's PtyManager and the debug kea-helper under plain
// Node (tests/support/holders.ts), core's Terminals wired to it as main wires them (core-support.ts).

import fs from 'node:fs'
import path from 'node:path'
import { runDir, socketPath } from '@kea/kit'
import type { PtyInfo } from '@kea/protocol'
import { FileRecords } from '@kea/core/src/terminal/records.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { holderAlive, holderState, killHolder, ptyhostHarness, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, readStream, startCore, type CoreUnderTest } from './core-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function harness(): Promise<Harness> {
  const h = await ptyhostHarness()
  cleanup.push(async () => {
    for (const id of ownPtyIds(h.home)) h.spawned.add(id) // the holders core started end too
    await h.dispose()
  })
  return h
}

function core(h: Harness): CoreUnderTest {
  const c = startCore(h, { env: testEnv({ SHELL: '/bin/sh' }) })
  cleanup.push(() => c.dispose())
  return c
}

const cat = (sessionId: string, kind: PtyInfo['kind'], cwd: string) => ({ sessionId, kind, command: { argv: ['/bin/cat'] }, cwd, cols: 80, rows: 24 })

describe('core: launch reconciliation', () => {
  it('I-PTY-12 · live holder + record → attached; live holder without record → orphan (adopt, terminate); record without holder → lost, session detached, stale socket removed', async () => {
    const h = await harness()
    // ── first run: core starts a shell and an agent (records); something else starts a holder core never recorded
    let c = core(h)
    await c.reconciled()
    const shell = (await c.t.launch(cat('shells', 'shell', h.home))).ptyId
    const agent = (await c.t.launch(cat('S1', 'agent', h.home))).ptyId
    const stray = (await h.spawn({ argv: ['/bin/cat'], sessionId: 'S2', kind: 'agent' })).ptyId
    const stray2 = (await h.spawn({ argv: ['/bin/cat'], sessionId: 'S3', kind: 'server' })).ptyId
    expect(c.t.store.get(shell)?.state).toBe('running')
    const shellPid = holderState(h.home, shell)?.pid

    // ── Kea goes away; meanwhile the agent's holder dies the hard way (its socket stays behind)
    c.dispose()
    h.stop()
    expect(killHolder(h.home, agent)).toBe(true)
    await until('the agent holder to be gone', () => !holderAlive(h.home, agent))
    const agentSock = socketPath(runDir(h.home), agent)
    expect(fs.existsSync(agentSock)).toBe(true)

    // ── relaunch: ptyhost adopts what it can reach, core reconciles
    await h.restart()
    c = core(h)
    const plan = await c.reconciled()
    expect(plan.attached).toEqual([shell])
    expect(c.t.store.get(shell)).toMatchObject({ state: 'running', kind: 'shell', holderPid: shellPid })
    expect(c.t.store.get(agent)).toMatchObject({ state: 'lost', kind: 'agent', sessionId: 'S1' })
    expect(plan.detachedSessions).toEqual(['S1'])
    expect(FileRecords.open(h.home, c.log).get(agent)?.state, 'persisted').toBe('lost')
    expect(fs.existsSync(agentSock), 'stale socket removed').toBe(false)
    expect(plan.staleSockets).toEqual([agent])
    const orphans = [...c.t.orphans.values()].sort((x, y) => x.sessionId.localeCompare(y.sessionId))
    expect(orphans.map((o) => [o.ptyId, o.sessionId, o.kind, o.reason, o.reachable, o.canAdopt])).toEqual([
      [stray, 'S2', 'agent', 'noRecord', true, true],
      [stray2, 'S3', 'server', 'noRecord', true, true],
    ])
    expect(orphans[0]!.holderPid).toBe(holderState(h.home, stray)?.pid)
    expect(await c.call('terminal.restored', {})).toEqual({ shells: 1, sessions: 1 })
    expect(c.touched(stray), 'an orphan is listed, never touched').toEqual([])

    // ── Adopt as shell: the orphan becomes a shell tab of its own session; Terminate: the holder ends and goes
    expect(await c.call('terminal.adoptOrphan', { ptyId: stray })).toEqual({ ptyId: stray })
    expect(c.t.store.get(stray)).toMatchObject({ kind: 'shell', sessionId: 'S2', state: 'running' })
    expect(c.records.get(stray)).toMatchObject({ kind: 'shell', sessionId: 'S2', state: 'running' })
    expect(await c.call('terminal.terminateOrphan', { ptyId: stray2 })).toEqual({ ok: true })
    await until('the terminated orphan to be gone', () => !holderAlive(h.home, stray2))
    await until('ptyhost to let the released holder go', () => h.manager.get(stray2) === undefined)
    expect(c.t.orphans.size).toBe(0)
    expect(holderAlive(h.home, shell) && holderAlive(h.home, stray), 'the others are untouched').toBe(true)

    // ── the next reconciliation agrees: nothing new is orphaned or ended
    c.dispose()
    c = core(h)
    const again = await c.reconciled()
    expect(again.attached.sort()).toEqual([shell, stray].sort())
    expect([again.orphans, again.ended, again.staleSockets]).toEqual([[], [], []])
  })

  it('I-PTY-30 · core restarting (crash, or killed after a hang) re-lists and reconciles without disturbing any holder: output keeps flowing, nothing is signalled or released', async () => {
    const h = await harness()
    let c = core(h)
    await c.reconciled()
    const a = (await c.t.launch(cat('shells', 'shell', h.home))).ptyId
    const b = (await c.t.launch(cat('S1', 'agent', h.home))).ptyId
    const pids = [a, b].map((id) => holderState(h.home, id)?.pid)
    const pty = h.manager.get(a)!

    // a renderer stream on `a`, which never passes through core
    const stream = readStream(h, a)
    cleanup.push(() => stream.close())
    const text = () => stream.text()
    pty.input('before\r')
    await until('echo before the restart', () => text().includes('before'))

    for (let round = 1; round <= 3; round++) {
      c.dispose() // core dies or is killed after missed heartbeats
      pty.input(`while-away-${round}\r`)
      await until('typing while core is away', () => text().includes(`while-away-${round}`))
      c = core(h)
      const plan = await c.reconciled()
      expect(plan.attached.sort(), `round ${round}`).toEqual([a, b].sort())
      expect([plan.orphans, plan.ended, plan.staleSockets, plan.deadFiles, plan.unreachable]).toEqual([[], [], [], [], []])
      expect(c.calls.map((x) => x.m).filter((m) => ['pty.signal', 'pty.terminate', 'pty.release', 'pty.spawn'].includes(m))).toEqual([])
      expect(await c.call('terminal.restored', {})).toEqual({ shells: 1, sessions: 1 })
    }
    expect([a, b].map((id) => holderState(h.home, id)?.pid)).toEqual(pids)
    expect(h.manager.get(a), 'ptyhost kept the same connection').toBe(pty)
    pty.input('after\r')
    await until('echo after the restarts', () => text().includes('after'))
    expect(c.t.store.get(b)).toMatchObject({ state: 'running', kind: 'agent' })
    // the restarted core serves new work at once: a new shell tab
    const { ptyId: fresh } = await c.call<{ ptyId: string }>('terminal.openShell', { cwd: h.home, cols: 80, rows: 24 })
    expect(c.t.store.get(fresh)).toMatchObject({ state: 'running', kind: 'shell' })
    expect(await c.call('terminal.restored', {})).toEqual({ shells: 2, sessions: 1 })
    for (const [id, session] of [[a, 'shells'], [b, 'S1']] as const) {
      expect(fs.existsSync(path.join(h.home, 'sessions', session, `${id}.json`)) && fs.existsSync(path.join(h.home, 'sessions', session, `${id}.ring`)), 'no state file removed').toBe(true)
    }
  })

  it('I-PTY-35 · shell tab numbers are core’s, in memory: a ptyhost restart under the running core keeps every number, gaps included; a restarted core numbers its shells again in their order, so the gaps close; every holder runs on throughout and nothing on disk holds a number', async () => {
    const h = await harness()
    let c = core(h)
    await c.reconciled()
    const open = async (sessionId: string) => (await c.t.launch(cat(sessionId, 'shell', h.home))).ptyId
    const numbers = (ids: string[]) => ids.map((id) => c.t.store.get(id)?.number)
    const a1 = await open('shells')
    const a2 = await open('shells')
    const a3 = await open('shells')
    const b1 = await open('S1')
    const agent = (await c.t.launch(cat('S1', 'agent', h.home))).ptyId
    const b2 = await open('S1')
    expect(numbers([a1, a2, a3, b1, b2, agent])).toEqual([1, 2, 3, 1, 2, undefined])
    // the middle shell of the shells pane closed: a gap, and the next one is numbered past it
    expect(await c.call('terminal.close', { ptyId: a2 })).toEqual({ ok: true })
    const a4 = await open('shells')
    const live = [a1, a3, a4, b1, b2]
    expect(numbers(live)).toEqual([1, 3, 4, 1, 2])
    const pids = live.map((id) => holderState(h.home, id)?.pid)
    /** Calls that would have disturbed one of the live holders, from the `from`th call core made on. */
    const disturbed = (from = 0) => c.calls.slice(from).filter((x) => ['pty.signal', 'pty.terminate', 'pty.release'].includes(x.m) && live.includes(x.a.ptyId as string))
    const mark = c.calls.length

    // ptyhost restarts while core runs: it adopts the holders, core reconciles on the new control port, and no number
    // changes, the gap included
    await h.restart()
    c.reconnect()
    const plan = await c.reconciled(2)
    expect(plan.attached.sort()).toEqual([...live, agent].sort())
    expect(numbers(live)).toEqual([1, 3, 4, 1, 2])
    expect(live.map((id) => c.t.store.get(id)?.state)).toEqual(live.map(() => 'running'))
    expect(disturbed(mark)).toEqual([])

    // core restarts: its records come back from disk, which holds no number, and are numbered again in their order
    c.dispose()
    c = core(h)
    const again = await c.reconciled()
    expect(again.attached.sort()).toEqual([...live, agent].sort())
    expect(numbers(live)).toEqual([1, 2, 3, 1, 2])
    expect(c.t.store.get(agent)?.number).toBeUndefined()
    // a shell opened now follows the highest listed
    const a5 = await open('shells')
    expect(c.t.store.get(a5)?.number).toBe(4)

    // the holders ran on throughout: the same processes, never signalled or released
    expect(live.map((id) => holderState(h.home, id)?.pid)).toEqual(pids)
    expect(live.every((id) => holderAlive(h.home, id))).toBe(true)
    expect(disturbed()).toEqual([])
    expect(fs.readFileSync(path.join(h.home, 'terminals.json'), 'utf8')).not.toContain('"number"')
  })
})
