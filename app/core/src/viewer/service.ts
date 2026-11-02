// The viewer's part of core: what serves `viewer.*` (protocol viewer.ts). It reads a file or a diff's sides for the
// window that asks, follows the one file each window has open, writes a file the user saves in it (save.ts), and keeps
// no contents.
//
// Visible set: every call is for the session the calling window shows and is refused for any other, and a
// window's follow ends when it shows another session or goes. A save is one of the session's file operations: it takes
// the slot a tree operation or a discard takes (files/session.ts), so none of them overlap.
//
// Following: one followed path per window, asked of the watch service (inside a subscribed worktree it
// costs no watch of its own). A change of the file, or of the session's git state (its scope, base or an entry: the
// git facts' `onChange`), moves the follow's revision on; the window's waiting `viewer.follow` call is answered at
// most L.viewerReloadPerS times a second — at once when the last answer is older than that, otherwise when the
// interval is up, with everything that changed meanwhile in one answer.

import { runProcess, systemClock, type Clock, type Disposable, type Logger, type TimerHandle } from '@kea/kit'
import { L, RpcError, type FollowResult, type Handlers, type viewerApi } from '@kea/protocol'
import type { GitFacts } from '../files/facts.ts'
import type { VisibleScope, VisibleSet } from '../platform/visible.ts'
import type { FileWatch, WatchService } from '../platform/watch/service.ts'
import { sessionFs, type FsModule } from '../files/fsImpl.ts'
import { readChanges, readDiff, type DiffFacts } from './diff.ts'
import { NOT_OPENED_BY_TYPE, opensSafely } from './openable.ts'
import { openForRead, readFile, readForEdit, resolveInside, userGroups, userId } from './read.ts'
import { saveFile, type SaveJournal } from './save.ts'
import path from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

export interface ViewerServiceOptions {
  log: Logger
  /** A session's working directory (absolute), or null for a session core does not know or one with no folder. */
  cwd(sessionId: string): string | null
  visible: VisibleSet
  watch: WatchService
  git: GitFacts
  /** Git's environment (the login shell's). */
  gitEnv(): Promise<Env>
  /**
   * `open` (`xdg-open` on Linux), which hands a file to its default app: the editor host's (editor/host.ts) — the
   * system's in the app, the harness's own under a test, where the system's must never run — or null for a core built
   * without a host: the action then answers that it is unavailable. The viewer names no tool of its own.
   */
  openTool: string | null
  /** In place of running `openTool` (a test that records). */
  openDefault?(file: string): Promise<{ ok: boolean; message: string | null }>
  /**
   * What `viewer.save` needs: the save journal (save.ts), and from the files service a session's file-operation slot
   * and its refresh after a write (files/service.ts). Absent: every save is refused (a test of the reads).
   */
  saves?: ViewerSaves
  clock?: Clock
}

export interface ViewerSaves {
  journal: SaveJournal
  /** Take the session's file-operation slot: its release, or null while a file operation, a discard or a save holds it. */
  slot(sessionId: string): (() => void) | null
  /** A save wrote one of the session's files. */
  saved(sessionId: string): void
  /** The file system calls a save makes: `sessionFs` (files/fsImpl.ts) unless a test wraps it. */
  fs?: FsModule
}

interface Follow {
  sessionId: string
  path: string
  watch: FileWatch
  /** Changes so far; the window has seen up to what its last answer said. */
  rev: number
  /** What changed since the last answer. */
  file: boolean
  git: boolean
  waiter: { seen: number; resolve: (r: FollowResult) => void } | null
  /** When the last answer went (monotonic ms); -Infinity before the first. */
  answeredAt: number
  timer: TimerHandle | null
}

const NOT_OPENED = 'The file could not be opened'

/** Run `tool` (an `open`) on `file`, as argv, with the launcher's timeout; a tool that is not there is a failed open. */
async function openWith(tool: string | null, file: string): Promise<{ ok: boolean; message: string | null }> {
  if (tool === null) return { ok: false, message: 'Opening files is not available' }
  try {
    const r = await runProcess(tool, [file], { pool: 'other', timeoutMs: L.editorLaunchTimeoutMs })
    return r.code === 0 && !r.timedOut ? { ok: true, message: null } : { ok: false, message: r.stderr.trim().split('\n').at(-1) || NOT_OPENED }
  } catch {
    return { ok: false, message: NOT_OPENED }
  }
}

