// The chaos suite's workload and the post-conditions every fault test checks, for app-level runs (app.ts).
//
// Workload: one tab runs `counter` (tools/process-zoo) at a steady rate, a second tab is an idle shell for typing.
// Post-conditions checked here:
//   1. Continuity: the counter's bytes in the holder's ring hold every number once, in order (nothing lost or doubled
//      at the PTY); and the terminal's whole buffer, once the counter has gone past what the ring held after the fault
//      (so its tail can only have come live), holds the counter as one strict run reaching back past the fault: the
//      seam between the rebuilt snapshot and the live stream has no gap, no repeat and nothing else (`seamContinuous`).
//   2. Liveness: every holder and its shell are the same live processes as before; the Kea processes that should
//      have survived kept their pids.
//   5. Cleanliness: KeaRun.dispose (app.ts) and the suites' global teardown.
// 3 (truth: status) and 4 (consistency: database, worktrees) need sessions, so the tests that start them check those
// themselves (tests/chaos/app-agents.test.ts, tests/chaos/core-sessions.test.ts).
//
// "Killing core does not interrupt typing" is `typeThrough`: every key typed through an outage is timed, and the
// slowest one must be within the keystroke-echo budget's p99 (P-TERM-1), as no maximum is stated for an outage, which
// must leave typing unaffected.

import { expect } from './expect.ts'
import { verifyCounter, type CounterCheck } from '@kea-tools/process-zoo/src/index.ts'
import { L } from '@kea/protocol'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { COUNTER_FORMAT, counterCommand, counterNumbers, counterRun, PROMPT, ringCounterText, ringMax, until, type CounterRun, type HolderState, type Kea, type KeaRun } from './app.ts'

export interface Workload {
  /** The tab running counter. */
  counter: string
  /** An idle shell tab. */
  shell: string
  rate: number
}

/** The first tab runs counter at `rate` lines/s, a second tab is an idle shell; the counter tab is left on screen. */
export async function startWorkload(kea: Kea, rate: number): Promise<Workload> {
  const counter = (await kea.shown()) as string
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  await kea.enter(counterCommand(rate))
  await kea.waitScreen('counter output', (s) => counterNumbers(s).length >= 2)
  const shell = await kea.newTab()
  await kea.select(counter)
  return { counter, shell, rate }
}

/** The highest counter number on screen now (the counter tab must be on screen). */
export async function lastOnScreen(kea: Kea): Promise<number> {
  const nums = counterNumbers(await kea.screen())
  if (!nums.length) throw new Error('no counter output on screen')
  return Math.max(...nums)
}

/** Lines the counter must move past what the ring held, so the tail of the buffer can only have come live. */
const LIVE_LINES = 3

/**
 * Post-condition 1 at the seam. Read M, the highest counter number in the ring of `ptyId` now (after the fault and the
 * reattach); wait until the terminal shows M + 3, a line that can only have come through the live stream; then read the
 * terminal's whole buffer (`Kea.terminalText`) and require, from its first counter line to its last, every line to be
 * exactly the next counter line (`counterRun`: nothing skipped, repeated, partial or in between).
 * `before`: the run must reach back to this number (a fault whose output fits the buffer: the run spans it).
 */
export async function seamContinuous(run: KeaRun, kea: Kea, ptyId: string, o: { before?: number } = {}): Promise<CounterRun> {
  if ((await kea.shown()) !== ptyId) await kea.select(ptyId)
  const m = ringMax(run, ptyId)
  await kea.waitScreen(`counter output past ${m + LIVE_LINES} (the ring held ${m})`, (s) => counterNumbers(s).some((n) => n >= m + LIVE_LINES))
  const text = await kea.terminalText(ptyId)
  const r = counterRun(text)
  // the rows below the cursor are blank: the tail worth showing ends at the last line with text
  const lines = text.trimEnd().split('\n')
  const tail = lines.slice(Math.max(0, lines.length - 12)).join('\n')
  expect(r.problems, `the counter in ${ptyId}'s buffer is one strict run from kc ${r.first} to kc ${r.last} (${r.lines} lines); buffer tail:\n${tail}`).toEqual([])
  expect(r.last, 'the run ends in live output').toBeGreaterThanOrEqual(m + LIVE_LINES)
  if (o.before !== undefined) expect(r.first, `the run reaches back to kc ${o.before}, before the fault`).toBeLessThanOrEqual(o.before)
  return r
}

