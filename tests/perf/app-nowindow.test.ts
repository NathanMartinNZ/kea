// The idle app with no window, over many window cycles and over hours, against the real app (tests/support/app.ts): 20
// live sessions, each a worktree of a tools/repo-factory repository with tools/fake-agent as Claude Code idle at its
// prompt, made and measured as the budgets they are held to (tests/perf/app-idle.ts: the same sessions, the same
// footprint and CPU sampling as P-MEM-5 and P-CPU-2).
//
//   L-TERM-5   the window closed and reopened, then Kea sent to the menu bar and opened from it, over and over: after
//              every close no renderer process within L.windowGoneSettleMs, every reopen reattaches, the footprint
//              within P-MEM-5 at each checkpoint, and main's counts, heap and footprint flat (by the leak suite's
//              rules). 15 + 15 cycles in a routine run; 50 + 50 with KEA_LONG (tools/test-long.ts). The footprint held
//              to P-MEM-5 is the one the budget's own test holds (app-idle.ts `windowGone`): read
//              L.windowGoneFootprintMs after the window went. Main's own footprint is read after V8's memory-reducing
//              collection (the free pages V8 keeps come and go by megabytes with no window involved), with its owned
//              memory that is mapped nowhere in it counted (Electron leaves blocks of it behind when a menu-bar item is
//              removed while its title is drawn); and only with the display on (with it off, Electron's main
//              keeps memory per window until it comes on): `pnpm perf` and `pnpm test:long` keep it on, and the
//              test fails, judging nothing else, when it was off.
//   C-SOAK-2   12 h idle, the first half with the window closed, the second in the menu bar: CPU within P-CPU-2 in
//   L-MEM-17   every window and no memory growth (C-SOAK-2). The footprint within P-MEM-5 at every sample and never a
//              renderer process (L-MEM-17). One run serves both. Long tests, before a release: `pnpm test:long`
//              (tools/test-long.ts), which sets KEA_LONG and KEA_SOAK; KEA_LONG alone does not start them, so
//              `pnpm perf --long` (the two-hour GPU memory run) does not grow by twelve hours.
//              `KEA_IDLE_SOAK_MS=<ms>` runs the same code for that long instead (a smoke run of the method, as
//              KEA_GPU_SOAK_DURATION_MS is for the GPU memory run): its halves and windows shrink with it.
//
// These tests hold the app to budgets (P-MEM-5, P-CPU-2), and a budget is defined for the release bundle: so they live
// in the perf project, which launches it, not in the memory and chaos suites, which launch the dev build. `pnpm perf`
// runs the window-cycle test's routine cycles; `pnpm test:memory` and `pnpm chaos` run none.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { repoRoot, stillSame } from '../../tools/perf/src/launch.ts'
import { median, theilSen } from '../../tools/perf/src/stats.ts'
import { ensureBuild, envNumber, footprints, measureFor, ptyhostMirrors } from './app-harness.ts'
import { atRest, GONE_WATCH_FACTOR, GONE_WATCH_FACTOR_SHORT, goneSeries, idleSeries, MIB, NO_WINDOW_SESSIONS, noWindowSessions, READINGS, windowGone, type Footprint, type GoneReading, type IdleWindow, type WindowGone } from './app-idle.ts'
import { KeaRun, PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { AGENT_MARK, claudeByDefault } from '../support/app-fake-agent.ts'
import { BYTE_BUDGET, byteVerdict, expectCountsFlat, WARMUP_CYCLES, type LeakRun, type Reading } from '../support/app-leak.ts'
import { clickMenuBarItem, inMenuBar, NO_MENU_BAR, pressQuit, quitSheet } from '../support/app-menubar.ts'
import { skipWhere } from '../support/skip.ts'
import { need } from '../../packages/protocol/src/platform.ts'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { demoRepo } from '../support/app-sessions.ts'
import { LONG } from '../support/long.ts'

/** The session count: the sessions the no-window footprint budget's own test measures (app-idle.ts). */
const SESSIONS = NO_WINDOW_SESSIONS

/** Cycles and checkpoints per phase: 50 with KEA_LONG; a routine run does what fits its five minutes. */
const FULL_CYCLES = 50
const ROUTINE_CYCLES = 15
const FULL_CHECKPOINTS = 10
const ROUTINE_CHECKPOINTS = 5
/**
 * The time limits. A cycle takes a second or two; a checkpoint takes L.windowGoneFootprintMs (its reading is taken
 * then) and, when the budget is missed, up to half as long again to say when it was met (twice as long for the first
 * close and each phase's last). A routine run is about four minutes, five when no checkpoint ever meets the budget: its
 * limit leaves room for a slow machine, below the ten minutes at which a test outside KEA_LONG fails (long-guard.ts).
 */
const FULL_MS = 30 * 60_000
const ROUTINE_MS = 8 * 60_000

/**
 * The soak's 12 h (C-SOAK-2, L-MEM-17), or KEA_IDLE_SOAK_MS for a smoke run of the same code. A long test with a switch
 * of its own beside KEA_LONG (`pnpm test:long` sets both): `pnpm perf --long` sets KEA_LONG for this whole project.
 */
const SOAK_HOURS = 12
const SOAK_MS = envNumber('KEA_IDLE_SOAK_MS', SOAK_HOURS * 3_600_000)
const SOAK = (LONG && process.env.KEA_SOAK === '1') || process.env.KEA_IDLE_SOAK_MS !== undefined
/** A soak window: this long at most (144 over 12 h), and never shorter than the idle CPU windows. */
const SOAK_WINDOW_MAX_MS = 5 * 60_000
const SOAK_WINDOW_MIN_MS = 20_000
const SOAK_WINDOWS = 144
/**
 * Setting up, coming to rest twice and one settled footprint reading per window, on top of the soak's
 * duration: an hour. A smoke run took 250 s for 120 s of windows on a loaded machine; at that rate the 12 h run's 144
 * readings and two rests take most of ten minutes, so a tighter limit could cut off a run after twelve hours and lose
 * its verdict. The limit only bounds a run that hangs: a run that ends is as long as it is.
 */
const SOAK_SETUP_MS = 60 * 60_000
/** At rest this long before each half's first window, as the idle CPU tests are (their WARMUP_MS). */
const SOAK_REST_MS = 10_000

const runs: KeaRun[] = [] // bounded: the runs of this file's tests (one each)
afterEach(async () => {
  // the soak's run is shared by its two tests: it ends with the file
  for (const r of runs.splice(0)) await r.dispose()
})

/** Kea with `SESSIONS` idle sessions, the first one's Agent terminal on screen (what a reopened window reattaches). */
async function idleApp(run: KeaRun): Promise<{ kea: Kea; agent: string }> {
  ensureBuild()
  claudeByDefault(run)
  const kea = await run.launch()
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  const { agent } = await noWindowSessions(kea, demoRepo(run).root)
  return { kea, agent }
}

const rendererGone = (kea: Kea, ms: number) => until('no renderer process', async () => (await kea.appMetrics()).every((m) => m.type !== 'Tab') || undefined, ms)

// ── L-TERM-5 ────────────────────────────────────────────────────────────────────────────────────

type Line = { reports: Record<string, Record<string, unknown>>; missing: Record<string, unknown> }

function flatten(prefix: string, v: unknown, out: Record<string, number>): void {
  if (typeof v === 'number') out[prefix] = v
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) flatten(`${prefix}.${k}`, x, out)
}

