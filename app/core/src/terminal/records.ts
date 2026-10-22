// Core's records of the PTYs it started. Reconciliation compares them with ptyhost's holder list. Sessions'
// records are on SQLite (the `ptys` table, dbRecords.ts); the shell tabs of the `shells` pane, which have no session,
// keep theirs in `<KEA_HOME>/terminals.json`: written atomically (temp → fsync → rename), mode 0600, at most
// L.terminalRecordsMax records. A file, not memory, because a core that restarts or a relaunch must still know its
// terminals; with records only in memory every surviving holder would look like an orphan.

import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteSync, type Logger } from '@kea/kit'
import { L, PTY_ID_RE, PTY_KIND, PTY_STATE, type PtyKind, type PtyState } from '@kea/protocol'

/** One row of the `ptys` table, plus the working directory (for a session's PTY, the session's `cwd`). */
export interface TerminalRecord {
  ptyId: string
  sessionId: string
  kind: PtyKind
  argv: string[]
  cwd: string
  title: string | null
  holderPid: number | null
  /** Holder process start time, ms since the epoch (from its state file): guards against pid reuse. */
  holderStartedAt: number | null
  childPid: number | null
  cols: number
  rows: number
  state: PtyState
  exitCode: number | null
  exitSignal: number | null
  tabOrder: number
  createdAt: number
  endedAt: number | null
}

export interface TerminalRecords {
  /**
   * False when there was nothing to load (first run, or an unreadable file set aside): reconciliation then rebuilds the
   * records from the live holders' state files instead of calling them orphans.
   */
  readonly loaded: boolean
  /**
   * Whether a live holder of `sessionId` found without a record gets one at reconciliation. Default: `!loaded`, for
   * every session.
   */
  rebuildsSession?(sessionId: string): boolean
  list(): TerminalRecord[]
  get(ptyId: string): TerminalRecord | undefined
  /**
   * Insert or replace, and persist. At the cap the oldest ended record makes room; throws when every record is
   * still running.
   */
  put(r: TerminalRecord): void
  /** Several inserts / replacements in one write (reconciliation). */
  putMany(rs: readonly TerminalRecord[]): void
  delete(ptyId: string): void
}

const FILE_VERSION = 1

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const intOrNull = (v: unknown): v is number | null => v === null || isInt(v)
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

/** A record read back from disk, or null if any field is missing or of the wrong type. */
export function parseRecord(v: unknown): TerminalRecord | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (typeof o.ptyId !== 'string' || !PTY_ID_RE.test(o.ptyId)) return null
  if (typeof o.sessionId !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(o.sessionId)) return null
  if (!(PTY_KIND as readonly unknown[]).includes(o.kind) || !(PTY_STATE as readonly unknown[]).includes(o.state)) return null
  if (!Array.isArray(o.argv) || !o.argv.every((a) => typeof a === 'string') || typeof o.cwd !== 'string') return null
  if (!strOrNull(o.title) || !intOrNull(o.holderPid) || !intOrNull(o.holderStartedAt) || !intOrNull(o.childPid)) return null
  if (!isInt(o.cols) || !isInt(o.rows) || !intOrNull(o.exitCode) || !intOrNull(o.exitSignal)) return null
  if (!isInt(o.tabOrder) || !isInt(o.createdAt) || !intOrNull(o.endedAt)) return null
  return {
    ptyId: o.ptyId,
    sessionId: o.sessionId,
    kind: o.kind as PtyKind,
    argv: o.argv as string[],
    cwd: o.cwd,
    title: o.title,
    holderPid: o.holderPid,
    holderStartedAt: o.holderStartedAt,
    childPid: o.childPid,
    cols: o.cols,
    rows: o.rows,
    state: o.state as PtyState,
    exitCode: o.exitCode,
    exitSignal: o.exitSignal,
    tabOrder: o.tabOrder,
    createdAt: o.createdAt,
    endedAt: o.endedAt,
  }
}

/** The shared in-memory part: the map, the cap and its eviction rule. */
export class MemoryRecords implements TerminalRecords {
  readonly loaded: boolean
  protected readonly map = new Map<string, TerminalRecord>() // bounded: L.terminalRecordsMax, oldest ended evicted

  constructor(initial?: readonly TerminalRecord[]) {
    this.loaded = initial !== undefined
    for (const r of initial ?? []) this.map.set(r.ptyId, r)
  }

  list(): TerminalRecord[] {
    return [...this.map.values()]
  }

  get(ptyId: string): TerminalRecord | undefined {
    return this.map.get(ptyId)
  }

  put(r: TerminalRecord): void {
    this.putMany([r])
  }

  putMany(rs: readonly TerminalRecord[]): void {
    const next = new Map(this.map)
    for (const r of rs) {
      if (!next.has(r.ptyId)) makeRoom(next)
      next.set(r.ptyId, r)
    }
    this.commit(next)
  }

  delete(ptyId: string): void {
    if (!this.map.has(ptyId)) return
    const next = new Map(this.map)
    next.delete(ptyId)
    this.commit(next)
  }

  /** Persist `next` (the file store writes it first, so a failed write changes nothing), then adopt it. */
  protected commit(next: Map<string, TerminalRecord>): void {
    this.map.clear()
    for (const [k, v] of next) this.map.set(k, v)
  }
}

function makeRoom(m: Map<string, TerminalRecord>): void {
  if (m.size < L.terminalRecordsMax) return
  const ended = [...m.values()].filter((r) => r.state !== 'running').sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt))
  const victim = ended[0]
  if (!victim) throw new Error(`terminal records: ${L.terminalRecordsMax} running terminals (L.terminalRecordsMax); refusing another`)
  m.delete(victim.ptyId)
}

/** `<KEA_HOME>/terminals.json`: the `shells` pseudo-session's records. */
export function recordsPath(home: string): string {
  return path.join(home, 'terminals.json')
}

/**
 * The records file of the `shells` pseudo-session. An unreadable file (bad JSON, wrong version, too many records) is
 * renamed to `terminals.json.unreadable` (replacing an older one) and the store starts empty with `loaded = false`;
 * single bad entries are dropped.
 */
export class FileRecords extends MemoryRecords {
  private readonly file: string

  private constructor(file: string, initial: TerminalRecord[] | undefined) {
    super(initial)
    this.file = file
  }

  static open(home: string, log: Logger): FileRecords {
    const file = recordsPath(home)
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('terminal records unreadable', { file, error: (e as Error).message })
      return new FileRecords(file, undefined)
    }
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      doc = null
    }
    const o = doc as { v?: unknown; records?: unknown } | null
    if (!o || o.v !== FILE_VERSION || !Array.isArray(o.records) || o.records.length > L.terminalRecordsMax) {
      const aside = `${file}.unreadable`
      try {
        fs.renameSync(file, aside)
      } catch {
        // gone meanwhile
      }
      log.error('terminal records file unreadable; set aside, rebuilding from the holders', { file, aside })
      return new FileRecords(file, undefined)
    }
    const records: TerminalRecord[] = []
    for (const v of o.records) {
      const r = parseRecord(v)
      if (r) records.push(r)
      else log.warn('terminal record dropped: malformed', { file })
    }
    return new FileRecords(file, records)
  }

  protected override commit(next: Map<string, TerminalRecord>): void {
    atomicWriteSync(this.file, `${JSON.stringify({ v: FILE_VERSION, records: [...next.values()] })}\n`, { mode: 0o600 })
    super.commit(next)
  }
}
