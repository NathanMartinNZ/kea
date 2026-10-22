// The output path from a real holder to renderers: forward first, parse second, ack after parse; a renderer that falls
// behind gets a snapshot, not a backlog; resizes are debounced.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { L, type StreamToRenderer } from '@kea/protocol'
import { HolderConnection } from '../../app/ptyhost/src/holder/connection.ts'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { ptyhostHarness, rawTty, until, type Harness } from '../support/holders.ts'
import { childArgv, talkLines } from './ptyhost-child.ts'
import { mirrorTerminal, parsedSeq, SIG, terminalState, TestRenderer } from './ptyhost-support.ts'

let h: Harness | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.dispose()
  h = null
})

const READY = 'ready\r\n'

/** A `talk` child that prints `lines` lines of `width` per SIGUSR2, once it is ready. */
async function talker(lines: number, width: number, o: { cols?: number; rows?: number } = {}) {
  h ??= await ptyhostHarness()
  const pty = await h.spawn({ argv: rawTty(childArgv('talk', ['--print', 'ready\\r\\n', '--lines', String(lines), '--width', String(width)])), ...o })
  await until('the child to be ready', () => parsedSeq(pty) === READY.length)
  return pty
}

describe('stream path', () => {
  it('I-PTY-13 · under load, each chunk reaches the renderer port before the mirror\'s write callback for it fires; acks come only from those callbacks', async () => {
    const lines = 50_000
    const width = 80
    const pty = await talker(lines, width)
    const total = READY.length + talkLines(0, lines, width).length
    type Ev = { k: 'send'; end: number } | { k: 'ack'; seq: number; fromMirror: boolean; parsed: number }
    const log: Ev[] = []
    const r = new TestRenderer(h!.manager, pty.ptyId, {
      credit: 'instant',
      onPtyhostSend: (m: StreamToRenderer) => {
        if (m.k === 'data') log.push({ k: 'send', end: m.seq + m.b.byteLength })
      },
    })
    await until('the snapshot', () => r.writtenSeq >= READY.length)
    const ack = HolderConnection.prototype.ack
    const depth = Error.stackTraceLimit
    Error.stackTraceLimit = 50
    vi.spyOn(HolderConnection.prototype, 'ack').mockImplementation(function (this: HolderConnection, seq: number) {
      log.push({ k: 'ack', seq, fromMirror: /app\/ptyhost\/src\/mirror\/mirror\.ts/.test(new Error().stack ?? ''), parsed: parsedSeq(pty) })
      ack.call(this, seq)
    })
    try {
      pty.signal(SIG.SIGUSR2, 'child')
      await until('the flood to be parsed', () => parsedSeq(pty) === total)
      await r.untilWritten(total)
    } finally {
      Error.stackTraceLimit = depth
    }
    const acks = log.filter((e): e is Extract<Ev, { k: 'ack' }> => e.k === 'ack')
    const sends = log.filter((e) => e.k === 'send')
    expect(sends.length).toBeGreaterThan(10) // it was under load: many batches
    expect(acks.length).toBeGreaterThan(10)
    expect(acks.filter((a) => !a.fromMirror)).toEqual([])
    expect(acks.filter((a) => a.seq !== a.parsed)).toEqual([]) // acked exactly what was parsed
    // every byte the mirror had parsed when it acked had been sent to the renderer before
    let sentTo = READY.length
    for (const e of log) {
      if (e.k === 'send') sentTo = Math.max(sentTo, e.end)
      else expect(e.seq, 'an ack for bytes the renderer had not been sent').toBeLessThanOrEqual(sentTo)
    }
    expect(r.discontinuities).toEqual([])
    expect(r.snapshots).toBe(1)
    expect(terminalState(r.term)).toEqual(terminalState(mirrorTerminal(pty)))
    r.close()
  })

  it('I-PTY-9 · a renderer that stops returning credit during a flood is sent at most its window, then one snapshot instead of the backlog', async () => {
    const lines = 40_000
    const width = 80
    const pty = await talker(lines, width)
    const flood = talkLines(0, lines, width).length
    expect(flood).toBeGreaterThan(L.streamSkipAheadBytes + L.streamCreditBytes)
    const total = READY.length + flood
    const r = new TestRenderer(h!.manager, pty.ptyId, { credit: 'manual' })
    await until('the snapshot', () => r.writtenSeq >= READY.length)
    r.giveCredit()
    const before = r.messages.length
    pty.signal(SIG.SIGUSR2, 'child')
    await until('the flood to be parsed', () => parsedSeq(pty) === total)
    // nothing returned: ptyhost sent at most the window, exactly. An empty window admits one batch of any size
    // (so a batch larger than the window cannot wedge a stream), but a batch is never larger than the window
    expect(L.coalesceMaxBytes, 'a batch fits the window').toBeLessThanOrEqual(L.streamCreditBytes)
    const sent = r.messages.slice(before).filter((m) => m.k === 'data').reduce((n, m) => n + (m as { b: Uint8Array }).b.byteLength, 0)
    expect(sent).toBeGreaterThan(0)
    expect(sent, 'data sent with no credit returned').toBeLessThanOrEqual(L.streamCreditBytes)
    const a = [...(pty as unknown as { attachments: Set<{ flow: { outstandingBytes: number; isBehind: boolean } }> }).attachments][0]!
    expect(a.flow.isBehind).toBe(true)
    expect(a.flow.outstandingBytes, 'outstanding: the window at most, nothing buffered beyond it').toBeLessThanOrEqual(L.streamCreditBytes)
    // credit comes back far behind: one snapshot, then live again
    const snapshotsBefore = r.snapshots
    await r.untilWritten(READY.length + sent)
    r.giveCredit()
    await until('the skip-ahead snapshot', () => r.snapshots === snapshotsBefore + 1)
    await until('the renderer to catch up', () => (r.giveCredit(), r.writtenSeq === total))
    expect(r.messages.slice(before).filter((m) => m.k === 'snapshot')).toHaveLength(1)
    expect(r.discontinuities).toEqual([])
    expect(terminalState(r.term)).toEqual(terminalState(mirrorTerminal(pty)))
    r.close()
  })

  it('I-PTY-10 · spawned at 137×41, one resize alone, then 100 resizes in 1 s: the child sees the lone size, and the PTY ends at the last size, with no more TIOCSWINSZ than the debounce allows', async () => {
    const clock = new ManualClock()
    h = await ptyhostHarness({ clock })
    const sizes = path.join(h.home, 'sizes.txt')
    const pty = await h.spawn({ argv: rawTty(childArgv('sizes', [sizes])), cols: 137, rows: 41 })
    // the file exists before the child's write lands in it: wait for a whole line
    const written = () => (fs.existsSync(sizes) ? fs.readFileSync(sizes, 'utf8') : '')
    await until('the child\'s first size', () => written().endsWith('\n'))
    expect(written()).toBe('137x41\n')
    // one resize on its own reaches the child as the new size (its SIGWINCH handler reads the size the tty has now,
    // not the one before: under load the storm's TIOCSWINSZ come this far apart too)
    pty.resize(120, 30)
    clock.advance(L.resizeDebounceMs)
    await until('the child to note the single resize', () => written().split('\n').length === 3)
    expect(written()).toBe('137x41\n120x30\n')
    const resizes = vi.spyOn(HolderConnection.prototype, 'resize')
    const STORM = 100
    const STORM_MS = 1000
    let last = { cols: 0, rows: 0 }
    for (let i = 0; i < STORM; i++) {
      last = { cols: 60 + (i % 50), rows: 20 + (i % 17) }
      pty.resize(last.cols, last.rows)
      clock.advance(STORM_MS / STORM)
    }
    clock.advance(L.resizeDebounceMs) // the last pending size goes out
    expect(resizes.mock.calls.at(-1)!.slice(0, 2)).toEqual([last.cols, last.rows])
    expect(resizes.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(STORM_MS / L.resizeDebounceMs))
    await until('the child to see the last size', () => fs.readFileSync(sizes, 'utf8').endsWith(`${last.cols}x${last.rows}\n`))
    expect(pty.info()).toMatchObject({ cols: last.cols, rows: last.rows })
  })
})