/** Main's own GC hook (app/main/src/testHooks.ts), with V8's memory-reducing collection after the two forced ones. */
const reducedGcMain = (kea: Kea): Promise<void> => kea.app.evaluate(() => (globalThis as unknown as { __keaTest: { gc(how: { reduce: boolean }): void } }).__keaTest.gc({ reduce: true }))

/**
 * Main's owned memory that is mapped nowhere in it, in blocks (`/usr/bin/footprint`'s "Owned physical footprint
 * (unmapped)", read only, on the run's own main after an identity check): memory main made and handed to another
 * process (the menu bar's, the window server's), still counted in main's footprint. Electron leaves two or three such
 * blocks of 32 KB in main when a menu-bar item is removed while its title is drawn, so Kea clears the item's
 * title before removing it.
 */
async function ownedUnmapped(kea: Kea): Promise<number> {
  if (!stillSame(kea.main)) throw new Error(`pid ${kea.main.pid} is not the run's main any more`)
  return need(harnessOs.ownedUnmapped).blocks(kea.main.pid)
}

/**
 * The display's state from the power log (`pmset -g log`, read only): its last "Display is turned on/off" line (null:
 * none in the log), and every "off" line at or after `since` (ms since the epoch). With the display off Electron's main
 * keeps memory for each window made and closed until it comes on again, which is not Kea's: the window-cycle
 * test judges main only with the display on.
 */
