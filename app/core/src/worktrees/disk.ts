// Disk usage: what each session's worktree takes on disk, its rebuildable folders, and the pruning of archived
// sessions. The `disk` store (protocol disk.ts) holds one row per session that has a worktree of its own on disk;
// Settings › Disk is its reader.
//
// Measuring. A size is a walk of the worktree on a worker thread (disk-walk.ts, in the finder worker's
// bundle: an instance of its own, started for the first walk waiting and ended with the last), one walk at a time. It
// is taken:
//   - once when a session is archived;
//   - when the Disk view asks (`disk.measure`: what was never measured or is older than L.diskMeasureIntervalMs; its
//     Refresh: all);
//   - after build folders were removed;
//   - by the schedule (disk-schedule.ts), at most once per L.diskMeasureIntervalMs for a session that is live and was
//     active, or was shown, since it was measured; only while a window is open, and never within
//     L.diskMeasureIntervalMs of core's start.
// The size goes to the session's row (`disk_bytes`, `disk_at`), and is cleared when the worktree goes (a worktree made
// again in its place, by Restore or Re-create worktree, is another folder: not measured until walked); the rebuildable
// share, whether the walk was capped, when a window last showed the session (written each time it leaves the screen)
// and when its build folders were removed go to one `kv` row, `disk:<sessionId>`.
//
// The schedule is one timer for everything: armed only while something is due at a known time (a measurement, while a
// window is open; an archived session's prune), at most L.diskMeasureIntervalMs ahead, and it never keeps core
// alive. With no window and no prune pending there is no timer at all.
//
// Removing. "Remove build folders" and the prune move a session's rebuildable folders (backup.ts: the project's
// patterns, and git-ignored; git is asked at that moment) into its worktree root's trash, in the session's own turn
// (never while it is being archived, deleted or set up), and the trash entry is deleted in the background: that trash
// is Kea's own holding folder, not the system's Trash, and nothing comes back from it. A folder that holds a git
// repository of its own (a `.git` entry at any depth) is never one of them: each folder is looked through on the walk's
// thread right before it would go, and one that holds a repository, or could not be looked through, stays. Folders
// removed while the session is archived are noted, so that unarchiving runs setup again.

import fs from 'node:fs'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import { CrossDeviceError, emptyTrashEntry, gitText, moveToTrash, type Logger } from '@kea/kit'
import { DISK_STORE, KeyedStore, L, PRUNE_MARK, RpcError, type BuildFoldersFound, type BuildFoldersRemoved, type DiskBranch, type diskApi, type DiskUsage, type Handlers, type KeptFolder, type Project, type SessionView } from '@kea/protocol'
import { startFinderWorker } from '../files/finder.ts'
import type { FromWorker, ToWorker } from '../files/finder-worker.ts'
import { kvDelete, kvGet, kvSet, type KeaDb } from '../platform/db/db.ts'
import type { VisibleSet } from '../platform/visible.ts'
import { rebuildableDirs } from './backup.ts'
import { measureDueAt, pruneDueAt, tickDelay } from './disk-schedule.ts'
import type { DiskWalkRequest, DiskWalkResult, GitScanRequest, GitScanResult } from './disk-walk.ts'
import { appendLog } from './log.ts'
import { branchFacts, WORKTREE_TRASH } from './ops.ts'

type Env = Record<string, string | undefined>

// ── the walk's thread ──────────────────────────────────────────────────────────────────────────────

/** What walks a worktree (the worker thread; a test passes its own). One piece of work at a time. */
export interface DiskWalker {
  /** The walk's result, or null when it could not be done (the thread failed, or was ended past the cap). */
  walk(req: DiskWalkRequest): Promise<DiskWalkResult | null>
  /** Whether a build folder holds a git repository, looked at now; null when it could not be said (as `walk`). */
  holdsGit(req: GitScanRequest): Promise<GitScanResult | null>
  /** Nothing is waiting: let the thread go. */
  release(): void
  /** Threads alive (0 or 1). */
  readonly workers: number
  dispose(): void
}

interface WalkerJob {
  what: string
  timeoutMs: number
  msg(id: number): ToWorker
  done(r: DiskWalkResult | GitScanResult | null): void
}

/**
 * The walk on a worker thread of its own, and the git look into a build folder on the same thread: one at a
 * time, in the order asked. Each caps itself (the walk's cap); a thread stuck past that is ended.
 */
