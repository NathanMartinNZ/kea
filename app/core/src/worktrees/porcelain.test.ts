import { describe, expect, it } from 'vitest'
import { parseWorktreeList } from './porcelain.ts'

const rec = (...fields: string[]) => `${fields.join('\0')}\0\0`

describe('git worktree list --porcelain -z', () => {
  it('U-WT-6 · main, linked, locked (with and without a reason), prunable, bare and detached entries; paths with spaces and newlines', () => {
    const out =
      rec('worktree /repo/main', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main') +
      rec('worktree /w/demo/fix auth', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/kea/fix-auth', 'locked initializing') +
      rec('worktree /w/demo/odd\nname', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'locked') +
      rec('worktree /w/demo/gone', 'HEAD 4444444444444444444444444444444444444444', 'branch refs/heads/kea/gone', 'prunable gitdir file points to non-existent location')
    const e = parseWorktreeList(out)
    expect(e).toEqual([
      { path: '/repo/main', head: '1'.repeat(40), branch: 'main', bare: false, detached: false, locked: null, prunable: null },
      { path: '/w/demo/fix auth', head: '2'.repeat(40), branch: 'kea/fix-auth', bare: false, detached: false, locked: 'initializing', prunable: null },
      { path: '/w/demo/odd\nname', head: '3'.repeat(40), branch: null, bare: false, detached: true, locked: '', prunable: null },
      { path: '/w/demo/gone', head: '4'.repeat(40), branch: 'kea/gone', bare: false, detached: false, locked: null, prunable: 'gitdir file points to non-existent location' },
    ])
    expect(parseWorktreeList(rec('worktree /srv/repo.git', 'bare'))).toEqual([{ path: '/srv/repo.git', head: null, branch: null, bare: true, detached: false, locked: null, prunable: null }])
    expect(parseWorktreeList('')).toEqual([])
    // a last record without its terminating empty field still counts
    expect(parseWorktreeList('worktree /a\0HEAD 5\0branch refs/heads/x\0')).toHaveLength(1)
  })
})
