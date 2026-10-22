// Core's one SQLite connection (driver better-sqlite3 13.0.3). Core is the single writer.
//
// Opening `<KEA_HOME>/kea.db`:
//   1. pragmas: WAL, synchronous NORMAL, foreign keys, busy timeout, page cache (L.dbCacheKib), journal size limit;
//   2. `PRAGMA quick_check` on every open, the full `integrity_check` after an unclean shutdown (the `core.open` key
//      in `kv` is still set: core did not close the database);
//   3. migrations (schema.ts): the file is copied to `kea.db.bak-<version>` first, then each migration runs in one
//      transaction with synchronous FULL;
//   4. anything unreadable — not a database, corrupt, a schema from a newer build — is renamed aside to `kea.db.corrupt`
//      (its -wal and -shm with it, replacing an older set) and a fresh database is created: `fresh` tells the caller
//      to rebuild projects and sessions from the holders' state files (sessions/rebuild.ts).
//
// Discipline: one connection; statements prepared once through `stmt()` (cached by their SQL text, which is
// fixed in code, so the cache is a fixed set); rows read with `get`/`all` only, never a pending `.iterate()`; writes in
// `tx()` (`BEGIN IMMEDIATE`). After a write the WAL is checkpointed with TRUNCATE once it exceeds L.dbWalTruncateBytes,
// and again L.dbIdleCheckpointMs after the last write. A corrupt-database error at run time goes to `onCorrupt` (core
// exits, and the next open's integrity check sets the file aside).

import fs from 'node:fs'
import Database, { type Database as Sqlite, type Statement } from 'better-sqlite3'
import type { Logger } from '@kea/kit'
import { L } from '@kea/protocol'
import { sqliteBindingPath } from './native.ts'
import { MIGRATIONS, type Migration } from './schema.ts'

/** The `kv` key that is set while core has the database open (cleared by `close()`). */
export const OPEN_KEY = 'core.open'

const CORRUPT_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_CORRUPT_VTAB', 'SQLITE_CORRUPT_SEQUENCE', 'SQLITE_CORRUPT_INDEX', 'SQLITE_IOERR_SHORT_READ'])

/** A SQLite error that means the file cannot be trusted. */
export function isCorruptError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && CORRUPT_CODES.has(code)
}

/** The database file is unusable for a reason other than an SQLite error (a schema from a newer Kea). */
class Unusable extends Error {}

export interface OpenOptions {
  /** `<KEA_HOME>/kea.db`, or `:memory:` (unit tests). */
  file: string
  log: Logger
  /** Default: the schema's MIGRATIONS (tests append their own). */
  migrations?: readonly Migration[]
  /** A corrupt-database error at run time (default: logged). */
  onCorrupt?: (e: unknown) => void
}

export interface OpenResult {
  db: KeaDb
  /** A new, empty database: first run, a lost file, or one set aside. Projects and sessions are to be rebuilt. */
  fresh: boolean
  /** Where an unusable file was moved, and why. */
  setAside: { path: string; reason: string } | null
  /** The full integrity check ran (unclean shutdown). */
  integrityChecked: boolean
  /** The version the file had before migrating (0: new). */
  fromVersion: number
}

type Tx = <T>(fn: () => T) => T

export class KeaDb {
  readonly file: string
  private readonly raw: Sqlite
  private readonly log: Logger
  private readonly statements = new Map<string, Statement>() // bounded: one per distinct SQL text in core's code
  private readonly immediate: Tx
  private readonly onCorrupt: (e: unknown) => void
  private idle: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /** Writes committed (the resource report). */
  writes = 0
  checkpoints = 0

  constructor(raw: Sqlite, file: string, log: Logger, onCorrupt?: (e: unknown) => void) {
    this.raw = raw
    this.file = file
    this.log = log
    this.onCorrupt = onCorrupt ?? ((e) => log.error('database corrupt', { error: String(e) }))
    const t = raw.transaction((fn: () => unknown) => fn())
    this.immediate = <T>(fn: () => T): T => t.immediate(fn) as T
  }

