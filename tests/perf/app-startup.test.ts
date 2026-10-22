// Startup budgets against the real app, a release build launched unfocused on a fresh KEA_HOME each time
// (tests/perf/app-harness.ts), except P-START-2, which launches one home with its sessions again and again. A "cold
// launch" here is a new Kea process on a home with no holders (the relaunch with live ones is a test of its own, with
// tools/fake-agent as Claude Code, never the real CLI); the OS file cache is warm after the warm-up launch, as it is
// for a person starting Kea a second time. This is the unpackaged build on npm's Electron with Playwright attached (it
// adds `--inspect=0` and `--remote-debugging-port=0`; with `executablePath` set it does not hold back `ready`), so it
// is an upper bound for the installed build, which cannot be driven (fused, no debugger).

import fs from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { afterEach, describe, expect, it } from 'vitest'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { launchKea, processInfo } from '../../tools/perf/src/launch.ts'
import { Kea, KeaRun, STEP_MS, testAppDist, until } from '../support/app.ts'
import { addProject, demoRepo, selectSession, startSession, tabOf, waitLive } from '../support/app-sessions.ts'
import { budget, CASSETTE_DIR, check, disposeRuns, ensureBuild, median, record, RUNS, startKea, trackRun, WARMUPS } from './app-harness.ts'

afterEach(disposeRuns)

declare const __keaPerf: {
  ready(): boolean
  attached(): Promise<void>
  armEcho(ch: string): void
  awaitEcho(ms?: number): Promise<number>
  firstSessionRows(): { rows: number; at: number } | null
  watchStatuses(): void
  statusesConfirmed(): { rows: number; at: number } | null
}
type MainMarks = { bootstrap: number; script: number; topLevel: number; ready: number; window: number }

/** Wall-clock time in ms (sub-millisecond), comparable between this process and the renderer (both read the system clock). */
const wall = () => performance.timeOrigin + performance.now()

/** The environment KeaRun.launch gives the app (the run's shell and git identity), for launches made directly. */
function launchEnv(run: KeaRun): Record<string, string> {
  return { SHELL: '/bin/zsh', ZDOTDIR: run.zdotdir, GIT_CONFIG_GLOBAL: run.gitConfig, GIT_CONFIG_NOSYSTEM: '1', ...run.agentEnv() }
}

/**
 * Launch Kea on the run's home directly (no readiness checks inside the measured time); `measure` runs on its window.
 * The clock starts when Electron is started (`onSpawn`): `launchKea`'s own check of the run's login shell, made before
 * that at every launch, is the harness's and no part of Kea's start.
 */
async function coldLaunch<T>(run: KeaRun, measure: (app: ElectronApplication, t0: number) => Promise<T>): Promise<T> {
  let t0 = wall()
  const app = await launchKea({ dist: testAppDist(), home: run.home, env: launchEnv(run), agents: run.agentBin, timeoutMs: STEP_MS, onSpawn: () => (t0 = wall()) })
  try {
    const out = await measure(app, t0)
    const main = processInfo(app.process().pid ?? 0)
    if (main) await new Kea(run, app, main).assertUnfocused()
    return out
  } finally {
    await app.close().catch(() => undefined)
  }
}

/** Kill every live holder of the run, so the next launch is cold (no holders; the relaunch test keeps them). */
function killLiveHolders(run: KeaRun): void {
  for (const h of run.holders()) if (run.holderAlive(h)) run.killHolderTree(h)
}

/** The run's live holders. */
function liveHolders(run: KeaRun): number {
  return run.holders().filter((h) => run.holderAlive(h)).length
}

/** What the relaunch test's fake agents draw: how the test finds one on screen. */
const AGENT_PROMPT = '⏺ Done: listed the files.'

/**
 * The relaunch test's sessions (P-START-4): tools/fake-agent as Claude Code (the run's `claude` shim,
 * tests/support/app.ts) made the default agent. Each replays a recorded Claude Code session at once (a cassette from
 * fixtures/cassettes: its history, in the ring), ends a turn as Claude does (the transcript, then the Stop hook) and
 * waits at its prompt, echoing what is typed. Its events go to the returned log (tools/fake-agent README "Event log").
 */
