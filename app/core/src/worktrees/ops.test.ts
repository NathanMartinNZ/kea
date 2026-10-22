import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { restoreBranch, snapshotPlan } from './ops.ts'

describe('delete snapshot and restore plans', () => {
  it('U-WT-2 · the snapshot leaves out and lists untracked files over the size limit, never adds ignored ones; a restore picks the branch by its state: at the parent, deleted, or reused → -restored', () => {
    const limit = L.snapshotUntrackedMaxBytes
    const plan = snapshotPlan([
      { path: 'small.txt', bytes: 10 },
      { path: 'at-limit.bin', bytes: limit },
      { path: 'big.bin', bytes: limit + 1 },
      { path: 'dir with space/huge :(glob)*.iso', bytes: limit * 4 },
      { path: 'link', bytes: null },
    ])
    expect(plan.oversize).toEqual([
      { path: 'big.bin', bytes: limit + 1 },
      { path: 'dir with space/huge :(glob)*.iso', bytes: limit * 4 },
    ])
    // literal pathspecs, so a name with magic characters excludes only itself; no --force, so ignored files stay out
    expect(plan.addArgs).toEqual(['add', '-A', '--', '.', ':(exclude,literal)big.bin', ':(exclude,literal)dir with space/huge :(glob)*.iso'])
    expect(plan.addArgs).not.toContain('--force')
    expect(plan.addArgs).not.toContain('-f')
    expect(snapshotPlan([]).addArgs).toEqual(['add', '-A', '--', '.'])
    // repositories of their own are left out the same way
    expect(snapshotPlan([], limit, ['vendor/clone']).addArgs).toEqual(['add', '-A', '--', '.', ':(exclude,literal)vendor/clone'])

    const none = new Set<string>()
    // the branch still points at the snapshot's parent: checked out as it is
    expect(restoreBranch({ branch: 'kea/fix', tip: 'p', parent: 'p', taken: none })).toEqual({ branch: 'kea/fix', existing: true })
    // deleted with the session: made again at the parent, same name
    expect(restoreBranch({ branch: 'kea/fix', tip: null, parent: 'p', taken: none })).toEqual({ branch: 'kea/fix', existing: false })
    // the name now points elsewhere (reused, or moved on): a new branch beside it, the first free suffix
    expect(restoreBranch({ branch: 'kea/fix', tip: 'other', parent: 'p', taken: none })).toEqual({ branch: 'kea/fix-restored', existing: false })
    expect(restoreBranch({ branch: 'kea/fix', tip: 'other', parent: 'p', taken: new Set(['kea/fix-restored', 'kea/fix-restored-2']) })).toEqual({ branch: 'kea/fix-restored-3', existing: false })
  })
})
