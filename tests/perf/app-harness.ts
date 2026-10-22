// What the app-level perf tests share (tests/perf/app-*.test.ts, and the GPU memory run through app-gpu-soak.ts): the
// release build they launch, Kea started through the shared app harness (tests/support/app.ts: unfocused, temporary
// KEA_HOME, identity-checked cleanup), and one implementation of each measurement (keystroke echo, per-process CPU and
// footprint, frames), plus the workloads they type into a test shell and the recording of every result in
// tools/perf/last.json (tools/perf/src/record.ts).
//
// Unless a test states otherwise, a scenario runs once to warm up and then RUNS times; the median of the runs is
// compared with the budget, and p99 budgets use every sample of every run.
//
// The window is never focused (`--kea-perf`), so the person at the computer may cover it with other windows. Chromium
// stops producing frames for an occluded window, which would stall every frame-based measurement; the tests therefore
// turn background throttling off for the window (`webContents.setBackgroundThrottling(false)`, a harness setting
// through Playwright, not a product change), so the page keeps rendering whether or not it is on top.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from '@kea/kit'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { fakeAgentCommand } from '../../tools/fake-agent/src/index.ts'
import { BUDGETS, type BudgetId } from '../../tools/perf/src/generated/budgets.ts'
import { isZygote, processInfo, processTable, repoRoot, runAppProcesses, type ProcInfo } from '../../tools/perf/src/launch.ts'
import { check, recordResult, type Check, type Entry, type PerfResult } from '../../tools/perf/src/record.ts'
import { quantile } from '../../tools/perf/src/stats.ts'
import { KeaRun, PROMPT, STEP_MS, testAppDist, type Kea } from '../support/app.ts'

/** Each scenario runs this many times after one warm-up. */
export const RUNS = 3
export const WARMUPS = 1
/** Keys measured per echo budget (`pnpm perf --keys`), after KEY_WARMUP unmeasured ones (shell and xterm warm up). */
export const KEYS = envNumber('KEA_PERF_KEYS', 1000)
export const KEY_WARMUP = 30
/** A shell line is ended (Enter) every so many keys, so typed text never wraps. */
const KEYS_PER_LINE = 60
const ECHO_CHARS = 'abcdefghijklmnopqrstuvwxy'

export const HELPER = path.join(repoRoot, 'native/kea-helper/target/release/kea-helper')
export const CASSETTE_DIR = path.join(repoRoot, 'fixtures/cassettes')
/** The recorded Claude Code sessions, sorted; FULLSCREEN_CASSETTE is the fullscreen session the budgets name. */
export const CASSETTES = fs
  .readdirSync(CASSETTE_DIR)
  .filter((f) => f.endsWith('.cast'))
  .sort()
  .map((f) => path.join(CASSETTE_DIR, f))
export const FULLSCREEN_CASSETTE = path.join(CASSETTE_DIR, 'claude-fullscreen-changelog.cast')
export const WORKLOADS = path.join(repoRoot, 'tools/perf/src/workloads')

