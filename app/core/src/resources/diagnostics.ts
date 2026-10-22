// "Copy diagnostics": core's part of the text, everything but the resource report (the window adds that, since main
// holds every process's report: features/diagnostics in the renderer).
//
// The rule: no terminal content, ever; no path outside `<KEA_HOME>` unless the person ticked "Include file paths".
//   - Terminal content stays out by what the text is made from: versions, the agents' detection rows, counts of
//     sessions and terminals by state, the holder list (ids and pids: never an argv, a cwd or a title), banners, account
//     conditions, and the warnings and errors of the processes' own logs. No title, slug, branch, prompt or screen is
//     read here at all.
//   - Paths stay out by `scrubPaths` (protocol/diagnostics.ts), given the folders the text could name (the user's home
//     folder, every project root, every worktree root and session folder) and the branches Kea made. A path that is
//     not quoted is taken to run to the end of its text, since a name may hold spaces: so every piece of free text (a
//     log entry's message, each of its fields, a banner's message and its fix, a CLI's notice) is scrubbed by itself
//     first, and loses no more than its own tail; then the whole text once more, last. A log field that is nothing
//     but a relative path (`src/app.ts`) goes too.
//
// Nothing is kept between calls: each one reads the tails of the logs (at most L.diagnosticsLogTailBytes of each) and
// asks the holders once.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Logger } from '@kea/kit'
import { conditionLabel, isAvailable, KEA_HOME_MARK, L, PATH_MARK, platformSection, scrubbedReport, scrubber, type AccountCondition, type AgentInfo, type Banner, type diagnosticsApi, type Handlers, type HolderRow, type Lifecycle, type PlatformReport } from '@kea/protocol'
import { coreOs } from '../os/index.ts'

/** The processes that keep a log in `<KEA_HOME>/logs/`: `<process>.log`. The window's is written by main (rendererLog.ts). */
export const LOG_PROCESSES = ['main', 'core', 'ptyhost', 'renderer'] as const

/** One warning or error of a process's log, as the text lists it. */
export interface ErrorLine {
  /** Its `t` (ISO), and that as wall ms for the order. */
  t: string
  at: number
  proc: string
  level: 'warn' | 'error'
  msg: string
  fields: Record<string, unknown>
}

export interface DiagnosticsFacts {
  /** Wall ms the text was asked for. */
  at: number
  home: string
  version: string
  /** `process.versions` of the process that collects (core runs in Electron's utility process: electron, chrome, node). */
  runtime: { electron?: string | undefined; chrome?: string | undefined; node: string }
  /** `Darwin 25.0.0 arm64`. */
  system: string
  /**
   * The platform report's inotify line (Linux; null where the system has no such limit, or it could not be read): Kea's
   * own watches beside the limits.
   */
  inotify?: { watches: number; maxWatches: number; instances: number; maxInstances: number } | null
  /** The platform report main sent last: the `Platform` section; null until main has sent one. */
  platform?: PlatformReport | null
  /** How long core has run. */
  upMs: number
  /** `fromVersion`: the schema it had when this launch opened it (0: a new file). */
  database: { fresh: boolean; setAside: boolean; fromVersion: number }
  /** Git can be run; null while that is being found out. */
  git: boolean | null
  agents: readonly Pick<AgentInfo, 'id' | 'displayName' | 'state' | 'version' | 'path' | 'loggedIn' | 'notice'>[]
  /** One per session row and per terminal: only their states are read. */
  sessions: readonly { lifecycle: Lifecycle }[]
  terminals: readonly { state: string }[]
  holders: readonly HolderRow[]
  banners: readonly Pick<Banner, 'kind' | 'source' | 'severity' | 'message' | 'fix'>[]
  conditions: readonly Pick<AccountCondition, 'agent' | 'kind' | 'state' | 'sessionIds'>[]
  errors: readonly ErrorLine[]
  /** The logs that could not be read, and why (a missing one is not an error: that process logged nothing yet). */
  unread: readonly { proc: string; why: string }[]
}

const cut = (s: string): string => (s.length > L.diagnosticsFieldMaxChars ? `${s.slice(0, L.diagnosticsFieldMaxChars)}…` : s)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** `3 d 4 h`, `2 h 5 min`, `12 min`, `40 s`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const [d, h, m] = [Math.floor(s / 86_400), Math.floor((s % 86_400) / 3600), Math.floor((s % 3600) / 60)]
  if (d > 0) return `${d} d ${h} h`
  if (h > 0) return `${h} h ${m} min`
  if (m > 0) return `${m} min`
  return `${s} s`
}

