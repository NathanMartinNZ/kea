// One session's files and git state in core: its loaded directories, what git ignores, its status snapshot, its hold on
// the watch service and its finder index. `FilesService` (service.ts) keeps one of these for each session that is
// visible, recently viewed or still followed by the watch service, and tells it when the session is shown and hidden.
//
//   shown    its two stores exist and are filled from what is cached; the worktree is followed and active; everything
//            is read again, then kept current by watcher events (tree: per directory; status: the scheduler).
//   hidden   no stores; the watch only marks it stale; no git runs (the one in flight is ended); the caches stay
//            until the service drops them.
//   The finder index (and its worker) goes L.finderDropMs after its last query, shown or hidden.

import fs from 'node:fs'
import path from 'node:path'
import { fileName, git, type Disposable, type Logger, type Scope } from '@kea/kit'
import { GIT_HEAD_KEY, gitKey, KeyedStore, L, TREE_HEAD_KEY, treeKey, type DiffScope, type DiscardAction, type DiscardResult, type FilesUi, type GitEntry, type GitHead, type GitRow, type GitState, type TreeDir, type TreeHead, type TreeRow } from '@kea/protocol'
import type { Changes } from '../platform/watch/batcher.ts'
import { askedOfGit, WORKTREE_EXCLUSIONS } from '../platform/watch/exclusions.ts'
import type { GitChange, RescanReason, Watcher, WatchMode, WorktreeWatch } from '../platform/watch/watcher.ts'
import { canonical, type RepoFacts } from '../worktrees/git.ts'
import { discardFile } from './discard.ts'
import { FinderIndex, type FinderAnswer } from './finder.ts'
import { IgnoreIndex } from './ignore.ts'
import { listDirectory } from './listing.ts'
import { networkMount } from './mounts.ts'
import { ZRecords } from './records.ts'
import type { Fsmonitor, PriorValues } from './fsmonitor.ts'
import { StatusScheduler } from './scheduler.ts'
import { GitStatus, type Env, type Snapshot } from './status.ts'
import { childPath, parentPath, TreeCache } from './tree.ts'
import { ignoredWhole } from './whole.ts'

/** What of a session the files service needs (from its `SessionView` and its project's settings). */
export interface SessionTarget {
  cwd: string
  baseBranch: string | null
  baseCommit: string | null
  /** The project uses git's fsmonitor. */
  useFsmonitor: boolean
}

/** What is kept in the database per session. */
export interface PersistedFiles {
  expanded: string[]
  scope: DiffScope
  ui: FilesUi
  /** Kea set `core.fsmonitor` in this worktree's config, so Kea may unset it. */
  fsmonitor?: boolean
  /** The values that worktree's own config had for Kea's keys before (put back when the setting goes off). */
  fsmonitorPrior?: Record<string, string>
}

export interface SessionDeps {
  log: Logger | undefined
  /** Null: nothing is watched (core runs on a stand-in watch service); the session refreshes only when asked. */
  watcher: Watcher | null
  env: () => Promise<Env>
  gitUsable: () => Promise<boolean>
  /** Timers (the service's scope). */
  scope: Scope
  /** False: core's git facts come from elsewhere (a test's stand-in): no status runs, no `git:` store. */
  facts: boolean
  /** `mount`'s output (a network volume is poll-only). */
  mounts: () => Promise<string>
  /** The timeout for each git call (tests shorten it). */
  statusTimeoutMs: number | undefined
  /** How long the finder's index outlives its last query (tests shorten it). */
  finderDropMs: number
  /** A status slower than this suggests fsmonitor (tests shorten it). */
  fsmonitorHintMs: number
  /** What writes the setting to a worktree and takes it back (fsmonitor.ts). */
  fsmonitor: Fsmonitor
  /** The `trash` tool Discard Changes moves a file to the Trash with, or null: none on this system. */
  trashTool: string | null
  persist(sessionId: string, files: PersistedFiles): void
  /** The session's status changed anything (GitFacts.onChange). */
  changed(sessionId: string): void
}

export interface SessionStats {
  /** Directory reads. */
  listings: number
  /** Deltas sent to the tree store. */
  treeUpdates: number
  /** Refreshes (the scheduler's runs): each is a status pipeline (and a full tree read when one was due). */
  refreshes: number
  fullRefreshes: number
  ignoreLoads: number
  ignoreChecks: number
  rescans: number
  /** Watcher changes dropped because git ignores the path. */
  ignoredEvents: number
  /** How long the last status pipeline took, in milliseconds (git's own time: P-GS-1, and the fsmonitor hint). */
  statusMs: number
}

const sameEntries = (a: TreeDir, b: TreeDir): boolean => {
  if (a.total !== b.total || a.paged !== b.paged || a.truncated !== b.truncated || a.entries.length !== b.entries.length) return false
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i] as TreeDir['entries'][number]
    const y = b.entries[i] as TreeDir['entries'][number]
    if (x.name !== y.name || x.kind !== y.kind || x.ignored !== y.ignored) return false
  }
  return true
}

const sameRow = (a: GitRow, b: GitRow): boolean => JSON.stringify(a) === JSON.stringify(b)

export class SessionFiles {
  readonly id: string
  private target: SessionTarget
  private readonly d: SessionDeps
  /** The working directory's real path; null until `init` has run, or when it is gone. */
  root: string | null = null
  repo: RepoFacts | null = null
  private network = false
  private missing = false
  private inited: Promise<void> | null = null
  /** `init` has finished: whether this is a repository is known. */
  private known = false
  /** Counters (not times): the last watch attached, the last refresh started. */
  private tick = 0
  private attachTick = 0
  private refreshTick = -1
  private settle: (() => void) | null = null
  /** git did not answer whether this is a repository: asked again with the next refresh. */
  private gitUnknown = false
  /** On screen with no stream: released for another session on screen (the worktree cap), until shown again. */
  private unwatched = false
  private attachedGitDir: string | null = null
  /** The watch service's first question (which folders git ignores whole), asked while the repository was inspected. */
  private wholeAsked: { root: string; answer: Promise<readonly string[] | null> } | null = null

