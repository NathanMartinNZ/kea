import { deleteCharBackward, insertNewline } from '@codemirror/commands'
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { fromDisk, readOnly } from './readonly.ts'

const DOC = 'const a = 1\nconst b = 2\n'

describe('strictly read-only', () => {
  it('U-FV-7 · every transaction that would change the document is refused — typing, paste, drop, cut, delete, undo, a command — and only the viewer’s own reload from disk changes it', () => {
    let state = EditorState.create({ doc: DOC, extensions: readOnly() })
    expect(state.readOnly).toBe(true)
    const tryAll: [string, TransactionSpec][] = [
      ['typing', { changes: { from: 0, insert: 'x' }, userEvent: 'input.type' }],
      ['composition', { changes: { from: 3, insert: 'é' }, userEvent: 'input.type.compose' }],
      ['paste', { changes: { from: 5, to: 8, insert: 'pasted\ntext' }, userEvent: 'input.paste' }],
      ['drop', { changes: { from: 0, insert: 'dropped' }, userEvent: 'input.drop' }],
      ['cut', { changes: { from: 0, to: 5 }, userEvent: 'delete.cut' }],
      ['backspace', { changes: { from: 0, to: 1 }, userEvent: 'delete.backward' }],
      ['move by drag', { changes: [{ from: 0, to: 5 }, { from: 12, insert: 'const' }], userEvent: 'move.drop' }],
      ['undo', { changes: { from: 0, to: DOC.length, insert: '' }, userEvent: 'undo' }],
      ['a change with no user event', { changes: { from: 0, insert: 'programmatic' } }],
      // an extension that claims the user did it, or sets the filter flag itself, gets no further
      ['filter: false is not ours to honour', { changes: { from: 0, insert: 'x' }, filter: true }],
    ]
    for (const [name, spec] of tryAll) {
      const tr = state.update(spec)
      expect(tr.docChanged, name).toBe(false)
      state = tr.state
      expect(state.doc.toString(), name).toBe(DOC)
    }
    // CodeMirror's own editing commands leave the text alone, whether they hold back themselves or the filter stops them
    for (const cmd of [insertNewline, deleteCharBackward]) {
      let after = state
      cmd({ state: state.update({ selection: { anchor: 5 } }).state, dispatch: (tr: Transaction) => (after = tr.state) } as never)
      expect(after.doc.toString()).toBe(DOC)
    }
    // the selection may move: reading is not changing
    const moved = state.update({ selection: { anchor: 3, head: 9 } })
    expect(moved.state.selection.main.head).toBe(9)
    // the reload from disk is the one change let through
    const reloaded = state.update({ changes: { from: 0, to: 5, insert: 'let' }, annotations: fromDisk.of(true) })
    expect(reloaded.docChanged).toBe(true)
    expect(reloaded.state.doc.toString()).toBe('let a = 1\nconst b = 2\n')
    // and only when it says so truthfully
    expect(state.update({ changes: { from: 0, insert: 'x' }, annotations: fromDisk.of(false) }).docChanged).toBe(false)
  })
})
