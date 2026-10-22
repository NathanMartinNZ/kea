import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import headless from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger, runDir, systemClock } from '@kea/kit'
import { channelPair, encodeHolderFrame, L, type Channel, type PtyhostNote, type StreamToRenderer } from '@kea/protocol'
import { colorThemeOf, createTerminalOptions } from '@kea/terminal'
import { CheckpointScheduler } from './checkpoint/scheduler.ts'
import { MemoryCheckpoints } from './checkpoint/store.ts'
import { HolderConnection } from './holder/connection.ts'
import { PtyManager } from './manager.ts'
import { Mirror } from './mirror/mirror.ts'
import { Pty } from './pty.ts'
import { Attachment } from './stream/attachment.ts'
import { FakeHolder, ManualClock, tempHome } from './test-support.ts'

const PTY = 'abcdefghij'
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  vi.restoreAllMocks()
})

async function setup(o: { capacity?: number } = {}) {
  const home = tempHome()
  const holder = await FakeHolder.start({ dir: path.join(home, 'sessions', 's1'), sockDir: runDir(home), ptyId: PTY, ...(o.capacity ? { capacity: o.capacity } : {}) })
  const notes: PtyhostNote[] = []
  const log = createMemoryLogger()
  const manager = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: 'test', dev: true, client: { option: '--client-req', value: 'test' } }, { log, notify: (n) => notes.push(n) })
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }), () => holder.close(), () => manager.dispose())
  return { home, holder, manager, notes, log }
}

/** A renderer stream end: collects messages, writes them into a headless terminal, and returns credit if asked. */
function renderer(ch: Channel, o: { credit: boolean } = { credit: true }) {
  let credit = o.credit
  const term = new headless.Terminal(createTerminalOptions({ side: 'renderer', cols: 80, rows: 24, scrollback: 1000 }))
  const msgs: StreamToRenderer[] = []
  let owed = 0
  let seq = -1
  const r = {
    term,
    msgs,
    get seq() {
      return seq
    },
    payOwed() {
      if (owed) ch.send({ k: 'credit', n: owed })
      owed = 0
    },
    stopCredit() {
      credit = false
    },
    /** From now on, return credit as each message is written (and pay what is owed now). */
    keepUp() {
      credit = true
      r.payOwed()
    },
    text: () => {
      const b = term.buffer.active
      const out: string[] = []
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
      return out.join('\n').trimEnd()
    },
  }
  ch.onMessage((raw) => {
    const m = raw as StreamToRenderer
    msgs.push(m)
    if (m.k === 'snapshot') {
      term.reset()
      term.resize(m.cols, m.rows)
      term.write(m.data)
      seq = m.seq
      owed += m.data.length
    } else if (m.k === 'data') {
      expect(m.seq).toBe(seq) // contiguous
      term.write(m.b)
      seq += m.b.byteLength
      owed += m.b.byteLength
    }
    if (credit) r.payOwed()
  })
  cleanups.push(() => term.dispose())
  return r
}

/** Resolves once the renderer terminal has parsed everything written so far. */
const parsedAll = (term: headless.Terminal) => new Promise<void>((r) => term.write('', r))

