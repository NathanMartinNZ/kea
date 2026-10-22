// What many idle sessions cost, what an idle Kea costs, and whether 50 live sessions stay usable, on a release build
// launched unfocused on a fresh KEA_HOME (tests/perf/app-harness.ts). Every test needs sessions idle for
// L.mirrorParkIdleMs, so all share one launch (the "world" below): a tools/repo-factory project with a `start.sh`, then
// 1, 20 and 50 worktree sessions whose agent is tools/fake-agent as Claude Code, idle after one short turn
// (tests/perf/app-idle.ts). A test asks the world for its sessions and waits for rest; alone (`-t 'P-MEM-3 ·'`) it
// builds them, after others it adds to them, so the tests stand in the order the world grows. The chaos test C-RES-4 is
// here for the same 50 sessions, on the build the budgets are defined for.
//
//   P-MEM-1   one session, on screen; the footprint once it has stopped moving (the GPU helper holds some 300 MB more
//             for the first seconds after the window opens: recorded as `atLaunchMb`, not compared)
//   P-MEM-2   19 more sessions started in the background, never shown, their mirrors parked: the footprint's growth
//             per session, the window showing what it showed at P-MEM-1. Two figures are held to the budget, so the
//             larger decides: every process summed, and the session's own holder + ptyhost + core (the processes the
//             budget names). The sum alone is flattered by a baseline that drifts: main, GPU and renderer fall by some
//             10 MB between the two checkpoints, two minutes apart, and that fall would be credited to the sessions. A
//             checkpoint that never stopped moving fails the test: its difference means nothing
//   P-MEM-3   20 sessions, with the window's set of terminals full (one on screen and L.warmTerminals warm)
//   P-CPU-1   20 sessions, the window visible: CPU over RUNS windows, the median compared, and nothing periodic armed
//             in core; then, as a second case, with the dev server of the session on screen running and its port found
//             (the port scans slow down once a port is found)
//   P-CPU-2   20 sessions, the window closed, and as a second case Kea in the menu bar: CPU the same way, no renderer
//             process, and the timers that fire in main, core and ptyhost (tests/support/app-timers.ts), read by two
//             rules: no timers of one delay under a second firing more than once a second, and per process no more
//             than one fire a second of all timers with a delay under a second together. Every timer fire per second
//             per process is recorded beside them. The second case ends with the watch's controls: a stray interval
//             planted in each process (both rules must report it) and a timeout that re-arms itself with a new delay
//             each time (the first rule cannot see it; the second must)
//   P-MEM-3b  50 sessions, the window's set of terminals full
//   C-RES-4   50 sessions: idle CPU within the 20-session idle budget scaled by the session count (and, recorded, its
//             ratio to the idle CPU with 20 sessions in this same launch, when that test ran in it), the footprint
//             within the 50-session budget, and the app usable: keys typed in the session on screen echoed within the
//             echo budget's p99, parked sessions switched to within the cold-switch budget, the sidebar scrolled end to
//             end and its last row opened; through all of it the watched worktrees within their cap and the
//             WebGL contexts within theirs; and the footprint read again after all that use, six parked
//             sessions woken, once it has settled, held to the same budget

