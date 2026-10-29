// What git ignores in a worktree, without asking git about every row. The index holds the ignored paths that `git
// ls-files -o -i --exclude-standard --directory` listed (a whole ignored folder is one entry) and the answers of later
// `git check-ignore` batches. A path below an ignored folder is ignored without a query; a path the index knows nothing
// of is "unknown" until a batch has asked.

import { L } from '@kea/protocol'

export type IgnoreAnswer = 'ignored' | 'not' | 'unknown'

export class IgnoreIndex {
  // bounded: L.dirCacheEntriesMax paths in all (dirs + files + clear); past it nothing more is remembered and `partial` is set
  private readonly dirs = new Set<string>()
  private readonly files = new Set<string>() // bounded: with `dirs`
  /** Paths a check said are not ignored. */
  private readonly clear = new Set<string>() // bounded: with `dirs`
  /** The list was cut (git's byte cap) or the index is full: an unlisted path is unknown, not "not ignored". */
  partial = false
  /** The list has been loaded at least once. */
  loaded = false
  private readonly max: number

  constructor(max: number = L.dirCacheEntriesMax) {
    this.max = max
  }

  get size(): number {
    return this.dirs.size + this.files.size + this.clear.size
  }

  private room(): boolean {
    if (this.size < this.max) return true
    this.partial = true
    return false
  }

  /** One entry of the ignored list: `dir/` (a whole folder) or a file. */
  addListed(entry: string): void {
    if (entry === '' || !this.room()) return
    if (entry.endsWith('/')) this.dirs.add(entry.slice(0, -1))
    else this.files.add(entry)
  }

  /** A check's answer for one path (`dir`: it is a directory, so everything below it is ignored with it). */
  addChecked(path: string, ignored: boolean, dir: boolean): void {
    if (!ignored) {
      if (this.room()) this.clear.add(path)
      return
    }
    this.clear.delete(path)
    if (!this.room()) return
    if (dir) this.dirs.add(path)
    else this.files.add(path)
  }

  /**
   * A folder moved or was renamed in the tree: what was known of it and below it is known under its new path until
   * the list is read again (the caller asks for that).
   */
  move(from: string, to: string): void {
    const pre = `${from}/`
    for (const set of [this.dirs, this.files, this.clear]) {
      for (const p of [...set]) {
        if (p !== from && !p.startsWith(pre)) continue
        set.delete(p)
        set.add(to + p.slice(from.length))
      }
    }
  }

  /** The folder at or above `path` that is ignored as a whole, if any. */
  ignoredAncestor(path: string, self = true): string | null {
    if (this.dirs.size === 0) return null
    if (self && this.dirs.has(path)) return path
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
      const up = path.slice(0, cut)
      if (this.dirs.has(up)) return up
    }
    return null
  }

  /**
   * Is `path` ignored? A path under an ignored folder is, with no query. Otherwise: listed or checked as ignored;
   * checked as not; or, when the full list is loaded, not ignored because it was not listed. A path that appeared
   * after the list was read is the caller's to check (`fresh`: do not trust the list's silence).
   */
  query(path: string, fresh = false): IgnoreAnswer {
    if (this.ignoredAncestor(path) !== null || this.files.has(path)) return 'ignored'
    if (this.clear.has(path)) return 'not'
    return this.loaded && !this.partial && !fresh ? 'not' : 'unknown'
  }

  reset(): void {
    this.dirs.clear()
    this.files.clear()
    this.clear.clear()
    this.partial = false
    this.loaded = false
  }
}
