import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { L } from '@kea/protocol'
import { StatusScheduler } from './scheduler.ts'

describe('the status scheduler', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  function scheduler(): { s: StatusScheduler; started: number[]; finish(): Promise<void> } {
    const started: number[] = []
    let done: (() => void) | null = null
    const s = new StatusScheduler({
      run: () => {
        started.push(Date.now())
        return new Promise<void>((r) => (done = r))
      },
      schedule: (fn, ms) => {
        const t = setTimeout(fn, ms)
        return { dispose: () => clearTimeout(t) }
      },
      now: () => Date.now(),
    })
    return {
      s,
      started,
      async finish() {
        done?.()
        done = null
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  it('U-GS-9 · a trigger after a quiet spell runs at once; a burst waits for L.gitDebounceMs of quiet and at most L.gitDebounceMaxMs; triggers during a run are exactly one trailing run; activation never waits', async () => {
    vi.setSystemTime(1_000_000)
    const { s, started, finish } = scheduler()
    const t0 = Date.now()
    s.trigger()
    expect(started).toEqual([t0]) // a single save: no debounce in front of it
    // Any number of triggers during the run: one more run, after it
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10)
      s.trigger()
    }
    expect(started).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(L.gitDebounceMs) // the debounce ran out while the first run was still going
    expect(started).toHaveLength(1)
    await finish()
    expect(started).toHaveLength(2)
    await finish()
    await vi.advanceTimersByTimeAsync(L.gitDebounceMaxMs * 2)
    expect(started).toHaveLength(2) // and no third
    expect(s.idle).toBe(true)

    // a burst with nothing in flight: the first at once, the rest together once it has been quiet for the debounce
    s.trigger()
    await finish()
    const burst = Date.now()
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(50)
      s.trigger()
    }
    expect(started).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(L.gitDebounceMs - 1)
    expect(started).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(started).toHaveLength(4)
    expect((started[3] as number) - burst).toBe(500 + L.gitDebounceMs)
    await finish()

    // a burst that never pauses: a run at the latest L.gitDebounceMaxMs after its first waiting trigger
    await vi.advanceTimersByTimeAsync(L.gitDebounceMs)
    s.trigger()
    await finish()
    expect(started).toHaveLength(5)
    const first = Date.now() + 100
    for (let t = 0; t < L.gitDebounceMaxMs + 1000; t += 100) {
      await vi.advanceTimersByTimeAsync(100)
      s.trigger()
      if (s.running) await finish()
    }
    expect(started.length).toBeGreaterThanOrEqual(6)
    expect((started[5] as number) - first).toBe(L.gitDebounceMaxMs)
    await finish()
    await vi.advanceTimersByTimeAsync(L.gitDebounceMaxMs)
    await finish()

    // activation, focus, Refresh: at once even inside a burst; during a run, right after it
    const n = started.length
    s.trigger()
    await finish()
    s.trigger() // waiting for its debounce
    s.now()
    expect(started).toHaveLength(n + 2)
    s.now()
    s.now()
    await finish()
    expect(started).toHaveLength(n + 3)
    await finish()

    // hidden: nothing waits and nothing starts
    s.trigger() // inside the debounce of the last one: waiting
    expect(s.pending).toBe(true)
    s.stop()
    s.trigger()
    s.now()
    await vi.advanceTimersByTimeAsync(L.gitDebounceMaxMs * 2)
    expect(started).toHaveLength(n + 3)
    expect(s.pending).toBe(false)
    s.resume()
    s.now()
    expect(started).toHaveLength(n + 4)
  })
})
