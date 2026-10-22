// The memory watchdog in a running Kea, for the app-level suites: a test says how long the person has been idle and
// what a process weighs in the watchdog's next sample (`__keaTest.watchdogIdle`, `__keaTest.watchdogFeed`,
// app/main/src/testHooks.ts), so the four actions run without a byte being allocated, and reads what the watchdog
// wrote. A run that uses these says so first (`KeaRun.expectWatchdog`): every other run fails for a trigger.

import fs from 'node:fs'
import path from 'node:path'
import { STEP_MS, WATCHDOG_LOG, type Kea, type KeaRun } from './app.ts'

/** One trigger, as main's log line and the `resources.ndjson` line hold it (app/main/src/resources.ts `WatchdogTrigger`). */
export interface Trigger {
  process: string
  pid: number
  bytes: number
  limit: 'soft' | 'hard'
  limitBytes: number
  action: string
  why?: string
}

/** A `resources.ndjson` line written for a watchdog trigger. */
export interface WatchdogLine {
  t: string
  trigger: 'watchdog'
  watchdog: Trigger[]
  reports: Record<string, Record<string, unknown>>
  missing: Record<string, string>
  footprint: { t: string; pids: Record<string, number>; bytes: Record<string, number> } | null
}

type TestApi = { watchdogIdle(ms: number | null): void; watchdogFeed(bytes: Record<string, number>): Promise<unknown> }

/** How long the person has given no input, as the watchdog takes it from now on; null: the system's own idle time again. */
export async function watchdogIdle(kea: Kea, ms: number | null): Promise<void> {
  await kea.app.evaluate((_e, v) => (globalThis as unknown as { __keaTest: TestApi }).__keaTest.watchdogIdle(v), ms)
}

/**
 * One watchdog interval now, on a fresh footprint sample in which the processes named in `bytes` weigh that much (the
 * others what they do). Resolves with the interval's triggers once its line is written and its actions are over: a
 * restarted core or ptyhost is ready, a reloaded window has loaded. `ms`: how long that may take.
 */
export function watchdogFeed(kea: Kea, bytes: Record<string, number>, ms = STEP_MS): Promise<Trigger[]> {
  let timer: NodeJS.Timeout | undefined
  const fed = kea.app.evaluate((_e, b) => (globalThis as unknown as { __keaTest: TestApi }).__keaTest.watchdogFeed(b), bytes) as Promise<Trigger[]>
  return Promise.race([fed, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`the watchdog's interval on ${JSON.stringify(bytes)}: not over within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer))
}

/** Triggers as `<process> <limit>:<action>` (and why an action waits), in order. */
export function brief(ts: readonly Trigger[]): string[] {
  return ts.map((t) => `${t.process} ${t.limit}:${t.action}${t.why ? ` (${t.why})` : ''}`)
}

/** Every trigger main has logged at error level so far, oldest first. */
export function loggedTriggers(kea: Kea): Trigger[] {
  return kea.logLines('main').filter((l) => l.msg === WATCHDOG_LOG && l.level === 'error') as unknown as Trigger[]
}

/** The watchdog's lines in the run's `resources.ndjson` so far, oldest first. */
export function watchdogLines(run: KeaRun): WatchdogLine[] {
  const file = path.join(run.home, 'logs', 'resources.ndjson')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as WatchdogLine)
    .filter((l) => l.trigger === 'watchdog')
}

/** How long each of the watchdog's actions took, from main's log (`watchdog: action finished`), oldest first. */
export function actionTimes(kea: Kea): { process: string; action: string; ms: number }[] {
  return kea.logLines('main').filter((l) => l.msg === 'watchdog: action finished') as unknown as { process: string; action: string; ms: number }[]
}
