import { history, undo, undoDepth } from '@codemirror/commands'
import { SearchQuery, setSearchQuery } from '@codemirror/search'
import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { bars, replaceEvery, replaceMatch } from './bars.ts'
import { readOnly } from './readonly.ts'

/** Enough of a view for the replace commands: a document with the bars and history, a query, and a dispatch. */
function viewOf(doc: string, query: ConstructorParameters<typeof SearchQuery>[0], o: { selection?: { anchor: number; head: number }; extra?: Extension } = {}) {
  let state = EditorState.create({ doc, selection: o.selection, extensions: [bars(), history(), o.extra ?? []] })
  state = state.update({ effects: setSearchQuery.of(new SearchQuery(query)) }).state
  const view = {
    get state() {
      return state
    },
    dispatch: (...specs: TransactionSpec[]) => {
      state = state.update(...specs).state
    },
  }
  return view as typeof view & EditorView
}

describe('replace', () => {
  it('U-FV-30 · Replace replaces the selected match and selects the next; Replace All replaces every match as one undo step; regular expression groups are inserted; a read-only document is left alone', () => {
    // Replace: the first press selects the next match, the second replaces it
    const one = viewOf('a1 b2 a3', { search: 'a', replace: 'x' })
    expect(replaceMatch(one)).toBe(true)
    expect(one.state.doc.toString()).toBe('a1 b2 a3')
    expect(one.state.sliceDoc(one.state.selection.main.from, one.state.selection.main.to)).toBe('a')
    expect(replaceMatch(one)).toBe(true)
    expect(one.state.doc.toString()).toBe('x1 b2 a3')
    // the next match is selected, ready for the next Replace
    expect(one.state.selection.main.from).toBe(6)
    expect(replaceMatch(one)).toBe(true)
    expect(one.state.doc.toString()).toBe('x1 b2 x3')
    // each Replace is its own undo step
    expect(undoDepth(one.state)).toBe(2)

    // Replace All with groups: one change, undone at once
    const doc = 'width=10\nheight=20\ndepth=30\n'
    const all = viewOf(doc, { search: '(\\w+)=(\\d+)', replace: '$2 is $1 ($&)', regexp: true })
    expect(replaceEvery(all)).toBe(true)
    expect(all.state.doc.toString()).toBe('10 is width (width=10)\n20 is height (height=20)\n30 is depth (depth=30)\n')
    expect(undoDepth(all.state)).toBe(1)
    undo(all)
    expect(all.state.doc.toString()).toBe(doc)

    // case and whole word as the toggles have them
    const word = viewOf('Cat cat concat', { search: 'cat', replace: 'dog', caseSensitive: true, wholeWord: true })
    replaceEvery(word)
    expect(word.state.doc.toString()).toBe('Cat dog concat')

    // nothing to replace, or a read-only document: no change and no undo step
    const none = viewOf('abc', { search: 'z', replace: 'y' })
    expect(replaceEvery(none)).toBe(false)
    const locked = viewOf('a a', { search: 'a', replace: 'b' }, { selection: { anchor: 0, head: 1 }, extra: readOnly() })
    expect(replaceMatch(locked)).toBe(false)
    expect(replaceEvery(locked)).toBe(false)
    expect(locked.state.doc.toString()).toBe('a a')
    expect(undoDepth(locked.state)).toBe(0)
  })
})
