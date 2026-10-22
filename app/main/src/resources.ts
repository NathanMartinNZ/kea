// Main's half of the resource report and the footprint sampler. No Electron here: main.ts supplies the processes, so
// this file is unit-tested in Node.
//
// · Collection. Main asks every process for its report — core and ptyhost with `{ k: 'report', id }` on parentPort,
//   each window's renderer with `kea:resources` through the preload — and its own comes from kit's registry. Each
//   request ends at its answer, a refused answer, the process's exit (a window's close or reload), or after
//   L.resourceReportTimeoutMs, never awaited longer. A process with no report is listed under `missing` with why:
//   `not running` (a child stopped or restarting: not asked), `no answer` (none, or none that passed the checks, in
//   time) or `no window` (the renderer while no window is open).
// · Footprint sampler. One `kea-helper footprint <pid…>` run per L.watchdogIntervalMs over Kea's own processes (those
//   `app.getAppMetrics()` lists: main, renderers, the GPU helper, core, ptyhost, Electron's network service), through
//   `runProcess`, at most one run at a time. The newest L.metricsSamplesKept samples are kept (one hour), oldest
//   dropped. The sampler's interval is main's only resource timer: the hourly line rides on it, whether or not that
//   interval's sample succeeded.
// · The line. `<KEA_HOME>/logs/resources.ndjson`, one JSON object per line, rotated like every log:
//   `{"t","level":"info","proc":"main","msg":"resources","trigger","reports":{<process>:{<row>:…}},"missing":{<process>:<why>},
//    "footprint":{"t","pids":{<process>:<pid>},"bytes":{<process>:<bytes>},"errors"?} | null}`. A gauge that threw
//   (NaN) is written as null: JSON has no NaN. Written at the first sampler interval L.resourceLogIntervalMs after the
//   last line (with that interval's sample, null if it failed), on a watchdog trigger (watchdog.ts: the line
//   then also holds `watchdog`, what was found over which limit and what is done about it, and the sample it was found
//   in), and by the test hook. Lines are written one after another, each with its own trigger.

import { BoundedQueue, createLogger, runProcess, Scope, systemClock, type Clock, type Disposable, type FileLogger, type Logger, type ProcessResult, type RunProcessOptions } from '@kea/kit'
import { L, type ResourceReport } from '@kea/protocol'

// ── requests answered by id ─────────────────────────────────────────────────────────────

/**
 * Requests answered by id, each ended by its answer or its deadline. `from` names who was asked (a renderer's
 * webContents id): an answer from anyone else is ignored.
 */
export class Replies<T> implements Disposable {
  private next = 1
  // bounded: one per request in flight; each leaves at its answer, its deadline (L.resourceReportTimeoutMs) or cancelAll
  private readonly waiting = new Map<number, { from: number | undefined; done: (v: T | null) => void }>()
  private readonly scope: Scope

  constructor(clock: Clock = systemClock) {
    this.scope = new Scope('Replies', { clock })
  }

  /** Requests waiting for their answer. */
  get size(): number {
    return this.waiting.size
  }

  /** Send a request with a fresh id; resolves with the answer, or null at the deadline or on `cancelAll`. */
  ask(send: (id: number) => void, deadlineMs: number, from?: number): Promise<T | null> {
    if (this.scope.isDisposed) return Promise.resolve(null)
    const id = this.next++
    return new Promise<T | null>((resolve) => {
      const timer = this.scope.timeout(() => done(null), deadlineMs)
      const done = (v: T | null) => {
        if (!this.waiting.delete(id)) return
        timer.dispose()
        resolve(v)
      }
      this.waiting.set(id, { from, done })
      try {
        send(id)
      } catch {
        done(null)
      }
    })
  }

  /** An answer; false when nobody waits for `id` (late, unknown, or from someone not asked). */
  answer(id: number, v: T, from?: number): boolean {
    const w = this.waiting.get(id)
    if (!w || w.from !== from) return false
    w.done(v)
    return true
  }

  /** Request `id` ends now with no answer (its answer was refused); false when nobody waits for it from `from`. */
  end(id: number, from?: number): boolean {
    const w = this.waiting.get(id)
    if (!w || w.from !== from) return false
    w.done(null)
    return true
  }

  /** Every request sent to `from` resolves null (its window closed, reloaded or lost its renderer). */
  cancelFrom(from: number): void {
    for (const w of [...this.waiting.values()]) if (w.from === from) w.done(null)
  }

