// The viewer's part in the text menu: the document a right-click landed in (a CodeMirror view, the diff's two
// included), whether its text is selected, and Select All, which is CodeMirror's own: the document is not editable, so
// the page's role would select the whole window.

import { selectAll } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'

export interface ViewerText {
  readonly hasSelection: boolean
  /** The keyboard to the document, so the Edit role's copy reaches its own copy handler. */
  focus(): void
  selectAll(): void
}

/** The document under `el`, or null where `el` is in none. */
export function viewerTextAt(el: Element): ViewerText | null {
  const root = el.closest('.cm-editor')
  const view = root instanceof HTMLElement ? EditorView.findFromDOM(root) : null
  if (!view) return null
  return {
    hasSelection: view.state.selection.ranges.some((r) => !r.empty),
    focus: () => view.focus(),
    selectAll: () => {
      selectAll(view)
      view.focus()
    },
  }
}