import { afterAll, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { STEP_MS, until, type Kea, type KeaRun } from '../support/app.ts'
import { AGENT_MARK, fakeAgentTerminal } from '../support/app-fake-agent.ts'
import { RendererProbe } from '../support/app-leak.ts'
import { clickMenuBarItem, inMenuBar, menuBar, NO_DOCK, NO_MENU_BAR, pressQuit, quitSheet } from '../support/app-menubar.ts'
import { skipWhere } from '../support/skip.ts'
import { startGlWatch, stopGlWatch } from '../support/app-render.ts'
import { commitFiles, serverAddress, serverScript, waitServer } from '../support/app-server.ts'
import { addProject, demoRepo, paneSession, selectSession, startSession, tabOf, waitRow } from '../support/app-sessions.ts'
import { callbacksPerSecond, fasterThan, fastFiresPerSecond, firesPerSecond, plantTimer, startTimerWatch, stopTimerWatch, timerLine, TIMER_PROCS, unplantTimers, type TimerProc, type TimerWatch } from '../support/app-timers.ts'
import { budget, check, disposeRuns, dist, echoLatencies, frames, KEY_WARMUP, measureFor, median, ptyhostMirrors, record, RUNS, startKea, unthrottle } from './app-harness.ts'
import { atRest, idleSeries, medianWindow, MIB, rawFootprint, READINGS, roleCpu, roleMb, settledFootprint, startIdleSessions, type Footprint, type IdleWindow, type Rest } from './app-idle.ts'
import { sysKey } from '../support/keys.ts'

/** The tests' session counts, as the budgets state them. */
const ONE = 1
const TWENTY = 20
const FIFTY = 50

/** CPU: after WARMUP_MS at rest, RUNS windows of WINDOW_MS; the median window is compared, as in app-cpu.test.ts. */
const WARMUP_MS = 10_000
const WINDOW_MS = 20_000
/** How long main's, core's and ptyhost's timers are watched (P-CPU-2 in each mode; P-CPU-1 with the dev server running). */
const TIMER_WATCH_MS = 10_000
/**
 * The no-window CPU test's controls: a stray timer of this period planted in each process (an interval; then a timeout
 * that re-arms itself a millisecond later each time), and how long each watch that must see it runs.
 */
const STRAY_MS = 250
const CONTROL_MS = 3_000

/** A footprint has settled when this many checkpoints in a row, SETTLE_GAP_MS apart, lie within SETTLE_BYTES of each other. */
const SETTLE_CHECKPOINTS = 3
const SETTLE_GAP_MS = 5_000
const SETTLE_BYTES = 3 * MIB
/** … and it is taken as it is after this long (the last checkpoint counts, and the result says it never settled). */
const SETTLE_MAX_MS = 60_000

/**
 * The 50-session test's time limit (C-RES-4). After the other tests it takes two to three minutes; run alone it starts
 * the 50 sessions itself and waits L.mirrorParkIdleMs for them, and the vitest default of five minutes is then too
 * close.
 */
const C_RES_4_MS = 8 * 60_000

/** C-RES-4: keys typed for the echo (after app-harness's unmeasured ones), parked sessions switched to, and one wheel step down the sidebar. */
const ECHO_KEYS = 200
const SWITCHES = 6
const WHEEL_STEP_PX = 240

/** The renderer's perf probes this file uses (app/renderer/src/lib/perf.ts). */
declare const __keaPerf: { resources(): Record<string, number>; armSwitch(ms?: number): Promise<number> }

type KitReport = Record<string, number | Record<string, number>>
const row = (r: KitReport, name: string): Record<string, number> => (typeof r[name] === 'object' ? (r[name] as Record<string, number>) : {})

/** A session's own processes and records: its holder, and what ptyhost and core hold of it (P-MEM-2). */
const OWN = (x: Footprint): number => (x.byRole.holder ?? 0) + (x.byRole.ptyhost ?? 0) + (x.byRole.core ?? 0)

/** A footprint that has stopped moving, the first checkpoint taken on the way, and how long it took. */
interface Settled {
  settled: Footprint
  first: Footprint
  settleMs: number
  stable: boolean
}

/**
 * Show a session's Agent terminal: the session selected, and its Agent tab clicked when the pane opened on another one
 * (a session opens on the tab it remembers: its Server tab, if that was the one shown last).
 */
async function showAgent(kea: Kea, id: string): Promise<string> {
  if ((await paneSession(await kea.page())) !== id) await selectSession(kea, id)
  const pty = await tabOf(kea, 'agent')
  if ((await kea.shown()) !== pty) await kea.clickTab(pty)
  await kea.waitScreen('the fake agent', (s) => s.includes(AGENT_MARK))
  return pty
}

class World {
  readonly run: KeaRun
  readonly kea: Kea
  /** The footprint as the window opened: one reading, nothing collected (the one-session test records it beside it). */
  readonly atLaunch: Footprint
  /** The sessions, oldest first; the first was started in the foreground. */
  readonly ids: string[] = []
  private probe: RendererProbe | null = null
  /** Checkpoints the tests share: taken once, by the first test that needs them. */
  private readonly taken = new Map<string, Settled>() // bounded: one entry per checkpoint name (five)
  /** The idle CPU with 20 sessions (P-CPU-1), once this launch measured it: the 50-session test compares with it. */
  twentyIdle: { idle: IdleWindow[]; rest: Rest } | null = null

  private constructor(run: KeaRun, kea: Kea, atLaunch: Footprint) {
    this.run = run
    this.kea = kea
    this.atLaunch = atLaunch
  }

  static async start(): Promise<World> {
    const { run, kea } = await startKea({ settings: { general: { defaultAgent: 'claude' } } })
    const atLaunch = await rawFootprint(kea)
    const repo = demoRepo(run)
    // every worktree gets a `start.sh` (the process zoo's stand-in dev server), so a session has its Run control
    commitFiles(repo.root, { 'start.sh': serverScript() }, { executable: true })
    await addProject(kea, repo.root)
    return new World(run, kea, atLaunch)
  }

  /** Grow to `n` sessions: the first in the foreground (it is on screen), the rest in the background, never shown. */
  async sessions(n: number): Promise<void> {
    if (this.ids.length > n) throw new Error(`the world already holds ${this.ids.length} sessions: a row for ${n} runs before the rows for more (they stand in that order)`)
    if (this.ids.length === n) return
    await this.window()
    if (this.ids.length === 0) {
      const id = await startSession(this.kea, 'idle 1')
      await waitRow(this.kea, id, 'live, its first turn ended', (r) => r.lifecycle === 'live' && r.status !== 'working')
      await fakeAgentTerminal(this.kea, id)
      this.ids.push(id)
    }
    if (this.ids.length < n) this.ids.push(...(await startIdleSessions(this.kea, n - this.ids.length, { from: this.ids.length })))
  }

  private async windows(): Promise<number> {
    return this.kea.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  }

  /** A window, reopened if a test closed it: Open Kea from the menu bar, or the Dock click. */
  async window(): Promise<void> {
    if ((await this.windows()) > 0) return
    if ((await menuBar(this.kea)).item) {
      const opened = this.kea.app.waitForEvent('window', { timeout: STEP_MS })
      if (!(await clickMenuBarItem(this.kea, 'app.openKea'))) throw new Error('no Open Kea item in the menu bar')
      await opened
      await this.kea.whenReady()
    } else await this.kea.reopenWindow()
    await unthrottle(this.kea)
  }

  /** The window's renderer over CDP (for its GC), opened on first use and again after the window was reopened. */
  async renderer(): Promise<RendererProbe> {
    await this.window()
    this.probe ??= await RendererProbe.open(this.kea)
    return this.probe
  }

  /** Let go of the renderer's CDP session: a CPU window is measured with nothing attached to the page. */
  async detach(): Promise<void> {
    await this.probe?.close()
    this.probe = null
  }

  private async rendererGone(): Promise<void> {
    await until('no renderer process', async () => (await this.kea.appMetrics()).every((m) => m.type !== 'Tab') || undefined)
  }

  /** Close the window as its close button does; resolves once no renderer process is left. */
  async closeWindow(): Promise<void> {
    await this.detach()
    if ((await this.windows()) > 0) await this.kea.closeWindow()
    await this.rendererGone()
  }

  /**
   * `⌘Q` into the menu bar. With a window open the first time, the first-quit sheet asks, and is answered
   * with its default; with no window (or once answered) `⌘Q` goes there directly.
   */
  async toMenuBar(): Promise<void> {
    await this.detach()
    if ((await menuBar(this.kea)).item && (await this.windows()) === 0) return
    const page = (await this.windows()) > 0 ? await this.kea.page() : null
    await pressQuit(this.kea)
    await until('the first-quit sheet answered, or Kea in the menu bar', async () => {
      if ((await this.windows()) === 0) return true
      const keep = page ? quitSheet(page).getByRole('button', { name: 'Keep in Menu Bar' }) : null
      if (!keep || (await keep.count()) === 0) return undefined
      await keep.click({ timeout: STEP_MS })
      return true
    })
    await inMenuBar(this.kea)
    await this.rendererGone()
  }

  /**
   * Fill the window's set of terminals: the newest session on screen and the three oldest warm, each shown
   * once in turn. With fewer than four sessions, every one.
   */
  async warm(): Promise<void> {
    await this.window()
    const last = this.ids.at(-1) as string
    const others = this.ids.slice(0, L.warmTerminals).filter((id) => id !== last)
    if ((await paneSession(await this.kea.page())) === last && (await this.kea.views()).length >= 1 + others.length && (await this.kea.shown()) === (await tabOf(this.kea, 'agent'))) return
    for (const id of [...others, last]) await showAgent(this.kea, id)
  }

  /** At rest: every mirror the window has no terminal view of is parked. */
  rest(): Promise<Rest> {
    return atRest(this.kea, { window: true })
  }

  /** The footprint once SETTLE_CHECKPOINTS checkpoints in a row agree, taken once per `name`, shared by the tests. */
  async footprint(name: string): Promise<Settled> {
    const had = this.taken.get(name)
    if (had) return had
    const renderer = await this.renderer()
    const t0 = Date.now()
    const points: Footprint[] = [await settledFootprint(this.kea, renderer)]
    const stable = () => {
      const tail = points.slice(-SETTLE_CHECKPOINTS).map((p) => p.total)
      return tail.length === SETTLE_CHECKPOINTS && Math.max(...tail) - Math.min(...tail) <= SETTLE_BYTES
    }
    while (!stable() && Date.now() - t0 < SETTLE_MAX_MS) {
      await measureFor(SETTLE_GAP_MS)
      points.push(await settledFootprint(this.kea, renderer))
    }
    const s: Settled = { settled: points.at(-1) as Footprint, first: points[0] as Footprint, settleMs: Date.now() - t0, stable: stable() }
    this.taken.set(name, s)
    return s
  }

  /** Core's resource report and its active handles. */
  async core(): Promise<{ kit: KitReport; handles: Record<string, number> }> {
    return { kit: (await this.kea.debug<KitReport>('core', 'kit')) ?? {}, handles: (await this.kea.debug<Record<string, number>>('core', 'handles')) ?? {} }
  }

  /**
   * What the reports show with every session but the window's own hidden: the window holds terminal views of
   * its own set only, `tree` and `git` of the one session on screen and at most one `server` store; core holds no
   * finder index and no transcript watcher (no agent is working); ptyhost keeps a mirror only where the window has a view.
   */
  async expectHiddenIsFree(): Promise<Record<string, number>> {
    const page = await this.kea.page()
    const renderer = await page.evaluate(() => __keaPerf.resources())
    const { kit } = await this.core()
    const mirrors = await ptyhostMirrors(this.kea)
    const views = (await this.kea.views()).filter((v) => v.attached).length
    const seen = {
      rendererTerminals: renderer['renderer.terminals'] ?? NaN,
      rendererFileStores: renderer['renderer.fileStores'] ?? NaN,
      rendererServerStores: renderer['renderer.serverStores'] ?? NaN,
      coreFinderIndexes: row(kit, 'core.files').finderIndexes ?? NaN,
      coreTranscriptWatches: row(kit, 'core.agents').transcriptWatches ?? NaN,
      mirrorsAwake: mirrors.awake,
      mirrorsParked: mirrors.parked,
    }
    expect(seen.rendererTerminals, 'terminal views: the session on screen and the warm ones').toBeLessThanOrEqual(1 + L.warmTerminals)
    expect(seen.rendererFileStores, '`tree` and `git` of the session on screen only').toBeLessThanOrEqual(2)
    expect(seen.rendererServerStores, '`server` stores followed').toBeLessThanOrEqual(1)
    expect(seen.coreFinderIndexes, 'finder indexes').toBe(0)
    expect(seen.coreTranscriptWatches, 'transcript watchers with no agent working').toBe(0)
    expect(seen.mirrorsAwake, 'mirrors awake: one per terminal view the window holds').toBeLessThanOrEqual(views)
    return seen
  }
}

let world: Promise<World> | null = null
const theWorld = (): Promise<World> => (world ??= World.start())

afterAll(async () => {
  const w = await world?.catch(() => null)
  world = null
  await w?.detach().catch(() => undefined)
  await disposeRuns()
})

/** A series' CPU as recorded values: the median window, the highest, and the median window's load and roles. */
function cpuValues(ws: readonly IdleWindow[]): Record<string, number> {
  const m = medianWindow(ws)
  return { cpuPct: m.cpuPct, cpuMaxPct: Math.max(...ws.map((w) => w.cpuPct)), load1: m.load, ...roleCpu(m) }
}

const settleNote = (s: Settled): string[] => (s.stable ? [] : [`the footprint was still moving after ${Math.round(s.settleMs / 1000)} s: the last checkpoint was taken`])
/** How many of the checkpoints a difference is taken between never settled: a check of its own, that fails the test. */
const unsettled = (...ss: Settled[]): number => ss.filter((s) => !s.stable).length

/** What core holds that could run by itself: timers, polls, status runs, git children, dev servers and their port scans. */
interface CoreIdle {
  timers: number
  timeoutHandles: number
  watchPolls: number
  statusRuns: number
  gitChildren: number
  serversLive: number
  scanTimers: number
}
const CORE_AT_REST: CoreIdle = { timers: 0, timeoutHandles: 0, watchPolls: 0, statusRuns: 0, gitChildren: 0, serversLive: 0, scanTimers: 0 }

async function coreIdle(w: World): Promise<CoreIdle> {
  const { kit, handles } = await w.core()
  return {
    timers: kit['kit.timers'] as number,
    timeoutHandles: handles.Timeout ?? 0,
    watchPolls: row(kit, 'core.watch').polls ?? NaN,
    statusRuns: (row(kit, 'core.files').statusRunning ?? NaN) + (row(kit, 'core.files').statusPending ?? NaN),
    gitChildren: (row(kit, 'kit.children')['git.active'] ?? NaN) + (row(kit, 'kit.children')['git.queued'] ?? NaN),
    serversLive: row(kit, 'core.servers').live ?? NaN,
    scanTimers: (row(kit, 'core.servers').scanTimers ?? NaN) + (row(kit, 'core.servers').scans ?? NaN),
  }
}

/**
 * Core with nothing armed: no timer, no poll, no status run, no git child, no port scan. A timer that re-arms
 * itself is there at every look, so this waits (a harness step at most) for one look that finds none.
 */
async function coreAtRest(w: World, what: string): Promise<void> {
  let last: CoreIdle | null = null
  await until(what, async () => {
    last = await coreIdle(w)
    return JSON.stringify(last) === JSON.stringify(CORE_AT_REST) || undefined
  }).catch((e: Error) => {
    throw new Error(`${e.message}: core still holds ${JSON.stringify(last)}`)
  })
}

/** P-CPU-2, one mode with no window: at rest, WARMUP_MS, the CPU windows, then the timers (their hook is never on during a CPU window). */
interface Windowless {
  rest: Rest
  cpu: IdleWindow[]
  timers: Record<TimerProc, TimerWatch>
  renderers: number
}

async function windowless(kea: Kea): Promise<Windowless> {
  const rest = await atRest(kea, { window: false })
  await measureFor(WARMUP_MS)
  const cpu = await idleSeries(kea, { windows: RUNS, windowMs: WINDOW_MS })
  await startTimerWatch(kea)
  await measureFor(TIMER_WATCH_MS)
  const timers = await stopTimerWatch(kea)
  return { rest, cpu, timers, renderers: (await kea.appMetrics()).filter((m) => m.type === 'Tab').length }
}

/** Record one windowless mode against P-CPU-2 and assert it. */
function expectWindowless(id: string, mode: string, how: string, m: Windowless): void {
  const b = budget('P-CPU-2')
  const fast = Object.fromEntries(TIMER_PROCS.map((p) => [p, fasterThan(m.timers[p], b.max_timer_hz)]))
  const values: Record<string, number> = { ...cpuValues(m.cpu), renderers: m.renderers, mirrorsAwake: m.rest.awake, mirrorsParked: m.rest.parked, parkWaitS: m.rest.waitedMs / 1000, fastTimers: Object.values(fast).flat().length }
  for (const p of TIMER_PROCS) {
    values[`${p}FastFiresPerS`] = fastFiresPerSecond(m.timers[p], b.max_timer_hz)
    values[`${p}TimersPerS`] = firesPerSecond(m.timers[p])
    values[`${p}CallbacksPerS`] = callbacksPerSecond(m.timers[p])
  }
  const e = record({
    id,
    metric: `${b.metric}: ${mode}`,
    method: `${TWENTY} idle sessions (tools/fake-agent as Claude Code); ${how}; once ptyhost reports every mirror parked: ${WARMUP_MS / 1000} s, then the CPU time (ps) of every Kea process — Electron's and the holders, not the shells and agents — over ${RUNS} windows of ${WINDOW_MS / 1000} s, summed, the median window; then every timer that fires in main, core and ptyhost over ${TIMER_WATCH_MS / 1000} s, by delay (an async hook reading each Timeout as it runs; tests/support/app-timers.ts), by two rules: no timers of one delay under 1 / ${b.max_timer_hz} s may fire more than ${b.max_timer_hz} × a second (fastTimers), and in each process all timers with such a delay together may not (<process>FastFiresPerS: a timeout re-armed with a new delay each time, or several short timers side by side). <process>TimersPerS is every timer fire, the long ones' too, and <process>CallbacksPerS every other asynchronous callback: recorded, not judged. Not seen by the timer watch: timers that never enter JavaScript (Chromium's own in main, a polled file watch, the holders' poll timeouts), a worker thread's timers, and the GPU and network helpers; their CPU the windows do count`,
    values,
    checks: [
      check('cpuPct', values.cpuPct as number, b.max, 'max', b.unit),
      check('fastTimers', values.fastTimers as number, 0, 'max', 'timers'),
      ...TIMER_PROCS.map((p) => check(`${p}FastFiresPerS`, values[`${p}FastFiresPerS`] as number, b.max_timer_hz, 'max', 'Hz')),
    ],
    notes: TIMER_PROCS.map((p) => `${p}: ${timerLine(m.timers[p])}`),
  })
  expect(m.renderers, 'renderer processes with no window').toBe(0)
  expect(m.rest.awake, 'mirrors awake with no window').toBe(0)
  expect(fast, `timers faster than ${b.max_timer_hz} Hz`).toEqual({ main: [], core: [], ptyhost: [] })
  for (const p of TIMER_PROCS) expect(values[`${p}FastFiresPerS`], `${p}: fires per second of every timer with a delay under ${1000 / b.max_timer_hz} ms together (${timerLine(m.timers[p])})`).toBeLessThanOrEqual(b.max_timer_hz)
  expect(e.pass, JSON.stringify(e.values)).toBe(true)
}

describe('many idle sessions (app)', () => {
  it('P-MEM-1 · the window open, one project and one idle session: the footprint of every Kea process, once it has settled, within budget', async () => {
    const w = await theWorld()
    await w.sessions(ONE)
    const one = await w.footprint('one')
    const hidden = await w.expectHiddenIsFree()
    const b = budget('P-MEM-1')
    const values = {
      totalMb: one.settled.total / MIB,
      ...roleMb(one.settled),
      settleS: one.settleMs / 1000,
      firstCheckpointMb: one.first.total / MIB,
      atLaunchMb: w.atLaunch.total / MIB,
      atLaunchGpuMb: (w.atLaunch.byRole.gpu ?? 0) / MIB,
      processes: one.settled.processes,
      ...hidden,
    }
    const e = record({
      id: 'P-MEM-1',
      metric: b.metric,
      method: `one project, one session started from the composer (tools/fake-agent as Claude Code, idle at its prompt after one turn) on screen, plus the first launch's shell, still warm; physical footprint of every Kea process (Electron's and the holders) summed after forced GC in each, median of ${READINGS} readings per checkpoint; the checkpoint once ${SETTLE_CHECKPOINTS} in a row, ${SETTLE_GAP_MS / 1000} s apart, lie within ${SETTLE_BYTES / MIB} MiB. atLaunchMb is one reading as the first shell's prompt appeared, nothing collected: the GPU helper holds a few hundred MB more for the first seconds of a window`,
      values,
      checks: [check('totalMb', values.totalMb, b.max, 'max', b.unit)],
      notes: settleNote(one),
    })
    expect(e.pass, JSON.stringify(e.values)).toBe(true)
  })

  it(`P-MEM-2 · ${TWENTY - ONE} more idle sessions, never shown, their mirrors parked: per session, neither the footprint of every Kea process nor that of holder + ptyhost + core grows by more than the budget, between two checkpoints that both settled`, async () => {
    const w = await theWorld()
    await w.sessions(ONE)
    const one = await w.footprint('one')
    await w.sessions(TWENTY)
    const rest = await w.rest()
    const twenty = await w.footprint('twenty')
    const hidden = await w.expectHiddenIsFree()
    const added = TWENTY - ONE
    const per = (f: (x: Footprint) => number) => (f(twenty.settled) - f(one.settled)) / added / MIB
    const perRole: Record<string, number> = {}
    for (const role of Object.keys(twenty.settled.byRole)) perRole[`${role}PerSessionMb`] = per((x) => x.byRole[role] ?? 0)
    const b = budget('P-MEM-2')
    const values = {
      perSessionMb: per((x) => x.total),
      // a session's own cost: its holder, and ptyhost's and core's records of it (what the budget names)
      holderPtyhostCorePerSessionMb: per(OWN),
      ...perRole,
      oneTotalMb: one.settled.total / MIB,
      twentyTotalMb: twenty.settled.total / MIB,
      oneOwnMb: OWN(one.settled) / MIB,
      twentyOwnMb: OWN(twenty.settled) / MIB,
      oneSettleS: one.settleMs / 1000,
      twentySettleS: twenty.settleMs / 1000,
      unsettledCheckpoints: unsettled(one, twenty),
      parkWaitS: rest.waitedMs / 1000,
      ...hidden,
    }
    const e = record({
      id: 'P-MEM-2',
      metric: b.metric,
      method: `the settled footprint with one session (P-MEM-1's checkpoint), then ${added} more started from the composer in the background and never shown; once ptyhost reports every mirror without a terminal view parked, the settled footprint again, the window showing what it showed before; (the second − the first) / ${added}, for every Kea process summed, for holder + ptyhost + core, and for each role. Both of the first two are compared with the budget (the larger decides: the sum is lowered by whatever main, GPU and renderer let go between the checkpoints, which is not the sessions' doing); a checkpoint that was still moving after ${SETTLE_MAX_MS / 1000} s fails the row`,
      values,
      checks: [
        check('perSessionMb', values.perSessionMb, b.max, 'max', b.unit),
        check('holderPtyhostCorePerSessionMb', values.holderPtyhostCorePerSessionMb, b.max, 'max', b.unit),
        check('unsettledCheckpoints', values.unsettledCheckpoints, 0, 'max', 'checkpoints'),
      ],
      notes: [...settleNote(one), ...settleNote(twenty)],
    })
    expect(hidden.mirrorsParked, 'parked mirrors: every session never shown').toBeGreaterThanOrEqual(added)
    expect(values.unsettledCheckpoints, 'checkpoints of the difference that were still moving when taken').toBe(0)
    expect(e.pass, JSON.stringify(e.values)).toBe(true)
  })

  it(`P-MEM-3 · ${TWENTY} idle sessions, the window open with its set of terminals full: the footprint of every Kea process within budget`, async () => {
    const w = await theWorld()
    await w.sessions(TWENTY)
    await w.warm()
    const rest = await w.rest()
    const full = await w.footprint('twenty, terminals full')
    const hidden = await w.expectHiddenIsFree()
    const b = budget('P-MEM-3')
    const values = { totalMb: full.settled.total / MIB, ...roleMb(full.settled), settleS: full.settleMs / 1000, processes: full.settled.processes, views: rest.views, ...hidden }
    const e = record({
      id: 'P-MEM-3',
      metric: b.metric,
      method: `${TWENTY} sessions (tools/fake-agent as Claude Code, each idle at its prompt in a worktree of its own); the newest on screen and the ${L.warmTerminals} oldest shown once each, so the window holds its full set of warm terminals; every other mirror parked; physical footprint of every Kea process summed after forced GC in each, median of ${READINGS} readings, once ${SETTLE_CHECKPOINTS} checkpoints in a row lie within ${SETTLE_BYTES / MIB} MiB`,
      values,
      checks: [check('totalMb', values.totalMb, b.max, 'max', b.unit)],
      notes: settleNote(full),
    })
    expect(rest.views, 'terminal views in the window').toBe(1 + L.warmTerminals)
    expect(e.pass, JSON.stringify(e.values)).toBe(true)
  })

  it(`P-CPU-1 · ${TWENTY} idle sessions, the window visible: CPU of every Kea process summed (the median window) within budget, with nothing periodic armed in core`, async () => {
    const w = await theWorld()
    await w.sessions(TWENTY)
    await w.warm()
    const rest = await w.rest()
    await w.detach()
    await measureFor(WARMUP_MS)
    await coreAtRest(w, 'core at rest before the windows')
    const idle = await idleSeries(w.kea, { windows: RUNS, windowMs: WINDOW_MS })
    await coreAtRest(w, 'core at rest after the windows')
    w.twentyIdle = { idle, rest }
    const b = budget('P-CPU-1')
    const values = { ...cpuValues(idle), views: rest.views, mirrorsAwake: rest.awake, mirrorsParked: rest.parked, parkWaitS: rest.waitedMs / 1000 }
    const e = record({
      id: 'P-CPU-1',
      metric: b.metric,
      method: `${TWENTY} idle sessions (tools/fake-agent as Claude Code), the window visible (rendering even when covered) with its full set of warm terminals, every other mirror parked; ${WARMUP_MS / 1000} s, then the CPU time (ps) of every Kea process — Electron's and the holders, not the shells and agents — over ${RUNS} windows of ${WINDOW_MS / 1000} s, summed, the median window; before and after, core's resource report shows no timer, poll, status run, git child or port scan`,
      values,
      checks: [check('cpuPct', medianWindow(idle).cpuPct, b.max, 'max', b.unit)],
    })
    expect(e.pass, JSON.stringify(e.values)).toBe(true)
  })

  it(`P-CPU-1 · ${TWENTY} idle sessions and the dev server of the session on screen running, its port found: CPU within the same budget, the port scans at their slow interval, and none left once the server stops`, async () => {
    const w = await theWorld()
    await w.sessions(TWENTY)
    await w.warm()
    const rest = await w.rest()
    await w.detach()
    const { kea } = w
    const page = await kea.page()
    // ⌘R in the session on screen; once its first port is found the scans slow down
    await page.keyboard.press(sysKey('Meta+r'))
    await waitServer(kea, 'running')
    const at = await serverAddress(kea)
    // the settling time doubles as a watch over core's timers: a scan still on its fast interval would fire in it
    await startTimerWatch(kea)
    await measureFor(Math.max(WARMUP_MS, 2 * L.portScanFastMs))
    const timers = await stopTimerWatch(kea)
    const serving = await idleSeries(kea, { windows: RUNS, windowMs: WINDOW_MS })
    const during = await coreIdle(w)
    await page.keyboard.press(sysKey('Meta+r'))
    await waitServer(kea, 'stopped')
    await coreAtRest(w, 'the scans to end with the server')

    const b = budget('P-CPU-1')
    const fastScans = timers.core.timers.filter((t) => t.delayMs === L.portScanFastMs).reduce((n, t) => n + t.fired, 0)
    const values = { ...cpuValues(serving), serverPort: at.port, scanTimers: during.scanTimers, fastScans, views: rest.views }
    const e = record({
      id: 'P-CPU-1 (dev server running)',
      metric: `${b.metric}, one dev server running`,
      method: `as P-CPU-1, with the dev server of the session on screen started with ⌘R (the process zoo's server as start.sh) and its port found; ${WARMUP_MS / 1000} s, in which core's timers are watched (tests/support/app-timers.ts), then ${RUNS} windows of ${WINDOW_MS / 1000} s, the median. A port scan's own child process (kea-helper ports, a few ms every ${L.portScanSlowMs / 1000} s) is not in the sum; core's share of it is. The server's own CPU is the person's program's, and not counted`,
      values,
      checks: [check('cpuPct', medianWindow(serving).cpuPct, b.max, 'max', b.unit)],
      notes: [`core: ${timerLine(timers.core)}`],
    })
    expect(during.serversLive, 'dev servers alive').toBe(1)
    expect(during.scanTimers, 'port-scan timers and scans in flight: the one slow timer').toBeLessThanOrEqual(1)
    expect(fastScans, `scans on the fast interval (${L.portScanFastMs} ms) after the port was found`).toBe(0)
    expect(e.pass, JSON.stringify(e.values)).toBe(true)
  })

  it(`P-CPU-2 · ${TWENTY} idle sessions, the window closed: no renderer process, CPU of every Kea process summed (the median window) within budget, and in main, core and ptyhost no timer faster than the budget's rate, nor all the timers under its period together`, async (ctx) => {
    skipWhere(ctx, NO_DOCK)
    const w = await theWorld()
    await w.sessions(TWENTY)
    await w.closeWindow()
    expectWindowless('P-CPU-2', 'the window closed', 'the window closed as its close button does', await windowless(w.kea))
  })

  it(`P-CPU-2 · ${TWENTY} idle sessions, Kea in the menu bar: no renderer process, CPU within the same budget, no timer faster than the budget's rate nor all the short ones together; and the timer watch's controls: a stray ${STRAY_MS} ms interval planted in each process trips both rules, a timeout re-armed with a new delay each time trips the second`, async (ctx) => {
    skipWhere(ctx, NO_MENU_BAR)
    const w = await theWorld()
    await w.sessions(TWENTY)
    await w.toMenuBar()
    const { kea } = w
    expectWindowless('P-CPU-2 (menu bar)', 'Kea in the menu bar', '⌘Q into the menu bar (from a closed window when the case before this one ran, else from the open one with the first-quit sheet answered Keep in Menu Bar)', await windowless(kea))

    const hz = budget('P-CPU-2').max_timer_hz
    const controlled = async (wander: boolean) => {
      for (const p of TIMER_PROCS) await plantTimer(kea, p, STRAY_MS, wander)
      await startTimerWatch(kea)
      await measureFor(CONTROL_MS)
      const seen = await stopTimerWatch(kea)
      await unplantTimers(kea)
      return seen
    }
    // the first control: a stray interval in each process is seen by the same watch, by both rules, and only it
    const control = await controlled(false)
    for (const p of TIMER_PROCS) {
      expect(fasterThan(control[p], hz).map((t) => t.delayMs), `the control: the ${STRAY_MS} ms interval planted in ${p} is seen (${timerLine(control[p])})`).toEqual([STRAY_MS])
      expect(fastFiresPerSecond(control[p], hz), `the control: the ${STRAY_MS} ms interval planted in ${p} trips the rule on all short timers together (${timerLine(control[p])})`).toBeGreaterThan(hz)
    }
    // the second: a timeout that re-arms itself a millisecond later each time. No delay fires twice, so the rule by
    // delay reports nothing (what it cannot see); the rule on all short timers together must
    const wandering = await controlled(true)
    for (const p of TIMER_PROCS) {
      expect(fasterThan(wandering[p], hz), `the control: no one delay of the re-arming timeout planted in ${p} fires twice (${timerLine(wandering[p])})`).toEqual([])
      expect(fastFiresPerSecond(wandering[p], hz), `the control: the re-arming timeout planted in ${p} trips the rule on all short timers together (${timerLine(wandering[p])})`).toBeGreaterThan(hz)
    }
    await w.window()
  })

  it(`P-MEM-3b · ${FIFTY} idle sessions, the window open with its set of terminals full: the footprint of every Kea process within budget`, async () => {
    const w = await theWorld()
    // with the 20-session checkpoint of the same launch: the growth per session over the sessions added (information
    // only; the per-session budget is P-MEM-2)
    const before = w.ids.length === TWENTY ? await w.warm().then(() => w.rest()).then(() => w.footprint('twenty, terminals full')) : null
    await w.sessions(FIFTY)
    await w.warm()
    const rest = await w.rest()
    const fifty = await w.footprint('fifty, terminals full')
    const hidden = await w.expectHiddenIsFree()
    const b = budget('P-MEM-3b')
    const values: Record<string, number> = { totalMb: fifty.settled.total / MIB, ...roleMb(fifty.settled), settleS: fifty.settleMs / 1000, processes: fifty.settled.processes, views: rest.views, parkWaitS: rest.waitedMs / 1000, ...hidden }
    // (a difference between checkpoints is recorded only when both settled: one still moving would say nothing)
    const comparable = before !== null && unsettled(before, fifty) === 0
    if (before && comparable) {
      const per = (f: (x: Footprint) => number) => (f(fifty.settled) - f(before.settled)) / (FIFTY - TWENTY) / MIB
      values.perSessionFrom20Mb = per((x) => x.total)
      values.holderPtyhostCorePerSessionFrom20Mb = per(OWN)
    }
    const e = record({
      id: 'P-MEM-3b',
      metric: b.metric,
      method: `${FIFTY} sessions (tools/fake-agent as Claude Code, each idle at its prompt in a worktree of its own); the newest on screen and the ${L.warmTerminals} oldest shown once each, so the window holds its full set of warm terminals; every other mirror parked; physical footprint of every Kea process summed after forced GC in each, median of ${READINGS} readings, once ${SETTLE_CHECKPOINTS} checkpoints in a row lie within ${SETTLE_BYTES / MIB} MiB`,
      values,
      checks: [check('totalMb', values.totalMb as number, b.max, 'max', b.unit)],
      notes: [...settleNote(fifty), ...(before && !comparable ? ['the growth per session from 20 is not recorded: one of its two checkpoints never settled'] : [])],
    })
    expect(rest.views, 'terminal views in the window').toBe(1 + L.warmTerminals)
    expect(hidden.mirrorsParked, 'parked mirrors').toBeGreaterThanOrEqual(FIFTY - (1 + L.warmTerminals))
    expect(e.pass, JSON.stringify(e.values)).toBe(true)
  })

  it(`C-RES-4 · ${FIFTY} live sessions: idle CPU within P-CPU-1 scaled by the session count and the footprint within P-MEM-3b; the app usable (typing echoed within P-TERM-1's p99, parked sessions switched to within P-TERM-8, the sidebar scrolled end to end and its last row opened); the watched worktrees within their cap and the WebGL contexts within P-GPU-1 throughout; the footprint still within P-MEM-3b after that use`, async () => {
    const w = await theWorld()
    // the idle CPU with 20 sessions in this launch, to set the 50-session reading against: the idle test's (P-CPU-1),
    // when it ran before this test (the whole file, or `-t 'P-CPU-1 ·|C-RES-4'`). Run alone the test has none: taking
    // one on the way to 50 would cost L.mirrorParkIdleMs a second time and make this a long test
    const twenty = w.twentyIdle ? medianWindow(w.twentyIdle.idle) : null
    await w.sessions(FIFTY)
    await w.warm()
    await w.rest()
    const fifty = await w.footprint('fifty, terminals full')
    await w.detach()
    const { kea } = w
    const page = await kea.page()
    const watch = async () => row((await w.core()).kit, 'core.watch')

    // idle CPU: the idle budget is for 20 sessions (P-CPU-1); scaled linearly, 50 sessions are allowed 50 / 20 of it
    // (an upper bound; the ratio to this launch's own 20-session reading is recorded with it)
    await measureFor(WARMUP_MS)
    const idle = await idleSeries(kea, { windows: RUNS, windowMs: WINDOW_MS })
    const cpu = budget('P-CPU-1')
    const cpuLimit = (cpu.max * FIFTY) / TWENTY

    // usable, 1: typing. A shell tab of the session on screen running cat, as the echo budget measures it (P-TERM-1)
    const agent = await kea.shown()
    const shell = await kea.newTab()
    await kea.enter('cat')
    const echo = dist(await echoLatencies(kea, ECHO_KEYS))
    await kea.press('Control+c')

    // usable, 2: switching to sessions never shown (their mirrors parked), by ⌘1…⌘9 as the cold-switch budget times it
    // (P-TERM-8)
    await startGlWatch(kea)
    let watched = (await watch()).worktrees ?? NaN
    const order = await page.evaluate(() => [...document.querySelectorAll('[role=treeitem][data-session-id]')].map((e) => e.getAttribute('data-session-id') ?? ''))
    const viewed = new Set([...w.ids.slice(0, L.warmTerminals), w.ids.at(-1)])
    const cold = [...order.keys()].slice(0, 9).filter((k) => !viewed.has(order[k])).slice(0, SWITCHES)
    const switches: number[] = []
    for (const k of cold) {
      const switched = page.evaluate((ms) => __keaPerf.armSwitch(ms), STEP_MS)
      await kea.press(sysKey(`Meta+${k + 1}`))
      switches.push(await switched)
      await until(`row ${k + 1} in the main pane`, async () => (await paneSession(page)) === order[k] || undefined)
      await kea.waitScreen(`row ${k + 1}: the fake agent`, (s) => s.includes(AGENT_MARK))
      watched = Math.max(watched, (await watch()).worktrees ?? NaN)
    }

    // usable, 3: the sidebar scrolls from its first row to its last and back, a wheel step at a time
    const body = page.locator('.sidebar-body')
    const box = await body.boundingBox({ timeout: STEP_MS })
    if (!box) throw new Error('no sidebar')
    const scroll = () => body.evaluate((e) => ({ top: e.scrollTop, max: e.scrollHeight - e.clientHeight }))
    const inView = (id: string) =>
      page.evaluate((sid) => {
        const r = document.querySelector(`[role=treeitem][data-session-id="${sid}"]`)?.getBoundingClientRect()
        const s = document.querySelector('.sidebar-body')?.getBoundingClientRect()
        return !!r && !!s && r.top >= s.top - 1 && r.bottom <= s.bottom + 1
      }, id)
    const wheelTo = async (dy: number, done: (s: { top: number; max: number }) => boolean) => {
      for (;;) {
        const s = await scroll()
        if (done(s)) return
        await page.mouse.wheel(0, dy)
        await until('the sidebar to move', async () => (await scroll()).top !== s.top || undefined)
      }
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const range = (await scroll()).max
    const scrolled = await frames(kea, async () => {
      await wheelTo(-WHEEL_STEP_PX, (s) => s.top <= 0)
      const firstSeen = await inView(order[0] as string)
      await wheelTo(WHEEL_STEP_PX, (s) => s.top >= s.max - 1)
      const lastSeen = await inView(order.at(-1) as string)
      return { firstSeen, lastSeen }
    })
    // … and the row at the far end opens with a click, as a person picks it
    const far = order.at(-1) as string
    await fakeAgentTerminal(kea, far)
    const after = await watch()
    watched = Math.max(watched, after.worktrees ?? NaN)
    const gl = await stopGlWatch(kea)
    // the footprint again, after the use: six parked sessions woken (their mirrors awake until ptyhost parks them
    // again), a shell tab added, the far session opened. `fifty` above was read before any of it. Read as every
    // level here is, once it has stopped moving: right after the switching and scrolling the GPU helper holds some 300
    // MB more for a few seconds, as it does after a window opens (recorded as the first checkpoint)
    const used = await w.footprint('fifty, after use')
    const usedMirrors = await ptyhostMirrors(kea)
    await w.detach()

    const mem = budget('P-MEM-3b')
    const term = budget('P-TERM-1')
    const cold8 = budget('P-TERM-8')
    const gpu = budget('P-GPU-1')
    const cpuEntry = record({
      id: 'P-CPU-1 (50 sessions, C-RES-4)',
      metric: `app idle, ${FIFTY} idle sessions, window visible`,
      method: `as P-CPU-1 with ${FIFTY} sessions: the window visible with its full set of warm terminals, every other mirror parked; ${WARMUP_MS / 1000} s, then ${RUNS} windows of ${WINDOW_MS / 1000} s, the median; the limit is P-CPU-1's × ${FIFTY} / ${TWENTY}. Recorded beside it, not judged: twentyCpuPct, the same reading with ${TWENTY} sessions earlier in this launch, and ratioToTwenty, this one over that (linear in the session count would be ${FIFTY / TWENTY}; at these levels, a few tenths of a percent of one core, the ratio moves with whatever else the machine does)`,
      values: { ...cpuValues(idle), ...(twenty ? { twentyCpuPct: twenty.cpuPct, ratioToTwenty: medianWindow(idle).cpuPct / twenty.cpuPct, twentyLoad1: twenty.load } : {}) },
      checks: [check('cpuPct', medianWindow(idle).cpuPct, cpuLimit, 'max', cpu.unit)],
      notes: twenty ? [] : [`no reading with ${TWENTY} sessions in this launch (P-CPU-1 did not run before this row): no ratio`],
    })
    const usedEntry = record({
      id: 'P-MEM-3b (after use, C-RES-4)',
      metric: `${FIFTY} live sessions, window open, after typing, ${SWITCHES} switches to parked sessions and a scroll of the sidebar`,
      method: `as P-MEM-3b (forced GC in each process, the median of ${READINGS} readings per checkpoint, the checkpoint once ${SETTLE_CHECKPOINTS} in a row lie within ${SETTLE_BYTES / MIB} MiB), read once the row's use is over: a shell tab added to the session on screen, ${SWITCHES} sessions never shown switched to (their mirrors awake until ptyhost parks them again), the sidebar scrolled and its last row opened. Not P-MEM-3b's own state (that is the idle one, before the use); held to its budget all the same. firstCheckpointMb is the reading right after the use, when the GPU helper still holds what the switching and scrolling drew: recorded, not compared`,
      values: { totalMb: used.settled.total / MIB, ...roleMb(used.settled), processes: used.settled.processes, settleS: used.settleMs / 1000, firstCheckpointMb: used.first.total / MIB, firstCheckpointGpuMb: (used.first.byRole.gpu ?? 0) / MIB, beforeUseMb: fifty.settled.total / MIB, mirrorsAwake: usedMirrors.awake, mirrorsParked: usedMirrors.parked },
      checks: [check('totalMb', used.settled.total / MIB, mem.max, 'max', mem.unit)],
      notes: settleNote(used),
    })
    const echoEntry = record({
      id: 'P-TERM-1 (50 sessions, C-RES-4)',
      metric: `keydown → glyph painted with ${FIFTY} idle sessions`,
      method: `cat in a shell tab of the session on screen, ${FIFTY} idle sessions beside it; tools/perf's echo probe, ${KEY_WARMUP} unmeasured keys, then ${ECHO_KEYS}; the p99 against P-TERM-1's`,
      values: { ...echo },
      checks: [check('p99', echo.p99, term.p99, 'max', term.unit)],
    })
    const switchEntry = record({
      id: 'P-TERM-8 (50 sessions, C-RES-4)',
      metric: `session switch to a parked session, ${FIFTY} idle sessions`,
      method: `⌘1…⌘9 to ${cold.length} sessions never shown, their mirrors parked (the checkpoint is the snapshot); keydown → the first frame with the session's terminal shown (__keaPerf.armSwitch); the median against P-TERM-8's cold switch (the snapshot here is one screen, not 5 000 lines)`,
      values: { ...dist(switches) },
      checks: [check('median', median(switches), cold8.max, 'max', cold8.unit)],
    })
    const values = {
      sessions: order.length,
      cpuPct: medianWindow(idle).cpuPct,
      cpuLimitPct: cpuLimit,
      cpuRatioToTwenty: twenty ? medianWindow(idle).cpuPct / twenty.cpuPct : NaN,
      totalMb: fifty.settled.total / MIB,
      totalAfterUseMb: used.settled.total / MIB,
      echoP50Ms: echo.p50,
      echoP99Ms: echo.p99,
      switches: switches.length,
      switchMedianMs: median(switches),
      switchMaxMs: Math.max(...switches),
      sidebarRangePx: range,
      sidebarScrollFps: scrolled.fps,
      sidebarScrollMaxFrameMs: scrolled.maxGapMs,
      watchedWorktreesMax: watched,
      watchEvictions: after.evictions ?? NaN,
      webglMaxAlive: gl.maxAlive,
      webglMaxCounted: gl.maxCounted,
      webglFrames: gl.frames,
      load1: medianWindow(idle).load,
    }
    console.info(`C-RES-4 · ${Object.entries(values).map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`).join(', ')}`)
    expect(shell, 'the shell tab the keys were typed in is a new tab of the session on screen').not.toBe(agent)
    expect(order.length, 'session rows in the sidebar').toBe(FIFTY)
    expect(switches.length, 'switches to parked sessions').toBe(SWITCHES)
    expect(range, 'the sidebar has more rows than fit: it scrolls').toBeGreaterThan(0)
    expect(scrolled.result, 'the first row in view at the top of the scroll, the last at its end').toEqual({ firstSeen: true, lastSeen: true })
    expect(watched, `watched worktrees over ${switches.length + 1} switches`).toBeLessThanOrEqual(L.watchWorktreesLru)
    expect(after.evictions, 'worktrees the LRU let go as other sessions were shown').toBeGreaterThan(0)
    expect(gl.frames, 'frames watched').toBeGreaterThan(0)
    expect(Math.max(gl.maxAlive, gl.maxCounted), 'WebGL contexts alive in any frame (P-GPU-1)').toBeLessThanOrEqual(gpu.max)
    expect(gl.releasedAlive, 'released WebGL canvases whose context was still alive').toBe(0)
    expect(fifty.settled.total / MIB, 'the footprint (P-MEM-3b)').toBeLessThanOrEqual(mem.max)
    expect(usedEntry.pass, `the footprint after the use (P-MEM-3b): ${JSON.stringify(usedEntry.values)}`).toBe(true)
    expect(echoEntry.pass, `echo: ${JSON.stringify(echo)}`).toBe(true)
    expect(switchEntry.pass, `switches: ${JSON.stringify(switches)}`).toBe(true)
    expect(cpuEntry.pass, `idle CPU: ${JSON.stringify(cpuEntry.values)}`).toBe(true)
  }, C_RES_4_MS)
})