/** Post-condition 1 at the holder: every counter number once, in order, from 1 (`final`: the stream ended). */
export function ringContinuity(run: KeaRun, ptyId: string): CounterCheck {
  const r = run.ring(ptyId)
  expect(r.earliest, 'the ring still holds the start of the counter (a fault test must not wrap it)').toBe(0)
  const check = verifyCounter(ringCounterText(r.text), { start: 1, format: COUNTER_FORMAT })
  expect(check, 'the counter in the ring has no gap and no repeat').toMatchObject({ ok: true, missing: [], duplicates: [], outOfOrder: 0 })
  return check
}

/** The ring of `ptyId` keeps growing: the child is not blocked, whether or not any Kea process runs. */
export async function ringGrows(run: KeaRun, ptyId: string): Promise<void> {
  const from = run.ring(ptyId).latest
  await until(`output from ${ptyId} into its ring`, () => run.ring(ptyId).latest > from || undefined)
}

/**
 * Post-condition 2 for holders: the same holder processes, with their children, still alive, and no client refused. A
 * ptyhost killed while its connection awaits the holder's admission check left; it was not refused.
 */
export function holdersUnharmed(run: KeaRun, before: HolderState[]): void {
  for (const h of before) {
    const now = run.holder(h.ptyId)
    expect(run.holderAlive(now), `holder ${h.pid} of ${h.ptyId} alive`).toBe(true)
    expect(now.pid, `holder of ${h.ptyId} not replaced`).toBe(h.pid)
    expect(now.exited, `the shell of ${h.ptyId} still running`).toBe(false)
    expect(isAlive(now.childPid), `child ${now.childPid} of ${h.ptyId} alive`).toBe(true)
    expect(now.refusals, `holder ${h.ptyId} refused no client`).toBe(0)
  }
}

/** The keystroke-echo budget's p99 (P-TERM-1): the bound on every key typed through an outage. */
export const ECHO_BOUND_MS = BUDGETS['P-TERM-1'].p99
/** `cat` gets a new line now and then, so the line never wraps. */
const TYPED_LINE = 50

/**
 * Type into `cat` in the terminal on screen, one key at a time, timing each echo (keydown → glyph painted, the echo
 * budget's probe `Kea.keyEcho`), until `done()` holds after a key (and at least `min` keys were typed). Returns every
 * latency (ms) and when each echo was seen (`at`, epoch ms).
 */
export async function typeThrough(kea: Kea, done: () => Promise<boolean> | boolean, o: { min?: number } = {}): Promise<{ ms: number[]; at: number[] }> {
  const out = { ms: [] as number[], at: [] as number[] }
  for (let i = 0; ; i++) {
    if (i > 0 && i % TYPED_LINE === 0) await kea.press('Enter')
    out.ms.push(await kea.keyEcho(String.fromCharCode(97 + (i % 26))))
    out.at.push(Date.now())
    if (out.ms.length >= (o.min ?? 1) && (await done())) return out
  }
}

/** "Killing core does not interrupt typing": not one key typed through the outage waited past ECHO_BOUND_MS. */
export function expectTypingUninterrupted(ms: readonly number[], what: string): void {
  expect(ms.length, `keys typed ${what}`).toBeGreaterThan(0)
  const worst = Math.max(...ms)
  const slow = ms.map((v, i) => [i, v] as const).filter(([, v]) => v > ECHO_BOUND_MS)
  expect(worst, `slowest of ${ms.length} keys typed ${what} (key #, ms over ${ECHO_BOUND_MS}: ${JSON.stringify(slow.slice(0, 10).map(([i, v]) => [i, Math.round(v)]))})`).toBeLessThanOrEqual(ECHO_BOUND_MS)
}

