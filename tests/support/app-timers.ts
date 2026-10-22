// The timers that fire in Kea's Node processes while it idles, which the idle CPU budget limits (`max_timer_hz`,
// P-CPU-2), for the app-level suites: one watch (tests/support/timer-watch.cjs) in each of main, core and ptyhost,
// started and stopped together. Core and ptyhost run it in their test hook (app-child-hooks.cjs, op `timers`); main
// gets the same function as source through Playwright and keeps it on `globalThis.__keaTimerWatch`. Both exist only in
// a dev build run with `--kea-perf`, like every other test hook (app/main/src/testHooks.ts).
//
// A watch counts every `Timeout` that fires, by its delay, whenever it was armed, and every other asynchronous callback
// by resource type. It sees no timer that never enters JavaScript (a native addon's, a polled file watch's, Chromium's
// own in main, a holder's poll timeout), none on another thread (a worker's) and no process without Node (the GPU and
// network helpers; the holders; the window). While it is on it costs CPU, so it never overlaps a CPU window.
//
// Two rules read a watch against a rate (the idle budget's `max_timer_hz`). `fasterThan`: the timers of one delay that
// fired more often than the rate, which names the timer. `fastFiresPerSecond`: every fire of a timer whose delay is
// shorter than the rate's period, whatever the delay, which also sees what the first cannot: a timeout that re-arms
// itself with a different delay each time, and several short timers that are each slow enough alone. `firesPerSecond`
// is every fire, the long timers' too: recorded (many timers of a second or more can together fire often), not judged.

import { createRequire } from 'node:module'
import type { Kea } from './app.ts'

export type TimerProc = 'main' | 'core' | 'ptyhost'
export const TIMER_PROCS: readonly TimerProc[] = ['main', 'core', 'ptyhost']

/** The timers of one delay that fired during a watch. */
export interface TimerGroup {
  delayMs: number
  /** Armed with `setInterval`. */
  repeat: boolean
  fired: number
}

/** What one process's watch saw. */
export interface TimerWatch {
  seconds: number
  timers: TimerGroup[]
  /** Other asynchronous callbacks that ran, by resource type (`Immediate`, `MessagePort`, `Pipe`, …). */
  callbacks: Record<string, number>
}

type WatchApi = { start(): boolean; stop(): TimerWatch; plant(ms: number, wander?: boolean): number; unplant(): number }
const { createTimerWatch } = createRequire(import.meta.url)('./timer-watch.cjs') as { createTimerWatch: (asyncHooks: unknown) => WatchApi }
const SOURCE = createTimerWatch.toString()

/** One call on main's watch (made on first use from `SOURCE`). */
function inMain<T>(kea: Kea, op: keyof WatchApi, ms?: number, wander = false): Promise<T> {
  return kea.app.evaluate(
    (_e, a) => {
      const g = globalThis as unknown as { __keaTimerWatch?: WatchApi }
      // the watch reaches main as source: it is test code, and main's bundle has none of it
      g.__keaTimerWatch ??= (0, eval)(`(${a.source})`)((process as unknown as { getBuiltinModule(n: string): unknown }).getBuiltinModule('node:async_hooks')) as WatchApi
      return (a.op === 'plant' ? g.__keaTimerWatch.plant(a.ms as number, a.wander) : g.__keaTimerWatch[a.op as 'start' | 'stop' | 'unplant']()) as unknown
    },
    { source: SOURCE, op, ms, wander },
  ) as Promise<T>
}

/** Start a watch in main, core and ptyhost. */
export async function startTimerWatch(kea: Kea): Promise<void> {
  await Promise.all([inMain(kea, 'start'), kea.debug('core', 'timers', 'start'), kea.debug('ptyhost', 'timers', 'start')])
}

/** Stop the watches; resolves with what each process's saw. */
export async function stopTimerWatch(kea: Kea): Promise<Record<TimerProc, TimerWatch>> {
  const [main, core, ptyhost] = await Promise.all([inMain<TimerWatch>(kea, 'stop'), kea.debug<TimerWatch>('core', 'timers', 'stop'), kea.debug<TimerWatch>('ptyhost', 'timers', 'stop')])
  return { main, core, ptyhost }
}

/**
 * Arm a stray timer that does nothing in `proc`, for a watch's control: an interval of `ms`, or with `wander` a timeout
 * that re-arms itself one millisecond later each time, so no two of its fires share a delay. `unplantTimers` clears it.
 */
export async function plantTimer(kea: Kea, proc: TimerProc, ms: number, wander = false): Promise<void> {
  if (proc === 'main') await inMain(kea, 'plant', ms, wander)
  else await kea.debug(proc, 'timers', `${wander ? 'wander' : 'plant'}:${ms}`)
}

export async function unplantTimers(kea: Kea): Promise<void> {
  await Promise.all([inMain(kea, 'unplant'), kea.debug('core', 'timers', 'unplant'), kea.debug('ptyhost', 'timers', 'unplant')])
}

/**
 * The timers of a watch that ran faster than `hz`: those of one delay shorter than a period of `hz` that fired more
 * often than `hz` over the watch. Two timers of a longer delay that together fire more often are not one fast timer,
 * and one short timeout after an event is not a periodic one.
 */
export function fasterThan(w: TimerWatch, hz: number): TimerGroup[] {
  return w.timers.filter((t) => t.delayMs < 1000 / hz && t.fired > w.seconds * hz)
}

/**
 * How often, per second of the watch, a timer with a delay shorter than a period of `hz` fired, all such timers
 * together whatever their delays. Above `hz` the process is waking faster than the rate allows, even when no one
 * delay does (`fasterThan`): a timeout re-armed with a new delay each time, or several short timers side by side.
 */
export function fastFiresPerSecond(w: TimerWatch, hz: number): number {
  return w.timers.filter((t) => t.delayMs < 1000 / hz).reduce((n, t) => n + t.fired, 0) / w.seconds
}

/** Every timer fire per second of the watch, whatever the delay. */
export function firesPerSecond(w: TimerWatch): number {
  return w.timers.reduce((n, t) => n + t.fired, 0) / w.seconds
}

/** Every other asynchronous callback per second of the watch (immediates, ports, pipes, promises' hooks, …). */
export function callbacksPerSecond(w: TimerWatch): number {
  return Object.values(w.callbacks).reduce((n, c) => n + c, 0) / w.seconds
}

/** A watch as one line for a message or a note: `2000 ms ×10, 30000 ms ×1 (interval); callbacks MessagePort ×4`. */
export function timerLine(w: TimerWatch): string {
  const timers = w.timers.map((t) => `${t.delayMs} ms ×${t.fired}${t.repeat ? ' (interval)' : ''}`).join(', ') || 'none'
  const callbacks = Object.entries(w.callbacks)
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ')
  return `${timers} in ${w.seconds.toFixed(1)} s${callbacks ? `; other callbacks ${callbacks}` : ''}`
}