export function envNumber(name: string, dflt: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}=${v}: expected a positive number`)
  return n
}

export function budget<K extends BudgetId>(id: K): (typeof BUDGETS)[K] {
  return BUDGETS[id]
}

// ── the build and the app ──────────────────────────────────────────────────────────────

/**
 * Build `dist/test-app-<tag>` as a release bundle once per Vitest invocation (tests/perf/app-global.ts sets the tag
 * and removes the build at the end); later calls, from later files, find it built.
 */
export function ensureBuild(): string {
  const dist = testAppDist()
  const marker = path.join(dist, '.perf-release')
  if (fs.existsSync(marker)) return dist
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'tools/build.ts'), '--release', '--out', path.relative(repoRoot, dist)], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`building ${dist} failed:\n${r.stdout}\n${r.stderr}`)
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  return dist
}

/** The runs a test file started; `disposeRuns` (afterEach) ends them all. */
const runs: KeaRun[] = [] // bounded: the runs of one test (a few; a startup test launches RUNS + WARMUPS)

export function trackRun(run: KeaRun): KeaRun {
  runs.push(run)
  return run
}

export async function disposeRuns(): Promise<void> {
  const errors: unknown[] = []
  for (const r of runs.splice(0)) await r.dispose().catch((e: unknown) => errors.push(e))
  if (errors.length) throw errors[0]
}

/**
 * Kea on a fresh KEA_HOME, its first shell at its prompt, its window rendering even when covered (see the header).
 * `settings`: sections laid over the home's settings.json before the launch. The run's own default (the `shell`
 * pseudo-agent, tests/support/app.ts) stays unless `general.defaultAgent` is given.
 */
export async function startKea(o: { args?: string[]; settings?: Record<string, Record<string, unknown>> } = {}): Promise<{ run: KeaRun; kea: Kea }> {
  ensureBuild()
  const run = trackRun(KeaRun.create())
  if (o.settings) {
    const file = path.join(run.home, 'settings.json')
    const merged = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
    for (const [section, values] of Object.entries(o.settings)) merged[section] = { ...merged[section], ...values }
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`)
  }
  const kea = await run.launch(o.args ? { args: o.args } : {})
  await unthrottle(kea)
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  return { run, kea }
}

/** Keep the window's page rendering while another app's window covers it (see the header). */
export async function unthrottle(kea: Kea): Promise<void> {
  await kea.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.setBackgroundThrottling(false)
  })
}

/** Open `n` more shell tabs; resolves with their ptyIds in the order opened (the last is on screen). */
export async function openTabs(kea: Kea, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await kea.newTab())
  return ids
}

// ── command lines typed into a test shell ──────────────────────────────────────────────

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

export function commandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map(shq).join(' ')
}

/** A program of tools/perf/src/workloads run with this Node. */
export function workload(name: 'agent-loop' | 'thinking' | 'winch', args: readonly string[] = []): string {
  return commandLine(process.execPath, [path.join(WORKLOADS, `${name}.ts`), ...args])
}

/**
 * fake-agent replaying `cassettes` at 1× in a loop (gaps capped at 1.5 s, no hooks): the command line, with its
 * scenario written into the run's KEA_HOME (removed with it).
 */
export function cassetteLoop(run: KeaRun, cassettes: readonly string[], name: string): string {
  const scenario = path.join(run.home, `${name}.json`)
  const fakeHome = path.join(run.home, 'fake-agent-home')
  fs.mkdirSync(fakeHome, { recursive: true })
  const steps = cassettes.map((file) => ({ cassette: { file, speed: 1, maxIdleMs: 1500 } }))
  fs.writeFileSync(scenario, JSON.stringify({ version: 1, name, fireSessionStart: false, fireSessionEnd: false, steps: [{ loop: { forever: true, steps } }] }))
  const { file, args } = fakeAgentCommand('claude', [], { scenario, fakeHome })
  return commandLine(file, args)
}

// ── measurements ───────────────────────────────────────────────────────────────────────

declare const __keaPerf: { framesStart(): void; framesStop(): { fps: number; maxGapMs: number; frames: number }; now(): number }

/**
 * Keystroke → glyph painted (the echo budgets' method, the echo probe in app/renderer/src/lib/perf.ts): the
 * synthetic keydown's timestamp → the first xterm render after which the typed character sits just before the cursor.
 * The terminal on screen must run something that echoes: `cat` (`echoer` 'cat') or a program that echoes each key in
 * order, such as workloads/thinking.ts ('app'). `warmup` keys are typed first and not counted. After each Enter, `cat`
 * writes the line back while the tty has already echoed the next key, so the next key waits for that copy.
 */
export async function echoLatencies(kea: Kea, keys: number, warmup = KEY_WARMUP, echoer: 'cat' | 'app' = 'cat'): Promise<number[]> {
  const samples: number[] = []
  let line = ''
  for (let i = 0; i < warmup + keys; i++) {
    if (i > 0 && i % KEYS_PER_LINE === 0) {
      if (echoer === 'cat') await kea.enterLineBack(line)
      else await kea.press('Enter')
      line = ''
    }
    const ch = ECHO_CHARS[i % ECHO_CHARS.length] as string
    const ms = await kea.keyEcho(ch)
    line += ch
    if (i >= warmup) samples.push(ms)
  }
  return samples
}

