// Idle sessions, and what an idle Kea costs: one way to make live, idle sessions, to bring the app to rest, and to read
// its footprint and CPU, shared by the perf tests (tests/perf/app-many.test.ts, app-memory.test.ts) and the leak tests
// (tests/perf/app-nowindow.test.ts). Nothing here launches Kea: a caller does, through its suite's own harness
// (tests/perf/app-harness.ts `startKea`, or tests/support/app.ts `KeaRun`).
//
// A live, idle session is a real one: a worktree of a tools/repo-factory repository, started from the composer the way
// a person starts it, its agent the run's `claude` (tools/fake-agent, the default scenario: one short turn with its
// hooks, transcript and title, then idle at its prompt) or the `shell` pseudo-agent when the run's default is that
// (P-MEM-2b; an agent session's holder is about 0.2 MB larger than a shell's). At rest means ptyhost has parked every
// mirror the window holds no terminal view of.
//
// The tests of an app with no window (its footprint budget, the window-cycle leak test and the 12-hour idle soaks)
// share more than that: the same sessions (`noWindowSessions`: 20, the fake agent's) and one reading of the window
// going (`windowGone`: the footprint held to P-MEM-5 is the one read `L.windowGoneFootprintMs` after the window went),
// so two tests cannot disagree about the same budget.
//
// Footprint is physical footprint (`kea-helper footprint`) summed over every Kea process (Electron's, the GPU helper
// included, and the holders) after a forced GC in each JS process; CPU is the processes' own CPU time (user + system:
// `ps`, or `/proc` on Linux) over a window, as % of one core. Neither counts the shells and agents under the holders:
// those are the person's programs.

import os from 'node:os'
import { L } from '@kea/protocol'
import { STEP_MS, until, type Kea } from '../support/app.ts'
import { fakeAgentTerminal } from '../support/app-fake-agent.ts'
import type { RendererProbe } from '../support/app-leak.ts'
import { addProject, startSession, waitRow } from '../support/app-sessions.ts'
import { CpuWindow, footprints, keaProcesses, measureFor, median, ptyhostMirrors } from './app-harness.ts'

export const MIB = 2 ** 20
/** Footprint readings per checkpoint (their median, as the leak suite takes it). */
export const READINGS = 3

/** How long a batch of sessions may take to turn live and end its first turn: creations queue behind one another. */
const SESSIONS_MS = 6 * STEP_MS

/**
 * `n` more sessions from the composer, each started in the background (⌥⌘↵) as a person does; resolves with their ids
 * once every one is live and its agent's first turn has ended (the row no longer says working). The composer is closed
 * again (Esc), so the pane shows what it showed before.
 */
export async function startIdleSessions(kea: Kea, n: number, o: { from?: number } = {}): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await startSession(kea, `idle ${(o.from ?? 0) + i + 1}`, { background: true, open: i === 0 }))
  for (const id of ids) await waitRow(kea, id, 'live, its first turn ended', (r) => r.lifecycle === 'live' && r.status !== 'working', SESSIONS_MS)
  if (n > 0) {
    const page = await kea.page()
    await page.keyboard.press('Escape')
    await page.getByRole('region', { name: 'New session' }).waitFor({ state: 'detached', timeout: STEP_MS })
  }
  return ids
}

/** What `atRest` found: ptyhost's mirrors, the terminal views the window holds, and how long the wait took. */
export interface Rest {
  awake: number
  parked: number
  views: number
  waitedMs: number
}

/**
 * Wait until the app is at rest: every mirror the window holds no attached terminal view of is parked (no renderer and
 * no output for L.mirrorParkIdleMs), so idle sessions hold no terminal buffers. With no window, every mirror. A wait on
 * ptyhost's own report, never on time; it may take L.mirrorParkIdleMs and a harness step.
 */
export async function atRest(kea: Kea, o: { window: boolean }): Promise<Rest> {
  const t0 = Date.now()
  let last = { awake: NaN, parked: NaN, views: NaN }
  await until(
    'every mirror without a terminal view to be parked',
    async () => {
      const views = o.window ? (await kea.views()).filter((v) => v.attached).length : 0
      last = { ...(await ptyhostMirrors(kea)), views }
      return last.awake <= views || undefined
    },
    L.mirrorParkIdleMs + 3 * STEP_MS,
  ).catch((e: Error) => {
    throw new Error(`${e.message} (last: ${JSON.stringify(last)})`)
  })
  return { ...last, waitedMs: Date.now() - t0 }
}

/** One footprint checkpoint: the total, each role's share (summed over its processes), and the renderer processes alive. */
export interface Footprint {
  total: number
  byRole: Record<string, number>
  renderers: number
  processes: number
}

