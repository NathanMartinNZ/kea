// The leak harness for the real app: reach a canonical state, measure every process, run a cycle that should be
// memory-neutral in batches, measure at each checkpoint, then judge exact counts (no difference at all) and bytes
// (Theil–Sen slope and absolute growth, failing only when both are over budget).
//
// How each process is read:
// · Renderer, over a CDP session: `HeapProfiler.collectGarbage` twice; `Memory.getDOMCounters` (documents, nodes, JS
//   listeners); `Runtime.queryObjects` on WebGL2RenderingContext.prototype (live contexts) and on the xterm classes a
//   test asks for (`Terminal`, `SearchAddon`, `WebglAddon`, exposed by the test probes); the renderer's own resource
//   counts (`__keaPerf.resources()`); `Runtime.getHeapUsage` for bytes.
//   Not used: `Memory.prepareForLeakDetection`, `getDOMCountersForLeakDetection` and `forciblyPurgeJavaScriptMemory`,
//   which crash this renderer, and live MessagePort objects, which would also count a UI framework's scheduler
//   channel; the renderer counts its stream ports itself (`streamPorts`).
// · Core and ptyhost, through the child hook (tests/support/app-child-hooks.cjs): forced GC twice, kit's resource
//   report, active handles by type, live MessagePortMain objects, `process.memoryUsage().heapUsed`.
// · Main, through `__keaTest` (app/main/src/testHooks.ts): forced GC, listener and handle counts, heap used.
// Heap snapshots: every run takes one of the renderer, core and ptyhost at its baseline, into the run's KEA_HOME
// (removed with it). When a byte series fails, a final one is taken of that process, and both are saved under
// test-results/leaks/<test>/ to compare in DevTools. Main has no snapshot hook; its series are judged on numbers alone.

import fs from 'node:fs'
import path from 'node:path'
import type { CDPSession } from '@playwright/test'
import { expect } from 'vitest'
import { L } from '@kea/protocol'
import { median, theilSen } from '../../tools/perf/src/stats.ts'
import { repoRoot } from '../../tools/perf/src/launch.ts'
import type { Kea } from './app.ts'

/** The default byte budgets: this suite's own tolerances for a byte series's slope and its absolute growth. */
export const BYTE_BUDGET = { slopePerCycle: 2 * 1024, absolute: 3 * 1024 * 1024 }
/** Warm-up cycles, left out of the judgement, and the checkpoints after the baseline. */
export const WARMUP_CYCLES = 2
export const CHECKPOINTS = 10
const READINGS = 3

export type Proc = 'renderer' | 'core' | 'ptyhost' | 'main'
/** One reading: counts and byte sizes keyed `<process>.<name>`. */
export type Reading = { counts: Record<string, number>; bytes: Record<string, number> }

declare const __keaPerf: { resources(): Record<string, number> }

/**
 * Classes the renderer's test probes expose for live-instance counts (app/renderer/src/lib/testProbes.ts): xterm's,
 * the file viewer's editors (`EditorView`, `MergeView`) and the palette's `PaletteData`.
 */
export type XtermClass = 'Terminal' | 'SearchAddon' | 'WebglAddon' | 'EditorView' | 'MergeView' | 'PaletteData'

/**
 * The nodes xterm's DOM renderer draws the terminals' rows with (`.xterm-rows`): where Chromium has no WebGL2 (Linux in a
 * VM or CI) the text is drawn as nodes, split by style and by the selection (a selected cell is a span of its
 * own), so their number follows what the terminals show and select, not what leaked. `renderer.nodes` leaves them out;
 * with WebGL the rows are a canvas and there are none.
 */
const DRAWN_ROW_NODES = `(() => { let n = 0; for (const rows of document.querySelectorAll('.xterm-rows')) { const w = document.createTreeWalker(rows, NodeFilter.SHOW_ALL); while (w.nextNode()) n++ } return n })()`

