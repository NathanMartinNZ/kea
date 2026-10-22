// The mirror's lifecycle in ptyhost: parking, checkpoints, rebuilds and mirror health. Parking and checkpoint
// timers run on a ManualClock; socket I/O and xterm's parser run on real time, so each step waits for the holder to see
// its acks before the clock is moved.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger, runDir } from '@kea/kit'
import { channelPair, L, type PtyhostNote, type StreamToRenderer } from '@kea/protocol'
import { checkpointPath, diskCheckpoints, serializeCheckpoint } from './checkpoint/store.ts'
import { PtyManager } from './manager.ts'
import { Mirror } from './mirror/mirror.ts'
import { Pty } from './pty.ts'
import { FakeHolder, ManualClock, tempHome } from './test-support.ts'

const PTY = 'abcdefghij'
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  vi.restoreAllMocks()
})

async function setup(o: { ids?: string[]; capacity?: number } = {}) {
  const home = tempHome()
  const stateDir = path.join(home, 'sessions', 's1')
  const holders: FakeHolder[] = []
  for (const id of o.ids ?? [PTY]) {
    const h = await FakeHolder.start({ dir: stateDir, sockDir: runDir(home), ptyId: id, ...(o.capacity ? { capacity: o.capacity } : {}) })
    holders.push(h)
    cleanups.push(() => h.close())
  }
  const clock = new ManualClock()
  const notes: PtyhostNote[] = []
  const log = createMemoryLogger()
  const manager = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: 'test', dev: true, client: { option: '--client-req', value: 'test' } }, { log, notify: (n) => notes.push(n), clock })
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }), () => manager.dispose())
  const holder = holders[0]!
  /** PTY output after a quiet gap (so the coalescer flushes it at once), parsed and acked before returning. */
  const emit = async (data: string, h = holder) => {
    clock.advance(L.coalesceQuietMs)
    h.emit(data)
    await h.until(() => h.acks().at(-1) === h.latestSeq)
  }
  const ckpt = (id = PTY) => diskCheckpoints.read(stateDir, id)
  return { home, stateDir, holder, holders, clock, manager, notes, log, emit, ckpt }
}

/** A renderer stream end that returns credit for everything and records what it was sent. */
function renderer() {
  const [mine, theirs] = channelPair()
  const msgs: StreamToRenderer[] = []
  theirs.onMessage((raw) => {
    const m = raw as StreamToRenderer
    msgs.push(m)
    if (m.k === 'snapshot') theirs.send({ k: 'credit', n: m.data.length })
    else if (m.k === 'data') theirs.send({ k: 'credit', n: m.b.byteLength })
  })
  return { port: mine, msgs, close: () => theirs.close() }
}

type Handlers = ReturnType<PtyManager['handlers']>
/** Call one of the manager's `ptyhostApi` handlers as core would. */
function call<K extends keyof Handlers>(m: PtyManager, k: K, args: Parameters<NonNullable<Handlers[K]>>[0]): ReturnType<NonNullable<Handlers[K]>> {
  const h = m.handlers()[k] as (a: typeof args, ctx: never) => ReturnType<NonNullable<Handlers[K]>>
  return h(args, {} as never)
}

const waitParsed = (p: Pty) => vi.waitFor(() => expect(p.isReplaying).toBe(false))