/** Every Kea process's footprint as it is now: one reading, nothing collected first (what Activity Monitor would show). */
export async function rawFootprint(kea: Kea): Promise<Footprint> {
  const procs = await keaProcesses(kea)
  const fp = await footprints(procs.map((r) => r.p))
  const byRole: Record<string, number> = {}
  let total = 0
  for (const { role, p } of procs) {
    const b = fp.get(p.pid) ?? 0
    byRole[role] = (byRole[role] ?? 0) + b
    total += b
  }
  return { total, byRole, renderers: (await kea.appMetrics()).filter((m) => m.type === 'Tab').length, processes: procs.length }
}

async function footprintOnce(kea: Kea, renderer: RendererProbe | null): Promise<Footprint> {
  await renderer?.settle()
  await kea.debug('core', 'gc')
  await kea.debug('ptyhost', 'gc')
  await kea.gcMain()
  return rawFootprint(kea)
}

/**
 * Every Kea process's footprint, summed, after forced GC everywhere: the reading with the median total of READINGS.
 * `renderer`: the window's probe, or null when no window is open (no renderer is left to settle).
 */
export async function settledFootprint(kea: Kea, renderer: RendererProbe | null): Promise<Footprint> {
  const readings: Footprint[] = []
  for (let i = 0; i < READINGS; i++) readings.push(await footprintOnce(kea, renderer))
  const totals = readings.map((r) => r.total)
  return readings[totals.indexOf(median(totals))] as Footprint
}

/** A footprint's roles as `<prefix><role>Mb` values for a recorded result. */
export function roleMb(f: Pick<Footprint, 'byRole'>, prefix = ''): Record<string, number> {
  return Object.fromEntries(Object.entries(f.byRole).map(([k, v]) => [`${prefix}${k}Mb`, v / MIB]))
}

/** The no-window budget's 20 idle sessions (P-MEM-5): every test of an app with no window measures these. */
export const NO_WINDOW_SESSIONS = 20

/**
 * The sessions of the tests of an app with no window, in a Kea whose default agent is the run's `claude`
 * (tools/fake-agent): a project at `repoRoot`, NO_WINDOW_SESSIONS sessions started from the composer, each idle at its
 * prompt after its first turn, and the first one's Agent terminal on screen (what a reopened window reattaches).
 * Resolves with their ids and that terminal.
 */
export async function noWindowSessions(kea: Kea, repoRoot: string): Promise<{ ids: string[]; agent: string }> {
  await addProject(kea, repoRoot)
  const ids = await startIdleSessions(kea, NO_WINDOW_SESSIONS)
  return { ids, agent: await fakeAgentTerminal(kea, ids[0] as string) }
}

/** How often the footprint is read as it stands until L.windowGoneFootprintMs (part of the method, not a limit). */
const GONE_POLL_MS = 1_000
/**
 * How many times L.windowGoneFootprintMs a window that has gone is watched for, to say when the budget was met; and the
 * shorter watch of a test that reads many windows going (the window-cycle leak test's checkpoints between its first and
 * last).
 */
export const GONE_WATCH_FACTOR = 3
export const GONE_WATCH_FACTOR_SHORT = 1.5

/** One footprint reading after the window went. */
export interface GoneReading extends Footprint {
  /** ms after the window went: when the reading began and when it was complete. */
  atMs: number
  doneMs: number
  /** Read after a forced GC in core, ptyhost and main (the median of READINGS), or as the processes stood. */
  settled: boolean
}

/** What a window that has gone is held to, as the no-window budget and the window-cycle leak test read it. */
export interface WindowGone {
  /** ms after the window went at which no renderer process was left (the caller holds it to L.windowGoneSettleMs). */
  rendererGoneMs: number
  /** The reading held to the budget: the settled footprint read L.windowGoneFootprintMs after the window went. */
  at: GoneReading
  /** Every reading, in order: as the processes stood until L.windowGoneFootprintMs, settled from then on. */
  readings: GoneReading[]
  /** ms after the window went at which a reading was first complete within the budget; null: none while it was watched. */
  withinMs: number | null
}

/**
 * The one reading of a window going: the window went at `wentAt` (`performance.now()` just before what took it away:
 * the close, the `⌘Q`, the sheet's button). No renderer process is waited for (within L.windowGoneSettleMs, or this
 * throws). Until `L.windowGoneFootprintMs` after `wentAt` the footprint is read as it stands, about once a second,
 * forcing nothing, so the reading that counts is not helped by the ones before it. At that time the settled footprint
 * is read (`settledFootprint`: forced GC in core, ptyhost and main, the median of READINGS): that reading, `at`, is the
 * one a test compares with the budget (P-MEM-5), whatever came before or comes after. If it is over `maxMb` the settled
 * footprint is read on, for up to `watchFactor` times L.windowGoneFootprintMs, only to report when the budget was met
 * (`withinMs`).
 */
