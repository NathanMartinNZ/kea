// Files and git in core: the session-scoped stores `tree:<sessionId>` and `git:<sessionId>`, the file panel's calls
// (protocol files.ts `filesApi`), the refresh triggers and the git facts the rest of core asks for (facts.ts
// `GitFacts`).
//
// Which sessions hold anything:
//   visible            its two stores, registered inside the visible set's change listener (so a subscription that
//                      follows `visible.set` finds them), an active hold on the watch service, its caches
//   recently viewed    caches for the L.fileCacheSessions most recently shown sessions (the visible one included)
//   still watched      the watch service keeps L.watchWorktreesLru worktrees; a session whose worktree is one of
//                      them holds only that (events mark it stale)
//   every other        nothing in memory: its expanded folders, scope and panel state are in the database
//
// The UI state lives in `session_ui.state` under the key `files`, written with `json_set` so the rest of that row
// (other panels' state) is untouched.

import { Scope, type Disposable, type Logger } from '@kea/kit'
import { gitStoreName, isAvailable, KeyedStore, L, RpcError, treeStoreName, zDiffScope, type DiffScope, type filesApi, type GitEntry, type GitRow, type Handlers, type Project, type SessionView, type SimpleStoreRegistry, type TreeRow } from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import { kvDelete, kvGet, kvSet, type KeaDb } from '../platform/db/db.ts'
import type { VisibleSet } from '../platform/visible.ts'
import type { Watcher } from '../platform/watch/watcher.ts'
import type { GitFacts } from './facts.ts'
import { Fsmonitor, FSMONITOR_KEYS, type ExtensionRecord } from './fsmonitor.ts'
import { networkMount } from './mounts.ts'
import { SessionFiles, type PersistedFiles, type SessionTarget } from './session.ts'
import type { Env } from './status.ts'

export interface FilesOptions {
  log?: Logger | undefined
  db: KeaDb
  visible: VisibleSet
  /** The watch service when it is the real one; null when core runs on a stand-in (nothing is followed). */
  watcher: Watcher | null
  /** The environment git runs with (the login shell's). */
  env: () => Promise<Env>
  /** False: another `GitFacts` is core's (a test's stand-in): no status runs and no `git:` store is registered. */
  facts?: boolean
  /** `mount`'s output (tests). */
  mounts?: () => Promise<string>
  /** The timeout for each git call (tests shorten it; default L.gitStatusTimeoutMs). */
  statusTimeoutMs?: number
  /** How long the finder's index outlives its last query (tests shorten it; default L.finderDropMs). */
  finderDropMs?: number
  /** A status slower than this marks the session's git head `slow` (tests shorten it; default L.fsmonitorHintMs). */
  fsmonitorHintMs?: number
  /**
   * The tool that moves a file to the Trash for Discard Changes. Default: none, so a discard that would move a file is
   * refused and no test can reach the real Trash; the app's core passes the system's (main.ts).
   */
  trashTool?: string | null
}

export interface FilesBinding {
  sessions: KeyedStore<SessionView>
  projects: KeyedStore<Project>
  stores: SimpleStoreRegistry
  gitUsable: Promise<boolean>
  /** A session's folder became a repository (`git init` in its terminal): its project's root is looked at again. */
  repository?(sessionId: string): void
}

/** `kv` rows, one per repository whose `extensions.worktreeConfig` Kea turned on: `{ prior }`, by common dir. */
const EXTENSION_KEY = 'fsmonitor.extension:'

export class FilesService implements GitFacts, Disposable {
  private readonly o: FilesOptions
  private readonly timers = new Scope('files')
  private bound: FilesBinding | null = null
  // bounded: the visible sessions, plus L.fileCacheSessions with caches, plus L.watchWorktreesLru still watched (`trim`)
  private readonly sessions = new Map<string, SessionFiles>()
  /** Session ids, most recently shown first. */
  private recent: string[] = [] // bounded: the keys of `sessions`
  // bounded: one per consumer built with core (the viewer)
  private readonly listeners = new Set<(sessionId: string) => void>()
  private readonly subs: (() => void)[] = []
  private mountCache: { at: number; out: Promise<string> } | null = null
  private readonly fsmonitor: Fsmonitor
  // bounded: the sessions nothing is held for whose worktree the setting is being taken out of (one git sequence each)
  private readonly takingBack = new Set<string>()
  private disposed = false
  /** Sessions whose caches were dropped since start. */
  evictions = 0

