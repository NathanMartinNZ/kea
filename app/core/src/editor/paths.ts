// Paths that come from outside core, checked before anything is done with them.
//
//   insideDir       a path relative to a session's working directory (or a project's root), for `editor.open`: it
//                   exists and its real path stays inside the directory
//   resolveLinks    file references printed in a terminal: relative to the working directory, absolute, `~/…`
//                   or a `file:` URL. Each is answered with the path relative to the working directory when it is a
//                   file whose real path stays inside it, else null: terminal output is untrusted, so a reference
//                   that climbs out (`../`), or reaches out through a symbolic link, is not a link. The checks are
//                   rationed (`PathChecks`): a path on a volume that no longer answers must not hold core's file calls.
//                   The viewer's file references (viewer/fileRefs.ts) are checked through the same rationing, with a
//                   share of their own (`begin('viewer')`).

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemClock, type Clock, type TimerHandle } from '@kea/kit'
import { isAvailable, isWorktreePath, L } from '@kea/protocol'
import { coreOs } from '../os/index.ts'

/** `p` is `root` or lies under it. */
export const within = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep)

export type Inside = { ok: true; abs: string; kind: 'file' | 'dir' } | { ok: false; why: 'missing' | 'outside' }

/** Where `rel` leads from `dir`: the path to hand an editor (not its real path), when it exists and stays inside. */
export async function insideDir(dir: string, rel: string): Promise<Inside> {
  const abs = path.join(dir, rel)
  try {
    const [root, real] = await Promise.all([fsp.realpath(dir), fsp.realpath(abs)])
    if (!within(root, real)) return { ok: false, why: 'outside' }
    const st = await fsp.stat(real)
    return { ok: true, abs, kind: st.isDirectory() ? 'dir' : 'file' }
  } catch {
    return { ok: false, why: 'missing' }
  }
}

/** A `file:` URL's path on this machine; null for another host's, or one that is not a path. */
function fileUrlPath(target: string): string | null {
  try {
    const u = new URL(target)
    if (u.protocol !== 'file:' || (u.hostname !== '' && u.hostname !== 'localhost')) return null
    u.hostname = ''
    return fileURLToPath(u)
  } catch {
    return null
  }
}

/** A printed reference as an absolute path, not yet checked. */
export function absoluteOf(cwd: string, candidate: string, home: string): string | null {
  if (candidate.includes('\0')) return null
  if (/^file:/i.test(candidate)) return fileUrlPath(candidate)
  if (candidate === '~' || candidate.startsWith('~/')) return path.join(home, candidate.slice(1))
  return path.resolve(cwd, candidate)
}

/** The file calls a check makes, replaceable in a test (one that never answers). */
export interface PathFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ isFile(): boolean }>
  /** A folder's entries, read one at a time (the viewer's workspace globs); without it no folder is listed. */
  opendir?(p: string): Promise<AsyncIterable<{ name: string; isDirectory(): boolean }>>
}

export interface PathChecksOptions {
  fs?: PathFs
  clock?: Clock
}

/**
 * Where this system mounts volumes, network shares among them (the OS layer's `mounts`: macOS `/Volumes`; Linux
 * `/media/<user>`, `/run/media/<user>` and `/mnt`): one whose check hangs is left alone as a whole. Asked once.
 */
let volumeRoots: readonly string[] | null = null

function volumes(): readonly string[] {
  volumeRoots ??= isAvailable(coreOs.mounts) ? coreOs.mounts.volumeRoots() : []
  return volumeRoots
}

/**
 * The place a check belongs to: the volume for a path under one of the system's volume folders (`/Volumes/<name>`),
 * else the folder the file is in (the folder itself, for the working directory). One check per place is on disk at a
 * time, and a place whose check hung is left alone with everything under it.
 */
function placeOf(abs: string, folder: boolean): string {
  for (const root of volumes()) {
    if (!abs.startsWith(root + path.sep)) continue
    const name = abs.slice(root.length + 1).split(path.sep, 1)[0]
    if (name) return path.join(root, name)
  }
  return folder ? abs : path.dirname(abs)
}

/** Who asks: a terminal's printed paths, or the viewer's file references. */
export type PathCaller = 'terminal' | 'viewer'

/** What a check answers when it was refused without asking the disk: not a file, but not known to be none either. */
export const NOT_CHECKED: unique symbol = Symbol('not checked')
export type NotChecked = typeof NOT_CHECKED

