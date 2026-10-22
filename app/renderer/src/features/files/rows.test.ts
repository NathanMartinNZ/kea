import { describe, expect, it } from 'vitest'
import { GIT_CODES, TREE_HEAD_KEY, treeKey, type GitCode, type TreeDir, type TreeEntry, type TreeRow } from '@kea/protocol'
import { ancestors, classOf, Rollup } from './rollup.ts'
import { compactChild, flattenTree } from './rows.ts'

const d = (name: string, ignored = false): TreeEntry => ({ name, kind: 'dir', ignored })
const f = (name: string, ignored = false): TreeEntry => ({ name, kind: 'file', ignored })

/** A tree store's data from `{ dir: entries }`. */
function tree(dirs: Record<string, TreeEntry[]>, more: Record<string, Partial<TreeDir>> = {}): Map<string, TreeRow> {
  const m = new Map<string, TreeRow>([[TREE_HEAD_KEY, { git: true, live: true, missing: false }]])
  for (const [path, entries] of Object.entries(dirs)) m.set(treeKey(path), { path, entries, total: entries.length, paged: false, truncated: false, ...more[path] })
  return m
}
const show = (rows: ReturnType<typeof flattenTree>): string[] => rows.map((r) => `${'  '.repeat(r.depth)}${r.label}${r.kind === 'dir' ? (r.expanded ? (r.loading ? '/…' : '/') : '/+') : r.kind === 'more' ? `(more of ${r.total})` : ''}`)

describe('the tree’s rows', () => {
  it('U-FT-2 · a chain of single-child directories is one row `a/b/c`; it splits again where a second child appears, and never forms across a collapsed, unloaded or paged directory', () => {
    const on = { compact: true, showIgnored: false }
    const base = { '': [d('packages'), f('README.md')], packages: [d('app')], 'packages/app': [d('src')], 'packages/app/src': [f('main.ts'), f('util.ts')] }
    const all = new Set(['packages', 'packages/app', 'packages/app/src'])
    expect(show(flattenTree(tree(base), all, on))).toEqual(['packages/app/src/', '  main.ts', '  util.ts', 'README.md'])
    const compact = flattenTree(tree(base), all, on)[0]
    expect(compact).toMatchObject({ path: 'packages/app/src', chain: ['packages', 'packages/app', 'packages/app/src'], depth: 0, expanded: true })
    // off: one row per directory
    expect(show(flattenTree(tree(base), all, { ...on, compact: false }))).toEqual(['packages/', '  app/', '    src/', '      main.ts', '      util.ts', 'README.md'])

    // a second child appears in the middle of the chain: it splits there, and only there
    const split = { ...base, 'packages/app': [d('src'), f('package.json')] }
    expect(show(flattenTree(tree(split), all, on))).toEqual(['packages/app/', '  src/', '    main.ts', '    util.ts', '  package.json', 'README.md'])
    // …and joins again when it goes
    expect(show(flattenTree(tree(base), all, on))[0]).toBe('packages/app/src/')
    // a second child at the top: no chain from there, the rest still compact
    const top = { ...base, packages: [d('app'), d('lib')] }
    expect(show(flattenTree(tree(top), all, on))).toEqual(['packages/', '  app/src/', '    main.ts', '    util.ts', '  lib/+', 'README.md'])

    // the chain ends at a collapsed directory, and at one whose entries have not arrived
    expect(show(flattenTree(tree(base), new Set(['packages']), on))).toEqual(['packages/app/+', 'README.md'])
    expect(show(flattenTree(tree(base), new Set(), on))).toEqual(['packages/+', 'README.md'])
    const unloaded = { '': base[''], packages: base.packages }
    expect(show(flattenTree(tree(unloaded), all, on))).toEqual(['packages/app/…', 'README.md'])
    expect(flattenTree(tree(unloaded), all, on)[0]).toMatchObject({ path: 'packages/app', loading: true })
    // what the view expands next so a chain forms: the only child, when it is a directory
    expect(compactChild(tree(base), 'packages', on)).toBe('packages/app')
    expect(compactChild(tree(base), 'packages/app/src', on)).toBeNull()
    expect(compactChild(tree(split), 'packages/app', on)).toBeNull()
    expect(compactChild(tree(base), 'not/loaded', on)).toBeNull()

    // ignored entries are hidden by default, so a folder with one visible directory and an ignored file is a chain;
    // shown (dimmed), they are a second child
    const ign = { '': [d('web')], web: [d('node_modules', true), d('src')], 'web/src': [f('.env', true), f('index.ts')], 'web/node_modules': [d('react', true)] }
    const open = new Set(['web', 'web/src', 'web/node_modules'])
    expect(show(flattenTree(tree(ign), open, on))).toEqual(['web/src/', '  index.ts'])
    expect(show(flattenTree(tree(ign), open, { compact: true, showIgnored: true }))).toEqual(['web/', '  node_modules/react/+', '  src/', '    .env', '    index.ts'])
    expect(flattenTree(tree(ign), open, { compact: true, showIgnored: true }).filter((r) => r.ignored).map((r) => r.path)).toEqual(['web/node_modules/react', 'web/src/.env'])

    // a big directory's first page ends with the "Show all (n)" row, and is never part of a chain
    const big = tree({ '': [d('gen')], gen: [d('only')] }, { gen: { paged: true, total: 50_000 } })
    expect(show(flattenTree(big, new Set(['gen']), on))).toEqual(['gen/', '  only/+', '  (more of 50000)'])
  })
})