/** The renderer over CDP. Opened once per window; it survives reloads (the page target stays the same). */
export class RendererProbe {
  private readonly cdp: CDPSession
  private readonly classes: readonly XtermClass[]
  private constructor(cdp: CDPSession, classes: readonly XtermClass[]) {
    this.cdp = cdp
    this.classes = classes
  }

  /**
   * `classes`: the xterm classes whose live instances each reading counts (`renderer.live<Class>`), through the
   * prototypes the renderer's test probes expose. Each count is a `Runtime.queryObjects`, which collects garbage
   * first, so a test names only the ones it judges.
   */
  static async open(kea: Kea, o: { classes?: readonly XtermClass[] } = {}): Promise<RendererProbe> {
    const page = await kea.page()
    return new RendererProbe(await page.context().newCDPSession(page), o.classes ?? [])
  }

  async settle(): Promise<void> {
    await this.cdp.send('HeapProfiler.collectGarbage')
    await this.cdp.send('HeapProfiler.collectGarbage')
  }

  /** Live objects whose prototype chain has `global.prototype` (`Runtime.queryObjects` collects garbage first). */
  async liveObjects(global: string): Promise<number> {
    const proto = await this.cdp.send('Runtime.evaluate', { expression: `${global}.prototype`, objectGroup: 'kea-leak' })
    const id = proto.result.objectId
    if (!id) throw new Error(`no ${global}.prototype`)
    const found = await this.cdp.send('Runtime.queryObjects', { prototypeObjectId: id, objectGroup: 'kea-leak' })
    const n = await this.cdp.send('Runtime.callFunctionOn', { objectId: found.objects.objectId as string, functionDeclaration: 'function () { return this.length }', returnByValue: true })
    await this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'kea-leak' })
    return n.result.value as number
  }

  async read(): Promise<Reading> {
    const dom = await this.cdp.send('Memory.getDOMCounters')
    const drawn = await this.cdp.send('Runtime.evaluate', { expression: DRAWN_ROW_NODES, returnByValue: true })
    const res = await this.cdp.send('Runtime.evaluate', { expression: '__keaPerf.resources()', returnByValue: true })
    const heap = await this.cdp.send('Runtime.getHeapUsage')
    const counts: Record<string, number> = {
      'renderer.documents': dom.documents,
      'renderer.nodes': dom.nodes - (drawn.result.value as number),
      'renderer.jsEventListeners': dom.jsEventListeners,
      'renderer.liveWebgl2Contexts': await this.liveObjects('WebGL2RenderingContext'),
    }
    // live xterm objects, on the prototypes the renderer's test probes expose (app/renderer/src/lib/testProbes.ts)
    for (const cls of this.classes) counts[`renderer.live${cls}`] = await this.liveObjects(`__keaProbe.classes.${cls}`)
    // the renderer's own rows are already named `renderer.<row>`
    for (const [k, v] of Object.entries((res.result.value ?? {}) as Record<string, number>)) counts[k.startsWith('renderer.') ? k : `renderer.${k}`] = v
    return { counts, bytes: { 'renderer.heap': heap.usedSize } }
  }

  /** A heap snapshot of the renderer, written to `file`. */
  async snapshot(file: string): Promise<void> {
    const chunks: string[] = []
    const onChunk = (e: { chunk: string }) => chunks.push(e.chunk)
    this.cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
    try {
      await this.cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    } finally {
      this.cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
    }
    fs.writeFileSync(file, chunks.join(''))
  }

  async close(): Promise<void> {
    await this.cdp.detach().catch(() => undefined)
  }
}

function flatten(prefix: string, v: unknown, out: Record<string, number>): void {
  if (typeof v === 'number') out[prefix] = v
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) flatten(`${prefix}.${k}`, x, out)
}

