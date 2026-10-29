// The watch service: the one owner of every `@parcel/watcher` stream and file watch in core.
//
//   worktree(req, handlers)   a worktree followed through `@parcel/watcher` (native.ts): one stream on its root with the
//                             kernel-side exclusions (exclusions.ts; in a git work tree only what git ignores whole,
//                             asked before the stream opens and again when the answer may have changed, below), and
//                             the repository's one common-dir stream,
//                             shared by every followed worktree of that repository and counted (its `HEAD`, `index`,
//                             merge and rebase state arrive there too, since a git dir lies inside its common dir; a
//                             git dir that does not gets a small stream of its own). At most L.watchWorktreesLru
//                             worktrees are followed: following one more releases the least recently used.
//   file(path) / dir(path)    `WatchService` (service.ts): inside a followed worktree they ride on its stream (no
//                             watch of their own); elsewhere they are single watches (single.ts).
//
// Events: a worktree's raw events go through its batcher (batcher.ts) and reach the attachments that are active
// (their session is visible); for the others they only set `stale`. Git metadata events are sorted by what moved
// (`HEAD`, `index`, refs, merge / rebase state, `info/exclude`), collected for the same window, and sent the same way.
//
// Exclusions in a git work tree: what the kernel leaves out is never heard of, so a candidate directory is left out
// only while git ignores it whole (`WorktreeRequest.ignored`). The worktree's stream opens once git has said which (the
// worktree is `starting` until then, at most L.watchStartTimeoutMs; with no answer `.git` alone is left out). The
// answer is asked for again, for an active worktree, when it may have changed: a `.gitignore` anywhere in the worktree,
// `info/exclude`, `HEAD`, and the index while anything but `.git` is left out (a file added with `-f` inside an ignored
// folder). A directory that is no longer ignored whole restarts the stream without it, and everything is read again
// (`onRescan('restart')`); one that became ignored is only a saving missed, taken with the next start. In a folder
// that is not a repository the candidates are left out by name, but a `.git` only once it is there: one being made is
// heard (the folder may be becoming a repository), and the stream opens again once to leave it out.
//
// Errors: "must be re-scanned" does not end a stream: it is one `onRescan`. Any other error, and the
// watched root being deleted, ends the stream: the worktree is in poll mode until a restart L.watchRestartMs later
// succeeds (tried once, then at each poll). A start that does not answer within L.watchStartTimeoutMs, or fails, is
// poll mode too, as is a worktree on a network volume. In poll mode an active worktree gets `onRescan('poll')` every
// L.watchPollMs; while its streams work no timer runs at all.
//
// On Linux inotify's limits are met here (limits.ts): a subscription that fails with `ENOSPC`, or a
// stream that ends with it, holds the watch limit, and a backend that cannot start the instance limit. While one is
// held no stream starts: the worktrees are in poll mode, refreshed at the refresh triggers, where the limit is
// read again (`focus`, a worktree shown, the poll); one banner per launch says so. With the prebuilt binding (Kea's
// patch could not be built) no first subscription is made at the instance limit (it would hang this thread), and
// the watches a subscribe left at `ENOSPC` are freed by ending every stream and starting the followed ones again, once
// (`drain`; the patch frees them itself). The patched watcher reports the entries each tree holds: past
// L.watchEntriesMax across the followed worktrees the oldest are released as at an LRU eviction (`capEntries`),
// and one released so is followed again when it is shown and there is room for what it held.

import path from 'node:path'
import { fileName, LruCache, Scope, type Clock, type Disposable, type Logger } from '@kea/kit'
import { isAvailable, L } from '@kea/protocol'
import { coreOs, type WatchLimits } from '../../os/index.ts'
import { ChangeBatcher, type Changes } from './batcher.ts'
import { askedOfGit, COMMON_DIR_EXCLUSIONS, GIT_DIR_NAME, gitExclusions, isExcluded, pickExclusions, plainExclusions, WORKTREE_EXCLUSIONS } from './exclusions.ts'
import { WatchLimitGuard, type LimitBanners } from './limits.ts'
import { isMustRescan, isPatched, loadNativeWatcher, nativeOptions, watcherBindingPath, type NativeCallback, type NativeEvent, type NativeOptions, type NativeWatcher } from './native.ts'
import type { FileWatch, FileWatchRequest, WatchService } from './service.ts'
import { SingleFileWatches } from './single.ts'

/** `starting`: its streams are being opened. `live`: they work. `poll`: they do not, the poll stands in. */
export type WatchMode = 'starting' | 'live' | 'poll'
export type RescanReason = 'dropped' | 'overflow' | 'start' | 'restart' | 'poll'

/** What moved in a worktree's git metadata since the last report. */
export interface GitChange {
  /** `HEAD`: another branch or commit is checked out. */
  head: boolean
  /** The index: something was staged, unstaged or refreshed. */
  index: boolean
  /** A ref or `packed-refs`: a commit, a fetch, a branch made or deleted (any worktree of the repository). */
  refs: boolean
  /** A merge, rebase, cherry-pick, revert or bisect began, moved on or ended. */
  state: boolean
  /** `info/exclude`: what is ignored may have changed. */
  exclude: boolean
}

export interface WorktreeHandlers {
  /** One chunk of changed paths, relative to the root (`/`-separated; names as kit's `fileName` gives them: NFC on macOS, as stored on Linux). Only while active. */
  onChanges(changes: Changes): void
  /** Everything below the root may have changed: refresh in full. Only while active. */
  onRescan(why: RescanReason): void
  /** Only while active. */
  onGit(change: GitChange): void
  onMode(mode: WatchMode): void
  /** The worktree left the LRU: nothing more comes; attach again when it is shown. */
  onReleased(): void
}

export interface WorktreeRequest {
  /** The worktree's canonical path (realpath; NFC on macOS, as stored on Linux). */
  root: string
  /** Its git dir and the repository's common dir (canonical); null for a folder that is not a git repository. */
  gitDir: string | null
  commonDir: string | null
  /** On a network volume: no stream, poll mode. */
  network?: boolean
  /**
   * A git work tree's: of these directories of the root (names), the ones git ignores whole — ignored by its rules,
   * with nothing tracked inside — so that no status can ever report from below them. Only those, and `.git`, are
   * excluded in the kernel. Null, or a rejection: git did not say, and `.git` alone is excluded. It must not depend on
   * the consumer that passed it staying attached (another may hold the same worktree). Absent for a folder that is not
   * a repository: its candidates are excluded by name.
   */
  ignored?: (names: readonly string[]) => Promise<readonly string[] | null>
}