/** One check: asked of the disk when its turn comes, answered once (by the disk, a deadline, its request's end or `dispose`). */
interface Job {
  caller: PathCaller
  place: string
  run: () => Promise<unknown>
  onDisk: boolean
  answered: boolean
  /** A viewer check's own hang timer, from when it went on disk. */
  hang: TimerHandle | null
  finish: (v: unknown) => void
}

/**
 * A request's checks, one at a time or many: `check` puts one in the queue, `end` takes what is still waiting out of
 * it (each answers `NOT_CHECKED`). A check already on disk keeps its place, and a viewer check its hang timer, until the
 * system answers it or it is given up on.
 */
export interface PathRequest {
  /** The file calls a check makes. */
  readonly fs: PathFs
  /**
   * `run`'s answer once its turn has come at `abs`'s place (`folder`: `abs` is a folder, its own place); null when it
   * failed; `NOT_CHECKED` when it was not let onto the disk or was given up on.
   */
  check<T>(abs: string, run: () => Promise<T | null>, folder?: boolean): Promise<T | null | NotChecked>
  end(): void
}

/**
 * The checks of the paths a terminal prints and of the files the viewer's references lead to. Both are untrusted (a
 * terminal's output, a file's text) and may name any path: one on a volume that no longer answers (a network share
 * that went away) holds the file call that asks about it, and core's file calls share libuv's four threads. So the
 * checks are rationed:
 *
 *   · at most L.terminalLinkChecksInFlightMax are on disk at once, one per place (placeOf), each one file call at a
 *     time. When a place frees, a terminal's check that can use it goes first; the viewer's checks hold at most one
 *     place, stuck or not, so the terminal always keeps one;
 *   · at most L.terminalLinkChecksWaitingMax of the terminal's checks wait their turn, and L.viewerLinkChecksWaitingMax
 *     of the viewer's; one more is not checked;
 *   · a terminal's request is answered L.terminalLinkCheckDeadlineMs after it was made at the latest: what the disk
 *     has not answered by then is "not a file". A viewer check is given up L.terminalLinkCheckDeadlineMs after it went
 *     on disk, and a viewer request stops at L.viewerLinkListBudgetMs: what still waits is not checked, and a check
 *     on disk is never given up for it;
 *   · a check given up on keeps its place in flight until the system answers it (the call cannot be taken back), and
 *     its place is left alone meanwhile, with everything under it. With every place in flight held that way nothing
 *     is checked at all: links are off, core's other file calls go on. While the viewer's place is held that way, no
 *     viewer check is made;
 *   · a check answered within L.terminalLinkHungAfterMs of being given up on was only slow (a busy disk): its place
 *     is checked again by the next request. Only one answered later than that hung, and only its place is left alone
 *     for L.terminalLinkHungPlaceMs more.
 */
export class PathChecks {
  private readonly fs: PathFs
  private readonly clock: Clock
  /** The checks on disk, by place. */
  private readonly active = new Map<string, Job>() // bounded: L.terminalLinkChecksInFlightMax
  /** The places of `active` whose check was given up on and is still not answered by the system: when. */
  private readonly stuck = new Map<string, number>() // bounded: a subset of `active`'s keys
  /** Checks waiting for a place in flight, or for the check ahead of them at their own place. */
  private readonly waiting: Job[] = [] // bounded: L.terminalLinkChecksWaitingMax of the terminal's and L.viewerLinkChecksWaitingMax of the viewer's, each gone at its request's deadline or end
  /** Places whose check hung, once the system answered: left alone until the time held here. */
  private readonly hung = new Map<string, number>() // bounded: L.terminalLinkHungPlacesMax, oldest out; each dropped L.terminalLinkHungPlaceMs after
  /** The viewer's one check on disk, if any (stuck or not). */
  private viewerJob: Job | null = null
  private disposed = false

  constructor(o: PathChecksOptions = {}) {
    this.fs = o.fs ?? fsp
    this.clock = o.clock ?? systemClock
  }

  /** The resource report's numbers (with the editors' gauge). */
  get counts(): { inFlight: number; waiting: number; hung: number } {
    return { inFlight: this.active.size, waiting: this.waiting.length, hung: this.stuck.size + this.hung.size }
  }

