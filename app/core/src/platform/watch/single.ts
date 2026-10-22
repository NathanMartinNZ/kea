// Single files and single directories followed outside a worktree's stream: the agent's status file and transcript,
// settings.json, a file the viewer shows in a worktree that has no stream. The watch service (watcher.ts) owns the one
// instance; nothing else calls `fs.watch`.
//
// Never polls: a regular file that exists is watched itself (kqueue: in-place writes, appends); one that does not exist
// yet is found by watching its nearest existing ancestor directory, re-resolved at every event there on the way to the
// file. That watch is recursive (FSEvents), because the events that say a directory on the way appeared can be lost:
// the creation can land before the watch starts (re-resolved once the watch is up), or while the process's directory
// stream restarts for another watch; then the file's next write, however deep, still moves the watch onto it
// (U-AGT-20). The paths are partly the agent's to choose, so an ancestor is watched recursively only inside the roots
// the caller names (the agent's config folder) and never at the home directory or above: anywhere else the watch is not
// recursive, and a path an agent chose cannot make core hear a whole volume (U-AGT-30). There a lost event leaves
// nothing deeper to hear, so the caller asks the watch to `look` again when it has a sign the file may be there (its
// agent's hooks or output, U-AGT-35); a watch on its file ignores that. And a file that appears while the stream
// restarts may never be written again (settings.json saved once; a transcript whose last record is the interrupt), so
// every file still waited for is looked for once more after each restart, as the directories below are (U-FT-19). A
// file's own watch is a kqueue event, not part of that stream: it loses nothing to a restart. A file is watched through
// the descriptor it was opened and checked on without waiting: a FIFO or a device in its place, even one swapped in a
// moment later, never blocks the thread (its folder is watched instead). A file that is removed falls back to its
// directory the same way; one that is replaced (a rename over it: an editor's atomic save) is watched again on the
// inode that took its place (U-FT-8). Every change calls `onChange` once, from the event loop's next check phase
// (several kernel events for one write are one call), and only once the watch listens again: libuv watches a file with
// a one-shot kqueue event that it re-arms after the event's callback has returned, and starts a new watch only at the
// loop's next poll, so a read made sooner would miss a write landing in between, the agent's next status among them
// (U-AGT-33, U-AGT-34). Read-only: nothing is ever written.
//
// A directory's own entries (`dir`): one non-recursive `fs.watch` on it. A directory that does not exist yet (a
// worktree still being created) is waited for on its nearest existing ancestor, that folder's own entries only and
// never recursively, stepping down as each folder on the way appears; its appearance is reported. macOS tells a
// directory's own watch nothing when the directory is removed (measured: no event, no error), so its parent is listened
// to as well, for that one name: the removal is reported and the directory waited for again (U-FT-11). A removal that
// takes the parent with it is noticed only at the next look. All of a process's directory watches share one FSEvents
// stream that libuv restarts whenever one is added or removed, losing what was not delivered yet, so after each such
// change every followed directory is looked at once more: one that differs from what was last seen (its inode and
// change times) is reported, and one still waited for is looked for again. So is every file waited for on an ancestor
// (that watch is a directory watch too).
//
// On Linux no watch is recursive: a recursive `fs.watch` walks the tree on core's own thread and adds one
// inotify watch per file and per directory. A file still waited for steps down through its ancestors' own entries, as a
// directory does, which loses nothing there: inotify is not one-shot and each `fs.watch` is its own watch (macOS's two
// gaps have no counterpart), and a directory's removal is heard on its own watch too (U-FT-8, U-FT-11 run there).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Disposable, Logger } from '@kea/kit'
import { isAvailable, L } from '@kea/protocol'
import { coreOs } from '../../os/index.ts'
import type { FileWatch } from './service.ts'

/** This system lets an ancestor be watched recursively (macOS); never on Linux. */
const RECURSIVE_HERE = isAvailable(coreOs.watcher) && coreOs.watcher.recursiveFsWatch

export interface FileWatchOptions {
  log?: Logger
  /** Upper bound on live watches, files and directories together. */
  max: number
  /** When the directories are looked at once more after their stream (re)starts (default L.watchDirSettleMs). */
  settleMs?: number
  /** An ancestor may be watched recursively inside the caller's folders (default: this system's `watcher.recursiveFsWatch`; tests: the other system's way). */
  recursive?: boolean
}

interface Entry {
  file: string
  onChange: () => void
  /** Folders inside which an ancestor may be watched recursively. */
  within: readonly string[]
  watcher: fs.FSWatcher | null
  /** What is being watched: the file itself, or this ancestor directory. */
  target: string | null
  /** The inode the file's own watch is on (a rename over the file brings another). */
  ino: bigint | null
  scheduled: boolean
  /** A look is due once a new watch listens (after the loop's next poll). */
  settling: boolean
  /** The file as it was when its own watch began (`stampOf`): a look finding it the same reports nothing. */
  stamp: string | null
  disposed: boolean
}