/** One consumer's hold on a followed worktree (a session's). */
export interface WorktreeWatch extends Disposable {
  readonly root: string
  readonly mode: WatchMode
  /** Events arrived while this was not active. */
  readonly stale: boolean
  /** Released by the LRU or disposed. */
  readonly released: boolean
  /** The consumer's session is visible (or no longer): events are delivered, or only mark it stale. Activating clears `stale`. */
  setActive(active: boolean): void
  /** Most recently used now. */
  touch(): void
}

export interface WatcherOptions {
  log?: Logger
  clock?: Clock
  /** The native watcher (tests: one that hangs, fails or is driven by hand). Default: `@parcel/watcher`'s binding. */
  native?: NativeWatcher
  /** Single files and directories followed at most (default L.watchFilesMax). */
  maxFiles?: number
  /** inotify's limits (tests: a stand-in; default the OS layer's `watcher.limits`, null where the system has none). */
  limits?: WatchLimits | null
}

const noGit = (): GitChange => ({ head: false, index: false, refs: false, state: false, exclude: false })

/** Files in a git dir that say an operation is under way (a rebase, a merge, a cherry-pick, a revert, a bisect). */
const STATE_FILES = new Set(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'])

function below(dir: string, p: string): string | null {
  return p.length > dir.length + 1 && p.startsWith(dir) && p[dir.length] === path.sep ? p.slice(dir.length + 1) : null
}

/** One native subscription: its start (with its time limit), its events, its end. */
class Stream {
  state: 'starting' | 'live' | 'dead' | 'closed' = 'starting'
  /** The native start has not answered yet (a start that hangs stays so: no second one is made beside it). */
  pending = false
  /** The entries its tree held when it started, as the patched watcher reports them; null: not reported. */
  entries: number | null = null
  /** It failed, or ended, at one of inotify's limits: the drain does not start it again. */
  limited = false
  /** Counted in `Watcher.liveNative` (subscribed, and not yet asked to end). */
  private counted = false
  /** Made by the drain's restart: it starts while the watch limit is held. */
  private readonly forced: boolean
  private readonly fn: NativeCallback
  private readonly opts: NativeOptions
  private readonly w: Watcher
  readonly dir: string
  readonly excluded: readonly string[]

  constructor(w: Watcher, dir: string, excluded: string[], sink: { events(evs: readonly NativeEvent[]): void; lost(): void; died(why: string): void }) {
    this.w = w
    this.dir = dir
    this.excluded = excluded
    this.opts = nativeOptions(excluded)
    this.forced = w.pastLimit
    // a callback that throws is fatal to the process: nothing may escape
    this.fn = (err, events) => {
      if (this.state !== 'live') return
      try {
        if (err) {
          if (isMustRescan(err)) sink.lost()
          else {
            sink.died(err.message)
            // A directory made later that the patched watcher could not watch (ENOSPC) holds the limit too
            return void w.limitMet(this, err.message)
          }
        }
        if (events.length) sink.events(events)
      } catch (e) {
        w.log?.error('watch event handling failed', { dir, error: String(e) })
      }
    }
  }

  /** Resolves true once the stream is live; false when it failed, timed out or was closed meanwhile. */
  start(): Promise<boolean> {
    const w = this.w
    w.streams++
    this.pending = true
    return new Promise<boolean>((resolve) => {
      const failed = (why: string): void => {
        this.pending = false
        w.streamGone()
        if (this.state === 'starting') this.state = 'dead'
        w.log?.debug('watcher start failed', { dir: this.dir, error: why })
        resolve(false)
      }
      const go = (): void => {
        let late = false
        const timer = w.scope.timeout(() => {
          // No answer in time. If the start still answers later, that stream is closed again.
          late = true
          if (this.state === 'starting') this.state = 'dead'
          w.log?.warn('watcher start timed out', { dir: this.dir, ms: L.watchStartTimeoutMs })
          resolve(false)
        }, L.watchStartTimeoutMs)
        let started: Promise<unknown>
        try {
          started = Promise.resolve(w.native().subscribe(this.dir, this.fn, this.opts))
        } catch (e) {
          started = Promise.reject(e)
        }
        started.then(
          (v) => {
            this.pending = false
            timer.dispose()
            // a drain under way ends every stream: one that starts meanwhile ends too, and starts after it
            if (this.state === 'starting' && !late && !w.draining) {
              this.state = 'live'
              this.entries = typeof v === 'number' ? v : null
              this.counted = true
              w.liveNative++
              return resolve(true)
            }
            // closed or given up on while it started: end it
            if (this.state === 'starting') this.state = 'dead'
            this.unsubscribe()
            resolve(false)
          },
          (e: unknown) => {
            timer.dispose()
            failed(String(e))
            // inotify's limits are known by the error's words
            w.limitMet(this, e instanceof Error ? e.message : String(e))
          },
        )
      }
      // While one of inotify's limits is held no stream starts but the drain's own
      if (w.limits.blocked && !this.forced) return failed('an inotify limit is held')
      // With the prebuilt binding, the backend's start would hang this thread at the instance limit
      if (w.guardsFirstSubscription()) {
        void w.limits.firstSubscription().then(
          (ok) => (this.state !== 'starting' ? failed('closed while the limit was looked at') : ok ? go() : failed('at the inotify instance limit')),
          (e: unknown) => failed(String(e)),
        )
        return
      }
      go()
    })
  }

  close(): void {
    const was = this.state
    this.state = 'closed'
    if (was === 'live') this.unsubscribe()
  }

  /** The stream ended by itself or is of no use any more: it is unsubscribed, and reads as dead. */
  kill(): void {
    const was = this.state
    this.state = 'dead'
    if (was === 'live') this.unsubscribe()
  }

  private unsubscribe(): void {
    const w = this.w
    if (this.counted) {
      this.counted = false
      w.liveNative--
    }
    let done: Promise<unknown>
    try {
      done = Promise.resolve(w.native().unsubscribe(this.dir, this.fn, this.opts))
    } catch (e) {
      done = Promise.reject(e)
    }
    done.catch((e: unknown) => w.log?.debug('watcher unsubscribe failed', { dir: this.dir, error: String(e) })).finally(() => w.streamGone())
  }
}

/** A file or directory followed through a worktree's stream; on a single watch of its own while no stream carries it. */
interface Rider {
  kind: 'file' | 'dir'
  path: string
  onChange: () => void
  within: readonly string[]
  sub: WorktreeSub | null
  own: FileWatch | Disposable | null
  disposed: boolean
}

class Attachment implements WorktreeWatch {
  active = false
  stale = false
  released = false
  readonly sub: WorktreeSub
  readonly h: WorktreeHandlers

  constructor(sub: WorktreeSub, h: WorktreeHandlers) {
    this.sub = sub
    this.h = h
  }
  get root(): string {
    return this.sub.root
  }
  get mode(): WatchMode {
    return this.sub.mode
  }
  setActive(active: boolean): void {
    if (this.released || this.active === active) return
    this.active = active
    if (active) this.stale = false
    this.sub.activeChanged()
  }
  touch(): void {
    if (!this.released) this.sub.w.touch(this.sub)
  }
  dispose(): void {
    if (this.released) return
    this.released = true
    this.active = false
    this.sub.detach(this)
  }
}

class WorktreeSub {
  readonly w: Watcher
  readonly root: string
  gitDir: string | null
  commonDir: string | null
  readonly network: boolean
  /** A git work tree's question to git (`WorktreeRequest.ignored`); null: not a repository. */
  ignored: WorktreeRequest['ignored'] | null
  /** The worktree's stream is waiting for git's answer before it opens: it is `starting`. */
  private opening = false
  /** Each `openStream` supersedes the one before it. */
  private openSeq = 0
  /** What the stream excludes may be out of date: git is asked again once the worktree is active and live. */
  private recheckDue = false
  private rechecking = false
  private recheckTimer: Disposable | null = null
  /** The start's time limit on git's answer while the stream waits to open. */
  private openTimer: Disposable | null = null
  /** A folder that is not a repository heard its `.git` made: the stream opens again, leaving it out. */
  private gitMadeTimer: Disposable | null = null
  mode: WatchMode = 'starting'
  // bounded: one per session attached to this worktree (FilesService holds one per session in the watch LRU)
  readonly attachments = new Set<Attachment>()
  stream: Stream | null = null
  ownGit: Stream | null = null
  common: CommonSub | null = null
  readonly batcher: ChangeBatcher
  private gitPending: GitChange | null = null
  private gitTimer: Disposable | null = null
  private poll: Disposable | null = null
  private restart: Disposable | null = null
  // bounded: by the service's file cap (Watcher.riderCount + single.size ≤ maxFiles)
  readonly fileRiders = new Map<string, Set<Rider>>()
  readonly dirRiders = new Map<string, Set<Rider>>() // bounded: as fileRiders
  private readonly riderDirty = new Set<Rider>() // bounded: the riders of this worktree
  private riderTimer: Disposable | null = null
  released = false
  private everLive = false

  constructor(w: Watcher, req: WorktreeRequest) {
    this.w = w
    this.root = req.root
    this.gitDir = req.gitDir
    this.commonDir = req.commonDir
    this.network = req.network === true
    this.ignored = req.ignored ?? null
    this.batcher = new ChangeBatcher({
      schedule: (fn, ms) => w.scope.timeout(fn, ms),
      onChanges: (c) => this.eachActive((a) => a.h.onChanges(c)),
      onRescan: () => this.eachActive((a) => a.h.onRescan('dropped')),
    })
  }

  get active(): boolean {
    for (const a of this.attachments) if (a.active) return true
    return false
  }

  private eachActive(fn: (a: Attachment) => void): void {
    for (const a of [...this.attachments]) {
      if (!a.active || a.released) continue
      try {
        fn(a)
      } catch (e) {
        this.w.log?.error('watch consumer failed', { root: this.root, error: String(e) })
      }
    }
  }

  private markStale(): void {
    for (const a of this.attachments) if (!a.active) a.stale = true
  }

  start(): void {
    if (this.network) return void this.setMode('poll')
    this.openStream()
    this.wireGit()
  }

  /**
   * What the worktree's stream leaves out in the kernel. A folder that is not a repository: the candidates by name, but
   * a `.git` only once it is there. A git work tree: `.git` and the candidates git ignores whole; `.git` alone when git
   * does not say.
   */
  private async exclusions(): Promise<string[]> {
    const ask = this.ignored
    if (!ask) return plainExclusions(this.root, WORKTREE_EXCLUSIONS)
    this.recheckDue = false // this answer is as new as any
    let whole: readonly string[] | null = null
    try {
      whole = await ask(askedOfGit(WORKTREE_EXCLUSIONS))
    } catch (e) {
      this.w.log?.debug('watch exclusions: git did not answer', { root: this.root, error: String(e) })
    }
    return gitExclusions(this.root, WORKTREE_EXCLUSIONS, whole)
  }

  /**
   * Open the worktree's stream once it is known what it leaves out: at once with `known`, or for a folder that is not
   * a repository; for a git work tree once git has answered. Until then the worktree is `starting` (`opening`).
   */
  private openStream(known?: string[]): void {
    const seq = ++this.openSeq
    this.openTimer?.dispose()
    this.openTimer = null
    // this opening decides what is left out, a `.git` made since the last one included
    this.gitMadeTimer?.dispose()
    this.gitMadeTimer = null
    this.opening = true
    const open = (excluded: string[]): void => {
      if (this.released || seq !== this.openSeq || !this.opening) return
      this.openTimer?.dispose()
      this.openTimer = null
      this.opening = false
      const stream = new Stream(this.w, this.root, excluded, {
        events: (evs) => this.events(evs),
        lost: () => this.lost(),
        died: (why) => this.streamDied(stream, why),
      })
      this.stream = stream
      void stream.start().then((ok) => {
        // The entries it holds may take the followed worktrees past their cap
        if (ok && this.stream === stream) this.w.capEntries(this)
        this.settle()
      })
    }
    if (known) return open(known)
    if (!this.ignored) return open(plainExclusions(this.root, WORKTREE_EXCLUSIONS))
    // the start's time limit holds for the question too: a git that never answers keeps no worktree `starting`
    this.openTimer = this.w.scope.timeout(() => {
      this.w.log?.warn('watch exclusions: no answer in time', { root: this.root, ms: L.watchStartTimeoutMs })
      open(gitExclusions(this.root, WORKTREE_EXCLUSIONS, null))
    }, L.watchStartTimeoutMs)
    void this.exclusions().then(open)
  }

  /**
   * What the stream leaves out may no longer be what git ignores whole. Git is asked again for an active worktree,
   * L.gitDebounceMs after the first sign (the status debounce: a burst of index writes is one question, not one
   * each); for one nobody looks at, when it is shown again.
   */
  private recheckSoon(): void {
    if (!this.ignored || this.released) return
    this.recheckDue = true
    if (!this.active) return
    this.recheckTimer ??= this.w.scope.timeout(() => {
      this.recheckTimer = null
      this.recheck()
    }, L.gitDebounceMs)
  }

  /**
   * Ask git again and compare, one question at a time. A directory the stream leaves out that git no longer ignores
   * whole must be heard: the stream is opened again without it, and what happened below it meanwhile is unknown (a
   * full refresh once it is live). A directory that became ignored is left for the next start: only a saving missed
   * (each restart costs a native stream and leaves some native memory behind).
   */
  private recheck(): void {
    const stream = this.stream
    if (!this.recheckDue || this.rechecking || this.recheckTimer || this.released || !this.ignored || !this.active || this.opening || !stream || stream.state !== 'live') return
    this.rechecking = true
    void this.exclusions().then((next) => {
      this.rechecking = false
      if (this.released) return
      if (this.stream === stream && stream.state === 'live' && !this.opening && stream.excluded.some((p) => !next.includes(p))) {
        this.w.log?.info('watch exclusions changed: the stream is opened again', { root: this.root, was: stream.excluded.length, now: next.length })
        stream.kill()
        this.markStale()
        this.openStream(next)
        this.settle()
      }
      if (this.recheckDue) this.recheckSoon()
    })
  }

  /** Attach to the repository's common-dir stream, and open one on the git dir when it lies outside. */
  wireGit(): void {
    this.unwireGit()
    if (this.released) return
    if (this.gitDir) this.w.gitDirOwner(this.gitDir, this, true)
    if (!this.commonDir) return
    this.common = this.w.acquireCommon(this.commonDir, this)
    if (this.gitDir && this.gitDir !== this.commonDir && below(this.commonDir, this.gitDir) === null) this.openOwnGit(this.gitDir)
  }

  unwireGit(): void {
    if (this.common) this.w.releaseCommon(this.common, this)
    this.common = null
    this.ownGit?.close()
    this.ownGit = null
    if (this.gitDir) this.w.gitDirOwner(this.gitDir, this, false)
  }

  private openOwnGit(gitDir: string): void {
    const own = new Stream(this.w, gitDir, pickExclusions(gitDir, COMMON_DIR_EXCLUSIONS), {
      events: (evs) => {
        for (const e of evs) {
          const rel = below(gitDir, fileName(e.path))
          if (rel !== null) this.gitDirEvent(rel)
        }
      },
      lost: () => this.git({ ...noGit(), head: true, index: true, state: true }),
      died: (why) => this.streamDied(own, why),
    })
    this.ownGit = own
    void own.start().then(() => this.settle())
  }

  /** The mode its streams add up to; consumers are told of a change, and of the moment it turns live. */
  settle(): void {
    if (this.released) return
    // a worktree stream that waits for git's answer (`opening`) stands for the one it replaces: it is starting
    const parts = [this.opening ? null : this.stream, this.ownGit, this.common?.stream].filter((s): s is Stream => !!s)
    const mode: WatchMode = this.network || parts.some((s) => s.state === 'dead' || s.state === 'closed') ? 'poll' : this.opening || parts.some((s) => s.state === 'starting') ? 'starting' : 'live'
    this.setMode(mode)
    if (mode === 'live') this.recheck()
  }

  private setMode(mode: WatchMode): void {
    const was = this.mode
    if (was === mode) return
    this.mode = mode
    if (mode === 'live') {
      this.restart?.dispose()
      this.restart = null
      // what happened while nothing listened is unknown (the gap before the first start included)
      const why: RescanReason = this.everLive ? 'restart' : 'start'
      this.everLive = true
      this.markStale()
      this.eachActive((a) => a.h.onRescan(why))
    }
    if (mode !== 'live') this.unride()
    for (const a of [...this.attachments]) {
      try {
        a.h.onMode(mode)
      } catch (e) {
        this.w.log?.error('watch consumer failed', { root: this.root, error: String(e) })
      }
    }
    this.pollChanged()
  }

  activeChanged(): void {
    if (!this.active) {
      // nobody looks: what was pending is dropped, and whoever comes back refreshes in full
      if (this.batcher.size > 0 || this.batcher.armed || this.gitPending) this.markStale()
      this.batcher.clear()
      this.gitPending = null
      this.gitTimer?.dispose()
      this.gitTimer = null
    }
    this.pollChanged()
    if (this.active) {
      this.recheck() // a sign that came while nobody looked
      // a refresh trigger: a worktree shown with an inotify limit held reads it again
      if (this.mode === 'poll') this.w.recheckLimits()
    } else {
      this.recheckTimer?.dispose()
      this.recheckTimer = null
    }
  }

  /** The poll runs only for an active worktree whose streams do not work. */
  private pollChanged(): void {
    const want = !this.released && this.mode === 'poll' && this.active
    if (want && !this.poll) {
      this.poll = this.w.scope.interval(() => {
        if (!this.network) this.tryRestart()
        this.eachActive((a) => a.h.onRescan('poll'))
      }, L.watchPollMs)
    } else if (!want && this.poll) {
      this.poll.dispose()
      this.poll = null
    }
  }

  get polling(): boolean {
    return this.poll !== null
  }
  get restarting(): boolean {
    return this.restart !== null
  }

  private events(evs: readonly NativeEvent[]): void {
    if (this.released) return
    const riders = this.fileRiders.size > 0 || this.dirRiders.size > 0
    const active = this.active
    let any = false
    for (const e of evs) {
      const p = fileName(e.path)
      if (p === this.root) {
        // the stream is dead once its root is deleted, with no error to say so
        if (e.type === 'delete') return void this.streamDied(this.stream, 'root deleted')
        continue
      }
      const rel = below(this.root, p)
      if (rel === null) continue
      any = true
      // what git ignores may have changed, and with it what the kernel may leave out
      if (this.ignored && path.basename(rel) === '.gitignore') this.recheckSoon()
      if (!this.ignored && (rel === GIT_DIR_NAME || rel.startsWith(GIT_DIR_NAME + path.sep))) this.gitMadeSoon()
      if (riders) this.ride(p)
      if (active) this.batcher.add(path.sep === '/' ? rel : rel.split(path.sep).join('/'), e.type)
    }
    if (any) this.markStale()
  }

  /**
   * A folder that is not a repository heard a path at or below its `.git` (`git init`, a clone into it, a folder made
   * by hand). Once it is a directory it is left out like any other: the stream opens again without it, once,
   * L.gitDebounceMs after the first sign, whether or not anyone looks and whatever git makes of it. Any other opening
   * meanwhile (the folder found to be a repository) decides that instead. A `.git` file changes nothing that is left out.
   */
  private gitMadeSoon(): void {
    if (this.gitMadeTimer || this.released || this.network) return
    this.gitMadeTimer = this.w.scope.timeout(() => {
      this.gitMadeTimer = null
      const stream = this.stream
      if (this.released || this.ignored || this.opening || !stream || stream.state !== 'live') return
      const next = plainExclusions(this.root, WORKTREE_EXCLUSIONS)
      if (next.length === stream.excluded.length && next.every((p, i) => p === stream.excluded[i])) return
      this.w.log?.info('a .git folder was made: the stream is opened again', { root: this.root })
      stream.kill()
      this.markStale()
      this.openStream(next)
      this.settle()
    }, L.gitDebounceMs)
  }

  private lost(): void {
    this.markStale()
    this.rideAll()
    this.recheckSoon() // a `.gitignore` may be among what was dropped
    if (this.active) this.batcher.rescan()
  }

  private streamDied(stream: Stream | null, why: string): void {
    if (this.released || !stream || stream.state !== 'live') return
    this.w.log?.warn('watcher stream ended; restarting', { dir: stream.dir, why, afterMs: L.watchRestartMs })
    stream.kill()
    this.markStale()
    this.settle()
    this.scheduleRestart()
  }

  /** One restart L.watchRestartMs after a stream ended; later tries ride on the poll. */
  scheduleRestart(): void {
    if (this.released || this.restart || this.network) return
    this.restart = this.w.scope.timeout(() => {
      this.restart = null
      this.tryRestart()
    }, L.watchRestartMs)
  }

  tryRestart(): void {
    if (this.released) return
    // While one of inotify's limits is held nothing starts; the limit is read again instead
    if (this.w.limits.blocked) return void this.w.recheckLimits()
    if (this.stream?.state === 'dead' && !this.stream.pending && !this.opening) this.openStream()
    if (this.ownGit?.state === 'dead' && !this.ownGit.pending && this.gitDir) this.openOwnGit(this.gitDir)
    this.common?.reopen()
    this.settle()
  }

  /** The inotify drain: its streams end (`afterDrain` starts them again). */
  drain(): void {
    if (this.released) return
    this.stream?.kill()
    this.ownGit?.kill()
    this.markStale()
    this.settle()
  }

  /** The drain is over: the streams it ended start again, past the limit held; not the one that met it. */
  afterDrain(): void {
    if (this.released || this.network) return
    const s = this.stream
    if (s && s.state === 'dead' && !s.pending && !s.limited && !this.opening) this.openStream([...s.excluded])
    const g = this.ownGit
    if (g && g.state === 'dead' && !g.pending && !g.limited && this.gitDir) this.openOwnGit(this.gitDir)
    this.settle()
  }

  /** The entries its tree holds, as the patched watcher reported them when its stream started; 0: not known. */
  get entries(): number {
    const s = this.stream
    return s && s.state === 'live' && s.entries !== null ? s.entries : 0
  }

  // ── git metadata ──────────────────────────────────────────────────────────────────────────────

  /** A path changed inside this worktree's git dir (relative to it). */
  gitDirEvent(rel: string): void {
    if (rel.endsWith('.lock')) return
    const top = rel.split(path.sep, 1)[0] as string
    if (rel === 'HEAD') this.git({ ...noGit(), head: true })
    else if (rel === 'index') this.git({ ...noGit(), index: true })
    else if (STATE_FILES.has(top)) this.git({ ...noGit(), state: true })
  }

  git(c: GitChange): void {
    if (this.released) return
    // what git ignores whole may have changed: its rules (`info/exclude`, another commit's `.gitignore`), or what is
    // tracked (the index: only a directory that is left out can come to hold a tracked file unheard)
    if (c.exclude || c.head || (c.index && this.excludesMore)) this.recheckSoon()
    if (!this.active) return void this.markStale()
    this.markStale()
    const p = (this.gitPending ??= noGit())
    p.head ||= c.head
    p.index ||= c.index
    p.refs ||= c.refs
    p.state ||= c.state
    p.exclude ||= c.exclude
    this.gitTimer ??= this.w.scope.timeout(() => {
      this.gitTimer = null
      const out = this.gitPending
      this.gitPending = null
      if (out) this.eachActive((a) => a.h.onGit(out))
    }, L.watchBatchMs)
  }

  /** The stream leaves out more than the repository's own `.git`: directories git ignored whole when it opened. */
  private get excludesMore(): boolean {
    const own = path.join(this.root, '.git')
    return (this.stream?.excluded ?? []).some((p) => p !== own)
  }

  /** The folder became a repository, or stopped being one: what its stream leaves out is decided again. */
  setIgnored(ignored: WorktreeRequest['ignored'] | null): void {
    const was = this.ignored
    this.ignored = ignored
    if (this.released || this.network || (was === null) === (ignored === null)) return
    const stream = this.stream
    if (this.opening) return this.openStream()
    if (stream?.state === 'live') {
      stream.kill()
      this.markStale()
      this.openStream()
    } else this.recheckDue = ignored !== null // a start under way keeps its list; compared once it is live
  }

  // ── riders (`file` and `dir` inside a followed worktree) ──────────────────────────────────────

  addRider(r: Rider): void {
    const map = r.kind === 'file' ? this.fileRiders : this.dirRiders
    let set = map.get(r.path)
    if (!set) map.set(r.path, (set = new Set()))
    set.add(r)
    r.sub = this
  }

  removeRider(r: Rider): void {
    const map = r.kind === 'file' ? this.fileRiders : this.dirRiders
    const set = map.get(r.path)
    set?.delete(r)
    if (set?.size === 0) map.delete(r.path)
    this.riderDirty.delete(r)
    r.sub = null
  }

  get riderCount(): number {
    let n = 0
    for (const s of this.fileRiders.values()) n += s.size
    for (const s of this.dirRiders.values()) n += s.size
    return n
  }

  /** `p` changed: the riders on it, on a file below it (a folder moved or removed says nothing of what it held) and on its folder. */
  private ride(p: string): void {
    const hit = this.fileRiders.get(p)
    if (hit) for (const r of hit) this.dirty(r)
    const own = this.dirRiders.get(path.dirname(p))
    if (own) for (const r of own) this.dirty(r)
    const self = this.dirRiders.get(p)
    if (self) for (const r of self) this.dirty(r)
    if (this.fileRiders.size > (hit ? 1 : 0) || this.dirRiders.size > 0) {
      const prefix = p + path.sep
      for (const [file, set] of this.fileRiders) if (file.startsWith(prefix)) for (const r of set) this.dirty(r)
      for (const [dir, set] of this.dirRiders) if (dir.startsWith(prefix)) for (const r of set) this.dirty(r)
    }
  }

  private rideAll(): void {
    for (const set of this.fileRiders.values()) for (const r of set) this.dirty(r)
    for (const set of this.dirRiders.values()) for (const r of set) this.dirty(r)
  }

  private dirty(r: Rider): void {
    this.riderDirty.add(r)
    this.riderTimer ??= this.w.scope.timeout(() => {
      this.riderTimer = null
      const due = [...this.riderDirty]
      this.riderDirty.clear()
      for (const x of due) this.w.fire(x)
    }, L.watchBatchMs)
  }

  /** The stream carries nothing any more: every rider goes onto a watch of its own, and looks once. */
  private unride(): void {
    for (const map of [this.fileRiders, this.dirRiders]) {
      for (const set of [...map.values()]) {
        for (const r of [...set]) {
          this.removeRider(r)
          this.w.own(r)
          this.w.fireSoon(r)
        }
      }
    }
  }

  // ── end ───────────────────────────────────────────────────────────────────────────────────────

  detach(a: Attachment): void {
    this.attachments.delete(a)
    if (this.attachments.size === 0) this.w.forget(this)
    else this.activeChanged()
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.unride()
    this.batcher.dispose()
    this.gitTimer?.dispose()
    this.poll?.dispose()
    this.restart?.dispose()
    this.riderTimer?.dispose()
    this.recheckTimer?.dispose()
    this.openTimer?.dispose()
    this.gitMadeTimer?.dispose()
    this.gitTimer = this.poll = this.restart = this.riderTimer = this.recheckTimer = this.openTimer = this.gitMadeTimer = null
    this.opening = false
    this.stream?.close()
    this.unwireGit()
    for (const a of [...this.attachments]) {
      a.released = true
      a.active = false
      try {
        a.h.onReleased()
      } catch (e) {
        this.w.log?.error('watch consumer failed', { root: this.root, error: String(e) })
      }
    }
    this.attachments.clear()
  }
}

/** A repository's common dir, followed once for every worktree of it that is followed. */
class CommonSub {
  stream: Stream
  // bounded: the followed worktrees of this repository (≤ L.watchWorktreesLru)
  readonly refs = new Set<WorktreeSub>()
  readonly dir: string
  private readonly w: Watcher

  constructor(w: Watcher, dir: string) {
    this.w = w
    this.dir = dir
    this.stream = this.open()
  }

  private open(): Stream {
    const stream: Stream = new Stream(this.w, this.dir, pickExclusions(this.dir, COMMON_DIR_EXCLUSIONS), {
      events: (evs) => this.events(evs),
      lost: () => {
        for (const s of this.refs) s.git({ head: true, index: true, refs: true, state: true, exclude: true })
      },
      died: (why) => this.died(stream, why),
    })
    void stream.start().then(() => {
      for (const s of [...this.refs]) s.settle()
    })
    return stream
  }

  private died(stream: Stream, why: string): void {
    if (stream.state !== 'live' || stream !== this.stream) return
    this.w.log?.warn('watcher stream ended; restarting', { dir: this.dir, why, afterMs: L.watchRestartMs })
    stream.kill()
    for (const s of [...this.refs]) {
      s.settle()
      s.scheduleRestart()
    }
  }

  reopen(): void {
    if (this.stream.state !== 'dead' || this.stream.pending) return
    this.stream = this.open()
  }

  /** The inotify drain (`WorktreeSub.drain`). */
  drain(): void {
    this.stream.kill()
    for (const s of [...this.refs]) s.settle()
  }

  afterDrain(): void {
    if (!this.stream.limited) this.reopen()
  }

  private events(evs: readonly NativeEvent[]): void {
    for (const e of evs) {
      const p = fileName(e.path)
      if (p === this.dir && e.type === 'delete') {
        // the repository's data was removed (`rm -rf .git`), often reported as that one event: whatever git says may
        // have changed for each of its worktrees, and the stream is dead, with no error to say so
        for (const s of this.refs) s.git({ head: true, index: true, refs: true, state: true, exclude: true })
        return this.died(this.stream, 'root deleted')
      }
      const rel = below(this.dir, p)
      if (rel === null || rel.endsWith('.lock')) continue
      if (rel === 'packed-refs' || rel.startsWith(`refs${path.sep}`)) {
        for (const s of this.refs) s.git({ ...noGit(), refs: true })
      } else if (rel === path.join('info', 'exclude')) {
        for (const s of this.refs) s.git({ ...noGit(), exclude: true })
      } else if (rel.startsWith(`worktrees${path.sep}`)) {
        // a linked worktree's git dir: `worktrees/<name>/…`
        const rest = rel.slice('worktrees'.length + 1)
        const cut = rest.indexOf(path.sep)
        if (cut > 0) for (const s of this.w.byGitDir.get(path.join(this.dir, 'worktrees', rest.slice(0, cut))) ?? []) s.gitDirEvent(rest.slice(cut + 1))
      } else {
        // the main worktree's git dir is the common dir itself
        for (const s of this.w.byGitDir.get(this.dir) ?? []) s.gitDirEvent(rel)
      }
    }
  }
}

export class Watcher implements WatchService {
  readonly log: Logger | undefined
  readonly scope: Scope
  private readonly single: SingleFileWatches
  private nativeImpl: NativeWatcher | null
  // bounded: L.watchWorktreesLru
  private readonly roots: LruCache<string, WorktreeSub>
  // bounded: one per repository with a followed worktree (≤ L.watchWorktreesLru)
  private readonly commons = new Map<string, CommonSub>()
  // bounded: the followed worktrees that are git repositories, by git dir (≤ L.watchWorktreesLru in all; two folders of
  // one repository followed as two roots share a git dir)
  readonly byGitDir = new Map<string, Set<WorktreeSub>>()
  // bounded: riders waiting for their one look after leaving a stream (≤ maxFiles)
  private readonly soon = new Set<Rider>()
  private soonTimer: Disposable | null = null
  private readonly maxFiles: number
  private disposed = false
  /** Native subscriptions open, opening or closing (P-FD-1). */
  streams = 0
  /** File and directory watches refused at the cap. */
  refused = 0
  /** Worktrees released by the LRU since start. */
  evictions = 0
  /** Worktrees not followed because every followed one was on screen, since start. */
  refusedWorktrees = 0
  /** inotify's limits; inert where the system has none. */
  readonly limits: WatchLimitGuard
  /** Native subscriptions made and not yet asked to end: none, and the next one may start the backend. */
  liveNative = 0
  /** The inotify drain: every stream ends; one that starts meanwhile ends too. */
  draining = false
  /** The drain's restart is making its streams: they start while the watch limit is held. */
  pastLimit = false
  /** The drain is done once per launch. */
  private drained = false
  private drainTimer: Disposable | null = null
  /** The binding is Kea's patch; null: not loaded yet. */
  private patched: boolean | null = null
  // bounded: L.watchEntriesRemembered: the entries of worktrees released at
  // the entries cap, by root, to refuse following one again while there is no room for it
  private readonly heldEntries = new LruCache<string, number>({ maxEntries: L.watchEntriesRemembered })
  /** Worktrees released, or not followed, at the entries cap, since start. */
  entriesReleased = 0

  constructor(o: WatcherOptions = {}) {
    this.log = o.log
    this.scope = new Scope('watch', o.clock ? { clock: o.clock } : {})
    this.nativeImpl = o.native ?? null
    // a test's stand-in for the binding meets no kernel limit unless it brings its own
    const os = coreOs.watcher
    this.limits = new WatchLimitGuard({ limits: o.limits !== undefined ? o.limits : !o.native && isAvailable(os) ? os.limits : null, ...(o.log ? { log: o.log } : {}) })
    this.maxFiles = o.maxFiles ?? L.watchFilesMax
    this.single = new SingleFileWatches({ ...(o.log ? { log: o.log } : {}), max: this.maxFiles })
    this.roots = new LruCache<string, WorktreeSub>({
      maxEntries: L.watchWorktreesLru,
      onEvict: (_root, sub, reason) => {
        if (reason === 'capacity') this.evictions++
        sub.release()
      },
    })
  }

  native(): NativeWatcher {
    if (!this.nativeImpl) {
      this.nativeImpl = loadNativeWatcher()
      // which copy a build loaded (a packaged app: under app.asar.unpacked), as the database does for its own
      this.log?.info('watcher binding loaded', { file: watcherBindingPath() })
    }
    return this.nativeImpl
  }

  /** The binding is Kea's patch: it frees what a failed subscription added, and rejects when its backend cannot start. */
  private get patchedBinding(): boolean {
    return (this.patched ??= isPatched(this.native()))
  }

  // ── inotify's limits ──────────────────────────────────────────────────────────────────────────

  /** Banners go to core's store (core.ts). */
  bindBanners(b: LimitBanners): void {
    this.limits.bindBanners(b)
  }

  /** Told when an inotify limit comes to be held and when it is let go: core tells main (`watchLimit`). */
  onLimitHeld(cb: (held: boolean) => void): void {
    this.limits.onHeldChange(cb)
  }

  /** No subscription is live, so the next one starts the backend, and this binding would hang at the instance limit. */
  guardsFirstSubscription(): boolean {
    if (!this.limits.applies || this.liveNative !== 0) return false
    try {
      return !this.patchedBinding
    } catch {
      // the binding does not load: no backend to hang, and the start's own subscribe fails into poll mode
      return false
    }
  }

  /**
   * `stream` failed, or ended, with `message`. One of inotify's limits, when the message names one: it is held, and with
   * the prebuilt binding the watches the failure left are freed by the drain.
   */
  limitMet(stream: Stream, message: string): void {
    const kind = this.limits.failed(message)
    if (kind === null) return
    stream.limited = true
    if (kind === 'watches' && !this.patchedBinding) this.drain()
  }

  /**
   * The prebuilt binding keeps the watches a subscription added before it failed at `ENOSPC` while any other
   * subscription of the process lives. Every stream ends, which ends the backend and its inotify instance with them;
   * once none is left (or L.watchStartTimeoutMs has passed) the ones that were followed start again, past the
   * limit held, which goes on holding for the others. Once per launch.
   */
  private drain(): void {
    if (this.drained || this.disposed) return
    this.drained = true
    this.draining = true
    this.log?.warn('watch: every stream ends and starts again, to free the watches a failed subscription left', { streams: this.streams })
    for (const [, s] of this.roots.entries()) s.drain()
    for (const c of this.commons.values()) c.drain()
    this.drainTimer = this.scope.timeout(() => this.endDrain(), L.watchStartTimeoutMs)
    if (this.streams === 0) this.endDrain()
  }

  /** A native subscription is gone: unsubscribed, or its start failed. */
  streamGone(): void {
    this.streams--
    if (this.draining && this.streams === 0) this.endDrain()
  }

  private endDrain(): void {
    if (!this.draining) return
    this.draining = false
    this.drainTimer?.dispose()
    this.drainTimer = null
    if (this.disposed) return
    this.pastLimit = true
    try {
      for (const c of this.commons.values()) c.afterDrain()
      for (const [, s] of this.roots.entries()) s.afterDrain()
    } finally {
      this.pastLimit = false
    }
  }

  /**
   * At the refresh triggers (a window focused, a worktree shown, the poll): a limit held is read again. Raised,
   * every followed worktree starts again.
   */
  recheckLimits(): void {
    if (!this.limits.blocked || this.disposed) return
    void this.limits.recheck().then((raised) => {
      if (!raised || this.disposed) return
      for (const [, s] of this.roots.entries()) s.tryRestart()
    })
  }

  /** A Kea window got keyboard focus. */
  focus(): void {
    this.recheckLimits()
  }

  // ── entries ───────────────────────────────────────────────────────────────────────────────────

  /** The entries the followed worktrees' trees hold, as the patched watcher reported them. */
  get entries(): number {
    let n = 0
    for (const [, s] of this.roots.entries()) n += s.entries
    return n
  }

  /**
   * `started`'s stream is live with the entries it reported. Past L.watchEntriesMax in all, the oldest followed
   * worktrees nobody looks at are released, as at an LRU eviction, and then, if that is not enough, `started` itself: a
   * stream is never taken from another worktree on screen. What each released one held is remembered for when it
   * is shown again.
   */
  capEntries(started: WorktreeSub): void {
    this.heldEntries.delete(started.root)
    let total = this.entries
    if (total <= L.watchEntriesMax) return
    const oldest = this.roots
      .entries()
      .reverse()
      .map(([, s]) => s)
    for (const s of [...oldest.filter((x) => x !== started && !x.active), started]) {
      if (total <= L.watchEntriesMax) break
      const n = s.entries
      if (n === 0) continue
      total -= n
      this.heldEntries.set(s.root, n)
      this.entriesReleased++
      this.log?.warn('watch: a followed worktree is released at the entries cap', { root: s.root, entries: n, total, max: L.watchEntriesMax })
      this.roots.delete(s.root)
    }
  }

  /** A worktree released at the entries cap is not followed again while what it held does not fit beside the worktrees on screen. */
  private noRoomFor(root: string): boolean {
    const held = this.heldEntries.get(root)
    if (held === undefined) return false
    let onScreen = 0
    for (const [, s] of this.roots.entries()) if (s.active) onScreen += s.entries
    return onScreen + held > L.watchEntriesMax
  }

  // ── worktrees ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Follow a worktree for one consumer. The worktree becomes the most recently used; the least recently used past the
   * cap is released, one nobody looks at before one somebody does (a session that stays on screen in one window keeps
   * its stream while another window moves through four more, I-FT-16).
   *
   * A stream is never taken from a worktree somebody is looking at. With the cap's worth of worktrees followed
   * and every one of them on screen, one more is not followed: the hold that comes back is already released, and its
   * consumer has been told (`onReleased`, before this returns), as when the LRU lets a worktree go. It asks again when
   * it is next shown (I-FT-24).
   */
  worktree(req: WorktreeRequest, handlers: WorktreeHandlers): WorktreeWatch {
    if (this.disposed) throw new Error('the watch service is closed')
    let sub = this.roots.get(req.root)
    if (!sub) {
      sub = new WorktreeSub(this, req)
      const full = this.roots.size >= L.watchWorktreesLru && this.roots.entries().every(([, s]) => s.active)
      if (full || this.noRoomFor(req.root)) {
        if (full) this.refusedWorktrees++
        else this.entriesReleased++
        const a = new Attachment(sub, handlers)
        sub.attachments.add(a)
        sub.release() // never started: nothing to close, and the consumer hears it is not followed
        return a
      }
      for (const [root, s] of this.roots.entries().reverse()) if (s.active) this.roots.get(root)
      this.roots.set(req.root, sub)
      sub.start()
    } else if (sub.gitDir !== req.gitDir || sub.commonDir !== req.commonDir) {
      // the folder became a repository (or stopped being one) since it was first followed
      sub.unwireGit()
      sub.gitDir = req.gitDir
      sub.commonDir = req.commonDir
      if (!sub.network) sub.wireGit()
      sub.setIgnored(req.ignored ?? null)
      sub.settle()
    }
    const a = new Attachment(sub, handlers)
    sub.attachments.add(a)
    return a
  }

  touch(sub: WorktreeSub): void {
    this.roots.get(sub.root)
  }

  forget(sub: WorktreeSub): void {
    if (this.roots.peek(sub.root) === sub) this.roots.delete(sub.root)
    else sub.release()
  }

  /** `sub`'s git dir is `gitDir` (or no longer). */
  gitDirOwner(gitDir: string, sub: WorktreeSub, owns: boolean): void {
    const set = this.byGitDir.get(gitDir)
    if (owns) {
      if (set) set.add(sub)
      else this.byGitDir.set(gitDir, new Set([sub]))
    } else if (set) {
      set.delete(sub)
      if (set.size === 0) this.byGitDir.delete(gitDir)
    }
  }

  acquireCommon(dir: string, sub: WorktreeSub): CommonSub {
    let c = this.commons.get(dir)
    if (!c) this.commons.set(dir, (c = new CommonSub(this, dir)))
    c.refs.add(sub)
    return c
  }

  releaseCommon(c: CommonSub, sub: WorktreeSub): void {
    c.refs.delete(sub)
    if (c.refs.size > 0) return
    c.stream.close()
    if (this.commons.get(c.dir) === c) this.commons.delete(c.dir)
  }

  /** The followed worktree whose live stream carries `p`: inside its root, outside what it excludes. */
  private carrier(p: string): WorktreeSub | null {
    for (const [, sub] of this.roots.entries()) {
      if (sub.mode !== 'live' || !sub.stream || sub.stream.state !== 'live') continue
      if (p !== sub.root && below(sub.root, p) === null) continue
      if (isExcluded(sub.stream.excluded, p)) continue
      return sub
    }
    return null
  }

  // ── single files and directories ──────────────────────────────────────────────────────────────

  private get riderCount(): number {
    let n = 0
    for (const [, sub] of this.roots.entries()) n += sub.riderCount
    return n
  }

  private follow(kind: 'file' | 'dir', p: string, onChange: () => void, within: readonly string[]): FileWatch {
    const inert: FileWatch = { dispose() {}, look() {} }
    if (this.disposed) return inert
    if (this.riderCount + this.single.size >= this.maxFiles) {
      this.refused++
      this.log?.warn('watch refused: cap reached', { path: p, max: this.maxFiles })
      return inert
    }
    const r: Rider = { kind, path: p, onChange, within, sub: null, own: null, disposed: false }
    const sub = this.carrier(p)
    if (sub) sub.addRider(r)
    else this.own(r)
    return {
      dispose: () => {
        if (r.disposed) return
        r.disposed = true
        r.sub?.removeRider(r)
        r.own?.dispose()
        r.own = null
        this.soon.delete(r)
      },
      look: () => {
        const own = r.own as Partial<FileWatch> | null
        own?.look?.()
      },
    }
  }

  /** Give a rider a watch of its own (no stream carries its path). */
  own(r: Rider): void {
    if (r.disposed) return
    r.own = r.kind === 'file' ? this.single.watch(r.path, () => this.fire(r), r.within) : this.single.dir(r.path, () => this.fire(r))
  }

  fire(r: Rider): void {
    if (r.disposed) return
    try {
      r.onChange()
    } catch (e) {
      this.log?.error('watch consumer failed', { path: r.path, error: String(e) })
    }
  }

  /** One look for a rider whose stream went: what happened meanwhile is unknown. */
  fireSoon(r: Rider): void {
    if (r.disposed || this.disposed) return
    this.soon.add(r)
    this.soonTimer ??= this.scope.timeout(() => {
      this.soonTimer = null
      const due = [...this.soon]
      this.soon.clear()
      for (const x of due) this.fire(x)
    }, L.watchBatchMs)
  }

  file(p: string, onChange: () => void, o?: FileWatchRequest): FileWatch {
    return this.follow('file', p, onChange, o?.within ?? [])
  }

  dir(p: string, onChange: () => void): Disposable {
    return this.follow('dir', p, onChange, [])
  }

  // ── the resource report (`core.watch`) ────────────────────────────────────────────────────────

  get counts(): Record<string, number> {
    let pending = 0
    let peak = 0
    let riders = 0
    let polls = 0
    let restarts = 0
    let attachments = 0
    let stale = 0
    for (const [, s] of this.roots.entries()) {
      pending += s.batcher.size
      peak = Math.max(peak, s.batcher.peak)
      riders += s.riderCount
      if (s.polling) polls++
      if (s.restarting) restarts++
      attachments += s.attachments.size
      for (const a of s.attachments) if (a.stale) stale++
    }
    const single = this.single.counts
    return {
      worktrees: this.roots.size,
      commonDirs: this.commons.size,
      streams: this.streams,
      attachments,
      stale,
      pendingEvents: pending,
      peakPendingEvents: peak,
      riders,
      files: single.files,
      dirs: single.dirs,
      polls,
      restarts,
      refused: this.refused + single.refused,
      evictions: this.evictions,
      unfollowed: this.refusedWorktrees,
      entries: this.entries,
      entriesReleased: this.entriesReleased,
      limitHeld: this.limits.blocked ? 1 : 0,
    }
  }

  /** As the other services name it (resources/gauges.ts). */
  get resourceCounts(): Record<string, number> {
    return this.counts
  }

  /** Tests: each followed worktree's root, mode and what its stream excludes in the kernel, most recently used first. */
  followed(): { root: string; mode: WatchMode; active: boolean; commonDir: string | null; excluded: readonly string[]; entries: number }[] {
    return this.roots.entries().map(([root, s]) => ({ root, mode: s.mode, active: s.active, commonDir: s.common?.dir ?? null, excluded: s.stream?.excluded ?? [], entries: s.entries }))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.roots.clear()
    this.heldEntries.clear()
    this.soon.clear()
    this.single.dispose()
    this.scope.dispose()
  }
}
