// Memory budgets of the whole app: one more session with an awake mirror (P-MEM-2b), and Kea with the window closed or
// in the menu bar, with 20 idle sessions (P-MEM-5). The no-window reading is the one the window-cycle leak test
// takes (tests/perf/app-idle.ts `windowGone`): the same sessions, the footprint L.windowGoneFootprintMs after the
// window went. Physical footprint (`kea-helper footprint`, what Activity Monitor shows) is summed over every Kea
// process (Electron's, GPU helper included, and the holders) after forced GC in each JS process
// (tests/perf/app-idle.ts, which also makes the idle sessions). The per-process budgets of ptyhost and the holder are
// in tests/perf/ptyhost-memory.test.ts, what many idle sessions cost with the window open in
// tests/perf/app-many.test.ts, and the viewer's in tests/perf/app-viewer.test.ts.

import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { STEP_MS, until, zooShellCommand, type Kea } from '../support/app.ts'
import { RendererProbe } from '../support/app-leak.ts'
import { inMenuBar, NO_MENU_BAR, pressQuit, quitSheet } from '../support/app-menubar.ts'
import { skipWhere } from '../support/skip.ts'
import { demoRepo } from '../support/app-sessions.ts'
import { theilSen } from '../../tools/perf/src/stats.ts'
import { budget, check, disposeRuns, median, ptyhostMirrors, record, startKea } from './app-harness.ts'
import { goneSeries, MIB, NO_WINDOW_SESSIONS, READINGS, roleMb, settledFootprint, noWindowSessions, windowGone, type WindowGone } from './app-idle.ts'
import { sysKey } from '../support/keys.ts'

afterEach(disposeRuns)

/** The budget's terminal: 5 000 lines of scrollback (Kea's default) at 200 columns (P-MEM-2b). */
const SCROLLBACK = 5000
const COLS = 200
/** Rounds of tabs added after the renderer's set is full, a footprint checkpoint after each. */
const ROUNDS = 4
const PER_ROUND = 4
/** How long a font step may take to reflow the terminal before the font is taken to be at its minimum. */
const FONT_STEP_MS = 2000
/** Window width changes tried before giving up on an exact column count (the first lands within a cell or two). */
const NARROW_ATTEMPTS = 8

/** Smaller font steps (⌘−) until the terminal on screen is at least `cols` wide; resolves with its width. */
async function widen(kea: Kea, cols: number): Promise<number> {
  const width = async () => {
    const shown = await kea.shown()
    return (await kea.views()).find((v) => v.ptyId === shown)?.cols ?? 0
  }
  let now = await width()
  while (now < cols) {
    const before = now
    await kea.press(sysKey('Meta+Minus'))
    // at the font setting's minimum the width stops changing
    now = await until('the terminal to reflow', async () => {
      const w = await width()
      return w !== before ? w : undefined
    }, FONT_STEP_MS).catch(() => before)
    if (now === before) break
  }
  return now
}

/**
 * Narrow the window, a cell at a time once close, until the terminal on screen is exactly `cols` wide (after `widen`,
 * whose font steps overshoot: 207 columns at the step that first reaches 200). Resolves with its width.
 */
async function narrowTo(kea: Kea, cols: number): Promise<number> {
  const width = async () => {
    const shown = await kea.shown()
    return (await kea.views()).find((v) => v.ptyId === shown)?.cols ?? 0
  }
  let now = await width()
  for (let attempt = 0; now !== cols && attempt < NARROW_ATTEMPTS; attempt++) {
    const page = await kea.page()
    // one cell's width in CSS px: the terminal on screen's width over its columns
    const hostPx = await page.evaluate(() => (document.querySelector('.terminal-host.shown') as HTMLElement | null)?.clientWidth ?? 0)
    const by = Math.max(1, Math.round((Math.abs(now - cols) * hostPx) / now))
    await kea.app.evaluate(({ BrowserWindow }, d) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (!w) throw new Error('no window')
      const [cw, ch] = w.getContentSize() as [number, number]
      w.setContentSize(cw - d, ch)
    }, now > cols ? by : -by)
    const before = now
    now = await until('the terminal to reflow', async () => {
      const w = await width()
      return w !== before ? w : undefined
    }, FONT_STEP_MS).catch(() => before)
  }
  return now
}

