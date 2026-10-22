// The GPU memory run: a long Claude Code cassette loop, truecolor shimmer included, in xterm with WebGL (at most
// L.webglContextsMax contexts), plus 20 headless mirrors that park and unpark. It measures the atlas
// guard's threshold at work, what warm terminals parsing output cost and what the memory budgets bound, over hours. The
// test of the GPU helper after 2 h of this is the same run (P-GPU-2, tests/perf/app-gpu.test.ts);
// `node tools/perf/src/gpu-soak.ts --duration 2h` starts it on its own.
//
// The scene, in one window, with tabs standing in for sessions:
//   visible   the first tab: tools/perf/src/workloads/agent-loop.ts replaying every cassette in turn at 1×, each
//             followed by SHIMMER_MS of tests/support/shimmer.ts's unbounded truecolor shimmer (the worst case for
//             @xterm/addon-webgl, whose atlas grows with per-cell truecolor; the recorded spinner has only a few
//             colours), always on
//   warm × 3  the same loop, switched on and off together every warm phase (on, off, on, …), so the renderer's CPU
//             with three warm terminals parsing output can be told from its CPU without
//   mirrors   20 tabs that were on screen once and then fell out of the renderer's set: one cassette burst every
//             L.mirrorParkIdleMs + BURST_SLACK_MS, staggered, so each mirror parks after its idle time and unparks on
//             the next burst
//
// Every sample it records: per-process physical footprint (kea-helper footprint) and CPU (ps, or /proc on Linux), by
// role; the atlas of each WebGL view (bytes, pages, guard clears) and the renderer's resource report;
// WebGL contexts; long tasks, context losses and renders of the visible terminal (in-page observers, no rAF loop, which
// would make the compositor draw every frame and inflate the renderer's CPU); ptyhost's awake and parked mirrors. The
// output is the time series plus a summary with a draft results row (`resultsRow`).

import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol'
import { processTable, repoRoot } from '../../tools/perf/src/launch.ts'
import { perfEnv } from '../../tools/perf/src/record.ts'
import { theilSen } from '../../tools/perf/src/stats.ts'
import { type Kea, type ViewProbe } from '../support/app.ts'
import { BYTE_BUDGET, byteVerdict } from '../support/app-leak.ts'
import { budget, CASSETTES, cpuSeconds, footprints, keaProcesses, measureFor, ptyhostMirrors, startKea, workload, type RoleProc } from './app-harness.ts'

export interface SoakOptions {
  durationMs: number
  sampleMs: number
  /** Headless mirrors (20 by default). */
  mirrors: number
  /** Length of each warm phase (on, then off, …). */
  warmPhaseMs: number
  /** Shimmer after each cassette in the visible and warm loops. */
  shimmerMs: number
  /** Silence after each mirror burst: past L.mirrorParkIdleMs, so the mirror parks before the next. */
  burstGapMs: number
  /** Where the time series and summary are written. */
  out: string
}

/** The run's two hours, the GPU budget's too (P-GPU-2). */
export const SOAK_DURATION_MS = 2 * 60 * 60_000
export const SOAK_SAMPLE_MS = 10_000
const MIRRORS = 20
const SHIMMER_MS = 20_000
/** A mirror's next burst comes this long after it could have parked. */
const BURST_SLACK_MS = 30_000
/** Warm phases: an eighth of the run, between these bounds (2 h: 10 min on, 10 min off, six times). */
const WARM_PHASE_MIN_MS = 30_000
const WARM_PHASE_MAX_MS = 10 * 60_000

export function soakOptions(o: Partial<SoakOptions> = {}): SoakOptions {
  const durationMs = o.durationMs ?? SOAK_DURATION_MS
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    durationMs,
    sampleMs: o.sampleMs ?? SOAK_SAMPLE_MS,
    mirrors: o.mirrors ?? MIRRORS,
    warmPhaseMs: o.warmPhaseMs ?? Math.min(WARM_PHASE_MAX_MS, Math.max(WARM_PHASE_MIN_MS, Math.round(durationMs / 8))),
    shimmerMs: o.shimmerMs ?? SHIMMER_MS,
    burstGapMs: o.burstGapMs ?? L.mirrorParkIdleMs + BURST_SLACK_MS,
    out: o.out ?? path.join(repoRoot, 'test-results', 'perf', `gpu-soak-${stamp}.json`),
  }
}

