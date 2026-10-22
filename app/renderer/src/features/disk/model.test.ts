import { describe, expect, it } from 'vitest'
import { L, type DiskUsage, type SessionView } from '@kea/protocol'
import { fakeSession } from '../sessions/fakes.ts'
import { branchText, deletedRows, diskView, foldersText, keptText, lifecycleText, rowActions, shareText, sizeText, totalText } from './model.ts'

const DAY = 86_400_000
const NOW = 100 * DAY
const MB = 1_000_000

function usage(over: Partial<DiskUsage> = {}): DiskUsage {
  return { bytes: null, rebuildableBytes: null, capped: false, at: null, measuring: false, visible: false, viewedAt: null, ...over }
}

function world(rows: readonly [Partial<SessionView>, Partial<DiskUsage> | null][]): { sessions: SessionView[]; disk: Map<string, DiskUsage> } {
  const sessions: SessionView[] = []
  const disk = new Map<string, DiskUsage>()
  for (const [s, d] of rows) {
    const v = fakeSession({ createdAt: NOW - 30 * DAY, ...s })
    sessions.push(v)
    if (d) disk.set(v.id, usage(d))
  }
  return { sessions, disk }
}

describe('the Disk view', () => {
  it('U-WT-21 · every session with a worktree, largest first, the unmeasured last; the total is over all of them, whatever the filter; Stale lists those not viewed for L.diskStaleDays days', () => {
    const w = world([
      [{ title: 'small' }, { bytes: 5 * MB, rebuildableBytes: 0, at: 1, viewedAt: NOW - DAY }],
      [{ title: 'big, archived', lifecycle: 'archived' }, { bytes: 900 * MB, rebuildableBytes: 400 * MB, at: 1, viewedAt: NOW - 8 * DAY }],
      [{ title: 'in place', isolation: 'inplace' }, null],
      [{ title: 'never measured' }, { measuring: true, viewedAt: NOW - L.diskStaleDays * DAY }],
      [{ title: 'middle, on screen' }, { bytes: 40 * MB, rebuildableBytes: 30 * MB, capped: true, at: 1, visible: true, viewedAt: NOW - 20 * DAY }],
      [{ title: 'b same size' }, { bytes: 5 * MB, rebuildableBytes: 1 * MB, at: 1, viewedAt: NOW }],
      [{ title: 'never shown, new', createdAt: NOW - DAY }, { bytes: 1 * MB, rebuildableBytes: 0, at: 1 }],
      [{ title: 'never shown, old' }, { bytes: 2 * MB, rebuildableBytes: 0, at: 1 }],
    ])
    const all = diskView(w.sessions, w.disk, NOW, 'all')
    // a session with no row in the `disk` store has no worktree of its own: it is not listed
    expect(all.rows.map((r) => r.title)).toEqual(['big, archived', 'middle, on screen', 'b same size', 'small', 'never shown, old', 'never shown, new', 'never measured'])
    expect(all.more).toBe(0)
    expect(all.total).toEqual({ bytes: 953 * MB, rebuildableBytes: 431 * MB, sessions: 7, unmeasured: 1, capped: 1, measuring: 1, stale: 3 })
    expect(totalText(all.total)).toBe('At least 953 MB in 7 worktrees · 431 MB rebuildable · measuring 1')

    const stale = diskView(w.sessions, w.disk, NOW, 'stale')
    // exactly L.diskStaleDays days counts; the one on screen does not, however long ago it was noted; one never shown
    // counts from its creation
    expect(stale.rows.map((r) => r.title)).toEqual(['big, archived', 'never shown, old', 'never measured'])
    expect(stale.rows.every((r) => r.stale)).toBe(true)
    expect(stale.total).toEqual(all.total)

    // the list is capped (`L.diskViewRowsMax` by default): the largest stay, and the view says how many it left out
    const capped = diskView(w.sessions, w.disk, NOW, 'all', 3)
    expect(capped.rows.map((r) => r.title)).toEqual(['big, archived', 'middle, on screen', 'b same size'])
    expect(capped.more).toBe(4)
    expect(capped.total.sessions).toBe(7)
    expect(diskView(w.sessions, w.disk, NOW, 'all', 0)).toMatchObject({ rows: [], more: 7 })
    expect(L.diskViewRowsMax).toBeGreaterThan(0)

    expect(diskView([], new Map(), NOW, 'all')).toEqual({ rows: [], more: 0, total: { bytes: 0, rebuildableBytes: 0, sessions: 0, unmeasured: 0, capped: 0, measuring: 0, stale: 0 } })
    expect(totalText(diskView([], new Map(), NOW, 'all').total)).toBe('No session has a worktree of its own.')
  })

  it('U-WT-22 · what a row says: its size (an upper bound when the walk was cancelled), its rebuildable share, its lifecycle, its branch state, and which actions it offers', () => {
    expect(sizeText({ bytes: null, capped: false, measuring: true })).toBe('Measuring…')
    expect(sizeText({ bytes: null, capped: false, measuring: false })).toBe('Not measured')
    expect(sizeText({ bytes: 4_200 * MB, capped: false, measuring: true })).toBe('4.2 GB')
    expect(sizeText({ bytes: 4_200 * MB, capped: true, measuring: false })).toBe('at least 4.2 GB')
    expect(shareText({ rebuildableBytes: null })).toBe('')
    expect(shareText({ rebuildableBytes: 0 })).toBe('nothing rebuildable')
    expect(shareText({ rebuildableBytes: 1_100 * MB })).toBe('1.1 GB rebuildable')

    expect(lifecycleText('live')).toBe('running')
    expect(lifecycleText('detached')).toBe('stopped')
    expect(lifecycleText('archived')).toBe('archived')

    expect(branchText(undefined)).toBe('checking the branch…')
    expect(branchText(null)).toBe('branch state not known')
    expect(branchText({ uncommittedFiles: 3, unpushedCommits: 1, commits: 2, merged: false })).toBe('3 uncommitted files · 1 unpushed commit · not merged')
    expect(branchText({ uncommittedFiles: 1, unpushedCommits: 0, commits: 4, merged: true })).toBe('1 uncommitted file · nothing unpushed · merged')
    // a branch with no commit of its own is not called merged: there is nothing to merge
    expect(branchText({ uncommittedFiles: 0, unpushedCommits: 0, commits: 0, merged: true })).toBe('nothing uncommitted · nothing unpushed · no commits of its own')

    expect(totalText({ bytes: 12_400 * MB, rebuildableBytes: 0, sessions: 1, unmeasured: 0, capped: 0, measuring: 0, stale: 0 })).toBe('12 GB in 1 worktree')
    expect(totalText({ bytes: 3 * MB, rebuildableBytes: 1 * MB, sessions: 4, unmeasured: 2, capped: 0, measuring: 0, stale: 0 })).toBe('3.0 MB in 4 worktrees · 1.0 MB rebuildable · 2 not measured')

    // Remove build folders is offered until a walk has found nothing rebuildable; Archive only for a session not archived yet
    expect(rowActions({ lifecycle: 'live', rebuildableBytes: null })).toEqual({ removeBuildFolders: true, archive: true, delete: true })
    expect(rowActions({ lifecycle: 'detached', rebuildableBytes: 0 })).toEqual({ removeBuildFolders: false, archive: true, delete: true })
    expect(rowActions({ lifecycle: 'archived', rebuildableBytes: 5 })).toEqual({ removeBuildFolders: true, archive: false, delete: true })
  })

  it('U-WT-25 · what a removal would take and what it keeps, in words: the folders and their size as last measured; a folder kept because it holds a git repository, or because it could not be checked, with its name where asked', () => {
    expect(foldersText({ folders: ['node_modules'], bytes: null })).toBe('1 folder: node_modules')
    expect(foldersText({ folders: ['node_modules', 'target', 'web/node_modules'], bytes: 1_200 * MB })).toBe('3 folders (1.2 GB when last measured): node_modules, target, web/node_modules')
    // a size of nothing (measured after an earlier removal) says nothing about folders made since
    expect(foldersText({ folders: ['dist'], bytes: 0 })).toBe('1 folder: dist')
    expect(foldersText({ folders: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], bytes: null })).toBe('8 folders: a, b, c, d, e, f and 2 more')
    expect(foldersText({ folders: [], bytes: 5 })).toMatch(/^Nothing to remove/)

    expect(keptText([])).toBe('')
    expect(keptText([{ path: 'build', reason: 'git' }])).toBe('1 folder kept: it holds a git repository')
    expect(keptText([{ path: 'build', reason: 'git' }], { names: true })).toBe('1 folder kept: it holds a git repository (build)')
    expect(keptText([{ path: 'build', reason: 'git' }, { path: '.venv', reason: 'git' }])).toBe('2 folders kept: they hold git repositories')
    expect(keptText([{ path: 'node_modules', reason: 'unchecked' }])).toBe('1 folder kept: it could not be checked for a git repository')
    expect(keptText([{ path: 'build', reason: 'git' }, { path: 'a/dist', reason: 'unchecked' }, { path: 'b/dist', reason: 'unchecked' }], { names: true })).toBe(
      '1 folder kept: it holds a git repository (build) · 2 folders kept: they could not be checked for a git repository (a/dist, b/dist)',
    )
  })

  it('U-WT-23 · Recently deleted: every project\'s deleted sessions as one list, newest first, capped', () => {
    const d = (id: string, deletedAt: number) => ({ id, title: `t-${id}`, branch: `kea/${id}`, isolation: 'worktree' as const, deletedAt, snapshotFiles: 0 })
    const lists = [
      { projectId: 'p1', sessions: [d('a', 50), d('b', 10)] },
      { projectId: 'p2', sessions: [] },
      { projectId: 'p3', sessions: [d('d', 70), d('c', 50)] },
    ]
    const r = deletedRows(lists)
    expect(r.rows.map((x) => `${x.id}@${x.projectId}`)).toEqual(['d@p3', 'a@p1', 'c@p3', 'b@p1'])
    expect(r.more).toBe(0)
    expect(deletedRows(lists, 3)).toMatchObject({ rows: [{ id: 'd' }, { id: 'a' }, { id: 'c' }], more: 1 })
    expect(deletedRows([])).toEqual({ rows: [], more: 0 })
  })
})