function displayLog(since: number): Promise<{ on: boolean | null; offs: string[] }> {
  return need(harnessOs.powerLog).display(since)
}

/**
 * A checkpoint with no window: main after two forced GCs and V8's memory-reducing collection, the median of READINGS
 * readings of its heap and its footprint; its own counts (windows, IPC listeners, handles), its owned unmapped blocks
 * and, from one resource line, its registry rows (the menu-bar item, notification records, connection records,
 * menu states) with core's.
 */
async function mainPoint(kea: Kea): Promise<Reading> {
  const heap: number[] = []
  const footprint: number[] = []
  const counts: Record<string, number> = {}
  for (let i = 0; i < READINGS; i++) {
    await reducedGcMain(kea)
    const { heapUsed, ...own } = await kea.mainCounts()
    heap.push(heapUsed ?? NaN)
    footprint.push((await footprints([kea.main])).get(kea.main.pid) ?? NaN)
    for (const [k, v] of Object.entries(own)) counts[`main.${k}`] = v
  }
  counts['main.ownedUnmappedBlocks'] = await ownedUnmapped(kea)
  const line = (await kea.app.evaluate(() => (globalThis as unknown as { __keaTest: { resourceLine(): Promise<unknown> } }).__keaTest.resourceLine())) as Line
  flatten('main.report', line.reports.main, counts)
  flatten('core.report', line.reports.core, counts)
  // core and ptyhost, which a window's coming and going must leave as they were: their heaps, collected
  const child = async (proc: 'core' | 'ptyhost') => {
    await kea.debug(proc, 'gc')
    return ((await kea.debug(proc, 'heap')) as { heapUsed: number }).heapUsed
  }
  return { counts, bytes: { 'main.heap': median(heap), 'main.footprint': median(footprint), 'core.heap': await child('core'), 'ptyhost.heap': await child('ptyhost') } }
}

/**
 * The counts held to their baseline: everything of main's but its footprint samples (one more per resource line, up to
 * their cap) and the children running at the instant of the line; and what core holds per window (connection scopes,
 * store subscriptions, deltas pending for one). The rest of core's report moves with the sessions, not the window.
 */
const HELD = (k: string): boolean =>
  (k.startsWith('main.') && !k.startsWith('main.report.main.metricsSamples') && !k.startsWith('main.report.kit.children')) || /^core\.report\.core\.(connections|subscriptions|pendingDeltas)$/.test(k)

/** The checkpoint with the largest total. */
const largest = <T extends Footprint>(fs: readonly T[]): T => fs.reduce((a, b) => (b.total > a.total ? b : a))

/** The byte series held flat by the leak suite's byte rule. */
const JUDGED = ['main.heap', 'main.footprint', 'core.heap', 'ptyhost.heap']

interface Phase {
  run: LeakRun
  /** Every cycle's times: the renderer gone after the close, the reopened window's terminal attached. */
  goneMs: number[]
  attachedMs: number[]
  /**
   * Every checkpoint as `windowGone` reads it (app-idle.ts): the footprint read L.windowGoneFootprintMs after
   * the window went, which is the one held to the budget, every reading on the way, and when the total was first within
   * the budget.
   */
  gone: WindowGone[]
  /** The readings held to the budget, one per checkpoint (`gone[i].at`). */
  totals: GoneReading[]
}

