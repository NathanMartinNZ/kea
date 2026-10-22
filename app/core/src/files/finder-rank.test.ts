import fuzzysort from 'fuzzysort'
import { describe, expect, it } from 'vitest'
import { BOOST, contextBoost, emptyQueryOrder, rank, type RankContext } from './finder-rank.ts'

const none: RankContext = { changed: new Set(), recent: new Map() }

/** The finder's order for `query` over `paths`, as the worker computes it. */
function order(query: string, paths: string[], ctx: RankContext = none): string[] {
  const res = fuzzysort.go(query, paths.map((p) => fuzzysort.prepare(p)), { limit: 50, threshold: 0, scoreFn: (r) => rank(r.score, r.target, r.indexes.length ? (r.indexes[0] as number) : 0, query, ctx) })
  return res.map((r) => r.target)
}

describe('the finder’s ranking', () => {
  it('U-FT-5 · a match in the file’s name beats the same match in a folder’s; changed files and recently opened ones rise; an empty query lists recent, then changed', () => {
    // basename: the file called `login` before files that merely live in a `login` folder
    const paths = ['src/login/index.ts', 'src/login/helpers/format.ts', 'src/auth/login.ts', 'docs/blog-in-depth.md', 'src/auth/LoginForm.svelte']
    const byName = order('login', paths)
    expect(byName[0]).toBe('src/auth/login.ts') // the name is the query
    expect(byName[1]).toBe('src/auth/LoginForm.svelte') // the name starts with it
    expect(byName.indexOf('src/login/index.ts')).toBeGreaterThan(1)
    expect(byName.at(-1)).toBe('docs/blog-in-depth.md') // scattered letters last
    // a query with a slash is about the path: no name boost
    expect(order('login/in', paths)[0]).toBe('src/login/index.ts')

    // changed: of two equal matches the one with changes first
    const twins = ['packages/a/src/config.ts', 'packages/b/src/config.ts']
    for (const changed of twins) expect(order('config', twins, { changed: new Set([changed]), recent: new Map() })[0]).toBe(changed)
    // recency: opened lately beats changed, and the more recent of two recent files wins
    const ctx: RankContext = { changed: new Set(['packages/b/src/config.ts']), recent: new Map([['packages/a/src/config.ts', 0]]) }
    expect(order('config', twins, ctx)[0]).toBe('packages/a/src/config.ts')
    expect(contextBoost('x', { changed: new Set(), recent: new Map([['x', 0], ['y', 1]]) })).toBeGreaterThan(contextBoost('y', { changed: new Set(), recent: new Map([['x', 0], ['y', 1]]) }))
    expect(contextBoost('z', { changed: new Set(), recent: new Map([['z', 500]]) })).toBe(BOOST.recentFloor) // an old entry still counts a little
    expect(contextBoost('q', none)).toBe(0)
    // boosts order equal matches; they do not let a poor match overtake an exact name
    const mixed = ['src/server/index.ts', 'src/settings/render.ts']
    expect(order('index', mixed, { changed: new Set(['src/settings/render.ts']), recent: new Map([['src/settings/render.ts', 0]]) })[0]).toBe('src/server/index.ts')

    // nothing typed: what was opened lately (most recent first), then what has changes; only files that exist
    const all = new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    expect(emptyQueryOrder(all, { changed: new Set(['d.ts', 'b.ts', 'gone.ts']), recent: new Map([['c.ts', 0], ['deleted.ts', 1], ['b.ts', 2]]) }, 10)).toEqual(['c.ts', 'b.ts', 'd.ts'])
    expect(emptyQueryOrder(all, { changed: new Set(['d.ts', 'b.ts']), recent: new Map([['c.ts', 0]]) }, 2)).toEqual(['c.ts', 'b.ts'])
  })
})
