// The dev server under a storm of clicks, at core level: core assembled as main.ts assembles it (core.ts) on a temp
// KEA_HOME, real ptyhost and holders, the process zoo's `server` as the session's `start.sh` on its own `$PORT`
// (loopback only, inside the session's port block). The post-conditions: a consistent state (the control, the terminal
// records and the processes agree), at most one server alive at any moment, nothing left when it is stopped.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { ServerResult, ServerView, SessionView } from '@kea/protocol'
import { zooCommand } from '@kea-tools/process-zoo/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { helperBinary, holderAlive, holdersIn, until } from '../support/holders.ts'
import { ownBlocks } from '../support/server-ports.ts'
import { createArgs, repo, startSessions } from '../integration/core-sessions-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

const CLICKS = 20
const q = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0: an existence check of a process this test's own server started
    return true
  } catch {
    return false
  }
}

/** Whether something accepts TCP connections on 127.0.0.1:port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let connected = false
    const c = net.connect({ host: '127.0.0.1', port })
    c.once('connect', () => {
      connected = true
      c.destroy()
    })
    c.once('error', () => undefined)
    c.once('close', () => resolve(connected))
  })
}

describe('dev server races', () => {
  it(`C-RACE-4 · Run and Stop clicked ${CLICKS}× quickly, all at once and one per turn, with Restart among them: the last click wins, never two servers alive, the port never fought over, the control agrees with what runs, and Stop leaves nothing`, async () => {
    const s = await startSessions({ opts: { helperPath: await helperBinary(), agentIntake: false, portProbe: ownBlocks() } })
    cleanup.push(() => s.dispose())
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const created = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'serve'))
    const v: SessionView = await s.until(created.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
    expect(v.lifecycle).toBe('live')
    const log = path.join(s.h.home, 'servers.ndjson')
    const zoo = zooCommand('server', ['--log', log])
    fs.writeFileSync(path.join(v.cwd, 'start.sh'), `#!/bin/sh\nexec ${[zoo.file, ...zoo.args].map(q).join(' ')}\n`, { mode: 0o755 })
    const core = s.c.core
    const port = v.portBase as number
    const view = (): ServerView => core.servers.view(v.id)
    const run = () => s.call<ServerResult>('server.run', { sessionId: v.id })
    const stop = () => s.call<ServerResult>('server.stop', { sessionId: v.id })
    const restart = () => s.call<ServerResult>('server.restart', { sessionId: v.id })
    /** Every server process that got as far as listening, by pid (the zoo's own log). */
    const started = (): number[] =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l.includes('"ready"'))
            .map((l) => (JSON.parse(l) as { pid: number }).pid)
        : []
    const serverRecords = () => core.terminals.sessionRecords(v.id).filter((x) => x.kind === 'server')

    // at most one alive at any moment: sampled all through the storms
    let most = 0
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        most = Math.max(most, started().filter(alive).length, serverRecords().filter((x) => x.state === 'running').length)
        await new Promise((res) => setImmediate(res))
      }
    })()

    /** The universal post-conditions for this session's server, once the calls have settled. */
    const consistent = async (what: string) => {
      await core.servers.idle()
      const st = view()
      expect(['running', 'stopped'], `${what}: settled in ${st.state}`).toContain(st.state)
      const running = serverRecords().filter((x) => x.state === 'running')
      expect(running.length, `${what}: running server terminals`).toBe(st.state === 'running' ? 1 : 0)
      if (st.state === 'running') {
        expect(st.ptyId, what).toBe(running[0]?.ptyId)
        await until(`${what}: the running server listens on its port`, () => listening(port))
        expect(started().filter(alive), `${what}: the one server process`).toHaveLength(1)
      } else {
        expect(started().filter(alive), `${what}: no server process`).toEqual([])
        expect(await listening(port), `${what}: port ${port} free`).toBe(false)
      }
      // one Server tab; no run was a crash (two servers would have fought over the port)
      expect(serverRecords().length, `${what}: one Server tab at most`).toBeLessThanOrEqual(1)
      expect(st.exit === null || st.state === 'stopped', what).toBe(true)
      expect(core.servers.resourceCounts.live, what).toBe(st.state === 'running' ? 1 : 0)
    }
    /** Clicks sent one per turn of the event loop, as a window's calls arrive: none waits for the one before. */
    const perTurn = async (clicks: (() => Promise<ServerResult>)[]): Promise<ServerResult[]> => {
      const sent: Promise<ServerResult>[] = []
      for (const click of clicks) {
        sent.push(click())
        await new Promise((res) => setImmediate(res))
      }
      return Promise.all(sent)
    }
    const turnsOf = (first: () => Promise<ServerResult>, second: () => Promise<ServerResult>) => Array.from({ length: CLICKS }, (_, i) => (i % 2 === 0 ? first : second))

    try {
      // ── Run, Stop ×10, all in one turn: the last click is Stop ──
      for (const a of await Promise.all(turnsOf(run, stop).map((click) => click()))) expect(a.reason, 'no click was refused').toBeNull()
      await consistent('after Run, Stop ×10 at once')
      expect(view().state, 'the last click was Stop').toBe('stopped')

      // ── the same, one click per turn: a Stop finds the Run before it at every point of its start ──
      for (const a of await perTurn(turnsOf(run, stop))) expect(a.reason, 'no click was refused').toBeNull()
      await consistent('after Run, Stop ×10 in turn')
      expect(view().state, 'the last click was Stop').toBe('stopped')

      // ── Stop, Run ×10, at once and then in turn: the last click is Run ──
      await Promise.all(turnsOf(stop, run).map((click) => click()))
      await consistent('after Stop, Run ×10 at once')
      expect(view().state, 'the last click was Run').toBe('running')
      await perTurn(turnsOf(stop, run))
      await consistent('after Stop, Run ×10 in turn')
      expect(view().state, 'the last click was Run').toBe('running')

      // ── Restart among them, from a running server; the last click is Stop ──
      await perTurn(Array.from({ length: CLICKS }, (_, i) => (i % 5 === 0 ? restart : i % 2 === 0 ? run : stop)))
      await consistent('after a storm with Restart')
      expect(view().state, 'the last click was Stop').toBe('stopped')

      // ── the second click on Stop arriving while the first is under way ──
      await run()
      await until('the server listens', () => listening(port))
      await Promise.all([stop(), stop(), stop()])
      await consistent('after three Stops')
      expect(view().state).toBe('stopped')
    } finally {
      // the sampler reads core's records: it ends before core does, whatever failed
      sampling = false
      await sampler
    }
    expect(most, 'servers alive at once, at most').toBeLessThanOrEqual(1)
    expect(started().length, 'servers that got as far as listening').toBeGreaterThanOrEqual(2)
    // nothing left: only the agent's holder runs, no scan timer, no server process
    await until('every server holder gone', () => holdersIn(s.h.home).filter((id) => holderAlive(s.h.home, id)).length === 1)
    expect(core.servers.resourceCounts).toMatchObject({ live: 0, scanTimers: 0, scans: 0 })
    expect(started().filter(alive)).toEqual([])
  })
})