function relaunchAgents(run: KeaRun): { log: string } {
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
  const scenario = path.join(run.home, 'relaunch.json')
  const steps = [
    { cassette: { file: path.join(CASSETTE_DIR, 'claude-classic-list-files.cast'), speed: 0 } },
    { hook: 'UserPromptSubmit' },
    { transcript: { record: 'user', text: '{{prompt}}' } },
    { transcript: { record: 'assistant', text: 'Done: listed the files.' } },
    { hook: { event: 'Stop', fields: { last_assistant_message: 'Done: listed the files.' } } },
    { frame: ['✻ fake-agent', '', '> {{prompt}}', '', AGENT_PROMPT, '', '> '] },
  ]
  fs.writeFileSync(scenario, JSON.stringify({ version: 1, name: 'relaunch', steps }))
  const log = path.join(run.home, 'relaunch.log')
  writeAgentShim(run.agentBin, 'claude', { env: { FAKE_AGENT_SCENARIO: scenario, FAKE_AGENT_LOG: log } })
  return { log }
}

/** How many turns the fake agents logging to `log` have ended (their Stop hook run). */
function turnsEnded(log: string): number {
  if (!fs.existsSync(log)) return 0
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.t === 'hook' && e.event === 'Stop').length
}

describe('startup (app)', () => {
  it(
    'P-START-1 · cold launch → the window’s first contentful paint within budget, median of the launches after a warm-up',
    async () => {
      ensureBuild()
      const runs: number[] = []
      for (let i = 0; i < WARMUPS + RUNS; i++) {
        const run = trackRun(KeaRun.create())
        const ms = await coldLaunch(run, async (app, t0) => {
          const page = await app.firstWindow({ timeout: STEP_MS })
          // the renderer's paint timing entry, on the system clock through its time origin
          const fcp = await page.waitForFunction(
            () => {
              const e = performance.getEntriesByName('first-contentful-paint')[0]
              return e ? performance.timeOrigin + e.startTime : null
            },
            null,
            { timeout: STEP_MS },
          )
          return ((await fcp.jsonValue()) as number) - t0
        })
        if (i >= WARMUPS) runs.push(ms)
        await disposeRuns() // every launch starts from the same state: a fresh home, no holders
      }
      const b = budget('P-START-1')
      const e = record({
        id: 'P-START-1',
        metric: b.metric,
        method: `wall clock from just before Playwright spawns Electron to the renderer's first-contentful-paint entry (its time origin + startTime); a fresh home each launch; ${WARMUPS} warm-up + ${RUNS} launches, median`,
        values: { median: median(runs), min: Math.min(...runs), max: Math.max(...runs) },
        checks: [check('median', median(runs), b.max, 'max', b.unit)],
      })
      expect(e.pass, `P-START-1: ${JSON.stringify(e.values)}`).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-START-2 · cold launch with 20 sessions in the database → the sidebar drawn with all of them within budget, median of the launches after a warm-up',
    async () => {
      const SESSIONS = 20
      ensureBuild()
      const run = trackRun(KeaRun.create())
      // the database: one project and its sessions (their holders killed after the quit, so every launch is cold)
      const kea = await run.launch()
      await addProject(kea, demoRepo(run).root)
      const ids: string[] = []
      for (let i = 0; i < SESSIONS; i++) ids.push(await startSession(kea, `startup ${i + 1}`, { background: true, open: i === 0 }))
      for (const id of ids) await waitLive(kea, id)
      await kea.close()
      killLiveHolders(run)
      const runs: { ms: number; dom: number; fcp: number; rows: number }[] = []
      for (let i = 0; i < WARMUPS + RUNS; i++) {
        const r = await coldLaunch(run, async (app, t0) => {
          const page = await app.firstWindow({ timeout: STEP_MS })
          // __keaPerf.firstSessionRows: the first DOM update that drew session rows (the sessions store's first
          // render); on screen no sooner than the window's first contentful paint
          const first = await page.waitForFunction(
            () => {
              const r = typeof __keaPerf !== 'undefined' ? __keaPerf.firstSessionRows() : null
              const fcp = performance.getEntriesByName('first-contentful-paint')[0]
              return r && fcp ? { rows: r.rows, dom: performance.timeOrigin + r.at, fcp: performance.timeOrigin + fcp.startTime } : null
            },
            null,
            { timeout: STEP_MS },
          )
          const { rows, dom, fcp } = (await first.jsonValue()) as { rows: number; dom: number; fcp: number }
          return { ms: Math.max(dom, fcp) - t0, dom: dom - t0, fcp: fcp - t0, rows }
        })
        killLiveHolders(run) // whatever this launch started (nothing, when the window opens on a detached session)
        expect(r.rows, 'every session drawn in the first render of the list').toBe(SESSIONS)
        if (i >= WARMUPS) runs.push(r)
      }
      const b = budget('P-START-2')
      const ms = runs.map((r) => r.ms)
      const e = record({
        id: 'P-START-2',
        metric: b.metric,
        method: `${SESSIONS} sessions of one project in the database, no holders (killed after a quit, so the sessions are detached); wall clock from just before Playwright spawns Electron to the later of the first DOM update that drew session rows (__keaPerf.firstSessionRows: a MutationObserver from before the window mounts; all ${SESSIONS} in that render) and the window's first contentful paint; ${WARMUPS} warm-up + ${RUNS} launches, median`,
        values: { median: median(ms), min: Math.min(...ms), max: Math.max(...ms), rowsDomMedian: median(runs.map((r) => r.dom)), fcpMedian: median(runs.map((r) => r.fcp)) },
        checks: [check('median', median(ms), b.max, 'max', b.unit)],
      })
      expect(e.pass, `P-START-2: ${JSON.stringify(e.values)}`).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-START-3 · cold launch → the active terminal attached and typeable (first echo round trip) within budget, median of the launches after a warm-up',
    async () => {
      ensureBuild()
      const runs: { total: number; window: number; attached: number; echo: number }[] = []
      for (let i = 0; i < WARMUPS + RUNS; i++) {
        const run = trackRun(KeaRun.create())
        // launched directly (not KeaRun.launch, whose readiness checks would sit inside the measured time); the clock
        // starts when Electron is started, after the harness's own check
        let t0 = wall()
        const app = await launchKea({ dist: testAppDist(), home: run.home, env: { SHELL: '/bin/zsh', ZDOTDIR: run.zdotdir, ...run.agentEnv() }, agents: run.agentBin, timeoutMs: STEP_MS, onSpawn: () => (t0 = wall()) })
        try {
          const page = await app.firstWindow({ timeout: STEP_MS })
          const tWindow = wall()
          await page.waitForFunction(() => typeof __keaPerf !== 'undefined' && __keaPerf.ready(), null, { timeout: STEP_MS })
          // attached, then armed in the same turn, so the key follows the attach by one CDP round trip
          const tAttached = await page.evaluate(async () => {
            await __keaPerf.attached()
            __keaPerf.armEcho('k')
            return performance.timeOrigin + performance.now()
          })
          await page.keyboard.press('k')
          const tEcho = await page.evaluate(async () => {
            await __keaPerf.awaitEcho(10_000)
            return performance.timeOrigin + performance.now()
          })
          if (i >= WARMUPS) runs.push({ total: tEcho - t0, window: tWindow - t0, attached: tAttached - t0, echo: tEcho - tAttached })
          const main = processInfo(app.process().pid ?? 0)
          if (main) await new Kea(run, app, main).assertUnfocused()
        } finally {
          await app.close().catch(() => undefined)
        }
        await disposeRuns() // every launch starts from the same state: no holders left from the last one
      }
      const b = budget('P-START-3')
      const total = median(runs.map((r) => r.total))
      const e = record({
        id: 'P-START-3',
        metric: b.metric,
        method: `wall clock from just before Playwright spawns Electron to the renderer's first echo of a key typed as soon as the terminal attached; ${WARMUPS} warm-up + ${RUNS} launches, median`,
        values: { median: total, min: Math.min(...runs.map((r) => r.total)), max: Math.max(...runs.map((r) => r.total)), windowMedian: median(runs.map((r) => r.window)), attachedMedian: median(runs.map((r) => r.attached)), echoMedian: median(runs.map((r) => r.echo)) },
        checks: [check('median', total, b.max, 'max', b.unit)],
      })
      expect(e.pass, `P-START-3: ${JSON.stringify(e.values)}`).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-START-4 · relaunch with 20 live holders (fake Claude Code sessions left running) → the visible terminal typeable (first echo round trip), and every status confirmed with every holder adopted and reconciled, within budget, median of the relaunches after a warm-up',
    async () => {
      const SESSIONS = 20
      ensureBuild()
      const run = trackRun(KeaRun.create())
      const { log } = relaunchAgents(run)
      const kea = await run.launch()
      // a fresh home opens a first shell: it exits, so the sessions' holders are the only ones
      await kea.enter('exit')
      await until('the first shell’s holder to go', () => liveHolders(run) === 0 || undefined)
      await addProject(kea, demoRepo(run).root)
      const ids: string[] = []
      for (let i = 0; i < SESSIONS; i++) ids.push(await startSession(kea, `relaunch ${i + 1}`, { background: true, open: i === 0 }))
      for (const id of ids) await waitLive(kea, id)
      await until(`${SESSIONS} turns ended`, () => turnsEnded(log) >= SESSIONS || undefined)
      // the window shows the first session's Agent tab, so the relaunch opens on it (the visible terminal)
      await selectSession(kea, ids[0]!)
      const visible = await tabOf(kea, 'agent')
      await until('the Agent terminal on screen', async () => (await kea.shown()) === visible || undefined)
      await kea.waitScreen('the agent at its prompt', (s) => s.includes(AGENT_PROMPT))
      await kea.close()
      expect(liveHolders(run), 'every session’s holder kept running after the quit').toBe(SESSIONS)

      const runs: { echo: number; window: number; attached: number; confirmed: number; adopted: number; reconciled: number }[] = []
      for (let i = 0; i < WARMUPS + RUNS; i++) {
        // launched directly (not KeaRun.launch, whose readiness checks would sit inside the measured time); the clock
        // starts when Electron is started, after the harness's own check
        let t0 = wall()
        const app = await launchKea({ dist: testAppDist(), home: run.home, env: launchEnv(run), agents: run.agentBin, timeoutMs: STEP_MS, onSpawn: () => (t0 = wall()) })
        try {
          const page = await app.firstWindow({ timeout: STEP_MS })
          const tWindow = wall()
          // the `status` store, followed from the window's first moments: a confirmation made before its snapshot
          // arrives counts at the snapshot's arrival (an upper bound)
          await page.waitForFunction(() => typeof __keaPerf !== 'undefined', null, { timeout: STEP_MS })
          await page.evaluate(() => __keaPerf.watchStatuses())
          await page.waitForFunction(() => __keaPerf.ready(), null, { timeout: STEP_MS })
          const tAttached = await page.evaluate(async () => {
            await __keaPerf.attached()
            __keaPerf.armEcho('k')
            return performance.timeOrigin + performance.now()
          })
          await page.keyboard.press('k')
          const tEcho = await page.evaluate(async () => {
            await __keaPerf.awaitEcho(10_000)
            return performance.timeOrigin + performance.now()
          })
          const all = await page.waitForFunction(
            (n) => {
              const c = __keaPerf.statusesConfirmed()
              return c && c.rows >= n ? performance.timeOrigin + c.at : null
            },
            SESSIONS,
            { timeout: STEP_MS },
          )
          const tConfirmed = (await all.jsonValue()) as number
          // ptyhost's last HELLO (every holder adopted) and core's reconcile with it, from their logs (`t`: wall ms)
          const main = processInfo(app.process().pid ?? 0)
          if (!main) throw new Error('main is not running')
          const again = new Kea(run, app, main)
          const line = (proc: 'core' | 'ptyhost', msg: string) => until(`${proc}'s "${msg}"`, () => again.logLines(proc).find((l) => l.msg === msg && Date.parse(l.t) >= Math.floor(t0)))
          const adopted = await line('ptyhost', 'holders adopted')
          expect([adopted.adopted, adopted.failed], 'every holder adopted').toEqual([SESSIONS, 0])
          const reconciled = await line('core', 'ptyhost reconciled')
          expect(reconciled.attached, 'every holder reconciled as live').toBe(SESSIONS)
          if (i >= WARMUPS)
            runs.push({
              echo: tEcho - t0,
              window: tWindow - t0,
              attached: tAttached - t0,
              confirmed: tConfirmed - t0,
              adopted: Date.parse(adopted.t) - t0,
              reconciled: Date.parse(reconciled.t) - t0,
            })
          await again.assertUnfocused()
        } finally {
          await app.close().catch(() => undefined)
        }
        expect(liveHolders(run), 'the holders keep running across relaunches').toBe(SESSIONS)
      }
      const b = budget('P-START-4')
      const echo = median(runs.map((r) => r.echo))
      // all statuses confirmed: the later of the window's every-status-confirmed and core's reconcile after the last HELLO
      const settled = runs.map((r) => Math.max(r.confirmed, r.reconciled, r.adopted))
      const e = record({
        id: 'P-START-4',
        metric: b.metric,
        method: `${SESSIONS} sessions of tools/fake-agent as Claude Code (a recorded Claude session each in its ring, a turn ended, idle at its prompt), Kea quit with them running, then relaunched; wall clock from just before Playwright spawns Electron to (1) the renderer's first echo of a key typed as soon as the visible terminal (the selected session's Agent tab) attached, (2) the later of: the window's copy of the \`status\` store holding all ${SESSIONS} statuses confirmed, ptyhost's "holders adopted" (the last HELLO) and core's "ptyhost reconciled" log lines; ${WARMUPS} warm-up + ${RUNS} relaunches, median`,
        values: {
          echoMedian: echo,
          confirmedMedian: median(settled),
          echoMax: Math.max(...runs.map((r) => r.echo)),
          confirmedMax: Math.max(...settled),
          windowMedian: median(runs.map((r) => r.window)),
          attachedMedian: median(runs.map((r) => r.attached)),
          adoptedMedian: median(runs.map((r) => r.adopted)),
          reconciledMedian: median(runs.map((r) => r.reconciled)),
          statusesMedian: median(runs.map((r) => r.confirmed)),
        },
        checks: [check('max', echo, b.max, 'max', b.unit), check('max_confirmed', median(settled), b.max_confirmed, 'max', b.unit)],
      })
      expect(e.pass, `P-START-4: ${JSON.stringify(e.values)}`).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-START-5 · the work Electron main does before creating its window is within budget, median of the launches after a warm-up',
    async () => {
      const marks: MainMarks[] = []
      for (let i = 0; i < WARMUPS + RUNS; i++) {
        const { kea } = await startKea()
        // app/main/src/main.ts's marks (performance.now(), ms since Node's time origin), exposed under --kea-perf
        const m = await kea.app.evaluate(() => (globalThis as unknown as { __keaPerfMain?: MainMarks }).__keaPerfMain ?? null)
        expect(m, 'main exposes its startup marks under --kea-perf').not.toBeNull()
        if (i >= WARMUPS) marks.push(m!)
        await disposeRuns()
      }
      // Main's own JS: Node's bootstrap → main's first statement (Electron's init and the bundle's module evaluation),
      // its top level, and `ready` → the window. Waiting for Chromium's `ready` is not main's work and is reported apart.
      const parts = marks.map((m) => ({ modules: m.script - m.bootstrap, topLevel: m.topLevel - m.script, readyToWindow: m.window - m.ready, waitForReady: m.ready - m.topLevel }))
      const work = parts.map((p) => p.modules + p.topLevel + p.readyToWindow)
      const b = budget('P-START-5')
      const e = record({
        id: 'P-START-5',
        metric: b.metric,
        method: `marks in app/main/src/main.ts (--kea-perf): (Node bootstrap complete → main's first statement) + (main's top level) + (ready → new BrowserWindow); ${WARMUPS} warm-up + ${RUNS} launches, median`,
        values: { median: median(work), max: Math.max(...work), modules: median(parts.map((p) => p.modules)), topLevel: median(parts.map((p) => p.topLevel)), readyToWindow: median(parts.map((p) => p.readyToWindow)), waitForReady: median(parts.map((p) => p.waitForReady)) },
        checks: [check('median', median(work), b.max, 'max', b.unit)],
      })
      expect(e.pass, `P-START-5: ${JSON.stringify(e.values)}`).toBe(true)
    },
    10 * 60_000,
  )
})
