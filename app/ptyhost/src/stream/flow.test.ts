import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { StreamFlow } from './flow.ts'

const W = L.streamCreditBytes
const SKIP = L.streamSkipAheadBytes

/** A flow that has sent its first snapshot at `seq`. */
function live(seq = 0): StreamFlow {
  const f = new StreamFlow()
  expect(f.resume(seq)).toEqual({ do: 'snapshot' })
  f.onSnapshotSent(seq, 0, seq)
  return f
}

describe('renderer lag policy', () => {
  it('U-PTY-2 · a new stream starts with a snapshot and sends nothing before it', () => {
    const f = new StreamFlow()
    expect(f.needsSnapshot).toBe(true)
    expect(f.onBatch(0, 10)).toEqual({ do: 'skip' })
    expect(f.resume(10)).toEqual({ do: 'snapshot' })
    f.onSnapshotSent(10, 500, 10)
    expect(f.outstandingBytes).toBe(500)
    expect(f.onBatch(10, 5)).toEqual({ do: 'send' })
    expect(f.sentSeq).toBe(15)
  })

  it('U-PTY-2 · never more than the credit window outstanding; without credit nothing is kept and the stream is behind', () => {
    const f = live()
    const chunk = W / 4
    for (let i = 0; i < 4; i++) expect(f.onBatch(i * chunk, chunk)).toEqual({ do: 'send' })
    expect(f.outstandingBytes).toBe(W)
    expect(f.onBatch(W, 1)).toEqual({ do: 'drop' })
    expect(f.isBehind).toBe(true)
    expect(f.onBatch(W + 1, 1)).toEqual({ do: 'skip' }) // stays behind until credit returns
    expect(f.sentSeq).toBe(W)
  })

  it('U-PTY-2 · credit back with a small backlog → catch up from the ring, then live again', () => {
    const f = live()
    f.onBatch(0, W)
    f.onBatch(W, 100)
    f.onBatch(W + 100, 100)
    f.credit(W)
    const a = f.resume(W + 200)
    expect(a).toEqual({ do: 'catchUp', from: W, to: W + 200, budget: W })
    f.onCatchUpSent(200)
    f.caughtUpTo(W + 200)
    expect(f.isBehind).toBe(false)
    expect(f.onBatch(W + 200, 1)).toEqual({ do: 'send' })
  })

  it('U-PTY-2 · beyond the skip-ahead threshold → stop and resnapshot instead of sending the backlog', () => {
    const f = live()
    f.onBatch(0, W)
    f.onBatch(W, 1)
    f.credit(W)
    expect(f.resume(W + SKIP + 1)).toEqual({ do: 'snapshot' })
    expect(f.needsSnapshot).toBe(true)
    expect(f.onBatch(W + SKIP + 1, 10)).toEqual({ do: 'skip' })
    f.onSnapshotSent(W + SKIP + 11, 1000, W + SKIP + 11)
    expect(f.onBatch(W + SKIP + 11, 10)).toEqual({ do: 'send' })
    // exactly at the threshold still catches up
    const g = live()
    g.onBatch(0, W)
    g.onBatch(W, 1)
    g.credit(W)
    expect(g.resume(W + SKIP)).toMatchObject({ do: 'catchUp' })
  })

  it('U-PTY-2 · a snapshot behind the live stream is followed by a catch-up; a lost ring forces a snapshot', () => {
    const f = new StreamFlow()
    f.resume(0)
    f.onSnapshotSent(100, 10, 150) // mirror had parsed to 100, the coalescer had flushed to 150
    expect(f.isBehind).toBe(true)
    expect(f.onBatch(150, 10)).toEqual({ do: 'skip' })
    expect(f.resume(160)).toEqual({ do: 'catchUp', from: 100, to: 160, budget: W - 10 })
    f.onCatchUpImpossible()
    expect(f.resume(160)).toEqual({ do: 'snapshot' })
  })

  it('U-PTY-2 · a batch that is not contiguous with what the renderer has (a rebuild) triggers a snapshot', () => {
    const f = live(0)
    f.onBatch(0, 10)
    expect(f.onBatch(500, 10)).toEqual({ do: 'skip' })
    expect(f.needsSnapshot).toBe(true)
  })

  it('U-PTY-2 · an empty window admits one oversized batch, so nothing can wedge', () => {
    const f = live()
    expect(f.onBatch(0, W * 2)).toEqual({ do: 'send' })
    expect(f.hasCredit).toBe(false)
    expect(f.onBatch(W * 2, 1)).toEqual({ do: 'drop' })
  })

  it('U-PTY-2 · property: outstanding never exceeds window + one batch, and every byte the renderer gets is contiguous', () => {
    const op = fc.oneof(
      fc.record({ t: fc.constant('batch' as const), n: fc.integer({ min: 1, max: L.coalesceMaxBytes }) }),
      fc.record({ t: fc.constant('credit' as const), frac: fc.double({ min: 0, max: 1, noNaN: true }) }),
    )
    fc.assert(
      fc.property(fc.array(op, { maxLength: 200 }), (ops) => {
        const f = live()
        let produced = 0 // the coalescer's flushedSeq
        let delivered = 0 // the renderer's seq
        let written = 0 // bytes delivered and not yet credited
        const resume = () => {
          for (let i = 0; i < 4; i++) {
            const a = f.resume(produced)
            if (a.do === 'snapshot') {
              f.onSnapshotSent(produced, 0, produced)
              delivered = produced
            } else if (a.do === 'catchUp') {
              const n = Math.min(a.to - a.from, a.budget)
              expect(a.from).toBe(delivered)
              f.onCatchUpSent(n)
              delivered += n
              written += n
              f.caughtUpTo(produced)
            } else return
          }
        }
        for (const o of ops) {
          if (o.t === 'batch') {
            const a = f.onBatch(produced, o.n)
            if (a.do === 'send') {
              expect(produced).toBe(delivered)
              delivered += o.n
              written += o.n
            }
            produced += o.n
          } else {
            const n = Math.floor(written * o.frac)
            written -= n
            f.credit(n)
            resume()
          }
          expect(f.outstandingBytes).toBeLessThanOrEqual(W + L.coalesceMaxBytes)
          expect(f.sentSeq).toBe(delivered)
          expect(delivered).toBeLessThanOrEqual(produced)
        }
      }),
      { numRuns: 300 },
    )
  })
})