export class ViewerService {
  private readonly o: ViewerServiceOptions
  private readonly clock: Clock
  // bounded: one per window connection, ended when the window shows another session or goes
  private readonly follows = new Map<VisibleScope, Follow>()
  private readonly subs: Disposable[]
  private inFlight = 0
  private saving = 0
  private disposed = false

  constructor(o: ViewerServiceOptions) {
    this.o = o
    this.clock = o.clock ?? systemClock
    this.subs = [
      // A window that shows another session, or none, or is gone, follows nothing
      o.visible.onChange((c) => {
        const f = this.follows.get(c.scope)
        if (f && f.sessionId !== c.sessionId) this.end(c.scope)
      }),
      // The session's git state changed
      o.git.onChange((sessionId) => {
        for (const f of this.follows.values()) if (f.sessionId === sessionId) this.changed(f, 'git')
      }),
    ]
  }

  /** The resource report's `core.viewer`: `journal` is the new files the save journal names (save.ts). */
  get resourceCounts(): { follows: number; waiters: number; timers: number; reads: number; saves: number; journal: number } {
    let waiters = 0
    let timers = 0
    for (const f of this.follows.values()) {
      if (f.waiter) waiters++
      if (f.timer !== null) timers++
    }
    return { follows: this.follows.size, waiters, timers, reads: this.inFlight, saves: this.saving, journal: this.o.saves?.journal.size ?? 0 }
  }

  handlers(): Handlers<typeof viewerApi> {
    return {
      'viewer.read': ({ sessionId, path: rel, source, edit }, { peer }) =>
        this.counted(() => {
          const cwd = this.cwdFor(peer, sessionId)
          const o = source ? { source } : {}
          return edit ? readForEdit(cwd, rel, edit, o) : readFile(cwd, rel, o)
        }),
      'viewer.diff': ({ sessionId, path: rel }, { peer, signal }) =>
        this.counted(async () => {
          const cwd = this.cwdFor(peer, sessionId)
          return readDiff({ cwd, env: await this.o.gitEnv(), signal }, rel, await this.facts(sessionId, rel))
        }),
      'viewer.changes': ({ sessionId, path: rel }, { peer, signal }) =>
        this.counted(async () => {
          const cwd = this.cwdFor(peer, sessionId)
          return readChanges({ cwd, env: await this.o.gitEnv(), signal }, rel, await this.facts(sessionId, rel))
        }),
      'viewer.follow': ({ sessionId, path: rel, seen }, { peer, signal }) => this.follow(peer, this.cwdFor(peer, sessionId), sessionId, rel, seen, signal),
      'viewer.unfollow': (_args, { peer }) => {
        this.end(peer)
        return { ok: true }
      },
      'viewer.openDefault': async ({ sessionId, path: rel }, { peer }) => {
        const where = await resolveInside(this.cwdFor(peer, sessionId), rel)
        if (where.state !== 'ok') return { ok: false, message: 'The file is not inside the session folder' }
        // opening must never run what a repository holds: no type that opening runs, follows, installs or mounts
        // (openable.ts), by the name asked for and by the real file's (a link with a plain name), and
        if (!opensSafely(rel) || !opensSafely(where.real)) return { ok: false, message: NOT_OPENED_BY_TYPE }
        // only a plain file that is not executable
        const opened = await openForRead(where.real)
        if (!opened) return { ok: false, message: 'The file is gone' }
        const { fh, stat } = opened
        await fh.close().catch(() => undefined)
        if (!stat.isFile() || (stat.mode & 0o111) !== 0) return { ok: false, message: 'Executable files are not opened from here' }
        return this.o.openDefault ? this.o.openDefault(where.real) : openWith(this.o.openTool, where.real)
      },
      'viewer.save': async ({ sessionId, path: rel, text, base, eol, create }, { peer }) => {
        const cwd = this.cwdFor(peer, sessionId)
        const saves = this.o.saves
        // a failure with no errno carries no words
        if (!saves) return { kind: 'refused', reason: 'io' }
        this.saving++
        try {
          const r = await saveFile(cwd, { path: rel, text, base, eol, ...(create ? { create } : {}) }, { fs: saves.fs ?? sessionFs, uid: userId(), groups: userGroups(), journal: saves.journal, slot: () => saves.slot(sessionId), wrote: () => saves.saved(sessionId) })
          // by how it ended, never by path
          this.o.log.info('save', { session: sessionId, ...(r.kind === 'refused' ? { refused: r.reason } : { kind: r.kind }), ...(create ? { create: true } : {}) })
          return r
        } finally {
          this.saving--
        }
      },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const s of this.subs.splice(0)) s.dispose()
    for (const scope of [...this.follows.keys()]) this.end(scope)
  }