export interface Dist {
  p50: number
  p99: number
  max: number
  mean: number
  n: number
}

export function dist(xs: readonly number[]): Dist {
  return { p50: quantile(xs, 0.5), p99: quantile(xs, 0.99), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length }
}

export const median = (xs: readonly number[]) => quantile(xs, 0.5)

/** rAF frames in the page while `during` runs: frames per second and the longest gap between two frames. */
export async function frames<T>(kea: Kea, during: () => Promise<T>): Promise<{ fps: number; maxGapMs: number; frames: number; result: T }> {
  const page = await kea.page()
  await page.evaluate(() => __keaPerf.framesStart())
  let result: T
  try {
    result = await during()
  } catch (e) {
    // stopped even when `during` fails, so no rAF loop outlives the measurement
    await page.evaluate(() => __keaPerf.framesStop()).catch(() => undefined)
    throw e
  }
  const f = await page.evaluate(() => __keaPerf.framesStop())
  return { ...f, result }
}

/** A process of the run with what it is (`zygote`: Linux's zygotes and the sandbox's helper). */
export interface RoleProc {
  role: 'main' | 'core' | 'ptyhost' | 'renderer' | 'gpu' | 'network' | 'utility' | 'zygote' | 'holder'
  p: ProcInfo
}

/** The processes of `procs` that are still the same processes in `table` (pid, start time, executable). */
export function stillIn(table: readonly ProcInfo[], procs: readonly ProcInfo[]): ProcInfo[] {
  const byPid = new Map(table.map((p) => [p.pid, p]))
  return procs.filter((p) => {
    const now = byPid.get(p.pid)
    return !!now && now.start === p.start && now.comm === p.comm
  })
}

/** A process table covering `procs`: their own rows for a few (one `ps` each), the whole table for more (one `ps`). */
function tableFor(procs: readonly ProcInfo[]): ProcInfo[] {
  return procs.length <= FEW ? procs.flatMap((p) => processInfo(p.pid) ?? []) : processTable()
}
const FEW = 3

/**
 * Every process of Kea in this run: its Electron processes (main, renderer, GPU, network, core, ptyhost and any other
 * utility process; found by the run's KEA_HOME or userData on their command lines; on Linux, too, the zygotes those
 * descend from, which carry neither) and its holders (kea-helper, by their state files' pid and start time). Not the
 * shells and what they run: those are the person's programs. Roles come from main (`app.getAppMetrics()`, the window's
 * renderer, `__keaTest.pids()`) and, for a zygote, its command line. One process table for all of it.
 */