/** The last `max` bytes of a file as text, from the first whole line in them; null when it cannot be read. */
export function readTail(file: string, max: number = L.diagnosticsLogTailBytes): string | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    // one byte more than asked: it says whether the first of the `max` bytes starts a line
    const from = Math.max(0, size - max - 1)
    const buf = Buffer.alloc(size - from)
    const n = fs.readSync(fd, buf, 0, buf.length, from)
    const text = buf.subarray(0, n).toString('utf8')
    if (from === 0) return text
    // cut mid-line: that line goes (with no line end in what was read, all of it)
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1)
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * The warnings and errors in the logs' text (kit's NDJSON lines, per process), newest first, at most `max`. A line that
 * is not a log entry is passed over: the logs are Kea's own, but a file on disk is still read as data.
 */
export function recentErrors(logs: Readonly<Record<string, string>>, max: number = L.diagnosticsErrorsMax): ErrorLine[] {
  const out: (ErrorLine & { n: number })[] = []
  let n = 0
  for (const [proc, text] of Object.entries(logs)) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if ((e.level !== 'warn' && e.level !== 'error') || typeof e.t !== 'string' || typeof e.msg !== 'string') continue
      const at = Date.parse(e.t)
      if (Number.isNaN(at)) continue
      const { t, level, proc: _p, msg, ...fields } = e
      out.push({ t, at, proc, level, msg, fields, n: n++ })
    }
  }
  // newest first; lines of one instant in the order they were written, latest first
  out.sort((a, b) => b.at - a.at || b.n - a.n)
  return out.slice(0, max).map(({ n: _n, ...e }) => e)
}

const RELATIVE_PATH = /^[^\s/<>:]+(\/[^\s/<>]+)+\/?$/

