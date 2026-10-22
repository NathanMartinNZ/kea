// Ptyhost's and the holder's memory budgets, and ptyhost's growth during the throughput flood measured on ptyhost alone
// (P-TERM-4), as physical footprint with `kea-helper footprint`. Run them on the reference machine with nothing else
// heavy running. Ptyhost runs in a probe process of its own on Electron's Node with its own V8 flags
// (tests/perf/ptyhost-probe.ts), so nothing of the test runner is counted. Each result is recorded in
// tools/perf/last.json like the app-level ones.
//
// The cost of one more PTY is measured in rounds: each round adds `n` PTYs in the state measured, and the per-PTY cost
// is the median over rounds of (growth in the round) / n. Growth is taken in footprint less V8's committed-but-unused
// heap (heapTotal − heapUsed): how far V8 has grown its heap is a GC policy, not memory a PTY holds, and it moves by
// tens of MB from one round to the next. What V8 does use, and everything outside its heap, counts.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { check, perfEnv, recordResult, type PerfResult } from '../../tools/perf/src/record.ts'
import { footprint } from '../memory/ptyhost-leak.ts'
import { helperBinary, holderState, ptyhostHarness, rawTty, shortKeaHome, until, type Harness } from '../support/holders.ts'
import { probe, type FillOptions, type FillResult, type FloodOptions, type FloodResult, type Memory } from './ptyhost-probe.ts'

let h: Harness | null = null
const homes: { dispose(): void }[] = []
afterEach(async () => {
  await h?.dispose()
  h = null
  for (const home of homes.splice(0)) home.dispose()
})

const MB = 1 << 20
const KB = 1 << 10
const fmt = (bytes: number, unit: number, name: string) => `${(bytes / unit).toFixed(unit === MB ? 2 : 1)} ${name}`

/** Footprint less V8's committed-but-unused heap (see the header). */
const held = (m: Memory) => m.footprint - (m.heapTotal - m.heapUsed)

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/** Record a result in tools/perf/last.json as measured here, and print its checks. */
function record(r: PerfResult): boolean {
  const e = recordResult(r, { env: perfEnv('ptyhost alone: tests/perf/ptyhost-probe.ts on Electron’s Node, its V8 flags, release kea-helper') })
  console.info(`${r.id} · ${e.checks.map((c) => `${c.name} ${c.measured.toFixed(2)} ${c.kind === 'max' ? '≤' : '≥'} ${c.limit} ${c.unit}${c.pass ? '' : ' MISSED'}`).join('; ')}`)
  return e.pass
}

/** Per-PTY growth in each round (`from`: the first round counted; earlier ones paid one-time costs). */
function perPty(r: FillResult, n: number, from: number): number[] {
  const points = [r.base, ...r.rounds]
  const out: number[] = []
  for (let i = Math.max(1, from); i < points.length; i++) out.push((held(points[i]!) - held(points[i - 1]!)) / n)
  return out
}

/**
 * The throughput flood's terminal in the app test (tests/perf/app-terminal.test.ts): the default window (design tokens
 * `window-default-*`) at the default font (`terminal.fontSize`) gives 165 × 40. The app test records its own size.
 */
const APP_COLS = 165
const APP_ROWS = 40
/** The throughput flood's footprint sampling interval in the app test. */
const P_TERM_4_SAMPLE_MS = 250

/** The budgets' own scenario: 5 000 lines of scrollback at 200 columns (P-MEM-8), plus one screen. */
const COLS = 200
const ROWS = 50
const SCROLLBACK_LINES = 5000