  constructor(o: FilesOptions) {
    this.o = o
    this.fsmonitor = new Fsmonitor({ env: o.env, log: o.log, timeoutMs: o.statusTimeoutMs, record: this.extensionRecord() })
    const v = o.visible.onChange((c) => {
      for (const id of c.hidden) this.hide(id)
      for (const id of c.shown) this.show(id)
    })
    this.subs.push(() => v.dispose())
  }

  /** The stores and services built after this one (core.ts). */
  bind(b: FilesBinding): void {
    this.bound = b
    this.subs.push(
      b.sessions.onDelta((d) => {
        for (const id of d.del ?? []) this.drop(id)
        for (const [id, view] of Object.entries(d.set ?? {})) {
          const s = this.sessions.get(id)
          if (!s) continue
          // archive and delete release everything, the watch included
          if (view.lifecycle === 'archived' || view.lifecycle === 'deleted') {
            if (!s.visible) this.drop(id)
            continue
          }
          s.retarget(this.target(view))
        }
      }),
      b.projects.onDelta((d) => {
        // The fsmonitor setting is the project's
        for (const s of this.sessions.values()) {
          const view = b.sessions.get(s.id)
          if (view && Object.hasOwn(d.set ?? {}, view.projectId)) s.retarget(this.target(view))
        }
        this.fsmonitorOffElsewhere(Object.values(d.set ?? {}))
      }),
    )
    for (const id of this.o.visible.sessions()) this.show(id)
    // a setting turned off while Kea was not there to take it out of every worktree
    this.fsmonitorOffElsewhere([...b.projects.values()])
    // the fsmonitor hint needs to know whether git has its daemon before the first slow status
    if (this.o.facts !== false) void b.gitUsable.then((ok) => (ok && !this.disposed ? this.fsmonitor.supported() : false))
  }

  // ── fsmonitor beyond the sessions held ────────────────────────────────────────────────────────

  private extensionRecord(): ExtensionRecord {
    const db = this.o.db
    const usable = (): boolean => !this.disposed && db.isOpen
    return {
      any: () => usable() && db.get(`SELECT 1 FROM kv WHERE key LIKE '${EXTENSION_KEY}%' LIMIT 1`) !== undefined,
      get: (commonDir) => {
        if (!usable()) return null
        try {
          const v = JSON.parse(kvGet(db, EXTENSION_KEY + commonDir) ?? 'null') as { prior?: unknown } | null
          return v ? { prior: typeof v.prior === 'string' ? v.prior : null } : null
        } catch {
          return null
        }
      },
      set: (commonDir, r) => void (usable() && kvSet(db, EXTENSION_KEY + commonDir, JSON.stringify(r))),
      delete: (commonDir) => void (usable() && kvDelete(db, EXTENSION_KEY + commonDir)),
    }
  }

  /**
   * A setting that is off leaves every worktree of its project where Kea wrote it, also the worktrees of sessions
   * nothing is held for (a held one is told by `retarget` and takes it back itself). Which those are is in the
   * database: the mark each session keeps once Kea wrote its worktree's keys.
   */
  private fsmonitorOffElsewhere(projects: readonly Project[]): void {
    const b = this.bound
    const off = projects.filter((p) => p.settings?.useFsmonitor !== true)
    if (!b || off.length === 0 || this.disposed || !this.o.db.isOpen) return
    let marked: { id: string }[] = []
    try {
      marked = this.o.db.all<{ id: string }>("SELECT session_id AS id FROM session_ui WHERE CASE WHEN json_valid(state) THEN json_extract(state, '$.files.fsmonitor') END = 1")
    } catch (e) {
      this.o.log?.warn('fsmonitor marks unreadable', { error: String(e) })
    }
    const ids = new Set(off.map((p) => p.id))
    const waits: Promise<void>[] = []
    for (const { id } of marked) {
      const view = b.sessions.get(id)
      if (!view || !ids.has(view.projectId) || this.sessions.has(id) || this.takingBack.has(id)) continue
      this.takingBack.add(id)
      waits.push(this.fsmonitorTakeBack(id, view.cwd).finally(() => void this.takingBack.delete(id)))
    }
    // …and a worktree that was removed while the setting was on took its keys with it: the shared config is looked at
    // once more for the project's repository, after the worktrees above
    void Promise.all(waits).then(async () => {
      for (const p of off) {
        if (this.disposed) return
        if (typeof p.rootPath === 'string' && (await b.gitUsable)) await this.fsmonitor.settle(p.rootPath).catch(() => undefined)
      }
    })
  }

