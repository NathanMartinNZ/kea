import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { ManualClock } from '../test-support.ts'
import { CheckpointScheduler, type CheckpointCandidate } from './scheduler.ts'

type Call = { reason: string; at: number }
interface Fake extends CheckpointCandidate {
  dirty: number
  at: number
  cap: number
  result: 'done' | 'wait' | 'failed'
  calls: Call[]
}

function setup() {
  const clock = new ManualClock()
  const s = new CheckpointScheduler(clock)
  const make = (ptyId: string, o: { dirty?: number; cap?: number } = {}) => {
    const c: Fake = {
      ptyId,
      dirty: o.dirty ?? 0,
      at: clock.now(),
      cap: o.cap ?? 1000,
      result: 'done',
      calls: [],
      dirtyBytes: () => c.dirty,
      lastCheckpointAt: () => c.at,
      ringCapacity: () => c.cap,
      checkpoint(reason: string) {
        c.calls.push({ reason, at: clock.now() })
        if (c.result === 'done') {
          c.dirty = 0
          c.at = clock.now()
        }
        return c.result
      },
    }
    s.add(c)
    return c
  }
  return { clock, s, make }
}

describe('checkpoint scheduler', () => {
  it('U-PTY-8 · a dirty mirror waits for half a ring of output or the max age; a clean one is never checkpointed', () => {
    const { clock, s, make } = setup()
    const below = make('aaaaaaaaaa', { dirty: 1000 * L.checkpointRingFraction - 1 })
    const half = make('bbbbbbbbbb', { dirty: 1000 * L.checkpointRingFraction })
    const clean = make('cccccccccc')
    for (const c of [below, half, clean]) s.poke(c)
    clock.advance(0)
    expect(half.calls).toEqual([{ reason: 'due', at: clock.now() }])
    expect(below.calls).toEqual([])
    clock.advance(L.checkpointMaxAgeMs - 1)
    expect(below.calls).toEqual([])
    clock.advance(1)
    expect(below.calls.map((c) => c.reason)).toEqual(['due'])
    clock.advance(10 * L.checkpointMaxAgeMs)
    expect(clean.calls).toEqual([])
    expect(half.calls).toHaveLength(1) // clean again after its checkpoint
    expect(s.runs).toBe(2)
  })

  it('U-PTY-17 · nothing is serialised within the quiet period after a keystroke, however overdue', () => {
    const { clock, s, make } = setup()
    const c = make('aaaaaaaaaa', { dirty: 1 })
    s.keystroke()
    const typedAt = clock.now()
    clock.advance(10)
    s.request(c, 'park')
    clock.advance(L.checkpointQuietMs - 11)
    expect(c.calls).toEqual([])
    // typing on keeps holding it back
    for (let i = 0; i < 10; i++) {
      s.keystroke()
      clock.advance(L.checkpointQuietMs - 1)
      expect(c.calls).toEqual([])
    }
    const lastKey = clock.now() - (L.checkpointQuietMs - 1)
    clock.advance(1)
    expect(c.calls).toEqual([{ reason: 'park', at: lastKey + L.checkpointQuietMs }])
    expect(lastKey).toBeGreaterThan(typedAt)
  })

  it('U-PTY-17 · at most one serialisation per minimum interval, across every PTY', () => {
    const { clock, s, make } = setup()
    const all = Array.from({ length: 20 }, (_, i) => make(String(i).padStart(10, 'a'), { dirty: 1 }))
    for (const c of all) s.request(c, 'now')
    clock.advance(20 * L.checkpointMinIntervalMs)
    const times = all.flatMap((c) => c.calls.map((x) => x.at)).sort((a, b) => a - b)
    expect(times).toHaveLength(20)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(L.checkpointMinIntervalMs)
    expect(s.runs).toBe(20)
  })

  it('U-PTY-17 · a PTY that cannot be cut yet is not retried until it pokes, then is', () => {
    const { clock, s, make } = setup()
    const c = make('aaaaaaaaaa', { dirty: 1 })
    c.result = 'wait'
    s.request(c, 'exit')
    clock.advance(0)
    expect(c.calls).toHaveLength(1)
    clock.advance(10 * L.checkpointMaxAgeMs)
    expect(c.calls).toHaveLength(1)
    c.result = 'done'
    s.poke(c)
    clock.advance(L.checkpointMinIntervalMs)
    expect(c.calls.map((x) => x.reason)).toEqual(['exit', 'exit']) // still the forced reason
    expect(s.runs).toBe(1)
  })

  it('U-PTY-8 · shutdown checkpoints every dirty mirror at once, ignoring the quiet period and the rate', () => {
    const { s, make } = setup()
    const dirty = [make('aaaaaaaaaa', { dirty: 5 }), make('bbbbbbbbbb', { dirty: 7 })]
    const clean = make('cccccccccc')
    s.keystroke()
    s.flushAll()
    for (const c of dirty) expect(c.calls.map((x) => x.reason)).toEqual(['shutdown'])
    expect(clean.calls).toEqual([])
  })

  it('U-PTY-17 · a removed PTY is never called again and leaves no timer behind, not even until the timer’s time', () => {
    const { clock, s, make } = setup()
    const c = make('aaaaaaaaaa', { dirty: 1 })
    const other = make('bbbbbbbbbb', { dirty: 1 }) // due only at L.checkpointMaxAgeMs
    s.keystroke()
    s.request(c, 'now')
    expect(clock.pendingTimeouts).toBe(1)
    s.remove(c)
    // the one timer is armed only while something is due: still for the other PTY, then for none
    expect(clock.pendingTimeouts).toBe(1)
    s.remove(other)
    expect(clock.pendingTimeouts).toBe(0)
    clock.advance(L.checkpointMaxAgeMs)
    expect(other.calls).toEqual([])
    expect(c.calls).toEqual([])
    expect(clock.pendingTimeouts).toBe(0)
    s.dispose()
  })

  it('U-PTY-61 · a checkpoint that cannot be written (the disk is full) is skipped: tried again only L.checkpointMaxAgeMs later, however dirty, unless one is asked for outright; once one is written the thresholds apply again', () => {
    const { clock, s, make } = setup()
    const c = make('aaaaaaaaaa', { dirty: 1000 }) // half a ring and more: due at once
    c.result = 'failed'
    s.poke(c)
    clock.advance(0)
    expect(c.calls).toHaveLength(1)
    // still dirty past every threshold: no serialisation every L.checkpointMinIntervalMs while the disk stays full
    clock.advance(L.checkpointMaxAgeMs - 1)
    expect(c.calls, 'skipped until the retry is due').toHaveLength(1)
    clock.advance(1)
    expect(c.calls.map((x) => x.reason)).toEqual(['due', 'due'])
    // asked for outright (⌘K): tried at once, and it fails again
    s.request(c, 'now')
    clock.advance(L.checkpointMinIntervalMs)
    expect(c.calls.map((x) => x.reason)).toEqual(['due', 'due', 'now'])
    clock.advance(L.checkpointMaxAgeMs - 1)
    expect(c.calls).toHaveLength(3)
    // space is back: the next try writes it, and from then on the usual thresholds decide
    c.result = 'done'
    clock.advance(1)
    expect(c.calls).toHaveLength(4)
    expect(c.dirty).toBe(0)
    c.dirty = 1000
    s.poke(c)
    clock.advance(L.checkpointMinIntervalMs)
    expect(c.calls, 'half a ring is due at once again').toHaveLength(5)
    expect(s.runs).toBe(5)
  })
})
