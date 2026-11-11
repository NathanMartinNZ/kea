// The current line: a fill on the line of each caret, and on no line while any range selects text. CodeMirror's own
// `highlightActiveLine` also marks the line a selection ends on, and a line's fill is drawn over the selection layer,
// so that line's part of the selection would be hidden or tinted apart from the rest. The gutter's current line
// number is `highlightActiveLineGutter`'s and stays as it is.

import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'

const current = Decoration.line({ class: 'cm-activeLine' })

/**
 * The current lines of `state`: the line of each empty range, none while any range is not empty. `lineStart`: where
 * the line holding a position starts on screen (a folded block is shown as one line); the document's line by default.
 */
export function currentLines(state: EditorState, lineStart: (pos: number) => number = (pos) => state.doc.lineAt(pos).from): DecorationSet {
  const ranges = state.selection.ranges
  if (ranges.some((r) => !r.empty)) return Decoration.none
  const marks: Range<Decoration>[] = []
  let last = -1
  // ranges are in document order, so a line holding several carets is met once in a row
  for (const r of ranges) {
    const from = lineStart(r.head)
    if (from > last) {
      marks.push(current.range(from))
      last = from
    }
  }
  return Decoration.set(marks)
}

const onScreen = (view: EditorView) => (pos: number) => view.lineBlockAt(pos).from

/**
 * The plugin's value: the current lines of the view's state, on the lines as they are shown. They are found again when
 * the text, the selection or the height changes: folding or unfolding lines, or showing a diff's run of unchanged
 * lines, moves the line a caret is shown on without moving the caret, and always changes the height.
 */
export class CurrentLineMarks {
  decorations: DecorationSet
  constructor(view: EditorView) {
    this.decorations = currentLines(view.state, onScreen(view))
  }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.selectionSet || u.heightChanged) this.decorations = currentLines(u.state, onScreen(u.view))
  }
}

const plugin = ViewPlugin.fromClass(CurrentLineMarks, { decorations: (v) => v.decorations })

/** The current line's fill, in place of CodeMirror's `highlightActiveLine`. */
export function activeLine(): Extension {
  return plugin
}
