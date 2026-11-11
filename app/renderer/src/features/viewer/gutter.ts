// The git change markers: a 2 px bar at the far left of the gutter on added and modified lines, and a small
// wedge where lines were deleted. The changed line ranges are core's (`viewer.changes`: the hunk headers of
// `git diff -U0`, relative to the file panel's scope). Between two answers the markers and the changed runs ride along
// with the document's changes, so a live reload does not strip them (E-FV-3) and typing does not leave Next / Previous
// Change or the change ruler (`ruler.ts`) pointing at lines that moved.

import { RangeSet, RangeSetBuilder, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Text } from '@codemirror/state'
import { gutter, GutterMarker } from '@codemirror/view'
import type { ChangeKind, LineChange, LineChanges } from '@kea/protocol'

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

/** A changed region of the document, in document positions, so that it moves with the text typed around it. */
export interface ChangeRun {
  readonly kind: ChangeKind
  /**
   * Added or modified: the start of the region's first line. Deleted: a position on the line beside which the lines
   * went: below it, or above it when `above` (lines removed before the first line).
   */
  readonly from: number
  /** Added or modified: the end of the region's last line. Deleted: `from`. */
  readonly to: number
  readonly above?: true
}

/** What the gutter knows of the file's changes. */
export interface ChangeRuns {
  /** Every line is new (an untracked file): one added run over the whole document. */
  readonly whole: boolean
  /** Core's answer was over its limits: no markers and no runs rather than some. */
  readonly truncated: boolean
  /** Ascending, in core's order: an edit moves them, never past one another. */
  readonly runs: readonly ChangeRun[]
}

interface Marks extends ChangeRuns {
  /** No marker objects when `whole`: one answer for all lines. */
  set: RangeSet<GutterMarker>
}

const NONE: Marks = { whole: false, truncated: false, set: RangeSet.empty, runs: [] }

function wholeRun(doc: Text): ChangeRun[] {
  return [{ kind: 'added', from: 0, to: doc.length }]
}

function build(doc: Text, c: LineChanges | null): Marks {
  if (!c) return NONE
  if (c.truncated) return { ...NONE, truncated: true }
  if (c.whole) return { whole: true, truncated: false, set: RangeSet.empty, runs: wholeRun(doc) }
  const b = new RangeSetBuilder<GutterMarker>()
  const runs: ChangeRun[] = [] // bounded: one per range of core's answer, at most L.viewerChangeRangesMax
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
      if (ch.from === 0) {
        put(1, DELETED_TOP)
        runs.push({ kind: 'deleted', from: 0, to: 0, above: true })
      } else {
        put(ch.from, DELETED)
        const at = doc.line(Math.min(ch.from, n)).to
        runs.push({ kind: 'deleted', from: at, to: at })
      }
      continue
    }
    const to = Math.min(ch.to, n)
    for (let line = Math.max(ch.from, 1); line <= to; line++) put(line, ch.kind === 'added' ? ADDED : MODIFIED)
    if (ch.from <= n) runs.push({ kind: ch.kind, from: doc.line(Math.max(ch.from, 1)).from, to: doc.line(to).to })
  }
  return { whole: false, truncated: false, set: b.finish(), runs }
}

/**
 * A run through an edit. Text typed at a region's first line start or last line end joins it; a deletion keeps to the
 * line it was below (or above).
 */
function mapRun(r: ChangeRun, changes: ChangeDesc): ChangeRun {
  if (r.kind === 'deleted') {
    const at = changes.mapPos(r.from, r.above ? 1 : -1)
    return r.above ? { kind: r.kind, from: at, to: at, above: true } : { kind: r.kind, from: at, to: at }
  }
  const from = changes.mapPos(r.from, -1)
  return { kind: r.kind, from, to: Math.max(from, changes.mapPos(r.to, 1)) }
}

/** The file's changed lines arrived (or null: none are known). */
export const setLineChanges = StateEffect.define<LineChanges | null>()

const marks = StateField.define<Marks>({
  create: () => NONE,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLineChanges)) return build(tr.state.doc, e.value)
    if (!tr.docChanged || value.runs.length === 0) return value
    // until core's next answer: the markers stay on their lines, and the runs on theirs
    if (value.whole) return { ...value, runs: wholeRun(tr.state.doc) }
    return { ...value, set: value.set.map(tr.changes), runs: value.runs.map((r) => mapRun(r, tr.changes)) }
  },
})

/** The changed runs of the document; the same object until they change. */
export function changeRuns(state: EditorState): ChangeRuns {
  return state.field(marks, false) ?? NONE
}

/**
 * The line Next (`dir` 1) or Previous (-1) Change goes to from the cursor's line: the first line of the next changed
 * region after it, or of the last one before it; around the ends. Null when nothing changed.
 */
export function nextChange(state: EditorState, dir: 1 | -1): number | null {
  const { runs } = changeRuns(state)
  if (runs.length === 0) return null
  const line = state.doc.lineAt(state.selection.main.head)
  let next: ChangeRun | undefined
  if (dir === 1) next = runs.find((r) => r.from > line.to)
  else for (let i = runs.length - 1; i >= 0 && !next; i--) if (runs[i]!.to < line.from) next = runs[i]
  next ??= dir === 1 ? runs[0]! : runs[runs.length - 1]!
  return state.doc.lineAt(next.from).number
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
