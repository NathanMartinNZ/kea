import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger } from '@kea/kit'
import { ENUM_COLUMNS, L } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBatch, type StatusEvent } from './batch.ts'
import Database from 'better-sqlite3'
import { KeaDb, kvGet, kvSet, migrate, OPEN_KEY, openDatabase } from './db.ts'
import { checkInvariants } from './invariants.ts'
import { MIGRATIONS, SCHEMA_VERSION, TABLES, type Migration } from './schema.ts'

const FIXTURES = path.resolve(import.meta.dirname, '../../../../../fixtures/db')
const log = () => createMemoryLogger({ process: 'core' })
const T0 = 1_790_000_000_000

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
  vi.useRealTimers()
})

function memory(): KeaDb {
  const { db } = openDatabase({ file: ':memory:', log: log() })
  cleanup.push(() => db.abandon())
  return db
}

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-db-test-'))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function schemaOf(db: KeaDb): { type: string; name: string; sql: string }[] {
  return db.all<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
}

let n = 0
function project(db: KeaDb, over: Record<string, unknown> = {}): string {
  const id = `01K00000000000000000000P${String(++n).padStart(2, '0')}`
  const r = { id, name: 'p', root_path: `/repos/p${n}`, sort_order: n, created_at: T0, ...over }
  db.tx(() => db.run('INSERT INTO projects (id, name, root_path, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', r.id, r.name, r.root_path, r.sort_order, r.created_at))
  return id
}

function session(db: KeaDb, projectId: string, over: Record<string, unknown> = {}): string {
  const id = `01K00000000000000000000S${String(++n).padStart(2, '0')}`
  const r = { slug: `s${n}`, isolation: 'worktree', cwd: `/wt/p/s${n}`, worktree_root: '/wt', lifecycle: 'detached', end_reason: 'stopped', port_base: null, deleted_at: null, ...over }
  db.tx(() =>
    db.run(
      `INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, worktree_root, agent, launch_config, lifecycle, end_reason, port_base, deleted_at, sort_order, created_at)
       VALUES (?, ?, ?, 'T', 'auto', ?, ?, ?, 'shell', '{}', ?, ?, ?, ?, 0, ?)`,
      id, projectId, r.slug, r.isolation, r.cwd, r.worktree_root, r.lifecycle, r.end_reason, r.port_base, r.deleted_at, T0,
    ),
  )
  return id
}

function pty(db: KeaDb, sessionId: string, kind = 'agent', state = 'running'): string {
  const id = `p${String(++n).padStart(9, '0')}`
  db.tx(() => db.run(`INSERT INTO ptys (id, session_id, kind, argv, state, created_at) VALUES (?, ?, ?, '[]', ?, ?)`, id, sessionId, kind, state, T0))
  return id
}

