// The finder's candidate paths and their matching, as the worker thread holds them: fuzzysort on prepared targets,
// ranked by finder-rank.ts. Pure, and imported by the worker thread: nothing here may import core or protocol code.
//
// A query scans every candidate, and on a large repository most of them match a short query, so what happens per match
// decides the keystroke's cost (P-FIND-1). Three things keep it small, none of which changes the answer (U-FT-10):
//   · a match with no boost (not in the file's name, not changed, not recent) ranks by fuzzysort's score alone, so once
//     one such match has failed to enter the best `limit`, every one that scores no higher is dropped on one comparison;
//   · the rank is handed back above 1, which fuzzysort takes as it is (no conversion per match);
//   · a query that extends the last one is matched only against what the last one matched.
// The first two read two fields fuzzysort keeps on a result (`_score`, the unconverted score, and `_indexes` with its
// `len`); without them nothing is dropped early and the answer is the same, only slower. fuzzysort is pinned.

import fuzzysort, { type Prepared } from 'fuzzysort'
import { basenameStart, emptyQueryOrder, rank, type RankContext } from './finder-rank.ts'

export interface PathHit {
  path: string
  /** Indexes of the matched characters, ascending. */
  matched: number[]
}

interface Entry {
  p: Prepared
  /** Where the file's name starts in the path. */
  b: number
  /** The query that last found this path changed or recent (`PathIndex.stamp`). */
  s: number
}

type RawResult = { obj: Entry; target: string; score: number; indexes: readonly number[]; _score?: number; _indexes?: number[] & { len?: number } }

export class PathIndex {
  private readonly max: number
  // bounded: `max` (L.finderPathsMax); a path past it is dropped and `truncated` set
  private readonly targets = new Map<string, Entry>()
  private list: Entry[] | null = null
  // bounded: what the last query matched, at most every path of the index; dropped with any change to the index
  private last: { query: string; matched: Entry[] } | null = null
  private stamp = 0
  truncated = false
  /** Candidates the last query was matched against (the resource report; U-FT-10). */
  scanned = 0

  constructor(max: number) {
    this.max = max
  }

  get size(): number {
    return this.targets.size
  }

  has(p: string): boolean {
    return this.targets.has(p)
  }

  private changed(): void {
    this.list = null
    this.last = null
  }

  add(p: string): void {
    if (p === '' || this.targets.has(p)) return
    if (this.targets.size >= this.max) {
      this.truncated = true
      return
    }
    this.targets.set(p, { p: fuzzysort.prepare(p), b: basenameStart(p), s: 0 })
    this.changed()
  }

  delete(p: string): void {
    if (this.targets.delete(p)) this.changed()
  }

  /** Every path inside the folder `dir`. */
  deleteBelow(dir: string): void {
    const prefix = `${dir}/`
    for (const p of this.targets.keys()) if (p.startsWith(prefix) && this.targets.delete(p)) this.changed()
  }

  clear(): void {
    this.targets.clear()
    this.changed()
    this.truncated = false
    fuzzysort.cleanup()
  }

  /** The best `limit` paths for `query`, best first; an empty query answers the recent and the changed files. */
  query(query: string, limit: number, ctx: RankContext): PathHit[] {
    const q = query.trim()
    if (q === '') {
      this.scanned = 0
      return emptyQueryOrder(this.targets, ctx, limit).map((path) => ({ path, matched: [] }))
    }
    const stamp = ++this.stamp
    for (const p of ctx.changed) {
      const e = this.targets.get(p)
      if (e) e.s = stamp
    }
    for (const p of ctx.recent.keys()) {
      const e = this.targets.get(p)
      if (e) e.s = stamp
    }
    const from = this.last && q.startsWith(this.last.query) ? this.last.matched : (this.list ??= [...this.targets.values()])
    this.scanned = from.length
    const slash = q.includes('/')
    const matched: Entry[] = []
    /** The ranks of the best `limit` so far, ascending: `top[0]` is what a match must beat once it is full. */
    const top: number[] = []
    /** The highest fuzzysort score with which an unboosted match failed to enter `top`. */
    let floor = Number.NEGATIVE_INFINITY
    const res = fuzzysort.go(q, from, {
      key: 'p',
      limit,
      threshold: 0,
      scoreFn: (result) => {
        const r = result as unknown as RawResult
        const e = r.obj
        matched.push(e)
        const idx = r._indexes
        let first = 0
        if (idx && typeof idx.len === 'number') {
          first = idx.len ? (idx[0] as number) : 0
          for (let i = 1; i < idx.len; i++) if ((idx[i] as number) < first) first = idx[i] as number
        } else {
          const sorted = r.indexes
          first = sorted.length ? (sorted[0] as number) : 0
        }
        const raw = r._score
        const plain = raw !== undefined && e.s !== stamp && (slash || first < e.b)
        if (plain && raw <= floor) return 0
        const rk = rank(r.score, r.target, first, q, ctx)
        if (top.length === limit && rk <= (top[0] as number)) {
          if (plain && raw > floor) floor = raw
          return 0
        }
        let i = top.length
        if (top.length === limit) {
          top.shift()
          i = limit - 1
        }
        top.push(rk)
        for (; i > 0 && (top[i - 1] as number) > rk; i--) top[i] = top[i - 1] as number
        top[i] = rk
        return 2 + rk
      },
    })
    this.last = { query: q, matched }
    return res.map((r) => ({ path: r.target, matched: [...r.indexes].sort((a, b) => a - b) }))
  }
}
