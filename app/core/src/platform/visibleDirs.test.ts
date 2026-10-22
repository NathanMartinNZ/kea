import { KeyedStore, type SessionView } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { VisibleSet } from './visible.ts'
import { followVisibleDirs } from './visibleDirs.ts'

describe('the working directories main may serve a window from', () => {
  it('U-VIS-2 · main is told a window’s working directory when the window shows another session and when the directory of the session it shows changes (a session whose worktree was made, or moved), so `kea-file://` never serves the old folder and refuses the new one; a change that leaves the directory as it was, or is another session’s, sends nothing', () => {
    const visible = new VisibleSet()
    const sessions = new KeyedStore<SessionView>('sessions')
    const view = (id: string, cwd: string, more: Partial<SessionView> = {}): SessionView => ({ id, cwd, lifecycle: 'live', ...more }) as SessionView
    const [one, two] = [{ window: 1 }, { window: 2 }]
    const connections = new Map<number, object>([[1, one], [2, two]])
    const sent: { connId: number; dirs: string[] }[] = []
    const take = () => sent.splice(0)
    const follow = followVisibleDirs({ visible, sessions, connections, send: (connId, dirs) => void sent.push({ connId, dirs }) })

    sessions.set('a', view('a', '/repo'))
    sessions.set('b', view('b', '/other/wt-b'))
    expect(take(), 'no window shows them').toEqual([])
    visible.set(one, 'a')
    visible.set(two, 'b')
    expect(take()).toEqual([{ connId: 1, dirs: ['/repo'] }, { connId: 2, dirs: ['/other/wt-b'] }])

    // the session window 1 shows gets its worktree (creation), then is moved (its branch name was taken)
    sessions.set('a', view('a', '/repo/.worktrees/fix-auth'))
    expect(take()).toEqual([{ connId: 1, dirs: ['/repo/.worktrees/fix-auth'] }])
    sessions.set('a', view('a', '/repo/.worktrees/fix-auth-2'))
    expect(take()).toEqual([{ connId: 1, dirs: ['/repo/.worktrees/fix-auth-2'] }])
    // anything else about it, and another window's session: nothing for window 1
    sessions.set('a', view('a', '/repo/.worktrees/fix-auth-2', { title: 'Fix auth' } as Partial<SessionView>))
    sessions.set('c', view('c', '/elsewhere'))
    expect(take()).toEqual([])
    sessions.set('b', view('b', '/other/wt-b2'))
    expect(take()).toEqual([{ connId: 2, dirs: ['/other/wt-b2'] }])
    // a directory that is not absolute is never sent; a session that is gone has none
    sessions.set('b', view('b', ''))
    expect(take()).toEqual([{ connId: 2, dirs: [] }])
    sessions.delete('a')
    expect(take()).toEqual([{ connId: 1, dirs: [] }])

    // both windows on one session: each is told
    sessions.set('b', view('b', '/other/wt-b'))
    take()
    visible.set(one, 'b')
    expect(take()).toEqual([{ connId: 1, dirs: ['/other/wt-b'] }])
    sessions.set('b', view('b', '/other/wt-b3'))
    expect(take()).toEqual([{ connId: 1, dirs: ['/other/wt-b3'] }, { connId: 2, dirs: ['/other/wt-b3'] }])
    // a window that shows nothing, or is gone, holds nothing and is told nothing more
    visible.set(one, null)
    visible.drop(two)
    expect(take()).toEqual([{ connId: 1, dirs: [] }, { connId: 2, dirs: [] }])
    expect(follow.windows).toBe(0)
    sessions.set('b', view('b', '/other/wt-b4'))
    expect(take()).toEqual([])
    follow.dispose()
    visible.set(one, 'b')
    expect(take(), 'after dispose').toEqual([])
  })
})
