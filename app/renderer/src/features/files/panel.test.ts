// The file panel's pure parts: which rows are drawn, what the keys do, what the Changes view and the finder say. The
// components only lay these out.
import { describe, expect, it, vi } from 'vitest'
import { DISCARD_REFUSALS, filesApi, TREE_HEAD_KEY, treeKey, type GitEntry, type GitHead, type TreeEntry, type TreeRow } from '@kea/protocol'
import { baseLabel, branchLine, branchText, changedList, changeRow, DISCARD_REFUSED, diffHeader, diffStat, discardBlocked, discardPlan, discardRequests, firstChangedLine, midPath, totalsText } from './changes.ts'
import { finderMove, finderNote, hitRow, midParts } from './finder.ts'
import { isTypeKey, listKey, treeKey as key, typeAhead } from './keys.ts'
import { NO_UI, parsePanelUi } from './panelUi.ts'
import { flattenTree } from './rows.ts'
import { pageRows, rowWindow, scrollToShow } from './window.ts'

// the model talks to core through the window's bridge: nothing is asked of it here
vi.mock('../../lib/rpc.ts', () => ({ call: async () => ({}), subscribe: () => () => undefined }))
const values = vi.hoisted(() => ({ 'files.showIgnored': true, 'files.compactFolders': true }))
vi.mock('../settings/store.ts', () => ({ settings: { get: (key: keyof typeof values) => values[key], subscribe: () => () => undefined } }))

async function newModel() {
  const { FilesModel } = await import('./model.ts')
  return new FilesModel()
}

const d = (name: string): TreeEntry => ({ name, kind: 'dir', ignored: false })
const f = (name: string): TreeEntry => ({ name, kind: 'file', ignored: false })
function tree(dirs: Record<string, TreeEntry[]>, paged: string[] = []): Map<string, TreeRow> {
  const m = new Map<string, TreeRow>([[TREE_HEAD_KEY, { git: true, live: true, missing: false }]])
  for (const [path, entries] of Object.entries(dirs)) m.set(treeKey(path), { path, entries, total: paged.includes(path) ? 12_000 : entries.length, paged: paged.includes(path), truncated: false })
  return m
}
const entry = (path: string, code: GitEntry['code'], more: Partial<GitEntry> = {}): GitEntry => ({ path, code, added: 1, removed: 0, origPath: null, ...more })
const head = (more: Partial<GitHead> = {}): GitHead => ({ scope: 'branch', base: 'a'.repeat(40), state: 'ok', branch: 'kea/fix-auth', detached: null, baseBranch: 'main', ahead: 3, behind: 0, operation: null, totals: { files: 7, added: 182, removed: 40 }, ...more })