  /** The working directory of `sessionId`, which the calling window must be showing. */
  private cwdFor(scope: VisibleScope, sessionId: string): string {
    if (this.o.visible.of(scope) !== sessionId) throw new RpcError('not_visible', 'the window does not show this session')
    const cwd = this.o.cwd(sessionId)
    if (cwd === null || !path.isAbsolute(cwd)) throw new RpcError('no_folder', 'the session has no folder')
    return cwd
  }

  private async facts(sessionId: string, rel: string): Promise<DiffFacts> {
    const scope = this.o.git.scope(sessionId)
    return { scope, base: await this.o.git.base(sessionId, scope), entry: this.o.git.entry(sessionId, rel) }
  }

  private async counted<T>(run: () => T | Promise<T>): Promise<T> {
    this.inFlight++
    try {
      return await run()
    } finally {
      this.inFlight--
    }
  }

  private follow(scope: VisibleScope, cwd: string, sessionId: string, rel: string, seen: number, signal: AbortSignal): Promise<FollowResult> {
    if (this.disposed) return Promise.resolve({ rev: seen, file: false, git: false, ended: true })
    let f = this.follows.get(scope)
    if (f && (f.sessionId !== sessionId || f.path !== rel)) {
      this.end(scope)
      f = undefined
    }
    if (!f) {
      const mine: Follow = { sessionId, path: rel, watch: null as unknown as FileWatch, rev: 0, file: false, git: false, waiter: null, answeredAt: -Infinity, timer: null }
      mine.watch = this.o.watch.file(path.join(cwd, rel), () => this.changed(mine, 'file'), { within: [cwd] })
      this.follows.set(scope, mine)
      f = mine
    }
    const follow = f
    // one waiting call per follow: an older one (the window asked again) is told nothing new
    follow.waiter?.resolve({ rev: follow.waiter.seen, file: false, git: false, ended: false })
    return new Promise<FollowResult>((resolve) => {
      const waiter = { seen, resolve }
      follow.waiter = waiter
      // the window gave up waiting (it cancelled the call): the follow itself stays until it follows something else
      signal.addEventListener(
        'abort',
        () => {
          if (follow.waiter !== waiter) return
          follow.waiter = null
          resolve({ rev: seen, file: false, git: false, ended: false })
        },
        { once: true },
      )
      this.answer(follow)
    })
  }

  private changed(f: Follow, what: 'file' | 'git'): void {
    f.rev++
    f[what] = true
    this.answer(f)
  }

  /** Answer the waiting call if there is news for it and the rate allows; otherwise when it does. */
  private answer(f: Follow): void {
    if (!f.waiter || f.rev <= f.waiter.seen || f.timer !== null) return
    const wait = f.answeredAt + 1000 / L.viewerReloadPerS - this.clock.now()
    if (wait > 0) {
      f.timer = this.clock.setTimeout(() => {
        f.timer = null
        this.answer(f)
      }, wait)
      return
    }
    const { resolve } = f.waiter
    f.waiter = null
    f.answeredAt = this.clock.now()
    // a follow the window asks about for the first time after changes it never saw: both may have changed
    const r: FollowResult = { rev: f.rev, file: f.file, git: f.git, ended: false }
    f.file = false
    f.git = false
    resolve(r)
  }

  private end(scope: VisibleScope): void {
    const f = this.follows.get(scope)
    if (!f) return
    this.follows.delete(scope)
    f.watch.dispose()
    if (f.timer !== null) this.clock.clearTimeout(f.timer)
    f.timer = null
    f.waiter?.resolve({ rev: f.rev, file: false, git: false, ended: true })
    f.waiter = null
  }
}