/**
 * One phase of the window-cycle test: the canonical state is no window; a cycle opens one (`open`) and takes it away
 * again (`away`). WARMUP_CYCLES cycles, a baseline, then `checkpoints` batches of `cycles / checkpoints` cycles.
 */
async function windowPhase(o: { kea: Kea; agent: string; cycles: number; checkpoints: number; open: () => Promise<void>; away: () => Promise<void> }): Promise<Phase> {
  const { kea } = o
  const p: Phase = { run: { cycles: [], points: [] }, goneMs: [], attachedMs: [], gone: [], totals: [] }
  const maxMb = BUDGETS['P-MEM-5'].max
  const cycle = async () => {
    const t0 = performance.now()
    await o.open()
    // every reopen reattaches: the session's Agent terminal is on screen again, drawn from its snapshot
    expect(await kea.shown(), 'the terminal on screen in the reopened window').toBe(o.agent)
    await kea.waitScreen('the fake agent in the reopened window', (s) => s.includes(AGENT_MARK))
    p.attachedMs.push(performance.now() - t0)
    const t1 = performance.now()
    await o.away()
    // no renderer process within L.windowGoneSettleMs
    await rendererGone(kea, L.windowGoneSettleMs)
    p.goneMs.push(performance.now() - t1)
    return t1
  }
  const checkpoint = async (done: number, awayAt: number, last: boolean) => {
    // … and the footprint within the budget at that time (P-MEM-5): the reading begun L.windowGoneFootprintMs
    // after the window went is the one judged, as in the budget's own test (the same function); what was read before
    // and after is reported (a phase's last close is watched longest for when the budget was met)
    const g = await windowGone(kea, awayAt, maxMb, last ? GONE_WATCH_FACTOR : GONE_WATCH_FACTOR_SHORT)
    p.gone.push(g)
    p.totals.push(g.at)
    p.run.cycles.push(done)
    p.run.points.push(await mainPoint(kea))
  }
  let at = 0
  for (let i = 0; i < WARMUP_CYCLES; i++) at = await cycle()
  await checkpoint(0, at, false)
  const batch = o.cycles / o.checkpoints
  for (let c = 1; c <= o.checkpoints; c++) {
    for (let i = 0; i < batch; i++) at = await cycle()
    await checkpoint(c * batch, at, c === o.checkpoints)
  }
  return p
}