describe('ptyhost mirror parking', () => {
  it('U-PTY-7 · a mirror with no renderer and no output for the idle period is checkpointed, then parked', async () => {
    const { holder, clock, manager, emit, ckpt } = await setup()
    holder.emit('hello\r\n')
    const p = await manager.adopt(PTY)
    await waitParsed(p)
    expect(p.isParked).toBe(false) // adopted with output and no checkpoint: rebuilt in idle time
    await emit('more\r\n')
    clock.advance(L.mirrorParkIdleMs - 1) // measured from the last output
    expect(p.isParked).toBe(false)
    expect(p.stats.parks).toBe(0)
    clock.advance(1)
    expect(p.isParked).toBe(true)
    expect(p.stats.parks).toBe(1)
    expect(ckpt()).toMatchObject({ seq: holder.latestSeq, cols: 80, rows: 24 })
    expect(ckpt()!.data).toContain('more')
  })

  it('U-PTY-7 · never parks while a renderer is attached; parks the idle period after the last one leaves', async () => {
    const { holder, clock, manager, emit } = await setup()
    const p = await manager.adopt(PTY)
    const r = renderer()
    manager.attachStream(PTY, r.port)
    await vi.waitFor(() => expect(r.msgs[0]?.k).toBe('snapshot'))
    await emit('x\r\n')
    clock.advance(3 * L.mirrorParkIdleMs)
    expect(p.isParked).toBe(false)
    r.close()
    await vi.waitFor(() => expect(p.attachedCount).toBe(0))
    clock.advance(0) // the idle period already passed: parks at once
    expect(p.isParked).toBe(true)
    expect(holder.latestSeq).toBeGreaterThan(0)
  })

  it('U-PTY-7 · new output restarts the idle period', async () => {
    const { clock, manager, emit } = await setup()
    const p = await manager.adopt(PTY)
    await emit('a\r\n')
    for (let i = 0; i < 4; i++) {
      clock.advance(L.mirrorParkIdleMs / 2)
      await emit(`tick ${i}\r\n`)
    }
    expect(p.isParked).toBe(false)
    clock.advance(L.mirrorParkIdleMs)
    expect(p.isParked).toBe(true)
  })

  it('U-PTY-7 · a parked mirror wakes on its first new byte, then answers the query in it exactly once', async () => {
    const { holder, clock, manager, emit } = await setup()
    holder.emit('old \x1b[c\r\n') // a query in history: never answered
    const p = await manager.adopt(PTY)
    await waitParsed(p)
    clock.advance(L.mirrorParkIdleMs)
    expect(p.isParked).toBe(true)
    await emit('\x1b[c')
    await holder.until(() => holder.inputs().length > 0)
    expect(p.isParked).toBe(false)
    expect(holder.inputs()).toBe('\x1b[?1;2c')
    expect(p.stats.wakes).toBe(2)
  })

  it('U-PTY-7 · attaching to a parked PTY is served the checkpoint at once while the mirror rebuilds behind it', async () => {
    const { holder, clock, manager, emit, ckpt } = await setup()
    holder.emit('before park\r\n')
    const p = await manager.adopt(PTY)
    await waitParsed(p)
    clock.advance(L.mirrorParkIdleMs)
    expect(p.isParked).toBe(true)
    const r = renderer()
    manager.attachStream(PTY, r.port)
    // synchronously: the snapshot is the checkpoint, and the mirror is already being rebuilt
    await Promise.resolve()
    expect(r.msgs[0]).toMatchObject({ k: 'snapshot', seq: ckpt()!.seq, data: ckpt()!.data })
    expect(p.isParked).toBe(false)
    await emit('after\r\n')
    await vi.waitFor(() => expect(r.msgs.at(-1)).toMatchObject({ k: 'data', seq: holder.latestSeq - 'after\r\n'.length }))
    expect(r.msgs.filter((m) => m.k === 'snapshot')).toHaveLength(1)
  })
})

