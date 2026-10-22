import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noopLogger, resources } from '@kea/kit'
import { channelPair, L, ptyhostApi, RpcPeer, SimpleStoreRegistry, type PtyInfo } from '@kea/protocol'
import { MemoryRecords, type TerminalRecord } from '../terminal/records.ts'
import { Terminals } from '../terminal/terminals.ts'
import { StatusBatch } from '../platform/db/batch.ts'
import { openDatabase } from '../platform/db/db.ts'
import { Projects } from '../sessions/projects.ts'
import { SettingsFile } from '../settings/settings.ts'
import { SessionsSeen } from '../platform/backupExclusions.ts'
import { registerCoreGauges } from './gauges.ts'

afterEach(() => {
  vi.useRealTimers()
})

const holder = (ptyId: string): PtyInfo => ({
  ptyId,
  sessionId: 'shells',
  kind: 'shell',
  state: 'running',
  holderPid: 10,
  holderStartedAt: 1,
  childPid: 11,
  cwd: '/tmp',
  argv: ['/bin/zsh', '-l'],
  cols: 80,
  rows: 24,
  exitCode: null,
  exitSignal: null,
  detached: false,
  title: null,
})

const record = (ptyId: string, tabOrder: number): TerminalRecord => ({
  ptyId,
  sessionId: 'shells',
  kind: 'shell',
  argv: ['/bin/zsh', '-l'],
  cwd: '/tmp',
  title: null,
  holderPid: 10,
  holderStartedAt: 1,
  childPid: 11,
  cols: 80,
  rows: 24,
  state: 'running',
  exitCode: null,
  exitSignal: null,
  tabOrder,
  createdAt: 1,
  endedAt: null,
})

/** A stand-in ptyhost listing `holders`. */
function ptyhost(holders: PtyInfo[]) {
  const [coreSide, ptyhostSide] = channelPair()
  const peer = new RpcPeer(ptyhostSide, {
    name: 'fake-ptyhost',
    api: ptyhostApi,
    handlers: {
      'pty.configure': async () => ({ ok: true }),
      'pty.setVisible': async () => ({ ok: true }),
      'pty.list': async () => holders,
      'pty.stat': async () => null, // a tab's title, asked of the holder: this ptyhost cannot tell
    } as never,
  })
  return { coreSide, peer }
}

const call = (t: Terminals, m: string, a: object): Promise<unknown> => (t.handlers() as Record<string, (a: object, ctx: never) => Promise<unknown>>)[m]!(a, { signal: new AbortController().signal } as never)