async function windowCycles(cycles: number, checkpoints: number): Promise<void> {
  // Judged only with the display on, from before the first window to the last reading
  const since = Date.now()
  const display = await displayLog(since)
  if (display.on === false) throw new Error('the display is off: L-TERM-5 judges main only with it on; `pnpm perf` and `pnpm test:long` keep it on (caffeinate -di), which cannot turn on a display that is already off')
  const run = KeaRun.create()
  runs.push(run)
  const { kea, agent } = await idleApp(run)
  const fromMenuBar = async () => {
    const opened = kea.app.waitForEvent('window', { timeout: STEP_MS })
    if (!(await clickMenuBarItem(kea, 'app.openKea'))) throw new Error('no Open Kea item in the menu bar')
    await opened
    await kea.whenReady()
  }

  // phase 1: the window closed as its close button does, and reopened as a click on the Dock icon does
  const firstWent = performance.now()
  await kea.closeWindow()
  // the first close: what the budget's own test judges (the same sessions, the same reading); here reported, the
  // checkpoints after the warm-up cycles are what this test holds
  const first = await windowGone(kea, firstWent, BUDGETS['P-MEM-5'].max)
  const closed = await windowPhase({ kea, agent, cycles, checkpoints, open: () => kea.reopenWindow().then(() => undefined), away: () => kea.closeWindow() })

  // phase 2: ⌘Q into the menu bar and Open Kea from its item; the first ⌘Q with a window asks once
  await kea.reopenWindow()
  await pressQuit(kea)
  await quitSheet(await kea.page()).getByRole('button', { name: 'Keep in Menu Bar' }).click({ timeout: STEP_MS })
  await inMenuBar(kea)
  const menuBar = await windowPhase({
    kea,
    agent,
    cycles,
    checkpoints,
    open: fromMenuBar,
    away: async () => {
      await pressQuit(kea)
      await inMenuBar(kea)
    },
  })

  const b = BUDGETS['P-MEM-5']
  const summary = (name: string, p: Phase) => {
    const heap = byteVerdict(p.run, 'main.heap')
    const fp = byteVerdict(p.run, 'main.footprint')
    return {
      phase: name,
      cycles: p.run.cycles.at(-1),
      goneMsMax: Math.round(Math.max(...p.goneMs)),
      reopenMsMedian: Math.round(median(p.attachedMs)),
      totalMbMax: +(Math.max(...p.totals.map((t) => t.total)) / MIB).toFixed(1),
      totalMbFirst: +((p.totals[0] as Footprint).total / MIB).toFixed(1),
      // each checkpoint: the reading held to the budget, when it began and was complete, each process's share, and
      // when a reading was first within the budget (null: not in the time it was watched)
      totalsMb: p.totals.map((t) => +(t.total / MIB).toFixed(1)),
      readAtMs: p.totals.map((t) => Math.round(t.atMs)),
      readDoneMs: p.totals.map((t) => Math.round(t.doneMs)),
      byRoleMb: Object.fromEntries(Object.keys(largest(p.totals).byRole).map((k) => [k, p.totals.map((t) => +((t.byRole[k] ?? 0) / MIB).toFixed(1))])),
      withinBudgetAfterMs: p.gone.map((g) => (g.withinMs === null ? null : Math.round(g.withinMs))),
      watchedMs: p.gone.map((g) => Math.round(g.readings.at(-1)?.doneMs ?? NaN)),
      coreHeapKb: p.run.points.map((x) => Math.round((x.bytes['core.heap'] as number) / 1024)),
      ptyhostHeapKb: p.run.points.map((x) => Math.round((x.bytes['ptyhost.heap'] as number) / 1024)),
      renderers: Math.max(...p.totals.map((t) => t.renderers)),
      mainHeapKb: p.run.points.map((x) => Math.round((x.bytes['main.heap'] as number) / 1024)),
      mainFootprintMb: p.run.points.map((x) => +((x.bytes['main.footprint'] as number) / MIB).toFixed(2)),
      mainOwnedUnmappedBlocks: p.run.points.map((x) => x.counts['main.ownedUnmappedBlocks']),
      mainHeap: { slopePerCycle: Math.round(heap.slopePerCycle), growth: heap.growth, ok: heap.ok },
      mainFootprint: { slopePerCycle: Math.round(fp.slopePerCycle), growth: fp.growth, ok: fp.ok },
    }
  }
  const phases = [summary('window closed', closed), summary('menu bar', menuBar)]
  const after = await displayLog(since)
  const series = (name: string, p: Phase) => p.gone.map((g, i) => `  ${name} checkpoint ${i} (after ${p.run.cycles[i]} cycles): ${goneSeries(g)}`).join('\n')
  console.info(
    `L-TERM-5 · budget ${b.max} MB at ${L.windowGoneFootprintMs / 1000} s; load ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}; display ${display.on === null ? 'not in the power log' : 'on'} at the start, turned off ${after.offs.length} times since\nfirst close ${JSON.stringify({ totalMb: +(first.at.total / MIB).toFixed(1), readAtMs: Math.round(first.at.atMs), withinBudgetAfterMs: first.withinMs === null ? null : Math.round(first.withinMs), rendererGoneMs: Math.round(first.rendererGoneMs), ...Object.fromEntries(Object.entries(first.at.byRole).map(([k, v]) => [k, +(v / MIB).toFixed(1)])) })}: ${goneSeries(first)}\n${JSON.stringify(phases)}\n${series('closed', closed)}\n${series('menu bar', menuBar)}`,
  )
  // A run in which the display turned off measured Electron, not Kea: nothing else is judged
  expect(after.offs, 'the display turned off during the run (pmset -g log): main keeps memory per window while it is off, so this run cannot judge Kea; run with the display on').toEqual([])
  const both = [['window closed', closed], ['menu bar', menuBar]] as const
  for (const [name, p] of both) {
    expect(p.run.cycles.at(-1), `${name}: cycles measured`).toBe(cycles)
    // while there is no window: no renderer process
    expect(p.totals.map((t) => t.renderers), `${name}: renderer processes at each checkpoint`).toEqual(p.totals.map(() => 0))
    // main flat across the cycles: its counts exactly, its heap and its footprint by the leak suite's byte rule; and
    // the heaps of core and ptyhost, which a window's coming and going leaves as they were
    expectCountsFlat(p.run, HELD)
    expect(JUDGED.map((k) => byteVerdict(p.run, k)).filter((v) => !v.ok), `${name}: byte growth over budget (slope ${BYTE_BUDGET.slopePerCycle} B/cycle and ${BYTE_BUDGET.absolute} B absolute)`).toEqual([])
  }
  // the menu-bar item is there in the second phase only, once
  expect(closed.run.points.map((x) => x.counts['main.report.main.menuBarItem']), 'menu-bar items while the window is only closed').toEqual(closed.run.points.map(() => 0))
  expect(menuBar.run.points.map((x) => x.counts['main.report.main.menuBarItem']), 'menu-bar items in the menu bar').toEqual(menuBar.run.points.map(() => 1))
  // … and the footprint within P-MEM-5 by L.windowGoneFootprintMs. Judged last and softly: a miss of the budget is
  // reported for both phases, with every process's share, after everything a leak would have failed
  for (const [name, p] of both) {
    const worst = largest(p.totals)
    expect
      .soft(worst.total / MIB, `${name}: total footprint ${Math.round(L.windowGoneFootprintMs / 1000)} s after the window went, at each checkpoint (MB): ${p.totals.map((t) => (t.total / MIB).toFixed(1)).join(', ')}; the largest by process: ${Object.entries(worst.byRole).map(([k, v]) => `${k} ${(v / MIB).toFixed(1)}`).join(', ')}; first within the budget after (ms; null: not while watched, ${GONE_WATCH_FACTOR_SHORT} × that time, ${GONE_WATCH_FACTOR} × for the last): ${p.gone.map((g) => (g.withinMs === null ? 'null' : Math.round(g.withinMs))).join(', ')}`)
      .toBeLessThanOrEqual(b.max)
  }
}

