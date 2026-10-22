import fs from 'node:fs'
import path from 'node:path'
import headless from '@xterm/headless'
import { noopLogger, resources, runDir } from '@kea/kit'
import { channelPair, DEFAULT_TERMINAL_SETTINGS, L, type PtyhostNote, type StreamToRenderer } from '@kea/protocol'
import { colorThemeOf } from '@kea/terminal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkpointPath, type CheckpointStore } from './checkpoint/store.ts'
import { PtyManager } from './manager.ts'
import { FakeHolder, ManualClock, tempHome } from './test-support.ts'

const { Terminal } = headless

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

describe('ptyhost manager: startup adoption', () => {
  it('U-PTY-16 · pty.list asked during the startup adoption answers after it, with every surviving holder', async () => {
    const home = tempHome()
    cleanup.push(async () => fs.rmSync(home, { recursive: true, force: true }))
    const holders = await Promise.all(
      ['aaaaaaaaaa', 'bbbbbbbbbb'].map((ptyId) => FakeHolder.start({ dir: path.join(home, 'sessions', 'shells'), sockDir: runDir(home), ptyId })),
    )
    for (const h of holders) cleanup.push(() => h.close())
    const m = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: '0.0.0', dev: true, client: { option: '--client-req', value: 'test' } }, { log: noopLogger, notify: () => {} })
    cleanup.push(async () => m.dispose())
    const adopting = m.adoptAll()
    // core's first list arrives while the adoption is still connecting (ptyhost reports ready before it finishes)
    const list = (m.handlers()['pty.list'] as (a: object, ctx: never) => Promise<{ ptyId: string }[]>)({}, { signal: new AbortController().signal } as never)
    expect((await list).map((i) => i.ptyId).sort()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
    expect((await adopting).adopted.sort()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
  })

  it('U-PTY-48 · a renderer stream and core calls that arrive while the startup adoption is still connecting reach the adopted PTY, not "gone"', async () => {
    const home = tempHome()
    cleanup.push(async () => fs.rmSync(home, { recursive: true, force: true }))
    const ptyId = 'dddddddddd'
    const h = await FakeHolder.start({ dir: path.join(home, 'sessions', 'shells'), sockDir: runDir(home), ptyId })
    cleanup.push(() => h.close())
    h.emit('before the restart\r\n')
    const m = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: '0.0.0', dev: true, client: { option: '--client-req', value: 'test' } }, { log: noopLogger, notify: () => {} })
    cleanup.push(async () => m.dispose())
    const adopting = m.adoptAll()
    // ptyhost said ready before the adoption finished: the window re-attaches and the user types at once
    const [mine, theirs] = channelPair()
    const msgs: StreamToRenderer[] = []
    theirs.onMessage((raw) => {
      const msg = raw as StreamToRenderer
      msgs.push(msg)
      if (msg.k === 'snapshot') theirs.send({ k: 'credit', n: msg.data.length })
    })
    m.attachStream(ptyId, mine)
    expect(resources.report()['ptyhost.streamsHeld']).toBe(1)
    theirs.send({ k: 'resize', cols: 101, rows: 31, xpx: 0, ypx: 0 })
    theirs.send({ k: 'in', d: 'typed early' })
    const handlers = m.handlers() as unknown as Record<string, (a: object, ctx: never) => unknown>
    const signal = handlers['pty.signal']!({ ptyId, signo: 28, target: 'child' }, {} as never)
    expect((await adopting).adopted).toEqual([ptyId])
    await vi.waitFor(() => expect(msgs.map((x) => x.k)).toContain('snapshot'))
    expect(msgs.map((x) => x.k)).not.toContain('gone')
    expect(resources.report()['ptyhost.streamsHeld']).toBe(0)
    expect(await signal).toEqual({ ok: true })
    await h.until(() => h.inputs() === 'typed early' && h.received.some((f) => f.t === 'resize' && f.cols === 101 && f.rows === 31))
    // a PTY that is not there after the adoption is still gone at once
    const [late, lateEnd] = channelPair()
    const lateMsgs: StreamToRenderer[] = []
    lateEnd.onMessage((raw) => lateMsgs.push(raw as StreamToRenderer))
    m.attachStream('eeeeeeeeee', late)
    await vi.waitFor(() => expect(lateMsgs).toEqual([{ k: 'gone', reason: 'no such terminal' }]))
    await expect(Promise.resolve().then(() => handlers['pty.signal']!({ ptyId: 'eeeeeeeeee', signo: 28, target: 'child' }, {} as never))).rejects.toThrow(/no pty/)
  })

  it('U-PTY-18 · a symlink in the run directory is never followed, even to a live holder', async () => {
    const home = tempHome()
    cleanup.push(async () => fs.rmSync(home, { recursive: true, force: true }))
    const elsewhere = path.join(home, 'elsewhere')
    const h = await FakeHolder.start({ dir: path.join(home, 'sessions', 'shells'), sockDir: elsewhere, ptyId: 'cccccccccc' })
    cleanup.push(() => h.close())
    fs.mkdirSync(runDir(home), { recursive: true, mode: 0o700 })
    fs.symlinkSync(h.sock, path.join(runDir(home), 'cccccccccc.sock'))
    const m = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: '0.0.0', dev: true, client: { option: '--client-req', value: 'test' } }, { log: noopLogger, notify: () => {} })
    cleanup.push(async () => m.dispose())
    expect(await m.adoptAll()).toEqual({ adopted: [], failed: ['cccccccccc'] })
    expect(h.received).toEqual([])
    expect(h.connections).toBe(0)
  })
})