  private async fsmonitorTakeBack(id: string, cwd: string): Promise<void> {
    try {
      if (!(await this.bound?.gitUsable) || this.disposed) return
      // a folder that is gone took its config with it; a git that did not say is asked again when the session is shown
      const place = await this.fsmonitor.place(cwd)
      const p = this.load(id)
      if (!place || !p?.fsmonitor || this.sessions.has(id)) return
      if (!(await this.fsmonitor.off(place, p.fsmonitorPrior))) return
      // shown meanwhile: the session has done the same and keeps its own state
      if (this.sessions.has(id)) return
      const { fsmonitor: _set, fsmonitorPrior: _prior, ...rest } = p
      this.save(id, rest)
    } catch (e) {
      this.o.log?.warn('fsmonitor setting failed', { session: id, error: String(e) })
    }
  }

  private target(view: SessionView | undefined): SessionTarget {
    const project = view ? this.bound?.projects.get(view.projectId) : undefined
    return { cwd: view?.cwd ?? '', baseBranch: view?.baseBranch ?? null, baseCommit: view?.baseCommit ?? null, useFsmonitor: project?.settings.useFsmonitor === true, isGit: project?.isGit === true }
  }

  private mounts(): Promise<string> {
    if (this.o.mounts) return this.o.mounts()
    // the OS layer's `mounts` (macOS: `mount`'s output; Linux: `/proc/self/mountinfo`); where the system has
    // none, no volume is known to be a network one
    const mounts = coreOs.mounts
    if (!isAvailable(mounts)) return Promise.resolve('')
    const now = performance.now()
    if (!this.mountCache || now - this.mountCache.at > L.watchPollMs) this.mountCache = { at: now, out: mounts.read() }
    return this.mountCache.out
  }

  // ── the database (expansion, scope and panel state persist per session) ───────────────────────

  private load(id: string): PersistedFiles | null {
    try {
      const row = this.o.db.get<{ files: string | null }>("SELECT json_extract(state, '$.files') AS files FROM session_ui WHERE session_id = ?", id)
      if (!row?.files) return null
      const v = JSON.parse(row.files) as Partial<PersistedFiles>
      const scope = zDiffScope.safeParse(v.scope)
      return {
        expanded: Array.isArray(v.expanded) ? v.expanded.filter((p): p is string => typeof p === 'string') : [],
        scope: scope.success ? scope.data : 'branch',
        ui: v.ui && typeof v.ui === 'object' && !Array.isArray(v.ui) ? v.ui : {},
        ...(v.fsmonitor === true ? { fsmonitor: true } : {}),
        ...(v.fsmonitor === true && v.fsmonitorPrior && typeof v.fsmonitorPrior === 'object' ? { fsmonitorPrior: Object.fromEntries(FSMONITOR_KEYS.flatMap((k) => (typeof v.fsmonitorPrior?.[k] === 'string' ? [[k, v.fsmonitorPrior[k]]] : []))) } : {}),
      }
    } catch (e) {
      this.o.log?.warn('files state unreadable', { session: id, error: String(e) })
      return null
    }
  }

  private save(id: string, files: PersistedFiles): void {
    if (this.disposed || !this.o.db.isOpen) return
    // bounded like the rest of the row (L.sessionUiMaxBytes): the folders expanded longest ago go first, then the panel's own state
    let state = files
    let json = JSON.stringify(state)
    while (Buffer.byteLength(json) > L.sessionUiMaxBytes && state.expanded.length > 0) {
      state = { ...state, expanded: state.expanded.slice(Math.ceil(state.expanded.length / 2)) }
      json = JSON.stringify(state)
    }
    if (Buffer.byteLength(json) > L.sessionUiMaxBytes) json = JSON.stringify({ ...state, ui: {} })
    try {
      this.o.db.tx(() => this.o.db.run("UPDATE session_ui SET state = json_set(CASE WHEN json_valid(state) THEN state ELSE '{}' END, '$.files', json(?)) WHERE session_id = ?", json, id))
    } catch (e) {
      this.o.log?.warn('files state not saved', { session: id, error: String(e) })
    }
  }

  // ── which sessions hold what ──────────────────────────────────────────────────────────────────

