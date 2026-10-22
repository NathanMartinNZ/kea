import { describe, expect, it } from 'vitest'
import { selectRebuildable } from './backup.ts'

describe('rebuildable folders and Time Machine', () => {
  it('U-WT-1 · only ignored directories that match a pattern are selected; tracked, untracked-not-ignored and symlinked paths never; Time Machine targets stop one level below the root', () => {
    // git's ignored listing (`--directory`): whole ignored directories end with `/`; tracked and not-ignored paths are never in it
    const ignoredDirs = ['node_modules/', 'target/', 'packages/web/node_modules/', 'packages/web/.next/', 'a/b/c/dist/', '.env', 'linked-dist/', 'build.log']
    const isSymlink = (rel: string) => rel === 'linked-dist'
    expect(selectRebuildable({ ignoredDirs, isSymlink })).toEqual(['a/b/c/dist', 'node_modules', 'packages/web/.next', 'packages/web/node_modules', 'target'])
    // The root and one level below
    expect(selectRebuildable({ ignoredDirs: ['node_modules/', 'web/node_modules/', 'packages/web/node_modules/'], isSymlink, maxDepth: 2 })).toEqual(['node_modules', 'web/node_modules'])
    // the project's own patterns replace the defaults
    expect(selectRebuildable({ ignoredDirs, patterns: ['target'], isSymlink })).toEqual(['target'])
    // a symlink that matches is never selected
    expect(selectRebuildable({ ignoredDirs: ['dist/'], isSymlink: () => true })).toEqual([])
  })
})
