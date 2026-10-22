// Structured logs per process: NDJSON lines `{"t", "level", "proc", "msg", ...fields}` appended to
// `<dir>/<process>.log`, rotated at L.logFileMaxBytes so that at most L.logFilesKept files exist per process (the live
// file plus `.1` … `.<kept−1>`, newest first). Appends are synchronous and never throw: a failed write (disk full)
// is dropped and counted, and writing resumes when space returns.

import fs from 'node:fs'
import { join } from 'node:path'
import { L } from '@kea/protocol/limits'
import type { Disposable } from './disposable.ts'
import { BoundedQueue } from './lru.ts'
import { resources } from './resources.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** A logger that adds `fields` to every line (same sink). */
  child(fields: LogFields): Logger
}

export interface LogEntry {
  t: string
  level: LogLevel
  proc: string
  msg: string
  [field: string]: unknown
}

export type ProcessName = 'main' | 'core' | 'ptyhost' | 'renderer' | (string & {})

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const RESERVED = new Set(['t', 'level', 'proc', 'msg'])

const droppedTotal = resources.counter('kit.log.dropped')

function makeEntry(level: LogLevel, proc: string, msg: string, base: LogFields, fields: LogFields | undefined, wall: number): LogEntry {
  const entry: LogEntry = { t: new Date(wall).toISOString(), level, proc, msg }
  for (const src of [base, fields]) {
    if (!src) continue
    for (const k of Object.keys(src)) if (!RESERVED.has(k)) entry[k] = src[k]
  }
  return entry
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as NodeJS.ErrnoException).code
    return { name: value.name, message: value.message, ...(code !== undefined ? { code } : {}), stack: value.stack }
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

/** One NDJSON line; never throws (unserialisable fields are replaced by a note). */
export function formatLine(entry: LogEntry): string {
  try {
    return `${JSON.stringify(entry, replacer)}\n`
  } catch (err) {
    const { t, level, proc, msg } = entry
    return `${JSON.stringify({ t, level, proc, msg, fieldsError: String(err) })}\n`
  }
}

type Emit = (level: LogLevel, msg: string, fields: LogFields | undefined, base: LogFields) => void

function makeLogger(emit: Emit, base: LogFields): Logger {
  return {
    debug: (msg, fields) => emit('debug', msg, fields, base),
    info: (msg, fields) => emit('info', msg, fields, base),
    warn: (msg, fields) => emit('warn', msg, fields, base),
    error: (msg, fields) => emit('error', msg, fields, base),
    child: (fields) => makeLogger(emit, { ...base, ...fields }),
  }
}

// ── file logger ─────────────────────────────────────────────────────────────────

export interface FileLoggerOptions {
  dir: string
  process: ProcessName
  /** File name in `dir` (default `<process>.log`): `resources.ndjson` rotates by the same rules. */
  file?: string
  /** Lowest level written (default 'info'). */
  level?: LogLevel
  /** Rotation size (default L.logFileMaxBytes). */
  maxBytes?: number
  /** Files kept per process, the live one included (default L.logFilesKept). */
  filesKept?: number
  /** Wall-clock source for `t` (default Date.now). */
  now?: () => number
}

export interface FileLogger extends Logger, Disposable {
  /** `<dir>/<process>.log`, or `<dir>/<file>`. */
  readonly path: string
  /** Lines dropped because they could not be written (or exceeded maxBytes alone). */
  readonly dropped: number
}

export function createLogger(opts: FileLoggerOptions): FileLogger {
  const path = join(opts.dir, opts.file ?? `${opts.process}.log`)
  const maxBytes = opts.maxBytes ?? L.logFileMaxBytes
  const kept = Math.max(1, opts.filesKept ?? L.logFilesKept)
  const minRank = LEVEL_RANK[opts.level ?? 'info']
  const now = opts.now ?? Date.now
  let fd: number | undefined
  let size = 0
  let dropped = 0
  let disposed = false

  const drop = (): void => {
    dropped++
    droppedTotal.inc()
  }

  const open = (): void => {
    try {
      fs.mkdirSync(opts.dir, { recursive: true })
      fd = fs.openSync(path, 'a', 0o600)
      size = fs.fstatSync(fd).size
    } catch {
      fd = undefined
    }
  }

  const closeFd = (): void => {
    if (fd === undefined) return
    try {
      fs.closeSync(fd)
    } catch {
      // nothing to do
    }
    fd = undefined
  }

  const rotate = (): void => {
    closeFd()
    try {
      if (kept === 1) {
        fs.rmSync(path, { force: true })
      } else {
        fs.rmSync(`${path}.${kept - 1}`, { force: true })
        for (let i = kept - 2; i >= 1; i--) {
          if (fs.existsSync(`${path}.${i}`)) fs.renameSync(`${path}.${i}`, `${path}.${i + 1}`)
        }
        if (fs.existsSync(path)) fs.renameSync(path, `${path}.1`)
      }
    } catch {
      // A failed rotation must not stop logging; the next open appends to whatever is there.
    }
    open()
  }

  const write = (line: string): void => {
    if (disposed) return
    const bytes = Buffer.byteLength(line)
    if (bytes > maxBytes) {
      drop()
      return
    }
    if (fd === undefined) open()
    if (fd !== undefined && size + bytes > maxBytes) rotate()
    if (fd === undefined) {
      drop()
      return
    }
    try {
      fs.writeSync(fd, line)
      size += bytes
    } catch {
      drop()
    }
  }

  open()

  const emit: Emit = (level, msg, fields, base) => {
    if (LEVEL_RANK[level] < minRank) return
    write(formatLine(makeEntry(level, opts.process, msg, base, fields, now())))
  }

  const logger = makeLogger(emit, {})
  return {
    ...logger,
    path,
    get dropped() {
      return dropped
    },
    dispose() {
      if (disposed) return
      disposed = true
      closeFd()
    },
  }
}

// ── no-op and memory loggers ────────────────────────────────────────────────────

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
}

export interface MemoryLogger extends Logger {
  /** Entries kept (newest L.logMemoryEntries, oldest first). */
  readonly entries: readonly LogEntry[]
  clear(): void
}

/** Keeps the newest entries in memory: tests, and "recent errors" for Copy diagnostics. */
export function createMemoryLogger(opts: { process?: ProcessName; level?: LogLevel; cap?: number; now?: () => number } = {}): MemoryLogger {
  // bounded: L.logMemoryEntries, oldest dropped
  const queue = new BoundedQueue<LogEntry>({ cap: opts.cap ?? L.logMemoryEntries, overflow: 'drop-oldest' })
  const minRank = LEVEL_RANK[opts.level ?? 'debug']
  const proc = opts.process ?? 'test'
  const now = opts.now ?? Date.now
  const emit: Emit = (level, msg, fields, base) => {
    if (LEVEL_RANK[level] < minRank) return
    queue.push(makeEntry(level, proc, msg, base, fields, now()))
  }
  return {
    ...makeLogger(emit, {}),
    get entries() {
      return [...queue]
    },
    clear() {
      queue.clear()
    },
  }
}
