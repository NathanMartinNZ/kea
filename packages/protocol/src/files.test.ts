import { describe, expect, it } from 'vitest'
import { changesOrder, GIT_HEAD_KEY, gitEntry, gitHead, gitKey, gitStoreName, isWorktreePath, zGitEntry, zWorktreePath, type GitEntry, type GitRow } from './files.ts'
import { zEditorOpenRequest } from './editor.ts'
import { zOpenRequest } from './viewer.ts'

const entry = (path: string, code: GitEntry['code'] = 'M', over: Partial<GitEntry> = {}): GitEntry => ({ path, code, added: 1, removed: 0, origPath: null, ...over })

describe('paths that cross a boundary', () => {
  it('U-FILES-1 · a worktree path is relative and stays inside: no absolute path, no empty, `.` or `..` segment, no NUL; the open and editor requests take nothing else', () => {
    for (const ok of ['a', 'src/auth/login.ts', '.gitignore', 'a b/ü.md', 'a:1', '__proto__', '...', 'src/..hidden']) expect(isWorktreePath(ok), ok).toBe(true)
    // os-ok: test data
    for (const bad of ['', '/etc/passwd', '..', '../x', 'a/../b', 'a/./b', './a', 'a//b', 'a/', 'a\0b']) expect(isWorktreePath(bad), JSON.stringify(bad)).toBe(false)
    expect(zWorktreePath.safeParse('src/a.ts').success).toBe(true)
    expect(zWorktreePath.safeParse('../a.ts').success).toBe(false)

    const open = { sessionId: 's1', path: 'src/a.ts', mode: 'diff' }
    expect(zOpenRequest.parse(open)).toEqual(open)
    expect(zOpenRequest.parse({ ...open, line: 12, col: 3, pin: true, focus: false })).toEqual({ ...open, line: 12, col: 3, pin: true, focus: false })
    for (const bad of [{ path: '/abs' }, { path: 'a/../../b' }, { mode: 'blame' }, { line: 0 }, { col: 1.5 }, { sessionId: 'no/slash' }, { focus: 'no' }]) expect(zOpenRequest.safeParse({ ...open, ...bad }).success, JSON.stringify(bad)).toBe(false)

    expect(zEditorOpenRequest.safeParse({ target: 'session', id: 's1' }).success, 'the folder itself').toBe(true)
    expect(zEditorOpenRequest.safeParse({ target: 'project', id: 'p1', path: 'a:1', line: 4, col: 2, editor: 'vscode' }).success).toBe(true)
    for (const bad of [{ target: 'file' }, { path: '/abs' }, { path: '../up' }, { line: 0 }, { editor: '' }]) expect(zEditorOpenRequest.safeParse({ target: 'session', id: 's1', ...bad }).success, JSON.stringify(bad)).toBe(false)
  })
})

describe('the git status store', () => {
  it('U-FILES-2 · one store holds a session’s status: the head, and an entry per changed path found by its path (also a file named `head` or `__proto__`); the Changes order is conflicts first, then by path', () => {
    expect(gitStoreName('s1')).toBe('git:s1')
    const data = new Map<string, GitRow>()
    expect({ head: gitHead(data), entry: gitEntry(data, 'a.ts'), order: changesOrder(data) }).toEqual({ head: null, entry: null, order: [] })

    const entries = [entry('src/z.ts'), entry('b.ts', '!'), entry('src/a.ts', 'A'), entry('Src/a.ts', 'U'), entry('head', 'D'), entry('__proto__'), entry('new.ts', 'R', { origPath: 'old.ts' }), entry('a/conflict.ts', '!')]
    data.set(GIT_HEAD_KEY, { scope: 'uncommitted', base: 'f'.repeat(40) })
    for (const e of entries) data.set(gitKey(e.path), e)
    expect(data.size, 'no path took the head’s key or another path’s').toBe(entries.length + 1)

    expect(gitHead(data)).toEqual({ scope: 'uncommitted', base: 'f'.repeat(40) })
    expect(gitEntry(data, 'src/a.ts')).toEqual(entry('src/a.ts', 'A'))
    expect(gitEntry(data, 'head')?.code).toBe('D')
    expect(gitEntry(data, '__proto__')?.path).toBe('__proto__')
    expect(gitEntry(data, 'new.ts')?.origPath).toBe('old.ts')
    expect(gitEntry(data, 'src/unchanged.ts'), 'no entry: unchanged, so no File · Diff switch').toBeNull()
    // conflicts first, then every path by code unit (capitals before small letters), whatever order the store has them in
    expect(changesOrder(data).map((e) => e.path)).toEqual(['a/conflict.ts', 'b.ts', 'Src/a.ts', '__proto__', 'head', 'new.ts', 'src/a.ts', 'src/z.ts'])
    expect(changesOrder(new Map([...data].reverse())).map((e) => e.path)).toEqual(changesOrder(data).map((e) => e.path))

    // an entry as it crosses: counts may be absent (binary), a rename names its old path
    expect(zGitEntry.safeParse(entry('img.png', 'M', { added: null, removed: null })).success).toBe(true)
    for (const bad of [{ code: 'X' }, { added: -1 }, { path: '/abs' }, { origPath: '../x' }]) expect(zGitEntry.safeParse({ ...entry('a.ts'), ...bad }).success, JSON.stringify(bad)).toBe(false)
  })
})