describe('ptyhost checkpoints', () => {
  it('U-PTY-8 · an awake mirror is not checkpointed before the max age, and is once it passes', async () => {
    const { clock, manager, emit, ckpt } = await setup()
    const p = await manager.adopt(PTY)
    const r = renderer() // attached: never parks
    manager.attachStream(PTY, r.port)
    await vi.waitFor(() => expect(r.msgs[0]?.k).toBe('snapshot'))
    const t0 = clock.now()
    await emit('some output\r\n')
    clock.advance(t0 + L.checkpointMaxAgeMs - 1 - clock.now())
    expect(ckpt()).toBeNull()
    clock.advance(1)
    expect(ckpt()).toMatchObject({ seq: p.flushedSeq() })
  })

  it('U-PTY-8 · exit writes a final checkpoint at the last byte and frees the mirror', async () => {
    const { holder, clock, manager, emit, ckpt } = await setup()
    const p = await manager.adopt(PTY)
    await emit('last words\r\n')
    holder.exit(0)
    await vi.waitFor(() => expect(p.info().state).toBe('exited'))
    clock.advance(0)
    expect(p.isParked).toBe(true)
    expect(ckpt()).toMatchObject({ seq: holder.latestSeq })
    expect(ckpt()!.data).toContain('last words')
  })

  it('U-PTY-8 · shutdown checkpoints every dirty mirror, even right after a keystroke', async () => {
    const { manager, emit, ckpt } = await setup()
    const p = await manager.adopt(PTY)
    await emit('dirty\r\n')
    p.input('k')
    manager.shutdown()
    expect(ckpt()!.data).toContain('dirty')
  })

  it('U-PTY-8 · a checkpoint waits for the end of an escape sequence; an open DEC 2026 block delays it only up to its limit', async () => {
    const { holder, clock, manager, emit, ckpt } = await setup()
    const p = await manager.adopt(PTY)
    await emit('text \x1b[3')
    manager.scheduler.request(p, 'now')
    clock.advance(10 * L.snapshotSyncWaitMs)
    expect(ckpt()).toBeNull() // mid-sequence: waits however long
    await emit('1mred\x1b[0m\r\n')
    clock.advance(L.checkpointMinIntervalMs)
    expect(ckpt()).toMatchObject({ seq: holder.latestSeq })
    // a synchronized-output block left open by an app that died mid-frame
    await emit('\x1b[?2026hframe')
    clock.advance(L.checkpointMinIntervalMs) // past the rate limit, so the first attempt is now
    manager.scheduler.request(p, 'now')
    clock.advance(0)
    clock.advance(L.snapshotSyncWaitMs - 1)
    expect(ckpt()!.seq).toBeLessThan(holder.latestSeq)
    clock.advance(1)
    expect(ckpt()).toMatchObject({ seq: holder.latestSeq })
  })

  it('U-PTY-54 · ⌘K clears the mirror and writes a checkpoint without new output; the ring is untouched', async () => {
    const { holder, clock, manager, emit, ckpt } = await setup()
    const p = await manager.adopt(PTY)
    await emit('secret scrollback\r\n')
    expect(call(manager, 'pty.clear', { ptyId: PTY })).toEqual({ ok: true })
    clock.advance(L.checkpointMinIntervalMs)
    await vi.waitFor(() => expect(ckpt()).not.toBeNull())
    expect(ckpt()!.data).not.toContain('secret')
    expect(fs.readFileSync(holder.ringPath).includes('secret scrollback')).toBe(true)
    expect(p.screenText()).not.toContain('secret')
  })

  it('U-PTY-8 · checkpoint files are private to the user and replaced atomically', async () => {
    const { stateDir } = await setup()
    const c = { seq: 5, cols: 80, rows: 24, data: 'abc', title: null }
    diskCheckpoints.write(stateDir, PTY, c)
    diskCheckpoints.write(stateDir, PTY, { ...c, seq: 6 })
    expect(fs.statSync(checkpointPath(stateDir, PTY)).mode & 0o777).toBe(0o600)
    expect(diskCheckpoints.read(stateDir, PTY)).toEqual({ ...c, seq: 6 })
    expect(fs.readdirSync(stateDir).filter((n) => n.includes('.ckpt'))).toEqual([`${PTY}.ckpt`]) // no temp left behind
  })
})

describe('ptyhost checkpoint storage', () => {
  it('U-PTY-23 · turning "Keep scrollback on disk" off moves live checkpoints into memory; a parked PTY still wakes from its own', async () => {
    const { holder, clock, manager, emit, ckpt, stateDir } = await setup()
    const p = await manager.adopt(PTY)
    await emit('kept in memory\r\n')
    clock.advance(L.mirrorParkIdleMs)
    expect(p.isParked).toBe(true)
    expect(ckpt()).not.toBeNull()
    const cfg = { foreground: '#ffffff', background: '#000000', cursor: '#ffffff', palette: Array<string>(16).fill('#808080'), dark: true, scrollback: 1000 }
    manager.configure({ ...cfg, diskBackedScrollback: false })
    expect(fs.existsSync(checkpointPath(stateDir, PTY))).toBe(false)
    const r = renderer()
    manager.attachStream(PTY, r.port)
    await Promise.resolve()
    expect(r.msgs[0]).toMatchObject({ k: 'snapshot', seq: holder.latestSeq })
    expect((r.msgs[0] as { data: string }).data).toContain('kept in memory')
    r.close()
    await vi.waitFor(() => expect(p.attachedCount).toBe(0))
    clock.advance(L.mirrorParkIdleMs)
    expect(p.isParked).toBe(true)
    expect(fs.existsSync(checkpointPath(stateDir, PTY))).toBe(false)
    manager.configure({ ...cfg, diskBackedScrollback: true })
    expect(ckpt()).toMatchObject({ seq: holder.latestSeq })
  })
})