describe('ptyhost PTY data path', () => {
  it('U-PTY-9 · attach: a snapshot first, then live chunks; the renderer ends up showing what the mirror shows', async () => {
    const { holder, manager } = await setup()
    holder.emit('first line\r\n\x1b[1mbold\x1b[0m\r\n')
    const p = await manager.adopt(PTY)
    await holder.until(() => holder.acks().at(-1) === holder.latestSeq)
    const [mine, theirs] = channelPair()
    const r = renderer(theirs)
    manager.attachStream(PTY, mine)
    await vi.waitFor(() => expect(r.msgs[0]?.k).toBe('snapshot'))
    holder.emit('live output\r\n')
    await vi.waitFor(() => expect(r.seq).toBe(holder.latestSeq))
    await parsedAll(r.term)
    expect(r.text()).toContain('first line')
    expect(r.text()).toContain('bold')
    expect(r.text()).toContain('live output')
    expect(r.msgs.filter((m) => m.k === 'snapshot')).toHaveLength(1)
    expect(p.attachedCount).toBe(1)
  })

  it('U-PTY-10 · forward first, parse second; the holder is acked only from mirror write callbacks, up to what was parsed', async () => {
    const { holder, manager } = await setup()
    const order: string[] = []
    const live = Attachment.prototype.live
    const write = Mirror.prototype.write
    vi.spyOn(Attachment.prototype, 'live').mockImplementation(function (this: Attachment, seq, data) {
      order.push(`live ${seq}`)
      return live.call(this, seq, data)
    })
    vi.spyOn(Mirror.prototype, 'write').mockImplementation(function (this: Mirror, seq, data) {
      order.push(`write ${seq}`)
      return write.call(this, seq, data)
    })
    const p = await manager.adopt(PTY)
    const [mine, theirs] = channelPair()
    const r = renderer(theirs)
    manager.attachStream(PTY, mine)
    await vi.waitFor(() => expect(r.msgs[0]?.k).toBe('snapshot'))
    for (let i = 0; i < 50; i++) holder.emit(`line ${i}\r\n`.repeat(20))
    await holder.until(() => holder.acks().at(-1) === holder.latestSeq)
    await vi.waitFor(() => expect(r.seq).toBe(holder.latestSeq))
    // every batch went to the renderer before the mirror
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toMatch(/^live /)
      expect(order[i + 1]).toBe(order[i]!.replace('live', 'write'))
    }
    const acks = holder.acks()
    expect(acks).toEqual([...acks].sort((a, b) => a - b))
    expect(Math.max(...acks)).toBe(holder.latestSeq)
    expect(p.info().state).toBe('running')
  })

  it('U-PTY-11 · queries in replayed history are never answered; new queries are answered exactly once', async () => {
    const { holder, manager } = await setup()
    holder.emit('old\r\n\x1b[c\x1b[6n\x1b]11;?\x07')
    await manager.adopt(PTY)
    await holder.until(() => holder.acks().at(-1) === holder.latestSeq)
    expect(holder.inputs()).toBe('')
    holder.emit('\x1b[c')
    await holder.until(() => holder.inputs().length > 0)
    expect(holder.inputs()).toBe('\x1b[?1;2c')
  })

  it('U-PTY-11 · a freshly spawned PTY answers the queries it printed before ptyhost attached', async () => {
    const { holder, log } = await setup()
    holder.emit('\x1b[c')
    // spawn's attach path, without launching a helper
    const { conn, hello } = await HolderConnection.open(holder.sock)
    const meta = { ptyId: PTY, sessionId: 's1', kind: 'shell' as const, stateDir: path.dirname(holder.ringPath), sock: holder.sock, cwd: '/', argv: [], holderPid: null, holderStartedAt: null, detached: true }
    const store = new MemoryCheckpoints()
    const scheduler = new CheckpointScheduler(systemClock)
    cleanups.push(() => scheduler.dispose())
    const deps = { clock: systemClock, log, notify: () => {}, colors: () => colorThemeOf('kea-dark'), scrollback: () => 100, checkpoints: () => store, scheduler, removed: () => {} }
    const p = new Pty(meta, conn, hello, deps, { mode: 'live', fromSeq: 0 })
    cleanups.push(() => p.dispose())
    await holder.until(() => holder.inputs() === '\x1b[?1;2c')
  })

  it('U-PTY-2 · a renderer without credit is caught up from the ring; far behind, it gets one snapshot instead', async () => {
    const { holder, manager } = await setup({ capacity: 4 * 1024 * 1024 })
    await manager.adopt(PTY)
    const [mine, theirs] = channelPair()
    const r = renderer(theirs, { credit: false })
    manager.attachStream(PTY, mine)
    await vi.waitFor(() => expect(r.msgs[0]?.k).toBe('snapshot'))
    r.payOwed()
    // a moderate burst: more than the window, less than the skip-ahead threshold
    const line = 'x'.repeat(78) + '\r\n'
    const burst = line.repeat(Math.ceil((L.streamCreditBytes * 2) / line.length))
    holder.emit(burst)
    await holder.until(() => holder.acks().at(-1) === holder.latestSeq, 5000)
    const before = r.seq
    expect(before).toBeLessThan(holder.latestSeq) // stopped at the window
    r.keepUp()
    await vi.waitFor(() => expect(r.seq).toBe(holder.latestSeq)) // caught up, contiguous (asserted in renderer())
    expect(r.msgs.filter((m) => m.k === 'snapshot')).toHaveLength(1)
    r.stopCredit()
    // now fall more than the skip-ahead threshold behind
    holder.emit(line.repeat(Math.ceil((L.streamSkipAheadBytes * 1.5) / line.length)))
    await holder.until(() => holder.acks().at(-1) === holder.latestSeq, 10_000)
    r.payOwed()
    await vi.waitFor(() => expect(r.msgs.filter((m) => m.k === 'snapshot')).toHaveLength(2))
    r.keepUp()
    await vi.waitFor(() => expect(r.seq).toBe(holder.latestSeq))
  })

  it('U-PTY-12 · renderer input reaches the holder; resizes are debounced and clamped', async () => {
    const { holder, manager } = await setup()
    await manager.adopt(PTY)
    const [mine, theirs] = channelPair()
    renderer(theirs)
    manager.attachStream(PTY, mine)
    theirs.send({ k: 'in', d: 'echo hi\r' })
    await holder.until(() => holder.inputs() === 'echo hi\r')
    for (let c = 100; c < 120; c++) theirs.send({ k: 'resize', cols: c, rows: 30, xpx: c * 8, ypx: 600 })
    theirs.send({ k: 'resize', cols: 3, rows: 1, xpx: 0, ypx: 0 })
    // the burst ends with the clamped size; wait for it to arrive rather than for the debounce to pass
    const resizes = () => holder.received.filter((f) => f.t === 'resize') as { cols: number; rows: number }[]
    await holder.until(() => resizes().at(-1)?.cols === L.ptyMinCols && resizes().at(-1)?.rows === L.ptyMinRows)
    expect(resizes().length).toBeLessThanOrEqual(3)
  })

  it('U-PTY-27 · a resize storm reaches the holder at most once per debounce period, ending at the last size', async () => {
    const home = tempHome()
    const holder = await FakeHolder.start({ dir: path.join(home, 'sessions', 's1'), sockDir: runDir(home), ptyId: PTY })
    const clock = new ManualClock()
    const manager = new PtyManager({ home, helperSource: '/nonexistent', keaVersion: 'test', dev: true, client: { option: '--client-req', value: 'test' } }, { log: createMemoryLogger(), notify: () => {}, clock })
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }), () => holder.close(), () => manager.dispose())
    const p = await manager.adopt(PTY)
    const STORM = 100
    const STORM_MS = 1000
    for (let i = 0; i < STORM; i++) {
      p.resize(60 + (i % 40), 20 + (i % 10))
      clock.advance(STORM_MS / STORM)
    }
    clock.advance(L.resizeDebounceMs)
    const resizes = () => holder.received.filter((f) => f.t === 'resize') as { cols: number; rows: number }[]
    await holder.until(() => resizes().at(-1)?.cols === 60 + ((STORM - 1) % 40) && resizes().at(-1)?.rows === 20 + ((STORM - 1) % 10))
    expect(resizes().length).toBeLessThanOrEqual(1 + Math.ceil(STORM_MS / L.resizeDebounceMs))
  })

  it('U-PTY-13 · exit reaches the renderer and core; a vanished holder is reported lost', async () => {
    const { holder, manager, notes } = await setup()
    await manager.adopt(PTY)
    const [mine, theirs] = channelPair()
    const r = renderer(theirs)
    manager.attachStream(PTY, mine)
    holder.emit('bye\r\n')
    holder.exit(3)
    await vi.waitFor(() => expect(r.msgs.some((m) => m.k === 'exit')).toBe(true))
    expect(r.msgs.find((m) => m.k === 'exit')).toEqual({ k: 'exit', code: 3, signal: null })
    expect(notes).toContainEqual({ m: 'pty.exit', a: { ptyId: PTY, sessionId: 's1', code: 3, signal: null, lost: false } })
    expect(manager.get(PTY)!.release()).toBe(true)
    expect(manager.list()[0]).toMatchObject({ state: 'exited', exitCode: 3 })
  })

  it('U-PTY-13 · the holder connection closing without an exit, its holder process gone, marks the PTY lost and removes it', async () => {
    const { home, holder, manager, notes, log } = await setup()
    // the state file names a pid that no longer runs: the holder crashed
    const json = path.join(home, 'sessions', 's1', `${PTY}.json`)
    const dead = spawnSync('/usr/bin/true').pid // os-ok: in /usr/bin on both systems
    fs.writeFileSync(json, JSON.stringify({ ...JSON.parse(fs.readFileSync(json, 'utf8')), pid: dead }))
    await manager.adopt(PTY)
    const [mine, theirs] = channelPair()
    const r = renderer(theirs)
    manager.attachStream(PTY, mine)
    holder.dropClient()
    await vi.waitFor(() => expect(notes.some((n) => n.m === 'pty.exit' && n.a.lost)).toBe(true))
    await vi.waitFor(() => expect(r.msgs.at(-1)).toEqual({ k: 'gone', reason: 'lost' }))
    expect(manager.get(PTY)).toBeUndefined()
    expect(log.entries.find((e) => e.msg === 'holder connection lost')).toMatchObject({ reason: expect.stringContaining(`holder process ${dead} is gone`) })
    expect(holder.connections, 'no reconnect to a holder whose process is gone').toBe(1)
  })

  it('U-PTY-51 · a connection the holder closes while it still runs is re-adopted: no exit is reported, the stream continues byte-exact and keys typed meanwhile arrive; closing again within L.holderReadoptIntervalMs is a loss', async () => {
    const { holder, manager, notes, log } = await setup()
    const p = await manager.adopt(PTY)
    const [mine, theirs] = channelPair()
    const r = renderer(theirs)
    manager.attachStream(PTY, mine)
    holder.emit('one\r\n')
    await vi.waitFor(() => expect(r.seq).toBe(holder.latestSeq))
    // keys typed while ptyhost is away from the holder wait for it (the re-adoption is still connecting here)
    const m = manager as unknown as { readopt(p: Pty): Promise<unknown> }
    const readopt = m.readopt.bind(manager)
    vi.spyOn(m, 'readopt').mockImplementation((q) => {
      q.input('typed while away\r')
      return readopt(q)
    })
    // another client the holder admits replaces ptyhost's connection; output goes on into the ring meanwhile
    const { conn: intruder } = await HolderConnection.open(holder.sock)
    cleanups.push(() => intruder.destroy())
    holder.emit('two\r\n')
    await vi.waitFor(() => expect(p.stats.readopts).toBe(1))
    holder.emit('three\r\n')
    await vi.waitFor(() => expect(r.seq).toBe(holder.latestSeq))
    await vi.waitFor(() => expect(holder.inputs()).toBe('typed while away\r'))
    await parsedAll(r.term)
    expect(r.text().split('\n')).toEqual(['one', 'two', 'three'])
    expect(notes.filter((n) => n.m === 'pty.exit'), 'no exit, lost or not').toEqual([])
    expect(r.msgs.filter((m) => m.k === 'gone' || m.k === 'snapshot').map((m) => m.k), 'one snapshot (the attach), never gone').toEqual(['snapshot'])
    expect(manager.get(PTY)).toBe(p)
    expect(intruder.isClosed, 'the re-adoption replaced the intruder in turn').toBe(true)
    expect(log.entries.map((e) => e.msg)).toContain('holder re-adopted')
    // closed again at once: a holder that keeps dropping ptyhost is reported lost
    holder.dropClient()
    await vi.waitFor(() => expect(notes).toContainEqual({ m: 'pty.exit', a: { ptyId: PTY, sessionId: 's1', code: null, signal: null, lost: true } }))
    await vi.waitFor(() => expect(r.msgs.at(-1)).toEqual({ k: 'gone', reason: 'lost' }))
    expect(manager.get(PTY)).toBeUndefined()
    expect(p.stats.readopts).toBe(1)
  })

  it('U-PTY-52 · what waits while a holder is re-adopted is bounded: input up to the holder input cap, each signal once, one TERMINATE with the shortest grace, no resize or STAT; it is sent in order once the holder answers', async () => {
    const { holder, manager } = await setup()
    const p = await manager.adopt(PTY)
    // hold the re-adoption open until the calls below are made
    let go!: () => void
    const gate = new Promise<void>((res) => (go = res))
    const m = manager as unknown as { readopt(p: Pty): Promise<unknown> }
    const readopt = m.readopt.bind(manager)
    let away = false
    vi.spyOn(m, 'readopt').mockImplementation(async (q) => {
      away = true
      await gate
      return readopt(q)
    })
    const { conn: intruder } = await HolderConnection.open(holder.sock)
    cleanups.push(() => intruder.destroy())
    await vi.waitFor(() => expect(away).toBe(true))

    p.input('a')
    p.input('')
    p.input(new Uint8Array(L.holderInputCapBytes)) // past the cap with what waits already: dropped, as a full queue drops it
    for (const signo of [2, 2, 15, 2]) p.signal(signo, 'fg')
    for (const graceMs of [5000, 1000, 3000]) p.terminate(graceMs)
    p.resize(100, 30)
    let answer: unknown = 'pending'
    void p.stat().then((v) => (answer = v))
    await Promise.resolve()
    expect(answer, 'a STAT is answered at once, with nothing').toBeNull()

    const reattach = holder.received.length
    go()
    await vi.waitFor(() => expect(p.stats.readopts).toBe(1))
    await vi.waitFor(() => expect(holder.received.slice(reattach).some((f) => f.t === 'terminate')).toBe(true))
    const after = holder.received.slice(reattach).filter((f) => f.t !== 'ack' && f.t !== 'hello' && f.t !== 'attach')
    expect(after).toEqual([
      { t: 'resize', cols: 100, rows: 30, xpx: 0, ypx: 0 }, // the latest size, once
      { t: 'input', data: Buffer.from('a') },
      { t: 'signal', signo: 2, target: 'fg' },
      { t: 'signal', signo: 15, target: 'fg' },
      { t: 'terminate', graceMs: 1000 },
    ])
  })

  it('U-PTY-14 · a stream for an unknown terminal is told it is gone and closed', async () => {
    const { manager } = await setup()
    const [mine, theirs] = channelPair()
    let closed = false
    theirs.onClose(() => (closed = true))
    manager.attachStream('zzzzzzzzzz', mine)
    await vi.waitFor(() => expect(closed).toBe(true))
  })
})