describe('window and menu-bar cycles with idle sessions (app)', () => {
  it.runIf(!LONG)(`L-TERM-5 · the window closed and reopened ${ROUTINE_CYCLES} times, then ⌘Q into the menu bar and Open Kea ${ROUTINE_CYCLES} times, with ${SESSIONS} idle sessions: every reopen reattaches; with no window, no renderer process within L.windowGoneSettleMs and the footprint within P-MEM-5; main's counts, heap and footprint flat`, async (ctx) => {
    skipWhere(ctx, NO_MENU_BAR)
    await windowCycles(ROUTINE_CYCLES, ROUTINE_CHECKPOINTS)
  }, ROUTINE_MS)

  it.runIf(LONG)(`L-TERM-5 · the row's ${FULL_CYCLES} + ${FULL_CYCLES} cycles (KEA_LONG): the window closed and reopened, then ⌘Q into the menu bar and Open Kea, with ${SESSIONS} idle sessions: every reopen reattaches; with no window, no renderer process within L.windowGoneSettleMs and the footprint within P-MEM-5; main's counts, heap and footprint flat`, async (ctx) => {
    skipWhere(ctx, NO_MENU_BAR)
    await windowCycles(FULL_CYCLES, FULL_CHECKPOINTS)
  }, FULL_MS)
})

// ── C-SOAK-2, L-MEM-17 ──────────────────────────────────────────────────────────────────────────