describe('folder roll-ups', () => {
  it('U-GS-7 · a status delta updates only the changed paths’ ancestors; a folder takes its strongest descendant’s class; a deleted file counts in its folders; incremental equals a full recompute for random deltas', () => {
    expect(ancestors('a/b/c.ts')).toEqual(['a/b', 'a', ''])
    expect(ancestors('top.ts')).toEqual([''])
    expect(GIT_CODES.map(classOf)).toEqual(['modified', 'added', 'added', 'deleted', 'renamed', 'conflict'])
    const e = (path: string, code: GitCode) => ({ path, code })
    const r = new Rollup()
    // one path: its three ancestors, nothing else
    let changed = r.apply([e('src/auth/login.ts', 'M')], [])
    expect([...changed].sort()).toEqual(['', 'src', 'src/auth'])
    expect(r.touched).toBe(3)
    expect([r.folder('src/auth'), r.folder('src'), r.folder(''), r.folder('test')]).toEqual(['modified', 'modified', 'modified', null])
    // strongest class wins: conflict > deleted > modified > added / untracked > renamed
    r.apply([e('src/auth/new.ts', 'U'), e('src/ui/moved.ts', 'R'), e('docs/a.md', 'A')], [])
    expect([r.folder('src/auth'), r.folder('src/ui'), r.folder('docs'), r.folder('src')]).toEqual(['modified', 'renamed', 'added', 'modified'])
    changed = r.apply([e('src/ui/gone.ts', 'D')], [])
    expect([...changed].sort()).toEqual(['', 'src', 'src/ui']) // `src/auth` and `docs` were not touched
    expect(r.touched).toBe(3)
    expect([r.folder('src/ui'), r.folder('src'), r.folder('')]).toEqual(['deleted', 'deleted', 'deleted'])
    // a deleted file is a change of its folders (the dot counts it) though the tree has no row for it
    expect(r.counts('src/ui')).toEqual({ conflict: 0, deleted: 1, modified: 0, added: 0, renamed: 1, total: 2 })
    expect(r.file('src/ui/gone.ts')).toBe('deleted')
    r.apply([e('docs/a.md', '!')], [])
    expect([r.folder('docs'), r.folder('')]).toEqual(['conflict', 'conflict'])
    expect(r.counts('')).toMatchObject({ total: 5, conflict: 1 })
    // a path that changes class moves between counters; one that leaves the status leaves its folders
    r.apply([e('docs/a.md', 'M')], ['src/ui/gone.ts'])
    expect([r.folder('docs'), r.folder('src/ui'), r.folder('')]).toEqual(['modified', 'renamed', 'modified'])
    r.apply([e('src/auth/login.ts', 'M')], []) // unchanged: nothing touched
    expect(r.touched).toBe(0)
    r.apply([], ['src/auth/login.ts', 'src/auth/new.ts', 'src/ui/moved.ts', 'docs/a.md', 'never/there.ts'])
    expect(r.snapshot()).toEqual({}) // nothing left behind
    expect(r.size).toBe(0)

    // property: after any sequence of deltas, the incremental roll-up equals one computed from scratch
    let seed = 20261011
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
    const names = ['a', 'b', 'c', 'd']
    const randomPath = (): string => `${Array.from({ length: 1 + rnd(4) }, () => names[rnd(names.length)]).join('/')}/f${rnd(6)}.ts`
    const live = new Map<string, GitCode>()
    const inc = new Rollup()
    for (let step = 0; step < 400; step++) {
      const set = Array.from({ length: rnd(6) }, () => e(randomPath(), GIT_CODES[rnd(GIT_CODES.length)] as GitCode))
      const known = [...live.keys()]
      const del = Array.from({ length: rnd(4) }, () => (known.length && rnd(4) > 0 ? (known[rnd(known.length)] as string) : randomPath())).filter((p) => !set.some((s) => s.path === p))
      for (const p of del) live.delete(p)
      for (const s of set) live.set(s.path, s.code)
      inc.apply(set, del)
      if (step % 20 === 0 || step === 399) expect(inc.snapshot(), `step ${step}`).toEqual(Rollup.of([...live].map(([path, code]) => e(path, code))).snapshot())
    }
    expect(inc.size).toBe(live.size)
  })
})
