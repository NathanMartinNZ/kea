// A read-only document (a diff's sides, the empty editor, a file that cannot be edited now): no typing, no paste, no
// drag-drop into the document, no save. Three layers, each enough alone: the content is not editable (no caret input
// reaches it), the state is read-only (CodeMirror's own commands and its paste, cut and drop handlers check that), and a
// change filter refuses every transaction that would change the document unless it is the viewer's own reload of the
// file from disk. A file's document holds this part or `editing.ts`'s in one compartment, so it can change between
// read-only and editable without losing its text (`editor.ts`).

import { Annotation, EditorState, type Extension, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Marks the viewer replacing text with what is on disk now: the one change a read-only document allows, and in an
 * editable one a change that is not the user's (the size cap lets it through, and it is no edit to save).
 */
export const fromDisk = Annotation.define<boolean>()

export const isFromDisk = (tr: Transaction): boolean => tr.annotation(fromDisk) === true

const refuse = (e: Event): boolean => {
  e.preventDefault()
  return true
}

export function readOnly(): Extension {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.changeFilter.of((tr) => !tr.docChanged || isFromDisk(tr)),
    // the keyboard still reaches the view: selection keys, find, copy
    EditorView.contentAttributes.of({ tabindex: '0', 'aria-readonly': 'true' }),
    EditorView.domEventHandlers({ beforeinput: refuse, paste: refuse, cut: refuse, drop: refuse, dragover: refuse }),
  ]
}