export class WorkerWalker implements DiskWalker {
  private worker: Worker | null = null
  private current: { id: number; done: WalkerJob['done'] } | null = null
  // bounded: what waits for the thread: ≤ 1 size walk (the service runs one at a time) and 1 look per removal under
  // way (a removal is in its session's own turn: ≤ one per session)
  private readonly waiting: WalkerJob[] = []
  private guard: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private disposed = false
  private readonly log: Logger

  constructor(log: Logger) {
    this.log = log
  }

  get workers(): number {
    return this.worker ? 1 : 0
  }

  walk(req: DiskWalkRequest): Promise<DiskWalkResult | null> {
    return this.run<DiskWalkResult>('size walk', req.timeoutMs, (id) => ({ t: 'disk', id, walk: req }))
  }

  holdsGit(req: GitScanRequest): Promise<GitScanResult | null> {
    return this.run<GitScanResult>('look for a git repository', req.timeoutMs, (id) => ({ t: 'git', id, scan: req }))
  }

  private run<T extends DiskWalkResult | GitScanResult>(what: string, timeoutMs: number, msg: (id: number) => ToWorker): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.waiting.push({ what, timeoutMs, msg, done: resolve as WalkerJob['done'] })
      this.next()
    })
  }

  private next(): void {
    if (this.current || this.disposed) return
    const job = this.waiting.shift()
    if (!job) return
    const w = this.ensure()
    const id = this.nextId++
    this.current = { id, done: job.done }
    // the work stops itself at its cap; a thread that has not answered a grace later is stuck in a system call
    this.guard = setTimeout(() => {
      this.log.warn(`${job.what} did not end at its cap: its thread is ended`, { capMs: job.timeoutMs })
      // the thread first: what waits next gets a new one
      this.stop()
      this.end(null)
    }, job.timeoutMs + L.processKillGraceMs)
    this.guard.unref()
    w.postMessage(job.msg(id))
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    // no index is built in this instance
    const w = startFinderWorker({ maxPaths: 0 })
    w.unref() // it never keeps core alive
    // a thread let go earlier may still report its end: only the current one's events count
    w.on('message', (m: FromWorker) => {
      if (this.worker !== w || this.current?.id !== (m as { id?: number }).id) return
      if (m.t === 'disk') this.end(m.size)
      else if (m.t === 'git') this.end(m.found)
    })
    w.on('error', (e) => {
      this.log.warn('size walk thread failed', { error: String(e) })
      if (this.worker !== w) return
      this.worker = null
      this.end(null)
    })
    w.on('exit', () => {
      if (this.worker !== w) return
      this.worker = null
      this.end(null)
    })
    this.worker = w
    return w
  }

  /** The work under way is over (null: it could not be done); what waits next starts. */
  private end(r: DiskWalkResult | GitScanResult | null): void {
    if (this.guard) clearTimeout(this.guard)
    this.guard = null
    const c = this.current
    this.current = null
    c?.done(r)
    this.next()
  }

  private stop(): void {
    const w = this.worker
    this.worker = null
    void w?.terminate()
  }

  release(): void {
    if (!this.current && this.waiting.length === 0) this.stop()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    for (const j of this.waiting.splice(0)) j.done(null)
    this.end(null)
  }
}

// ── what is kept of a session besides its size ─────────────────────────────────────────────────────

/** The `kv` row `disk:<sessionId>`. */
export interface DiskMark {
  /** The part of the size inside rebuildable folders; null: not known (never measured, or git could not say). */
  rebuildableBytes: number | null
  /** The last walk was cancelled at the cap. */
  capped: boolean
  /** When a window last showed the session. */
  viewedAt: number | null
  /** When its build folders were last removed while it was archived: unarchive runs setup again. */
  prunedAt: number | null
}

const NO_MARK: DiskMark = { rebuildableBytes: null, capped: false, viewedAt: null, prunedAt: null }

/** Where a session's worktree is, as its row says. */
export interface DiskPlace {
  cwd: string
  worktreeRoot: string | null
  /** A pipeline step is under way, or auto-clean removed the worktree. */
  busy: boolean
}

/** What the service keeps outside the `sessions` store (the database; a test keeps it in memory). */
export interface DiskRecords {
  mark(id: string): DiskMark | null
  setMark(id: string, m: DiskMark): void
  dropMark(id: string): void
  /** `disk_bytes`, `disk_at`. */
  measured(id: string, bytes: number, at: number): void
  /** The worktree went: its size is not the session's any more (`disk_bytes`, `disk_at` null). */
  unmeasured(id: string): void
  place(id: string): DiskPlace | null
  /** Marks of sessions that are gone: removed. */
  sweep(): void
}