describe('ptyhost rebuilds', () => {
  it('C-COR-2 · a truncated checkpoint, or one whose seq the ring cannot follow, is ignored and the mirror is rebuilt from the ring', async () => {
    for (const bad of ['truncated', 'ahead', 'behind'] as const) {
      const { holder, stateDir, clock, manager, ckpt } = await setup({ capacity: L.ringBytesMin })
      const line = 'y'.repeat(78) + '\r\n'
      holder.emit(line.repeat(Math.ceil((L.ringBytesMin * 1.2) / line.length))) // wraps: earliestSeq > 0
      holder.emit('the end\r\n')
      const good = { seq: holder.latestSeq, cols: 80, rows: 24, data: 'CHECKPOINT\r\n', title: null }
      const file = checkpointPath(stateDir, PTY)
      if (bad === 'truncated') fs.writeFileSync(file, serializeCheckpoint(good).slice(0, 20))
      if (bad === 'ahead') fs.writeFileSync(file, serializeCheckpoint({ ...good, seq: holder.latestSeq + 100 }))
      if (bad === 'behind') fs.writeFileSync(file, serializeCheckpoint({ ...good, seq: holder.earliestSeq - 1 }))
      expect(holder.earliestSeq).toBeGreaterThan(0)
      const p = await manager.adopt(PTY)
      await waitParsed(p)
      expect(p.isParked).toBe(false)
      expect(p.screenText()).toContain('the end')
      expect(p.screenText()).not.toContain('CHECKPOINT')
      expect(p.checkpointSeq).toBeNull()
      // nor is it served as a parked PTY's snapshot: parking replaces it
      clock.advance(L.mirrorParkIdleMs)
      expect(p.isParked).toBe(true)
      expect(ckpt()).toMatchObject({ seq: holder.latestSeq })
      for (const c of cleanups.splice(0).reverse()) await c()
    }
  })

  it('U-PTY-19 · adoption rebuilds the visible terminal first and the rest one at a time; a PTY with a valid checkpoint and no new output stays parked', async () => {
    const ids = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd']
    const { holders, stateDir, manager } = await setup({ ids })
    for (const h of holders) h.emit(`${h.ptyId}\r\n`.repeat(2000))
    // d's checkpoint covers everything it printed
    const d = holders[3]!
    diskCheckpoints.write(stateDir, d.ptyId, { seq: d.latestSeq, cols: 80, rows: 24, data: 'parked\r\n', title: null })
    manager.setVisible(['cccccccccc'])
    const replaying: number[] = []
    const ensure = Pty.prototype.ensureAwake
    const order: string[] = []
    vi.spyOn(Pty.prototype, 'ensureAwake').mockImplementation(function (this: Pty) {
      if (this.isParked) order.push(this.ptyId)
      ensure.call(this)
      replaying.push(ids.filter((id) => manager.get(id)?.isReplaying).length)
    })
    await manager.adoptAll()
    await vi.waitFor(() => expect(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'].every((id) => manager.get(id)?.isParked === false && !manager.get(id)!.isReplaying)).toBe(true))
    expect(order[0]).toBe('cccccccccc')
    expect(order.slice(1).sort()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
    expect(Math.max(...replaying)).toBeLessThanOrEqual(2) // the visible one, plus one idle-time rebuild
    expect(manager.get('dddddddddd')!.isParked).toBe(true)
  })

  it('U-PTY-57 · a renderer that attaches while its terminal is being rebuilt from a checkpoint with nothing after it is served its snapshot once the checkpoint is written in', async () => {
    const { holder, stateDir, manager } = await setup()
    holder.emit('before\r\n')
    // an idle shell after a relaunch: the checkpoint covers every byte, so no output will come to wake the stream
    diskCheckpoints.write(stateDir, PTY, { seq: holder.latestSeq, cols: 80, rows: 24, data: `${'checkpointed line\r\n'.repeat(400)}kea$ `, title: null })
    await manager.adoptAll()
    const p = manager.get(PTY)!
    expect(p.isParked, 'not visible and nothing new: parked').toBe(true)
    // the window makes it visible (core's terminal.setVisible) just before its stream arrives
    manager.setVisible([PTY])
    expect(p.currentMirror?.isRestoring, 'the mirror is still writing the checkpoint in').toBe(true)
    const r = renderer()
    manager.attachStream(PTY, r.port)
    await vi.waitFor(() => expect(r.msgs[0]).toMatchObject({ k: 'snapshot', seq: holder.latestSeq }))
    expect((r.msgs[0] as { data: string }).data).toContain('kea$')
  })

  it('U-PTY-20 · a rebuild from the ring alone nudges a full-screen app to repaint: rows − 1, then back', async () => {
    const { holder, clock, manager } = await setup()
    holder.emit('\x1b[?1049h\x1b[Hfull screen app')
    const p = await manager.adopt(PTY)
    await waitParsed(p)
    const resizes = () => holder.received.filter((f) => f.t === 'resize') as { rows: number }[]
    await holder.until(() => resizes().length === 1)
    expect(resizes()[0]!.rows).toBe(23)
    clock.advance(L.repaintNudgeMs - 1)
    expect(resizes()).toHaveLength(1)
    clock.advance(1)
    await holder.until(() => resizes().length === 2)
    expect(resizes()[1]!.rows).toBe(24)
    expect(p.stats.nudges).toBe(1)
  })

  it('U-PTY-21 · an exception from inside xterm rebuilds only the mirrors with unparsed writes; replies resume without repeats', async () => {
    const ids = ['aaaaaaaaaa', 'bbbbbbbbbb']
    const { holders, manager, emit } = await setup({ ids })
    const [a, b] = [await manager.adopt(ids[0]!), await manager.adopt(ids[1]!)]
    await emit('\x1b[c', holders[0]!)
    await holders[0]!.until(() => holders[0]!.inputs() === '\x1b[?1;2c')
    vi.spyOn(Pty.prototype, 'pendingWrites', 'get').mockImplementation(function (this: Pty) {
      return this.ptyId === ids[0] ? 1 : 0
    })
    expect(manager.recoverFromException(new Error('boom'))).toBe(1)
    vi.restoreAllMocks()
    expect(a.stats.rebuilds).toBe(1)
    expect(b.stats.rebuilds).toBe(0)
    await waitParsed(a)
    expect(a.screenText()).not.toBeNull()
    await emit('\x1b[c', holders[0]!)
    await holders[0]!.until(() => holders[0]!.inputs().length > '\x1b[?1;2c'.length)
    expect(holders[0]!.inputs()).toBe('\x1b[?1;2c'.repeat(2)) // the old query was not answered again
    expect(manager.recoverFromException(new Error('not a mirror'))).toBe(0)
  })

  it('U-PTY-21 · a mirror whose write callback stops firing is rebuilt at the next health check', async () => {
    const { clock, manager, emit } = await setup()
    const p = await manager.adopt(PTY)
    await emit('x\r\n')
    const stalled = vi.spyOn(Mirror.prototype, 'stalled').mockReturnValueOnce(true)
    clock.advance(L.mirrorStallMs)
    expect(stalled).toHaveBeenCalled()
    expect(p.stats.rebuilds).toBe(1)
    await waitParsed(p)
    expect(p.screenText()).toContain('x')
  })

  it('U-PTY-22 · the last screen of an exited PTY comes from its checkpoint and ring, without keeping a mirror', async () => {
    const { holder, clock, manager, home } = await setup()
    holder.emit('first\r\n')
    const p = await manager.adopt(PTY)
    await waitParsed(p)
    holder.exit(0)
    await vi.waitFor(() => expect(p.info().state).toBe('exited'))
    clock.advance(0)
    expect(p.isParked).toBe(true)
    const s = await call(manager, 'pty.lastScreen', { ptyId: PTY, sessionId: 's1', cols: 80, rows: 24 })
    expect(s).toMatchObject({ seq: holder.latestSeq, cols: 80, rows: 24 })
    expect(s!.data).toContain('first')
    expect(p.isParked).toBe(true)
    // no checkpoint: the ring alone; neither: nothing
    fs.rmSync(checkpointPath(path.join(home, 'sessions', 's1'), PTY))
    expect((await call(manager, 'pty.lastScreen', { ptyId: PTY, sessionId: 's1', cols: 80, rows: 24 }))!.data).toContain('first')
    expect(await call(manager, 'pty.lastScreen', { ptyId: 'zzzzzzzzzz', sessionId: 's1', cols: 80, rows: 24 })).toBeNull()
  })

  it('U-PTY-59 · an ended PTY let go: its last screen becomes its checkpoint at the ring’s end, so its ring can go and the last screen still shows; a PTY still held is never folded', async () => {
    const { holder, clock, manager, stateDir, ckpt } = await setup()
    holder.emit('first\r\n')
    const p = await manager.adopt(PTY)
    await waitParsed(p)
    expect(await call(manager, 'pty.foldCheckpoint', { ptyId: PTY, sessionId: 's1' }), 'held: its own checkpoints follow it').toEqual({ written: false })
    holder.exit(0)
    await vi.waitFor(() => expect(p.info().state).toBe('exited'))
    clock.advance(0)
    expect(await call(manager, 'pty.release', { ptyId: PTY })).toEqual({ ok: true })
    holder.dropClient() // a released holder exits
    await vi.waitFor(() => expect(manager.list().map((i) => i.ptyId)).toEqual([]))
    // a checkpoint older than the ring's end (here: none at all) is replaced by one at its end
    fs.rmSync(checkpointPath(stateDir, PTY), { force: true })
    expect(await call(manager, 'pty.foldCheckpoint', { ptyId: PTY, sessionId: 's1' })).toEqual({ written: true })
    expect(ckpt()).toMatchObject({ seq: holder.latestSeq })
    const folded = ckpt()
    fs.rmSync(holder.ringPath)
    const s = await call(manager, 'pty.lastScreen', { ptyId: PTY, sessionId: 's1', cols: 80, rows: 24 })
    expect(s!.data, 'the last screen from the checkpoint alone').toContain('first')
    // again: nothing to change
    expect(await call(manager, 'pty.foldCheckpoint', { ptyId: PTY, sessionId: 's1' })).toEqual({ written: true })
    expect(ckpt()).toEqual(folded)
    // nothing kept at all: nothing to fold
    fs.rmSync(checkpointPath(stateDir, PTY))
    expect(await call(manager, 'pty.foldCheckpoint', { ptyId: PTY, sessionId: 's1' })).toEqual({ written: false })
  })

  it('U-PTY-65 · an ended PTY released while its exit checkpoint still waits on the rate rules (a keystroke just before) has it written before the release returns, and nothing after: core may remove its files next (an archived session’s shell)', async () => {
    const { holder, clock, manager, stateDir, emit, ckpt } = await setup()
    const p = await manager.adopt(PTY)
    await emit('last words\r\n')
    p.input('k') // no serialisation for L.checkpointQuietMs
    holder.exit(0)
    await vi.waitFor(() => expect(p.info().state).toBe('exited'))
    clock.advance(0)
    expect(ckpt(), 'the exit checkpoint waits for the quiet period').toBeNull()
    expect(await call(manager, 'pty.release', { ptyId: PTY })).toEqual({ ok: true })
    expect(ckpt()?.data, 'written before the release returns').toContain('last words')
    // core removes its files (archive), then the released holder exits and the rate rules would allow it
    fs.rmSync(checkpointPath(stateDir, PTY))
    holder.dropClient()
    await vi.waitFor(() => expect(manager.list().map((i) => i.ptyId)).toEqual([]))
    clock.advance(L.checkpointQuietMs + L.checkpointMinIntervalMs)
    expect(fs.existsSync(checkpointPath(stateDir, PTY)), 'nothing written once released').toBe(false)
  })
})

describe('adoption trust', () => {
  it('U-PTY-28 · a holder whose state file disagrees with where it lives, is claimed by two sessions, or whose HELLO names another PTY is refused and left alone', async () => {
    const cases: { name: string; json?: Record<string, unknown>; hello?: string; twin?: boolean; connects: boolean }[] = [
      { name: 'ptyId', json: { ptyId: 'zzzzzzzzzz' }, connects: false },
      { name: 'sessionId', json: { sessionId: 's2' }, connects: false },
      { name: 'socket', json: { socket: '/tmp/elsewhere.sock' }, connects: false },
      { name: 'two state files', twin: true, connects: false },
      { name: 'HELLO', hello: 'zzzzzzzzzz', connects: true },
    ]
    for (const c of cases) {
      const home = tempHome()
      cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
      const dir = path.join(home, 'sessions', 's1')
      const holder = await FakeHolder.start({ dir, sockDir: runDir(home), ptyId: PTY, ...(c.json ? { json: c.json } : {}) })
      cleanups.push(() => holder.close())
      holder.emit('alive\r\n')
      if (c.hello) holder.helloPtyId = c.hello
      if (c.twin) {
        fs.mkdirSync(path.join(home, 'sessions', 's2'))
        fs.copyFileSync(path.join(dir, `${PTY}.json`), path.join(home, 'sessions', 's2', `${PTY}.json`))
      }
      const log = createMemoryLogger()
      const manager = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: 'test', dev: true, client: { option: '--client-req', value: 'test' } }, { log, notify: () => {} })
      cleanups.push(() => manager.dispose())
      await expect(manager.adopt(PTY), c.name).rejects.toThrow(/refused/)
      expect(await manager.adoptAll(), c.name).toEqual({ adopted: [], failed: [PTY] })
      expect(manager.get(PTY), c.name).toBeUndefined()
      // left alone: never attached, signalled, terminated or released; its socket stays
      if (c.connects) await holder.until(() => holder.connections === 2)
      expect(holder.connections, c.name).toBe(c.connects ? 2 : 0)
      expect(holder.received.map((f) => f.t).filter((t) => t !== 'hello'), c.name).toEqual([])
      expect(fs.existsSync(holder.sock), c.name).toBe(true)
    }
  })

  it('U-PTY-29 · pty.detach lets go of a holder without releasing or signalling it; it can be adopted again', async () => {
    const { holder, manager, notes, emit } = await setup()
    const p = await manager.adopt(PTY)
    await emit('before\r\n')
    const r = renderer()
    manager.attachStream(PTY, r.port)
    await vi.waitFor(() => expect(r.msgs[0]?.k).toBe('snapshot'))
    expect(call(manager, 'pty.detach', { ptyId: PTY })).toEqual({ ok: true })
    expect(p.isDisposed).toBe(true)
    expect(manager.get(PTY)).toBeUndefined()
    await vi.waitFor(() => expect(r.msgs.at(-1)).toEqual({ k: 'gone', reason: 'detached' }))
    await holder.until(() => !holder.connected)
    expect(holder.received.map((f) => f.t).filter((t) => !['hello', 'attach', 'ack', 'resize'].includes(t))).toEqual([])
    expect(notes.filter((n) => n.m === 'pty.exit')).toEqual([])
    expect(call(manager, 'pty.detach', { ptyId: PTY })).toEqual({ ok: false })
    const again = await manager.adopt(PTY)
    again.ensureAwake() // parked on the checkpoint detach wrote
    await vi.waitFor(() => expect(again.screenText()).toContain('before'))
  })

  it('C-COR-8 · a stale socket with no state file is removed once a connect to it is refused; one that accepts is never removed', async () => {
    const home = tempHome()
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
    const run = runDir(home)
    fs.mkdirSync(run, { recursive: true, mode: 0o700 })
    // stale: a socket file nothing listens on (bound, renamed into place, then the server closed)
    const stale = path.join(run, 'aaaaaaaaaa.sock')
    const server = net.createServer()
    const tmp = path.join(run, 'x.sock')
    await new Promise<void>((r) => server.listen(tmp, () => r()))
    fs.renameSync(tmp, stale)
    await new Promise<void>((r) => server.close(() => r()))
    expect(fs.lstatSync(stale).isSocket()).toBe(true)
    // live: a holder that accepts, whose state file was removed
    const live = await FakeHolder.start({ dir: path.join(home, 'sessions', 's1'), sockDir: run, ptyId: 'bbbbbbbbbb' })
    cleanups.push(() => live.close())
    fs.rmSync(path.join(home, 'sessions', 's1', 'bbbbbbbbbb.json'))
    const log = createMemoryLogger()
    const manager = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: 'test', dev: true, client: { option: '--client-req', value: 'test' } }, { log, notify: () => {} })
    cleanups.push(() => manager.dispose())
    const r = await manager.adoptAll()
    expect(r.adopted).toEqual([])
    expect(r.failed.sort()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
    expect(fs.existsSync(stale)).toBe(false)
    expect(log.entries.map((e) => e.msg)).toContain('stale holder socket removed')
    expect(fs.lstatSync(live.sock).isSocket()).toBe(true)
    expect(live.received.map((f) => f.t).filter((t) => t !== 'hello')).toEqual([])
  })
})