describe('ptyhost and holder memory', () => {
  it('P-MEM-4 · idle holders, after twice their ring of output through ptyhost, each have a footprint within budget', async () => {
    const HOLDERS = 10
    h = await ptyhostHarness({ helperSource: await helperBinary('release') })
    const harness = h
    // twice the ring: the mapped ring is full and has wrapped, and it is excluded from the footprint
    const bytes = 2 * L.ringBytesDefault
    const ptys = []
    // os-ok: in /usr/bin on both systems
    for (let i = 0; i < HOLDERS; i++) ptys.push(await harness.spawn({ argv: rawTty(['/bin/sh', '-c', `/usr/bin/head -c ${bytes} /dev/zero; exec /bin/sleep 1000000`]) }))
    for (const p of ptys) await until(`${p.ptyId}'s output through ptyhost`, () => (p.currentMirror?.parsedSeq ?? 0) >= bytes && p.pendingWrites === 0)
    const sizes: number[] = []
    for (const p of ptys) sizes.push(await footprint(harness.helper, holderState(harness.home, p.ptyId)!.pid!))
    const budget = BUDGETS['P-MEM-4'].max
    console.log(`P-MEM-4 holder footprint (release, ${HOLDERS} holders): median ${fmt(median(sizes), MB, 'MB')}, max ${fmt(Math.max(...sizes), MB, 'MB')} (budget ${fmt(budget, MB, 'MB')})`)
    const pass = record({
      id: 'P-MEM-4',
      metric: BUDGETS['P-MEM-4'].metric,
      method: `${HOLDERS} release holders, each after twice its ring (${bytes} bytes) of output through ptyhost, idle; kea-helper footprint of each (the mapped ring is not counted); the largest`,
      values: { maxMb: Math.max(...sizes) / MB, medianMb: median(sizes) / MB },
      checks: [check('max', Math.max(...sizes) / MB, budget / MB, 'max', 'MiB')],
    })
    expect(Math.max(...sizes)).toBeLessThanOrEqual(budget)
    expect(pass).toBe(true)
  })

  it(`P-MEM-8 · each awake mirror with ${SCROLLBACK_LINES} lines of scrollback at ${COLS} columns costs ptyhost at most its budget`, async () => {
    const home = shortKeaHome()
    homes.push(home)
    const o: FillOptions = { n: 8, rounds: 4, cols: COLS, rows: ROWS, lines: SCROLLBACK_LINES + ROWS }
    const r = await probe<FillResult>('awake', o, home.home)
    const each = perPty(r, o.n, 1)
    const budget = BUDGETS['P-MEM-8'].max * MB
    const heapEach = (r.rounds.at(-1)!.heapUsed - r.base.heapUsed) / (o.n * o.rounds)
    const externalEach = (r.rounds.at(-1)!.external - r.base.external) / (o.n * o.rounds)
    console.log(`P-MEM-8 per awake mirror (${COLS}×${SCROLLBACK_LINES}): median ${fmt(median(each), MB, 'MB')} [${each.map((x) => (x / MB).toFixed(2)).join(', ')}] (budget ${fmt(budget, MB, 'MB')}); JS heap ${fmt(heapEach, MB, 'MB')}, outside V8 ${fmt(externalEach, MB, 'MB')} each`)
    const pass = record({
      id: 'P-MEM-8',
      metric: BUDGETS['P-MEM-8'].metric,
      method: `ptyhost probe: ${o.rounds} rounds of ${o.n} PTYs, each filled with ${o.lines} lines of ${COLS} columns (${SCROLLBACK_LINES} of scrollback + a ${ROWS}-row screen), mirrors awake; footprint less V8's committed-but-unused heap after a forced GC; per PTY = growth in a round / ${o.n}, median over rounds`,
      values: { perMirrorMb: median(each) / MB, maxMb: Math.max(...each) / MB, minMb: Math.min(...each) / MB, jsHeapMb: heapEach / MB, externalMb: externalEach / MB },
      checks: [check('perMirrorMb', median(each) / MB, budget / MB, 'max', 'MiB')],
    })
    expect(r.report['ptyhost.ptys']).toEqual({ awake: o.n * o.rounds, parked: 0 })
    expect(median(each)).toBeLessThanOrEqual(budget)
    expect(pass).toBe(true)
  })

  it('P-MEM-9 · each parked PTY, and each exited one, costs ptyhost at most its budget', async () => {
    const budget = BUDGETS['P-MEM-9'].max * KB
    // A parked or exited PTY keeps no terminal buffers (its checkpoint is on disk), so what it showed does not change
    // what it costs; one screen each keeps the transient mirrors of a round small next to the records measured.
    const o: FillOptions = { n: 50, rounds: 4, cols: COLS, rows: ROWS, lines: ROWS }
    const values: Record<string, number> = {}
    for (const scenario of ['parked', 'exited'] as const) {
      const home = shortKeaHome()
      homes.push(home)
      const r = await probe<FillResult>(scenario, o, home.home)
      const each = perPty(r, o.n, 2)
      console.log(`P-MEM-9 per ${scenario} PTY: median ${fmt(median(each), KB, 'KB')} [${each.map((x) => (x / KB).toFixed(1)).join(', ')}] (budget ${fmt(budget, KB, 'KB')}); JS heap ${fmt((r.rounds.at(-1)!.heapUsed - r.rounds[0]!.heapUsed) / (o.n * (o.rounds - 1)), KB, 'KB')} each`)
      values[`${scenario}Kb`] = median(each) / KB
      expect(r.report['ptyhost.ptys'], scenario).toEqual({ awake: 0, parked: o.n * o.rounds })
      expect(median(each), scenario).toBeLessThanOrEqual(budget)
    }
    const pass = record({
      id: 'P-MEM-9',
      metric: BUDGETS['P-MEM-9'].metric,
      method: `ptyhost probe: ${o.rounds} rounds of ${o.n} PTYs with one screen each, then parked or exited; footprint less V8's committed-but-unused heap after a forced GC; per PTY = growth in a round / ${o.n}, median over rounds 3–${o.rounds}`,
      values,
      checks: [check('parkedKb', values.parkedKb ?? NaN, budget / KB, 'max', 'KiB'), check('exitedKb', values.exitedKb ?? NaN, budget / KB, 'max', 'KiB')],
    })
    expect(pass).toBe(true)
  })

  it('P-TERM-4 · ptyhost alone (probe): its footprint growth over 100 MB floods in the app test’s terminal, median of 5 runs after a warm-up', async () => {
    const home = shortKeaHome()
    homes.push(home)
    const b = BUDGETS['P-TERM-4']
    const bytes = Number(process.env.KEA_PERF_FLOOD_MB ?? 100) * MB // the budget's 100 MB (`pnpm perf --flood-mb`)
    const o: FloodOptions = { childNode: process.execPath, bytes, cols: APP_COLS, rows: APP_ROWS, sampleMs: P_TERM_4_SAMPLE_MS, renderer: true, warmups: 1, runs: 5 }
    const r = await probe<FloodResult>('flood', o, home.home)
    const growth = r.runs.map((x) => (x.peak.footprint - r.before.footprint) / MB)
    const values = {
      ptyhostGrowthMb: median(growth),
      maxGrowthMb: Math.max(...growth),
      mbPerS: median(r.runs.map((x) => x.mbPerS)),
      // what the growth is made of, at the median run's peak: V8's heap, and buffers outside it (the scrollback among them)
      heapTotalGrowthMb: median(r.runs.map((x) => (x.peak.heapTotal - r.before.heapTotal) / MB)),
      externalGrowthMb: median(r.runs.map((x) => (x.peak.external - r.before.external) / MB)),
      afterGrowthMb: median(r.runs.map((x) => (x.after.footprint - r.before.footprint) / MB)),
      ptyhostBaseMb: r.before.footprint / MB,
      checkpoints: r.checkpoints,
      cols: o.cols,
      rows: o.rows,
    }
    const pass = record({
      id: 'P-TERM-4 (ptyhost probe)',
      metric: `${b.metric}: ptyhost footprint growth, ptyhost alone`,
      method: `ptyhost probe, ${o.cols}×${o.rows} (the app test's terminal): process-zoo flood --bytes ${bytes} in one PTY, ${o.warmups} warm-up + ${o.runs} runs; footprint every ${o.sampleMs} ms, each run's peak − the idle footprint before the warm-up, median. Its renderer is a stand-in that returns credit at once, so the app's stream copies (a structured clone per batch, ring catch-up for a renderer behind) are not here; the app test (P-TERM-4) measures those too`,
      values,
      checks: [check('ptyhostGrowthMb', values.ptyhostGrowthMb, b.max_ptyhost_growth_mb, 'max', 'MiB'), check('mbPerS', values.mbPerS, b.min, 'min', b.unit)],
    })
    expect(pass, JSON.stringify(values)).toBe(true)
  })
})