type Role = RoleProc['role']
export interface SoakSample {
  /** Seconds since the measurement started. */
  t: number
  /** The warm terminals were producing output in this interval. */
  warmOn: boolean
  /** Footprint by role (MiB; holders summed) and in total. */
  mb: Partial<Record<Role, number>> & { total: number; holderMax: number }
  /** CPU over the interval since the last sample, % of one core, by role and in total. */
  cpu: Partial<Record<Role, number>> & { total: number }
  /** Each WebGL view's atlas: the visible one first. */
  atlas: { ptyId: string; visible: boolean; mb: number; pages: number; guardClears: number }[]
  /** The renderer's own counts: live terminals, WebGL contexts, atlas bytes (shared pages once) and pages. */
  renderer: { terminals: number; webglContexts: number; atlasMb: number; atlasPages: number }
  /** Views holding WebGL, and views that fell back to the DOM renderer while they should not have. */
  webglViews: number
  domFallbacks: number
  /** In the interval: long tasks and the longest, renders of the visible terminal; since the start: context losses. */
  longTasks: number
  longTaskMaxMs: number
  renders: number
  contextLosses: number
  /** Ptyhost's mirrors. */
  mirrorsAwake: number
  mirrorsParked: number
  gpuPid: number | null
  /** The page was reloaded (a renderer crash) since the last sample. */
  reloaded: boolean
}

export interface SoakSummary {
  durationMin: number
  samples: number
  setup: { tabs: number; cols: number; rows: number; warmPhaseMin: number; shimmerS: number; burstGapS: number }
  gpu: { firstMb: number; maxMb: number; lastMb: number; lastHalf: { minMb: number; maxMb: number; slopeMbPerMin: number; growthMb: number; flat: boolean } }
  atlas: { visibleMaxMb: number; rendererMaxMb: number; pagesMax: number; guardClears: number; clearsPerMin: number; samplesOverThreshold: number; thresholdMb: number }
  footprintMb: Record<string, { start: number; end: number; max: number }>
  cpuPct: { rendererWarmOn: number; rendererWarmOff: number; warmCost: number; total: number; gpu: number; ptyhost: number; rendererMax: number }
  mirrors: { awakeMin: number; awakeMax: number; parks: number; unparks: number }
  stability: { contextLosses: number; domFallbackSamples: number; longTasks: number; longTaskMaxMs: number; rendererReloads: number; gpuProcessRestarts: number; maxWebglContexts: number; samplesWithoutRenders: number }
  /** A draft results row in Markdown: the date and what the run measured. */
  resultsRow: string
}

declare const __keaProbe: { terminal(id: string): { onRender(cb: () => void): { dispose(): void } } | undefined }
declare const __keaPerf: { resources(): Record<string, number> }
type PageState = { longTasks: number; longTaskMaxMs: number; renders: number; contextLosses: number }

/** In-page observers (no rAF): long tasks, context losses anywhere, renders of the visible terminal. */
async function watchPage(kea: Kea, visible: string): Promise<void> {
  await (
    await kea.page()
  ).evaluate((id) => {
    const w = window as unknown as { __keaGpuSoak?: PageState }
    if (w.__keaGpuSoak) return
    const st: PageState = { longTasks: 0, longTaskMaxMs: 0, renders: 0, contextLosses: 0 }
    w.__keaGpuSoak = st
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        st.longTasks++
        st.longTaskMaxMs = Math.max(st.longTaskMaxMs, e.duration)
      }
    }).observe({ type: 'longtask' })
    window.addEventListener('webglcontextlost', () => st.contextLosses++, true)
    __keaProbe.terminal(id)?.onRender(() => st.renders++)
  }, visible)
}

