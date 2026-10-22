// Reporting a wrong status: the evidence is captured at the moment the status is wrong.
//
//   bundle  `<KEA_HOME>/reports/<time>-<sessionId>/`: report.json (Kea version and commit, adapter and CLI
//                   version, lifecycle, phase, attention, background, unread, the expected state and the note, wall
//                   and monotonic times, and what a replay starts from) · status-events.ndjson (the last
//                   L.reportEvents journal rows) · signals.ndjson (the recent-signal ring, in arrival order) ·
//                   transcript.jsonl (the last L.reportTranscriptBytes) · status-file.json (tier 1b, if any) ·
//                   screen.txt (the mirror's screen) · ring.bin (the last L.reportRingBytes of the PTY ring) ·
//                   resources.json (core's resource report). report.json also holds the platform report,
//                   scrubbed as Copy Diagnostics' text is. Nothing about the session changes; the capture waits for the
//                   screen at most until L.reportCaptureMs, and lists what it could not get
//   bounds  the newest L.reportsKept bundles, at most L.reportsMaxBytes together; never committed
//   counts  the bundles present, by expected state: the `core.statusReports` row of the resource report, which
//                   the hourly resource log records

import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@kea/kit'
import { EXPECTED_STATES, L, parseRingHeader, readRing, RpcError, type ExpectedState, type Lifecycle, type PlatformReport, type ReplayStart } from '@kea/protocol'
import type { KeaDb } from '../platform/db/db.ts'
import { signalToJson, stateToJson } from './codec.ts'
import type { SessionMachine } from './machine.ts'
import type { StatusState } from './table.ts'

export const REPORTS_DIR = 'reports'
/** `<yyyymmdd>-<hhmmss>-<ms>-<sessionId>` (UTC), so names sort by time. */
const BUNDLE_RE = /^\d{8}-\d{6}-\d{3}-/

export interface ReportsOptions {
  home: string
  db: KeaDb
  log: Logger
  version: string
  /** The build's commit, when known. */
  commit?: string | undefined
  now: () => number
  mono: () => bigint
  /** Commit pending status writes first, so the journal is complete. */
  flush(): void
  /** The agent CLI's version (adapters' detection). */
  cliVersion?: ((agent: string) => string | null) | undefined
  /** The session's tier-1b status file (adapters), if any. */
  statusFile?: ((sessionId: string) => string | null) | undefined
  /** The session's agent PTY. */
  agentPty?: ((sessionId: string) => string | null) | undefined
  /** The mirror's current screen of a PTY (ptyhost). */
  screen?: ((ptyId: string) => Promise<string | null>) | undefined
  /** Core's resource report. */
  resources?: (() => unknown) | undefined
  /** The platform report main sent, scrubbed; null while main has sent none, which the bundle lists missing. */
  platform?: (() => PlatformReport | null) | undefined
  /**
   * Told when a report made `<KEA_HOME>/reports/` (it was not there): core then keeps it out of backups (Time Machine,
   * on macOS).
   */
  folderMade?: ((dir: string) => void) | undefined
}

/** What the engine knows of the session at the moment of the report. */
export interface ReportSubject {
  sessionId: string
  expected: ExpectedState
  note: string | null
  /** The live session's machine (its status, ring and ring base); null when the session is not live. */
  machine: SessionMachine | null
  unconfirmed: boolean
}