  /** A prepared statement, created on first use and reused. */
  stmt<P extends unknown[] = unknown[], R = unknown>(sql: string): Statement<P, R> {
    let s = this.statements.get(sql)
    if (!s) {
      const made = this.guard(() => this.raw.prepare(sql))
      this.statements.set(sql, made)
      s = made
    }
    return s as unknown as Statement<P, R>
  }

  get<R>(sql: string, ...params: unknown[]): R | undefined {
    return this.guard(() => this.stmt<unknown[], R>(sql).get(...params))
  }

  all<R>(sql: string, ...params: unknown[]): R[] {
    return this.guard(() => this.stmt<unknown[], R>(sql).all(...params))
  }

  /** One statement outside a transaction of its own (inside `tx`, or a single-statement write). */
  run(sql: string, ...params: unknown[]): number {
    return this.guard(() => this.stmt(sql).run(...params).changes)
  }

  /** A write transaction (`BEGIN IMMEDIATE`): all or nothing. Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.raw.inTransaction) return fn()
    const v = this.guard(() => this.immediate(fn))
    this.writes++
    this.afterWrite()
    return v
  }

  /** `PRAGMA wal_checkpoint(TRUNCATE)`; only core runs checkpoints. */
  checkpoint(): void {
    if (this.closed || this.raw.memory) return
    this.guard(() => this.raw.pragma('wal_checkpoint(TRUNCATE)'))
    this.checkpoints++
  }

  /** The WAL file's size in bytes (0 when there is none). */
  walBytes(): number {
    if (this.raw.memory) return 0
    try {
      return fs.statSync(`${this.file}-wal`).size
    } catch {
      return 0
    }
  }

  pragma(source: string): unknown {
    return this.guard(() => this.raw.pragma(source, { simple: true }))
  }

  /** The resource report's `core.db` row. */
  get stats(): { statements: number; walBytes: number; writes: number; checkpoints: number } {
    return { statements: this.statements.size, walBytes: this.walBytes(), writes: this.writes, checkpoints: this.checkpoints }
  }

  get isOpen(): boolean {
    return !this.closed
  }

  /** The whole database (tests: a status batch is all there or not at all). */
  serialize(): Buffer {
    return this.raw.serialize()
  }

  /** Clean close: the open marker is cleared and the WAL truncated, so the next open skips the full integrity check. */
  close(): void {
    if (this.closed) return
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    try {
      this.tx(() => this.run('DELETE FROM kv WHERE key = ?', OPEN_KEY))
      this.checkpoint()
    } catch (e) {
      this.log.warn('database close: marker not cleared', { error: String(e) })
    }
    this.closed = true
    this.statements.clear()
    this.raw.close()
  }

  /**
   * Close without the clean-shutdown steps (tests): the open marker stays set, as a killed core leaves it. SQLite's own
   * close still checkpoints and deletes the WAL, so a test of a lost WAL copies the main file before closing.
   */
  abandon(): void {
    if (this.closed) return
    if (this.idle) clearTimeout(this.idle)
    this.closed = true
    this.statements.clear()
    this.raw.close()
  }

  private afterWrite(): void {
    if (this.raw.memory) return
    if (this.walBytes() > L.dbWalTruncateBytes) this.checkpoint()
    if (this.idle) this.idle.refresh()
    else {
      this.idle = setTimeout(() => {
        this.idle = null
        if (!this.closed) this.checkpoint()
      }, L.dbIdleCheckpointMs)
      this.idle.unref?.()
    }
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      if (isCorruptError(e)) this.onCorrupt(e)
      throw e
    }
  }
}

function applyPragmas(raw: Sqlite): void {
  raw.pragma('journal_mode = WAL')
  raw.pragma('synchronous = NORMAL')
  raw.pragma('foreign_keys = ON')
  raw.pragma(`busy_timeout = ${L.dbBusyTimeoutMs}`)
  raw.pragma(`cache_size = -${L.dbCacheKib}`)
  raw.pragma(`journal_size_limit = ${L.dbJournalSizeLimitBytes}`)
}

function openRaw(file: string): Sqlite {
  const binding = sqliteBindingPath()
  return new Database(file, { timeout: L.dbBusyTimeoutMs, ...(binding ? { nativeBinding: binding } : {}) })
}

