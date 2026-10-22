// A session's loaded directories: what `tree:<sessionId>` shows, kept while the session is one of the few whose caches
// core holds. One row per expanded directory; a big directory shows its first page until asked for all of it. The cache
// holds at most L.dirCacheEntriesMax entries: past that, the directories expanded longest ago are dropped (never the
// root), and the window asks again when it wants one back.

import { L, type TreeDir, type TreeEntry } from '@kea/protocol'
import type { IgnoreIndex } from './ignore.ts'
import type { ListedEntry, Listing } from './listing.ts'

interface LoadedDir {
  path: string
  /** Every entry read (a big directory's too: the page is cut when the row is made). */
  entries: ListedEntry[]
  truncated: boolean
  showAll: boolean
  /** A counter: higher is more recently expanded or refreshed by the window. */
  used: number
}

export function childPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

export function parentPath(p: string): string {
  const cut = p.lastIndexOf('/')
  return cut < 0 ? '' : p.slice(0, cut)
}

export class TreeCache {
  // bounded: L.dirCacheEntriesMax entries over all directories
  private readonly dirs = new Map<string, LoadedDir>()
  private entryCount = 0
  private tick = 0
  private readonly max: number

  constructor(max: number = L.dirCacheEntriesMax) {
    this.max = max
  }

  get size(): number {
    return this.dirs.size
  }
  /** Entries held over all loaded directories. */
  get entries(): number {
    return this.entryCount
  }
  has(dir: string): boolean {
    return this.dirs.has(dir)
  }
  paths(): string[] {
    return [...this.dirs.keys()]
  }
  showsAll(dir: string): boolean {
    return this.dirs.get(dir)?.showAll === true
  }
  names(dir: string): ListedEntry[] | null {
    return this.dirs.get(dir)?.entries ?? null
  }

  /** The window expanded or scrolled to `dir`: it is the most recently used. */
  touch(dir: string): void {
    const d = this.dirs.get(dir)
    if (d) d.used = ++this.tick
  }

  /** Put a directory's listing in. Returns the directories dropped to stay under the cap. */
  set(dir: string, listing: Listing, o: { showAll?: boolean; touch?: boolean } = {}): string[] {
    const prev = this.dirs.get(dir)
    this.entryCount += listing.entries.length - (prev?.entries.length ?? 0)
    this.dirs.set(dir, { path: dir, entries: listing.entries, truncated: listing.truncated, showAll: o.showAll ?? prev?.showAll ?? false, used: o.touch === false && prev ? prev.used : ++this.tick })
    return this.evict(dir)
  }

  private evict(keep: string): string[] {
    const dropped: string[] = []
    while (this.entryCount > this.max) {
      let oldest: LoadedDir | null = null
      for (const d of this.dirs.values()) {
        if (d.path === '' || d.path === keep) continue
        if (!oldest || d.used < oldest.used) oldest = d
      }
      if (!oldest) break
      dropped.push(...this.remove(oldest.path))
    }
    return dropped
  }

  /** Forget `dir` and every loaded directory below it. Returns what was forgotten. */
  remove(dir: string): string[] {
    const gone: string[] = []
    const prefix = dir === '' ? '' : `${dir}/`
    for (const [p, d] of this.dirs) {
      if (dir !== '' && p !== dir && !p.startsWith(prefix)) continue
      this.entryCount -= d.entries.length
      this.dirs.delete(p)
      gone.push(p)
    }
    return gone
  }

  clear(): void {
    this.dirs.clear()
    this.entryCount = 0
  }

  /** A loaded directory's store row: its first page unless all were asked for, each entry's `ignored` set. */
  row(dir: string, ignore: IgnoreIndex | null): TreeDir | null {
    const d = this.dirs.get(dir)
    if (!d) return null
    const paged = !d.showAll && d.entries.length > L.dirBigThreshold
    const shown = paged ? d.entries.slice(0, L.dirFirstPage) : d.entries
    const inherited = ignore !== null && dir !== '' && ignore.ignoredAncestor(dir) !== null
    const entries: TreeEntry[] = shown.map((e) => ({ name: e.name, kind: e.kind, ignored: inherited || (ignore !== null && ignore.query(childPath(dir, e.name)) === 'ignored') }))
    return { path: dir, entries, total: d.entries.length, paged, truncated: d.truncated }
  }
}