type Row = {
  agent: string
  lifecycle: Lifecycle
  end_reason: string | null
  transcriptPath: string | null
  phase: string
  attention: string
  background: number
  unread: number
  failure_kind: string | null
  status_source: string | null
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`
}

/** The last `max` bytes of a file, or null when it cannot be read. */
function tail(file: string, max: number): Buffer | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const n = Math.min(size, max)
    const buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, size - n)
    return buf
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export class Reports {
  private readonly o: ReportsOptions
  // bounded: one per bundle present, ≤ L.reportsKept after each prune
  private known: Map<string, ExpectedState> | null = null

  constructor(o: ReportsOptions) {
    this.o = o
  }

  get dir(): string {
    return path.join(this.o.home, REPORTS_DIR)
  }

  /** Write the bundle; resolves within L.reportCaptureMs plus the disk writes. */
  async write(subject: ReportSubject): Promise<{ dir: string; ms: number }> {
    const t0 = performance.now()
    const id = subject.sessionId
    const row = this.o.db.get<Row>(
      `SELECT s.agent, s.lifecycle, s.end_reason, s.transcript_path AS transcriptPath, r.phase, r.attention, r.background, r.unread, r.failure_kind, r.status_source
       FROM sessions s JOIN session_runtime r ON r.session_id = s.id WHERE s.id = ?`,
      id,
    )
    if (!row || row.lifecycle === 'deleted') throw new RpcError('not_found', `no session ${id}`)
    // the pending status writes go first, so the journal in the bundle is complete (nothing about the session changes)
    this.o.flush()
    const wall = this.o.now()
    const mono = this.o.mono()
    if (fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }) !== undefined) this.o.folderMade?.(this.dir)
    let name = `${stamp(wall)}-${id}`
    for (let i = 2; fs.existsSync(path.join(this.dir, name)); i++) name = `${stamp(wall)}-${id}-${i}`
    const dir = path.join(this.dir, name)
    fs.mkdirSync(dir, { mode: 0o700 })
    const missing: string[] = []
    const write = (file: string, data: string | Uint8Array) => fs.writeFileSync(path.join(dir, file), data, { mode: 0o600 })

    // the screen is asked for first: it is the one part that waits (ptyhost), bounded by what is left of the capture time
    const ptyId = this.o.agentPty?.(id) ?? null
    const screen = ptyId && this.o.screen ? this.o.screen(ptyId).catch(() => null) : Promise.resolve(null)

    const events = this.o.db.all<{ at: number; source: string; event: string; summary: string | null; phase_after: string }>(
      'SELECT at, source, event, summary, phase_after FROM status_events WHERE session_id = ? ORDER BY id DESC LIMIT ?',
      id,
      L.reportEvents,
    )
    write('status-events.ndjson', events.reverse().map((e) => JSON.stringify({ at: e.at, source: e.source, event: e.event, summary: e.summary, phaseAfter: e.phase_after })).join('\n') + (events.length ? '\n' : ''))

    const m = subject.machine
    const ring = m ? [...m.ring].sort((a, b) => a.seq - b.seq) : []
    write('signals.ndjson', ring.map((r) => JSON.stringify(signalToJson(r))).join('\n') + (ring.length ? '\n' : ''))

    const transcript = row.transcriptPath ? tail(row.transcriptPath, L.reportTranscriptBytes) : null
    if (transcript) write('transcript.jsonl', transcript)
    else missing.push('transcript')

    const statusFile = this.o.statusFile?.(id) ?? null
    const sf = statusFile ? tail(statusFile, L.hookEnvelopeMaxBytes) : null
    if (sf) write('status-file.json', sf)
    else if (statusFile) missing.push('status-file')

    const ringBytes = ptyId ? this.ringTail(id, ptyId) : null
    if (ringBytes) write('ring.bin', ringBytes)
    else missing.push('ring')

    try {
      write('resources.json', JSON.stringify(this.o.resources?.() ?? null, null, 1))
    } catch {
      missing.push('resources')
    }

    // The system it happened on, as main reported it (scrubbed by the caller)
    const platform = this.o.platform ? this.o.platform() : null
    if (this.o.platform && !platform) missing.push('platform')

    let timer: ReturnType<typeof setTimeout> | null = null
    const left = Math.max(0, L.reportCaptureMs - (performance.now() - t0))
    const LATE = Symbol('late')
    const shot = await Promise.race([screen, new Promise<typeof LATE>((r) => (timer = setTimeout(() => r(LATE), left)))])
    if (timer) clearTimeout(timer)
    if (typeof shot === 'string') write('screen.txt', shot)
    else missing.push(shot === LATE ? 'screen (late)' : 'screen')

    const s: StatusState | null = m ? m.state : null
    const start: ReplayStart | null = m ? { base: stateToJson(m.ringBase.state), baseMono: m.ringBase.mono === null ? null : m.ringBase.mono.toString(), prompt: m.prompt, noTurns: m.noTurns } : null
    let attention: unknown = []
    try {
      attention = s ? s.attention : JSON.parse(row.attention)
    } catch {
      attention = []
    }
    const report = {
      format: 1,
      kea: { version: this.o.version, commit: this.o.commit ?? null },
      sessionId: id,
      agent: row.agent,
      cliVersion: this.o.cliVersion?.(row.agent) ?? null,
      lifecycle: row.lifecycle,
      endReason: row.end_reason,
      phase: s?.phase ?? row.phase,
      attention,
      background: s ? s.background : row.background !== 0,
      unread: s ? s.unread : row.unread !== 0,
      failureKind: s ? s.failureKind : row.failure_kind,
      source: s ? s.source : row.status_source,
      unconfirmed: subject.unconfirmed,
      expected: subject.expected,
      note: subject.note,
      wall,
      mono: mono.toString(),
      start,
      platform,
      missing,
    }
    write('report.json', JSON.stringify(report, null, 1))
    const ms = performance.now() - t0
    this.counts()
    this.known?.set(name, subject.expected)
    this.prune()
    this.o.log.info('status report saved', { sessionId: id, dir, ms: Math.round(ms), expected: subject.expected, missing })
    return { dir, ms }
  }

  /** The newest L.reportsKept bundles, at most L.reportsMaxBytes together; the rest go. */
  prune(): void {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir).filter((n) => BUNDLE_RE.test(n))
    } catch {
      return
    }
    names.sort().reverse()
    let total = 0
    let kept = 0
    for (const n of names) {
      const p = path.join(this.dir, n)
      const size = dirBytes(p)
      if (kept < L.reportsKept && total + size <= L.reportsMaxBytes) {
        kept++
        total += size
        continue
      }
      fs.rmSync(p, { recursive: true, force: true })
      this.known?.delete(n)
    }
  }

  /** The bundles present, by expected state (and in all). */
  counts(): Record<ExpectedState | 'total', number> {
    if (!this.known) {
      this.known = new Map()
      let names: string[] = []
      try {
        names = fs.readdirSync(this.dir).filter((n) => BUNDLE_RE.test(n))
      } catch {
        names = []
      }
      for (const n of names) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(this.dir, n, 'report.json'), 'utf8')) as { expected?: unknown }
          if ((EXPECTED_STATES as readonly unknown[]).includes(r.expected)) this.known.set(n, r.expected as ExpectedState)
        } catch {
          // a bundle without a readable report.json is not counted
        }
      }
    }
    const out = { total: 0, working: 0, needsMe: 0, finished: 0, idle: 0, ended: 0 } as Record<ExpectedState | 'total', number>
    for (const e of this.known.values()) {
      out[e]++
      out.total++
    }
    return out
  }

  /** The last L.reportRingBytes of the agent PTY's ring file, or null. */
  private ringTail(sessionId: string, ptyId: string): Uint8Array | null {
    try {
      const file = fs.readFileSync(path.join(this.o.home, 'sessions', sessionId, `${ptyId}.ring`))
      const h = parseRingHeader(file)
      return h ? (readRing(file, Math.max(0, h.latestSeq - L.reportRingBytes))?.data ?? null) : null
    } catch {
      return null
    }
  }
}

function dirBytes(dir: string): number {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size
    }
  } catch {
    // gone meanwhile
  }
  return n
}