/** Core or ptyhost after a forced GC. */
async function readChild(kea: Kea, name: 'core' | 'ptyhost'): Promise<Reading> {
  await kea.debug(name, 'gc')
  const counts: Record<string, number> = {}
  flatten(`${name}.kit`, await kea.debug(name, 'kit'), counts)
  flatten(`${name}.handles`, await kea.debug(name, 'handles'), counts)
  counts[`${name}.ports`] = (await kea.debug<number>(name, 'ports')) ?? -1
  const heap = await kea.debug<{ heapUsed: number }>(name, 'heap')
  return { counts, bytes: { [`${name}.heap`]: heap.heapUsed } }
}

async function readMain(kea: Kea): Promise<Reading> {
  await kea.gcMain()
  const { heapUsed, ...rest } = await kea.mainCounts()
  const counts: Record<string, number> = {}
  for (const [k, v] of Object.entries(rest)) counts[`main.${k}`] = v
  return { counts, bytes: { 'main.heap': heapUsed ?? 0 } }
}

/** Settle and read every process once. */
export async function readAll(kea: Kea, renderer: RendererProbe): Promise<Reading> {
  await renderer.settle()
  const parts = [await renderer.read(), await readChild(kea, 'core'), await readChild(kea, 'ptyhost'), await readMain(kea)]
  return { counts: Object.assign({}, ...parts.map((p) => p.counts)), bytes: Object.assign({}, ...parts.map((p) => p.bytes)) }
}

/**
 * The readings of one checkpoint as one, key by key: the median. A count that a reading does not have is a count of
 * none: active handles are reported by type, and a type with no handle at that moment is simply not listed (a timer
 * that had fired by the second reading). Read as "unknown", it would make the median NaN, and the failure that followed
 * would say nothing. A byte size that is missing stays unknown: every reading has every one of them.
 */
export function medianReading(rs: readonly Reading[]): Reading {
  const pick = (part: 'counts' | 'bytes', absent: number) => {
    const keys = new Set(rs.flatMap((r) => Object.keys(r[part])))
    return Object.fromEntries([...keys].map((k) => [k, median(rs.map((r) => r[part][k] ?? absent))]))
  }
  return { counts: pick('counts', 0), bytes: pick('bytes', NaN) }
}

/** A checkpoint: settle, then the median of three readings, key by key. */
export async function checkpoint(kea: Kea, renderer: RendererProbe): Promise<Reading> {
  const rs: Reading[] = []
  for (let i = 0; i < READINGS; i++) rs.push(await readAll(kea, renderer))
  return medianReading(rs)
}

export interface LeakRun {
  /** Cycles done at each checkpoint; the first entry (0) is the baseline after the warm-up. */
  cycles: number[]
  points: Reading[]
  /** Where the time went (ms): the cycles (warm-up included) and the checkpoints. */
  ms?: { cycles: number; checkpoints: number }
  /** The directory with this run's baseline heap snapshots (`<proc>-baseline.heapsnapshot`). */
  snapshots?: string
  /** What `expectCountsFlat` judged last: how many counts, and those first seen after the baseline (printed with the bytes). */
  judged?: { counts: number; late: string[] }
}

/** The processes with a heap-snapshot hook. */
const SNAPSHOT_PROCS = ['renderer', 'core', 'ptyhost'] as const
type SnapshotProc = (typeof SNAPSHOT_PROCS)[number]
let snapshotRuns = 0

async function snapshot(kea: Kea, renderer: RendererProbe, proc: SnapshotProc, file: string): Promise<void> {
  if (proc === 'renderer') await renderer.snapshot(file)
  else await kea.debug(proc, 'snapshot', file)
}

/**
 * Run `warmup` cycles (excluded), a baseline checkpoint, then `checkpoints` batches of `batch` cycles, each followed by
 * a checkpoint. `cycle(i)` gets the running cycle number (warm-up included).
 */
