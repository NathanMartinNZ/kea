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
})