describe("core's resource rows", () => {
  it('U-MEM-21 · every core row reads the real objects: connection scopes, the control connection and calls waiting for it, store subscriptions and pending deltas, terminal records and orphans, shell tabs followed for their title; gone when unregistered', async () => {
    vi.useFakeTimers()
    // core as main.ts builds it: two recorded terminals, the terminals stores, one window's RPC connection
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records: new MemoryRecords([record('aaaaaaaaaa', 0), record('bbbbbbbbbb', 1)]) })
    const stores = new SimpleStoreRegistry()
    stores.add(t.store)
    stores.add(t.orphans)
    const [a, b] = channelPair()
    const served = new RpcPeer(a, { name: 'core', stores })
    const client = new RpcPeer(b, { name: 'renderer' })
    const connections = new Map([[1, served]])
    const reg = registerCoreGauges({ connections, terminals: t })
    const rows = () => Object.fromEntries(Object.entries(resources.report()).filter(([k]) => k.startsWith('core.')))
    const noTitles = { tabs: 0, timers: 0, asks: 0 }
    expect(rows()).toEqual({ 'core.connections': 1, 'core.control': 0, 'core.controlWaiters': 0, 'core.subscriptions': 0, 'core.pendingDeltas': 0, 'core.terminalRecords': 2, 'core.orphans': 0, 'core.terminalLaunches': 0, 'core.tabTitles': noTitles })

    // the window follows both stores; a call waits for ptyhost, which is not there yet
    const views = [client.subscribe(t.store.name, () => undefined), client.subscribe(t.orphans.name, () => undefined)]
    const waiting = call(t, 'terminal.setVisible', { ptyIds: ['aaaaaaaaaa'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(views.every((v) => v.ready)).toBe(true)
    expect(rows()).toMatchObject({ 'core.subscriptions': 2, 'core.controlWaiters': 1, 'core.control': 0 })

    // ptyhost connects and lists a third holder no record accounts for: an orphan. The orphans store holds one
    // merged delta for the window; the terminals store does not (ptyhost's info equals what the records showed)
    const ph = ptyhost([holder('aaaaaaaaaa'), holder('bbbbbbbbbb'), holder('cccccccccc')])
    t.setControl(ph.coreSide)
    expect(rows()).toMatchObject({ 'core.control': 1, 'core.controlWaiters': 0 })
    await call(t, 'terminal.restored', {})
    await waiting
    expect(rows()).toMatchObject({ 'core.orphans': 1, 'core.terminalRecords': 2, 'core.pendingDeltas': 1 })
    // The window shows a terminal of the shells, so both shell tabs are followed for their title (asked once, no timer left)
    expect(rows()['core.tabTitles']).toEqual({ tabs: 2, timers: 0, asks: 0 })
    await vi.advanceTimersByTimeAsync(L.storeTickMs)
    expect(rows()['core.pendingDeltas']).toBe(0)

    // ptyhost goes away (the control port's connection is cleaned up)
    ph.peer.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(rows()['core.control']).toBe(0)

    // the window goes: its scope, and every subscription in it, with it
    served.dispose()
    connections.delete(1)
    t.windowGone() // as core.ts `serve` does when a window's channel closes
    expect(rows()).toEqual({ 'core.connections': 0, 'core.control': 0, 'core.controlWaiters': 0, 'core.subscriptions': 0, 'core.pendingDeltas': 0, 'core.terminalRecords': 2, 'core.orphans': 1, 'core.terminalLaunches': 0, 'core.tabTitles': noTitles })
    reg.dispose()
    expect(rows()).toEqual({})
    client.dispose()
    t.dispose()
  })
})

describe("core's launch and Time Machine rows", () => {
  it('U-MEM-28 · core.terminalLaunches counts the PTYs being launched, from their record written while ptyhost is away until ptyhost has spawned and listed them, and core.sessionsSeen the sessions the Time Machine exclusions know of; gone when unregistered', async () => {
    vi.useFakeTimers()
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records: new MemoryRecords([]) })
    const seen = new SessionsSeen(['01K00000000000000000000S01'])
    const reg = registerCoreGauges({ connections: new Map(), terminals: t, sessionsSeen: seen })
    const rows = () => Object.fromEntries(Object.entries(resources.report()).filter(([k]) => ['core.terminalLaunches', 'core.sessionsSeen', 'core.terminalRecords', 'core.controlWaiters'].includes(k)))
    expect(rows()).toEqual({ 'core.terminalLaunches': 0, 'core.sessionsSeen': 1, 'core.terminalRecords': 0, 'core.controlWaiters': 0 })

    // a shell tab launched while ptyhost is away: its record is written, and the launch waits for the control port
    const launched = t.openShell({ cwd: '/tmp', cols: 80, rows: 24 })
    await vi.advanceTimersByTimeAsync(0)
    expect(rows()).toEqual({ 'core.terminalLaunches': 1, 'core.sessionsSeen': 1, 'core.terminalRecords': 1, 'core.controlWaiters': 1 })

    // ptyhost comes and spawns it, and has not listed it yet: still being launched
    const spawned: string[] = []
    let list: () => void = () => undefined
    const listed = new Promise<void>((resolve) => (list = resolve))
    const [coreSide, ptyhostSide] = channelPair()
    const peer = new RpcPeer(ptyhostSide, {
      name: 'fake-ptyhost',
      api: ptyhostApi,
      handlers: {
        'pty.configure': async () => ({ ok: true }),
        'pty.setVisible': async () => ({ ok: true }),
        'pty.spawn': async (a: { ptyId: string }) => {
          spawned.push(a.ptyId)
          return { holderPid: 10, childPid: 11, detached: false }
        },
        'pty.list': async () => {
          await listed
          return spawned.map(holder)
        },
        'pty.stat': async () => null,
      } as never,
    })
    t.setControl(coreSide)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawned).toHaveLength(1)
    expect(rows()).toMatchObject({ 'core.terminalLaunches': 1, 'core.controlWaiters': 0 })

    // listed: launched, and the map holds nothing more
    list()
    expect(await launched).toEqual({ ptyId: spawned[0] })
    expect(rows()).toEqual({ 'core.terminalLaunches': 0, 'core.sessionsSeen': 1, 'core.terminalRecords': 1, 'core.controlWaiters': 0 })

    // a session new to the store, then both gone from it
    seen.changed({ set: { '01K00000000000000000000S02': {} } })
    expect(rows()['core.sessionsSeen']).toBe(2)
    seen.changed({ del: ['01K00000000000000000000S01', '01K00000000000000000000S02'] })
    expect(rows()['core.sessionsSeen']).toBe(0)

    reg.dispose()
    expect(rows()).toEqual({})
    peer.dispose()
    t.dispose()
  })
})