const KV = 'disk:'
const SQL_MEASURED = 'UPDATE sessions SET disk_bytes = ?, disk_at = ? WHERE id = ?'
const SQL_UNMEASURED = 'UPDATE sessions SET disk_bytes = NULL, disk_at = NULL WHERE id = ? AND disk_at IS NOT NULL'
const SQL_PLACE = 'SELECT cwd, worktree_root, creation_step FROM sessions WHERE id = ?'
const SQL_SWEEP = `DELETE FROM kv WHERE key LIKE '${KV}%' AND substr(key, ${KV.length + 1}) NOT IN (SELECT id FROM sessions WHERE lifecycle != 'deleted')`

export function dbRecords(db: KeaDb): DiskRecords {
  return {
    mark(id) {
      const raw = kvGet(db, KV + id)
      if (!raw) return null
      try {
        const m = JSON.parse(raw) as Partial<DiskMark>
        const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null)
        return { rebuildableBytes: num(m.rebuildableBytes), capped: m.capped === true, viewedAt: num(m.viewedAt), prunedAt: num(m.prunedAt) }
      } catch {
        return null
      }
    },
    setMark: (id, m) => kvSet(db, KV + id, JSON.stringify(m)),
    dropMark: (id) => kvDelete(db, KV + id),
    measured: (id, bytes, at) => void db.tx(() => db.run(SQL_MEASURED, bytes, at, id)),
    unmeasured: (id) => void db.tx(() => db.run(SQL_UNMEASURED, id)),
    place(id) {
      const r = db.get<{ cwd: string; worktree_root: string | null; creation_step: string | null }>(SQL_PLACE, id)
      return r ? { cwd: r.cwd, worktreeRoot: r.worktree_root, busy: r.creation_step !== null } : null
    },
    sweep() {
      // every statement of this file is prepared here, at the service's start, so `core.db`'s count of statements does
      // not move when the first walk or the first removal comes
      for (const sql of [SQL_MEASURED, SQL_UNMEASURED, SQL_PLACE]) db.stmt(sql)
      kvGet(db, KV)
      db.tx(() => {
        db.run(SQL_SWEEP)
        kvSet(db, KV, '')
        kvDelete(db, KV)
      })
    },
  }
}

// ── the service ────────────────────────────────────────────────────────────────────────────────────

export interface DiskOptions {
  home: string
  log: Logger
  records: DiskRecords
  sessions: {
    readonly store: KeyedStore<SessionView>
    /** Re-read a session's row into the store (its size changed). */
    refresh(id: string): unknown
    /** Run `fn` in the session's own turn: after its earlier calls, before its later ones. */
    exclusive<T>(id: string, fn: () => Promise<T>): Promise<T>
    /** The session's setup script is running: its build folders are being made. */
    settingUp(id: string): boolean
  }
  projects: { get(id: string): Pick<Project, 'settings' | 'isGit'> | undefined }
  /** `general.pruneArchivedBuildDirsDays` (0: never). */
  pruneDays(): number
  /** Told when the settings change. */
  onSettings?(cb: () => void): () => void
  visible: Pick<VisibleSet, 'onChange' | 'has' | 'sessions'>
  /** Git's environment (the login shell's). */
  env(): Promise<Env>
  now?: () => number
  /** Default: the worker thread. */
  walker?: DiskWalker
  /** The walk's cap (a test shortens it to another constant). */
  walkTimeoutMs?: number
  /**
   * Told when a removal made the worktree root's `.kea-trash`: core then keeps it out of backups (Time Machine, on
   * macOS).
   */
  folderMade?: (dir: string) => void
}

const HAS_WORKTREE = new Set<string>(['live', 'detached', 'archived'])
const wants = (v: SessionView): boolean => v.isolation === 'worktree' && HAS_WORKTREE.has(v.lifecycle) && !v.worktreeMissing

