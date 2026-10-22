// Time sources. Every interval, timeout and duration in Kea is measured on the monotonic clock: it never jumps with
// wall-clock changes and does not advance across sleep, so a laptop waking up never sees a spurious timeout. Wall time
// is only for display and journals (`at` stamps), never for measuring how long something took.

/** Monotonic milliseconds since an arbitrary origin (`performance.now()`). */
export function monotonicMs(): number {
  return performance.now()
}

/** Wall-clock milliseconds since the Unix epoch. For timestamps only — never subtract two of these. */
export function wallMs(): number {
  return Date.now()
}

/** Opaque timer handle returned by a `Clock`. */
export type TimerHandle = unknown

/**
 * Injectable time source for code that schedules work (Supervisor, Scope timers). Production code
 * uses `systemClock`; tests either use Vitest fake timers (which `systemClock` picks up, because it
 * looks the globals up on every call) or pass their own clock.
 */
export interface Clock {
  /** Monotonic milliseconds. */
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

type NodeTimer = ReturnType<typeof setTimeout>

/** The real clock. Node's timers already run on the monotonic clock (libuv `uv_now`). */
export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeTimer),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeTimer),
}
