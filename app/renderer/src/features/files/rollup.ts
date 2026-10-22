// Folder roll-ups for the tree's decorations: each folder shows the colour of the strongest change below it and can say
// how many there are. The counters are kept per directory and by status class; a status delta touches only the changed
// paths' ancestors (O(depth) each), never the whole tree.
//
// Strength: conflict > deleted > modified > added or untracked > renamed. A deleted file has no row of its own in
// the tree (it is not on disk), but it counts in its folders.

import type { GitCode, GitEntry } from '@kea/protocol'

export const STATUS_CLASSES = ['conflict', 'deleted', 'modified', 'added', 'renamed'] as const
/** Strongest first. */
export type StatusClass = (typeof STATUS_CLASSES)[number]

export function classOf(code: GitCode): StatusClass {
  switch (code) {
    case '!':
      return 'conflict'
    case 'D':
      return 'deleted'
    case 'M':
      return 'modified'
    case 'A':
    case 'U':
      return 'added'
    case 'R':
      return 'renamed'
  }
}

type Counts = Record<StatusClass, number>

/** `a/b/c.ts` → `a/b`, `a`, `` (the root), innermost first. */
export function ancestors(path: string): string[] {
  const out: string[] = []
  for (let cut = path.lastIndexOf('/'); cut >= 0; cut = path.lastIndexOf('/', cut - 1)) out.push(path.slice(0, cut))
  out.push('')
  return out
}

export class Rollup {
  // bounded: the directories above the status's entries (≤ L.gitStatusEntriesMax × depth); emptied with the status
  // (each holds its changed files' counts by status class)
  private readonly dirs = new Map<string, Counts>()
  // bounded: the status's entries (≤ L.gitStatusEntriesMax)
  private readonly files = new Map<string, StatusClass>()
  /** Directory counters touched by the last `apply` (tests: only ancestors of what changed). */
  touched = 0

  static of(entries: Iterable<Pick<GitEntry, 'path' | 'code'>>): Rollup {
    const r = new Rollup()
    r.apply(entries, [])
    return r
  }

  get size(): number {
    return this.files.size
  }

  private bump(path: string, cls: StatusClass, by: 1 | -1, changed: Set<string>): void {
    for (const dir of ancestors(path)) {
      let c = this.dirs.get(dir)
      if (!c) this.dirs.set(dir, (c = { conflict: 0, deleted: 0, modified: 0, added: 0, renamed: 0 }))
      c[cls] += by
      this.touched++
      changed.add(dir)
      if (by < 0 && STATUS_CLASSES.every((k) => (c as Counts)[k] === 0)) this.dirs.delete(dir)
    }
  }

  /**
   * Apply a delta of the status: entries that are new or changed, and paths that are no longer changed. Returns the
   * directories whose roll-up may show differently now.
   */
  apply(set: Iterable<Pick<GitEntry, 'path' | 'code'>>, del: Iterable<string>): Set<string> {
    this.touched = 0
    const changed = new Set<string>()
    for (const path of del) {
      const was = this.files.get(path)
      if (was === undefined) continue
      this.files.delete(path)
      this.bump(path, was, -1, changed)
    }
    for (const e of set) {
      const cls = classOf(e.code)
      const was = this.files.get(e.path)
      if (was === cls) continue
      if (was !== undefined) this.bump(e.path, was, -1, changed)
      this.files.set(e.path, cls)
      this.bump(e.path, cls, 1, changed)
    }
    return changed
  }

  clear(): void {
    this.dirs.clear()
    this.files.clear()
  }

  /** A changed file's class; null for an unchanged path. */
  file(path: string): StatusClass | null {
    return this.files.get(path) ?? null
  }

  /** A folder's colour: the strongest class among the changes below it; null when there are none. */
  folder(dir: string): StatusClass | null {
    const c = this.dirs.get(dir)
    if (!c) return null
    for (const k of STATUS_CLASSES) if (c[k] > 0) return k
    return null
  }

  /** How many changes lie below a folder (deleted files included), in all and per class. */
  counts(dir: string): Counts & { total: number } {
    const c = this.dirs.get(dir) ?? { conflict: 0, deleted: 0, modified: 0, added: 0, renamed: 0 }
    return { ...c, total: c.conflict + c.deleted + c.modified + c.added + c.renamed }
  }

  /** Every directory with a roll-up and its counters (tests compare two roll-ups with it). */
  snapshot(): Record<string, Counts> {
    return Object.fromEntries([...this.dirs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, { ...v }]))
  }
}