interface DirEntry {
  dir: string
  onChange: () => void
  watcher: fs.FSWatcher | null
  /** While the directory itself is watched: its parent, heard for the directory's own name (its removal). */
  parent: fs.FSWatcher | null
  /** What is being watched: the directory itself, or the nearest ancestor that exists while it does not. */
  target: string | null
  /** The inode the directory's own watch is on (removed and made again, it is another). */
  ino: bigint | null
  /** The directory as last reported (`stampOf`); null while it is not there. */
  stamp: string | null
  scheduled: boolean
  disposed: boolean
}

export class SingleFileWatches {
  private readonly entries = new Set<Entry>() // bounded: FileWatchOptions.max with `dirs`
  private readonly dirs = new Set<DirEntry>() // bounded: as above, the two together
  private readonly o: FileWatchOptions
  /** A look at every followed directory, and every file waited for on one, is due. */
  private dirLook = false
  /** The one timer of `dirStreamChanged` (a single shot, started again by each change; none while nothing changes). */
  private dirSettle: NodeJS.Timeout | null = null
  private readonly settleMs: number
  private readonly recursive: boolean
  /** Watches refused because the cap was reached. */
  refused = 0

  constructor(o: FileWatchOptions) {
    this.o = o
    this.settleMs = o.settleMs ?? L.watchDirSettleMs
    this.recursive = o.recursive ?? RECURSIVE_HERE
  }

  /** Files and directories followed. */
  get size(): number {
    return this.entries.size + this.dirs.size
  }

  get counts(): { files: number; dirs: number; refused: number } {
    return { files: this.entries.size, dirs: this.dirs.size, refused: this.refused }
  }

  /**
   * Watch `file` (absolute); `onChange` after each change, including its creation and removal. `within`: the folders
   * inside which an ancestor may be watched recursively while the file does not exist yet (none: never recursive).
   */
  watch(file: string, onChange: () => void, within: readonly string[] = []): FileWatch {
    if (this.size >= this.o.max) {
      this.refused++
      this.o.log?.warn('file watch refused: cap reached', { file, max: this.o.max })
      return { dispose() {}, look() {} }
    }
    const e: Entry = { file, onChange, within, watcher: null, target: null, ino: null, scheduled: false, settling: false, stamp: null, disposed: false }
    this.entries.add(e)
    this.arm(e)
    return {
      dispose: () => this.drop(e),
      look: () => {
        if (!e.disposed && e.target !== e.file) this.event(e)
      },
    }
  }

  /**
   * Follow the entries of `dir` itself (added, removed, renamed). `dir` need not exist yet: it is waited for, and its
   * appearance and its removal are changes too. Inert only when the cap is reached.
   */
  dir(dir: string, onChange: () => void): Disposable {
    if (this.size >= this.o.max) {
      this.refused++
      this.o.log?.warn('directory watch refused: cap reached', { dir, max: this.o.max })
      return { dispose() {} }
    }
    const e: DirEntry = { dir, onChange, watcher: null, parent: null, target: null, ino: null, stamp: null, scheduled: false, disposed: false }
    this.dirs.add(e)
    this.armDir(e)
    return {
      dispose: () => {
        if (e.disposed) return
        e.disposed = true
        const had = this.closeDir(e)
        this.dirs.delete(e)
        if (had) this.dirStreamChanged()
      },
    }
  }

  /** End what a directory entry listens to; true if it listened to anything. */
  private closeDir(e: DirEntry): boolean {
    const had = e.watcher !== null || e.parent !== null
    e.watcher?.close()
    e.parent?.close()
    e.watcher = e.parent = null
    return had
  }

