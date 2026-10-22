import { describe, expect, it } from 'vitest'
import { maxInWindow, median, quantile, theilSen } from './stats.ts'

describe('stats', () => {
  it('U-PERF-2 · Theil–Sen ignores a few wild checkpoints that would tilt a least-squares fit; quantiles use nearest rank', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const flat = xs.map(() => 100)
    expect(theilSen(xs, flat)).toBe(0)
    // a flat series with two outliers (a GC that had not run, a cache that filled) stays flat
    const noisy = [...flat]
    noisy[3] = 900
    noisy[8] = 1500
    expect(theilSen(xs, noisy)).toBe(0)
    // a real leak of 2 per cycle is found through the same noise
    const leak = xs.map((x) => 100 + 2 * x)
    leak[3] = 900
    expect(theilSen(xs, leak)).toBe(2)
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3)
    expect(quantile(Array.from({ length: 100 }, (_, i) => i + 1), 0.99)).toBe(99)
    expect(median([3, 1, 2])).toBe(2)
  })

  it('U-PERF-5 · events sent 50 ms apart read 20 per window of 1 000 ms less the delivery jitter allowed, whatever the jitter within it; a faster sender reads more', () => {
    const T = 50 // L.resizeDebounceMs: the resize spacing the drag budget checks (P-TERM-9)
    const sends = Array.from({ length: 60 }, (_, i) => 1000 + i * T)
    // a case that reads 21 in whole seconds: the first of 21 resizes delivered 6 ms late, the last on time
    const late = sends.map((t, i) => (i === 0 ? t + 6 : t))
    expect(maxInWindow(sends, 1000)).toBe(20)
    expect(maxInWindow(late, 1000)).toBe(21)
    // any delays within a spread of `jitter` (here: a fixed pseudo-random pattern, and the worst case alternating)
    const jitter = T / 2
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * jitter
    const shaken = sends.map((t) => t + rnd())
    const worst = sends.map((t, i) => t + (i % 21 === 0 ? jitter : 0))
    for (const ts of [sends, late, shaken, worst]) expect(maxInWindow([...ts].sort((a, b) => a - b), 1000 - jitter)).toBeLessThanOrEqual(1000 / T)
    // a sender that keeps only 48 ms apart (20.8/s) or 16 ms (no throttle at all) is still caught
    for (const gap of [48, 40, 16]) {
      const fast = Array.from({ length: 80 }, (_, i) => i * gap)
      expect(maxInWindow(fast, 1000 - jitter), `${gap} ms apart`).toBeGreaterThan(1000 / T)
    }
  })
})
