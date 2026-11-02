import { deleteCharBackward, insertNewline } from '@codemirror/commands'
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { baseExtensions, emptyState, fileState } from './editor.ts'
import { textStats, viewPolicy } from './policy.ts'
import { fromDisk } from './readonly.ts'
import { EMPTY_VIEW } from './tab.ts'

const DOC = 'const a = 1\nconst b = 2\n'

/** The viewer's read-only documents: a diff's side, a file document opened without editing, the empty editor. */
function readOnlyDocuments(): [string, EditorState][] {
  const lines = DOC.split('\n')
  return [
    ['a diff’s side', EditorState.create({ doc: DOC, extensions: baseExtensions({ eol: 'lf', store: null, guides: null, label: 'a.ts' }) })],
    ['a file that cannot be edited', fileState({ path: 'a.ts', lines, eol: 'lf', policy: viewPolicy(textStats(DOC.length, lines)), store: null, wrap: false, changes: null, edit: null }, EMPTY_VIEW, null)],
    ['the empty editor', emptyState().update({ changes: { from: 0, insert: DOC }, annotations: fromDisk.of(true) }).state],
  ]
}

describe('read-only documents', () => {
  it('U-FV-7 · in a read-only document (a diff’s side, a file that cannot be edited, the empty editor) every transaction that would change it is refused — typing, paste, drop, cut, delete, undo, a command — and only the viewer’s own reload from disk changes it', () => {
    for (const [what, start] of readOnlyDocuments()) {
      let state = start
      expect(state.readOnly, what).toBe(true)
      expect(state.doc.toString(), what).toBe(DOC)
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
        expect(tr.docChanged, `${what}: ${name}`).toBe(false)
        state = tr.state
        expect(state.doc.toString(), `${what}: ${name}`).toBe(DOC)
      }
      // CodeMirror's own editing commands leave the text alone, whether they hold back themselves or the filter stops them
      for (const cmd of [insertNewline, deleteCharBackward]) {
        let after = state
        cmd({ state: state.update({ selection: { anchor: 5 } }).state, dispatch: (tr: Transaction) => (after = tr.state) } as never)
        expect(after.doc.toString(), what).toBe(DOC)
      }
      // the selection may move: reading is not changing
      const moved = state.update({ selection: { anchor: 3, head: 9 } })
      expect(moved.state.selection.main.head, what).toBe(9)
      // the reload from disk is the one change let through
      const reloaded = state.update({ changes: { from: 0, to: 5, insert: 'let' }, annotations: fromDisk.of(true) })
      expect(reloaded.docChanged, what).toBe(true)
      expect(reloaded.state.doc.toString(), what).toBe('let a = 1\nconst b = 2\n')
      // and only when it says so truthfully
      expect(state.update({ changes: { from: 0, insert: 'x' }, annotations: fromDisk.of(false) }).docChanged, what).toBe(false)
    }
  })
})
