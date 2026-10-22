// tools/perf/last.json: the latest result of every budget, each with the machine, OS, Electron version and commit it
// was measured on, and the previous result of the same budget, so the summary table can show both (a passing value more
// than 15 % worse than the previous one is a reason to look). Written by the app-level perf tests
// (tests/perf/app-*.test.ts) one result at a time, so a partial run (`pnpm perf --only …`) keeps the others; read by
// `pnpm perf` for its summary table.
//
// Format 2 (format 1, a single `{ at, machine, commit, results: [...] }` run, is read only as previous values):
//   { format: 2, updated, results: { "<P-ID>": Entry } }
//   Entry = { id, metric, method, at, env, values, checks: Check[], pass, notes?, previous: { at, values, checks, pass } | null }
//   Check = { name, kind: "max" | "min", limit, measured, unit, pass, margin }  (margin: the fraction of the limit to spare;
//           negative when missed)

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { harnessOs } from './os/index.ts'

export const LAST_JSON = path.resolve(import.meta.dirname, '..', 'last.json')
const repo = path.resolve(import.meta.dirname, '..', '..', '..')

export interface Check {
  /** What is compared, e.g. `p99` or `fps` (the budgets.toml field name where there is one). */
  name: string
  kind: 'max' | 'min'
  limit: number
  measured: number
  unit: string
  pass: boolean
  /** (limit − measured) / limit for a maximum, (measured − limit) / limit for a minimum. */
  margin: number
}

export interface PerfResult {
  /** The P-ID; a variant measured against another budget is `<P-ID> (<what>)`, e.g. `P-GS-3 (ignored folder …)`. */
  id: string
  metric: string
  /** How it was measured: scenario, runs and warm-ups, the statistic compared. */
  method: string
  values: Record<string, number>
  checks: Check[]
  notes?: string[]
}

export interface PerfEnv {
  machine: { model: string | null; cpu: string; cores: number; memGb: number; arch: string }
  os: string
  electron: string
  node: string
  /** `git rev-parse HEAD`; null before the first commit. */
  commit: string | null
  dirty: boolean | null
  /** On AC power (as the reference machine must be), on battery, or unknown. */
  power: 'AC' | 'battery' | null
  /** One-, five- and fifteen-minute load averages when the result was recorded (a busy machine shows here). */
  load: number[]
  build: string
}

export interface Entry extends PerfResult {
  at: string
  env: PerfEnv
  pass: boolean
  previous: { at: string; values: Record<string, number>; checks: Check[]; pass: boolean } | null
}

export interface LastJson {
  format: 2
  updated: string
  results: Record<string, Entry>
}

/** One comparison with a budget. */
export function check(name: string, measured: number, limit: number, kind: 'max' | 'min', unit: string): Check {
  const pass = Number.isFinite(measured) && (kind === 'max' ? measured <= limit : measured >= limit)
  const margin = limit === 0 ? 0 : kind === 'max' ? (limit - measured) / limit : (measured - limit) / limit
  return { name, kind, limit, measured, unit, pass, margin }
}

function run(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() } }).trim()
  } catch {
    return null
  }
}

let envCache: PerfEnv | null = null

/** The machine, OS, Electron, commit and power state, read once per process; the load is read each time. */
export function perfEnv(build = 'dev build, release bundle (tools/build.ts --release)'): PerfEnv {
  if (!envCache) {
    const electronPkg = createRequire(path.join(repo, 'tools/perf/package.json')).resolve('electron/package.json')
    const commit = run('/usr/bin/git', ['rev-parse', 'HEAD']) // os-ok: in /usr/bin on both systems; fails before the first commit
    const status = commit === null ? null : run('/usr/bin/git', ['status', '--porcelain', '--untracked-files=no']) // os-ok: in /usr/bin on both systems
    envCache = {
      machine: { model: harnessOs.machine.model(), cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, memGb: Math.round(os.totalmem() / 2 ** 30), arch: os.arch() },
      os: harnessOs.machine.system(os.release()),
      electron: (JSON.parse(fs.readFileSync(electronPkg, 'utf8')) as { version: string }).version,
      node: process.version,
      commit,
      dirty: status === null ? null : status.length > 0,
      power: harnessOs.machine.power(),
      load: [],
      build,
    }
  }
  return { ...envCache, load: os.loadavg().map((x) => Math.round(x * 100) / 100) }
}

