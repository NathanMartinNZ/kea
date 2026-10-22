// Paths that come from outside core, checked before anything is done with them.
//
//   insideDir       a path relative to a session's working directory (or a project's root), for `editor.open`: it
//                   exists and its real path stays inside the directory
//   resolveLinks    file references printed in a terminal: relative to the working directory, absolute, `~/…`
//                   or a `file:` URL. Each is answered with the path relative to the working directory when it is a
//                   file whose real path stays inside it, else null: terminal output is untrusted, so a reference
//                   that climbs out (`../`), or reaches out through a symbolic link, is not a link. The checks are
//                   rationed (`PathChecks`): a path on a volume that no longer answers must not hold core's file calls.

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemClock, type Clock } from '@kea/kit'
import { isAvailable, isWorktreePath, L } from '@kea/protocol'
import { coreOs } from '../os/index.ts'

const within = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep)

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
function absoluteOf(cwd: string, candidate: string, home: string): string | null {
  if (candidate.includes('\0')) return null
  if (/^file:/i.test(candidate)) return fileUrlPath(candidate)
  if (candidate === '~' || candidate.startsWith('~/')) return path.join(home, candidate.slice(1))
  return path.resolve(cwd, candidate)
}

/** The file calls a check makes, replaceable in a test (one that never answers). */
export interface PathFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ isFile(): boolean }>
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

/** One check: asked of the disk when its turn comes, answered once (by the disk, its deadline, or `dispose`). */
interface Job {
  place: string
  run: () => Promise<unknown>
  onDisk: boolean
  answered: boolean
  finish: (v: unknown) => void
}

/**
 * The checks of the paths a terminal prints. Terminal output is untrusted and may name any path: one on a volume that
 * no longer answers (a network share that went away) holds the file call that asks about it, and core's file calls
 * share libuv's four threads. So the checks are rationed:
 *
 *   · at most L.terminalLinkChecksInFlightMax are on disk at once, one per place (placeOf), each one file call at a
 *     time; at most L.terminalLinkChecksWaitingMax wait their turn, one more is "not a file" at once;
 *   · a request is answered L.terminalLinkCheckDeadlineMs after it was made at the latest: what the disk has not
 *     answered by then is "not a file";
 *   · a check given up on keeps its place in flight until the system answers it (the call cannot be taken back), and
 *     its place is left alone meanwhile, with everything under it. With every place in flight held that way nothing
 *     is checked at all: links are off, core's other file calls go on;
 *   · a check answered within L.terminalLinkHungAfterMs of being given up on was only slow (a busy disk): its place
 *     is checked again by the next request. Only one answered later than that hung, and only its place is left alone
 *     for L.terminalLinkHungPlaceMs more.
 */
export class PathChecks {
  private readonly fs: PathFs
  private readonly clock: Clock
  /** The checks on disk, by place. */
  private readonly active = new Map<string, Job>() // bounded: L.terminalLinkChecksInFlightMax
  /** The places of `active` whose check was given up on at its deadline and is still not answered by the system: when. */
  private readonly stuck = new Map<string, number>() // bounded: a subset of `active`'s keys
  /** Checks waiting for a place in flight, or for the check ahead of them at their own place. */
  private readonly waiting: Job[] = [] // bounded: L.terminalLinkChecksWaitingMax, each gone at its request's deadline
  /** Places whose check hung, once the system answered: left alone until the time held here. */
  private readonly hung = new Map<string, number>() // bounded: L.terminalLinkHungPlacesMax, oldest out; each dropped L.terminalLinkHungPlaceMs after
  private disposed = false

  constructor(o: PathChecksOptions = {}) {
    this.fs = o.fs ?? fsp
    this.clock = o.clock ?? systemClock
  }

  /** The resource report's numbers (with the editors' gauge). */
  get counts(): { inFlight: number; waiting: number; hung: number } {
    return { inFlight: this.active.size, waiting: this.waiting.length, hung: this.stuck.size + this.hung.size }
  }

  /** Answers what is still asked with "not a file"; a call the system has not answered ends by itself, unheard. */
  dispose(): void {
    this.disposed = true
    for (const job of this.waiting.splice(0)) job.finish(null)
    for (const job of this.active.values()) job.finish(null)
    this.hung.clear()
  }

