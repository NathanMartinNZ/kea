// GPU budgets against the real app (tests/perf/app-harness.ts). The GPU memory run (P-GPU-2, tests/perf/app-gpu-soak.ts)
// takes two hours by default, so it runs only when asked: `KEA_LONG=1` (`pnpm perf --long`; tests/support/long.ts) or
// `KEA_GPU_SOAK_DURATION_MS` (`node tools/perf/src/gpu-soak.ts --duration …`, which also prints the report's summary;
// `KEA_GPU_SOAK_SAMPLE_MS` and `KEA_GPU_SOAK_OUT` set the sampling period and the report's path). A shorter duration is a smoke
// run: its "last hour" is the last half of the run.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { startGlWatch, stopGlWatch } from '../support/app-render.ts'
import { budget, check, disposeRuns, envNumber, openTabs, record, startKea } from './app-harness.ts'
import { runGpuSoak, SOAK_DURATION_MS, SOAK_SAMPLE_MS, soakOptions, summaryText } from './app-gpu-soak.ts'
import { LONG } from '../support/long.ts'
import { sysKey } from '../support/keys.ts'

afterEach(disposeRuns)

/** Three times as many tabs as the renderer keeps (the visible one and L.warmTerminals warm ones). */
const TABS = 3 * (1 + L.warmTerminals)
const ROUNDS = 3

const SOAK_MS = envNumber('KEA_GPU_SOAK_DURATION_MS', SOAK_DURATION_MS)
const SOAK = LONG || process.env.KEA_GPU_SOAK_DURATION_MS !== undefined
/** Setting up the GPU memory run's 24 tabs and writing its report, on top of its duration. */
const SOAK_SETUP_MS = 15 * 60_000

describe('GPU (app)', () => {
  it(
    `P-GPU-1 · ${TABS} tabs visited round-robin ${ROUNDS} times: WebGL contexts alive never above L.webglContextsMax in any frame`,
    async () => {
      const { kea } = await startKea()
      await openTabs(kea, TABS - 1)
      const ids = await kea.tabIds()
      await startGlWatch(kea)
      const page = await kea.page()
      let at = ids.indexOf((await kea.shown()) as string) // the last tab opened
      for (let i = 0; i < ROUNDS * ids.length; i++) {
        at = (at + 1) % ids.length
        const next = ids[at] as string
        await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
        await page.waitForFunction((x) => document.querySelector('.terminal-host.shown')?.getAttribute('data-pty') === x, next, { polling: 'raf', timeout: 20_000 })
      }
      const gl = await stopGlWatch(kea)
      const b = budget('P-GPU-1')
      const e = record({
        id: 'P-GPU-1',
        metric: b.metric,
        method: `${TABS} shell tabs, ⌘⇧] through all of them ${ROUNDS} times; every frame, the contexts the views count and the WebGL2 contexts alive on canvases in the page (tests/support/app-render.ts GlWatch); the most in any frame`,
        values: { maxAlive: gl.maxAlive, maxCounted: gl.maxCounted, frames: gl.frames, disposed: gl.disposed, releasedAlive: gl.releasedAlive, lostOnShown: gl.lostOnShown, tabs: ids.length },
        checks: [check('maxAlive', gl.maxAlive, b.max, 'max', b.unit), check('maxCounted', gl.maxCounted, b.max, 'max', b.unit)],
      })
      expect(gl.frames, 'frames watched').toBeGreaterThan(0)
      expect(gl.releasedAlive, 'released WebGL canvases whose context was still alive').toBe(0)
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )

  it.runIf(SOAK)(
    'P-GPU-2 · the Claude Code cassette loop with truecolor shimmer for 2 h (KEA_GPU_SOAK_DURATION_MS overrides): the GPU helper’s footprint within budget and flat over the last hour',
    async () => {
      const o = soakOptions({ durationMs: SOAK_MS, sampleMs: envNumber('KEA_GPU_SOAK_SAMPLE_MS', SOAK_SAMPLE_MS), ...(process.env.KEA_GPU_SOAK_OUT ? { out: process.env.KEA_GPU_SOAK_OUT } : {}) })
      const { summary, out } = await runGpuSoak(o)
      console.info(summaryText(summary, out))
      const b = budget('P-GPU-2')
      const smoke = SOAK_MS < SOAK_DURATION_MS
      const e = record({
        id: 'P-GPU-2',
        metric: b.metric,
        method: `the GPU soak (tests/perf/app-gpu-soak.ts) for ${summary.durationMin} min: the GPU helper's physical footprint every ${o.sampleMs / 1000} s; its maximum over the last half of the run (the last hour of 2 h) against the budget, and flat over that half (the leak suites' byte rule, per minute)${smoke ? '; SMOKE: shorter than the budget’s 2 h' : ''}`,
        values: { lastHalfMaxMb: summary.gpu.lastHalf.maxMb, maxMb: summary.gpu.maxMb, lastMb: summary.gpu.lastMb, slopeMbPerMin: summary.gpu.lastHalf.slopeMbPerMin, growthMb: summary.gpu.lastHalf.growthMb, flat: summary.gpu.lastHalf.flat ? 1 : 0, durationMin: summary.durationMin, guardClears: summary.atlas.guardClears },
        checks: [check('lastHalfMaxMb', summary.gpu.lastHalf.maxMb, b.max, 'max', b.unit), check('flat', summary.gpu.lastHalf.flat ? 1 : 0, 1, 'min', 'yes')],
        notes: [`GPU soak report: ${out}`, ...(smoke ? [`smoke run of ${summary.durationMin} min, not the budget's 2 h`] : [])],
      })
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    SOAK_MS + SOAK_SETUP_MS,
  )
})