type V1 = { at?: string; results?: { id: string; values: Record<string, number>; pass: boolean }[] }

/** last.json as it is on disk (format 1 becomes previous values only), or an empty one. */
export function readLast(file = LAST_JSON): LastJson {
  let raw: unknown = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // missing or half-written: start afresh
  }
  const o = raw as Partial<LastJson> & V1
  if (o && o.format === 2 && o.results && typeof o.results === 'object' && !Array.isArray(o.results)) return o as LastJson
  const out: LastJson = { format: 2, updated: new Date().toISOString(), results: {} }
  if (o && Array.isArray(o.results))
    for (const r of o.results) {
      if (!r || typeof r.id !== 'string') continue
      out.results[r.id] = { id: r.id, metric: '', method: 'v0 (pnpm perf, format 1)', at: o.at ?? '', env: perfEnv(), values: {}, checks: [], pass: r.pass, previous: { at: o.at ?? '', values: r.values ?? {}, checks: [], pass: r.pass } }
    }
  return out
}

/** Record one result in last.json (atomically: written aside, then renamed), keeping the previous one as `previous`. */
export function recordResult(r: PerfResult, o: { file?: string; env?: PerfEnv; at?: Date } = {}): Entry {
  const file = o.file ?? LAST_JSON
  const last = readLast(file)
  const before = last.results[r.id]
  const prior = before && before.checks.length ? { at: before.at, values: before.values, checks: before.checks, pass: before.pass } : (before?.previous ?? null)
  const entry: Entry = { ...r, at: (o.at ?? new Date()).toISOString(), env: o.env ?? perfEnv(), pass: r.checks.length > 0 && r.checks.every((c) => c.pass), previous: prior }
  last.results[r.id] = entry
  last.updated = entry.at
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(last, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return entry
}

const fmt = (v: number) => (!Number.isFinite(v) ? String(v) : Math.abs(v) >= 100 || Number.isInteger(v) ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))
const op = (c: Check) => (c.kind === 'max' ? '≤' : '≥')

/**
 * The markdown summary: one row per check (budget, measured, margin, the previous value), and a flag when a passing
 * value is more than `worse` (by default 15 %) worse than the previous one.
 */
export function summaryTable(last: LastJson, o: { ids?: (id: string) => boolean; since?: string; worse?: number } = {}): string {
  const worse = o.worse ?? 0.15
  const rows = ['| Budget | Check | Limit | Measured | Margin | Previous | Pass |', '|---|---|---|---|---|---|---|']
  const ids = Object.keys(last.results)
    .filter((id) => (o.ids ? o.ids(id) : true) && (!o.since || last.results[id]!.at >= o.since))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  for (const id of ids) {
    const e = last.results[id]!
    for (const c of e.checks) {
      const prev = e.previous?.checks.find((p) => p.name === c.name)
      const regress = prev && c.pass && (c.kind === 'max' ? c.measured > prev.measured * (1 + worse) : c.measured < prev.measured * (1 - worse))
      rows.push(`| ${id} | ${c.name} | ${op(c)} ${fmt(c.limit)} ${c.unit} | ${fmt(c.measured)} | ${(c.margin * 100).toFixed(0)} % | ${prev ? fmt(prev.measured) : '—'}${regress ? ` (> ${worse * 100} % worse)` : ''} | ${c.pass ? 'yes' : '**no**'} |`)
    }
  }
  return rows.join('\n')
}
