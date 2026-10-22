import fuzzysort from 'fuzzysort'
import { describe, expect, it } from 'vitest'
import { PathIndex } from './finder-match.ts'
import { rank, type RankContext } from './finder-rank.ts'

const LIMIT = 50

/** A monorepo's shape: the same folder and file names many times over, so most paths match a short query. */
function paths(n: number): string[] {
  const areas = ['web', 'api', 'cli', 'core']
  const kinds = ['components', 'hooks', 'routes', 'util', 'index']
  const names = ['button', 'date', 'index', 'session', 'util']
  const out = ['README.md', 'package.json', 'src/index.ts', 'docs/Session Notes.md']
  for (let i = 0; out.length < n; i++) {
    const a = areas[i % areas.length] as string
    const k = kinds[Math.floor(i / areas.length) % kinds.length] as string
    const name = names[Math.floor(i / (areas.length * kinds.length)) % names.length] as string
    out.push(`packages/${a}/src/${k}/m${String(i % 37).padStart(2, '0')}/${name}-${String(i).padStart(4, '0')}.${i % 9 === 0 ? 'test.ts' : 'ts'}`)
  }
  return out
}

/** The ranking with nothing left out: every match scored, the best `LIMIT` kept. */
function reference(query: string, all: string[], ctx: RankContext): { path: string; rank: number }[] {
  const res = fuzzysort.go(query, all.map((p) => fuzzysort.prepare(p)), { limit: LIMIT, threshold: 0, scoreFn: (r) => rank(r.score, r.target, r.indexes.length ? (r.indexes[0] as number) : 0, query, ctx) })
  return res.map((r) => ({ path: r.target, rank: r.score }))
}

/** The rank of `path` for `query`, from the path alone. */
function rankOf(query: string, path: string, ctx: RankContext): number {
  const r = fuzzysort.single(query, path)
  if (!r) throw new Error(`${path} does not match ${query}`)
  return rank(r.score, path, r.indexes.length ? (r.indexes[0] as number) : 0, query, ctx)
}

describe('the finder’s matching', () => {
  it('U-FT-10 · dropping unboosted matches early and matching a longer query only against the last one’s matches answer exactly what scoring every match does, across typing, context and index changes', () => {
    const all = paths(6000)
    const index = new PathIndex(10_000)
    for (const p of all) index.add(p)
    expect(index.size).toBe(all.length)
    const ctx: RankContext = {
      changed: new Set(all.filter((_, i) => i % 401 === 7)),
      recent: new Map(all.filter((_, i) => i % 907 === 3).map((p, i) => [p, i])),
    }
    const same = (query: string, now: string[], context: RankContext): void => {
      const want = reference(query, now, context)
      const got = index.query(query, LIMIT, context)
      expect(got.length, `"${query}": how many`).toBe(want.length)
      // the same ranks in the same order (paths that tie may come in either order)
      got.forEach((h, i) => expect(rankOf(query, h.path, context), `"${query}" #${i} ${h.path}`).toBeCloseTo((want[i] as { rank: number }).rank, 9))
      // and above the lowest rank kept, the very same paths
      const cut = want.length ? (want.at(-1) as { rank: number }).rank : 0
      const above = (xs: { path: string; rank: number }[]) => xs.filter((x) => x.rank > cut + 1e-9).map((x) => x.path).sort()
      expect(above(got.map((h) => ({ path: h.path, rank: rankOf(query, h.path, context) })))).toEqual(above(want))
      // the matched characters are those of the path, ascending
      for (const h of got) expect(h.matched).toEqual([...(fuzzysort.single(query, h.path)?.indexes ?? [])].sort((a, b) => a - b))
    }

    // typing: each query extends the last, and is matched only against what the last one matched
    for (const word of ['button', 'src/util/date', 'README', 'webhooksindex', 'session-0243.test', 'cli index', 'sn', 'zzzz']) {
      let scanned = Number.POSITIVE_INFINITY
      for (let n = 1; n <= word.length; n++) {
        same(word.slice(0, n), all, ctx)
        if (word.slice(0, n).trim() === word.slice(0, n)) {
          expect(index.scanned, `"${word.slice(0, n)}" scans no more than its prefix matched`).toBeLessThanOrEqual(scanned)
          scanned = index.scanned
        }
      }
      expect(scanned, `"${word}" was not matched against every path`).toBeLessThan(all.length)
      same(word.slice(0, 1), all, ctx) // back to one character: everything is a candidate again
      expect(index.scanned).toBe(all.length)
    }

    // with no context the same holds (nothing is boosted but file names)
    const none: RankContext = { changed: new Set(), recent: new Map() }
    for (const q of ['index', 'util', 's', 'packages', 'm12/date']) same(q, all, none)

    // the index changes between two keystrokes: the next query starts from every path again
    same('sess', all, ctx)
    const added = 'packages/web/src/session.ts'
    index.add(added)
    index.delete(all[100] as string)
    index.deleteBelow('packages/api/src/hooks')
    const now = [...all.filter((p, i) => i !== 100 && !p.startsWith('packages/api/src/hooks/')), added]
    expect(index.size).toBe(now.length)
    same('sessi', now, ctx)
    expect(index.scanned).toBe(now.length)
    expect(index.query('session', LIMIT, none)[0]?.path).toBe(added) // the file named for the query comes first

    // an empty query: recent, then changed; past the cap a path is dropped and the index says so
    expect(index.query('  ', LIMIT, { changed: new Set([added]), recent: new Map([['README.md', 0]]) }).map((h) => h.path)).toEqual(['README.md', added])
    const small = new PathIndex(3)
    for (const p of all.slice(0, 5)) small.add(p)
    expect([small.size, small.truncated]).toEqual([3, true])
  })
})