const SIDE_FILES = ['', '-wal', '-shm'] as const

/** Move `kea.db` (+ -wal, -shm) to `kea.db.corrupt` (+ -wal, -shm), replacing an older set. */
function setAsideFiles(file: string): string {
  const aside = `${file}.corrupt`
  for (const x of SIDE_FILES) fs.rmSync(`${aside}${x}`, { force: true })
  for (const x of SIDE_FILES) {
    try {
      fs.renameSync(`${file}${x}`, `${aside}${x}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return aside
}

function checkResult(v: unknown): string | null {
  return v === 'ok' ? null : String(v)
}

/** Bring a database to the newest schema. Returns the version it had. */
export function migrate(raw: Sqlite, file: string, migrations: readonly Migration[], log: Logger): number {
  const from = Number(raw.pragma('user_version', { simple: true }))
  const latest = migrations[migrations.length - 1]?.version ?? 0
  if (from > latest) throw new Unusable(`schema version ${from} is newer than this build's ${latest}`)
  if (from === latest) return from
  if (from > 0 && file !== ':memory:') {
    raw.pragma('wal_checkpoint(TRUNCATE)')
    fs.copyFileSync(file, `${file}.bak-${from}`)
  }
  raw.pragma('synchronous = FULL')
  try {
    for (const m of migrations) {
      if (m.version <= from) continue
      raw.transaction(() => {
        raw.exec(m.sql)
        raw.pragma(`user_version = ${m.version}`)
      }).immediate()
      log.info('database migrated', { version: m.version, name: m.name })
    }
  } finally {
    raw.pragma('synchronous = NORMAL')
  }
  return from
}

/** Open (and if need be set aside, create and migrate) the database. See the module comment. */
export function openDatabase(o: OpenOptions): OpenResult {
  const migrations = o.migrations ?? MIGRATIONS
  const memory = o.file === ':memory:'
  let setAside: OpenResult['setAside'] = null

  const attempt = (): Omit<OpenResult, 'setAside'> => {
    const existed = !memory && fs.existsSync(o.file)
    const raw = openRaw(o.file)
    try {
      applyPragmas(raw)
      if (!memory) fs.chmodSync(o.file, 0o600)
      let integrityChecked = false
      const version = Number(raw.pragma('user_version', { simple: true }))
      if (existed && version > 0) {
        const quick = checkResult(raw.pragma('quick_check', { simple: true }))
        if (quick) throw new Unusable(`quick_check: ${quick}`)
        const marker = raw.prepare('SELECT value FROM kv WHERE key = ?').pluck().get(OPEN_KEY)
        if (marker !== undefined) {
          integrityChecked = true
          const full = checkResult(raw.pragma('integrity_check', { simple: true }))
          if (full) throw new Unusable(`integrity_check after an unclean shutdown: ${full}`)
        }
      }
      const fromVersion = migrate(raw, o.file, migrations, o.log)
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(OPEN_KEY, String(Date.now()))
      return { db: new KeaDb(raw, o.file, o.log, o.onCorrupt), fresh: fromVersion === 0, integrityChecked, fromVersion }
    } catch (e) {
      raw.close()
      throw e
    }
  }

  try {
    return { ...attempt(), setAside }
  } catch (e) {
    if (memory || !(e instanceof Unusable || isCorruptError(e))) throw e
    const reason = e instanceof Error ? e.message : String(e)
    const aside = setAsideFiles(o.file)
    setAside = { path: aside, reason }
    o.log.error('database unusable; set aside, starting fresh and rebuilding from the holders', { file: o.file, aside, reason })
    return { ...attempt(), setAside }
  }
}

// ── kv: window bounds, column widths, caches … ────────────────────────────────────────────────────────────

export function kvGet(db: KeaDb, key: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value
}

export function kvSet(db: KeaDb, key: string, value: string): void {
  db.tx(() => db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value))
}

export function kvDelete(db: KeaDb, key: string): void {
  db.tx(() => db.run('DELETE FROM kv WHERE key = ?', key))
}