  readonly tree = new TreeCache()
  // bounded: by the persisted state's size cap (L.sessionUiMaxBytes; `persist` cuts the oldest)
  readonly expanded = new Set<string>()
  private ui: FilesUi
  ignore: IgnoreIndex | null = null
  treeStore: KeyedStore<TreeRow> | null = null
  gitStore: KeyedStore<GitRow> | null = null

  private status: GitStatus | null = null
  readonly scheduler: StatusScheduler
  snapshot: Snapshot | null = null
  scope: DiffScope
  /** Too many changes; refreshed only when asked. */
  private manual = false
  private slow = false
  private statusAbort: AbortController | null = null
  private fsmonitorSet: boolean
  private fsmonitorPrior: PriorValues

  watch: WorktreeWatch | null = null
  private mode: WatchMode = 'live'
  visible = false
  /** Counts shows, so work started for one showing is not applied to the next. */
  private shows = 0
  /** A full read of the tree is due with the next refresh. */
  private fullDue = false

  // bounded: the loaded directories (≤ TreeCache's)
  private readonly dirty = new Set<string>()
  private flushing: Promise<void> | null = null
  // bounded: L.checkIgnoreQueueMax; past it the queue is dropped and the ignored list is read again
  private readonly checkQueue = new Set<string>()
  private checkTimer: Disposable | null = null
  private checking: Promise<void> | null = null
  private lastCheck = Number.NEGATIVE_INFINITY
  private ignoreLoading: Promise<void> | null = null
  private ignoreAgain = false
  private ignoreTimer: Disposable | null = null

  finder: FinderIndex | null = null
  private finderDrop: Disposable | null = null
  disposed = false
  readonly stats: SessionStats = { listings: 0, treeUpdates: 0, refreshes: 0, fullRefreshes: 0, ignoreLoads: 0, ignoreChecks: 0, rescans: 0, ignoredEvents: 0, statusMs: 0 }

  constructor(id: string, target: SessionTarget, persisted: PersistedFiles | null, deps: SessionDeps) {
    this.id = id
    this.target = target
    this.d = deps
    this.scope = persisted?.scope ?? 'branch'
    this.ui = persisted?.ui ?? {}
    this.fsmonitorSet = persisted?.fsmonitor === true
    this.fsmonitorPrior = persisted?.fsmonitorPrior ?? {}
    for (const p of persisted?.expanded ?? []) this.expanded.add(p)
    this.scheduler = new StatusScheduler({ run: () => this.refresh(), schedule: (fn, ms) => deps.scope.timeout(fn, ms), now: () => performance.now() })
    this.scheduler.stop() // until shown
  }

  // ── what the service asks ─────────────────────────────────────────────────────────────────────

  get hasCaches(): boolean {
    return this.tree.size > 0 || this.snapshot !== null || this.ignore !== null || this.finder !== null
  }

  get counts(): { dirs: number; entries: number; gitEntries: number; ignored: number; finderPaths: number; finderWorker: number; linesCached: number } {
    return { dirs: this.tree.size, entries: this.tree.entries, gitEntries: this.snapshot?.entries.size ?? 0, ignored: this.ignore?.size ?? 0, finderPaths: this.finder?.paths ?? 0, finderWorker: this.finder?.hasWorker ? 1 : 0, linesCached: this.status?.linesCached ?? 0 }
  }

  get statusCounters(): GitStatus['counters'] | null {
    return this.status?.counters ?? null
  }

  persisted(): PersistedFiles {
    return { expanded: [...this.expanded], scope: this.scope, ui: this.ui, ...(this.fsmonitorSet ? { fsmonitor: true, ...(Object.keys(this.fsmonitorPrior).length ? { fsmonitorPrior: { ...this.fsmonitorPrior } } : {}) } : {}) }
  }

  private persist(): void {
    this.d.persist(this.id, this.persisted())
  }

  /** The session's view changed (its directory, its base) or its project's settings did. */
  retarget(target: SessionTarget): void {
    const was = this.target
    if (was.cwd === target.cwd && was.baseBranch === target.baseBranch && was.baseCommit === target.baseCommit && was.useFsmonitor === target.useFsmonitor && !this.missing) return
    this.target = target
    if (was.cwd !== target.cwd) {
      // another directory: nothing known holds
      this.inited = null
      this.known = false
      this.dropWatch()
      this.dropCaches()
      if (this.visible) void this.activate()
      return
    }
    if (this.root !== null && this.repo) this.status?.retarget({ root: this.root, toplevel: this.repo.toplevel, gitDir: this.repo.gitDir, baseBranch: target.baseBranch, baseCommit: target.baseCommit })
    if (was.useFsmonitor !== target.useFsmonitor) void this.applyFsmonitor()
    if (this.visible && (was.baseBranch !== target.baseBranch || was.baseCommit !== target.baseCommit)) this.scheduler.now()
    if (this.visible && this.missing) {
      // a worktree that was not there yet (a session being created): look again
      this.inited = null
      void this.activate()
    }
  }