describe('database schema and migrations', () => {
  it('U-DB-1 · migrations apply in order on an empty database and on each historical fixture database', () => {
    const fresh = memory()
    expect(fresh.pragma('user_version')).toBe(SCHEMA_VERSION)
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
    const tables = fresh.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name)
    expect(tables).toEqual([...TABLES].sort())

    const fixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.sql'))
    expect(fixtures.length).toBeGreaterThan(0)
    for (const f of fixtures) {
      const raw = new Database(':memory:')
      raw.pragma('foreign_keys = ON')
      raw.exec(fs.readFileSync(path.join(FIXTURES, f), 'utf8'))
      const db = new KeaDb(raw, ':memory:', log())
      cleanup.push(() => db.abandon())
      const before = Object.fromEntries(TABLES.map((t) => [t, db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n]))
      const from = migrate(raw, ':memory:', MIGRATIONS, log())
      expect(from, f).toBeGreaterThan(0)
      expect(db.pragma('user_version'), f).toBe(SCHEMA_VERSION)
      expect(schemaOf(db), f).toEqual(schemaOf(fresh))
      for (const t of TABLES) expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n, `${f}: ${t} rows kept`).toBe(before[t])
      expect(checkInvariants(db), f).toEqual([])
    }
  })

  it('U-DB-1 · an older file is copied to kea.db.bak-<version> before migrating; a failing migration leaves it as it was', () => {
    const dir = tempDir()
    const file = path.join(dir, 'kea.db')
    const first = openDatabase({ file, log: log() })
    project(first.db)
    first.db.close()

    const v2: Migration = { version: SCHEMA_VERSION + 1, name: 'test: a column', sql: 'ALTER TABLE presets ADD COLUMN note TEXT;' }
    const second = openDatabase({ file, log: log(), migrations: [...MIGRATIONS, v2] })
    expect(second.fromVersion).toBe(SCHEMA_VERSION)
    expect(second.fresh).toBe(false)
    expect(fs.existsSync(`${file}.bak-${SCHEMA_VERSION}`)).toBe(true)
    expect(second.db.pragma('user_version')).toBe(v2.version)
    expect(second.db.get<{ n: number }>('SELECT count(*) AS n FROM projects')!.n).toBe(1)
    second.db.close()

    const broken: Migration = { version: v2.version + 1, name: 'test: fails halfway', sql: 'ALTER TABLE presets ADD COLUMN other TEXT; SELECT nope FROM nowhere;' }
    expect(() => openDatabase({ file, log: log(), migrations: [...MIGRATIONS, v2, broken] })).toThrow()
    const third = openDatabase({ file, log: log(), migrations: [...MIGRATIONS, v2] })
    expect(third.db.pragma('user_version')).toBe(v2.version)
    expect(third.db.all<{ name: string }>("SELECT name FROM pragma_table_info('presets')").map((c) => c.name)).not.toContain('other')
    third.db.close()
  })

  it('U-DB-3 · the live schema’s CHECK constraints equal enums.ts, and nothing outside an enum is accepted', () => {
    const db = memory()
    const checks: { table: string; column: string; values: string[]; nullable: boolean }[] = []
    for (const { name, sql } of db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'")) {
      for (const m of sql.matchAll(/CHECK \((\w+) (IS NULL OR \w+ )?IN \(([^)]*)\)\)/g)) {
        checks.push({ table: name, column: m[1]!, values: [...m[3]!.matchAll(/'([^']*)'/g)].map((v) => v[1]!), nullable: !!m[2] })
      }
    }
    const expected = ENUM_COLUMNS.map((e) => ({ table: e.table, column: e.column, values: [...e.values], nullable: 'nullable' in e && e.nullable === true }))
    const key = (c: { table: string; column: string }) => `${c.table}.${c.column}`
    expect([...checks].sort((a, b) => key(a).localeCompare(key(b)))).toEqual([...expected].sort((a, b) => key(a).localeCompare(key(b))))

    const p = project(db)
    expect(() => session(db, p, { lifecycle: 'zombie' })).toThrow(/CHECK/)
    expect(() => session(db, p, { isolation: 'sandbox' })).toThrow(/CHECK/)
    const s = session(db, p)
    expect(() => pty(db, s, 'daemon')).toThrow(/CHECK/)
    expect(() => db.tx(() => db.run("UPDATE session_runtime SET phase = 'asleep' WHERE session_id = ?", s))).toThrow(/CHECK/)
  })

  it('U-DB-3 · every session insert creates its session_runtime and session_ui rows in the same transaction', () => {
    const db = memory()
    const p = project(db)
    let inside: number[] = []
    db.tx(() => {
      const s = session(db, p, { lifecycle: 'creating', end_reason: null })
      inside = [db.get<{ n: number }>('SELECT count(*) AS n FROM session_runtime WHERE session_id = ?', s)!.n, db.get<{ n: number }>('SELECT count(*) AS n FROM session_ui WHERE session_id = ?', s)!.n]
    })
    expect(inside).toEqual([1, 1])
    const runtime = db.get<{ phase: string; attention: string; last_activity_at: number }>('SELECT phase, attention, last_activity_at FROM session_runtime')
    expect(runtime).toEqual({ phase: 'idle', attention: '[]', last_activity_at: T0 })

    // rolled back together: no runtime or ui row without its session
    expect(() =>
      db.tx(() => {
        session(db, p, { lifecycle: 'creating', end_reason: null })
        throw new Error('creation failed')
      }),
    ).toThrow('creation failed')
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM sessions')!.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM session_runtime')!.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM session_ui')!.n).toBe(1)
  })
})