describe("core's data-layer rows", () => {
  it('U-MEM-25 · core.db, core.projects and core.settings read the real connection, status batch, projects and settings file; gone when unregistered', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-gauges-'))
    const { db } = openDatabase({ file: path.join(home, 'kea.db'), log: noopLogger })
    const statusBatch = new StatusBatch(db)
    const projects = new Projects({ db, log: noopLogger, gitReady: Promise.resolve(false) })
    const settings = new SettingsFile({ home, log: noopLogger, watch: true })
    const t = new Terminals({ version: '0', log: noopLogger, env: async () => ({}), records: new MemoryRecords([]) })
    const reg = registerCoreGauges({ connections: new Map(), terminals: t, db, statusBatch, projects, settings })
    const rows = () => Object.fromEntries(Object.entries(resources.report()).filter(([k]) => ['core.db', 'core.projects', 'core.settings'].includes(k)))
    const statements = db.stats.statements
    expect(rows()).toEqual({
      'core.db': { statements, walBytes: db.walBytes(), pendingWrites: 0 },
      'core.projects': { projects: 0, repoLocks: 0 },
      'core.settings': { values: settings.store.size, watchers: 1, listeners: 0 },
    })

    fs.mkdirSync(path.join(home, 'repo'))
    const { project } = await projects.add(path.join(home, 'repo'))
    db.tx(() => db.run("INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, agent, launch_config, lifecycle, sort_order, created_at) VALUES ('01K00000000000000000000S01', ?, 's', 'S', 'auto', 'inplace', '/', 'shell', '{}', 'live', 0, 0)", project.id))
    statusBatch.queue({ sessionId: '01K00000000000000000000S01', events: [{ at: 1, source: 'hook', event: 'Stop', summary: null, phaseAfter: 'ready' }] })
    const off = settings.onChange(() => undefined)
    expect(rows()).toMatchObject({ 'core.db': { pendingWrites: 2 }, 'core.projects': { projects: 1 }, 'core.settings': { listeners: 1 } })
    expect((rows()['core.db'] as { walBytes: number }).walBytes).toBeGreaterThan(0)
    statusBatch.flush()
    expect(rows()['core.db']).toMatchObject({ pendingWrites: 0 })

    off()
    settings.dispose()
    expect(rows()['core.settings']).toEqual({ values: 0, watchers: 0, listeners: 0 })
    reg.dispose()
    expect(rows()).toEqual({})
    statusBatch.dispose()
    projects.dispose()
    t.dispose()
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
})