/** Read and reset the interval counters; null if the page lost them (it was reloaded). */
async function readPage(kea: Kea): Promise<(PageState & { resources: Record<string, number> }) | null> {
  return (await kea.page()).evaluate(() => {
    const st = (window as unknown as { __keaGpuSoak?: PageState }).__keaGpuSoak
    if (!st) return null
    const out = { ...st, resources: __keaPerf.resources() }
    st.longTasks = 0
    st.longTaskMaxMs = 0
    st.renders = 0
    return out
  })
}

const mib = (b: number) => b / 2 ** 20
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d

/** Set up the scene, sample it for `o.durationMs`, write the JSON and return it. */
export async function runGpuSoak(o: SoakOptions): Promise<{ samples: SoakSample[]; summary: SoakSummary; out: string }> {
  const { kea } = await startKea()
  const visible = (await kea.shown()) as string
  const casts = CASSETTES.flatMap((c) => ['--cast', c])
  // mirrors first: each is on screen while its command is typed, then falls out of the renderer's set
  for (let i = 0; i < o.mirrors; i++) {
    await kea.newTab()
    const cast = CASSETTES[i % CASSETTES.length] as string
    await kea.enter(workload('agent-loop', ['--cast', cast, '--gap-ms', String(o.burstGapMs), '--delay-ms', String(Math.round((i * o.burstGapMs) / o.mirrors))]))
  }
  const epoch = Date.now()
  const warm: string[] = []
  for (let i = 0; i < L.warmTerminals; i++) {
    warm.push(await kea.newTab())
    await kea.enter(workload('agent-loop', [...casts, '--shimmer-ms', String(o.shimmerMs), '--duty-on-ms', String(o.warmPhaseMs), '--duty-off-ms', String(o.warmPhaseMs), '--epoch', String(epoch)]))
  }
  // one switch back to the first tab: on screen, and the three just opened stay warm (most recently viewed)
  await kea.clickTab(visible)
  await kea.enter(workload('agent-loop', [...casts, '--shimmer-ms', String(o.shimmerMs)]))
  const views = await kea.views()
  const gl = views.filter((v) => v.webgl).map((v) => v.ptyId)
  if (gl.length !== 1 + L.warmTerminals || !gl.includes(visible) || !warm.every((w) => gl.includes(w))) throw new Error(`the GPU memory run needs the visible terminal and ${L.warmTerminals} warm ones with WebGL, got ${JSON.stringify(views.map((v) => [v.ptyId, v.webgl, v.visible]))}`)
  const vis = views.find((v) => v.ptyId === visible) as ViewProbe
  await watchPage(kea, visible)

  const samples: SoakSample[] = []
  const t0 = Date.now()
  let procs: RoleProc[] = await keaProcesses(kea)
  let cpu0 = await cpuSeconds(procs.map((r) => r.p))
  let tPrev = performance.now()
  for (let k = 1; ; k++) {
    const due = t0 + k * o.sampleMs
    if (due - t0 > o.durationMs) break
    await measureFor(due - Date.now())
    const table = processTable()
    const [fp, cpu1] = await Promise.all([footprints(procs.map((r) => r.p), table), cpuSeconds(procs.map((r) => r.p), table)])
    const tNow = performance.now()
    const secs = (tNow - tPrev) / 1000
    const mb: SoakSample['mb'] = { total: 0, holderMax: 0 }
    const pct: SoakSample['cpu'] = { total: 0 }
    for (const { role, p } of procs) {
      const b = fp.get(p.pid)
      if (b !== undefined) {
        mb[role] = (mb[role] ?? 0) + mib(b)
        mb.total += mib(b)
        if (role === 'holder') mb.holderMax = Math.max(mb.holderMax, mib(b))
      }
      const a = cpu0.get(p.pid)
      const c = cpu1.get(p.pid)
      if (a !== undefined && c !== undefined) {
        const x = ((c - a) / secs) * 100
        pct[role] = (pct[role] ?? 0) + x
        pct.total += x
      }
    }
    let page = await readPage(kea)
    const reloaded = page === null
    if (reloaded) {
      await watchPage(kea, visible)
      page = await readPage(kea)
    }
    const vs = await kea.views()
    const m = await ptyhostMirrors(kea)
    const res = page?.resources ?? {}
    const phase = Math.floor((Date.now() - epoch) / o.warmPhaseMs) % 2 === 0
    samples.push({
      t: round((Date.now() - t0) / 1000, 0),
      warmOn: phase,
      mb,
      cpu: pct,
      atlas: [visible, ...warm].flatMap((id) => {
        const v = vs.find((x) => x.ptyId === id)
        return v ? [{ ptyId: id, visible: id === visible, mb: mib(v.atlas.bytes), pages: v.atlas.pages, guardClears: v.atlas.clears.guard ?? 0 }] : []
      }),
      renderer: { terminals: res['renderer.terminals'] ?? NaN, webglContexts: res['renderer.webglContexts'] ?? NaN, atlasMb: mib(res['renderer.atlasBytes'] ?? NaN), atlasPages: res['renderer.atlasPages'] ?? NaN },
      webglViews: vs.filter((v) => v.webgl).length,
      domFallbacks: vs.filter((v) => (v.ptyId === visible || warm.includes(v.ptyId)) && !v.webgl).length,
      longTasks: page?.longTasks ?? NaN,
      longTaskMaxMs: page?.longTaskMaxMs ?? NaN,
      renders: page?.renders ?? NaN,
      contextLosses: page?.contextLosses ?? NaN,
      mirrorsAwake: m.awake,
      mirrorsParked: m.parked,
      gpuPid: procs.find((r) => r.role === 'gpu')?.p.pid ?? null,
      reloaded,
    })
    // the next interval's processes (a GPU helper or renderer may have been replaced) and CPU baseline
    const next = await keaProcesses(kea, table)
    if (next.map((r) => r.p.pid).join() !== procs.map((r) => r.p.pid).join()) {
      procs = next
      cpu0 = await cpuSeconds(procs.map((r) => r.p))
    } else cpu0 = cpu1
    tPrev = tNow
  }
  await kea.assertUnfocused()
  const summary = summarize(samples, o, { tabs: await kea.tabCount(), cols: vis.cols, rows: vis.rows })
  const report = { run: 'gpu-soak', startedAt: new Date(t0).toISOString(), env: perfEnv(), options: o, summary, samples }
  fs.mkdirSync(path.dirname(o.out), { recursive: true })
  fs.writeFileSync(o.out, `${JSON.stringify(report, null, 1)}\n`)
  return { samples, summary, out: o.out }
}