export async function runCycles(o: {
  kea: Kea
  renderer: RendererProbe
  batch: number
  cycle: (i: number) => Promise<void>
  warmup?: number
  checkpoints?: number
  /** Called before each checkpoint: wait for whatever the cycle leaves running to come to rest. */
  quiesce?: () => Promise<void>
  /** Take the baseline heap snapshots (default: yes; a case that cannot afford them passes false). */
  snapshots?: boolean
  /**
   * Readings of the case's own, taken once at each checkpoint after the harness's and merged into it (a process's
   * footprint, live objects of a class the probes do not expose): judged with the rest by `expectCountsFlat` and
   * `expectBytesFlat`.
   */
  extra?: () => Promise<Reading>
}): Promise<LeakRun> {
  let i = 0
  const ms = { cycles: 0, checkpoints: 0 }
  const timed = async <T>(part: keyof typeof ms, f: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try {
      return await f()
    } finally {
      ms[part] += performance.now() - t0
    }
  }
  await timed('cycles', async () => {
    for (let w = 0; w < (o.warmup ?? WARMUP_CYCLES); w++) await o.cycle(i++)
  })
  const take = () =>
    timed('checkpoints', async () => {
      await o.quiesce?.()
      const r = await checkpoint(o.kea, o.renderer)
      const x = await o.extra?.()
      return x ? { counts: { ...r.counts, ...x.counts }, bytes: { ...r.bytes, ...x.bytes } } : r
    })
  const run: LeakRun = { cycles: [0], points: [await take()], ms }
  if (o.snapshots ?? true) {
    const dir = path.join(o.kea.run.home, 'leak-snapshots', String(++snapshotRuns))
    run.snapshots = dir
    fs.mkdirSync(dir, { recursive: true })
    await timed('checkpoints', async () => {
      for (const proc of SNAPSHOT_PROCS) await snapshot(o.kea, o.renderer, proc, path.join(dir, `${proc}-baseline.heapsnapshot`))
    })
  }
  for (let c = 0; c < (o.checkpoints ?? CHECKPOINTS); c++) {
    await timed('cycles', async () => {
      for (let b = 0; b < o.batch; b++) await o.cycle(i++)
    })
    run.cycles.push(run.cycles[run.cycles.length - 1]! + o.batch)
    run.points.push(await take())
  }
  return run
}

/**
 * Timers: one armed in the canonical state (a checkpoint due after output) may fire during the run and not be
 * re-armed, so these may fall below their baseline; any growth is still a leak.
 */
// ptyTimers: ptyhost's per-PTY timers as one count; checkpoints.timer: its checkpoint scheduler's one timer
const MAY_FALL = /(?:\.timers|\.ptyTimers|\.checkpoints\.timer|\.Timeout|handle:Timeout)$/

/**
 * Levels with their own cap, not counts: they move with ordinary writes and are held to that cap instead of their
 * baseline. core's WAL: each core start writes a little, and SQLite truncates it above the cap or after
 * L.dbIdleCheckpointMs idle, which restarts a few seconds apart never reach. The watch service's `peakPendingEvents` is
 * a high-water mark, the most events ever pending at once for a worktree it follows now: it rises with the busiest
 * moment so far and goes with its worktree, and what it is reported for is L.watchRescanThreshold
 * (tests/memory/core-files.test.ts holds it to the same).
 */
const CAPPED: [RegExp, number][] = [
  [/\.db\.walBytes$/, L.dbWalTruncateBytes],
  [/\.core\.watch\.peakPendingEvents$/, L.watchRescanThreshold],
]

/**
 * Event counts, not levels: rows of a process's resource report that say how often something has happened
 * since the process started, not how much it holds now. A cycle that does the thing moves them by design (a
 * round-robin through more sessions than an LRU keeps evicts on every switch, and some leak tests check that they
 * rise), a restarted process counts from 0 again, and no value of one is a leak: they are held to nothing.
 *
 * Each is listed by its row's whole name, one by one. A pattern (`.evictions`, `.refused`) would also take the next
 * row that happens to end so and is a level, and the reports have levels that read like events: `core.files.fsmonitorWrites`,
 * `core.editors.launches`, `core.viewer.reads`, `core.servers.scans`, `core.watch.restarts` and `.polls` are all things
 * under way now. An event count that is not listed here fails the first cycle that moves it, by name; it is added
 * here with why it is not a level.
 */