describe('the file panel’s lists', () => {
  it('U-FT-12 · the rows drawn are the ones on screen plus the overscan, whatever the list holds: 100 000 rows draw as many as 100; the window follows the scroll position, stops at both ends, and a list that shrank under the scroll position draws its last screenful', () => {
    const ROW = 24
    expect(rowWindow(0, 480, ROW, 100_000, 8)).toEqual({ start: 0, end: 28, offset: 0, height: 2_400_000 })
    // the same number of rows at any position, in a list of any length
    for (const count of [100, 10_000, 100_000, 500_000]) {
      const top = Math.floor(count / 2) * ROW + 7
      const w = rowWindow(top, 480, ROW, count, 8)
      expect(w.end - w.start).toBe(8 + 21 + 8) // 480 px shows 20 whole rows and one cut at each edge
      expect(w.start).toBe(Math.floor(top / ROW) - 8)
      expect(w.offset).toBe(w.start * ROW)
    }
    // the ends
    expect(rowWindow(2_400_000 - 480, 480, ROW, 100_000, 8)).toMatchObject({ start: 100_000 - 20 - 8, end: 100_000 })
    expect(rowWindow(9_999_999, 480, ROW, 50, 8)).toMatchObject({ start: 22, end: 50 }) // shrank: the last screenful
    expect(rowWindow(0, 480, ROW, 3, 8)).toEqual({ start: 0, end: 3, offset: 0, height: 72 })
    expect(rowWindow(0, 480, ROW, 0, 8)).toEqual({ start: 0, end: 0, offset: 0, height: 0 })
    expect(rowWindow(120, 0, ROW, 100, 8)).toMatchObject({ start: 0, end: 14 }) // a hidden panel: the overscan only
    // bringing a row into view moves as little as possible
    expect(scrollToShow(5, 0, 480, ROW)).toBe(0)
    expect(scrollToShow(30, 0, 480, ROW)).toBe(31 * ROW - 480)
    expect(scrollToShow(2, 240, 480, ROW)).toBe(48)
    expect(pageRows(480, ROW)).toBe(19)
    expect(pageRows(10, ROW)).toBe(1)
  })

  it('U-FT-13 · the tree’s keys: ↑ ↓ Home End and the page keys move and stop at the ends; → opens a folder, then steps into it; ← closes an open folder, else goes to the folder the row is in; a compact row closes as a whole and opens at its innermost folder; Enter opens a file with the keyboard, Space without, and both toggle a folder; “Show all” loads the folder; typing a name finds the next row that starts with it', () => {
    const data = tree({ '': [d('packages'), d('src'), f('README.md'), f('readme.txt')], packages: [d('app')], 'packages/app': [f('main.ts'), f('util.ts')], src: [f('a.ts')] }, ['src'])
    const rows = flattenTree(data, new Set(['packages', 'packages/app', 'src']), { compact: true, showIgnored: false })
    expect(rows.map((r) => r.label || `more:${r.total}`)).toEqual(['packages/app', 'main.ts', 'util.ts', 'src', 'a.ts', 'more:12000', 'README.md', 'readme.txt'])
    const k = (i: number, name: string) => key(rows, i, name, 3)
    // movement
    expect(k(0, 'ArrowDown')).toEqual({ do: 'select', index: 1 })
    expect(k(7, 'ArrowDown')).toEqual({ do: 'select', index: 7 })
    expect(k(0, 'ArrowUp')).toEqual({ do: 'select', index: 0 })
    expect(k(4, 'Home')).toEqual({ do: 'select', index: 0 })
    expect(k(4, 'End')).toEqual({ do: 'select', index: 7 })
    expect(k(1, 'PageDown')).toEqual({ do: 'select', index: 4 })
    expect(k(1, 'PageUp')).toEqual({ do: 'select', index: 0 })
    expect(k(-1, 'ArrowDown')).toEqual({ do: 'select', index: 0 }) // no row yet: the first
    expect(k(-1, 'ArrowUp')).toEqual({ do: 'select', index: 7 })
    // folders
    expect(k(0, 'ArrowRight')).toEqual({ do: 'select', index: 1 }) // open: into it
    expect(k(0, 'ArrowLeft')).toEqual({ do: 'collapse', path: 'packages' }) // the compact row closes as a whole
    expect(k(2, 'ArrowLeft')).toEqual({ do: 'select', index: 0 }) // a file: to its folder
    expect(k(6, 'ArrowLeft')).toBeNull() // at the top level there is none
    expect(k(1, 'ArrowRight')).toBeNull()
    const closed = flattenTree(data, new Set(['packages']), { compact: true, showIgnored: false })
    expect(closed[0]).toMatchObject({ label: 'packages/app', expanded: false })
    expect(key(closed, 0, 'ArrowRight', 3)).toEqual({ do: 'expand', path: 'packages/app' }) // opens at its innermost folder
    expect(key(closed, 0, 'Enter', 3)).toEqual({ do: 'expand', path: 'packages/app' })
    expect(k(0, 'Enter')).toEqual({ do: 'collapse', path: 'packages' })
    expect(k(3, ' ')).toEqual({ do: 'collapse', path: 'src' })
    // files
    expect(k(1, 'Enter')).toEqual({ do: 'open', index: 1, focus: true })
    expect(k(1, ' ')).toEqual({ do: 'open', index: 1, focus: false })
    expect(k(5, 'Enter')).toEqual({ do: 'showAll', dir: 'src' })
    expect(k(1, 'x')).toBeNull()
    expect(key([], -1, 'ArrowDown', 3)).toBeNull()
    // the Changes list: the same movement, no folders
    expect(listKey(3, 0, 'ArrowDown', 3)).toEqual({ do: 'select', index: 1 })
    expect(listKey(3, 2, 'Enter', 3)).toEqual({ do: 'open', index: 2, focus: true })
    expect(listKey(3, 2, ' ', 3)).toEqual({ do: 'open', index: 2, focus: false })
    expect(listKey(3, 2, 'ArrowRight', 3)).toBeNull()
    expect(listKey(0, -1, 'Enter', 3)).toBeNull()

    // type-ahead
    const labels = rows.map((r) => r.label)
    expect(typeAhead(labels, 0, 'r')).toBe(6) // the next row that starts with it
    expect(typeAhead(labels, 6, 'r')).toBe(7) // the same letter again: the one after
    expect(typeAhead(labels, 7, 'r')).toBe(6) // and round
    expect(typeAhead(labels, 6, 're')).toBe(6) // a longer prefix stays while it matches
    expect(typeAhead(labels, 6, 'readme.t')).toBe(7)
    expect(typeAhead(labels, 3, 'a')).toBe(4)
    expect(typeAhead(labels, 4, 'ap')).toBe(0) // a compact row is found by any of its folders
    expect(typeAhead(labels, 0, 'zz')).toBe(-1)
    expect(typeAhead([], -1, 'a')).toBe(-1)
    expect(isTypeKey({ key: 'a', metaKey: false, ctrlKey: false, altKey: false })).toBe(true)
    expect(isTypeKey({ key: 'a', metaKey: true, ctrlKey: false, altKey: false })).toBe(false)
    expect(isTypeKey({ key: ' ', metaKey: false, ctrlKey: false, altKey: false })).toBe(false)
    expect(isTypeKey({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false })).toBe(false)
  })

  it('U-GS-10 · the Changes view’s words: a row’s letter, name, folder and `+n −n`; a rename as `old → new`; a deleted file struck through; a submodule as `S`; the totals; the branch line with its base, `↑n`, “behind n”, `REBASING 2/5` / `MERGING` and a detached HEAD’s short id; the header’s diff stat only while there are changes', () => {
    expect(changeRow(entry('src/auth/login.ts', 'M', { added: 12, removed: 3 }))).toEqual({ path: 'src/auth/login.ts', letter: 'M', cls: 'modified', name: 'login.ts', dir: 'src/auth', struck: false, added: '+12', removed: '−3' })
    expect(changeRow(entry('README.md', 'U', { added: 4 }))).toMatchObject({ letter: 'U', cls: 'added', name: 'README.md', dir: '' })
    expect(changeRow(entry('src/gone.ts', 'D', { added: 0, removed: 9 }))).toMatchObject({ struck: true, removed: '−9' })
    expect(changeRow(entry('logo.png', 'M', { added: null, removed: null }))).toMatchObject({ added: null, removed: null }) // binary: no count
    expect(changeRow(entry('src/new.ts', 'R', { origPath: 'src/old.ts' })).name).toBe('old.ts → new.ts')
    expect(changeRow(entry('lib/new.ts', 'R', { origPath: 'src/old.ts' }))).toMatchObject({ name: 'src/old.ts → new.ts', dir: 'lib', cls: 'renamed' })
    expect(changeRow(entry('vendor/sub', 'M', { submodule: true })).letter).toBe('S')
    expect(changeRow(entry('a.ts', '!')).cls).toBe('conflict')
    expect(changedList([entry('b.ts', 'M'), entry('a.ts', 'U')])).toBe('b.ts\na.ts')

    expect(totalsText(head())).toEqual({ files: '7 files', added: '+182', removed: '−40' })
    expect(totalsText(head({ totals: { files: 1, added: 0, removed: 0 } }))?.files).toBe('1 file')
    expect(totalsText(head({ state: 'loading' }))).toBeNull()
    expect(totalsText(null)).toBeNull()

    expect(branchText(branchLine(head())!)).toBe('kea/fix-auth ← main ↑3')
    expect(branchText(branchLine(head({ ahead: 0, behind: 12 }))!)).toBe('kea/fix-auth ← main behind 12')
    expect(branchText(branchLine(head({ operation: { kind: 'rebase', step: 2, total: 5 } }))!)).toBe('REBASING 2/5 kea/fix-auth ← main ↑3')
    expect(branchLine(head({ operation: { kind: 'merge', step: null, total: null } }))?.operation).toBe('MERGING')
    expect(branchLine(head({ branch: null, detached: '1a2b3c4', baseBranch: null, ahead: null }))).toEqual({ name: '1a2b3c4', detached: true, base: null, ahead: null, behind: null, operation: null })
    expect(branchLine(head({ branch: null, detached: null }))).toBeNull()
    expect(branchLine(null)).toBeNull()

    expect(diffStat(head())).toMatchObject({ added: '+182', removed: '−40' })
    // only renames or binary files changed: the count of files, never `+0 −0`
    expect(diffStat(head({ totals: { files: 2, added: 0, removed: 0 } }))).toMatchObject({ added: null, removed: null, files: '2 files', label: '2 changed files, no line counted: show Changes' })
    expect(diffStat(head({ totals: { files: 1, added: 0, removed: 3 } }))).toMatchObject({ added: '+0', removed: '−3', files: '1 file' })
    expect(diffStat(head({ totals: { files: 0, added: 0, removed: 0 } }))).toBeNull() // nothing changed: nothing shown
    expect(diffStat(head({ state: 'notGit' }))).toBeNull()
    expect(diffStat(head({ state: 'loading' }))).toBeNull()
    expect(diffStat(head({ state: 'tooMany' }))).toBeNull()
    expect(diffStat(head({ state: 'unavailable' }))).not.toBeNull() // the last status that worked
    expect(diffStat(null)).toBeNull()
  })

  it('U-GS-11 · a count of nothing is not shown: no totals while nothing has changed, the number of files alone when no line has, and no `+0 −0` on a row with no changed line (a pure rename, an empty new file, a mode change); a row with lines on one side keeps the other side’s zero', () => {
    expect(totalsText(head({ totals: { files: 0, added: 0, removed: 0 } }))).toBeNull()
    expect(totalsText(head({ state: 'unavailable', totals: { files: 0, added: 0, removed: 0 } }))).toBeNull()
    expect(totalsText(head({ totals: { files: 2, added: 0, removed: 0 } }))).toEqual({ files: '2 files', added: null, removed: null })
    expect(totalsText(head({ totals: { files: 2, added: 0, removed: 5 } }))).toEqual({ files: '2 files', added: '+0', removed: '−5' })

    expect(changeRow(entry('lib/new.ts', 'R', { origPath: 'src/old.ts', added: 0, removed: 0 }))).toMatchObject({ added: null, removed: null })
    expect(changeRow(entry('empty.txt', 'U', { added: 0, removed: null }))).toMatchObject({ added: null, removed: null })
    expect(changeRow(entry('run.sh', 'M', { added: 0, removed: 0 }))).toMatchObject({ added: null, removed: null })
    expect(changeRow(entry('notes.md', 'U', { added: 4, removed: null }))).toMatchObject({ added: '+4', removed: null }) // an untracked file: `+n` alone
    expect(changeRow(entry('a.ts', 'M', { added: 5, removed: 0 }))).toMatchObject({ added: '+5', removed: '−0' })
    expect(changeRow(entry('gone.ts', 'D', { added: 0, removed: 9 }))).toMatchObject({ added: '+0', removed: '−9' })
  })

  it('U-DF-3 · the diff header’s letter and its `+n −n` say one thing: the status’s entry gives both; a path the status has no entry for (too many changes to track) gets both from the diff on screen, added or deleted by the side that is not there, modified when lines differ; a diff with no change shows neither, and a count of nothing is not shown', () => {
    const on = (old: boolean, now: boolean, added: number, removed: number) => ({ old, new: now, counts: { added, removed } })
    // the status has the path: its letter, and git’s counts whatever the diff on screen counts
    expect(diffHeader(entry('a.ts', 'M', { added: 3, removed: 2 }), on(true, true, 9, 9))).toEqual({ letter: 'M', counts: { added: 3, removed: 2 } })
    expect(diffHeader(entry('a.ts', 'M', { added: 3, removed: 2 }), null), 'before the diff is read').toEqual({ letter: 'M', counts: { added: 3, removed: 2 } })
    // a file the status did not count is counted from the diff on screen
    expect(diffHeader(entry('notes.md', 'U', { added: 4, removed: null }), on(false, true, 4, 0))).toEqual({ letter: 'U', counts: { added: 4, removed: 0 } })
    expect(diffHeader(entry('logo.png', 'M', { added: null, removed: null }), { old: true, new: true, counts: null })).toEqual({ letter: 'M', counts: null })
    expect(diffHeader(entry('lib/new.ts', 'R', { origPath: 'src/old.ts', added: 0, removed: 0 }), on(true, true, 0, 0)), 'a pure rename').toEqual({ letter: 'R', counts: null })

    // no entry: the letter is what the diff on screen shows, and the counts are its own
    expect(diffHeader(null, on(true, true, 1, 7))).toEqual({ letter: 'M', counts: { added: 1, removed: 7 } })
    expect(diffHeader(null, on(false, true, 12, 0))).toEqual({ letter: 'A', counts: { added: 12, removed: 0 } })
    expect(diffHeader(null, on(true, false, 0, 30))).toEqual({ letter: 'D', counts: { added: 0, removed: 30 } })
    expect(diffHeader(null, { old: false, new: true, counts: null }), 'a new binary file').toEqual({ letter: 'A', counts: null })
    // nothing differs, or nothing says that it does: no letter, and then no counts either
    expect(diffHeader(null, on(true, true, 0, 0))).toEqual({ letter: null, counts: null })
    expect(diffHeader(null, on(false, false, 0, 0))).toEqual({ letter: null, counts: null })
    expect(diffHeader(null, { old: true, new: true, counts: null }), 'two binary sides').toEqual({ letter: null, counts: null })
    expect(diffHeader(null, null)).toEqual({ letter: null, counts: null })
  })

  it('U-FT-18 · a folder’s path is cut in its middle, not at its end: the last folder stays whole and what is before it gives way; a finder hit’s folder is cut at the same place, its marked runs kept', () => {
    expect(midPath('app/renderer/src/features/files')).toEqual({ head: 'app/renderer/src/features', tail: '/files' })
    expect(midPath('a/b')).toEqual({ head: 'a', tail: '/b' })
    expect(midPath('src'), 'one folder is all tail').toEqual({ head: '', tail: 'src' })
    expect(midPath('')).toEqual({ head: '', tail: '' })
    for (const p of ['', 'src', 'a/b', 'a/b c/é/d']) expect(midPath(p).head + midPath(p).tail).toBe(p)

    const hit = hitRow({ path: 'src/auth/login.ts', matched: [4, 9, 10], changed: true })
    expect(midParts(hit.dir)).toEqual({ head: [{ text: 'src', hit: false }], tail: [{ text: '/', hit: false }, { text: 'a', hit: true }, { text: 'uth', hit: false }] })
    expect(midParts([{ text: 'lib/mod', hit: true }]), 'a run across the cut is split there').toEqual({ head: [{ text: 'lib', hit: true }], tail: [{ text: '/mod', hit: true }] })
    expect(midParts([{ text: 'src', hit: false }])).toEqual({ head: [], tail: [{ text: 'src', hit: false }] })
    expect(midParts([])).toEqual({ head: [], tail: [] })
  })

  it('U-FT-14 · Discard Changes… says what it will do before it does it: a changed or deleted file is put back as the base has it, an untracked or added one moves to the Trash, a rename is both in that order; a conflict and a submodule cannot be discarded from here; the base is named by its scope', () => {
    expect(discardPlan(entry('src/a.ts', 'M'), head())).toMatchObject({ steps: [{ path: 'src/a.ts', expect: 'restore' }], button: 'Discard Changes' })
    expect(discardPlan(entry('src/a.ts', 'D'), head())).toMatchObject({ steps: [{ path: 'src/a.ts', expect: 'restore' }], button: 'Restore' })
    for (const code of ['U', 'A'] as const) expect(discardPlan(entry('notes.md', code), head())).toMatchObject({ steps: [{ path: 'notes.md', expect: 'trash' }], button: 'Move to Trash' })
    const rename = discardPlan(entry('lib/new.ts', 'R', { origPath: 'src/old.ts' }), head())
    expect(rename.steps).toEqual([{ path: 'lib/new.ts', expect: 'trash' }, { path: 'src/old.ts', expect: 'restore' }])
    expect(rename.text).toContain('old.ts')
    for (const plan of [discardPlan(entry('src/a.ts', 'M'), head()), rename]) expect(plan.text).toContain('main')
    expect(discardPlan(entry('notes.md', 'U'), head()).text).toContain('Trash')
    expect(discardBlocked(entry('a.ts', '!'))).toMatch(/conflict/)
    expect(discardBlocked(entry('vendor/sub', 'M', { submodule: true }))).toMatch(/submodule/)
    expect(discardBlocked(entry('a.ts', 'M'))).toBeNull()
    expect(baseLabel(head())).toContain('main')
    expect(baseLabel(head({ scope: 'uncommitted' }))).toBe('the last commit')
    expect(baseLabel(head({ baseBranch: null }))).toMatch(/started from/)
  })

  it('U-FT-17 · the sheet’s plan names the scope and the commit its sentence was written for, and every request made from it carries them with the path and what is expected there, so core can refuse when either no longer holds; the request’s schema takes none that leaves them out; an untracked file’s sentence says what the window knows (git does not track it), not that the base has no file there', () => {
    const fork = 'b'.repeat(40)
    const last = 'c'.repeat(40)
    const inBranch = discardPlan(entry('src/a.ts', 'M'), head({ base: fork }))
    expect(inBranch).toMatchObject({ scope: 'branch', base: fork })
    expect(inBranch.text).toContain('main')
    const inUncommitted = discardPlan(entry('src/a.ts', 'M'), head({ scope: 'uncommitted', base: last }))
    expect(inUncommitted).toMatchObject({ scope: 'uncommitted', base: last })
    expect(inUncommitted.text).toContain('the last commit')
    expect(discardPlan(entry('notes.md', 'U'), head({ base: null })).base, 'a repository with no commit yet').toBeNull()

    // one request per step, each with what the sheet said
    expect(discardRequests('s1', inUncommitted)).toEqual([{ sessionId: 's1', path: 'src/a.ts', expect: 'restore', scope: 'uncommitted', base: last }])
    const rename = discardPlan(entry('lib/new.ts', 'R', { origPath: 'src/old.ts' }), head({ base: fork }))
    expect(discardRequests('s1', rename)).toEqual([
      { sessionId: 's1', path: 'lib/new.ts', expect: 'trash', scope: 'branch', base: fork },
      { sessionId: 's1', path: 'src/old.ts', expect: 'restore', scope: 'branch', base: fork },
    ])
    const args = filesApi['files.discard'].args
    for (const req of [...discardRequests('s1', inBranch), ...discardRequests('s1', rename)]) expect(args.safeParse(req).success).toBe(true)
    expect(args.safeParse({ sessionId: 's1', path: 'src/a.ts', expect: 'restore' }).success, 'neither').toBe(false)
    expect(args.safeParse({ sessionId: 's1', path: 'src/a.ts', expect: 'restore', scope: 'branch' }).success, 'no base').toBe(false)
    expect(args.safeParse({ sessionId: 's1', path: 'src/a.ts', expect: 'restore', base: fork }).success, 'no scope').toBe(false)
    expect(args.safeParse({ sessionId: 's1', path: 'src/a.ts', expect: 'restore', scope: 'branch', base: 'HEAD~1' }).success, 'not an object id').toBe(false)
    expect(args.safeParse({ sessionId: 's1', path: 'notes.md', expect: 'trash', scope: 'branch', base: null }).success, 'no commit yet').toBe(true)

    // `U` is what git says of the file, not of the base: the window does not know whether the base has one there
    const untracked = discardPlan(entry('notes.md', 'U'), head({ base: fork }))
    expect(untracked.text).toContain('Trash')
    expect(untracked.text).toMatch(/does not track/)
    expect(untracked.text).not.toMatch(/does not have it/)
    expect(discardPlan(entry('notes.md', 'A'), head({ base: fork })).text).toMatch(/main .*does not have it/)
  })

  it('U-FT-20 · a deleted row whose file the base does not have either (added to git, then deleted from disk: core marks the row as the index’s alone) is offered for what can be done: Restore, put back as it was added, and the request says so; never "as it is in the last commit", which has no such file; the ordinary deleted row reads as before', () => {
    const last = 'c'.repeat(40)
    const h = head({ scope: 'uncommitted', base: last })
    const marked = entry('src/draft.ts', 'D', { added: null, removed: null, indexOnly: true })
    const plan = discardPlan(marked, h)
    expect(plan).toMatchObject({ scope: 'uncommitted', base: last, button: 'Restore', steps: [{ path: 'src/draft.ts', expect: 'restoreStaged' }] })
    expect(plan.text).toBe('Restore draft.ts? It was added to git and then deleted from disk, and the last commit does not have it: it is put back as it was added.')
    expect(discardRequests('s1', plan)).toEqual([{ sessionId: 's1', path: 'src/draft.ts', expect: 'restoreStaged', scope: 'uncommitted', base: last }])
    // the request and the marked row cross the boundary; with no commit yet too
    const args = filesApi['files.discard'].args
    expect(args.safeParse(discardRequests('s1', plan)[0]).success).toBe(true)
    const unborn = discardPlan(marked, head({ scope: 'uncommitted', base: null }))
    expect(unborn.steps).toEqual([{ path: 'src/draft.ts', expect: 'restoreStaged' }])
    expect(args.safeParse(discardRequests('s1', unborn)[0]).success).toBe(true)
    expect(discardBlocked(marked)).toBeNull()
    // a deleted file the base has: put back from there
    const plain = discardPlan(entry('src/a.ts', 'D'), h)
    expect(plain.steps).toEqual([{ path: 'src/a.ts', expect: 'restore' }])
    expect(plain.text).toBe('Restore a.ts? It is put back as it is in the last commit.')
  })

  it('U-FT-22 · every reason core can refuse a discard with has its sentence, none the same as another; on a Mac without the `trash` tool the sentence names the tool, the macOS that has it, and says the file was left alone', () => {
    for (const r of DISCARD_REFUSALS) expect(DISCARD_REFUSED[r], r).toMatch(/\S/)
    expect(Object.keys(DISCARD_REFUSED).sort()).toEqual([...DISCARD_REFUSALS].sort())
    expect(new Set(Object.values(DISCARD_REFUSED)).size).toBe(DISCARD_REFUSALS.length)
    expect(DISCARD_REFUSED.noTrash).toBe('This Mac has no `trash` tool (macOS 15 or later); the file was left alone')
  })

  it('U-FT-15 · a finder hit is shown as its name and its folder with the matched characters marked; ↑ ↓ wrap through the list; the last line says when nothing matched and when the list of files was cut at its cap', () => {
    expect(hitRow({ path: 'src/auth/login.ts', matched: [4, 9, 10], changed: true })).toEqual({
      path: 'src/auth/login.ts',
      name: [{ text: 'lo', hit: true }, { text: 'gin.ts', hit: false }],
      dir: [{ text: 'src/', hit: false }, { text: 'a', hit: true }, { text: 'uth', hit: false }],
      changed: true,
    })
    expect(hitRow({ path: 'README.md', matched: [], changed: false })).toEqual({ path: 'README.md', name: [{ text: 'README.md', hit: false }], dir: [], changed: false })
    expect(finderMove(3, 0, 'ArrowDown')).toBe(1)
    expect(finderMove(3, 2, 'ArrowDown')).toBe(0)
    expect(finderMove(3, 0, 'ArrowUp')).toBe(2)
    expect(finderMove(3, 1, 'PageDown')).toBe(2)
    expect(finderMove(3, 1, 'PageUp')).toBe(0)
    expect(finderMove(3, 1, 'Home')).toBeNull() // the input's own
    expect(finderMove(0, 0, 'ArrowDown')).toBe(-1)
    expect(finderMove(3, 1, 'a')).toBeNull()
    const base = { hits: 5, total: 1200, truncated: false, query: 'lo', loading: false }
    expect(finderNote(base)).toBeNull()
    expect(finderNote({ ...base, hits: 0 })).toBe('No matching files.')
    expect(finderNote({ ...base, hits: 0, query: '' })).toBe('Type to find a file.')
    expect(finderNote({ ...base, total: 500_000, truncated: true })).toBe('Showing the first 500 000 files; the rest are not searched.')
    expect(finderNote({ ...base, hits: 0, total: 500_000, truncated: true })).toBe('No matching files. Showing the first 500 000 files; the rest are not searched.')
    expect(finderNote({ ...base, hits: 0, loading: true })).toBeNull()
  })

  it('U-ED-4 · Open in Editor from the Changes list lands on the file’s first changed line: the first changed range’s first line, the line a leading removal follows (line 1 when it was the file’s start), line 1 for a file that is new as a whole, and no position when nothing changed in its text or its ranges were not read', () => {
    const lines = { scope: 'branch' as const, base: 'a'.repeat(40), changes: [], whole: false, truncated: false }
    expect(firstChangedLine({ ...lines, changes: [{ kind: 'modified', from: 12, to: 12 }, { kind: 'added', from: 20, to: 24 }] })).toBe(12)
    expect(firstChangedLine({ ...lines, changes: [{ kind: 'added', from: 1, to: 3 }] })).toBe(1)
    expect(firstChangedLine({ ...lines, changes: [{ kind: 'deleted', from: 40, to: 40 }, { kind: 'modified', from: 60, to: 61 }] })).toBe(40)
    expect(firstChangedLine({ ...lines, changes: [{ kind: 'deleted', from: 0, to: 0 }] })).toBe(1)
    expect(firstChangedLine({ ...lines, base: null, whole: true })).toBe(1)
    expect(firstChangedLine(lines), 'a mode change, a binary file').toBeNull()
    expect(firstChangedLine({ ...lines, truncated: true })).toBeNull()
  })

  it('U-FT-16 · the panel state core kept for a session is read field by field: anything missing or of the wrong kind takes its default, so a state written by another version never breaks the panel', () => {
    const none = { mode: null, showIgnored: null, hintClosed: false, files: { top: 0, sel: null }, changes: { top: 0, sel: null } }
    for (const raw of [undefined, null, 'x', 7, [], {}]) expect(parsePanelUi(raw)).toEqual(none)
    expect(parsePanelUi({ mode: 'changes', showIgnored: true, hintClosed: true, files: { top: 240.4, sel: 'src/a.ts' }, changes: { top: 48, sel: 'b.ts' } })).toEqual({ mode: 'changes', showIgnored: true, hintClosed: true, files: { top: 240, sel: 'src/a.ts' }, changes: { top: 48, sel: 'b.ts' } })
    expect(parsePanelUi({ mode: 'tree', showIgnored: 'yes', files: { top: -5, sel: '' }, changes: { top: Number.NaN, sel: 3 }, tab: 'changes', scrollTop: 240 })).toEqual(none)
  })

  it('U-FT-34 · ignored files are listed by default (the files.showIgnored setting); a choice made in a session, on or off, is that session’s, and one never made follows the setting', async () => {
    const m = await newModel()
    expect(NO_UI.showIgnored).toBeNull()
    expect(m.showIgnored).toBe(true)
    m.ui = { ...NO_UI, showIgnored: false }
    expect(m.showIgnored).toBe(false)
    m.ui = { ...NO_UI, showIgnored: true }
    expect(m.showIgnored).toBe(true)
    // the setting turned off: a session that never chose follows it, one that chose keeps its choice
    values['files.showIgnored'] = false
    m.ui = NO_UI
    expect(m.showIgnored).toBe(false)
    m.ui = { ...NO_UI, showIgnored: true }
    expect(m.showIgnored).toBe(true)
    values['files.showIgnored'] = true
    // an off choice is kept as one, not read as none
    expect(parsePanelUi({ showIgnored: false }).showIgnored).toBe(false)
    expect(parsePanelUi({}).showIgnored).toBeNull()
  })

  it('U-FT-35 · the files.compactFolders setting decides whether a folder holding one folder is one row', async () => {
    const data = tree({ '': [d('packages')], packages: [d('app')], 'packages/app': [f('a.ts')] })
    const open = new Set(['packages', 'packages/app'])
    expect(flattenTree(data, open, { compact: true, showIgnored: true }).map((r) => r.path)).toEqual(['packages/app', 'packages/app/a.ts'])
    expect(flattenTree(data, open, { compact: false, showIgnored: true }).map((r) => r.path)).toEqual(['packages', 'packages/app', 'packages/app/a.ts'])
    const m = await newModel()
    expect(m.compact).toBe(true)
    values['files.compactFolders'] = false
    expect(m.compact).toBe(false)
    values['files.compactFolders'] = true
  })
})
