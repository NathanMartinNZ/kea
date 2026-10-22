// A watch over one Node process's timers, for the idle CPU budget's `max_timer_hz` (P-CPU-2): while it is on, every
// timer that fires in the process is counted by its delay, whenever and however it was armed (`setTimeout`,
// `setInterval`, `node:timers`, `timers/promises`, `AbortSignal.timeout`, kit's `Scope`: all of them run a `Timeout`),
// and every other asynchronous callback by its resource type. It is an async hook with only a `before` callback, which
// reads the resource about to run; a timer armed before the watch began is seen as soon as it fires.
//
// Used inside core and ptyhost by the test hook (app-child-hooks.cjs, op `timers`) and inside main, which gets
// `createTimerWatch` as source through Playwright (tests/support/app-timers.ts): so it is self-contained, and everything
// it needs is its argument. The hook costs CPU while it is on: a watch never overlaps a CPU measurement.
//
// What it cannot see: timers that never enter JavaScript (libuv timers of a native addon, a polled file watch's
// `fs.watchFile`, Chromium's own in main, the Rust holders' poll timeouts), timers on another thread of the process (a
// worker's: an async hook belongs to the thread that made it) and processes with no Node (the GPU and network helpers,
// and the window, whose timers are Blink's). A loop that never arms a timer (`setImmediate`, a message port posting to
// itself) shows only as a count under its resource type.
'use strict'

function createTimerWatch(asyncHooks) {
  let run = null
  const planted = [] // bounded: one stop function per stray timer a test planted (one or two at a time, cleared by `unplant`)
  return {
    /** Start counting (a watch already on starts afresh). */
    start() {
      if (run) run.hook.disable()
      const timers = new Map() // bounded: one entry per distinct timer delay seen during one watch
      const callbacks = new Map() // bounded: one entry per async resource type
      const hook = asyncHooks.createHook({
        before() {
          const r = asyncHooks.executionAsyncResource()
          const type = (r && r.constructor && r.constructor.name) || 'unknown'
          if (type === 'Timeout') {
            const key = `${r._idleTimeout}:${r._repeat === null || r._repeat === undefined ? 0 : 1}`
            timers.set(key, (timers.get(key) || 0) + 1)
          } else callbacks.set(type, (callbacks.get(type) || 0) + 1)
        },
      })
      run = { hook, timers, callbacks, t0: performance.now() }
      hook.enable()
      return true
    },
    /** Stop counting: `{ seconds, timers: [{ delayMs, repeat, fired }], callbacks: { <type>: n } }` since `start`. */
    stop() {
      if (!run) throw new Error('timers: no watch is on')
      const w = run
      run = null
      w.hook.disable()
      const timers = [...w.timers].map(([key, fired]) => {
        const [delay, repeat] = key.split(':')
        return { delayMs: Number(delay), repeat: repeat === '1', fired }
      })
      timers.sort((a, b) => a.delayMs - b.delayMs)
      return { seconds: (performance.now() - w.t0) / 1000, timers, callbacks: Object.fromEntries(w.callbacks) }
    },
    /**
     * Arm a stray timer that does nothing, which a watch must see (its control): an interval of `ms`, or with `wander`
     * a timeout that arms itself again each time it fires, one millisecond later than the last, so that no two of its
     * fires share a delay (what a rule that groups timers by delay cannot see).
     */
    plant(ms, wander) {
      if (!Number.isFinite(ms) || ms <= 0) throw new Error('timers: plant needs a period in ms')
      if (wander) {
        let next = ms
        let t = null
        const arm = () => {
          t = setTimeout(arm, next++)
        }
        arm()
        planted.push(() => clearTimeout(t))
      } else {
        const t = setInterval(() => {}, ms)
        planted.push(() => clearInterval(t))
      }
      return planted.length
    },
    /** Clear every planted timer. */
    unplant() {
      const n = planted.length
      for (const stop of planted.splice(0)) stop()
      return n
    },
  }
}

module.exports = { createTimerWatch }
