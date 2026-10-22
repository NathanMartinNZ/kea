// The finder's ranking: fuzzysort's score for the path, raised when the match lies in the file's name, when the file
// has changes, and when it was opened lately. Pure, and imported by the worker thread: nothing here may import core or
// protocol code.

export interface RankContext {
  /** Paths with an entry in the session's status. */
  changed: ReadonlySet<string>
  /** Recently opened paths → position, 0 for the most recent. */
  recent: ReadonlyMap<string, number>
}

/** Weights on fuzzysort's 0…1 score. Tuning values of this ranking, not limits (U-FT-5 holds their order). */
export const BOOST = {
  /** Every matched character lies in the file's name. */
  basename: 0.15,
  /** …and the name starts with the query. */
  basenamePrefix: 0.1,
  /** …and the name is the query (with or without its extension). */
  basenameExact: 0.15,
  changed: 0.1,
  /** The most recently opened file; each older one gets `recentStep` less, never below `recentFloor`. */
  recent: 0.2,
  recentStep: 0.005,
  recentFloor: 0.05,
} as const

export function basenameStart(path: string): number {
  return path.lastIndexOf('/') + 1
}

/** The boost for a path, independent of the query's match. */
export function contextBoost(path: string, ctx: RankContext): number {
  let b = 0
  if (ctx.changed.has(path)) b += BOOST.changed
  const pos = ctx.recent.get(path)
  if (pos !== undefined) b += Math.max(BOOST.recentFloor, BOOST.recent - pos * BOOST.recentStep)
  return b
}

/** The rank of a match: `score` is fuzzysort's, `first` the lowest matched index in `path`. */
export function rank(score: number, path: string, first: number, query: string, ctx: RankContext): number {
  let r = score + contextBoost(path, ctx)
  const start = basenameStart(path)
  if (first >= start && !query.includes('/')) {
    r += BOOST.basename
    const name = path.slice(start).toLowerCase()
    const q = query.toLowerCase()
    if (name.startsWith(q)) {
      r += BOOST.basenamePrefix
      const dot = name.lastIndexOf('.')
      if (name === q || (dot > 0 && name.slice(0, dot) === q)) r += BOOST.basenameExact
    }
  }
  return r
}

/** What an empty query answers: the recent files (most recent first), then the changed ones by path. */
export function emptyQueryOrder(paths: ReadonlySet<string> | { has(p: string): boolean }, ctx: RankContext, limit: number): string[] {
  const out: string[] = []
  const recent = [...ctx.recent.entries()].sort((a, b) => a[1] - b[1])
  for (const [p] of recent) {
    if (out.length >= limit) return out
    if (paths.has(p)) out.push(p)
  }
  const seen = new Set(out)
  for (const p of [...ctx.changed].sort()) {
    if (out.length >= limit) break
    if (!seen.has(p) && paths.has(p)) out.push(p)
  }
  return out
}
