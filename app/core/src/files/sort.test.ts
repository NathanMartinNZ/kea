import { describe, expect, it } from 'vitest'
import { IgnoreIndex } from './ignore.ts'
import { compareNames, sortEntries } from './sort.ts'

describe('the tree’s order', () => {
  it('U-FT-1 · directories first, then files; case-insensitive and numeric-aware; a total order', () => {
    const e = (name: string, kind: 'dir' | 'file' | 'symlink' = 'file') => ({ name, kind })
    const sorted = sortEntries([e('file10.ts'), e('README.md'), e('src', 'dir'), e('file2.ts'), e('Zebra', 'dir'), e('apple.txt'), e('Banana.txt'), e('.env'), e('docs', 'dir'), e('link', 'symlink'), e('file1.ts'), e('.github', 'dir')])
    expect(sorted.map((x) => x.name)).toEqual(['.github', 'docs', 'src', 'Zebra', '.env', 'apple.txt', 'Banana.txt', 'file1.ts', 'file2.ts', 'file10.ts', 'link', 'README.md'])
    expect(['v1.10.0', 'v1.9.0', 'v1.2.0'].sort(compareNames)).toEqual(['v1.2.0', 'v1.9.0', 'v1.10.0'])
    expect(['img12.png', 'img2.png', 'IMG3.png'].sort(compareNames)).toEqual(['img2.png', 'IMG3.png', 'img12.png'])
    // names that differ only in case still have one order, whatever order they came in
    expect(['b', 'B', 'a', 'A'].sort(compareNames)).toEqual(['A', 'a', 'B', 'b'])
    expect(['A', 'a', 'B', 'b'].reverse().sort(compareNames)).toEqual(['A', 'a', 'B', 'b'])
    expect(compareNames('same', 'same')).toBe(0)
  })

  it('U-FT-4 · everything below an ignored folder is ignored without a query; elsewhere a path is ignored if listed, not ignored if the list is whole, unknown if it is new or the list was cut', () => {
    const ix = new IgnoreIndex()
    expect(ix.query('src/a.ts')).toBe('unknown') // nothing loaded yet
    for (const listed of ['node_modules/', 'packages/app/dist/', '.env', 'logs/debug.log']) ix.addListed(listed)
    ix.loaded = true
    expect(ix.query('node_modules')).toBe('ignored')
    expect(ix.query('node_modules/react/index.js')).toBe('ignored')
    expect(ix.query('node_modules/.pnpm/a/b/c/d/e/f.js')).toBe('ignored')
    expect(ix.ignoredAncestor('packages/app/dist/assets/x.js')).toBe('packages/app/dist')
    expect(ix.ignoredAncestor('packages/app/dist', false)).toBeNull() // the folder itself, asked for what is above it
    expect(ix.query('packages/app/src/x.ts')).toBe('not')
    expect(ix.query('.env')).toBe('ignored')
    expect(ix.query('logs/debug.log')).toBe('ignored')
    expect(ix.query('logs/other.log')).toBe('not')
    expect(ix.query('node_modules_backup/x')).toBe('not') // a name that only starts like an ignored one
    // a path that appeared after the list was read: only a check can say
    expect(ix.query('build-output/x.o', true)).toBe('unknown')
    expect(ix.query('node_modules/new-package/index.js', true)).toBe('ignored') // but below an ignored folder nothing is asked
    ix.addChecked('build-output', true, true)
    ix.addChecked('src/new.ts', false, false)
    expect(ix.query('build-output/x.o', true)).toBe('ignored')
    expect(ix.query('src/new.ts', true)).toBe('not')
    // a list that was cut: silence means nothing
    const part = new IgnoreIndex(3)
    for (const listed of ['a/', 'b/', 'c/', 'd/']) part.addListed(listed)
    part.loaded = true
    expect(part.partial).toBe(true)
    expect(part.query('a/x')).toBe('ignored')
    expect(part.query('d/x')).toBe('unknown')
    expect(part.size).toBe(3)
  })
})
