// A session's file tabs as files move in the tree: each follows its file, and a tab left at the path a moved file
// takes (its own file is not there any more) closes for it.
import { describe, expect, it } from 'vitest'
import { EMPTY_VIEW } from '../features/viewer/tab.ts'
import { fileTabsOf, moveFileTabs, setFileTabs, takeMovedTab } from './fileTabs.svelte.ts'
import { fileTabId, type FileTab } from './tabs.ts'

const tab = (path: string, seen: number, mode: 'file' | 'diff' = 'file'): FileTab => ({ id: fileTabId(path), path, mode, pinned: true, seen, view: EMPTY_VIEW, goto: null })
const paths = (sessionId: string) => fileTabsOf(sessionId).tabs.map((t) => `${t.mode}:${t.path}`)

describe('file tabs as files move', () => {
  it('U-FV-11 · a tab follows its file’s rename or move, a folder’s tabs with it; a tab left at the path a moved file takes closes', () => {
    setFileTabs('s1', { tabs: [tab('src/a.ts', 1), tab('src/b.ts', 2), tab('lib/c.ts', 3), tab('lib/d.ts', 4, 'diff')], seq: 4 })
    moveFileTabs('s1', 'src', 'app')
    expect(paths('s1')).toEqual(['file:app/a.ts', 'file:app/b.ts', 'file:lib/c.ts', 'diff:lib/d.ts'])
    expect(takeMovedTab('s1', fileTabId('src/a.ts'))).toBe(fileTabId('app/a.ts'))
    // app/b.ts is gone from disk, its tab still open: a.ts renamed to b.ts takes the path, and b.ts's tab closes
    moveFileTabs('s1', 'app/a.ts', 'app/b.ts')
    expect(paths('s1')).toEqual(['file:app/b.ts', 'file:lib/c.ts', 'diff:lib/d.ts'])
    expect(fileTabsOf('s1').tabs[0]?.seen).toBe(1)
    setFileTabs('s1', { tabs: [], seq: 0 })
  })

  it('U-FV-11 · a move the pane did not follow leaves nothing behind: a tab opened later at the old path, closed while on screen, finds no move', () => {
    setFileTabs('s1', { tabs: [tab('src/a.ts', 1), tab('src/b.ts', 2)], seq: 2 })
    // b.ts on screen; a.ts renamed onto it takes b.ts's place, which the pane still shows: it looks, and finds its tab
    moveFileTabs('s1', 'src/a.ts', 'src/b.ts')
    expect(paths('s1')).toEqual(['file:src/b.ts'])
    expect(takeMovedTab('s1', null)).toBeNull()
    // a new a.ts, opened and then closed while on screen: the pane looks for where its tab went
    setFileTabs('s1', { tabs: [...fileTabsOf('s1').tabs, tab('src/a.ts', 3)], seq: 3 })
    setFileTabs('s1', { tabs: fileTabsOf('s1').tabs.filter((t) => t.path !== 'src/a.ts'), seq: 3 })
    expect(takeMovedTab('s1', fileTabId('src/a.ts'))).toBeNull()
    setFileTabs('s1', { tabs: [], seq: 0 })
  })
})