  /** Shown in a window (synchronously, inside `visible.set`): the stores exist when this returns. */
  show(treeStore: KeyedStore<TreeRow>, gitStore: KeyedStore<GitRow> | null): void {
    this.visible = true
    this.shows++
    this.treeStore = treeStore
    this.gitStore = gitStore
    // What is cached is on screen at once; the refresh that follows corrects it
    // (the head only once it is known whether this is a repository: the panel shows nothing it would have to take back)
    treeStore.setMany([...(this.known ? ([[TREE_HEAD_KEY, this.treeHead()]] as [string, TreeRow][]) : []), ...this.tree.paths().flatMap((p): [string, TreeRow][] => {
      const row = this.tree.row(p, this.ignore)
      return row ? [[treeKey(p), row]] : []
    })])
    if (gitStore) gitStore.setMany(this.gitRows())
    this.scheduler.resume()
    void this.activate()
  }

  /** No window shows it any more. */
  hide(): void {
    this.visible = false
    this.treeStore = null
    this.gitStore = null
    this.scheduler.stop()
    this.statusAbort?.abort() // a run nobody needs
    this.statusAbort = null
    this.wholeAsked = null // an answer not used by now is too old to open a stream with later
    this.watch?.setActive(false)
    this.checkTimer?.dispose()
    this.checkTimer = null
    this.checkQueue.clear()
    this.ignoreTimer?.dispose()
    this.ignoreTimer = null
    this.dirty.clear()
    // The finder's index (and its worker) goes with the wait its last query started (`find`): no later than
    // that long after the session was hidden, as only a session on screen is queried
  }

  /** This session is no longer one whose caches core keeps. */
  dropCaches(): void {
    this.tree.clear()
    this.snapshot = null
    this.ignore = null
    this.manual = false
    this.dropFinder()
  }

  dropFinder(): void {
    this.finderDrop?.dispose()
    this.finderDrop = null
    this.finder?.dispose()
    this.finder = null
  }

  private dropWatch(): void {
    this.watch?.dispose()
    this.watch = null
    this.attachedGitDir = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.visible = false
    this.scheduler.dispose()
    this.statusAbort?.abort()
    this.checkTimer?.dispose()
    this.ignoreTimer?.dispose()
    this.dropWatch()
    this.dropCaches()
    this.treeStore = this.gitStore = null
  }

  // ── start ─────────────────────────────────────────────────────────────────────────────────────

  private init(): Promise<void> {
    return (this.inited ??= (async () => {
      let root: string | null = null
      try {
        root = canonical(this.target.cwd)
        if (!fs.statSync(root).isDirectory()) root = null
      } catch {
        root = null
      }
      this.root = root
      this.missing = root === null
      this.repo = null
      this.status = null
      this.network = false
      this.gitUnknown = false
      if (root === null) return
      // the tree does not wait for git: one that hangs holds up nothing else
      void this.firstPaint()
      if (await this.d.gitUsable()) await this.inspect(root)
      // what the worktree's stream may leave out is git's to say. Asked now, beside what follows, so the answer is
      // there when the worktree is attached and its stream opens as fast as it did by name
      const whole = this.repo && this.d.watcher && this.visible ? this.askWhole(root) : null
      try {
        this.network = networkMount(await this.d.mounts(), root) !== null
      } catch {
        this.network = false
      }
      await this.applyFsmonitor()
      // waited for, but only as long as one event window: the first status is not held up by a slow git (the stream
      // then opens when the answer comes, and everything is read once more)
      if (whole) {
        await new Promise<void>((resolve) => {
          const t = this.d.scope.timeout(resolve, L.watchBatchMs)
          void whole.then(() => {
            t.dispose()
            resolve()
          })
        })
      }
    })().finally(() => {
      this.known = true
    }))
  }

  /** The root's entries, before anything is known about git, for a session with nothing cached. */
  private async firstPaint(): Promise<void> {
    if (!this.visible || this.tree.has('')) return
    if ((await this.load('')) && this.visible) this.publishDirs([''])
  }

