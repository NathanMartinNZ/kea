// A clock for the sidebar's trailing times, one per window: one interval while any session row listens, stopped with
// the last one.

import { L } from '@kea/protocol'

const clockSubs = new Set<() => void>() // bounded: the session rows on screen
let clockNow = Date.now()
let clockTimer: ReturnType<typeof setInterval> | null = null

export function subscribeClock(cb: () => void): () => void {
  clockSubs.add(cb)
  clockTimer ??= setInterval(() => {
    clockNow = Date.now()
    for (const s of [...clockSubs]) s()
  }, L.sidebarClockMs)
  return () => {
    clockSubs.delete(cb)
    if (clockSubs.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

/** The clock's time, as of its last tick. */
export function clockTime(): number {
  return clockNow
}