export class DiskService {
  // bounded: one row per session with a worktree on disk (≤ the `sessions` store)
  readonly store = new KeyedStore<DiskUsage>(DISK_STORE)
  // bounded: one per row of `store`, dropped with it
  private readonly marks = new Map<string, DiskMark>()
  // bounded: one per row of `store` (its session's lifecycle as last seen: an archive is a change of it)
  private readonly life = new Map<string, string>()
  // bounded: ⊆ the rows of `store`: a walk or a prune that failed, until its next try
  private readonly retryAt = new Map<string, number>()
  // bounded: ≤ one entry per row of `store` (a session waits once)
  private readonly queue: string[] = []
  // bounded: ⊆ the rows of `store`: sessions to measure again once their walk in flight ends
  private readonly again = new Set<string>()
  // bounded: one per trash entry being deleted or prune under way; each ends by itself
  private readonly work = new Set<Promise<unknown>>()
  private walking: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt = Infinity
  private windows = 0
  private started = false
  private disposed = false
  private readonly since: number
  private readonly now: () => number
  private readonly walker: DiskWalker
  private readonly o: DiskOptions
  private offs: (() => void)[] = []

  constructor(o: DiskOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.since = this.now()
    this.walker = o.walker ?? new WorkerWalker(o.log)
  }