  private make(id: string): SessionFiles {
    const b = this.bound as FilesBinding
    return new SessionFiles(id, this.target(b.sessions.get(id)), this.load(id), {
      log: this.o.log,
      watcher: this.o.watcher,
      env: this.o.env,
      gitUsable: () => b.gitUsable,
      scope: this.timers,
      facts: this.o.facts !== false,
      mounts: () => this.mounts(),
      statusTimeoutMs: this.o.statusTimeoutMs,
      finderDropMs: this.o.finderDropMs ?? L.finderDropMs,
      fsmonitorHintMs: this.o.fsmonitorHintMs ?? L.fsmonitorHintMs,
      fsmonitor: this.fsmonitor,
      trashTool: this.o.trashTool ?? null,
      persist: (sid, files) => this.save(sid, files),
      repository: (sid) => this.bound?.repository?.(sid),
      changed: (sid) => {
        for (const l of [...this.listeners]) {
          try {
            l(sid)
          } catch (e) {
            this.o.log?.warn('git facts listener failed', { error: String(e) })
          }
        }
      },
    })
  }

  /** Inside `visible.set`: the session's stores exist when this returns. */
  private show(id: string): void {
    const b = this.bound
    if (!b || this.disposed) return
    let s = this.sessions.get(id)
    if (!s) this.sessions.set(id, (s = this.make(id)))
    this.recent = [id, ...this.recent.filter((x) => x !== id)]
    const tree = b.stores.add(new KeyedStore<TreeRow>(treeStoreName(id)))
    const git = this.o.facts !== false ? b.stores.add(new KeyedStore<GitRow>(gitStoreName(id))) : null
    s.show(tree, git)
    this.trim()
  }

  private hide(id: string): void {
    const b = this.bound
    const s = this.sessions.get(id)
    if (!b || !s) return
    s.hide()
    b.stores.remove(treeStoreName(id))
    if (this.o.facts !== false) b.stores.remove(gitStoreName(id))
    // archive and delete release everything, the watch included: for a session that was on screen then, now
    const view = b.sessions.get(id)
    if (!view || view.lifecycle === 'archived' || view.lifecycle === 'deleted') return this.drop(id)
    this.trim()
  }

  /** Caches for the most recently shown sessions only; a session with neither caches nor a watch is forgotten. */
  private trim(): void {
    let kept = 0
    for (const id of [...this.recent]) {
      const s = this.sessions.get(id)
      if (!s) continue
      kept++
      if (s.visible || kept <= L.fileCacheSessions) continue
      if (s.hasCaches) {
        s.dropCaches()
        this.evictions++
      }
      if (!s.watch || s.watch.released) this.drop(id)
    }
  }

