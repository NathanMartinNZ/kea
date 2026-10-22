import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { Coalescer } from './coalescer.ts'

/** A manual clock: timers fire only when `advance` passes them. */
function fakeClock() {
  let t = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = due[1].at
        due[1].fn()
      }
      t = end
    },
    get pending() {
      return timers.size
    },
  }
}

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill)

function setup(opts: { windowMs?: number; maxBytes?: number; quietMs?: number } = {}) {
  const clock = fakeClock()
  const out: { seq: number; n: number; at: number }[] = []
  const c = new Coalescer({ clock, flush: (seq, data) => out.push({ seq, n: data.byteLength, at: clock.now() }), ...opts })
  return { clock, out, c }
}

describe('output coalescer', () => {
  it('U-PTY-1 · the first chunk after quiet is forwarded at once (keystroke echo)', () => {
    const { clock, out, c } = setup()
    clock.advance(100)
    c.push(0, bytes(1))
    expect(out).toEqual([{ seq: 0, n: 1, at: 100 }])
    expect(clock.pending).toBe(0)
    // another keystroke after quiet: immediate again
    clock.advance(L.coalesceQuietMs)
    c.push(1, bytes(1))
    expect(out.at(-1)).toEqual({ seq: 1, n: 1, at: 100 + L.coalesceQuietMs })
  })

  it('U-PTY-1 · under load, chunks are batched for at most the window', () => {
    const { clock, out, c } = setup()
    c.push(0, bytes(10)) // immediate (quiet since start)
    clock.advance(1)
    c.push(10, bytes(10)) // within quiet: batched
    clock.advance(1)
    c.push(20, bytes(10))
    expect(out).toHaveLength(1)
    clock.advance(L.coalesceWindowMs - 2)
    expect(out).toHaveLength(1) // window counts from the first batched chunk (at t=1)
    clock.advance(1)
    expect(out).toEqual([
      { seq: 0, n: 10, at: 0 },
      { seq: 10, n: 20, at: 1 + L.coalesceWindowMs },
    ])
  })

  it('U-PTY-1 · a batch is flushed as soon as it reaches the size limit, and never exceeds it', () => {
    const { clock, out, c } = setup()
    c.push(0, bytes(1))
    clock.advance(1)
    const chunk = L.coalesceMaxBytes / 4
    for (let i = 0; i < 4; i++) c.push(1 + i * chunk, bytes(chunk))
    expect(out.map((o) => o.n)).toEqual([1, L.coalesceMaxBytes])
    expect(out[1]!.at).toBe(1) // no waiting for the timer
    // a chunk that would overflow the batch flushes the batch first
    c.push(1 + L.coalesceMaxBytes, bytes(chunk * 3))
    c.push(1 + L.coalesceMaxBytes + chunk * 3, bytes(chunk * 2))
    expect(out.map((o) => o.n)).toEqual([1, L.coalesceMaxBytes, chunk * 3])
    clock.advance(L.coalesceWindowMs)
    expect(out.map((o) => o.n)).toEqual([1, L.coalesceMaxBytes, chunk * 3, chunk * 2])
  })

  it('U-PTY-1 · flushNow, reset and dispose', () => {
    const { clock, out, c } = setup()
    c.push(0, bytes(1))
    clock.advance(1)
    c.push(1, bytes(5))
    c.flushNow()
    expect(out.map((o) => [o.seq, o.n])).toEqual([[0, 1], [1, 5]])
    expect(c.flushedSeq).toBe(6)
    c.push(6, bytes(3))
    c.reset(100)
    expect(c.pendingBytes).toBe(0)
    expect(c.flushedSeq).toBe(100)
    clock.advance(10)
    expect(out).toHaveLength(2)
    c.dispose()
    c.push(100, bytes(1))
    expect(out).toHaveLength(2)
  })

  it('U-PTY-1 · property: batches are contiguous, lossless, within the size limit, and no byte waits longer than the window', () => {
    const step = fc.record({ gap: fc.integer({ min: 0, max: 12 }), n: fc.integer({ min: 1, max: 40_000 }) })
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 80 }), (steps) => {
        const { clock, out, c } = setup()
        const arrivals: { seq: number; at: number }[] = []
        let seq = 0
        for (const s of steps) {
          clock.advance(s.gap)
          arrivals.push({ seq, at: clock.now() })
          c.push(seq, bytes(s.n))
          seq += s.n
        }
        clock.advance(L.coalesceWindowMs)
        let expect0 = 0
        for (const o of out) {
          expect(o.seq).toBe(expect0)
          expect(o.n).toBeLessThanOrEqual(L.coalesceMaxBytes)
          expect0 += o.n
        }
        expect(expect0).toBe(seq)
        // each chunk's first byte is flushed within the window of its arrival
        for (const a of arrivals) {
          const batch = out.find((o) => a.seq >= o.seq && a.seq < o.seq + o.n)!
          expect(batch.at - a.at).toBeLessThanOrEqual(L.coalesceWindowMs)
        }
      }),
      { numRuns: 200 },
    )
  })
})
