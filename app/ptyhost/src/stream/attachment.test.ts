import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { L, type Channel, type StreamToRenderer } from '@kea/protocol'
import { Attachment, type AttachmentHost, type StreamSnapshot } from './attachment.ts'

// U-MEM-2: the credit window as the renderer's port sees it, with the real limits: an Attachment, a PTY whose ring
// holds everything from `earliest`, and a port that records what was posted.

const W = L.streamCreditBytes
const SKIP = L.streamSkipAheadBytes
const BATCH = L.coalesceMaxBytes

class Host implements AttachmentHost {
  readonly ptyId = 'abcdefghij'
  /** Where the coalescer's next batch starts. */
  flushed = 0
  earliest = 0
  snapshotRequests = 0
  private pending: ((s: StreamSnapshot) => void) | null = null
  flushedSeq(): number {
    return this.flushed
  }
  requestSnapshot(cb: (s: StreamSnapshot) => void): () => void {
    this.snapshotRequests++
    this.pending = cb
    return () => {
      if (this.pending === cb) this.pending = null
    }
  }
  get snapshotPending(): boolean {
    return this.pending !== null
  }
  /** Cut the requested snapshot at the flushed seq (a one-character screen, so it costs 1 credit). */
  cut(): void {
    const cb = this.pending
    this.pending = null
    cb?.({ seq: this.flushed, cols: 80, rows: 24, data: 'S', exited: null, title: null })
  }
  readRing(from: number, to: number, max: number): Uint8Array | null {
    if (from < this.earliest) return null
    return new Uint8Array(Math.max(0, Math.min(to, this.flushed, from + max) - from))
  }
  input(): void {}
  resize(): void {}
  detached(): void {}
}

/** The renderer end: what was posted, what it still owes credit for, and a contiguity check on every data message. */
function stream() {
  const host = new Host()
  const posted: StreamToRenderer[] = []
  let deliver: ((m: unknown) => void) | null = null
  let outstanding = 0
  let peak = 0
  let seq = -1
  const ch: Channel = {
    send: (raw) => {
      const m = raw as StreamToRenderer
      posted.push(m)
      if (m.k === 'snapshot') {
        seq = m.seq
        outstanding += m.data.length
      } else if (m.k === 'data') {
        expect(m.seq).toBe(seq) // contiguous with what the renderer has
        seq += m.b.byteLength
        outstanding += m.b.byteLength
      }
      peak = Math.max(peak, outstanding)
    },
    onMessage: (cb) => {
      deliver = (m) => cb(m, [])
      return () => (deliver = null)
    },
    onClose: () => () => {},
    close() {},
  }
  const a = new Attachment(host, ch)
  return {
    host,
    a,
    posted,
    get outstanding() {
      return outstanding
    },
    get peak() {
      return peak
    },
    get seq() {
      return seq
    },
    /** The renderer wrote `n` more bytes (all it owes when omitted). */
    credit(n = outstanding) {
      outstanding -= n
      deliver?.({ k: 'credit', n })
    },
    /** A live batch of `n` bytes from the coalescer. */
    live(n: number) {
      const at = host.flushed
      host.flushed += n
      a.live(at, new Uint8Array(n))
    },
    dataBytes: () => posted.reduce((n, m) => n + (m.k === 'data' ? m.b.byteLength : 0), 0),
  }
}

/** Attach, send the first snapshot and pay for it: the stream is live at seq 0 with the whole window free. */
function live() {
  const s = stream()
  s.a.start()
  s.host.cut()
  s.credit()
  return s
}

/** Fill the window with live batches, then put the stream `backlog` bytes behind. */
function behindBy(backlog: number) {
  const s = live()
  for (let i = 0; i < W / BATCH; i++) s.live(BATCH)
  expect(s.outstanding).toBe(W)
  for (let left = backlog; left > 0; left -= BATCH) s.live(Math.min(BATCH, left))
  expect(s.host.flushed - s.seq).toBe(backlog)
  return s
}

describe('credit window at the port', () => {
  it('U-MEM-2 · the sender stops at zero credit, keeps nothing while stopped, and resumes from the ring when credit returns', () => {
    const s = live()
    let sends = 0
    while (s.outstanding + BATCH <= W) {
      s.live(BATCH)
      sends++
    }
    expect(s.outstanding).toBe(W)
    expect(sends).toBe(W / BATCH)
    // out of credit: nothing more is posted, however much output there is
    const before = s.posted.length
    for (let i = 0; i < 6; i++) s.live(BATCH)
    expect(s.posted.length).toBe(before)
    expect(s.a.stats.dropped).toBe(1) // the first batch that did not fit; after it the stream is behind and skips
    expect(s.a.flow.isBehind).toBe(true)
    // credit returns: catch up from the ring, never more than the window at once, until live again
    while (s.seq < s.host.flushed) {
      const was = s.posted.length
      s.credit()
      expect(s.posted.length).toBeGreaterThan(was)
      expect(s.outstanding).toBeLessThanOrEqual(W)
    }
    expect(s.a.stats.catchUpBytes).toBe(6 * BATCH)
    expect(s.host.snapshotRequests).toBe(1)
    s.credit()
    s.live(100)
    expect(s.posted.at(-1)).toMatchObject({ k: 'data', seq: s.host.flushed - 100 })
    expect(s.peak).toBe(W)
  })

  it(`U-MEM-2 · skip-ahead: a renderer exactly ${SKIP} bytes behind is caught up from the ring; one byte more and it gets a snapshot instead`, () => {
    const at = behindBy(SKIP)
    at.credit()
    expect(at.host.snapshotRequests).toBe(1) // only the first one
    expect(at.posted.at(-1)?.k).toBe('data')
    expect(at.a.stats.catchUpBytes).toBe(W) // one window's worth now; the rest as credit returns
    const over = behindBy(SKIP + 1)
    const sent = over.dataBytes()
    over.credit()
    expect(over.host.snapshotRequests).toBe(2)
    expect(over.dataBytes()).toBe(sent) // the backlog is not sent
    over.host.cut()
    expect(over.posted.at(-1)).toMatchObject({ k: 'snapshot', seq: over.host.flushed })
    expect(over.a.stats.catchUpBytes).toBe(0)
  })

  it('U-MEM-2 · property: whatever the output and however the renderer pays, outstanding never exceeds the window and the renderer stays contiguous', () => {
    const op = fc.oneof(
      fc.record({ k: fc.constant('live' as const), n: fc.integer({ min: 1, max: BATCH }) }),
      fc.record({ k: fc.constant('credit' as const), part: fc.double({ min: 0, max: 1, noNaN: true }) }),
      fc.record({ k: fc.constant('cut' as const) }),
      fc.record({ k: fc.constant('lose' as const) }),
    )
    fc.assert(
      fc.property(fc.array(op, { maxLength: 300 }), (ops) => {
        const s = stream()
        s.a.start()
        for (const o of ops) {
          if (o.k === 'live') s.live(o.n)
          else if (o.k === 'credit') s.credit(Math.floor(s.outstanding * o.part))
          else if (o.k === 'cut') s.host.cut()
          else s.host.earliest = s.host.flushed // the ring wrapped past everything sent
          expect(s.outstanding).toBeLessThanOrEqual(W)
        }
        // paying everything back and cutting any snapshot asked for always brings the renderer up to date
        for (let i = 0; i < 64 && s.seq < s.host.flushed; i++) {
          s.credit()
          s.host.cut()
        }
        expect(s.seq).toBe(s.host.flushed)
      }),
      { numRuns: 200 },
    )
  })
})