  /**
   * Begin following the sessions (core calls it once its launch work is done, so none of this is on the way to the
   * first window): a row for every session with a worktree, the marks of sessions that are gone removed, the timer
   * armed if something is due.
   */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    const { sessions, visible } = this.o
    this.offs.push(
      sessions.store.onDelta((d) => {
        for (const id of d.del ?? []) this.forget(id)
        let changed = (d.del?.length ?? 0) > 0
        for (const v of Object.values(d.set ?? {})) changed = this.sync(v) || changed
        if (changed) this.schedule()
      }),
    )
    const off = visible.onChange((c) => {
      for (const id of c.shown) this.put(id, { visible: true })
      for (const id of c.hidden) this.viewed(id)
      if (c.shown.length || c.hidden.length) this.schedule()
    })
    this.offs.push(() => off.dispose())
    if (this.o.onSettings) this.offs.push(this.o.onSettings(() => this.schedule()))
    try {
      this.o.records.sweep()
    } catch (e) {
      this.o.log.warn('disk marks not swept', { error: String(e) })
    }
    for (const v of sessions.store.values()) this.sync(v)
    this.schedule()
  }

  /** A window connected (+1) or went (−1): the schedule measures only while one is open. */
  window(delta: 1 | -1): void {
    this.windows = Math.max(0, this.windows + delta)
    this.schedule()
  }

  // ── rows ─────────────────────────────────────────────────────────────────────────────────────

  private put(id: string, patch: Partial<DiskUsage>): void {
    const cur = this.store.get(id)
    if (!cur) return
    const next = { ...cur, ...patch }
    for (const k of Object.keys(patch) as (keyof DiskUsage)[]) {
      if (cur[k] !== next[k]) {
        this.store.set(id, next)
        return
      }
    }
  }

  /** The session left the screen: last seen now, written at once (the Stale mark reads it after a relaunch). */
  private viewed(id: string): void {
    const m = this.marks.get(id)
    if (!m) return
    m.viewedAt = this.now()
    this.saveMark(id)
    this.put(id, { visible: false, viewedAt: m.viewedAt })
  }

  private saveMark(id: string): void {
    const m = this.marks.get(id)
    if (!m) return
    try {
      this.o.records.setMark(id, m)
    } catch (e) {
      this.o.log.warn('disk mark not written', { sessionId: id, error: String(e) })
    }
  }

  /** Follow one session's row; true when what the schedule reads of it changed. */
  private sync(v: SessionView): boolean {
    const id = v.id
    const row = this.store.get(id)
    if (!wants(v)) {
      if (row) this.forget(id, HAS_WORKTREE.has(v.lifecycle))
      return row !== undefined
    }
    if (!row) {
      // a session whose worktree is not there (auto-clean removed it) has nothing to weigh
      if (!fs.existsSync(v.cwd)) return false
      const mark = { ...(this.o.records.mark(id) ?? NO_MARK) }
      this.marks.set(id, mark)
      this.life.set(id, v.lifecycle)
      // a worktree not measured (a new one, or one made again where another was) has no share and no cap to show
      if (v.diskAt === null) {
        mark.rebuildableBytes = null
        mark.capped = false
      }
      this.store.set(id, { bytes: v.diskBytes, rebuildableBytes: mark.rebuildableBytes, capped: mark.capped, at: v.diskAt, measuring: false, visible: this.o.visible.has(id), viewedAt: mark.viewedAt })
      return true
    }
    const was = this.life.get(id)
    this.life.set(id, v.lifecycle)
    const changed = was !== v.lifecycle || row.at !== v.diskAt
    this.put(id, { bytes: v.diskBytes, at: v.diskAt })
    // Once on archive
    if (was !== undefined && was !== 'archived' && v.lifecycle === 'archived') this.enqueue(id)
    // an agent that worked since the measurement makes its session due; only that can arm a timer where none is
    return changed || (this.timer === null && v.lifecycle === 'live' && row.at !== null && v.lastActivityAt > row.at)
  }

  /**
   * The session has no worktree to weigh any more (deleted, or its folder went). `keepMark`: its session stays (the
   * folder went, or the project did), so when it was last shown and pruned still counts.
   *
   * A worktree that goes takes its size with it: one made again in its place (Restore, Re-create worktree) is
   * another folder, so the session is unmeasured until that one is walked. The sessions' own next read of the row
   * (every step that brings a worktree back makes one) carries that into its view.
   */
  private forget(id: string, keepMark = false): void {
    if (this.store.get(id)?.at != null) {
      try {
        this.o.records.unmeasured(id)
      } catch (e) {
        this.o.log.warn('size not cleared', { sessionId: id, error: String(e) })
      }
    }
    this.marks.delete(id)
    this.life.delete(id)
    this.retryAt.delete(id)
    this.again.delete(id)
    const at = this.queue.indexOf(id)
    if (at >= 0) this.queue.splice(at, 1)
    this.store.delete(id)
    if (!keepMark) {
      try {
        this.o.records.dropMark(id)
      } catch (e) {
        this.o.log.warn('disk mark not removed', { sessionId: id, error: String(e) })
      }
    }
  }

  /**
   * Every session with a worktree has its row, and no row is left for a worktree that went (auto-clean says nothing).
   */
  private reconcile(): void {
    for (const v of this.o.sessions.store.values()) {
      if (this.store.has(v.id) && !fs.existsSync(v.cwd)) this.forget(v.id, true)
      else this.sync(v)
    }
    for (const id of [...this.store.keys()]) if (!this.o.sessions.store.has(id)) this.forget(id)
  }

  // ── the schedule ─────────────────────────────────────────────────────────────────────────────

  private dueTimes(id: string): { measure: number; prune: number } {
    const v = this.o.sessions.store.get(id)
    const row = this.store.get(id)
    const mark = this.marks.get(id)
    if (!v || !row || !mark) return { measure: Infinity, prune: Infinity }
    const retry = this.retryAt.get(id) ?? 0
    return {
      measure: this.queue.includes(id) || this.walking === id ? Infinity : measureDueAt(v, row, this.since, retry),
      prune: pruneDueAt(v, mark.prunedAt, this.o.pruneDays(), retry),
    }
  }

  private schedule(): void {
    if (!this.started || this.disposed) return
    let next = Infinity
    for (const id of this.store.keys()) {
      const d = this.dueTimes(id)
      next = Math.min(next, d.prune, this.windows > 0 ? d.measure : Infinity)
    }
    const now = this.now()
    const delay = tickDelay(next, now)
    if (delay === null) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.timerAt = Infinity
      return
    }
    // an earlier tick is armed already: it looks again when it fires
    if (this.timer && this.timerAt <= now + delay) return
    if (this.timer) clearTimeout(this.timer)
    this.timerAt = now + delay
    this.timer = setTimeout(() => this.track(this.tick()), delay)
    this.timer.unref() // it never keeps core alive
  }

  /** The timer fired: measure what is due (while a window is open), prune what is due, arm the next. */
  async tick(): Promise<void> {
    this.timer = null
    this.timerAt = Infinity
    if (this.disposed) return
    this.reconcile()
    const now = this.now()
    const prunes: string[] = []
    for (const id of [...this.store.keys()]) {
      const d = this.dueTimes(id)
      if (d.prune <= now) prunes.push(id)
      else if (this.windows > 0 && d.measure <= now) this.enqueue(id)
    }
    for (const id of prunes) await this.prune(id)
    this.schedule()
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const t: Promise<unknown> = p.catch((e) => this.o.log.warn('disk work failed', { error: String(e) })).finally(() => this.work.delete(t))
    this.work.add(t)
    return p
  }

  // ── measuring ────────────────────────────────────────────────────────────────────────────────

  private enqueue(id: string): boolean {
    if (this.disposed || !this.store.has(id)) return false
    if (this.walking === id) {
      this.again.add(id)
      return true
    }
    if (this.queue.includes(id)) return false
    this.queue.push(id)
    this.put(id, { measuring: true })
    this.pump()
    return true
  }

  private pump(): void {
    if (this.walking !== null || this.disposed) return
    const id = this.queue.shift()
    if (id === undefined) {
      this.walker.release()
      return
    }
    this.walking = id
    this.track(
      this.measure(id).finally(() => {
        this.walking = null
        if (this.again.delete(id)) this.enqueue(id)
        this.pump()
        this.schedule()
      }),
    )
  }

  private async measure(id: string): Promise<void> {
    const v = this.o.sessions.store.get(id)
    if (!v || !wants(v) || !fs.existsSync(v.cwd)) {
      if (v) this.forget(id, true)
      return
    }
    // the rebuildable folders, so the same walk sums their share; where git cannot say, the share is not known
    let rebuildable: string[] | null = null
    try {
      const p = this.o.projects.get(v.projectId)
      if (p?.isGit) rebuildable = await rebuildableDirs(v.cwd, p.settings.rebuildableDirs, await this.o.env())
    } catch (e) {
      this.o.log.info('rebuildable folders not known for a size walk', { sessionId: id, error: String(e) })
    }
    const r = this.disposed ? null : await this.walker.walk({ root: v.cwd, rebuildable: rebuildable ?? [], timeoutMs: this.o.walkTimeoutMs ?? L.diskWalkTimeoutMs })
    if (this.disposed || !this.store.has(id)) return
    const now = this.now()
    if (!r) {
      this.retryAt.set(id, now + L.diskMeasureIntervalMs)
      this.put(id, { measuring: false })
      return
    }
    this.retryAt.delete(id)
    const mark = this.marks.get(id) ?? { ...NO_MARK }
    mark.rebuildableBytes = rebuildable ? r.rebuildableBytes : null
    mark.capped = r.capped
    this.marks.set(id, mark)
    this.saveMark(id)
    if (r.capped) this.o.log.info('size walk cancelled at its cap', { sessionId: id, entries: r.entries, ms: Math.round(r.ms) })
    try {
      this.o.records.measured(id, r.bytes, now)
      // the row's size and time come back through the sessions store
      this.o.sessions.refresh(id)
    } catch (e) {
      this.o.log.warn('size not written', { sessionId: id, error: String(e) })
    }
    this.put(id, { bytes: r.bytes, at: now, rebuildableBytes: mark.rebuildableBytes, capped: mark.capped, measuring: false })
  }

  /** `disk.measure`: what was never measured or is older than L.diskMeasureIntervalMs; `all`: every worktree. */
  measureStale(all: boolean): number {
    this.start()
    this.reconcile()
    const now = this.now()
    let n = 0
    for (const [id, row] of [...this.store.entries()]) {
      if (!all && row.at !== null && now - row.at < L.diskMeasureIntervalMs) continue
      if (this.enqueue(id)) n++
    }
    return n
  }

  // ── the branch state of a row ────────────────────────────────────────────────────────────────

  async branch(id: string): Promise<DiskBranch | null> {
    const v = this.o.sessions.store.get(id)
    if (!v || !wants(v) || !this.o.projects.get(v.projectId)?.isGit || !fs.existsSync(v.cwd)) return null
    try {
      const env = await this.o.env()
      const base = v.baseBranch ?? v.baseCommit
      const f = await branchFacts({ env }, v.cwd, base)
      // "unpushed" is the branch's own work: the commits it adds to its base that no remote-tracking ref holds. All of
      // HEAD's (the count auto-clean uses) would call the whole history unpushed on every row of a repository
      // with no remote. A base that no longer resolves says nothing about what the branch adds: then HEAD's count
      // stands.
      let unpushed = f.unpushedCommits
      if (unpushed > 0 && base && f.baseResolved) {
        const own = f.uniqueCommits === 0 ? 0 : Number((await gitText(['rev-list', '--count', `${base}..HEAD`, '--not', '--remotes'], { cwd: v.cwd, readOnly: true, env })).trim())
        if (Number.isInteger(own)) unpushed = own
      }
      return { uncommittedFiles: f.uncommittedFiles, unpushedCommits: unpushed, commits: f.uniqueCommits, merged: f.baseResolved && f.merged }
    } catch (e) {
      this.o.log.info('branch state not read', { sessionId: id, error: String(e) })
      return null
    }
  }

  // ── removing ─────────────────────────────────────────────────────────────────────────────────

  /** "Remove build folders", in the session's own turn. */
  removeBuildFolders(id: string): Promise<BuildFoldersRemoved> {
    return this.o.sessions.exclusive(id, () => this.remove(id, 'Remove build folders'))
  }

  /** The session's rebuildable folders as git names them now, and where they are. Throws when none may be removed. */
  private async rebuildable(id: string): Promise<{ v: SessionView; cwd: string; trash: string; dirs: string[] }> {
    const v = this.o.sessions.store.get(id)
    const place = this.o.records.place(id)
    if (!v || !place) throw new RpcError('not_found', `no session ${id}`)
    if (v.isolation !== 'worktree' || !HAS_WORKTREE.has(v.lifecycle)) throw new RpcError('wrong_state', `the session is ${v.lifecycle} and has no worktree of its own`)
    if (place.busy || !place.worktreeRoot || !fs.existsSync(place.cwd)) throw new RpcError('wrong_state', 'its worktree is not on disk, or is being worked on')
    // Never while it is being set up (a pipeline step is `busy` above; setup after an unarchive or a restore, or
    // run again by hand, is a script in the session's Setup tab)
    if (this.o.sessions.settingUp(id)) throw new RpcError('wrong_state', 'setup is running in this session and is making its build folders: wait until it has ended')
    const p = this.o.projects.get(v.projectId)
    if (!p?.isGit) throw new RpcError('wrong_state', 'not a git project: nothing says which folders can be rebuilt')
    try {
      return { v, cwd: place.cwd, trash: path.join(place.worktreeRoot, WORKTREE_TRASH), dirs: await rebuildableDirs(place.cwd, p.settings.rebuildableDirs, await this.o.env()) }
    } catch (e) {
      // without git's answer nothing is known to be ignored: nothing is removed
      throw new RpcError('git_failed', `git could not say which folders are ignored: ${String(e)}`)
    }
  }

  /** The time a removal's looks have left, all its folders together: the walk's cap from now. */
  private lookBudget(): () => number {
    const cap = this.o.walkTimeoutMs ?? L.diskWalkTimeoutMs
    const t0 = performance.now()
    return () => Math.max(0, cap - (performance.now() - t0))
  }

  /**
   * Why a build folder stays where it is, looked at now, on the walk's thread: it holds a git repository of its
   * own (a `.git` entry at any depth: a clone, a submodule, a linked worktree, with work that may exist nowhere else), or
   * it could not be looked through (the cap, a folder that cannot be read, another volume in it; the thread failed) and
   * so may hold one. Null: it holds none.
   */
  private async keeps(abs: string, left: () => number): Promise<KeptFolder['reason'] | null> {
    const r = this.disposed ? null : await this.walker.holdsGit({ dir: abs, timeoutMs: left() })
    if (!r) return 'unchecked'
    return r.git !== null ? 'git' : r.unchecked !== null ? 'unchecked' : null
  }

  /** Nothing waits for the walk's thread: it goes. */
  private letGo(): void {
    if (this.walking === null && this.queue.length === 0) this.walker.release()
  }

  /**
   * What a removal would take from the session now and what it would keep (the confirmation's answer). Nothing
   * is changed, and the removal that may follow asks git and looks through each folder again.
   */
  async buildFolders(id: string): Promise<BuildFoldersFound> {
    const { cwd, dirs } = await this.rebuildable(id)
    const folders: string[] = []
    const kept: KeptFolder[] = []
    const left = this.lookBudget()
    for (const rel of dirs) {
      const abs = path.join(cwd, rel)
      try {
        if (!fs.lstatSync(abs).isDirectory()) continue
      } catch {
        continue
      }
      const reason = await this.keeps(abs, left)
      if (reason) kept.push({ path: rel, reason })
      else folders.push(rel)
    }
    this.letGo()
    return { folders, kept, bytes: this.marks.get(id)?.rebuildableBytes ?? null }
  }

  private async remove(id: string, why: string): Promise<BuildFoldersRemoved> {
    const { v, cwd, trash, dirs } = await this.rebuildable(id)
    const removed: string[] = []
    const kept: KeptFolder[] = []
    const left = this.lookBudget()
    for (const rel of dirs) {
      const abs = path.join(cwd, rel)
      try {
        // as it is now: only a real folder goes (a link put there since git answered is never followed or moved)
        if (!fs.lstatSync(abs).isDirectory()) continue
        // and only one that holds no git repository, looked at right before it would go
        const reason = await this.keeps(abs, left)
        if (reason) {
          kept.push({ path: rel, reason })
          continue
        }
        const moved = await moveToTrash(abs, trash, { made: (dir) => this.o.folderMade?.(dir) })
        removed.push(rel)
        this.track(emptyTrashEntry(moved))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        this.o.log.warn('build folder not removed', { sessionId: id, error: e instanceof CrossDeviceError ? 'it is on another volume than the worktree root' : String(e) })
      }
    }
    const mark = this.marks.get(id)
    const bytes = mark?.rebuildableBytes ?? null
    const now = this.now()
    if (mark && v.lifecycle === 'archived') {
      // Unarchive runs setup again; and the prune has nothing more to do for this archive
      mark.prunedAt = now
      this.saveMark(id)
    }
    const lines = [`${why}: ${removed.length ? removed.join(', ') : 'none found'}`]
    const holding = kept.filter((k) => k.reason === 'git').map((k) => k.path)
    const unchecked = kept.filter((k) => k.reason === 'unchecked').map((k) => k.path)
    if (holding.length) lines.push(`kept, it holds a git repository: ${holding.join(', ')}`)
    if (unchecked.length) lines.push(`kept, it could not be checked for a git repository: ${unchecked.join(', ')}`)
    try {
      appendLog(this.o.home, id, lines.join('\n'), now)
    } catch (e) {
      this.o.log.warn('session log not written', { sessionId: id, error: String(e) })
    }
    this.o.log.info('removed build folders', { sessionId: id, folders: removed.length, kept: kept.length, archived: v.lifecycle === 'archived' })
    if (!(removed.length && this.enqueue(id))) this.letGo()
    return { removed, kept, bytes }
  }

  /** The prune, for one session that is due, as it is in its own turn (an Unarchive queued first keeps its folders). */
  private async prune(id: string): Promise<void> {
    try {
      await this.o.sessions.exclusive(id, async () => {
        const v = this.o.sessions.store.get(id)
        const mark = this.marks.get(id)
        if (!v || !mark || pruneDueAt(v, mark.prunedAt, this.o.pruneDays()) > this.now()) return
        await this.remove(id, `archived for ${this.o.pruneDays()} days, ${PRUNE_MARK}`)
      })
      this.retryAt.delete(id)
    } catch (e) {
      // its worktree is gone or busy, or git cannot say: looked at again L.diskMeasureIntervalMs later, not at once
      this.retryAt.set(id, this.now() + L.diskMeasureIntervalMs)
      this.o.log.info('build folders not pruned', { sessionId: id, error: String(e) })
    }
  }

  /** The session's build folders were removed while it was archived, and setup has not run since. */
  pruned(id: string): boolean {
    const m = this.marks.get(id) ?? this.o.records.mark(id)
    return m?.prunedAt != null
  }

  /** Setup runs again (an unarchive): the note goes. */
  restored(id: string): void {
    const m = this.marks.get(id) ?? this.o.records.mark(id)
    if (!m || m.prunedAt === null) return
    m.prunedAt = null
    try {
      this.o.records.setMark(id, m)
    } catch (e) {
      this.o.log.warn('disk mark not written', { sessionId: id, error: String(e) })
    }
  }

  // ── the rest ─────────────────────────────────────────────────────────────────────────────────

  handlers(): Handlers<typeof diskApi> {
    return {
      'disk.measure': ({ all }) => ({ queued: this.measureStale(all === true) }),
      'disk.branch': async ({ id }) => ({ branch: await this.branch(id) }),
      'disk.removeBuildFolders': ({ id }) => this.removeBuildFolders(id),
      'disk.buildFolders': ({ id }) => this.buildFolders(id),
    }
  }

  /** Walks, prunes and trash deletions done (tests). */
  async idle(): Promise<void> {
    while (this.work.size) await Promise.all([...this.work])
  }

  /**
   * The `core.disk` gauge, levels all: rows of the store; sessions waiting for a walk;
   * a walk under way; the walk's thread; the timer; trash deletions, walks and prunes in flight; retries noted.
   */
  get resourceCounts(): { rows: number; queued: number; walking: number; workers: number; timers: number; work: number; retries: number } {
    return { rows: this.store.size, queued: this.queue.length, walking: this.walking === null ? 0 : 1, workers: this.walker.workers, timers: this.timer ? 1 : 0, work: this.work.size, retries: this.retryAt.size }
  }

  dispose(): void {
    if (this.disposed) return
    // what is on screen now was last seen now
    if (this.started) for (const id of this.o.visible.sessions()) this.viewed(id)
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const off of this.offs.splice(0)) off()
    this.queue.length = 0
    this.again.clear()
    this.walker.dispose()
    this.store.dispose()
  }
}