describe('invariants', () => {
  it('U-DB-2 · the invariant checker flags each violation, and a consistent database has none', () => {
    const db = memory()
    const p = project(db)
    const live = session(db, p, { lifecycle: 'live', end_reason: null, port_base: L.portRangeStart })
    pty(db, live)
    session(db, p, { lifecycle: 'deleted', end_reason: 'stopped', deleted_at: T0 })
    session(db, p, { isolation: 'inplace', cwd: '/repos/p', worktree_root: null })
    expect(checkInvariants(db)).toEqual([])

    const flagged = (): number[] => [...new Set(checkInvariants(db).map((v) => v.invariant))].sort()
    const violate = (n: number, make: () => void, undo: () => void) => {
      make()
      expect(flagged(), `invariant ${n}`).toEqual([n])
      undo()
      expect(flagged(), `invariant ${n} undone`).toEqual([])
    }
    const set = (sql: string, ...params: unknown[]) => () => void db.tx(() => db.run(sql, ...params))

    // 1: a live session has exactly one running agent PTY
    const second = pty(db, live)
    violate(1, () => {}, set('DELETE FROM ptys WHERE id = ?', second))
    violate(1, set("UPDATE ptys SET state = 'exited' WHERE session_id = ?", live), set("UPDATE ptys SET state = 'running' WHERE session_id = ?", live))
    // 2: port blocks inside the port range (L.portRangeStart to L.portRangeEnd), never overlapping
    violate(2, set('UPDATE sessions SET port_base = ? WHERE id = ?', L.portRangeEnd, live), set('UPDATE sessions SET port_base = ? WHERE id = ?', L.portRangeStart, live))
    const other = session(db, p)
    violate(2, set('UPDATE sessions SET port_base = ? WHERE id = ?', L.portRangeStart + L.portBlockSize - 1, other), set('UPDATE sessions SET port_base = NULL WHERE id = ?', other))
    // 3: a worktree session's cwd is inside its own worktree root
    violate(3, set("UPDATE sessions SET cwd = '/elsewhere/s' WHERE id = ?", other), set("UPDATE sessions SET cwd = '/wt/p/x' WHERE id = ?", other))
    violate(3, set("UPDATE sessions SET cwd = '/wtx/p/x' WHERE id = ?", other), set("UPDATE sessions SET cwd = '/wt/p/x' WHERE id = ?", other))
    // 4: title_source only moves forward — refused by the trigger, so the checker never sees it
    db.tx(() => db.run("UPDATE sessions SET title_source = 'user' WHERE id = ?", other))
    expect(() => db.tx(() => db.run("UPDATE sessions SET title_source = 'agent' WHERE id = ?", other))).toThrow(/title_source only moves/)
    expect(db.get<{ t: string }>('SELECT title_source AS t FROM sessions WHERE id = ?', other)!.t).toBe('user')
    // 5: rows whose parent is gone (only possible with foreign keys off)
    db.pragma('foreign_keys = OFF')
    violate(5, set("INSERT INTO ptys (id, session_id, kind, argv, state, created_at) VALUES ('orphan0001', 'gone', 'shell', '[]', 'exited', 0)"), set("DELETE FROM ptys WHERE id = 'orphan0001'"))
    // 6: every session has its runtime and ui rows (the trigger makes them; deleting one shows)
    violate(6, set('DELETE FROM session_ui WHERE session_id = ?', other), set('INSERT INTO session_ui (session_id) VALUES (?)', other))
    violate(6, set('DELETE FROM session_runtime WHERE session_id = ?', other), set('INSERT INTO session_runtime (session_id, last_activity_at) VALUES (?, 0)', other))
    db.pragma('foreign_keys = ON')
    // 7: attention / background only while live; end_reason only when detached, archived or deleted; failure_kind only while failed
    violate(7, set("UPDATE session_runtime SET attention = '[1]' WHERE session_id = ?", other), set("UPDATE session_runtime SET attention = '[]' WHERE session_id = ?", other))
    violate(7, set('UPDATE session_runtime SET background = 1 WHERE session_id = ?', other), set('UPDATE session_runtime SET background = 0 WHERE session_id = ?', other))
    violate(7, set("UPDATE sessions SET end_reason = 'exited' WHERE id = ?", live), set('UPDATE sessions SET end_reason = NULL WHERE id = ?', live))
    violate(7, set("UPDATE session_runtime SET failure_kind = 'auth' WHERE session_id = ?", other), set('UPDATE session_runtime SET failure_kind = NULL WHERE session_id = ?', other))
    // 8: a deleted session has deleted_at, no running PTY and no port block
    const gone = session(db, p, { lifecycle: 'deleted', deleted_at: T0 })
    violate(8, set('UPDATE sessions SET deleted_at = NULL WHERE id = ?', gone), set('UPDATE sessions SET deleted_at = ? WHERE id = ?', T0, gone))
    violate(8, set('UPDATE sessions SET port_base = ? WHERE id = ?', L.portRangeEnd - L.portBlockSize + 1, gone), set('UPDATE sessions SET port_base = NULL WHERE id = ?', gone))
    const ghost = pty(db, gone, 'shell')
    violate(8, () => {}, set('DELETE FROM ptys WHERE id = ?', ghost))
  })

  it('U-DB-2 · deleting a project cascades to its sessions, their runtime and ui rows, PTYs and events (invariant 5)', () => {
    const db = memory()
    const p = project(db)
    const keep = project(db)
    const s = session(db, p, { lifecycle: 'live', end_reason: null, port_base: L.portRangeStart })
    pty(db, s)
    db.tx(() => db.run("INSERT INTO status_events (session_id, at, source, event, phase_after) VALUES (?, 0, 'hook', 'x', 'idle')", s))
    const k = session(db, keep)
    db.tx(() => db.run('DELETE FROM projects WHERE id = ?', p))
    for (const t of ['sessions', 'session_runtime', 'session_ui', 'ptys', 'status_events']) {
      const col = t === 'sessions' ? 'id' : 'session_id'
      expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t} WHERE ${col} = ?`, s)!.n, t).toBe(0)
    }
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE port_base IS NOT NULL')!.n, 'its port block is free again').toBe(0)
    expect(db.get<{ id: string }>('SELECT id FROM sessions')!.id).toBe(k)
    expect(checkInvariants(db)).toEqual([])
  })
})

describe('write batching', () => {
  const ev = (i: number): StatusEvent => ({ at: T0 + i, source: 'hook', event: `e${i}`, summary: null, phaseAfter: 'working' })
  const events = (db: KeaDb, s: string) => db.all<{ event: string }>('SELECT event FROM status_events WHERE session_id = ? ORDER BY id', s).map((r) => r.event)

  it('U-DB-4 · the status writes of one tick commit in one transaction; status_events is trimmed in that batch, for the sessions it touched only', () => {
    vi.useFakeTimers()
    const db = memory()
    const p = project(db)
    const [a, b, c] = [session(db, p, { lifecycle: 'live', end_reason: null }), session(db, p, { lifecycle: 'live', end_reason: null }), session(db, p, { lifecycle: 'live', end_reason: null })]
    for (const s of [a, b, c]) pty(db, s)
    // c holds more than the cap from before (written straight, as an older build might have)
    db.tx(() => {
      for (let i = 0; i < L.statusEventsPerSession + 20; i++) db.run("INSERT INTO status_events (session_id, at, source, event, phase_after) VALUES (?, ?, 'hook', ?, 'idle')", c, i, `old${i}`)
    })
    const committed: string[][] = []
    const batch = new StatusBatch(db, { onCommit: (s) => committed.push(s) })
    cleanup.push(() => batch.dispose())

    const writesBefore = db.writes
    for (let i = 0; i < L.statusEventsPerSession + 5; i++) batch.queue({ sessionId: a, runtime: { phase: 'working', lastActivityAt: T0 + i }, events: [ev(i)] })
    batch.queue({ sessionId: b, runtime: { phase: 'blocked', attention: '[{"kind":"permission"}]' } })
    batch.queue({ sessionId: b, runtime: { unread: true } })
    batch.queue({ sessionId: '01K0000000000000000000GONE', runtime: { phase: 'ready' }, events: [ev(1)] }) // deleted meanwhile
    expect(db.writes, 'nothing is written before the tick').toBe(writesBefore)
    expect(batch.pending).toBeGreaterThan(0)

    vi.advanceTimersByTime(L.storeTickMs)
    expect(db.writes - writesBefore, 'one transaction for the whole tick').toBe(1)
    expect(batch.commits).toBe(1)
    expect(committed).toEqual([[a, b]])
    expect(batch.pending).toBe(0)

    const ea = events(db, a)
    expect(ea.length).toBe(L.statusEventsPerSession)
    expect(ea[0]).toBe('e5')
    expect(ea.at(-1)).toBe(`e${L.statusEventsPerSession + 4}`)
    expect(events(db, c).length, 'an untouched session is not trimmed').toBe(L.statusEventsPerSession + 20)
    const rb = db.get<{ phase: string; attention: string; unread: number }>('SELECT phase, attention, unread FROM session_runtime WHERE session_id = ?', b)
    expect(rb, 'runtime fields merge latest-wins per field').toEqual({ phase: 'blocked', attention: '[{"kind":"permission"}]', unread: 1 })
    expect(db.get<{ phase: string; last_activity_at: number }>('SELECT phase, last_activity_at FROM session_runtime WHERE session_id = ?', a)).toEqual({ phase: 'working', last_activity_at: T0 + L.statusEventsPerSession + 4 })

    // the next tick touches c: trimmed then, in that batch
    const statements = db.stats.statements
    batch.queue({ sessionId: c, events: [ev(9)] })
    vi.advanceTimersByTime(L.storeTickMs)
    expect(events(db, c).length).toBe(L.statusEventsPerSession)
    expect(events(db, c).at(-1)).toBe('e9')
    expect(db.stats.statements, 'statements are prepared once').toBe(statements)
  })

  it('U-DB-4 · a batch that fails is rolled back whole', () => {
    vi.useFakeTimers()
    const db = memory()
    const p = project(db)
    const a = session(db, p, { lifecycle: 'live', end_reason: null })
    pty(db, a)
    const errors: unknown[] = []
    const batch = new StatusBatch(db, { onError: (e) => errors.push(e) })
    cleanup.push(() => batch.dispose())
    batch.queue({ sessionId: a, runtime: { phase: 'working' }, events: [ev(1)] })
    batch.queue({ sessionId: a, runtime: { phase: 'nonsense' as never } })
    batch.flush()
    expect(errors.length).toBe(1)
    expect(events(db, a)).toEqual([])
    expect(db.get<{ phase: string }>('SELECT phase FROM session_runtime WHERE session_id = ?', a)!.phase).toBe('idle')
  })
})

describe('opening kea.db', () => {
  it('U-DB-5 · pragmas on open; integrity check only after an unclean shutdown, where a failing one sets the file aside; an unreadable file is set aside and a fresh one created', () => {
    const dir = tempDir()
    const file = path.join(dir, 'kea.db')
    const first = openDatabase({ file, log: log() })
    expect(first).toMatchObject({ fresh: true, setAside: null, integrityChecked: false, fromVersion: 0 })
    const db = first.db
    expect(db.pragma('journal_mode')).toBe('wal')
    expect(db.pragma('synchronous')).toBe(1) // NORMAL
    expect(db.pragma('foreign_keys')).toBe(1)
    expect(db.pragma('busy_timeout')).toBe(L.dbBusyTimeoutMs)
    expect(db.pragma('cache_size')).toBe(-L.dbCacheKib)
    expect(db.pragma('journal_size_limit')).toBe(L.dbJournalSizeLimitBytes)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(kvGet(db, OPEN_KEY)).toBeDefined()
    kvSet(db, 'window.bounds', '{}')
    db.close()

    const clean = openDatabase({ file, log: log() })
    expect(clean).toMatchObject({ fresh: false, setAside: null, integrityChecked: false })
    expect(kvGet(clean.db, 'window.bounds')).toBe('{}')
    clean.db.abandon() // a crash: the open marker stays

    const unclean = openDatabase({ file, log: log() })
    expect(unclean).toMatchObject({ fresh: false, setAside: null, integrityChecked: true })
    unclean.db.close()

    // an index that no longer matches its table: quick_check (every open) passes it; the full integrity_check after an
    // unclean shutdown finds it and the file is set aside
    const tamper = new Database(file)
    // the shipped typings lack it; it lifts SQLite's defensive mode so the schema can be written
    ;(tamper as unknown as { unsafeMode(on: boolean): void }).unsafeMode(true)
    tamper.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX probe_v ON probe(v)')
    for (let i = 0; i < 20; i++) tamper.prepare('INSERT INTO probe (v) VALUES (?)').run(`v${i}`)
    tamper.pragma('writable_schema = ON')
    tamper.exec(`UPDATE sqlite_master SET sql = 'CREATE INDEX probe_v ON probe(id)' WHERE name = 'probe_v'`)
    tamper.pragma('writable_schema = OFF')
    tamper.close()
    const quick = openDatabase({ file, log: log() })
    expect(quick).toMatchObject({ fresh: false, setAside: null, integrityChecked: false })
    quick.db.abandon()
    const checked = openDatabase({ file, log: log() })
    expect(checked).toMatchObject({ fresh: true, setAside: { path: `${file}.corrupt`, reason: expect.stringMatching(/^integrity_check after an unclean shutdown: .*probe_v/) } })
    checked.db.close()

    // garbage: set aside (with its -wal and -shm), fresh database, rebuild asked for
    fs.writeFileSync(file, 'this is not a database'.repeat(400))
    fs.writeFileSync(`${file}-wal`, 'junk')
    const l = log()
    const after = openDatabase({ file, log: l })
    expect(after.fresh).toBe(true)
    expect(after.setAside?.path).toBe(`${file}.corrupt`)
    expect(fs.readFileSync(`${file}.corrupt`, 'utf8')).toMatch(/^this is not a database/)
    expect(fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`, 'utf8') : '', 'no stale WAL beside the fresh file').not.toBe('junk')
    expect(after.db.pragma('user_version')).toBe(SCHEMA_VERSION)
    expect(l.entries.some((e) => e.level === 'error' && /set aside/.test(e.msg))).toBe(true)
    after.db.close()

    // a schema from a newer build is not this build's to read
    const raw = openDatabase({ file, log: log() })
    raw.db.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    raw.db.close()
    const older = openDatabase({ file, log: log() })
    expect(older.setAside?.reason).toMatch(/newer/)
    expect(older.fresh).toBe(true)
    older.db.close()
  })

  it('U-DB-5 · the WAL is checkpointed with TRUNCATE above its limit and after the idle delay', () => {
    vi.useFakeTimers()
    const dir = tempDir()
    const { db } = openDatabase({ file: path.join(dir, 'kea.db'), log: log() })
    cleanup.push(() => db.close())
    const p = project(db)
    expect(db.walBytes()).toBeGreaterThan(0)
    const before = db.checkpoints
    vi.advanceTimersByTime(L.dbIdleCheckpointMs)
    expect(db.checkpoints).toBe(before + 1)
    expect(db.walBytes()).toBe(0)

    // SQLite's own (passive) checkpoints keep reusing a WAL of about 4 MB; one transaction larger than the limit grows it
    const big = 'x'.repeat(64 * 1024)
    db.tx(() => {
      for (let i = 0; i * big.length <= L.dbWalTruncateBytes; i++) db.run('INSERT INTO kv (key, value) VALUES (?, ?)', `k${i}`, big)
    })
    expect(db.checkpoints, 'checkpointed once the WAL passed its limit').toBe(before + 2)
    expect(db.walBytes()).toBeLessThanOrEqual(L.dbWalTruncateBytes)
    expect(db.get<{ id: string }>('SELECT id FROM projects')!.id).toBe(p)
  })
})