interface SoakHalf {
  mode: 'window closed' | 'menu bar'
  windows: IdleWindow[]
  /** Ptyhost's mirrors at the half's end. */
  mirrors: { awake: number; parked: number }
}

interface Soak {
  durationMs: number
  windowMs: number
  halves: SoakHalf[]
  /** The series as it was written, a line per window. */
  out: string
}

/** How a soak of `durationMs` is cut: two halves of `perHalf` windows of `windowMs` each. */
function soakPlan(durationMs: number): { windowMs: number; perHalf: number } {
  const windowMs = Math.min(SOAK_WINDOW_MAX_MS, Math.max(SOAK_WINDOW_MIN_MS, durationMs / SOAK_WINDOWS))
  return { windowMs, perHalf: Math.max(2, Math.round(durationMs / 2 / windowMs)) }
}

/**
 * The idle soak: `SESSIONS` idle sessions; the window closed and every mirror parked, then half of
 * `durationMs` like that and, after ⌘Q, half in the menu bar. Each half is `idleSeries` (the idle CPU windows), with
 * the settled footprint read between windows (the no-window footprint reading). Every window is appended to
 * `test-results/soak/` as it ends, so a run that is cut short leaves what it measured.
 */
async function runSoak(durationMs: number): Promise<Soak> {
  const run = KeaRun.create()
  soakRuns.push(run)
  const { kea } = await idleApp(run)
  const { windowMs, perHalf } = soakPlan(durationMs)
  const dir = path.join(repoRoot, 'test-results', 'soak')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `idle-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`)
  const half = async (mode: SoakHalf['mode']): Promise<SoakHalf> => {
    await rendererGone(kea, L.windowGoneSettleMs)
    await atRest(kea, { window: false })
    // as the idle CPU tests do: parking's own work is over before the first window opens
    await measureFor(SOAK_REST_MS)
    const windows = await idleSeries(kea, {
      windows: perHalf,
      windowMs,
      footprint: true,
      each: (w, i) => fs.appendFileSync(out, `${JSON.stringify({ mode, i, t: new Date().toISOString(), atS: Math.round(w.atS), cpuPct: w.cpuPct, cpuByRole: w.cpuByRole, load: w.load, totalMb: (w.footprint?.total ?? NaN) / MIB, byRoleMb: Object.fromEntries(Object.entries(w.footprint?.byRole ?? {}).map(([k, v]) => [k, v / MIB])), renderers: w.footprint?.renderers })}\n`),
    })
    return { mode, windows, mirrors: await ptyhostMirrors(kea) }
  }
  await kea.closeWindow()
  const closed = await half('window closed')
  // ⌘Q with no window goes straight to the menu bar: no window is opened in between, so nothing wakes
  await pressQuit(kea)
  await inMenuBar(kea)
  const menuBar = await half('menu bar')
  return { durationMs, windowMs, halves: [closed, menuBar], out }
}

const soakRuns: KeaRun[] = [] // bounded: the one run the two soak tests share
let soak: Promise<Soak> | null = null
const theSoak = (): Promise<Soak> => (soak ??= runSoak(SOAK_MS))

afterAll(async () => {
  await soak?.catch(() => undefined)
  soak = null
  for (const r of soakRuns.splice(0)) await r.dispose()
})

const soakName = SOAK_MS === SOAK_HOURS * 3_600_000 ? `${SOAK_HOURS} h` : `${Math.round(SOAK_MS / 60_000)} min (KEA_IDLE_SOAK_MS; the row is ${SOAK_HOURS} h)`