  /** Every waiting request resolves null (the process asked has exited). */
  cancelAll(): void {
    for (const w of [...this.waiting.values()]) w.done(null)
  }

  dispose(): void {
    this.cancelAll()
    this.scope.dispose()
  }
}

// ── collection ──────────────────────────────────────────────────────────────────────────

/** Why a process gave no report. */
export type MissingReason = 'not running' | 'no answer' | 'no window'

/** `main`, `core`, `ptyhost`, `renderer` (the first window; `renderer:<id>` for any other). */
export type ReportSource =
  /** The process's report, or null when no valid answer came in time (refused, ended, or the deadline passed). */
  | { name: string; ask(): Promise<ResourceReport | null> }
  /** A process known to be absent: it is not asked. */
  | { name: string; absent: Exclude<MissingReason, 'no answer'> }

export interface Collected {
  reports: Record<string, ResourceReport>
  /** Sources that gave no report, in source order, with why. */
  missing: Record<string, MissingReason>
}

/** Ask every source at once; each one's own deadline bounds the wait. A source that throws counts as `no answer`. */
export async function collectReports(sources: readonly ReportSource[]): Promise<Collected> {
  const got = await Promise.all(sources.map((s) => ('absent' in s ? Promise.resolve(null) : s.ask().catch(() => null))))
  const out: Collected = { reports: {}, missing: {} }
  sources.forEach((s, i) => {
    const r = got[i]
    if (r) out.reports[s.name] = r
    else out.missing[s.name] = 'absent' in s ? s.absent : 'no answer'
  })
  return out
}

/** The report key of a window's renderer: the first window's is `renderer`; any further window's is `renderer:<id>`. */
export function rendererKey(index: number, webContentsId: number): string {
  return index === 0 ? 'renderer' : `renderer:${webContentsId}`
}

// ── footprint sampler ───────────────────────────────────────────────────────────────────

export type NamedPid = { name: string; pid: number }

/**
 * One footprint sample: wall-clock time, each process's pid (a changed pid is a restart) and footprint bytes
 * (`ri_phys_footprint` on macOS, `RssAnon + VmSwap` on Linux; errors: why a process was not read).
 */
export type FootprintSample = { t: number; pids: Record<string, number>; bytes: Record<string, number>; errors?: Record<string, string> }

/** The slice of Electron's `ProcessMetric` used to name processes. */
export type AppMetric = { pid: number; type: string; serviceName?: string | undefined; name?: string | undefined }

/**
 * Names for the processes of `app.getAppMetrics()` and Linux's zygotes (type `Zygote`): `known` first (main,
 * core, ptyhost, renderers by pid), then `gpu` and `zygote`, then `<type>:<serviceName or name>`; a name already taken
 * gets `:<pid>` appended.
 */
export function nameProcesses(metrics: readonly AppMetric[], known: ReadonlyMap<number, string>): NamedPid[] {
  const used = new Set<string>()
  const out: NamedPid[] = []
  for (const m of metrics) {
    let name = known.get(m.pid) ?? (m.type === 'GPU' ? 'gpu' : m.type === 'Zygote' ? 'zygote' : `${m.type.toLowerCase()}:${m.serviceName || m.name || m.pid}`)
    if (used.has(name)) name = `${name}:${m.pid}`
    used.add(name)
    out.push({ name, pid: m.pid })
  }
  return out
}

/** `kea-helper footprint` output (`<pid> <bytes>` or `<pid> error <reason>`, one line per pid) by process name. */
export function parseFootprint(stdout: string, pids: readonly NamedPid[]): { bytes: Record<string, number>; errors: Record<string, string> } {
  const byPid = new Map(pids.map((p) => [String(p.pid), p.name]))
  const bytes: Record<string, number> = {}
  const errors: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const m = /^(\d+) (?:(\d+)|error (.*))$/.exec(line.trim())
    const name = m ? byPid.get(m[1] as string) : undefined
    if (!m || !name) continue
    if (m[2] !== undefined) bytes[name] = Number(m[2])
    else errors[name] = m[3] as string
  }
  for (const p of pids) if (!(p.name in bytes) && !(p.name in errors)) errors[p.name] = 'not reported'
  return { bytes, errors }
}

export type RunFn = (file: string, args: readonly string[], opts: RunProcessOptions) => Promise<ProcessResult>

export interface SamplerOptions {
  /** The kea-helper binary. */
  helper: string
  /** Kea's processes now. */
  pids: () => NamedPid[]
  log: Logger
  clock?: Clock
  /** Wall clock for a sample's `t` (default Date.now). */
  wall?: () => number
  /** Default `runProcess`. */
  run?: RunFn
  /** After each interval's sample, null when it failed (main: the hourly line). */
  onInterval?: (s: FootprintSample | null) => void
}