/** The summary of a run (also run on a saved file by tools/perf/src/gpu-soak.ts). */
export function summarize(samples: SoakSample[], o: SoakOptions, setup: { tabs: number; cols: number; rows: number }): SoakSummary {
  const last = samples.at(-1)
  const gpuMb = samples.map((s) => s.mb.gpu ?? NaN)
  const halfT = (last?.t ?? 0) / 2
  const tail = samples.filter((s) => s.t >= halfT)
  const tailGpu = tail.map((s) => s.mb.gpu ?? NaN)
  const minutes = tail.map((s) => s.t / 60)
  const flatMin = Math.max(1, (minutes.at(-1) ?? 0) - (minutes[0] ?? 0))
  // the leak suite's byte rule per minute, as the long terminal leak test applies it (L-TERM-3): flat unless both the
  // slope and the growth exceed the budget
  const flat = byteVerdict({ cycles: minutes, points: tail.map((s) => ({ counts: {}, bytes: { gpu: (s.mb.gpu ?? NaN) * 2 ** 20 } })) }, 'gpu', { slopePerCycle: BYTE_BUDGET.absolute / flatMin, absolute: BYTE_BUDGET.absolute })
  const visAtlas = samples.map((s) => s.atlas.find((a) => a.visible))
  const clears = last ? last.atlas.reduce((n, a) => n + a.guardClears, 0) : 0
  const roles = new Set(samples.flatMap((s) => Object.keys(s.mb)))
  const footprintMb: SoakSummary['footprintMb'] = {}
  for (const r of roles) {
    const xs = samples.map((s) => (s.mb as Record<string, number>)[r] ?? NaN)
    footprintMb[r] = { start: round(xs[0] ?? NaN), end: round(xs.at(-1) ?? NaN), max: round(Math.max(...xs.filter(Number.isFinite))) }
  }
  // the first interval holds the setup's tail; CPU is averaged from the second sample on
  const steady = samples.slice(1)
  const rOn = steady.filter((s) => s.warmOn).map((s) => s.cpu.renderer ?? NaN)
  const rOff = steady.filter((s) => !s.warmOn).map((s) => s.cpu.renderer ?? NaN)
  let parks = 0
  let unparks = 0
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]!.mirrorsParked - samples[i - 1]!.mirrorsParked
    if (d > 0) parks += d
    else unparks -= d
  }
  const gpuPids = new Set(samples.map((s) => s.gpuPid))
  const s: Omit<SoakSummary, 'resultsRow'> = {
    durationMin: round((last?.t ?? 0) / 60),
    samples: samples.length,
    setup: { ...setup, warmPhaseMin: round(o.warmPhaseMs / 60_000, 2), shimmerS: o.shimmerMs / 1000, burstGapS: o.burstGapMs / 1000 },
    gpu: {
      firstMb: round(gpuMb[0] ?? NaN),
      maxMb: round(Math.max(...gpuMb)),
      lastMb: round(gpuMb.at(-1) ?? NaN),
      lastHalf: { minMb: round(Math.min(...tailGpu)), maxMb: round(Math.max(...tailGpu)), slopeMbPerMin: round(theilSen(minutes, tailGpu), 3), growthMb: round((tailGpu.at(-1) ?? NaN) - (tailGpu[0] ?? NaN)), flat: flat.ok },
    },
    atlas: {
      visibleMaxMb: round(Math.max(...visAtlas.map((a) => a?.mb ?? 0))),
      rendererMaxMb: round(Math.max(...samples.map((x) => x.renderer.atlasMb).filter(Number.isFinite))),
      pagesMax: Math.max(...samples.map((x) => x.renderer.atlasPages).filter(Number.isFinite)),
      guardClears: clears,
      clearsPerMin: round(clears / Math.max(1, (last?.t ?? 0) / 60), 2),
      samplesOverThreshold: samples.filter((x) => x.atlas.some((a) => a.mb > mib(L.atlasGuardBytes))).length,
      thresholdMb: mib(L.atlasGuardBytes),
    },
    footprintMb,
    cpuPct: {
      rendererWarmOn: round(mean(rOn)),
      rendererWarmOff: round(mean(rOff)),
      warmCost: round(mean(rOn) - mean(rOff)),
      total: round(mean(steady.map((x) => x.cpu.total))),
      gpu: round(mean(steady.map((x) => x.cpu.gpu ?? NaN))),
      ptyhost: round(mean(steady.map((x) => x.cpu.ptyhost ?? NaN))),
      rendererMax: round(Math.max(...steady.map((x) => x.cpu.renderer ?? NaN))),
    },
    mirrors: { awakeMin: Math.min(...samples.map((x) => x.mirrorsAwake)), awakeMax: Math.max(...samples.map((x) => x.mirrorsAwake)), parks, unparks },
    stability: {
      contextLosses: last?.contextLosses ?? NaN,
      domFallbackSamples: samples.filter((x) => x.domFallbacks > 0).length,
      longTasks: samples.reduce((n, x) => n + (Number.isFinite(x.longTasks) ? x.longTasks : 0), 0),
      longTaskMaxMs: round(Math.max(0, ...samples.map((x) => x.longTaskMaxMs).filter(Number.isFinite))),
      rendererReloads: samples.filter((x) => x.reloaded).length,
      gpuProcessRestarts: Math.max(0, gpuPids.size - 1),
      maxWebglContexts: Math.max(...samples.map((x) => Math.max(x.webglViews, Number.isFinite(x.renderer.webglContexts) ? x.renderer.webglContexts : 0))),
      samplesWithoutRenders: samples.filter((x) => x.renders === 0).length,
    },
  }
  return { ...s, resultsRow: resultsRow(s) }
}