  /** Answers what is still asked with `NOT_CHECKED`; a call the system has not answered ends by itself, unheard. */
  dispose(): void {
    this.disposed = true
    for (const job of this.waiting.splice(0)) job.finish(NOT_CHECKED)
    for (const job of this.active.values()) {
      this.clearHang(job)
      job.finish(NOT_CHECKED)
    }
    this.hung.clear()
  }

  /**
   * A request of `caller`'s. A terminal's is answered by L.terminalLinkCheckDeadlineMs at the latest; a viewer's stops
   * at L.viewerLinkListBudgetMs. `end` it once its answers are in.
   */
  begin(caller: PathCaller): PathRequest {
    const now = this.clock.now()
    for (const [place, until] of this.hung) if (until <= now) this.hung.delete(place)
    const mine = new Set<Job>() // bounded: one request's checks: a terminal's directory and L.terminalLinkCandidatesMax candidates, or one check per viewer reference (at most L.viewerLinkRefsMax at once, each of L.viewerLinkCandidatesMax in turn)
    let over = false
    const timer = this.clock.setTimeout(() => {
      over = true
      for (const job of [...mine]) {
        if (caller === 'terminal') this.giveUp(job)
        else this.withdraw(job)
      }
    }, caller === 'terminal' ? L.terminalLinkCheckDeadlineMs : L.viewerLinkListBudgetMs)
    return {
      fs: this.fs,
      check: <T>(abs: string, run: () => Promise<T | null>, folder = false): Promise<T | null | NotChecked> => {
        if (over) return Promise.resolve(NOT_CHECKED)
        return this.check(caller, mine, abs, placeOf(abs, folder), run)
      },
      end: () => {
        over = true
        this.clock.clearTimeout(timer)
        for (const job of [...mine]) this.withdraw(job)
      },
    }
  }

  /**
   * Which of `candidates` are files of the working directory `cwd`. One answer per candidate, in order: the path
   * relative to `cwd`, or null.
   */
  async resolveLinks(cwd: string, candidates: readonly string[], home: string = os.homedir()): Promise<(string | null)[]> {
    const none = (): null[] => candidates.map(() => null)
    if (this.disposed) return none()
    const req = this.begin('terminal')
    const answer = <T>(v: T | null | NotChecked): T | null => (v === NOT_CHECKED ? null : v)
    try {
      const base = path.resolve(cwd)
      const root = answer(await req.check(base, () => this.fs.realpath(cwd), true))
      if (root === null) return none()
      return await Promise.all(
        candidates.map(async (c) => {
          const abs = absoluteOf(base, c, home)
          if (abs === null) return null
          const real = answer(
            await req.check(abs, async () => {
              const real = await this.fs.realpath(abs)
              if (!within(root, real) || real === root) return null
              return (await this.fs.stat(real)).isFile() ? real : null
            }),
          )
          if (real === null) return null
          // as written when that is inside the directory (a link inside it keeps its own name); else by its real path
          // (the directory itself was named through a link, `/tmp/…` for `/private/tmp/…`)
          const rel = within(base, abs) ? path.relative(base, abs) : path.relative(root, real)
          return isWorktreePath(rel) ? rel : null
        }),
      )
    } finally {
      req.end()
    }
  }

  /** `run`'s answer once its turn has come; null when it failed; `NOT_CHECKED` when it was not let onto the disk or was given up on. */
  private check<T>(caller: PathCaller, mine: Set<Job>, abs: string, place: string, run: () => Promise<T | null>): Promise<T | null | NotChecked> {
    if (this.disposed || this.leftAlone(abs) || this.stuck.size >= L.terminalLinkChecksInFlightMax) return Promise.resolve(NOT_CHECKED)
    if (caller === 'viewer' && this.viewerJob && this.stuck.has(this.viewerJob.place)) return Promise.resolve(NOT_CHECKED)
    return new Promise<T | null | NotChecked>((resolve) => {
      const job: Job = {
        caller,
        place,
        run,
        onDisk: false,
        answered: false,
        hang: null,
        finish: (v) => {
          if (job.answered) return
          job.answered = true
          mine.delete(job)
          resolve(v as T | null | NotChecked)
        },
      }
      mine.add(job)
      this.waiting.push(job)
      this.pump()
      // still waiting, and one more than may wait: this one is not checked
      const cap = caller === 'terminal' ? L.terminalLinkChecksWaitingMax : L.viewerLinkChecksWaitingMax
      if (!job.onDisk && this.waitingOf(caller) > cap) {
        this.waiting.splice(this.waiting.indexOf(job), 1)
        job.finish(NOT_CHECKED)
      }
    })
  }