export class FootprintSampler implements Disposable {
  // bounded: L.metricsSamplesKept, oldest dropped
  private readonly ring = new BoundedQueue<FootprintSample>({ cap: L.metricsSamplesKept, overflow: 'drop-oldest' })
  private newest: FootprintSample | null = null
  private running: Promise<FootprintSample | null> | null = null
  private readonly scope: Scope
  private readonly abort = new AbortController()
  private readonly o: SamplerOptions

  constructor(o: SamplerOptions) {
    this.o = o
    this.scope = new Scope('FootprintSampler', { clock: o.clock ?? systemClock })
  }

  /** Samples kept (≤ L.metricsSamplesKept). */
  get size(): number {
    return this.ring.length
  }

  get latest(): FootprintSample | null {
    return this.newest
  }

  samples(): FootprintSample[] {
    return [...this.ring]
  }

  /** One sample per L.watchdogIntervalMs until disposed; each interval ends in `onInterval`, failed or not. */
  start(): void {
    this.scope.interval(() => {
      void this.sample().then((s) => {
        if (!this.scope.isDisposed) this.o.onInterval?.(s)
      })
    }, L.watchdogIntervalMs)
  }

  /** Sample now; a call while a run is in flight shares that run (one `kea-helper footprint` at a time). */
  sample(): Promise<FootprintSample | null> {
    if (this.scope.isDisposed) return Promise.resolve(null)
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  dispose(): void {
    this.abort.abort()
    this.scope.dispose()
  }

  private async run(): Promise<FootprintSample | null> {
    let pids: NamedPid[]
    let r: ProcessResult
    try {
      pids = this.o.pids()
      if (pids.length === 0) return null
      r = await (this.o.run ?? runProcess)(this.o.helper, ['footprint', ...pids.map((p) => String(p.pid))], {
        pool: 'other',
        timeoutMs: L.resourceReportTimeoutMs,
        signal: this.abort.signal,
      })
    } catch (e) {
      this.o.log.warn('footprint sample failed', { error: (e as Error).message })
      return null
    }
    if (this.scope.isDisposed) return null
    if (r.code !== 0 || !r.stdout) {
      this.o.log.warn('footprint sample failed', { code: r.code, timedOut: r.timedOut, stderr: r.stderr })
      return null
    }
    const { bytes, errors } = parseFootprint(r.stdout.toString('utf8'), pids)
    const s: FootprintSample = { t: (this.o.wall ?? Date.now)(), pids: Object.fromEntries(pids.map((p) => [p.name, p.pid])), bytes, ...(Object.keys(errors).length ? { errors } : {}) }
    this.ring.push(s)
    this.newest = s
    this.o.log.debug('footprint sampled', { at: s.t, processes: Object.keys(bytes).length })
    return s
  }
}

// ── the resources.ndjson line ───────────────────────────────────────────────────────────

export type LineTrigger = 'hourly' | 'watchdog' | 'test'

/** What the watchdog does about a process over a limit: restart core or ptyhost, reload a window, reset WebGL in every window. */
export type WatchdogAction = 'restart' | 'reload' | 'resetWebgl'

/**
 * One watchdog trigger: a process found over a limit in a footprint sample, and what is done about it now.
 * `action`: `none` (a soft limit: the report is all), one of the watchdog's actions, `deferred` (a hard limit
 * whose action waits: `why`), or `gaveUp` (the action was taken and its cool-down is over, and the same process is
 * still over).
 */
export type WatchdogTrigger = {
  /** The process as the sample names it: `core`, `ptyhost`, `renderer`, `renderer:<id>`, `gpu`. */
  process: string
  pid: number
  bytes: number
  limit: 'soft' | 'hard'
  limitBytes: number
  action: 'none' | WatchdogAction | 'deferred' | 'gaveUp'
  why?: 'not idle' | 'cool-down' | 'action under way'
}

/** The fields of one resources.ndjson line after the logger's `t`, `level`, `proc`, `msg`. */
export type ResourceLine = {
  trigger: LineTrigger
  /** A watchdog line only: every trigger it was written for. */
  watchdog?: WatchdogTrigger[]
  reports: Record<string, ResourceReport>
  missing: Record<string, MissingReason>
  /** The footprint sample the line was written with (`t` as ISO time), or null: none yet, or that interval's failed. */
  footprint: { t: string; pids: Record<string, number>; bytes: Record<string, number>; errors?: Record<string, string> } | null
}

export const RESOURCE_LOG_FILE = 'resources.ndjson'

export interface ResourceLogOptions {
  /** `<KEA_HOME>/logs`. */
  dir: string
  collect: () => Promise<Collected>
  sampler: Pick<FootprintSampler, 'latest' | 'sample'>
  clock?: Clock
  /** Rotation, for tests (default the logger's: L.logFileMaxBytes × L.logFilesKept). */
  maxBytes?: number
}

/**
 * Which footprint a line carries: a fresh sample, a given one (the interval's, or null when it failed), or the newest.
 * `watchdog`: the triggers a watchdog line is written for.
 */
export type LineFootprint = { sample?: boolean; footprint?: FootprintSample | null; watchdog?: readonly WatchdogTrigger[] }

/** A line that waits for the one being written. */
type WaitingLine = {
  line: Promise<ResourceLine>
  // bounded: the triggers of the watchdog intervals that end while the line waits (it waits for one line at most: a
  // sample and a collection, each within L.resourceReportTimeoutMs; an interval is L.watchdogIntervalMs)
  watchdog: WatchdogTrigger[]
}

export class ResourceLog implements Disposable {
  private readonly file: FileLogger
  private readonly o: ResourceLogOptions
  private readonly clock: Clock
  private last: number
  private disposed = false
  /** Lines are written one after another, each with its own trigger. */
  private chain: Promise<unknown> = Promise.resolve()
  // bounded: one per trigger (LineTrigger) — a write whose trigger already waits joins that line — plus the one being written
  private readonly waiting = new Map<LineTrigger, WaitingLine>()

