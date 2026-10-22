// The git change markers: a 2 px bar at the far left of the gutter on added and modified lines, and a small
// wedge where lines were deleted. The changed line ranges are core's (`viewer.changes`: the hunk headers of
// `git diff -U0`, relative to the file panel's scope); between two answers the markers ride along with the document's
// changes, so a live reload does not strip them (E-FV-3).

import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { gutter, GutterMarker } from '@codemirror/view'
import type { LineChange, LineChanges } from '@kea/protocol'

class ChangeMarker extends GutterMarker {
  override elementClass: string
  constructor(kind: string) {
    super()
    this.elementClass = `kea-change kea-change-${kind}`
  }
}

const ADDED = new ChangeMarker('added')
const MODIFIED = new ChangeMarker('modified')
/** Lines were removed after this line. */
const DELETED = new ChangeMarker('deleted')
/** Lines were removed before the first line. */
const DELETED_TOP = new ChangeMarker('deleted-top')

interface Marks {
  /** Every line is new (an untracked file): no marker objects, one answer for all lines. */
  whole: boolean
  set: RangeSet<GutterMarker>
  /** The changed regions as line spans (1-based, inclusive), ascending: Next / Previous Change steps through them. */
  regions: readonly { from: number; to: number }[]
}

const NONE: Marks = { whole: false, set: RangeSet.empty, regions: [] }

function build(doc: Text, c: LineChanges | null): Marks {
  if (!c) return NONE
  if (c.whole) return { whole: true, set: RangeSet.empty, regions: [{ from: 1, to: doc.lines }] }
  const b = new RangeSetBuilder<GutterMarker>()
  const regions: { from: number; to: number }[] = []
  const n = doc.lines
  let last = 0 // the last line given a marker: one marker per line, and the builder wants them ascending
  const put = (line: number, m: GutterMarker) => {
    if (line <= last || line > n) return
    last = line
    const at = doc.line(line).from
    b.add(at, at, m)
  }
  for (const ch of c.changes as readonly LineChange[]) {
    if (ch.kind === 'deleted') {
      if (ch.from === 0) put(1, DELETED_TOP)
      else put(ch.from, DELETED)
      const at = Math.min(Math.max(ch.from, 1), n)
      regions.push({ from: at, to: at })
      continue
    }
    const to = Math.min(ch.to, n)
    for (let line = Math.max(ch.from, 1); line <= to; line++) put(line, ch.kind === 'added' ? ADDED : MODIFIED)
    if (ch.from <= n) regions.push({ from: Math.max(ch.from, 1), to })
  }
  return { whole: false, set: b.finish(), regions }
}

/** The file's changed lines arrived (or null: none are known). */
export const setLineChanges = StateEffect.define<LineChanges | null>()

const marks = StateField.define<Marks>({
  create: () => NONE,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLineChanges)) return build(tr.state.doc, e.value)
    if (!tr.docChanged || value === NONE) return value
    // until core's next answer: the markers stay on their lines; the regions are left as they were
    return value.whole ? { ...value, regions: [{ from: 1, to: tr.state.doc.lines }] } : { ...value, set: value.set.map(tr.changes) }
  },
})

/** The changed regions of the document as line spans (1-based, inclusive), ascending. */
export function changedRegions(state: EditorState): readonly { from: number; to: number }[] {
  return state.field(marks, false)?.regions ?? []
}

/** The gutter and its state; `initial` is what is known when the document is first shown (a tab flip keeps them). */
export function changeGutter(initial: LineChanges | null = null): Extension {
  return [
    marks.init((state) => build(state.doc, initial)),
    gutter({
      class: 'kea-change-gutter',
      markers: (view) => view.state.field(marks).set,
      lineMarker: (view) => (view.state.field(marks).whole ? ADDED : null),
      lineMarkerChange: (u) => u.startState.field(marks) !== u.state.field(marks),
    }),
  ]
}