  private waitingOf(caller: PathCaller): number {
    let n = 0
    for (const job of this.waiting) if (job.caller === caller) n++
    return n
  }

  /** The path lies in a place whose check hung: not answered yet, or answered less than its time ago. */
  private leftAlone(abs: string): boolean {
    for (const place of this.stuck.keys()) if (within(place, abs)) return true
    for (const place of this.hung.keys()) if (within(place, abs)) return true
    return false
  }

  /**
   * Puts waiting checks on disk while a place in flight is free: first each terminal check whose place has none there,
   * then one viewer check while the viewer holds no place.
   */
  private pump(): void {
    for (let i = 0; i < this.waiting.length && this.active.size < L.terminalLinkChecksInFlightMax; ) {
      const job = this.waiting[i] as Job
      if (job.caller !== 'terminal' || this.active.has(job.place)) {
        i++
        continue
      }
      this.waiting.splice(i, 1)
      this.start(job)
    }
    if (this.viewerJob || this.active.size >= L.terminalLinkChecksInFlightMax) return
    const i = this.waiting.findIndex((job) => job.caller === 'viewer' && !this.active.has(job.place))
    if (i >= 0) this.start(this.waiting.splice(i, 1)[0] as Job)
  }

  private start(job: Job): void {
    job.onDisk = true
    this.active.set(job.place, job)
    if (job.caller === 'viewer') {
      this.viewerJob = job
      job.hang = this.clock.setTimeout(() => {
        job.hang = null
        this.giveUp(job)
      }, L.terminalLinkCheckDeadlineMs)
    }
    let out: Promise<unknown>
    try {
      out = job.run()
    } catch (e) {
      out = Promise.reject(e as Error)
    }
    out.then(
      (v) => this.settled(job, v),
      () => this.settled(job, null),
    )
  }

  private clearHang(job: Job): void {
    if (job.hang === null) return
    this.clock.clearTimeout(job.hang)
    job.hang = null
  }

  /** The system answered (a file, not a file, an error: all the same here). */
  private settled(job: Job, v: unknown): void {
    this.clearHang(job)
    this.active.delete(job.place)
    if (this.viewerJob === job) this.viewerJob = null
    // Given up on meanwhile. Answered soon after, the place was slow once and is checked again like any other;
    // answered well past the deadline, it hung, and is left alone a while longer
    const gaveUpAt = this.stuck.get(job.place)
    this.stuck.delete(job.place)
    if (gaveUpAt !== undefined && !this.disposed && this.clock.now() - gaveUpAt >= L.terminalLinkHungAfterMs) {
      this.hung.delete(job.place)
      this.hung.set(job.place, this.clock.now() + L.terminalLinkHungPlaceMs)
      for (const oldest of this.hung.keys()) {
        if (this.hung.size <= L.terminalLinkHungPlacesMax) break
        this.hung.delete(oldest)
      }
    }
    job.finish(v)
    this.pump()
  }

  /** Not asked any more: a waiting check leaves the queue; one on disk is answered now and keeps its place and hang timer. */
  private withdraw(job: Job): void {
    if (job.answered) return
    if (!job.onDisk) {
      const at = this.waiting.indexOf(job)
      if (at >= 0) this.waiting.splice(at, 1)
    }
    job.finish(NOT_CHECKED)
  }

  /** A deadline: a waiting check is dropped; one on disk keeps its place, which is left alone from now. */
  private giveUp(job: Job): void {
    if (!job.onDisk) {
      this.withdraw(job)
      return
    }
    if (!this.active.has(job.place) || this.active.get(job.place) !== job || this.stuck.has(job.place)) return
    this.clearHang(job)
    this.stuck.set(job.place, this.clock.now())
    job.finish(NOT_CHECKED)
    // what waits for that place, or for a place in flight when none is left, will not be checked; nor, with the
    // viewer's place stuck, any viewer check
    const noneLeft = this.stuck.size >= L.terminalLinkChecksInFlightMax
    const viewerStuck = this.viewerJob !== null && this.stuck.has(this.viewerJob.place)
    for (const other of this.waiting.filter((w) => noneLeft || w.place === job.place || within(job.place, w.place) || (viewerStuck && w.caller === 'viewer'))) {
      this.waiting.splice(this.waiting.indexOf(other), 1)
      other.finish(NOT_CHECKED)
    }
  }
}
