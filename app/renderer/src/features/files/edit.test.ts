import { describe, expect, it } from 'vitest'
import { darwin } from '@kea/protocol/os/darwin'
import { linux } from '@kea/protocol/os/linux'
import { afterPlan, dropEffect, fieldAction, folderOf, movedPath, nextAfter, opMessage, refusedInline, startName, stem, type Answer, type AfterContext } from './edit.ts'
import type { FlatRow } from './rows.ts'

const row = (path: string, kind: FlatRow['kind'] = 'file', depth = path.split('/').length - 1): FlatRow => ({ path, label: path.slice(path.lastIndexOf('/') + 1), chain: [path], kind, depth, ignored: false, expanded: false, loading: false })

describe('the name field', () => {
  const at = { nested: true, dir: 'src' }

  it('U-FT-26 · ↵ commits unless an input method is composing; Esc, another session and the panel leaving Files cancel; the window losing the keyboard does nothing', () => {
    expect(fieldAction({ kind: 'enter', composing: false }, 'a.ts', at)).toBe('commit')
    expect(fieldAction({ kind: 'enter', composing: true }, 'a.ts', at)).toBe('none')
    // ↵ commits even a bad name: core's or the field's check says why in place
    expect(fieldAction({ kind: 'enter', composing: false }, '', at)).toBe('commit')
    expect(fieldAction({ kind: 'escape' }, 'a.ts', at)).toBe('cancel')
    expect(fieldAction({ kind: 'away' }, 'a.ts', at)).toBe('cancel')
    expect(fieldAction({ kind: 'blur' }, 'a.ts', at)).toBe('none')
    expect(fieldAction({ kind: 'blur' }, '', at)).toBe('none')
  })

  it('U-FT-26 · a press outside or the keyboard moving away commits a valid name and cancels any other; inside the field, or into a menu or sheet over it, nothing happens', () => {
    for (const kind of ['press', 'focus'] as const) {
      expect(fieldAction({ kind, inside: false, layer: false }, 'a.ts', at), kind).toBe('commit')
      expect(fieldAction({ kind, inside: false, layer: false }, '', at), kind).toBe('cancel')
      expect(fieldAction({ kind, inside: false, layer: false }, '.git', at), kind).toBe('cancel')
      expect(fieldAction({ kind, inside: false, layer: false }, 'a/b', { nested: false, dir: '' }), kind).toBe('cancel')
      expect(fieldAction({ kind, inside: true, layer: false }, 'a.ts', at), kind).toBe('none')
      expect(fieldAction({ kind, inside: false, layer: true }, 'a.ts', at), kind).toBe('none')
    }
  })

  it('U-FT-26 · a name core refused is not sent again by a press outside (single-shot per attempt); ↵ sends it again; another name commits', () => {
    const refused = { ...at, refused: 'taken.ts' }
    expect(fieldAction({ kind: 'press', inside: false, layer: false }, 'taken.ts', refused)).toBe('cancel')
    expect(fieldAction({ kind: 'focus', inside: false, layer: false }, 'taken.ts', refused)).toBe('cancel')
    expect(fieldAction({ kind: 'enter', composing: false }, 'taken.ts', refused)).toBe('commit')
    expect(fieldAction({ kind: 'press', inside: false, layer: false }, 'free.ts', refused)).toBe('commit')
  })

  it('U-FT-26 · what the field starts with and selects first: a file’s name before its extension, all of a folder’s or a dotfile’s', () => {
    expect(startName(null)).toBe('')
    expect(startName('src/lib/a.test.ts')).toBe('a.test.ts')
    expect(startName('README.md')).toBe('README.md')
    expect(stem('a.test.ts', false)).toEqual([0, 6])
    expect(stem('.env', false)).toEqual([0, 4])
    expect(stem('Makefile', false)).toEqual([0, 8])
    expect(stem('v1.2', true)).toEqual([0, 4])
  })

  it('U-FT-26 · the folder an action acts in: a folder row is itself, a file or Show all its folder, the new entry’s row its folder, no row the root', () => {
    expect(folderOf(undefined)).toBe('')
    expect(folderOf(row('src/lib', 'dir'))).toBe('src/lib')
    expect(folderOf(row('src/lib/a.ts'))).toBe('src/lib')
    expect(folderOf(row('a.ts'))).toBe('')
    expect(folderOf(row('src/link', 'symlink'))).toBe('src')
    expect(folderOf(row('src/', 'pending'))).toBe('src')
    expect(folderOf(row('/', 'pending'))).toBe('')
  })

  it('U-FT-26 · a refusal of the name stays under the field; any other closes it with a toast that says what was tried and why', () => {
    expect(refusedInline({ refused: 'name', detail: 'A name cannot hold “/”' })).toBe('A name cannot hold “/”')
    expect(refusedInline({ refused: 'exists' })).toMatch(/taken/)
    expect(refusedInline({ refused: 'busy' })).toBeNull()
    expect(refusedInline({ refused: 'gitDir' })).toBeNull()
    expect(opMessage("Couldn't rename", { refused: 'busy' })).toMatch(/^Couldn't rename: .*under way/)
    expect(opMessage("Couldn't move", { refused: 'failed', detail: 'EACCES' })).toMatch(/\(EACCES\)$/)
    expect(opMessage("Couldn't move to Trash", { refused: 'noTrash', detail: 'the tool said no' })).toBe("Couldn't move to Trash: the tool said no")
  })
})

describe('what follows an answer', () => {
  const answer: Answer = { path: 'src/b.ts', ignored: false, paged: false, undo: 'rename' }
  const ctx: AfterContext = { sessionId: 's1', shown: 's1', showIgnored: false, began: true, inPanel: true, from: 'src/a.ts' }

  it('U-FT-26 · the result is selected, the keyboard taken to the list only when the operation began there and the keyboard is still in the panel', () => {
    expect(afterPlan(answer, ctx)).toMatchObject({ same: true, reveal: { path: 'src/b.ts', focus: true }, tabs: { from: 'src/a.ts', to: 'src/b.ts' }, undo: 'rename', hidden: null, showAll: null })
    expect(afterPlan(answer, { ...ctx, began: false }).reveal).toEqual({ path: 'src/b.ts', focus: false })
    expect(afterPlan(answer, { ...ctx, inPanel: false }).reveal).toEqual({ path: 'src/b.ts', focus: false })
    // made, not moved: no file tab follows
    expect(afterPlan(answer, { ...ctx, from: undefined }).tabs).toBeNull()
    expect(afterPlan(answer, { ...ctx, from: 'src/b.ts' }).tabs).toBeNull()
  })

  it('U-FT-26 · for another session only the file tabs follow; every other step is skipped', () => {
    const p = afterPlan({ ...answer, expanded: ['src'] }, { ...ctx, shown: 's2' })
    expect(p).toEqual({ same: false, tabs: { from: 'src/a.ts', to: 'src/b.ts' }, expanded: null, rekey: null, showAll: null, reveal: null, hidden: null, undo: null })
    expect(afterPlan(answer, { ...ctx, shown: null }).same).toBe(false)
  })

  it('U-FT-26 · a folder moved or renamed replaces the open folders and re-keys what the window keeps under its old path; a paged result shows its folder whole; an ignored one while hidden says so instead', () => {
    const folder = afterPlan({ path: 'lib', ignored: false, paged: false, expanded: ['lib', 'lib/x'], undo: 'move' }, { ...ctx, from: 'src' })
    expect(folder).toMatchObject({ expanded: ['lib', 'lib/x'], rekey: { from: 'src', to: 'lib' } })
    expect(afterPlan({ ...answer, expanded: ['src'] }, { ...ctx, from: undefined }).rekey).toBeNull()
    expect(afterPlan({ ...answer, paged: true }, ctx).showAll).toBe('src')
    const hidden = afterPlan({ ...answer, ignored: true, paged: true }, ctx)
    expect(hidden).toMatchObject({ hidden: 'src/b.ts', reveal: null, showAll: null })
    expect(afterPlan({ ...answer, ignored: true }, { ...ctx, showIgnored: true })).toMatchObject({ hidden: null, reveal: { path: 'src/b.ts' } })
  })

  it('U-FT-26 · paths under a moved folder follow it; others stay', () => {
    expect(movedPath('src/a.ts', 'src', 'lib')).toBe('lib/a.ts')
    expect(movedPath('src', 'src', 'lib')).toBe('lib')
    expect(movedPath('srcs/a.ts', 'src', 'lib')).toBe('srcs/a.ts')
    expect(movedPath('a/src/b', 'src', 'lib')).toBe('a/src/b')
  })

  it('U-FT-26 · after Move to Trash the next row that is not inside what went is selected, else the one before; none when nothing is left', () => {
    const rows = [row('a', 'dir'), row('a/x.ts'), row('a/y', 'dir'), row('a/y/z.ts'), row('b.ts'), row('c.ts')]
    expect(nextAfter(rows, 0, 'a')).toBe('b.ts')
    expect(nextAfter(rows, 1, 'a/x.ts')).toBe('a/y')
    expect(nextAfter(rows, 5, 'c.ts')).toBe('b.ts')
    expect(nextAfter([row('only.ts')], 0, 'only.ts')).toBeNull()
    // the "Show all" row and a new entry's row are never selected
    expect(nextAfter([row('a.ts'), row('dir/', 'pending'), row('more', 'more')], 0, 'a.ts')).toBeNull()
  })
})

describe('drags in the tree', () => {
  it('U-FT-27 · a drop moves, copies with the modifier, and does nothing for a folder into itself or below it, or a move into its own folder', () => {
    const file = { path: 'src/a.ts', dir: false }
    const folder = { path: 'src/lib', dir: true }
    expect(dropEffect(file, 'docs', false)).toBe('move')
    expect(dropEffect(file, 'docs', true)).toBe('copy')
    expect(dropEffect(file, '', false)).toBe('move')
    // its own folder: nothing, unless copied there (a copy beside it)
    expect(dropEffect(file, 'src', false)).toBe('none')
    expect(dropEffect(file, 'src', true)).toBe('copy')
    expect(dropEffect({ path: 'a.ts', dir: false }, '', false)).toBe('none')
    // a folder never into itself or below it, even copied
    for (const copy of [false, true]) {
      expect(dropEffect(folder, 'src/lib', copy)).toBe('none')
      expect(dropEffect(folder, 'src/lib/deep', copy)).toBe('none')
    }
    expect(dropEffect(folder, 'src/library', false)).toBe('move')
    expect(dropEffect(folder, '', false)).toBe('move')
  })

  it('U-FT-27 · the copy modifier is the system’s: ⌥ on macOS, Ctrl on Linux', () => {
    expect(darwin.keys.dragCopy({ altKey: true, ctrlKey: false })).toBe(true)
    expect(darwin.keys.dragCopy({ altKey: false, ctrlKey: true })).toBe(false)
    expect(linux.keys.dragCopy({ altKey: false, ctrlKey: true })).toBe(true)
    expect(linux.keys.dragCopy({ altKey: true, ctrlKey: false })).toBe(false)
  })
})