  private drop(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.visible) this.hide(id)
    s.dispose()
    this.sessions.delete(id)
    this.recent = this.recent.filter((x) => x !== id)
  }

  // ── the window's calls ────────────────────────────────────────────────────────────────────────

  private shown(sessionId: string): SessionFiles {
    const s = this.sessions.get(sessionId)
    if (!s?.visible) throw new RpcError('invalid_args', `session ${sessionId} is not shown in a window`)
    return s
  }

  handlers(): Handlers<typeof filesApi> {
    return {
      'files.open': ({ sessionId }) => {
        const s = this.shown(sessionId)
        const p = s.persisted()
        return { ok: true, expanded: p.expanded, scope: p.scope, ui: p.ui, trash: s.trashAvailable, undo: s.undoKind }
      },
      'files.expand': async ({ sessionId, path }) => ({ ok: await this.shown(sessionId).expand(path) }),
      'files.collapse': ({ sessionId, path }) => ({ ok: this.shown(sessionId).collapse(path) }),
      'files.showAll': async ({ sessionId, path }) => ({ ok: await this.shown(sessionId).showAll(path) }),
      'files.saveUi': ({ sessionId, ui }) => {
        if (Buffer.byteLength(JSON.stringify(ui)) > L.sessionUiMaxBytes) throw new RpcError('invalid_args', `panel state over ${L.sessionUiMaxBytes} bytes`)
        // also for a session the window has just left (its scroll position at the switch): whatever core still holds
        const s = this.sessions.get(sessionId)
        if (!s) return { ok: false }
        s.saveUi(ui)
        return { ok: true }
      },
      'files.refresh': ({ sessionId }) => {
        this.shown(sessionId).refreshSoon(true, true)
        return { ok: true }
      },
      'files.setScope': ({ sessionId, scope }) => {
        this.shown(sessionId).setScope(scope)
        return { ok: true }
      },
      'files.discard': ({ sessionId, path, expect, scope, base }) => this.shown(sessionId).discard(path, expect, { scope, base }),
      'files.create': ({ sessionId, dir, name, kind }) => this.shown(sessionId).create(dir, name, kind),
      'files.rename': ({ sessionId, path, name }) => this.shown(sessionId).rename(path, name),
      'files.move': ({ sessionId, path, toDir, copy }) => this.shown(sessionId).move(path, toDir, copy),
      'files.undo': ({ sessionId }) => this.shown(sessionId).undo(),
      'files.trash': ({ sessionId, path, dir }) => this.shown(sessionId).trash(path, dir),
      'files.measure': ({ sessionId, sources, toDir }) => this.shown(sessionId).measure(sources, toDir),
      'files.copyIn': ({ sessionId, sources, toDir }) => this.shown(sessionId).copyIn(sources, toDir),
      'files.find': ({ sessionId, query, recent }) => this.shown(sessionId).find(query, recent ?? []),
      'files.fsmonitorOffered': async ({ projectId }) => {
        // not on a network volume. The folder is the repository's: every worktree's git dir, where git's daemon
        // listens, lies in it (a session whose own worktree is on one is left out by itself, session.ts)
        const root = this.bound?.projects.get(projectId)?.rootPath
        // nor where git has no daemon (Linux's git)
        if (!(await this.fsmonitor.supported())) return { offered: false }
        return { offered: root === undefined || networkMount(await this.mounts(), root) === null }
      },
    }
  }

  // ── refresh triggers ──────────────────────────────────────────────────────────────────────────

  /** A Kea window got keyboard focus: every visible session is read again, now. */
  focus(): void {
    // An inotify limit held is read again here too
    this.o.watcher?.focus()
    for (const s of this.sessions.values()) s.refreshSoon(true)
  }

  /** An agent's tool finished in `sessionId`: it may have written files (joins the status debounce). */
  toolFinished(sessionId: string): void {
    this.sessions.get(sessionId)?.refreshSoon(false)
  }

  // ── GitFacts ──────────────────────────────────────────────────────────────────────────────────

  scope(sessionId: string): DiffScope {
    return this.sessions.get(sessionId)?.scope ?? this.load(sessionId)?.scope ?? 'branch'
  }

  async base(sessionId: string, scope: DiffScope): Promise<string | null> {
    const have = this.sessions.get(sessionId)
    if (have) return have.base(scope)
    const b = this.bound
    if (!b || !b.sessions.get(sessionId)) return null
    // a session nothing is held for: asked once, kept nowhere
    const once = this.make(sessionId)
    try {
      return await once.base(scope)
    } finally {
      once.dispose()
    }
  }

  entry(sessionId: string, path: string): GitEntry | null {
    return this.sessions.get(sessionId)?.entry(path) ?? null
  }

  onChange(cb: (sessionId: string) => void): Disposable {
    this.listeners.add(cb)
    return { dispose: () => void this.listeners.delete(cb) }
  }

  // ── the resource report (`core.files`) ────────────────────────────────────────────────────────

  get counts(): Record<string, number> {
    let dirs = 0
    let entries = 0
    let gitEntries = 0
    let ignored = 0
    let cached = 0
    let finderPaths = 0
    let finderIndexes = 0
    let finderWorkers = 0
    let running = 0
    let pending = 0
    let lines = 0
    let visible = 0
    for (const s of this.sessions.values()) {
      const c = s.counts
      dirs += c.dirs
      entries += c.entries
      gitEntries += c.gitEntries
      ignored += c.ignored
      finderPaths += c.finderPaths
      finderWorkers += c.finderWorker
      lines += c.linesCached
      if (s.finder) finderIndexes++
      if (s.hasCaches) cached++
      if (s.visible) visible++
      if (s.scheduler.running) running++
      if (s.scheduler.pending) pending++
    }
    return { sessions: this.sessions.size, visible, cached, dirs, entries, gitEntries, ignored, lineCounts: lines, statusRunning: running, statusPending: pending, finderIndexes, finderWorkers, finderPaths, evictions: this.evictions, listeners: this.listeners.size, timers: this.timers.size, fsmonitorWrites: this.fsmonitor.writes }
  }

  /** As the other services name it (resources/gauges.ts). */
  get resourceCounts(): Record<string, number> {
    return this.counts
  }

  /** Tests: a session's state, if any is held. */
  session(sessionId: string): SessionFiles | undefined {
    return this.sessions.get(sessionId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.subs.splice(0)) off()
    for (const id of [...this.sessions.keys()]) {
      const s = this.sessions.get(id) as SessionFiles
      if (s.visible && this.bound) {
        this.bound.stores.remove(treeStoreName(id))
        if (this.o.facts !== false) this.bound.stores.remove(gitStoreName(id))
      }
      s.dispose()
    }
    this.sessions.clear()
    this.recent = []
    this.listeners.clear()
    this.timers.dispose()
  }
}
