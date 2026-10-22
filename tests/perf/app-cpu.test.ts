// CPU budgets with recorded Claude Code sessions replayed at 1× against the real app (tests/perf/app-harness.ts). The
// cassettes (fixtures/cassettes) loop through fake-agent (`cassetteLoop`). CPU is the processes' own CPU time (user +
// system: `ps`, or `/proc` on Linux) over a window, as % of one core.
//
// Each test lets the replays run WARMUP_MS first, then measures RUNS windows of WINDOW_MS (each spans two loops or
// more of a ≈ 10 s cassette) and compares the median window with the budget.
//
// The idle app's CPU (P-CPU-1 with the window visible, P-CPU-2 with none) is tests/perf/app-many.test.ts: it needs
// the idle sessions the memory tests there make, and measures the same way (tests/perf/app-idle.ts `idleSeries`).

import { afterEach, describe, expect, it } from 'vitest'
import { descendants } from '../../tools/perf/src/launch.ts'
import { type KeaRun } from '../support/app.ts'
import { budget, cassetteLoop, CASSETTES, check, CpuWindow, disposeRuns, frames, FULLSCREEN_CASSETTE, keaProcesses, measureFor, median, record, RUNS, startKea, type RoleProc } from './app-harness.ts'

afterEach(disposeRuns)

const WARMUP_MS = 10_000
const WINDOW_MS = 20_000
/** Sessions replaying cassettes at 1×, one of them visible (P-CPU-3). */
const WORKING = 5

/** Output bytes the run's PTYs have produced so far (their rings' latest seqs): proof the replays ran. */
function produced(run: KeaRun): number {
  return run.holders().reduce((n, h) => n + run.ring(h.ptyId).latest, 0)
}

describe('CPU with working sessions (app)', () => {
  it(
    'P-TERM-6 · the Claude Code fullscreen cassette replayed at 1× in the terminal on screen: renderer CPU (the median window) and the longest frame within budget',
    async () => {
      const { run, kea } = await startKea()
      await kea.enter(cassetteLoop(run, [FULLSCREEN_CASSETTE], 'fullscreen'))
      await kea.waitScreen('the replay', (s) => s.includes('Claude Code'))
      await measureFor(WARMUP_MS)
      const renderer: RoleProc = { role: 'renderer', p: await kea.pid('renderer') }
      const bytes0 = produced(run)
      const t0 = performance.now()
      const cpu: number[] = []
      for (let i = 0; i < RUNS; i++) {
        const w = new CpuWindow([renderer])
        await w.start()
        await measureFor(WINDOW_MS)
        cpu.push((await w.stop()).total)
      }
      const replayKBps = (produced(run) - bytes0) / 1000 / ((performance.now() - t0) / 1000)
      // frames in a window of their own: a rAF loop makes the compositor draw every frame, which would add to the CPU
      // measured above
      const f = await frames(kea, () => measureFor(WINDOW_MS))
      const b = budget('P-TERM-6')
      const values = { rendererCpuPct: median(cpu), rendererCpuMaxPct: Math.max(...cpu), maxFrameMs: f.maxGapMs, fps: f.fps, replayKBps }
      const e = record({
        id: 'P-TERM-6',
        metric: b.metric,
        method: `fake-agent loops ${FULLSCREEN_CASSETTE.split('/').pop()} at 1× in the terminal on screen; ${WARMUP_MS / 1000} s warm-up, then the renderer process's CPU time (ps) over ${RUNS} windows of ${WINDOW_MS / 1000} s, median; then the longest gap between rAF frames over another ${WINDOW_MS / 1000} s`,
        values,
        checks: [check('rendererCpuPct', values.rendererCpuPct, b.max, 'max', b.unit), check('maxFrameMs', values.maxFrameMs, b.max_frame_ms, 'max', 'ms')],
      })
      expect(replayKBps, 'the replay ran').toBeGreaterThan(0)
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )

  it(
    'P-CPU-3 · five terminals replaying Claude Code cassettes at 1×, one on screen: CPU of all Kea processes summed (the median window) within budget',
    async () => {
      const { run, kea } = await startKea()
      await kea.enter(cassetteLoop(run, [CASSETTES[0] as string], 'working-0'))
      for (let i = 1; i < WORKING; i++) {
        await kea.newTab()
        await kea.enter(cassetteLoop(run, [CASSETTES[i % CASSETTES.length] as string], `working-${i}`))
      }
      // the last tab opened is on screen; up to L.warmTerminals before it stay warm, so the first exists only in
      // ptyhost
      await measureFor(WARMUP_MS)
      const procs = await keaProcesses(kea)
      // the agents (the shells and the fake-agents under the holders) are the person's programs, not Kea: reported apart
      const agents: RoleProc[] = descendants(procs.filter((r) => r.role === 'holder').map((r) => r.p.pid)).map((p) => ({ role: 'utility', p }))
      const bytes0 = produced(run)
      const t0 = performance.now()
      const totals: number[] = []
      const roles: Record<string, number>[] = []
      const agentCpu: number[] = []
      for (let i = 0; i < RUNS; i++) {
        const w = new CpuWindow(procs)
        const a = new CpuWindow(agents)
        await Promise.all([w.start(), a.start()])
        await measureFor(WINDOW_MS)
        const [r, ra] = await Promise.all([w.stop(), a.stop()])
        totals.push(r.total)
        roles.push(r.byRole)
        agentCpu.push(ra.total)
      }
      const replayKBps = (produced(run) - bytes0) / 1000 / ((performance.now() - t0) / 1000)
      const at = totals.indexOf(median(totals))
      const b = budget('P-CPU-3')
      const values: Record<string, number> = { totalCpuPct: median(totals), totalCpuMaxPct: Math.max(...totals), agentsCpuPct: median(agentCpu), replayKBps, processes: procs.length }
      for (const [role, pct] of Object.entries(roles[at] ?? {})) values[`${role}CpuPct`] = pct
      const e = record({
        id: 'P-CPU-3',
        metric: b.metric,
        method: `${WORKING} tabs, each fake-agent looping one of fixtures/cassettes at 1×; the last opened on screen, three warm, one only in ptyhost; ${WARMUP_MS / 1000} s warm-up, then the CPU time (ps) of every Kea process — Electron's and the holders, not the shells and agents (reported as agentsCpuPct) — over ${RUNS} windows of ${WINDOW_MS / 1000} s, summed, median; per-role values are the median window's`,
        values,
        checks: [check('totalCpuPct', values.totalCpuPct as number, b.max, 'max', b.unit)],
      })
      expect(replayKBps, 'the replays ran').toBeGreaterThan(0)
      expect(e.pass, JSON.stringify(e.values)).toBe(true)
    },
    10 * 60_000,
  )
})