  /** Watch the directory if it is there, else its nearest existing ancestor, until what is watched holds still. */
  private armDir(e: DirEntry): void {
    // each pass moves the target down the path (a folder that appeared meanwhile): at most its depth
    for (let pass = e.dir.split(path.sep).length + 1; pass > 0 && !e.disposed; pass--) {
      const target = isDirectory(e.dir) ? e.dir : nearestDir(path.dirname(e.dir))
      // still on it: the same ancestor, or the same directory (removed and made again, it is another inode)
      if (target === e.target && e.watcher && (target !== e.dir || inodeOf(e.dir) === e.ino)) return
      const had = this.closeDir(e)
      e.target = target
      e.ino = null
      if (had) this.dirStreamChanged()
      if (!target) return
      const own = target === e.dir
      const gone = (w: fs.FSWatcher): void => {
        // what was listened to went away: the directory, its parent, or the ancestor it was waited for on
        if (e.watcher !== w && e.parent !== w) return
        this.closeDir(e)
        e.target = null
        this.dirEvent(e)
      }
      try {
        if (own) e.ino = inodeOf(target)
        const w = fs.watch(target, { persistent: false }, (_ev, name) => {
          if (own || onTheWay(target, name, e.dir)) this.dirEvent(e)
        })
        w.on('error', () => gone(w))
        e.watcher = w
        const up = path.dirname(target)
        if (own && up !== target) {
          const name = path.basename(target)
          const p = fs.watch(up, { persistent: false }, (_ev, changed) => {
            if (changed === null || String(changed) === name) this.dirEvent(e)
          })
          p.on('error', () => gone(p))
          e.parent = p
        }
      } catch (err) {
        this.o.log?.debug('directory watch failed', { dir: target, error: String(err) })
        this.closeDir(e)
        e.target = null
        return
      }
      this.dirStreamChanged()
      if (own) return
      // a folder on the way (or the directory) that appeared before this watch began is never reported: look again
    }
  }

  /** Something happened at what is watched: find the directory again, and say so if it is there, changed or gone. */
  private dirEvent(e: DirEntry): void {
    if (e.disposed || e.scheduled) return
    e.scheduled = true
    setImmediate(() => {
      e.scheduled = false
      if (e.disposed) return
      const wasThere = e.stamp !== null
      this.armDir(e)
      const stamp = e.target === e.dir ? stampOf(e.dir) : null
      // an ancestor's event that brought the directory no nearer is nobody's news
      if (stamp === null && !wasThere) return
      e.stamp = stamp
      e.onChange()
    })
  }

  /**
   * A directory watch was added or removed: libuv restarted the shared stream, and may have lost events. Every
   * followed directory, and every file waited for on an ancestor, is looked at twice more: after the loop's next poll,
   * and once the restarted stream has had `settleMs` to start (what happens in its first moments, a worktree made
   * just as it is asked for, a settings file saved as another watch begins, can go unheard). A look that moves a
   * watch (the file is there: its folder's watch ends) is such a change itself; it ends once nothing moves.
   */
  private dirStreamChanged(): void {
    if (this.dirs.size === 0 && !this.anyWaiting()) return
    if (this.dirSettle) clearTimeout(this.dirSettle)
    this.dirSettle = setTimeout(() => {
      this.dirSettle = null
      this.lookAtDirs()
    }, this.settleMs)
    this.dirSettle.unref()
    if (this.dirLook) return
    this.dirLook = true
    // after the loop's next poll (as `settle` below)
    setImmediate(() =>
      setImmediate(() => {
        this.dirLook = false
        this.lookAtDirs()
      }),
    )
  }

  /** Changed since it was last reported, or (still waited for) there now: `dirEvent` finds out which. */
  private lookAtDirs(): void {
    for (const e of [...this.dirs]) if (!e.disposed && stampOf(e.dir) !== e.stamp) this.dirEvent(e)
    // a file not there when last looked for: `event` re-resolves, and says so only if the watch is on the file now
    for (const e of [...this.entries]) if (!e.disposed && e.target !== e.file) this.event(e)
  }

  /** Some file is waited for on an ancestor directory (or could not be watched at all). */
  private anyWaiting(): boolean {
    for (const e of this.entries) if (e.target !== e.file) return true
    return false
  }

  private drop(e: Entry): void {
    if (e.disposed) return
    e.disposed = true
    const wasDir = e.watcher !== null && e.target !== e.file
    e.watcher?.close()
    e.watcher = null
    this.entries.delete(e)
    if (wasDir) this.dirStreamChanged()
  }