export const EVENT_ROWS: ReadonlySet<string> = new Set([
  // Sessions whose caches the files service's LRU dropped since core started (files/service.ts `evictions`)
  'core.files.evictions',
  // Worktrees the watch service's LRU released since core started (platform/watch/watcher.ts `evictions`)
  'core.watch.evictions',
  // file and directory watches refused at the watch service's cap since core started (`refused`)
  'core.watch.refused',
  // Worktrees not followed, every followed one being on screen, since core started (`refusedWorktrees`; the
  // row's name reads like a level, "not followed now", and is not one)
  'core.watch.unfollowed',
  // Worktrees released, or not followed, at the entries cap since core started (`entriesReleased`)
  'core.watch.entriesReleased',
  // Log lines the process could not write since it started (kit/logger.ts; a row of every process's report)
  'kit.log.dropped',
])

/**
 * Requests in flight, not things held: Node lists an fs call, a write to a socket or pipe and a few more among a
 * process's active resources (`process.getActiveResourcesInfo()`) from the moment it is issued until its callback has
 * run. A reading that falls inside one sees it: core writes a log line, a WAL page or a state file at moments no cycle
 * controls, so a checkpoint can catch one and the next not. Held to its baseline such a count fails a run at random.
 * Each is listed by its whole handle type, and only the types that are requests by Node's own definition (a `…Req…` or
 * a write's `…Wrap`), never a handle that holds something (a socket, a pipe, a child, a watcher, a timer):
 * - `FSReqCallback`: an `fs` call with a callback (core's and ptyhost's file writes, the logger's appends);
 * - `FSReqPromise`: an `fs.promises` call (core's state and worktree reads);
 * - `WriteWrap`: a write to a stream handle still being flushed (a pipe to a holder, the child hook's own reply);
 * - `ShutdownWrap`: a stream's end still being flushed (a holder connection closing).
 * Such a count may stand above where it rests (its lowest value in the run) at a checkpoint, but never at two in a
 * row: a request that is still there one checkpoint later is not in flight but held, and a leak.
 */
export const TRANSIENT_HANDLES: ReadonlySet<string> = new Set(['FSReqCallback', 'FSReqPromise', 'WriteWrap', 'ShutdownWrap'])

/** The handle type a count is, if it is a request named in TRANSIENT_HANDLES (`core.handles.<type>`, `main.handle:<type>`). */
function transient(key: string): boolean {
  const type = /^(?:core|ptyhost)\.handles\.(.+)$/.exec(key)?.[1] ?? /^main\.handle:(.+)$/.exec(key)?.[1]
  return type !== undefined && TRANSIENT_HANDLES.has(type)
}

/**
 * The report row a count is, if it is one: a reading names a process's rows `<process>.kit.<row>` (the child hook's `kit`
 * op, `readChild` here) or `<process>.report.<row>` (main's resources line, tests/perf/app-nowindow.test.ts). Null for
 * what is not a row of a report: handles, ports, DOM counters, live objects, main's own counts.
 */
function reportRow(key: string): string | null {
  return /^(?:core|ptyhost|main)\.(?:kit|report)\.(.+)$/.exec(key)?.[1] ?? null
}

/**
 * Exact counts: every listed count equals its baseline at every checkpoint (timers: never above it; CAPPED levels:
 * never above their cap; EVENT_ROWS: not levels, held to nothing; TRANSIENT_HANDLES: above where they rest at no two
 * checkpoints in a row). Every count any checkpoint lists is judged, the baseline's and those first seen later (a
 * handle type, a report row, a listener that appears in the run); one that a checkpoint does not list is none there
 * (as in `medianReading`: a handle type with no handle left, a timer that fired), the baseline included, so a count
 * that appeared or fell is reported with its numbers.
 */