describe('idle soak with no window (app, Tier B, long)', () => {
  it.runIf(SOAK)(
    `C-SOAK-2 · ${SESSIONS} idle sessions left for ${SOAK_HOURS} h (KEA_IDLE_SOAK_MS overrides), half with the window closed and half in the menu bar: CPU of every Kea process summed within P-CPU-2 in every window, and no memory growth in either half`,
    async (ctx) => {
      skipWhere(ctx, NO_MENU_BAR)
      const s = await theSoak()
      const b = BUDGETS['P-CPU-2']
      const lines: string[] = []
      for (const h of s.halves) {
        const cpu = h.windows.map((w) => w.cpuPct)
        const total = h.windows.map((w) => (w.footprint as Footprint).total)
        // the leak suite's byte rule per minute, as the long terminal leak test and the GPU memory run apply it to a
        // level over time: growth is a slope of more than the absolute budget over the half and a last reading more
        // than that budget above the first
        const minutes = h.windows.map((w) => w.atS / 60)
        const span = Math.max(1, (minutes.at(-1) ?? 0) - (minutes[0] ?? 0))
        const points = total.map((v) => ({ counts: {}, bytes: { total: v } }))
        const grew = byteVerdict({ cycles: minutes, points }, 'total', { slopePerCycle: BYTE_BUDGET.absolute / span, absolute: BYTE_BUDGET.absolute })
        lines.push(`${h.mode}: ${h.windows.length} windows of ${Math.round(s.windowMs / 1000)} s; CPU median ${median(cpu).toFixed(2)} %, max ${Math.max(...cpu).toFixed(2)} % (≤ ${b.max}); footprint ${((total[0] as number) / MIB).toFixed(1)} → ${((total.at(-1) as number) / MIB).toFixed(1)} MB, slope ${(theilSen(minutes, total) / 1024).toFixed(1)} KB/min, ${grew.ok ? 'flat' : 'GREW'}; load ${median(h.windows.map((w) => w.load)).toFixed(1)}`)
        expect(Math.max(...cpu), `${h.mode}: CPU in the busiest window (% of one core; every window: ${cpu.map((c) => c.toFixed(2)).join(', ')})`).toBeLessThanOrEqual(b.max)
        expect(grew.ok, `${h.mode}: memory growth (slope ${grew.slopePerCycle.toFixed(0)} B/min, ${grew.growth} B from the first reading to the last)`).toBe(true)
      }
      console.info(`C-SOAK-2 · ${soakName}; series in ${s.out}\n  ${lines.join('\n  ')}`)
    },
    SOAK_MS + SOAK_SETUP_MS,
  )

  it.runIf(SOAK)(
    `L-MEM-17 · ${SESSIONS} idle sessions left for ${SOAK_HOURS} h (KEA_IDLE_SOAK_MS overrides), half with the window closed and half in the menu bar: at every sample the footprint of every Kea process within P-MEM-5, no renderer process, and every mirror still parked at the end`,
    async (ctx) => {
      skipWhere(ctx, NO_MENU_BAR)
      const s = await theSoak()
      const b = BUDGETS['P-MEM-5']
      const lines: string[] = []
      for (const h of s.halves) {
        const fps = h.windows.map((w) => w.footprint as Footprint)
        const total = fps.map((f) => f.total / MIB)
        const worst = fps[total.indexOf(Math.max(...total))] as Footprint
        lines.push(`${h.mode}: ${fps.length} samples; footprint min ${Math.min(...total).toFixed(1)}, median ${median(total).toFixed(1)}, max ${Math.max(...total).toFixed(1)} MB (≤ ${b.max}); at the max: ${Object.entries(worst.byRole).map(([k, v]) => `${k} ${(v / MIB).toFixed(1)}`).join(', ')}`)
        expect(fps.map((f) => f.renderers), `${h.mode}: renderer processes at each sample`).toEqual(fps.map(() => 0))
        expect(h.mirrors.awake, `${h.mode}: mirrors awake at its end (${h.mirrors.parked} parked)`).toBe(0)
      }
      console.info(`L-MEM-17 · ${soakName}; series in ${s.out}\n  ${lines.join('\n  ')}`)
      // the budget last and softly, so a miss is reported for both halves
      for (const h of s.halves) {
        const total = h.windows.map((w) => (w.footprint as Footprint).total / MIB)
        expect.soft(Math.max(...total), `${h.mode}: the largest footprint (MB; every sample: ${total.map((t) => t.toFixed(1)).join(', ')})`).toBeLessThanOrEqual(b.max)
      }
    },
    SOAK_MS + SOAK_SETUP_MS,
  )
})