function fieldText(v: unknown, paths: boolean): string {
  if (typeof v === 'string') {
    // a value that is nothing but a relative path names a file of the person's (a known root or a leading `/` is the scrubber's)
    if (!paths && RELATIVE_PATH.test(v)) return PATH_MARK
    const s = cut(v)
    return /^[^\s"=]+$/.test(s) ? s : JSON.stringify(s)
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v)
  let s: string
  try {
    s = JSON.stringify(v) ?? 'undefined'
  } catch {
    s = '[unreadable]'
  }
  return cut(s)
}

/** A piece of free text, as it goes into the text. */
type Part = (text: string) => string
const asIs: Part = (text) => text

/**
 * One log entry as a line: `2026-10-13T09:58:00.123Z core warn worktree not removed path=<path> error="…"`. `part`:
 * what the message and each field's value go through, each by itself (the scrub, for a text without paths).
 */
export function errorText(e: ErrorLine, paths: boolean, part: Part = asIs): string {
  const fields = Object.keys(e.fields).map((k) => `${k}=${part(fieldText(e.fields[k], paths))}`)
  return [e.t, e.proc, e.level, part(cut(e.msg.replace(/\s+/g, ' '))), ...fields].join(' ')
}

const pid = (n: number | null): string => (n === null ? '?' : String(n))

function holderText(h: HolderRow, now: number): string {
  const flags = [h.alive === null ? 'unconfirmed' : 'alive', ...(h.exited ? ['program exited'] : []), ...(h.orphan ? ['orphan'] : [])]
  return [h.ptyId, h.sessionId ?? '(no state file)', h.kind ?? '?', `pid ${pid(h.pid)}`, `child ${pid(h.childPid)}`, h.startedAt === null ? 'up ?' : `up ${duration(now - h.startedAt)}`, flags.join(', ')].join('  ')
}

function agentText(a: DiagnosticsFacts['agents'][number], paths: boolean, part: Part): string {
  const parts = [a.id, a.displayName, a.state, a.version ?? 'no version']
  if (a.loggedIn !== null) parts.push(a.loggedIn ? 'signed in' : 'signed out')
  // where the CLI is installed is a path outside the home
  if (paths && a.path) parts.push(a.path)
  if (a.notice) parts.push(`(${part(a.notice)})`)
  return parts.join('  ')
}

/**
 * The text, section by section. `scrub`: the folders it could name and the branches Kea made, for a text without
 * paths; null: the person ticked "Include file paths".
 */
export function diagnosticsText(f: DiagnosticsFacts, scrub: { roots: readonly string[]; homes?: readonly string[]; names?: readonly string[] } | null): string {
  const paths = scrub === null
  const part: Part = scrub ? scrubber({ home: scrub.homes ?? [f.home], roots: scrub.roots, names: scrub.names ?? [] }) : asIs
  const out: string[] = []
  out.push('# Kea diagnostics', `copied ${new Date(f.at).toISOString()}`, paths ? 'file paths: included' : `file paths: left out (${KEA_HOME_MARK} is Kea’s own folder, ${PATH_MARK} any other path)`)

  const runtime = [f.runtime.electron ? `electron ${f.runtime.electron}` : null, f.runtime.chrome ? `chrome ${f.runtime.chrome}` : null, `node ${f.runtime.node}`].filter(Boolean)
  out.push(
    '',
    '## Kea',
    `version ${f.version}`,
    runtime.join(' · '),
    `system ${f.system}`,
    ...(f.inotify ? [`inotify Kea holds ${f.inotify.watches} watches (fs.inotify.max_user_watches = ${f.inotify.maxWatches}); this user’s instances ${f.inotify.instances} (fs.inotify.max_user_instances = ${f.inotify.maxInstances})`] : []),
    `home ${f.home}`,
    `core up ${duration(f.upMs)}`,
    `database ${f.database.fresh ? 'new' : `opened at schema ${f.database.fromVersion}`}${f.database.setAside ? ', an unreadable one set aside as kea.db.corrupt' : ''}`,
    `git ${f.git === null ? 'being looked for' : f.git ? 'available' : 'not available'}`,
  )

  // The system as main reports it, each line with its fix where it is not the full answer
  out.push('', ...platformSection(f.platform ?? null, part))

  out.push('', '## Agent CLIs')
  if (f.agents.length === 0) out.push('none detected yet')
  for (const a of f.agents) out.push(agentText(a, paths, part))

  const by = new Map<string, number>()
  for (const s of f.sessions) by.set(s.lifecycle, (by.get(s.lifecycle) ?? 0) + 1)
  const running = f.terminals.filter((t) => t.state === 'running').length
  out.push('', '## Sessions')
  out.push(f.sessions.length === 0 ? 'no sessions' : `${plural(f.sessions.length, 'session')}: ${[...by].map(([k, n]) => `${n} ${k}`).join(', ')}`)
  out.push(`${plural(f.terminals.length, 'terminal')}, ${running} running`)
  for (const c of f.conditions) out.push(`${c.agent}: ${conditionLabel(c.kind)} (${c.state}), holds ${plural(c.sessionIds.length, 'session')}`)

  out.push('', '## Holders')
  out.push(f.holders.length === 0 ? 'none running' : `${plural(f.holders.length, 'holder')}, ${f.holders.filter((h) => h.orphan).length} orphaned`)
  for (const h of f.holders) out.push(holderText(h, f.at))

  out.push('', '## Banners')
  if (f.banners.length === 0) out.push('none')
  for (const b of f.banners) out.push(`${b.kind} (${b.severity}, from ${b.source}): ${part(cut(b.message))}${b.fix ? ` Fix: ${part(cut(b.fix))}` : ''}`)

  out.push('', '## Recent errors')
  out.push(f.errors.length === 0 ? 'no warnings or errors in the logs' : `the newest ${plural(f.errors.length, 'warning or error', 'warnings and errors')} of ${LOG_PROCESSES.join(', ')} (at most ${L.diagnosticsErrorsMax}; the logs are in ${path.join(f.home, 'logs')})`)
  for (const u of f.unread) out.push(`${u.proc}: log not read (${u.why})`)
  for (const e of f.errors) out.push(errorText(e, paths, part))

  // each piece went through by itself; the whole once more, as the one rule over everything the text holds
  return part(out.join('\n'))
}

export interface DiagnosticsOptions {
  home: string
  version: string
  log: Logger
  now?: () => number
  database: DiagnosticsFacts['database']
  git(): boolean | null
  agents(): DiagnosticsFacts['agents']
  sessions(): DiagnosticsFacts['sessions']
  terminals(): DiagnosticsFacts['terminals']
  holders(): Promise<readonly HolderRow[]>
  banners(): DiagnosticsFacts['banners']
  conditions(): DiagnosticsFacts['conditions']
  /** Every folder outside the home the text could name: project roots, worktree roots, session folders. */
  roots(): readonly string[]
  /** The branches Kea made for its sessions: a git error quotes one by its name (default: none). */
  names?(): readonly string[]
}

/** Both names of a folder: as given and with its symlinks resolved (`/var/…` and `/private/var/…`). */
function names(dir: string): string[] {
  try {
    return [...new Set([dir, fs.realpathSync(dir)])]
  } catch {
    return [dir]
  }
}

/** The inotify line: the watches this process holds, this user's instances, and both limits (Linux only). */
async function inotifyUse(): Promise<DiagnosticsFacts['inotify']> {
  const w = coreOs.watcher
  const l = isAvailable(w) ? w.limits : null
  if (!l) return null
  try {
    const [max, watches, instances] = await Promise.all([l.max(), l.ownWatches(), l.userInstances()])
    return max ? { watches, maxWatches: max.watches, instances, maxInstances: max.instances } : null
  } catch {
    return null
  }
}

export class Diagnostics {
  private readonly o: DiagnosticsOptions
  private readonly now: () => number
  private readonly since: number
  /** The platform report main sent last (main's `platform` message); one, replaced by the next. */
  private report: PlatformReport | null = null

  constructor(o: DiagnosticsOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.since = this.now()
  }

  async facts(): Promise<DiagnosticsFacts> {
    const o = this.o
    const logs: Record<string, string> = {}
    const unread: { proc: string; why: string }[] = []
    for (const proc of LOG_PROCESSES) {
      const file = path.join(o.home, 'logs', `${proc}.log`)
      if (!fs.existsSync(file)) continue
      const text = readTail(file)
      if (text === null) unread.push({ proc, why: 'the file could not be read' })
      else logs[proc] = text
    }
    const holders = await o.holders().catch((e) => {
      o.log.warn('diagnostics: the holders could not be listed', { error: String(e) })
      return [] as HolderRow[]
    })
    const at = this.now()
    return {
      at,
      home: o.home,
      version: o.version,
      runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      system: coreOs.report.systemLine(),
      inotify: await inotifyUse(),
      platform: this.report,
      upMs: at - this.since,
      database: o.database,
      git: o.git(),
      agents: o.agents(),
      sessions: o.sessions(),
      terminals: o.terminals(),
      holders,
      banners: o.banners(),
      conditions: o.conditions(),
      errors: recentErrors(logs),
      unread,
    }
  }

  /** Main's platform report, as it sends it: at this core's start and each time it changes. */
  setPlatform(report: PlatformReport): void {
    this.report = report
  }

  get platform(): PlatformReport | null {
    return this.report
  }

  /** The report for a status report's bundle: scrubbed as a text without paths is; null until main sent one. */
  scrubbedPlatform(): PlatformReport | null {
    return this.report ? scrubbedReport(this.report, scrubber(this.scrubFor(this.o.home))) : null
  }

  /**
   * What a text without paths must not name: the folders outside the home it could name and the branches Kea made. The
   * home's own layout is kept, but not the folder worktrees are made in by default: its folders are named after
   * projects and sessions, and no session need be left to say so.
   */
  private scrubFor(home: string): { home: string[]; roots: string[]; names: readonly string[] } {
    const roots = [os.homedir(), os.tmpdir(), path.join(home, 'worktrees'), ...this.o.roots()].flatMap(names)
    return { home: names(home), roots, names: this.o.names?.() ?? [] }
  }

  /** `diagnostics.collect`. */
  async collect(paths: boolean): Promise<string> {
    const f = await this.facts()
    if (paths) return diagnosticsText(f, null)
    const s = this.scrubFor(f.home)
    return diagnosticsText(f, { homes: s.home, roots: s.roots, names: s.names })
  }

  handlers(): Handlers<typeof diagnosticsApi> {
    return {
      'diagnostics.collect': async ({ paths }) => ({ text: await this.collect(paths === true) }),
      // Settings › About: the report as main sent it, paths and all (it stays in this window)
      'diagnostics.platform': () => ({ report: this.report }),
    }
  }
}