describe('ptyhost resource report', () => {
  it('U-MEM-17 · the ptyhost resources kept in the manager (PTYs, credit windows, per-PTY queues and timers, pending rebuilds, checkpoints) are in the kit report with the values the test knows, and gone with the manager', async () => {
    const home = tempHome()
    cleanup.push(async () => fs.rmSync(home, { recursive: true, force: true }))
    const ptyId = 'ffffffffff'
    const h = await FakeHolder.start({ dir: path.join(home, 'sessions', 'shells'), sockDir: runDir(home), ptyId })
    cleanup.push(() => h.close())
    h.emit('some output\r\n')
    const clock = new ManualClock()
    const m = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: '0.0.0', dev: true, client: { option: '--client-req', value: 'test' } }, { log: noopLogger, notify: () => {}, clock })
    cleanup.push(async () => m.dispose())
    const rows = () => {
      const r = resources.report()
      return { ptys: r['ptyhost.ptys'], connections: r['ptyhost.connections'], creditWindows: r['ptyhost.creditWindows'], ptyQueues: r['ptyhost.ptyQueues'], ptyTimers: r['ptyhost.ptyTimers'], pendingRebuilds: r['ptyhost.pendingRebuilds'], checkpoints: r['ptyhost.checkpoints'] }
    }
    await m.adopt(ptyId)
    // a renderer that never returns credit: its window holds exactly what was sent
    const [mine, theirs] = channelPair()
    let sent = 0
    theirs.onMessage((raw) => {
      const msg = raw as StreamToRenderer
      if (msg.k === 'snapshot') sent += msg.data.length
      else if (msg.k === 'data') sent += msg.b.byteLength
    })
    m.attachStream(ptyId, mine, 1)
    await vi.waitFor(() => expect(sent).toBeGreaterThan(0))
    expect(rows()).toEqual({
      ptys: { awake: 1, parked: 0 },
      connections: { windows: 1, streams: 1 },
      creditWindows: { windows: 1, outstandingBytes: sent },
      ptyQueues: { coalescerBytes: 0, snapshotWaiters: 0, holderWriteBytes: 0 },
      // attached (no park timer) and its snapshot sent (no wait): only the stall watch the rebuild's replay armed,
      // which stays until its time is up
      ptyTimers: 1,
      pendingRebuilds: { queued: 0, running: 0 },
      // the mirror is dirty: its checkpoint falls due at L.checkpointMaxAgeMs, on the scheduler's one timer
      checkpoints: { watched: 1, pending: 0, timer: 1, inMemory: 0, inMemoryChars: 0 },
    })
    clock.advance(L.mirrorStallMs) // nothing pending: the stall watch fires and is not armed again
    expect(rows().ptyTimers).toBe(0)
    theirs.close()
    m.dispose()
    expect(rows()).toEqual({
      ptys: { awake: 0, parked: 0 },
      connections: { windows: 0, streams: 0 },
      creditWindows: { windows: 0, outstandingBytes: 0 },
      ptyQueues: { coalescerBytes: 0, snapshotWaiters: 0, holderWriteBytes: 0 },
      ptyTimers: 0,
      pendingRebuilds: { queued: 0, running: 0 },
      checkpoints: { watched: 0, pending: 0, timer: 0, inMemory: 0, inMemoryChars: 0 },
    })
  })

  it('U-MEM-24 · the ptyhost rows count what is really queued — a rebuild running and one waiting, output in the coalescer, a snapshot waiting for ground, input the holder has not read, a checkpoint asked for, one kept in memory — and debug.resources answers with the report main logs', async () => {
    const home = tempHome()
    cleanup.push(async () => fs.rmSync(home, { recursive: true, force: true }))
    const stateDir = path.join(home, 'sessions', 'shells')
    const [a, b] = (await Promise.all(['kkkkkkkkkk', 'mmmmmmmmmm'].map((ptyId) => FakeHolder.start({ dir: stateDir, sockDir: runDir(home), ptyId })))) as [FakeHolder, FakeHolder]
    for (const h of [a, b]) {
      cleanup.push(() => h.close())
      h.emit(`${h.ptyId} before the restart\r\n`)
    }
    const clock = new ManualClock()
    const m = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: '0.0.0', dev: true, client: { option: '--client-req', value: 'test' } }, { log: noopLogger, notify: () => {}, clock })
    cleanup.push(async () => m.dispose())
    // "Keep scrollback on disk" off: checkpoints stay in ptyhost's memory
    const colors = colorThemeOf(DEFAULT_TERMINAL_SETTINGS.theme)
    m.configure({ ...colors, palette: [...colors.palette], dark: true, scrollback: DEFAULT_TERMINAL_SETTINGS.scrollback, diskBackedScrollback: false })
    const row = (name: string) => resources.report()[`ptyhost.${name}`]
    const queues = () => row('ptyQueues') as Record<string, number>

    // Adopted PTYs rebuild from their rings one at a time. xterm's parsing is held back, so the first cannot finish
    const held: (() => void)[] = []
    const write = Terminal.prototype.write
    const hold = vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: InstanceType<typeof Terminal>, data, cb) {
      held.push(() => write.call(this, data, cb))
    })
    const pa = await m.adopt(a.ptyId)
    const pb = await m.adopt(b.ptyId)
    expect({ aReplaying: pa.isReplaying, bParked: pb.isParked }).toEqual({ aReplaying: true, bParked: true })
    expect(row('pendingRebuilds')).toEqual({ queued: 1, running: 1 })
    expect(row('ptys')).toEqual({ awake: 1, parked: 1 })
    hold.mockRestore()
    for (const w of held.splice(0)) w()
    await vi.waitFor(() => expect({ a: pa.isReplaying, b: pb.isReplaying, bParked: pb.isParked }).toEqual({ a: false, b: false, bParked: false }))
    expect(row('pendingRebuilds')).toEqual({ queued: 0, running: 0 })
    expect(row('ptys')).toEqual({ awake: 2, parked: 0 })
    // two awake mirrors with nothing attached: each waits to park and has the stall watch its replay armed, which goes
    // once its time is up with nothing pending
    expect(row('ptyTimers')).toBe(4)
    clock.advance(L.mirrorStallMs)
    expect(row('ptyTimers')).toBe(2)

    // Output that follows a chunk within L.coalesceQuietMs waits in the coalescer for its window
    clock.advance(L.coalesceQuietMs)
    a.emit('first ')
    await a.until(() => pa.flushedSeq() === a.latestSeq)
    const flushed = pa.flushedSeq()
    a.emit('second')
    await vi.waitFor(() => expect(queues().coalescerBytes).toBe('second'.length))
    expect(pa.flushedSeq()).toBe(flushed)
    clock.advance(L.coalesceWindowMs)
    expect(pa.flushedSeq()).toBe(a.latestSeq)
    expect(queues().coalescerBytes).toBe(0)

    // A stream attached while a synchronized-output block is open waits for its snapshot
    clock.advance(L.coalesceQuietMs)
    b.emit('\x1b[?2026h')
    await b.until(() => b.acks().at(-1) === b.latestSeq)
    clock.advance(L.mirrorStallMs) // the stall watches this output armed, gone (as above)
    expect(row('ptyTimers')).toBe(2)
    const [mine, theirs] = channelPair()
    const got: StreamToRenderer[] = []
    theirs.onMessage((raw) => got.push(raw as StreamToRenderer))
    m.attachStream(b.ptyId, mine, 1)
    await vi.waitFor(() => expect(pb.attachedCount).toBe(1))
    expect(queues().snapshotWaiters).toBe(1)
    // b's park timer went with the attach; the wait for the block is its one timer now
    expect(row('ptyTimers')).toBe(2)
    clock.advance(L.snapshotSyncWaitMs) // a block still open this long no longer delays it
    await vi.waitFor(() => expect(got.map((x) => x.k)).toContain('snapshot'))
    const snap = got.find((x) => x.k === 'snapshot') as Extract<StreamToRenderer, { k: 'snapshot' }>
    expect(queues().snapshotWaiters).toBe(0)
    expect(row('creditWindows')).toEqual({ windows: 1, outstandingBytes: snap.data.length })
    expect(row('ptyTimers')).toBe(1)

    // Input the holder has not read yet waits in ptyhost's socket
    const typed = 'x'.repeat(L.holderInputCapBytes / 4)
    pb.input(typed)
    expect(queues().holderWriteBytes).toBeGreaterThanOrEqual(typed.length)
    await b.until(() => b.inputs().length === typed.length)
    await vi.waitFor(() => expect(queues().holderWriteBytes).toBe(0))

    // ⌘K asks for a checkpoint at once; it stays pending until L.checkpointQuietMs after the input above, then
    // is kept in memory
    expect(row('checkpoints')).toMatchObject({ watched: 2, pending: 0, inMemory: 0, inMemoryChars: 0 })
    expect(pa.clear()).toBe(true)
    expect(row('checkpoints')).toMatchObject({ watched: 2, pending: 1, timer: 1 })
    clock.advance(L.checkpointQuietMs - 1)
    expect(row('checkpoints')).toMatchObject({ watched: 2, pending: 1, timer: 1, inMemory: 0 })
    clock.advance(1)
    expect(row('checkpoints')).toMatchObject({ watched: 2, pending: 0, inMemory: 1 })
    expect((row('checkpoints') as Record<string, number>).inMemoryChars).toBeGreaterThan(0)
    expect(fs.existsSync(checkpointPath(stateDir, a.ptyId))).toBe(false)

    // the debug RPC answers with the report main asks for and logs, not a report of its own
    const handlers = m.handlers() as unknown as Record<string, (args: object, ctx: never) => unknown>
    expect(await handlers['debug.resources']!({}, {} as never)).toEqual(resources.report())

    // An exited PTY's checkpoint in memory goes with it, once its holder leaves after RELEASE
    a.exit(0)
    await vi.waitFor(() => expect(pa.isRunning).toBe(false))
    expect(pa.release()).toBe(true)
    a.dropClient()
    await vi.waitFor(() => expect(pa.isDisposed).toBe(true))
    expect(row('checkpoints')).toMatchObject({ watched: 1, pending: 0, inMemory: 0, inMemoryChars: 0 })
    expect(row('ptys')).toEqual({ awake: 1, parked: 0 })

    theirs.close()
    m.dispose()
    expect([row('ptys'), row('ptyTimers'), row('ptyQueues'), row('pendingRebuilds'), row('checkpoints'), row('creditWindows')]).toEqual([
      { awake: 0, parked: 0 },
      0,
      { coalescerBytes: 0, snapshotWaiters: 0, holderWriteBytes: 0 },
      { queued: 0, running: 0 },
      { watched: 0, pending: 0, timer: 0, inMemory: 0, inMemoryChars: 0 },
      { windows: 0, outstandingBytes: 0 },
    ])
  })

  it('U-MEM-22 · each window’s streams form one connection scope: main’s disconnect closes them all on both ends, a scope goes when its last stream does, and the report counts them', async () => {
    const home = tempHome()
    cleanup.push(async () => fs.rmSync(home, { recursive: true, force: true }))
    const ids = ['gggggggggg', 'hhhhhhhhhh']
    for (const ptyId of ids) {
      const h = await FakeHolder.start({ dir: path.join(home, 'sessions', 'shells'), sockDir: runDir(home), ptyId })
      cleanup.push(() => h.close())
    }
    const m = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: '0.0.0', dev: true, client: { option: '--client-req', value: 'test' } }, { log: noopLogger, notify: () => {} })
    cleanup.push(async () => m.dispose())
    for (const ptyId of ids) await m.adopt(ptyId)
    const report = () => ({ connections: resources.report()['ptyhost.connections'], streams: m.reportRows().creditWindows.windows })
    /** A renderer's end of a stream port for `ptyId` in window `connId`, and whether ptyhost closed it. */
    const attach = (connId: number, ptyId: string) => {
      const [mine, theirs] = channelPair()
      const end = { theirs, closed: false }
      theirs.onClose(() => (end.closed = true))
      m.attachStream(ptyId, mine, connId)
      return end
    }
    const w1 = [attach(1, ids[0]!), attach(1, ids[1]!)]
    const w2 = attach(2, ids[0]!)
    expect(report()).toEqual({ connections: { windows: 2, streams: 3 }, streams: 3 })
    expect(m.reportRows().connections).toEqual({ windows: 2, streams: 3 })

    m.disconnect(1) // window 1 reloaded, crashed or closed
    expect(m.reportRows().connections).toEqual({ windows: 1, streams: 1 })
    // ports close asynchronously, as Electron's do
    await vi.waitFor(() => expect(w1.map((e) => e.closed)).toEqual([true, true]))
    expect(w2.closed).toBe(false)
    expect(report()).toEqual({ connections: { windows: 1, streams: 1 }, streams: 1 })
    m.disconnect(1) // twice, or a window ptyhost never saw: nothing to do
    m.disconnect(7)
    expect(report()).toEqual({ connections: { windows: 1, streams: 1 }, streams: 1 })

    w2.theirs.close() // the renderer let its last stream go: nothing of window 2 is left
    await vi.waitFor(() => expect(report()).toEqual({ connections: { windows: 0, streams: 0 }, streams: 0 }))
    const again = attach(2, ids[1]!) // and a later stream opens the scope again
    expect(report()).toEqual({ connections: { windows: 1, streams: 1 }, streams: 1 })
    m.dispose()
    expect(resources.report()['ptyhost.connections']).toEqual({ windows: 0, streams: 0 })
    await vi.waitFor(() => expect(again.closed).toBe(true))
  })
})