function resultsRow(s: Omit<SoakSummary, 'resultsRow'>): string {
  const date = new Date().toISOString().slice(0, 10)
  const fp = (r: string) => (s.footprintMb[r] ? `${r} ${s.footprintMb[r]!.start}→${s.footprintMb[r]!.end} (max ${s.footprintMb[r]!.max})` : null)
  const gpuBudget = `${budget('P-GPU-2').max} ${budget('P-GPU-2').unit}` // the 2^20-byte units it is compared in
  const result = [
    `\`tools/perf/src/gpu-soak.ts\` (tests/perf/app-gpu-soak.ts), ${s.durationMin} min, release bundle, ${s.setup.tabs} tabs at ${s.setup.cols}×${s.setup.rows}: the visible terminal and ${L.warmTerminals} warm ones (WebGL) loop the five Claude Code cassettes at 1× with ${s.setup.shimmerS} s of unbounded truecolor shimmer after each (warm ones on/off every ${s.setup.warmPhaseMin} min); ${s.setup.tabs - 1 - L.warmTerminals} headless mirrors get a cassette burst every ${s.setup.burstGapS} s.`,
    `**Atlas** (guard at ${s.atlas.thresholdMb} MiB): visible terminal max ${s.atlas.visibleMaxMb} MiB, renderer max ${s.atlas.rendererMaxMb} MiB / ${s.atlas.pagesMax} pages, ${s.atlas.guardClears} guard clears (${s.atlas.clearsPerMin}/min), ${s.atlas.samplesOverThreshold} samples above the threshold.`,
    `**GPU helper**: ${s.gpu.firstMb} → ${s.gpu.lastMb} MiB, max ${s.gpu.maxMb} (P-GPU-2 ≤ ${gpuBudget}); last half ${s.gpu.lastHalf.minMb}–${s.gpu.lastHalf.maxMb} MiB, slope ${s.gpu.lastHalf.slopeMbPerMin} MiB/min, ${s.gpu.lastHalf.flat ? 'flat' : 'not flat'}.`,
    `**Footprint** (MiB, first → last sample): ${['main', 'renderer', 'gpu', 'network', 'core', 'ptyhost', 'utility', 'zygote', 'holder', 'total'].map(fp).filter(Boolean).join('; ')}.`,
    `**CPU** (% of one core): renderer ${s.cpuPct.rendererWarmOn} with the 3 warm terminals working vs ${s.cpuPct.rendererWarmOff} idle (cost ${s.cpuPct.warmCost}); all Kea processes ${s.cpuPct.total}, GPU ${s.cpuPct.gpu}, ptyhost ${s.cpuPct.ptyhost}.`,
    `**Mirrors**: awake ${s.mirrors.awakeMin}–${s.mirrors.awakeMax}, ${s.mirrors.parks} parks, ${s.mirrors.unparks} unparks.`,
    `**Stability**: ${s.stability.contextLosses} context losses, ${s.stability.domFallbackSamples} samples with a DOM fallback, ${s.stability.rendererReloads} renderer reloads, ${s.stability.gpuProcessRestarts} GPU process restarts, WebGL contexts ≤ ${s.stability.maxWebglContexts}, ${s.stability.longTasks} long tasks (max ${s.stability.longTaskMaxMs} ms), ${s.stability.samplesWithoutRenders} samples without a render of the visible terminal.`,
  ].join(' ')
  return `| ${date} | ${result} |`
}

/** Markdown summary of a run, for the console and `gpu-soak.ts`. */
export function summaryText(s: SoakSummary, out: string): string {
  return [`GPU memory run (${s.durationMin} min, ${s.samples} samples) → ${path.relative(repoRoot, out)}`, '', '```json', JSON.stringify({ ...s, resultsRow: undefined }, null, 2), '```', '', 'Draft results row:', '', s.resultsRow].join('\n')
}