export async function keaProcesses(kea: Kea, table: readonly ProcInfo[] = processTable()): Promise<RoleProc[]> {
  const pids = await kea.app.evaluate(({ app, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const m = app.getAppMetrics()
    const k = (globalThis as unknown as { __keaTest: { pids(): Record<'core' | 'ptyhost', number | null> } }).__keaTest.pids()
    return { main: process.pid, renderer: w && !w.isDestroyed() ? w.webContents.getOSProcessId() : null, gpu: m.find((x) => x.type === 'GPU')?.pid ?? null, network: m.find((x) => x.serviceName === 'network.mojom.NetworkService')?.pid ?? null, ...k }
  })
  const roleOf = new Map<number, RoleProc['role']>()
  for (const [role, pid] of Object.entries(pids)) if (pid) roleOf.set(pid, role as RoleProc['role'])
  const out: RoleProc[] = runAppProcesses(kea.run.home, { table: [...table] }).map((p) => ({ role: roleOf.get(p.pid) ?? (isZygote(p) ? 'zygote' : 'utility'), p }))
  const byPid = new Map(table.map((p) => [p.pid, p]))
  for (const h of kea.run.holders()) {
    const p = h.exited ? undefined : byPid.get(h.pid)
    // the holder its state file names: same pid, the start time it recorded (µs; ps has whole seconds), kea-helper
    if (p && path.basename(p.comm) === 'kea-helper' && Math.abs(p.start - Math.floor(h.pidStartTime / 1e6)) <= 1) out.push({ role: 'holder', p })
  }
  return out
}

/** CPU seconds (user + system) used so far by each process still alive, in one look (`ps`; Linux: `/proc`). */
export async function cpuSeconds(procs: readonly ProcInfo[], table: readonly ProcInfo[] = tableFor(procs)): Promise<Map<number, number>> {
  return harnessOs.cpu.seconds(stillIn(table, procs).map((p) => p.pid))
}

/**
 * Physical footprint (bytes) of each process still alive, from one `kea-helper footprint` run: Electron's
 * `app.getAppMetrics()` reports the working set on macOS, not the footprint.
 */
export async function footprints(procs: readonly ProcInfo[], table: readonly ProcInfo[] = tableFor(procs)): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const live = stillIn(table, procs)
  if (!live.length) return out
  const r = await runProcess(HELPER, ['footprint', ...live.map((p) => String(p.pid))], { pool: 'other', timeoutMs: STEP_MS })
  for (const line of (r.stdout?.toString('utf8') ?? '').split('\n')) {
    const m = /^(\d+) (\d+)$/.exec(line.trim())
    if (m) out.set(Number(m[1]), Number(m[2]))
  }
  return out
}

/**
 * CPU use over a window, as % of one core per process: `start()` reads every process's CPU time, `stop()` reads it
 * again; a process that exited in between is left out.
 */
export class CpuWindow {
  private readonly procs: readonly RoleProc[]
  private t0 = 0
  private c0 = new Map<number, number>()
  constructor(procs: readonly RoleProc[]) {
    this.procs = procs
  }

  async start(): Promise<void> {
    this.c0 = await cpuSeconds(this.procs.map((r) => r.p))
    this.t0 = performance.now()
  }

  /** % of one core: per process, per role (summed) and in total. */
  async stop(): Promise<{ seconds: number; byPid: Map<number, number>; byRole: Record<string, number>; total: number }> {
    const c1 = await cpuSeconds(this.procs.map((r) => r.p))
    const seconds = (performance.now() - this.t0) / 1000
    const byPid = new Map<number, number>()
    const byRole: Record<string, number> = {}
    let total = 0
    for (const { role, p } of this.procs) {
      const a = this.c0.get(p.pid)
      const b = c1.get(p.pid)
      if (a === undefined || b === undefined) continue
      const pct = ((b - a) / seconds) * 100
      byPid.set(p.pid, pct)
      byRole[role] = (byRole[role] ?? 0) + pct
      total += pct
    }
    return { seconds, byPid, byRole, total }
  }
}

/** Ptyhost's mirrors now: awake (a live headless xterm) and parked (a holder socket without one). */
export async function ptyhostMirrors(kea: Kea): Promise<{ awake: number; parked: number }> {
  const r = (await kea.debug<Record<string, unknown>>('ptyhost', 'kit')) ?? {}
  const awake = Number(r['ptyhost.mirrors'] ?? NaN)
  return { awake, parked: Number(r['ptyhost.holderSockets'] ?? NaN) - awake }
}

/** A measurement window that a budget defines (the one sleep tests allow; never for synchronisation). */
export const measureFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── results ─────────────────────────────────────────────────────────────────────────────

export { check, type Check }

/** Record a result in tools/perf/last.json and print it; resolves with the entry (its `pass` is every check's). */
export function record(r: PerfResult): Entry {
  const e = recordResult(r)
  const checks = e.checks.map((c) => `${c.name} ${c.measured.toFixed(2)} ${c.kind === 'max' ? '≤' : '≥'} ${c.limit} ${c.unit}${c.pass ? '' : ' MISSED'}`).join('; ')
  console.info(`${r.id} · ${checks}\n  ${Object.entries(r.values)
    .map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`)
    .join(', ')}${r.notes?.length ? `\n  ${r.notes.join('\n  ')}` : ''}`)
  return e
}