export async function windowGone(kea: Kea, wentAt: number, maxMb: number, watchFactor: number = GONE_WATCH_FACTOR): Promise<WindowGone> {
  const since = () => performance.now() - wentAt
  await until('no renderer process', async () => (await kea.appMetrics()).every((m) => m.type !== 'Tab') || undefined, Math.max(1, L.windowGoneSettleMs - since()))
  const settleMs = L.windowGoneFootprintMs
  const rendererGoneMs = since()
  const readings: GoneReading[] = []
  const read = async (settled: boolean): Promise<GoneReading> => {
    const atMs = since()
    const f = settled ? await settledFootprint(kea, null) : await rawFootprint(kea)
    const r = { ...f, atMs, doneMs: since(), settled }
    readings.push(r)
    return r
  }
  // as the processes stand, until L.windowGoneFootprintMs; the last of these is complete before that time
  let slowest = 0
  while (since() + slowest + GONE_POLL_MS < settleMs) {
    const r = await read(false)
    slowest = Math.max(slowest, r.doneMs - r.atMs)
    // the next reading a second after this one began (the test's own measurement window: nothing is waited for)
    await measureFor(Math.max(0, Math.min(r.atMs + GONE_POLL_MS, settleMs - slowest) - since()))
  }
  await measureFor(Math.max(0, settleMs - since()))
  const at = await read(true)
  let last = at
  while (last.total > maxMb * MIB && since() < watchFactor * settleMs) last = await read(true)
  const within = readings.find((r) => r.total <= maxMb * MIB)
  return { rendererGoneMs, at, readings, withinMs: within ? within.doneMs : null }
}

/** A window-gone result's readings as one line: `t s total MB` each, the one held to the budget marked. */
export function goneSeries(g: WindowGone): string {
  return g.readings.map((r) => `${(r.atMs / 1000).toFixed(1)} s ${(r.total / MIB).toFixed(1)}${r === g.at ? ' ←' : r.settled ? '' : ' (raw)'}`).join(', ')
}

/** One window of an idle series: CPU over it, the machine's load at its end, and the footprint then (when asked for). */
export interface IdleWindow {
  /** Seconds from the series' start to this window's end. */
  atS: number
  seconds: number
  /** % of one core, every Kea process summed. */
  cpuPct: number
  cpuByRole: Record<string, number>
  /** The one-minute load average at the window's end: what else the machine was doing. */
  load: number
  footprint: Footprint | null
}

/**
 * The idle app watched for `windows` windows of `windowMs`, back to back: each window's CPU (every Kea process alive
 * through it, found afresh at its start), and with `footprint` the settled footprint at its end (read between two
 * windows, so its forced GCs are in neither). The idle CPU budgets take a few short windows; the 12 h soaks (C-SOAK-2,
 * L-MEM-17) the same code with more and longer ones. `renderer`: as for `settledFootprint`. `each` is told of every
 * window as it ends (a long run prints its progress and can fail early).
 */
export async function idleSeries(
  kea: Kea,
  o: { windows: number; windowMs: number; footprint?: boolean; renderer?: RendererProbe | null; each?: (w: IdleWindow, i: number) => void },
): Promise<IdleWindow[]> {
  const out: IdleWindow[] = []
  const t0 = performance.now()
  for (let i = 0; i < o.windows; i++) {
    const w = new CpuWindow(await keaProcesses(kea))
    await w.start()
    await measureFor(o.windowMs)
    const r = await w.stop()
    const win: IdleWindow = {
      atS: (performance.now() - t0) / 1000,
      seconds: r.seconds,
      cpuPct: r.total,
      cpuByRole: r.byRole,
      load: os.loadavg()[0] as number,
      footprint: o.footprint ? await settledFootprint(kea, o.renderer ?? null) : null,
    }
    out.push(win)
    o.each?.(win, i)
  }
  return out
}

/** The window of a series with the median CPU (the median run is compared with the budget). */
export function medianWindow(ws: readonly IdleWindow[]): IdleWindow {
  const cpu = ws.map((w) => w.cpuPct)
  return ws[cpu.indexOf(median(cpu))] as IdleWindow
}

/** A CPU window's roles as `<prefix><role>CpuPct` values for a recorded result. */
export function roleCpu(w: Pick<IdleWindow, 'cpuByRole'>, prefix = ''): Record<string, number> {
  return Object.fromEntries(Object.entries(w.cpuByRole).map(([k, v]) => [`${prefix}${k}CpuPct`, v]))
}
