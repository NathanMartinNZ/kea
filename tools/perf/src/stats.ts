// Small statistics shared by the perf harness and the app-level suites.

/** The q-quantile of `xs` by the nearest-rank method (q = 0.99: the p99 the budgets state). */
export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? NaN
}

/** The median of `xs` (each leak checkpoint is the median of three readings). */
export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5)
}

/**
 * Theil–Sen slope of `ys` over `xs`: the median of the slopes between every pair of points, so a few noisy checkpoints
 * cannot fake or hide a trend.
 */
export function theilSen(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length) throw new Error('theilSen: xs and ys differ in length')
  const slopes: number[] = []
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++) {
      const dx = (xs[j] as number) - (xs[i] as number)
      if (dx !== 0) slopes.push(((ys[j] as number) - (ys[i] as number)) / dx)
    }
  if (!slopes.length) return 0
  const s = slopes.sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/**
 * The most of the times `ts` (ms, sorted) inside any half-open window `[t, t + ms)`: events per window, for a rate
 * budget such as `max_resizes_per_s` (P-TERM-9).
 *
 * Events sent at least `T` apart can still arrive closer together when their delivery is delayed by different amounts.
 * If every delay lies within a spread of `jitterMs`, the arrivals of n + 1 such events span at least n·T − jitterMs; so
 * counting in windows of `1000 − jitterMs` instead of 1000 can never read more than 1000 / T for a sender that keeps
 * its spacing, while a sender that sends faster than `(1000 − jitterMs) / (1000 / T)` apart still reads above it.
 */
export function maxInWindow(ts: readonly number[], ms: number): number {
  let best = 0
  for (let i = 0, j = 0; i < ts.length; i++) {
    while ((ts[i] as number) - (ts[j] as number) >= ms) j++
    best = Math.max(best, i - j + 1)
  }
  return best
}