describe('holder output gaps', () => {
  it('U-HLD-2 · an OUTPUT ahead of the expected seq triggers exactly one rebuild, and the renderer gets one fresh snapshot', async () => {
    const { holder, manager, log } = await setup()
    holder.emit('one\r\n')
    const p = await manager.adopt(PTY)
    await holder.until(() => holder.acks().at(-1) === holder.latestSeq)
    const [mine, theirs] = channelPair()
    const r = renderer(theirs)
    manager.attachStream(PTY, mine)
    await vi.waitFor(() => expect(r.seq).toBe(holder.latestSeq))
    const wakes = p.stats.wakes
    holder.skip('two\r\n')
    holder.emit('three\r\n')
    holder.emit('four\r\n')
    await holder.until(() => holder.acks().at(-1) === holder.latestSeq)
    await vi.waitFor(() => expect(r.seq).toBe(holder.latestSeq))
    expect(p.stats.gaps).toBe(1)
    expect(p.stats.wakes - wakes).toBe(1)
    expect(r.msgs.filter((m) => m.k === 'snapshot')).toHaveLength(2)
    await parsedAll(r.term)
    expect(log.entries.map((e) => e.msg)).not.toContain('mirror restarted without history')
    // the rebuild read the skipped bytes back from the ring
    expect(r.text().split('\n')).toEqual(['one', 'two', 'three', 'four'])
  })

  it('U-HLD-2 · an OUTPUT behind the expected seq is a protocol error: the connection closes once, nothing is delivered', async () => {
    const { holder } = await setup()
    holder.emit('abcdef')
    const { conn } = await HolderConnection.open(holder.sock)
    const got: number[] = []
    const gaps: [number, number][] = []
    const closes: string[] = []
    conn.attach('fromSeq', 0, { gap: (e, g) => gaps.push([e, g]), output: (seq) => got.push(seq), exit: () => {}, error: () => {}, close: (why) => closes.push(why) })
    await vi.waitFor(() => expect(got).toEqual([0]))
    holder.sendRaw(encodeHolderFrame({ t: 'output', seq: 3, data: new TextEncoder().encode('def') }))
    await vi.waitFor(() => expect(closes).toHaveLength(1))
    expect(closes[0]).toMatch(/protocol error: OUTPUT at 3, expected 6/)
    expect(got).toEqual([0])
    expect(gaps).toEqual([])
    conn.destroy()
    expect(closes).toHaveLength(1)
  })
})