  /**
   * Which of `candidates` are files of the working directory `cwd`. One answer per candidate, in order: the path
   * relative to `cwd`, or null.
   */
  async resolveLinks(cwd: string, candidates: readonly string[], home: string = os.homedir()): Promise<(string | null)[]> {
    const none = (): null[] => candidates.map(() => null)
    if (this.disposed) return none()
    const now = this.clock.now()
    for (const [place, until] of this.hung) if (until <= now) this.hung.delete(place)
    const mine = new Set<Job>() // bounded: this request's checks (its directory, then L.terminalLinkCandidatesMax candidates)
    const deadline = this.clock.setTimeout(() => {
      for (const job of [...mine]) this.giveUp(job)
    }, L.terminalLinkCheckDeadlineMs)
    try {
      const base = path.resolve(cwd)
      const root = await this.check(mine, base, placeOf(base, true), () => this.fs.realpath(cwd))
      if (root === null) return none()
      return await Promise.all(
        candidates.map(async (c) => {
          const abs = absoluteOf(base, c, home)
          if (abs === null) return null
          const real = await this.check(mine, abs, placeOf(abs, false), async () => {
            const real = await this.fs.realpath(abs)
            if (!within(root, real) || real === root) return null
            return (await this.fs.stat(real)).isFile() ? real : null
          })
          if (real === null) return null
          // as written when that is inside the directory (a link inside it keeps its own name); else by its real path
          // (the directory itself was named through a link, `/tmp/…` for `/private/tmp/…`)
          const rel = within(base, abs) ? path.relative(base, abs) : path.relative(root, real)
          return isWorktreePath(rel) ? rel : null
        }),
      )
    } finally {
      this.clock.clearTimeout(deadline)
    }
  }

  /** `run`'s answer once its turn has come; null when it failed, was not let onto the disk, or was given up on. */
  private check<T>(mine: Set<Job>, abs: string, place: string, run: () => Promise<T | null>): Promise<T | null> {
    if (this.disposed || this.leftAlone(abs) || this.stuck.size >= L.terminalLinkChecksInFlightMax) return Promise.resolve(null)
    return new Promise<T | null>((resolve) => {
      const job: Job = {
        place,
        run,
        onDisk: false,
        answered: false,
        finish: (v) => {
          if (job.answered) return
          job.answered = true
          mine.delete(job)
          resolve(v as T | null)
        },
      }
      mine.add(job)
      this.waiting.push(job)
      this.pump()
      // still waiting, and one more than may wait: this one is not checked
      if (!job.onDisk && this.waiting.length > L.terminalLinkChecksWaitingMax) {
        this.waiting.splice(this.waiting.indexOf(job), 1)
        job.finish(null)
      }
    })
  }

  /** The path lies in a place whose check hung: not answered yet, or answered less than its time ago. */
  private leftAlone(abs: string): boolean {
    for (const place of this.stuck.keys()) if (within(place, abs)) return true
    for (const place of this.hung.keys()) if (within(place, abs)) return true
    return false
  }

  /** Puts waiting checks on disk while a place in flight is free: the first of each place that has none there. */
  private pump(): void {
    for (let i = 0; i < this.waiting.length && this.active.size < L.terminalLinkChecksInFlightMax; ) {
      const job = this.waiting[i] as Job
      if (this.active.has(job.place)) {
        i++
        continue
      }
      this.waiting.splice(i, 1)
      this.start(job)
    }
  }

  private start(job: Job): void {
    job.onDisk = true
    this.active.set(job.place, job)
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

  /** The system answered (a file, not a file, an error: all the same here). */
  private settled(job: Job, v: unknown): void {
    this.active.delete(job.place)
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

  /** The request's deadline: a waiting check is dropped; one on disk keeps its place, which is left alone from now. */
  private giveUp(job: Job): void {
    if (job.answered) return
    if (!job.onDisk) {
      const at = this.waiting.indexOf(job)
      if (at >= 0) this.waiting.splice(at, 1)
      job.finish(null)
      return
    }
    this.stuck.set(job.place, this.clock.now())
    job.finish(null)
    // what waits for that place, or for a place in flight when none is left, will not be checked
    const noneLeft = this.stuck.size >= L.terminalLinkChecksInFlightMax
    for (const other of this.waiting.filter((w) => noneLeft || w.place === job.place || within(job.place, w.place))) {
      this.waiting.splice(this.waiting.indexOf(other), 1)
      other.finish(null)
    }
  }
}
