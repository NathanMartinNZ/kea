// Dev-server cycles leave nothing behind: core assembled as main.ts assembles it on a temp KEA_HOME, a real ptyhost and
// real holders in this process (tests/integration/core-sessions-support.ts). The server is the process zoo's `server`,
// run as the session's `start.sh` on its own `$PORT` (loopback only, inside the session's port block); each cycle runs
// it, waits until a port scan has found its port, and stops it. Counts are upper bounds: the smallest run that gives
// the method's warm-ups and checkpoints.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { DisposableTracker, resources, setDisposableTracker } from '@kea/kit'
import type { ServerResult, ServerView, SessionView } from '@kea/protocol'
import { zooCommand } from '@kea-tools/process-zoo/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { helperBinary, holderAlive, holdersIn, until } from '../support/holders.ts'
import { ownBlocks } from '../support/server-ports.ts'
import { createArgs, repo, startSessions, type SessionsUnderTest } from '../integration/core-sessions-support.ts'
import { METHOD, settle } from './ptyhost-leak.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  setDisposableTracker(null)
  for (const c of cleanup.splice(0).reverse()) await c()
})

const CYCLES = METHOD.warmups + METHOD.checkpoints
const q = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

/** Whether something accepts TCP connections on 127.0.0.1:port. Answers once the probe's own socket is closed (it is a handle too). */
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

/** Open file descriptors of this process (core and ptyhost run in it). */
const fds = () => fs.readdirSync('/dev/fd').length

/** Active handles and timers by type, without the file-system requests that come and go with every read. */
function handles(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of process.getActiveResourcesInfo()) if (!r.startsWith('FSReq')) out[r] = (out[r] ?? 0) + 1
  return out
}

/**
 * At rest for a reading: ptyhost's activity notes sent (each PTY's note comes due a moment after its last output, the
 * stopped server's or the agent's; its timer would count at one reading and not the other), then `settle`.
 */
async function atRest(): Promise<void> {
  await until('ptyhost’s activity notes sent', () => (resources.report()['ptyhost.activity'] as { timers?: number } | undefined)?.timers === 0)
  await settle()
}

/** What must come back to baseline: the dev servers' own rows, core's PTY records, ptyhost's per-PTY rows, kit's children and timers. */
function counts(s: SessionsUnderTest) {
  const r = resources.report()
  const children = Object.fromEntries(Object.entries(r).filter(([k]) => k.startsWith('kit.children')))
  return {
    servers: s.c.core.servers.resourceCounts,
    terminals: s.c.core.terminals.resourceCounts,
    children,
    ptys: r['ptyhost.ptys'],
    holderSockets: r['ptyhost.holderSockets'],
    ptyTimers: r['ptyhost.ptyTimers'],
    ptyQueues: r['ptyhost.ptyQueues'],
    scopes: r['kit.scopes'],
    timers: r['kit.timers'],
    listeners: r['kit.targetListeners'],
  }
}

describe('dev-server cycles in core and ptyhost', () => {
  it(`L-MEM-11 · run a dev server, let a scan find its port, stop it, ×${CYCLES}: holders, \`kea-helper ports\` children, port-scan timers, handles, timers and fds at baseline; one Server tab record, its port free`, async () => {
    const s = await startSessions({ opts: { helperPath: await helperBinary(), agentIntake: false, portProbe: ownBlocks() } })
    cleanup.push(() => s.dispose())
    const r = repo()
    cleanup.push(() => r.dispose())
    const p = await s.project(r.root)
    const created = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, 'serve'))
    const v: SessionView = await s.until(created.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
    expect(v.lifecycle).toBe('live')
    const zoo = zooCommand('server', [])
    fs.writeFileSync(path.join(v.cwd, 'start.sh'), `#!/bin/sh\nexec ${[zoo.file, ...zoo.args].map(q).join(' ')}\n`, { mode: 0o755 })
    const core = s.c.core
    // a window shows the session for the whole run: its `server:` store and its start.sh watch are part of the baseline
    const window = {}
    core.visible.set(window, v.id)
    cleanup.push(() => core.visible.drop(window))
    const view = (): ServerView => core.servers.view(v.id)
    const port = v.portBase as number

    const cycle = async (i: number) => {
      expect(await s.call<ServerResult>('server.run', { sessionId: v.id }), `cycle ${i}: run`).toMatchObject({ ok: true })
      // a scan (the holder's STAT, then `kea-helper ports` on the ports pool) finds the port; asked for as the Server
      // tab's opening asks, so no cycle waits for the interval
      await until(`cycle ${i}: the server's port found`, async () => {
        if (view().ports.includes(port)) return true
        await s.call('server.scan', { sessionId: v.id })
        return false
      })
      expect(view(), `cycle ${i}`).toMatchObject({ state: 'running', ports: [port], url: `http://localhost:${port}/` })
      // one schedule while it runs: its interval, and at most the one extra scan its output asked for
      const up = core.servers.resourceCounts
      expect(up.live, `cycle ${i}: servers alive`).toBe(1)
      expect([1, 2], `cycle ${i}: scan timers while it runs`).toContain(up.scanTimers)
      expect(await s.call<ServerResult>('server.stop', { sessionId: v.id }), `cycle ${i}: stop`).toMatchObject({ ok: true, state: 'stopped' })
      await core.servers.idle()
      expect(await listening(port), `cycle ${i}: port ${port} free after Stop`).toBe(false)
    }

    for (let i = 0; i < METHOD.warmups; i++) await cycle(i)
    // only the agent's holder runs (a stopped server's holder is let go; its state file and ring stay for the tab)
    const quiet = () => holdersIn(s.h.home).filter((id) => holderAlive(s.h.home, id)).length === 1 && resources.report()['ptyhost.holderSockets'] === 1
    await until('the stopped server’s holder gone, and ptyhost’s connection to it', quiet)
    await atRest()
    const before = { counts: counts(s), handles: handles(), fds: fds() }
    expect(before.counts.servers).toMatchObject({ entries: 1, live: 0, stores: 1, scanTimers: 0, scans: 0, watches: 1 })
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    for (let i = METHOD.warmups; i < CYCLES; i++) await cycle(i)
    await until('every server holder gone, and ptyhost’s connections to them', quiet)
    await atRest()

    expect(tracker.report(), 'disposables of the measured cycles all disposed').toBe('')
    expect(counts(s)).toEqual(before.counts)
    expect(handles(), 'active handles and timers').toEqual(before.handles)
    expect(fds(), 'open file descriptors').toBe(before.fds)
    // the Server tab is the last run's alone: one `server` record, ended, however many runs there were
    const records = core.terminals.sessionRecords(v.id).filter((x) => x.kind === 'server')
    expect(records.map((x) => x.state)).toEqual(['exited'])
    expect(view()).toMatchObject({ state: 'stopped', ports: [], url: null, pid: null })
  })
})