/** Fill the terminal on screen with SCROLLBACK lines (plus a screen) of `cols` characters each; resolves when shown. */
async function fill(kea: Kea, cols: number, rows: number, tag: string): Promise<void> {
  const flood = zooShellCommand('flood', ['--bytes', String((SCROLLBACK + rows) * (cols + 1)), '--line-length', String(cols + 1)])
  await kea.enter(`${flood}; echo ${tag}-$((40+2))`)
  await kea.waitScreen(`${tag}'s output`, (s) => s.includes(`${tag}-42`))
}

describe('whole-app memory (app)', () => {
  it(
    'P-MEM-2b · each extra terminal with an awake 5 000 × 200 mirror adds at most its budget to the footprint of all Kea processes (Theil–Sen slope over 4 rounds of 4)',
    async () => {
      const { kea } = await startKea()
      await widen(kea, COLS)
      const cols = await narrowTo(kea, COLS)
      const rows = (await kea.views()).find((v) => v.visible)?.rows ?? 0
      // the renderer's set first: the terminal on screen and the warm ones, each full, so later tabs change
      // nothing in the renderer (they fall out of its set and live only in ptyhost and their holders)
      await fill(kea, cols, rows, 'FILLED0')
      for (let i = 1; i <= L.warmTerminals; i++) {
        await kea.newTab()
        await fill(kea, cols, rows, `FILLED${i}`)
      }
      const renderer = await RendererProbe.open(kea)
      try {
        let prev = await settledFootprint(kea, renderer)
        const base = prev
        const points = [{ tabs: 0, ...base }]
        const perTab: number[] = []
        const awake: number[] = []
        const t0 = Date.now()
        for (let r = 0; r < ROUNDS; r++) {
          for (let k = 0; k < PER_ROUND; k++) {
            await kea.newTab()
            await fill(kea, cols, rows, `ROUND${r}TAB${k}`)
          }
          const now = await settledFootprint(kea, renderer)
          perTab.push((now.total - prev.total) / PER_ROUND)
          points.push({ tabs: (r + 1) * PER_ROUND, ...now })
          prev = now
          const m = await ptyhostMirrors(kea)
          awake.push(m.awake)
          // every mirror must still be awake: the rounds run well within L.mirrorParkIdleMs
          expect(m.parked, `parked mirrors after round ${r} (${Math.round((Date.now() - t0) / 1000)} s)`).toBe(0)
        }
        const b = budget('P-MEM-2b')
        // per tab: the Theil–Sen slope of the footprint over the tabs added (the leak suite's estimator), robust to one
        // checkpoint thrown off by a process that has nothing to do with the tabs (the GPU helper moves by tens of MB
        // as WebGL contexts come and go with the warm set)
        const tabs = points.map((x) => x.tabs)
        const slope = (ys: number[]) => theilSen(tabs, ys) / MIB
        const growth: Record<string, number> = {}
        for (const role of Object.keys(prev.byRole)) growth[`${role}PerTabMb`] = slope(points.map((x) => x.byRole[role] ?? 0))
        const values = { perTabMb: slope(points.map((x) => x.total)), perTabRoundMedianMb: median(perTab) / MIB, perTabRoundMaxMb: Math.max(...perTab) / MIB, cols, rows, baseTotalMb: base.total / MIB, endTotalMb: prev.total / MIB, mirrorsAwake: awake.at(-1) ?? NaN, ...growth }
        const e = record({
          id: 'P-MEM-2b',
          metric: b.metric,
          method: `${cols} columns (⌘− until ≥ ${COLS}, then the window narrowed to exactly ${COLS}); the terminal on screen and ${L.warmTerminals} warm ones filled first; then ${ROUNDS} rounds of ${PER_ROUND} new tabs, each filled with ${SCROLLBACK} + ${rows} lines of ${cols} characters (process-zoo flood) and left with no renderer and an awake mirror; footprint of every Kea process (Electron's and the holders) summed after forced GC, median of ${READINGS} readings per checkpoint; per tab = the Theil–Sen slope of the total over the tabs added (the base and one checkpoint per round), each role's the same way`,
          values,
          checks: [check('perTabMb', values.perTabMb, b.max, 'max', b.unit)],
        })
        expect(cols, `the terminal is ${COLS} columns wide`).toBe(COLS)
        expect(e.pass, JSON.stringify(e.values)).toBe(true)
      } finally {
        await renderer.close()
      }
    },
    15 * 60_000,
  )

  it(
    `P-MEM-5 · ${NO_WINDOW_SESSIONS} idle sessions: the window closed, then Kea in the menu bar after ⌘Q: each time no renderer process within L.windowGoneSettleMs, and the footprint of every Kea process read at that time within its budget`,
    async (ctx) => {
      skipWhere(ctx, NO_MENU_BAR)
      // the sessions the window-cycle leak test measures: the fake agent as Claude Code, idle at its prompt
      // (app-idle.ts)
      const { run, kea } = await startKea({ settings: { general: { defaultAgent: 'claude' } } })
      await noWindowSessions(kea, demoRepo(run).root)
      const b = budget('P-MEM-5')
      const load = () => os.loadavg()[0] as number

      // the window closed
      let went = performance.now()
      await kea.closeWindow()
      const closed = await windowGone(kea, went, b.max)
      const closedLoad = load()
      // Kea in the menu bar: ⌘Q, the first-quit sheet answered with its default; the window goes with that click
      await kea.reopenWindow()
      await pressQuit(kea)
      const keep = quitSheet(await kea.page()).getByRole('button', { name: 'Keep in Menu Bar' })
      await keep.waitFor({ timeout: STEP_MS })
      went = performance.now()
      await keep.click({ timeout: STEP_MS })
      await inMenuBar(kea)
      const menuBar = await windowGone(kea, went, b.max)

      const of = (name: string, g: WindowGone) => ({
        [`${name}Mb`]: g.at.total / MIB,
        [`${name}ReadAtMs`]: g.at.atMs,
        [`${name}ReadDoneMs`]: g.at.doneMs,
        [`${name}Renderers`]: g.at.renderers,
        [`${name}RendererGoneMs`]: g.rendererGoneMs,
        // -1: not within the budget for as long as it was watched
        [`${name}WithinBudgetAfterMs`]: g.withinMs ?? -1,
        [`${name}WatchedMs`]: g.readings.at(-1)?.doneMs ?? NaN,
        ...roleMb(g.at, `${name}_`),
      })
      const values = { ...of('closed', closed), ...of('menuBar', menuBar), closedLoad1m: closedLoad, menuBarLoad1m: load() }
      const e = record({
        id: 'P-MEM-5',
        metric: b.metric,
        method: `${NO_WINDOW_SESSIONS} sessions started from the composer (fake-agent as Claude Code, idle at its prompt after one turn: the sessions L-TERM-5 measures), plus the first launch's shell; once with the window closed, once in the menu bar after ⌘Q (the first-quit sheet answered Keep in Menu Bar). Read as tests/perf/app-idle.ts windowGone reads it (shared with L-TERM-5): no renderer process within ${L.windowGoneSettleMs / 1000} s of the window going; the footprint of every Kea process (Electron's and the holders) summed after forced GC in core, ptyhost and main, median of ${READINGS} readings, begun ${L.windowGoneSettleMs / 1000} s after the window went. That one reading is compared, whatever was read before or after; WithinBudgetAfterMs is when a reading was first within the budget (before that time: as the processes stood, forcing nothing; -1: not while watched)`,
        values,
        checks: [check('closedMb', closed.at.total / MIB, b.max, 'max', b.unit), check('menuBarMb', menuBar.at.total / MIB, b.max, 'max', b.unit)],
        notes: [`window closed: ${goneSeries(closed)}`, `menu bar: ${goneSeries(menuBar)}`],
      })
      // "no renderer process" is its own check: gone within L.windowGoneSettleMs (windowGone waited no longer), and
      // none at the reading
      expect(Math.max(closed.rendererGoneMs, menuBar.rendererGoneMs), `the renderer process gone within ${L.windowGoneSettleMs} ms`).toBeLessThanOrEqual(L.windowGoneSettleMs)
      expect(closed.at.renderers + menuBar.at.renderers, 'no renderer process').toBe(0)
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    15 * 60_000,
  )
})