export function expectCountsFlat(run: LeakRun, keys: (key: string) => boolean): void {
  const seen = [...new Set(run.points.flatMap((p) => Object.keys(p.counts)))].filter(keys)
  run.judged = { counts: seen.length, late: seen.filter((k) => !(k in run.points[0]!.counts)) }
  const drift: Record<string, number[]> = {}
  for (const k of seen) {
    if (EVENT_ROWS.has(reportRow(k) ?? '')) continue
    const series = run.points.map((p) => p.counts[k] ?? 0)
    const b = series[0] as number
    const cap = CAPPED.find(([re]) => re.test(k))?.[1]
    let moved: boolean
    if (cap !== undefined) moved = series.some((v) => !(v <= cap))
    else if (transient(k)) {
      const rest = Math.min(...series)
      moved = series.some((v, i) => i > 0 && v > rest && (series[i - 1] as number) > rest)
    } else if (MAY_FALL.test(k)) moved = series.some((v) => !(v <= b))
    else moved = series.some((v) => v !== b)
    if (moved) drift[k] = series
  }
  expect(drift, 'counts that moved from their baseline (series: baseline, then each checkpoint)').toEqual({})
}

export interface ByteVerdict {
  key: string
  slopePerCycle: number
  growth: number
  ok: boolean
}

/** Bytes: fail only if the Theil–Sen slope and the absolute growth both exceed the budget. */
export function byteVerdict(run: LeakRun, key: string, budget = BYTE_BUDGET): ByteVerdict {
  const ys = run.points.map((p) => p.bytes[key] ?? NaN)
  const slopePerCycle = theilSen(run.cycles, ys)
  const growth = (ys[ys.length - 1] as number) - (ys[0] as number)
  return { key, slopePerCycle, growth, ok: !(slopePerCycle > budget.slopePerCycle && growth > budget.absolute) }
}

/**
 * Every listed byte series within budget. On failure, for each failing process with a snapshot hook, a final heap
 * snapshot and the run's baseline one beside it, under test-results/leaks/<name>/.
 */
export async function expectBytesFlat(kea: Kea, renderer: RendererProbe, run: LeakRun, keys: string[], name: string, budget = BYTE_BUDGET): Promise<ByteVerdict[]> {
  const verdicts = keys.map((k) => byteVerdict(run, k, budget))
  // the run in one line, for the record: counts judged (and those first seen after the baseline), each byte series
  const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`
  const counts = run.judged ? `${run.judged.counts} counts judged${run.judged.late.length ? ` (first seen after the baseline: ${run.judged.late.join(', ')})` : ''}; ` : ''
  console.log(`${name}: ${run.cycles.at(-1)} cycles, ${counts}${verdicts.map((v) => `${v.key} ${v.slopePerCycle.toFixed(0)} B/cycle, ${kb(v.growth)}${v.ok ? '' : ' OVER'}`).join('; ')}`)
  const bad = verdicts.filter((v) => !v.ok)
  const saved: string[] = []
  if (bad.length) {
    const dir = path.join(repoRoot, 'test-results', 'leaks', name.replace(/[^\w-]+/g, '_'))
    fs.mkdirSync(dir, { recursive: true })
    for (const proc of new Set(bad.map((v) => v.key.split('.')[0] as Proc))) {
      if (!(SNAPSHOT_PROCS as readonly string[]).includes(proc)) continue
      const p = proc as SnapshotProc
      await snapshot(kea, renderer, p, path.join(dir, `${p}-final.heapsnapshot`))
      const baseline = run.snapshots ? path.join(run.snapshots, `${p}-baseline.heapsnapshot`) : null
      if (baseline && fs.existsSync(baseline)) fs.copyFileSync(baseline, path.join(dir, `${p}-baseline.heapsnapshot`))
      saved.push(p)
    }
    if (saved.length) saved.unshift(`heap snapshots in ${dir}:`)
  }
  expect(bad, `byte growth over budget (slope ${budget.slopePerCycle} B/cycle and ${budget.absolute} B absolute)${saved.length ? `; ${saved.join(' ')}` : ''}`).toEqual([])
  return verdicts
}
