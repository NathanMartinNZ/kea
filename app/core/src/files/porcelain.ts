// `git status --porcelain=v2 -z --branch` as a stream of records: the branch headers and one entry per changed path.
// Paths are whatever bytes git printed; bytes that are not UTF-8 become replacement characters. The parser stops at
// L.gitStatusEntriesMax: what it has is then of no use (`tooMany`), and the caller kills git.

import type { GitCode } from '@kea/protocol'
import { L } from '@kea/protocol'

export interface StatusHeader {
  /** `HEAD`'s commit; null before the first commit. */
  oid: string | null
  /** The checked-out branch; null when `HEAD` is detached. */
  branch: string | null
  detached: boolean
  upstream: string | null
  /** Commits ahead of and behind the upstream, when there is one and git counted. */
  ahead: number | null
  behind: number | null
}

export interface StatusEntry {
  path: string
  /** `1` ordinary, `2` renamed or copied, `u` unmerged, `?` untracked. */
  kind: '1' | '2' | 'u' | '?'
  /** The staged (`x`) and unstaged (`y`) letters, `.` for none; `?` `?` for an untracked path. */
  x: string
  y: string
  code: GitCode
  submodule: boolean
  origPath: string | null
}

/**
 * A status entry's letter (the Uncommitted scope, where nothing better is known): unmerged is a conflict whatever its
 * two letters; untracked is `U`; a path deleted on either side is `D` (gone from the work tree, or from the index with
 * nothing in its place); a rename is `R`; a path new to the index (added, copied, or marked intent-to-add) is `A`;
 * everything else (modified, type changed, on either or both sides) is `M`.
 */
export function statusCode(kind: StatusEntry['kind'], x: string, y: string): GitCode {
  if (kind === 'u') return '!'
  if (kind === '?') return 'U'
  if (y === 'D' || x === 'D') return 'D'
  if (x === 'R' || kind === '2') return x === 'C' ? 'A' : 'R'
  if (x === 'A' || x === 'C' || y === 'A') return 'A'
  return 'M'
}

/** A path as it crosses a boundary: a nested repository's `dir/` loses its slash, and any more of them (U-GS-12). */
function cleanPath(b: Buffer): string {
  let end = b.length
  while (end > 0 && b[end - 1] === 0x2f) end-- // '/', counted from the end: linear, unlike a regex anchored at $
  return b.toString('utf8', 0, end)
}

/** The byte offset just past the `n`th space, or -1. */
function afterSpaces(b: Buffer, n: number): number {
  let at = 0
  for (let i = 0; i < n; i++) {
    at = b.indexOf(0x20, at)
    if (at < 0) return -1
    at++
  }
  return at
}

export class StatusParser {
  readonly header: StatusHeader = { oid: null, branch: null, detached: false, upstream: null, ahead: null, behind: null }
  /** Entries seen (ignored `!` records are not entries). */
  count = 0
  /** More entries than L.gitStatusEntriesMax: the parse stopped. */
  tooMany = false
  private pendingRename: StatusEntry | null = null
  private readonly onEntry: (e: StatusEntry) => void
  private readonly max: number

  constructor(onEntry: (e: StatusEntry) => void, maxEntries: number = L.gitStatusEntriesMax) {
    this.onEntry = onEntry
    this.max = maxEntries
  }

  /**
   * One NUL-terminated record. False: stop, at L.gitStatusEntriesMax entries. A record that makes no sense is skipped,
   * never thrown on.
   */
  record(rec: Buffer): boolean {
    if (this.pendingRename) {
      // a `2` entry's second record: the path it was renamed from
      const e = this.pendingRename
      this.pendingRename = null
      e.origPath = cleanPath(rec) || null
      return this.emit(e)
    }
    if (rec.length < 3 || rec[1] !== 0x20) return true
    const t = rec[0]
    if (t === 0x23) return this.head(rec.toString('utf8', 2)) // '#'
    if (t === 0x3f) return this.emit({ path: cleanPath(rec.subarray(2)), kind: '?', x: '?', y: '?', code: 'U', submodule: false, origPath: null }) // '?'
    if (t === 0x21) return true // '!': an ignored path (never asked for)
    const kind = t === 0x31 ? '1' : t === 0x32 ? '2' : t === 0x75 ? 'u' : null
    if (!kind) return true
    // `1 XY sub mH mI mW hH hI path` · `2 XY sub mH mI mW hH hI Xscore path` · `u XY sub m1 m2 m3 mW h1 h2 h3 path`
    const at = afterSpaces(rec, kind === '1' ? 8 : kind === '2' ? 9 : 10)
    if (at < 0 || at >= rec.length || rec.length < 8) return true
    const x = String.fromCharCode(rec[2] as number)
    const y = String.fromCharCode(rec[3] as number)
    const entry: StatusEntry = { path: cleanPath(rec.subarray(at)), kind, x, y, code: statusCode(kind, x, y), submodule: rec[5] === 0x53, origPath: null } // sub field `S…`
    if (kind === '2') {
      this.pendingRename = entry
      return true
    }
    return this.emit(entry)
  }

  private emit(e: StatusEntry): boolean {
    if (e.path === '') return true
    if (this.count >= this.max) {
      this.tooMany = true
      return false
    }
    this.count++
    this.onEntry(e)
    return true
  }

  private head(line: string): boolean {
    const sp = line.indexOf(' ')
    const key = sp < 0 ? line : line.slice(0, sp)
    const value = sp < 0 ? '' : line.slice(sp + 1)
    const h = this.header
    if (key === 'branch.oid') h.oid = value === '(initial)' ? null : value
    else if (key === 'branch.head') {
      h.detached = value === '(detached)'
      h.branch = h.detached ? null : value
    } else if (key === 'branch.upstream') h.upstream = value
    else if (key === 'branch.ab') {
      const m = /^\+(\d+) -(\d+)$/.exec(value)
      if (m) {
        h.ahead = Number(m[1])
        h.behind = Number(m[2])
      }
    }
    return true
  }
}
