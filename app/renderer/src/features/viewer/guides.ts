// Indent guides: a hairline at each indent level, drawn as the background of each visible line's leading whitespace —
// no element per guide, nothing for the lines off screen. The level's width is the document's indent unit, told once
// from its first lines: a tab, or the smallest run of leading spaces.

import { Facet, RangeSetBuilder, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { L } from '@kea/protocol/limits'

/** Columns per indent level. */
const indentColumns = Facet.define<number, number>({ combine: (v) => v[0] ?? 4 })

/** The document's indent unit in columns: `tabSize` for a tab-indented file, else the smallest indent of its first lines (2…8). */
export function indentUnitOf(doc: Text, tabSize: number): number {
  let smallest = 0
  const n = Math.min(doc.lines, L.highlightChunkLines)
  for (let i = 1; i <= n; i++) {
    const text = doc.line(i).text
    if (text.charCodeAt(0) === 9) return tabSize
    if (text.charCodeAt(0) !== 32) continue
    let k = 1
    while (text.charCodeAt(k) === 32) k++
    // a line of spaces only says nothing; one space is a comment's continuation (` * …`), not a level
    if (k === text.length || k < 2) continue
    if (smallest === 0 || k < smallest) smallest = k
  }
  return smallest === 0 ? tabSize : Math.min(8, smallest)
}

const guides: (Decoration | undefined)[] = [] // bounded: one per indent unit (2…8 columns)
function guide(columns: number): Decoration {
  return (guides[columns] ??= Decoration.mark({ class: 'kea-guides', attributes: { style: `--kea-indent:${columns}ch` } }))
}

function build(view: EditorView): DecorationSet {
  const doc = view.state.doc
  const mark = guide(view.state.facet(indentColumns))
  const b = new RangeSetBuilder<Decoration>()
  let done = 0
  for (const { from, to } of view.visibleRanges) {
    let line = doc.lineAt(from)
    for (;;) {
      if (line.number > done) {
        done = line.number
        const text = line.text
        let k = 0
        for (;;) {
          const c = text.charCodeAt(k)
          if (c !== 32 && c !== 9) break
          k++
        }
        if (k > 0 && k < text.length) b.add(line.from, line.from + k, mark)
      }
      if (line.to >= to || line.number >= doc.lines) break
      line = doc.line(line.number + 1)
    }
  }
  return b.finish()
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.startState.facet(indentColumns) !== u.state.facet(indentColumns)) this.decorations = build(u.view)
    }
  },
  { decorations: (v) => v.decorations },
)

/** The guides for a document whose indent unit is `columns` wide. */
export function indentGuides(columns: number): Extension {
  return [indentColumns.of(columns), plugin]
}