describe('disk full', () => {
  it('U-PTY-62 · checkpoints the full disk refuses: the disk-full banner once, no retry before L.checkpointMaxAgeMs (not a serialisation every L.checkpointMinIntervalMs), the terminal still streams; another failure that is not the disk raises nothing; the next checkpoint written clears the banner', async () => {
    const home = tempHome()
    cleanup.push(async () => fs.rmSync(home, { recursive: true, force: true }))
    const ptyId = 'ffffffffff'
    const h = await FakeHolder.start({ dir: path.join(home, 'sessions', 'shells'), sockDir: runDir(home), ptyId })
    cleanup.push(() => h.close())
    const clock = new ManualClock()
    const notes: PtyhostNote[] = []
    // where the checkpoints go: refused while `refuse` is set, as a full disk refuses a write
    let refuse: Error | null = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    const writes: number[] = []
    const store: CheckpointStore = {
      read: () => null,
      write: () => {
        writes.push(clock.now())
        if (refuse) throw refuse
      },
      remove: () => {},
    }
    const m = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: '0.0.0', dev: true, client: { option: '--client-req', value: 'test' } }, { log: noopLogger, notify: (n) => notes.push(n), clock, checkpoints: store })
    cleanup.push(async () => m.dispose())
    const p = await m.adopt(ptyId)
    // a window shows it: awake, never parked
    const [mine, theirs] = channelPair()
    const msgs: StreamToRenderer[] = []
    theirs.onMessage((raw) => {
      const msg = raw as StreamToRenderer
      msgs.push(msg)
      if (msg.k === 'snapshot') theirs.send({ k: 'credit', n: msg.data.length })
      if (msg.k === 'data') theirs.send({ k: 'credit', n: msg.b.byteLength })
    })
    m.attachStream(ptyId, mine)
    await vi.waitFor(() => expect(msgs.map((x) => x.k)).toContain('snapshot'))
    h.emit('output before the disk fills\r\n')
    await vi.waitFor(() => expect(p.dirtyBytes()).toBeGreaterThan(0))
    const banners = () => notes.filter((n) => n.m === 'pty.banner' || n.m === 'pty.bannerCleared')

    // due by age: the write is refused; the banner is raised once
    clock.advance(L.checkpointMaxAgeMs)
    expect(writes).toHaveLength(1)
    expect(banners()).toEqual([{ m: 'pty.banner', a: { kind: 'diskFull', message: expect.stringMatching(/disk is full/i) } }])
    // still dirty: nothing more is tried until the retry is due
    for (let t = 0; t < L.checkpointMaxAgeMs - 1; t += L.checkpointMinIntervalMs) clock.advance(Math.min(L.checkpointMinIntervalMs, L.checkpointMaxAgeMs - 1 - t))
    expect(writes, 'no serialisation every L.checkpointMinIntervalMs while the disk is full').toHaveLength(1)
    // the terminal still streams
    h.emit('output while the disk is full\r\n')
    await vi.waitFor(() => expect(msgs.some((x) => x.k === 'data' && Buffer.from(x.b).toString().includes('while the disk is full'))).toBe(true))
    // the retry: refused for another reason (not the disk) raises nothing more
    refuse = Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })
    clock.advance(1)
    expect(writes).toHaveLength(2)
    expect(banners()).toHaveLength(1)
    // space is back: the next checkpoint is written and the banner goes, once
    refuse = null
    clock.advance(L.checkpointMaxAgeMs)
    expect(writes).toHaveLength(3)
    expect(banners()).toEqual([
      { m: 'pty.banner', a: { kind: 'diskFull', message: expect.stringMatching(/disk is full/i) } },
      { m: 'pty.bannerCleared', a: { kind: 'diskFull' } },
    ])
    h.emit('more\r\n')
    await vi.waitFor(() => expect(p.dirtyBytes()).toBeGreaterThan(0))
    clock.advance(L.checkpointMaxAgeMs)
    expect(writes).toHaveLength(4)
    expect(banners(), 'nothing more to clear').toHaveLength(2)
  })
})