  constructor(o: ResourceLogOptions) {
    this.o = o
    this.clock = o.clock ?? systemClock
    this.last = this.clock.now()
    this.file = createLogger({ dir: o.dir, process: 'main', file: RESOURCE_LOG_FILE, level: 'info', ...(o.maxBytes ? { maxBytes: o.maxBytes } : {}) })
  }

  get path(): string {
    return this.file.path
  }

  /**
   * At the end of each sampler interval, with that interval's sample (null when it failed): the hourly line, once
   * L.resourceLogIntervalMs has passed since the last line.
   */
  tick(sample: FootprintSample | null): void {
    if (this.waiting.has('hourly') || this.clock.now() - this.last < L.resourceLogIntervalMs) return
    void this.write('hourly', { footprint: sample })
  }

  /**
   * Collect and append one line, after any line being written. `sample`: a fresh footprint sample first; `footprint`:
   * this one (null: none); neither: the newest. A write whose trigger already waits returns that line; its watchdog
   * triggers are added to that line's, so none is lost and no second watchdog line queues behind the first.
   */
  write(trigger: LineTrigger, o: LineFootprint = {}): Promise<ResourceLine> {
    const queued = this.waiting.get(trigger)
    if (queued) {
      if (o.watchdog) queued.watchdog.push(...o.watchdog)
      return queued.line
    }
    const entry: WaitingLine = { watchdog: [...(o.watchdog ?? [])], line: null as unknown as Promise<ResourceLine> }
    entry.line = this.chain.then(() => {
      this.waiting.delete(trigger)
      return this.compose(trigger, o, entry.watchdog)
    })
    this.waiting.set(trigger, entry)
    this.chain = entry.line.catch(() => undefined)
    return entry.line
  }

  dispose(): void {
    this.disposed = true
    this.file.dispose()
  }

  private async compose(trigger: LineTrigger, o: LineFootprint, watchdog: WatchdogTrigger[]): Promise<ResourceLine> {
    this.last = this.clock.now()
    // the sample is taken before the reports are collected, so main's `main.metricsSamples` counts it (and only it, of
    // any sample that lands while the other processes answer)
    const s = o.footprint !== undefined ? o.footprint : o.sample ? await this.o.sampler.sample() : this.o.sampler.latest
    const { reports, missing } = await this.o.collect()
    const line: ResourceLine = {
      trigger,
      ...(trigger === 'watchdog' ? { watchdog } : {}),
      reports,
      missing,
      footprint: s ? { t: new Date(s.t).toISOString(), pids: s.pids, bytes: s.bytes, ...(s.errors ? { errors: s.errors } : {}) } : null,
    }
    if (!this.disposed) this.file.info('resources', line) // NaN (a gauge that threw) is written as null
    return line
  }
}