  /** Watch the file if it exists, else its nearest existing ancestor (recursively where allowed), until what is watched holds still. */
  private arm(e: Entry): void {
    // each pass moves the target down the path (a directory that appeared meanwhile): at most its depth
    for (let pass = e.file.split(path.sep).length + 1; pass > 0 && !e.disposed; pass--) {
      const target = isRegular(e.file) ? e.file : nearestDir(path.dirname(e.file))
      // still on it: the same directory, or the same file (a rename over the file brings another inode, U-FT-8)
      if (target === e.target && e.watcher && (target !== e.file || inodeOf(e.file) === e.ino)) return
      const hadDir = e.watcher !== null && e.target !== e.file
      e.watcher?.close()
      e.watcher = null
      e.target = target
      e.ino = null
      if (hadDir) this.dirStreamChanged()
      if (!target) return
      const dir = target !== e.file
      try {
        const listener = (_ev: string, name: string | Buffer | null) => {
          if (!dir || onTheWay(target, name, e.file)) this.event(e)
        }
        e.stamp = dir ? null : stampOf(target)
        let w: fs.FSWatcher | null
        if (dir) {
          w = fs.watch(target, { persistent: false, recursive: this.recursive && mayRecurse(target, e.within) }, listener)
          this.dirStreamChanged()
        } else {
          const r = watchRegular(target, listener)
          w = r?.watcher ?? null
          e.ino = r?.ino ?? null
        }
        if (!w) {
          // replaced by a special file since it was looked at: its folder, next pass
          e.target = null
          continue
        }
        const watching = w
        watching.on('error', () => {
          // the target went away (deleted directory or file): find the next one
          if (e.watcher === watching) {
            e.watcher = null
            e.target = null
            queueMicrotask(() => this.arm(e))
          }
        })
        e.watcher = watching
        this.settle(e)
      } catch (err) {
        this.o.log?.debug('file watch failed', { target, error: String(err) })
        return
      }
      if (!dir) return
      // a directory on the way (or the file) that appeared before this watch began is never reported: look again
    }
  }

  private event(e: Entry): void {
    if (e.disposed || e.scheduled) return
    e.scheduled = true
    // not in this callback: libuv re-arms the file's one-shot kqueue event only after it returns
    setImmediate(() => {
      e.scheduled = false
      if (e.disposed) return
      const wasFile = e.target === e.file
      // re-resolve: the file appeared, was replaced, or went away
      this.arm(e)
      if (wasFile || e.target === e.file) e.onChange()
    })
  }

  /**
   * A new watch hears nothing until the event loop's next poll registers it: look once that has passed, so a
   * change made meanwhile is reported like any other. A file just as it was when its watch began reports nothing (the
   * caller read it then); an ancestor's watch re-resolves, in case the file appeared meanwhile.
   */
  private settle(e: Entry): void {
    if (e.settling) return
    e.settling = true
    // the first turn's check phase can come before that poll; the second's comes after it
    setImmediate(() =>
      setImmediate(() => {
        e.settling = false
        if (e.disposed) return
        if (e.target === e.file && e.stamp !== null && stampOf(e.file) === e.stamp) return
        this.event(e)
      }),
    )
  }

  dispose(): void {
    for (const e of [...this.entries]) this.drop(e)
    for (const e of [...this.dirs]) {
      e.disposed = true
      this.closeDir(e)
    }
    this.dirs.clear()
    if (this.dirSettle) clearTimeout(this.dirSettle)
    this.dirSettle = null
  }
}

/** The home directory or one above it (`/`, `/Users`): never watched recursively, that would hear the whole disk. */
function holdsHome(dir: string): boolean {
  const home = os.homedir()
  return home === dir || home.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
}

/** A directory may be watched recursively only inside one of `within` (the agent's config folder), never at home or above. */
function mayRecurse(dir: string, within: readonly string[]): boolean {
  if (holdsHome(dir)) return false
  return within.some((r) => dir === r || dir.startsWith(r.endsWith(path.sep) ? r : r + path.sep))
}

/**
 * fs.watch on a regular file through the descriptor it was checked on: opened without waiting (a FIFO opens at once
 * with O_NONBLOCK), checked, then watched as `/dev/fd/<n>` (macOS hands the watch the same file), so a special file
 * swapped in by path between the check and the watch is never opened by the watch. Null when it is not a regular file.
 */
function watchRegular(file: string, listener: (ev: string, name: string | Buffer | null) => void): { watcher: fs.FSWatcher; ino: bigint } | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd, { bigint: true })
    if (!st.isFile()) return null
    return { watcher: fs.watch(`/dev/fd/${fd}`, { persistent: false }, listener), ino: st.ino }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** A recursive directory event concerns the file: the file itself or a directory between `dir` and it (unnamed: maybe). */
function onTheWay(dir: string, name: string | Buffer | null, file: string): boolean {
  if (name === null) return true
  const p = path.join(dir, String(name))
  return p === file || file.startsWith(p + path.sep)
}

/** Which file is there and whether it changed: inode, size and change times (stat never opens it). Null if none. */
function stampOf(p: string): string | null {
  try {
    const st = fs.statSync(p, { bigint: true })
    return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
  } catch {
    return null
  }
}

function inodeOf(p: string): bigint | null {
  try {
    return fs.statSync(p, { bigint: true }).ino
  } catch {
    return null
  }
}

/** A regular file there (through symlinks): a FIFO, a device or a directory is not watched as the file. */
function isRegular(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function nearestDir(dir: string): string | null {
  let d = dir
  for (;;) {
    try {
      if (fs.statSync(d).isDirectory()) return d
    } catch {
      // not there: go up
    }
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}