  /**
   * Is the directory a git work tree, and where are its git dir and common dir (a linked worktree's `.git` is a file;
   * git says where it points)? A git that does not answer leaves that unknown: asked again at the next refresh.
   */
  private async inspect(root: string): Promise<void> {
    const r = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd: root, env: await this.d.env(), readOnly: true, collect: true, timeoutMs: this.d.statusTimeoutMs ?? L.gitStatusTimeoutMs }).catch(() => null)
    if (root !== this.root) return
    this.gitUnknown = !r || r.timedOut || r.truncated || r.cancelled
    if (!r || this.gitUnknown || r.code !== 0) return // exit 128: not a repository
    const [toplevel, gitDir, commonDir] = (r.stdout ?? Buffer.alloc(0)).toString('utf8').split('\n')
    if (!toplevel || !gitDir || !commonDir) return
    const real = (p: string): string => {
      try {
        return canonical(p)
      } catch {
        return fileName(p)
      }
    }
    const facts = { toplevel: real(toplevel), gitDir: real(gitDir), commonDir: real(commonDir) }
    this.repo = { ...facts, linked: facts.gitDir !== facts.commonDir }
    if (this.d.facts) this.status = new GitStatus({ root, toplevel: facts.toplevel, gitDir: facts.gitDir, baseBranch: this.target.baseBranch, baseCommit: this.target.baseCommit }, this.d.env, this.d.statusTimeoutMs)
  }

  /** Ask git which of the stream's candidate folders it ignores whole, ahead of the watch service asking. */
  private askWhole(root: string): Promise<readonly string[] | null> {
    const answer = ignoredWhole(root, askedOfGit(WORKTREE_EXCLUSIONS), this.d.env, this.d.statusTimeoutMs)
    this.wholeAsked = { root, answer }
    return answer
  }

  /**
   * The watch service's question for the work tree at `root` (`WorktreeRequest.ignored`). It holds the root and the
   * service's git environment, nothing of this session, which may be gone while another session's hold keeps the
   * worktree followed. Its first answer is the one asked for while the repository was inspected, if that was just now.
   */
  private wholeAsk(root: string): (names: readonly string[]) => Promise<readonly string[] | null> {
    const d = this.d
    let first = this.wholeAsked?.root === root ? this.wholeAsked.answer : null
    this.wholeAsked = null
    return (names) => {
      const asked = first
      first = null
      return asked ?? ignoredWhole(root, names, d.env, d.statusTimeoutMs)
    }
  }

  /** Follow the worktree for this session (again, when what is known of its git dirs changed). True: a new hold. */
  private attach(): boolean {
    if (!this.d.watcher || this.root === null) return false
    const have = this.watch && !this.watch.released ? this.watch : null
    const gitDir = this.repo?.gitDir ?? null
    if (have && this.attachedGitDir === gitDir) return false
    this.attachTick = ++this.tick
    this.attachedGitDir = gitDir
    const root = this.root
    this.watch = this.d.watcher.worktree({ root, gitDir, commonDir: this.repo?.commonDir ?? null, network: this.network, ...(this.repo ? { ignored: this.wholeAsk(root) } : {}) }, {
      onChanges: (c) => this.onChanges(c),
      onRescan: (why) => this.onRescan(why),
      onGit: (g) => this.onGit(g),
      onMode: (m) => this.onMode(m),
      onReleased: () => this.onReleased(),
    })
    if (have) {
      this.watch.setActive(this.visible)
      have.dispose()
    }
    return true
  }

  /** Shown: follow the worktree, read everything again. */
  private async activate(): Promise<void> {
    const show = this.shows
    // a folder that was not there at the last look may have been put back: looked for again
    if (this.missing && this.known) this.inited = null
    await this.init()
    if (this.disposed || !this.visible || show !== this.shows) return
    this.publishTreeHead()
    if (this.root === null) {
      // a missing directory: nothing to list, nothing to compare
      this.publishGit()
      return
    }
    this.unwatched = false
    const fresh = this.attach()
    const w = this.watch
    // what moved while nobody watched is unknown: the merge base is asked for again
    if (fresh || w?.stale || (w && w.mode !== 'live')) this.status?.base.moved()
    w?.touch()
    w?.setActive(true)
    // a hold released as soon as it was given (every followed worktree is on screen) has no start to wait for
    if (fresh && w?.mode === 'starting' && !w.released) {
      // the stream opens in about a millisecond: the first refresh waits for it, so that nothing can change unseen
      // between the two; a start that takes longer is not waited for (the start has its own, L.watchStartTimeoutMs)
      await new Promise<void>((resolve) => {
        const t = this.d.scope.timeout(resolve, L.watchBatchMs)
        this.settle = () => {
          t.dispose()
          resolve()
        }
      })
      this.settle = null
      if (this.disposed || !this.visible || show !== this.shows) return
    }
    this.mode = w && w.mode !== 'starting' ? w.mode : 'live'
    this.publishTreeHead()
    this.tree.touch('')
    this.fullDue = true
    if (this.repo) this.loadIgnore()
    this.scheduler.now()
  }

  // ── the tree ──────────────────────────────────────────────────────────────────────────────────

  private treeHead(): TreeHead {
    return { git: this.repo !== null, live: this.mode !== 'poll' && !this.unwatched, missing: this.missing }
  }

  private publishTreeHead(): void {
    const s = this.treeStore
    if (!s) return
    const next = this.treeHead()
    const was = s.get(TREE_HEAD_KEY) as TreeHead | undefined
    if (!was || was.git !== next.git || was.live !== next.live || was.missing !== next.missing) s.set(TREE_HEAD_KEY, next)
  }

  private publishDirs(dirs: Iterable<string>): void {
    const s = this.treeStore
    if (!s) return
    const set: [string, TreeRow][] = []
    for (const p of dirs) {
      const row = this.tree.row(p, this.ignore)
      if (!row) continue
      const was = s.get(treeKey(p)) as TreeDir | undefined
      if (!was || !sameEntries(was, row)) set.push([treeKey(p), row])
    }
    if (set.length) {
      this.stats.treeUpdates++
      s.setMany(set)
    }
  }

  private forget(dirs: readonly string[]): void {
    for (const p of dirs) {
      this.dirty.delete(p)
      this.treeStore?.delete(treeKey(p))
    }
  }

  /** `rel` is a directory inside the working directory, reached without passing a symlink (never followed). */
  private async isPlainDir(rel: string): Promise<boolean> {
    if (this.root === null) return false
    if (rel === '') return true
    const abs = path.join(this.root, rel)
    try {
      const st = await fs.promises.lstat(abs)
      if (!st.isDirectory()) return false
      // compared as file operations take names: NFC on macOS, byte for byte on Linux, where two spellings of a name
      // are two files
      return fileName(await fs.promises.realpath(abs)) === fileName(abs)
    } catch {
      return false
    }
  }

  /**
   * Whether the session's folder is gone (deleted while it was shown). If so, nothing read from it stays on screen
   * under the "missing" note — no tree row, no change, no status passed off as one that worked — and nothing of it is
   * followed; the state is the one of a folder that was never there. It is looked for again at every refresh trigger
   * (`refresh`), when the session is next shown (`activate`) and when its view changes (`retarget`).
   */
  private async rootGone(): Promise<boolean> {
    const root = this.root
    if (root === null) return true
    const there = await fs.promises.stat(root).then(
      (st) => st.isDirectory(),
      () => false,
    )
    if (there || this.disposed || this.root !== root) return this.root === null
    this.statusAbort?.abort()
    this.statusAbort = null
    this.dropWatch()
    this.dropCaches()
    this.dirty.clear()
    this.checkQueue.clear()
    this.wholeAsked = null
    this.root = null
    this.missing = true
    this.repo = null
    this.status = null
    this.gitUnknown = false
    this.unwatched = false
    this.mode = 'live'
    this.treeStore?.replace({ [TREE_HEAD_KEY]: this.treeHead() })
    this.publishGit()
    return true
  }

  /** Read `rel` into the cache. False: it is not a directory any more (and is forgotten, with what was below it). */
  private async load(rel: string, o: { showAll?: boolean; touch?: boolean } = {}): Promise<boolean> {
    if (this.root === null) return false
    this.stats.listings++
    const listing = (await this.isPlainDir(rel)) ? await listDirectory(path.join(this.root, rel)) : null
    if (this.disposed) return false
    if (!listing) {
      if (rel !== '') {
        this.forget(this.tree.remove(rel))
        this.expanded.delete(rel)
      } else {
        await this.rootGone()
      }
      return false
    }
    const before = this.tree.names(rel)
    const had = before ? new Set(before.map((e) => e.name)) : null
    this.forget(this.tree.set(rel, listing, o))
    if (this.repo && this.ignore && this.ignore.ignoredAncestor(rel) === null) {
      // git is asked (in batches) about the rows the ignored list cannot answer for: every row while the list is not
      // whole, and a name that appeared since this directory was last read (the list is older than it; a folder the
      // kernel excludes sends no event of its own)
      for (const e of listing.entries.slice(0, L.dirFirstPage)) {
        const child = childPath(rel, e.name)
        if (this.ignore.query(child, had !== null && !had.has(e.name)) === 'unknown') this.queueCheck(child)
      }
    }
    return true
  }

  /** Read the directories that changed, one pass at a time; what changes meanwhile is the next pass. */
  private flushTree(): Promise<void> {
    if (this.flushing) return this.flushing
    const pass = async (): Promise<void> => {
      while (this.dirty.size && !this.disposed && this.visible) {
        const batch = [...this.dirty].sort((a, b) => a.length - b.length)
        this.dirty.clear()
        const ok: string[] = []
        for (const p of batch) if (this.tree.has(p) && (await this.load(p, { touch: false }))) ok.push(p)
        // a check that is already running names files these rows may hold: its answer first, so a new ignored file is
        // not shown for a moment (the wait fits in the time a new file has to appear)
        if (this.checking) await this.checking
        this.publishDirs(ok)
      }
    }
    // cleared in a later turn, so an empty pass cannot clear it before it is set
    const run: Promise<void> = pass().finally(() => {
      if (this.flushing === run) this.flushing = null
    })
    this.flushing = run
    return run
  }

  /** The root and every expanded directory, read again (the full refresh; the first load of a session shown). */
  private async readAll(): Promise<void> {
    if (this.root === null) return
    this.stats.fullRefreshes++
    const want = new Set<string>(['', ...this.tree.paths()])
    // a session shown for the first time since its caches went: what was expanded then, parents before children
    for (const p of [...this.expanded].sort((a, b) => a.length - b.length)) if (p === '' || want.has(parentPath(p))) want.add(p)
    for (const p of want) this.dirty.add(p)
    // `load` only reads what the cache already has; a directory not yet in it is added here
    for (const p of [...want].sort((a, b) => a.length - b.length)) {
      if (this.disposed || !this.visible) return
      if (!this.tree.has(p)) {
        this.dirty.delete(p)
        if (await this.load(p)) this.publishDirs([p])
      }
    }
    await this.flushTree()
  }

  async expand(rel: string): Promise<boolean> {
    await this.init()
    if (!this.visible || !(await this.load(rel))) return false
    if (rel !== '') this.expanded.add(rel)
    if (this.checking) await this.checking
    this.publishDirs([rel])
    this.persist()
    return true
  }

  collapse(rel: string): boolean {
    const prefix = `${rel}/`
    for (const p of [...this.expanded]) if (p === rel || p.startsWith(prefix)) this.expanded.delete(p)
    this.forget(this.tree.remove(rel))
    this.persist()
    return true
  }

  async showAll(rel: string): Promise<boolean> {
    await this.init()
    if (!this.visible || !this.tree.has(rel) || !(await this.load(rel, { showAll: true }))) return false
    this.publishDirs([rel])
    return true
  }

  saveUi(ui: FilesUi): void {
    this.ui = ui
    this.persist()
  }

  // ── what git ignores ──────────────────────────────────────────────────────────────────────────

  /** Read the ignored list again, soon (a `.gitignore` changed, `HEAD` moved): one read however many reasons. */
  private ignoreSoon(): void {
    if (!this.repo || !this.visible || this.ignoreTimer) return
    this.ignoreTimer = this.d.scope.timeout(() => {
      this.ignoreTimer = null
      this.loadIgnore()
    }, L.checkIgnoreDebounceMs)
  }

  /** `git ls-files -o -i --exclude-standard --directory -z`: every ignored path, a whole ignored folder as one entry. */
  private loadIgnore(): void {
    if (!this.repo || this.root === null) return
    if (this.ignoreLoading) {
      this.ignoreAgain = true
      return
    }
    const root = this.root
    this.stats.ignoreLoads++
    this.ignoreLoading = (async () => {
      const next = new IgnoreIndex()
      const recs = new ZRecords((rec) => void next.addListed(fileName(rec.toString('utf8'))))
      const r = await git(['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z'], { cwd: root, env: await this.d.env(), readOnly: true, maxBytes: L.gitLsfilesCapBytes, timeoutMs: L.gitStatusTimeoutMs, onStdout: (c) => void recs.push(c) }).catch(() => null)
      recs.end()
      if (this.disposed || root !== this.root) return
      if (!r || (r.code !== 0 && !r.truncated)) {
        this.ignore ??= new IgnoreIndex() // nothing known: rows are asked about one by one
      } else {
        if (r.truncated || recs.overlong) next.partial = true
        next.loaded = true
        this.ignore = next
        if (this.finder) this.finder.stale = true // what the finder lists follows the same rules
      }
      this.publishDirs(this.tree.paths())
    })().finally(() => {
      this.ignoreLoading = null
      if (this.ignoreAgain) {
        this.ignoreAgain = false
        if (this.visible) this.loadIgnore()
      }
    })
  }

  /** Ask git about `rel` with the next batch. */
  private queueCheck(rel: string): void {
    if (!this.repo || !this.visible) return
    if (this.checkQueue.size >= L.checkIgnoreQueueMax) {
      // too many to ask one by one: the whole list again
      this.checkQueue.clear()
      this.checkTimer?.dispose()
      this.checkTimer = null
      return this.ignoreSoon()
    }
    this.checkQueue.add(rel)
    if (this.checkTimer || this.checking) return
    const now = performance.now()
    // one new file: asked at once; a stream of them: a batch per debounce
    if (now - this.lastCheck >= L.checkIgnoreDebounceMs) return void this.runCheck()
    this.checkTimer = this.d.scope.timeout(() => {
      this.checkTimer = null
      void this.runCheck()
    }, L.checkIgnoreDebounceMs)
  }

  private runCheck(): Promise<void> {
    if (this.checking) return this.checking
    const root = this.root
    const ignore = this.ignore
    if (root === null || !ignore || this.checkQueue.size === 0) return Promise.resolve()
    const asked = [...this.checkQueue]
    this.checkQueue.clear()
    this.lastCheck = performance.now()
    this.stats.ignoreChecks++
    this.checking = (async () => {
      const hit = new Set<string>()
      const recs = new ZRecords((rec) => void hit.add(rec.toString('utf8')))
      const r = await git(['check-ignore', '-z', '--stdin'], { cwd: root, env: await this.d.env(), readOnly: true, stdin: `${asked.join('\0')}\0`, maxBytes: L.gitStatusCapBytes, timeoutMs: L.gitStatusTimeoutMs, onStdout: (c) => void recs.push(c) }).catch(() => null)
      recs.end()
      if (this.disposed || ignore !== this.ignore || !r || (r.code !== 0 && r.code !== 1)) return
      const parents = new Set<string>()
      const gone: string[] = []
      for (const p of asked) {
        const ignored = hit.has(p)
        let dir = false
        if (ignored) {
          gone.push(p)
          try {
            dir = (await fs.promises.lstat(path.join(root, p))).isDirectory()
          } catch {
            dir = false
          }
        }
        ignore.addChecked(p, ignored, dir)
        if (ignored && this.tree.has(parentPath(p))) parents.add(parentPath(p))
        if (ignored && dir) for (const loaded of this.tree.paths()) if (loaded === p || loaded.startsWith(`${p}/`)) parents.add(loaded)
      }
      if (gone.length) this.finder?.patch([], gone)
      this.publishDirs(parents)
    })().finally(() => {
      this.checking = null
      if (this.checkQueue.size && !this.checkTimer && this.visible) {
        this.checkTimer = this.d.scope.timeout(() => {
          this.checkTimer = null
          void this.runCheck()
        }, L.checkIgnoreDebounceMs)
      }
    })
    return this.checking
  }

  // ── the watch service's news ──────────────────────────────────────────────────────────────────

  private onChanges(changes: Changes): void {
    if (!this.visible || this.root === null) return
    let trigger = false
    const add: string[] = []
    const del: string[] = []
    for (const [p, kind] of changes) {
      const parent = parentPath(p)
      if (this.tree.has(parent)) this.dirty.add(parent)
      if (kind === 'delete' && this.tree.has(p)) {
        this.forget(this.tree.remove(p))
        this.expanded.delete(p)
      } else if (this.tree.has(p)) this.dirty.add(p)
      if (p === '.gitignore' || p.endsWith('/.gitignore')) this.ignoreSoon()
      if (this.repo) {
        // filtered after delivery: what git ignores is no reason for a status
        const answer = this.ignore ? this.ignore.query(p, kind === 'create') : 'unknown'
        if (answer === 'ignored') {
          this.stats.ignoredEvents++
          continue
        }
        if (answer === 'unknown' && kind !== 'delete') this.queueCheck(p)
      }
      trigger = true
      // an update may be a new file: one made, removed and made again in one window, or one the native watcher reported
      // removed (made and removed within one of its batches) and that was then made again (I-FT-28). The finder
      // takes it as an add, which its index ignores for a path it has
      if (kind === 'delete') del.push(p)
      else add.push(p)
    }
    if (this.dirty.size) void this.flushTree()
    if (this.finder && (add.length || del.length)) void this.patchFinder(add, del)
    if (trigger && !this.manual) this.scheduler.trigger()
  }

  private async patchFinder(add: string[], del: string[]): Promise<void> {
    const root = this.root
    if (root === null) return
    const files: string[] = []
    for (const p of add) {
      try {
        const st = await fs.promises.lstat(path.join(root, p))
        if (st.isFile() || st.isSymbolicLink()) files.push(p)
      } catch {
        // gone again
      }
    }
    this.finder?.patch(files, del)
  }

  private onRescan(why: RescanReason): void {
    if (!this.visible) return
    this.stats.rescans++
    if (why === 'start') {
      this.settle?.()
      // no refresh has begun since the worktree was attached: the one about to begin sees everything
      if (this.refreshTick < this.attachTick) return
    }
    this.fullDue = true
    if (why !== 'start') {
      // what moved is unknown: the merge base and the ignored list are asked for again
      this.status?.base.moved()
      this.ignoreSoon()
      if (this.finder) this.finder.stale = true
    }
    if (this.manual) return
    this.scheduler.trigger()
  }

  private onGit(g: GitChange): void {
    if (!this.visible) return
    if (g.head || g.refs) this.status?.base.moved()
    if (g.exclude || g.head) this.ignoreSoon()
    if (g.head && this.finder) this.finder.stale = true
    if (!this.manual) this.scheduler.trigger()
  }

  private onMode(mode: WatchMode): void {
    // `starting` is not news: the note says "unavailable" only once a start has failed
    if (mode === 'starting') return
    this.settle?.()
    this.mode = mode
    this.publishTreeHead()
  }

  private onReleased(): void {
    this.watch = null
    this.attachedGitDir = null
    if (!this.visible) return
    // More sessions are on screen than worktrees are followed: this one is no longer told of changes. It says so (as in
    // poll mode), is read again at each refresh trigger and followed again when next shown. It never takes a stream
    // back from another session on screen by itself (@parcel/watcher leaves native memory behind at each subscribe and
    // unsubscribe).
    this.unwatched = true
    this.publishTreeHead()
  }

  // ── status ────────────────────────────────────────────────────────────────────────────────────

  /** Window focus, the Refresh command, a finished tool: everything again. `now`: without the debounce. */
  refreshSoon(now: boolean, manual = false): void {
    if (!this.visible) return
    if (this.mode !== 'live' || !this.watch) this.status?.base.moved() // nothing said whether a ref moved
    this.fullDue = true
    if (manual) this.manual = false
    if (this.manual) return
    if (now) this.scheduler.now()
    else this.scheduler.trigger()
  }

  /** One refresh (the scheduler's run): the tree in full when that is due, then the status. Never rejects. */
  private async refresh(): Promise<void> {
    this.stats.refreshes++
    this.refreshTick = ++this.tick
    try {
      if (this.missing) {
        // the folder was not there at the last look: looked for again at every trigger, and read in full by
        // the refresh `activate` asks for once it is back
        await this.activate()
        return
      }
      if (this.gitUnknown && this.root !== null) {
        // git did not say whether this is a repository: asked again now
        await this.inspect(this.root)
        if (this.disposed || !this.visible) return
        if (this.repo) {
          if (!this.unwatched && this.attach()) this.watch?.setActive(true)
          this.loadIgnore()
          this.publishTreeHead()
        }
      }
      const full = this.fullDue
      this.fullDue = false
      const reading = full ? this.readAll() : null
      if (this.status && this.repo) await this.runStatus()
      else this.publishGit()
      await reading
    } catch (e) {
      this.d.log?.warn('files refresh failed', { session: this.id, error: String(e) })
    }
  }

  private async runStatus(): Promise<void> {
    const status = this.status
    if (!status) return
    const ac = new AbortController()
    this.statusAbort = ac
    const scope = this.scope
    let out: Awaited<ReturnType<GitStatus['snapshot']>>
    try {
      out = await status.snapshot(scope, ac.signal)
    } finally {
      if (this.statusAbort === ac) this.statusAbort = null
    }
    if (out.kind === 'cancelled' || this.disposed || status !== this.status || scope !== this.scope) return
    const next = out.snapshot
    const state = next.head.state as GitState
    if (out.error !== undefined) {
      this.d.log?.warn('git status could not be run', { session: this.id, error: out.error })
      // the usual reason: the folder was deleted. Then there is no last status to keep on screen either
      if (await this.rootGone()) return
      if (this.disposed || status !== this.status || scope !== this.scope) return
    }
    if (state === 'unavailable' && this.snapshot) {
      // The last status that worked stays on screen, marked; the next trigger tries again
      this.snapshot = { ...this.snapshot, head: { ...this.snapshot.head, state: 'unavailable' } }
    } else {
      this.snapshot = next
    }
    this.manual = state === 'tooMany' // too many changes: refreshed only when asked
    this.stats.statusMs = out.ms
    // the fsmonitor hint, where git has its daemon (not Linux's git)
    if (out.ms > this.d.fsmonitorHintMs && !this.target.useFsmonitor && !this.network && this.d.fsmonitor.hasDaemon === true) this.slow = true
    this.publishGit()
  }

  private gitHead(): GitHead {
    // no status yet: `notGit` once that is known (a directory that is gone has no repository either)
    const base: GitHead = this.snapshot?.head ?? { scope: this.scope, base: null, state: !this.known ? 'loading' : this.gitUnknown ? 'unavailable' : this.repo ? 'loading' : 'notGit' }
    return { ...base, scope: this.scope, ...(this.manual ? { manual: true } : {}), ...(this.slow ? { slow: true } : {}) }
  }

  private gitRows(): [string, GitRow][] {
    const rows: [string, GitRow][] = [[GIT_HEAD_KEY, this.gitHead()]]
    if (this.snapshot) for (const e of this.snapshot.entries.values()) rows.push([gitKey(e.path), e])
    return rows
  }

  /** Write the snapshot to the store as one delta, and tell the git facts' listeners when anything changed. */
  private publishGit(): void {
    const s = this.gitStore
    if (!s) {
      if (this.d.facts) this.d.changed(this.id)
      return
    }
    let changed = false
    const off = s.onDelta(() => void (changed = true))
    try {
      s.replace(Object.fromEntries(this.gitRows()), sameRow)
    } finally {
      off()
    }
    if (changed) this.d.changed(this.id)
  }

  setScope(scope: DiffScope): void {
    if (scope === this.scope) return
    this.scope = scope
    this.persist()
    // the rows of the other scope are not this one's: gone until the status has run
    if (this.snapshot) this.snapshot = { head: { ...this.snapshot.head, scope, base: null, state: 'loading', totals: { files: 0, added: 0, removed: 0 } }, entries: new Map(), oid: this.snapshot.oid }
    this.statusAbort?.abort()
    this.publishGit()
    if (this.visible) this.scheduler.now()
  }

  entry(rel: string): GitEntry | null {
    return this.snapshot?.entries.get(rel) ?? null
  }

  /** The commit `scope` compares against. */
  async base(scope: DiffScope): Promise<string | null> {
    await this.init()
    if (!this.status) return null
    const head = this.snapshot && this.snapshot.head.state === 'ok' ? this.snapshot.oid : await this.status.headOid()
    return (await this.status.baseOf(scope, head)).base
  }

  // ── Discard Changes ───────────────────────────────────────────────────────────────────────────

  /**
   * Undo this session's changes to one file (discard.ts); the panel hears of it at once. `said` is what the sheet was
   * written for: the scope, and the commit that scope compared against. Both must still hold at the click. The commit
   * is asked of git now, not taken from the last status (which may be older than the click): a sheet read in the
   * other scope, or before `HEAD` or the branch point moved, is refused `changed` and nothing is touched. The list is
   * then read again, so the next sheet says what holds.
   */
  async discard(rel: string, expect: DiscardAction, said: { scope: DiffScope; base: string | null }): Promise<DiscardResult> {
    await this.init()
    if (this.root === null || !this.visible) return { ok: false, refused: 'failed', detail: 'the session is not shown' }
    const status = this.status
    if (!this.repo || !status) return { ok: false, refused: 'notGit' }
    let res: DiscardResult
    try {
      let base: string | null | undefined
      if (said.scope === this.scope) {
        if (said.scope === 'branch') status.base.moved() // a ref may have moved with no event yet: the branch point is computed again
        base = (await status.baseOf(said.scope, await status.headOid())).base
      }
      res = base === undefined || base !== said.base ? { ok: false, refused: 'changed' } : await discardFile({ root: this.root, rel, base, expect, env: await this.d.env(), trashTool: this.d.trashTool })
    } catch (e) {
      res = { ok: false, refused: 'failed', detail: String(e).slice(0, L.discardDetailMaxChars) }
    }
    this.d.log?.info('discard', { session: this.id, expect, scope: said.scope, ...(res.ok ? { did: res.did } : { refused: res.refused }) })
    if (res.ok || res.refused === 'failed' || res.refused === 'changed') this.refreshSoon(true)
    return res
  }

  // ── fsmonitor ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Never implicit: only the project's setting writes `core.fsmonitor` and `core.untrackedCache`, to this worktree's
   * config alone; what that needs in the shared config, and how every write is checked and taken back, is fsmonitor.ts.
   */
  private applyFsmonitor(): Promise<void> {
    // one at a time: a setting flipped while the last change is still being written is applied after it
    const run: Promise<void> = (this.fsmonitorBusy ?? Promise.resolve()).then(() => this.writeFsmonitor()).finally(() => {
      if (this.fsmonitorBusy === run) this.fsmonitorBusy = null
    })
    this.fsmonitorBusy = run
    return run
  }

  private fsmonitorBusy: Promise<void> | null = null

  private async writeFsmonitor(): Promise<void> {
    const root = this.root
    if (root === null || !this.repo) return
    // a git with no daemon (Linux's) is never told to use one
    const want = this.target.useFsmonitor && !this.network && (await this.d.fsmonitor.supported())
    if (this.disposed || want === this.fsmonitorSet) return
    const place = { root, gitDir: this.repo.gitDir, commonDir: this.repo.commonDir }
    try {
      if (want) {
        const prior = await this.d.fsmonitor.on(place)
        if (prior === null) return // a write failed (logged there): nothing is written, nothing is claimed
        this.fsmonitorPrior = prior
      } else {
        if (!(await this.d.fsmonitor.off(place, this.fsmonitorPrior))) return
        this.fsmonitorPrior = {}
      }
      if (this.disposed) return
      this.fsmonitorSet = want
      this.persist()
      // the hint has been answered: it goes now, not with the next status (which may be a long time coming)
      if (this.slow) {
        this.slow = false
        this.publishGit()
      }
    } catch (e) {
      this.d.log?.warn('fsmonitor setting failed', { session: this.id, error: String(e) })
    }
  }

  // ── the finder ────────────────────────────────────────────────────────────────────────────────

  async find(query: string, recent: readonly string[]): Promise<FinderAnswer> {
    await this.init()
    if (this.root === null || !this.visible) return { hits: [], total: 0, truncated: false, superseded: false }
    this.finder ??= new FinderIndex({ root: this.root, git: this.repo !== null, env: this.d.env, log: this.d.log })
    // the index outlives its last query by L.finderDropMs, on screen or not (it costs 1–2 KB a path)
    this.finderDrop?.dispose()
    this.finderDrop = this.d.scope.timeout(() => {
      this.finderDrop = null
      this.dropFinder()
    }, this.d.finderDropMs)
    const changed = new Set<string>()
    if (this.snapshot) for (const e of this.snapshot.entries.values()) if (e.code !== 'D') changed.add(e.path)
    return this.finder.query(query, changed, recent)
  }
}