export interface TerminalsWatch {
  /** Messages of one kind main has sent the window since the watch began: `rpc` (a new core's port), `wake`, … */
  received(kind: string): Promise<number>
  /** Stop: the fewest tabs the strip showed at any moment, and the terminals whose view was replaced. */
  stop(): Promise<{ fewestTabs: number; rebuilt: string[] }>
}

type Watch = { fewest: number; got: Record<string, number>; hosts: Map<string, Element>; obs: MutationObserver; onMessage(e: MessageEvent): void }

/**
 * Watch the window for anything a core restart or a wake must not do to terminals, which both leave unaffected:
 * every DOM change is seen (a MutationObserver runs after each batch of DOM updates), so a tab strip that
 * empties for one frame, or a terminal view that is torn down and rebuilt, is caught however briefly it lasts. Main's
 * messages to the page arrive as window messages from the preload (`{ kea: kind }`, lib/bridge.ts).
 */
export async function watchTerminals(kea: Kea): Promise<TerminalsWatch> {
  const page = await kea.page()
  await page.evaluate(() => {
    const tabs = () => document.querySelectorAll('[role=tab].tab:not(.add)').length
    const hosts = new Map([...document.querySelectorAll('.terminal-host')].map((e) => [e.getAttribute('data-pty') ?? '', e]))
    const w: Watch = {
      fewest: tabs(),
      got: {},
      hosts,
      obs: new MutationObserver(() => (w.fewest = Math.min(w.fewest, tabs()))),
      onMessage: (e: MessageEvent) => {
        const kind = (e.data as { kea?: unknown } | null)?.kea
        if (typeof kind === 'string') w.got[kind] = (w.got[kind] ?? 0) + 1
      },
    }
    w.obs.observe(document.body, { childList: true, subtree: true, attributes: true })
    window.addEventListener('message', w.onMessage)
    ;(window as unknown as { __keaWatch: Watch }).__keaWatch = w
  })
  return {
    received: (kind) => page.evaluate((k) => (window as unknown as { __keaWatch: Watch }).__keaWatch.got[k] ?? 0, kind),
    stop: () =>
      page.evaluate(() => {
        const w = (window as unknown as { __keaWatch: Watch }).__keaWatch
        w.obs.disconnect()
        window.removeEventListener('message', w.onMessage)
        const now = new Map([...document.querySelectorAll('.terminal-host')].map((e) => [e.getAttribute('data-pty') ?? '', e]))
        return { fewestTabs: w.fewest, rebuilt: [...w.hosts].filter(([id, e]) => now.get(id) !== e).map(([id]) => id) }
      }),
  }
}

/**
 * The supervisor's restart delays for `name`, from main's log: for each exit, the time until the next generation
 * started (L.supervisorBackoffMinMs, doubling up to L.supervisorBackoffMaxMs).
 */
export function restartDelays(kea: Kea, name: 'core' | 'ptyhost'): { delayMs: number; reason: string }[] {
  const lines = kea.logLines('main').filter((l) => l.name === name && (l.msg === 'supervisor: exited' || l.msg === 'supervisor: started'))
  const out: { delayMs: number; reason: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const exit = lines[i]
    const next = lines[i + 1]
    if (exit?.msg !== 'supervisor: exited' || next?.msg !== 'supervisor: started') continue
    out.push({ delayMs: Date.parse(next.t) - Date.parse(exit.t), reason: String(exit.reason) })
  }
  return out
}

/** The backoff the supervisor owes before restart number `i` (0-based) of an unbroken run of crashes. */
export function backoffMs(i: number): number {
  return Math.min(L.supervisorBackoffMinMs * 2 ** i, L.supervisorBackoffMaxMs)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
