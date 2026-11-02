// The places a merge marked (`rebase.ts`): changed on disk where the user edited too. A field holds each mark's extent
// in the document and in `base`; the lines a mark covers are drawn in the warning colour. Use the File's puts `base`'s
// text back over every mark in one undo step. Its undo puts the user's text and those marks back beside any a merge
// marked since, and its redo takes those marks again. Keep Yours drops the marks and is no undo step.
//
// A mark's document extent maps through every change so that text typed at either edge stays outside it, and a mark
// that is a point (the user's text there is gone) stays a point. Its file text is always `base` over its base
// extent, never worked out from the document.

import { invertedEffects, isolateHistory } from '@codemirror/commands'
import { Annotation, ChangeSet, RangeSetBuilder, StateEffect, StateField, Transaction, type ChangeDesc, type EditorState, type Extension, type StateCommand, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { L } from '@kea/protocol/limits'
import { mapExtent, type Extent, type Mark } from './rebase.ts'
import { reloadChanges } from './reload.ts'

export type { Extent, Mark }

/** What a command needs of an editor: an `EditorView`, or a state and somewhere to send its transactions. */
type Target = Parameters<StateCommand>[0]

/** One Use the File's step, through its undos and redos. */
type Step = object

/** Marks whose base extents are in one text: a merge's, or those an undo of Use the File's put back. */
interface Group {
  marks: readonly Mark[]
  /** The text the base extents are in; null: the document's `base` (a merge's marks). */
  base: Text | null
  /** The Use the File's step whose undo put these marks back, and whose redo takes them again; null: a merge's. */
  by: Step | null
}

interface Marked {
  // bounded: L.viewerMarksMax marks a group; a merge's group, and one for each Use the File's step an undo put back, of
  // the steps the history holds (L.viewerHistoryMaxBytes)
  groups: readonly Group[]
}

const NONE: Marked = { groups: [] }
const NO_MARKS: readonly Mark[] = []

const mapMark = (m: Mark, changes: ChangeDesc): Mark => ({ doc: mapExtent(m.doc, changes), base: m.base })

/** The document's marks are these (a merge's, which takes every earlier mark into account); an empty list removes them. */
export const setMarks = StateEffect.define<readonly Mark[]>({ map: (v, changes) => v.map((m) => mapMark(m, changes)) })

/** Marks an undo puts back: their document extents are in the document after it, as a transaction's effects are. */
interface Back {
  marks: readonly Mark[]
  base: Text
  by: Step
  /** The changes the history keeps for the step: from the document before the undo to the one after it. */
  step: ChangeDesc
}

/**
 * The history moves a stored step's effects through a change made outside it as it moves the step's changes, in the
 * coordinates of the document the undo starts from, though the marks are in the document the undo leads to. They move
 * instead through that change carried across the step's own changes, as the history moves the step's selection, and
 * the step's changes move with it. A change that does not start from the step's document (the history joined the step
 * to a later one) leaves nothing to put back: the effect goes, and the undo leaves the marks as they are.
 */
function mapBack(v: Back, changes: ChangeDesc): Back | undefined {
  if (changes.length !== v.step.length) return undefined
  const after = changes.mapDesc(v.step, true)
  return { marks: v.marks.map((m) => mapMark(m, after)), base: v.base, by: v.by, step: v.step.mapDesc(changes) }
}

/** An undo of Use the File's (or of its redo): its marks come back. */
const putBack = StateEffect.define<Back>({ map: mapBack })

/** A redo of Use the File's: the marks its undo put back go again. */
const takeBack = StateEffect.define<Step>()

/** Use the File's: the marks it replaced and the text their base extents are in, for its undo. */
const theFiles = Annotation.define<{ marks: readonly Mark[]; base: Text }>()

const field = StateField.define<Marked>({
  create: () => NONE,
  update(value, tr) {
    let groups = value.groups
    if (tr.docChanged && groups.length > 0) groups = groups.map((g) => ({ ...g, marks: g.marks.map((m) => mapMark(m, tr.changes)) }))
    for (const e of tr.effects) {
      if (e.is(setMarks)) groups = e.value.length === 0 ? [] : [{ marks: e.value, base: null, by: null }]
      else if (e.is(putBack) && e.value.marks.length > 0) groups = [...groups.filter((g) => g.by !== e.value.by), { marks: e.value.marks, base: e.value.base, by: e.value.by }]
      else if (e.is(takeBack)) groups = groups.filter((g) => g.by !== e.value)
    }
    if (groups === value.groups) return value
    return groups.length === 0 ? NONE : { groups }
  },
})

/** The marks' base extents moved from the text they are in to `to`. */
function rebased(marks: readonly Mark[], from: Text, to: Text): readonly Mark[] {
  const r = reloadChanges(from, to.toJSON())
  if (!r) return marks
  const changes = ChangeSet.of(r.changes, from.length)
  return marks.map((m) => ({ doc: m.doc, base: mapExtent(m.base, changes) }))
}

/**
 * Several groups' marks as one list, in order. Marks that overlap in the document join; so do, when their base extents
 * are all in one text (`inBase`), those that overlap there or are the other way round, which Use the File's would put
 * the same file text in twice for or out of order. Past L.viewerMarksMax the rest join the last kept, as a merge
 * joins them.
 */
function joined(marks: readonly Mark[], inBase: boolean): Mark[] {
  const out: Mark[] = []
  for (const m of [...marks].sort((p, q) => p.doc.from - q.doc.from || p.doc.to - q.doc.to)) {
    out.push(m)
    // a join can reach back to the mark before
    while (out.length > 1) {
      const q = out[out.length - 1] as Mark
      const p = out[out.length - 2] as Mark
      if (q.doc.from >= p.doc.to && (!inBase || q.base.from >= p.base.to) && out.length <= L.viewerMarksMax) break
      out.splice(-2, 2, { doc: { from: p.doc.from, to: Math.max(p.doc.to, q.doc.to) }, base: { from: Math.min(p.base.from, q.base.from), to: Math.max(p.base.to, q.base.to) } })
    }
  }
  return out
}

/**
 * The document's marks, in order. With `base` (the document's `base` now), their base extents are in it even when an
 * undo put them back after the file was merged or saved again: pass it when the marks go to `merge`.
 */
export function marksOf(state: EditorState, base?: Text): readonly Mark[] {
  const groups = state.field(field, false)?.groups ?? NONE.groups
  const lists = groups.map((g) => (!base || !g.base || g.base === base || g.base.eq(base) ? g.marks : rebased(g.marks, g.base, base)))
  if (lists.length <= 1) return lists[0] ?? NO_MARKS
  return joined(lists.flat(), base !== undefined)
}

/** Use the File's: every marked place takes `base`'s text over its base extent. False when there is nothing to do or the document is read-only. */
export function useTheFiles(view: Target, base: Text): boolean {
  const state = view.state
  const marks = marksOf(state, base)
  if (marks.length === 0 || state.readOnly) return false
  const clamp = (e: Extent, length: number): Extent => {
    const to = Math.max(0, Math.min(e.to, length))
    return { from: Math.max(0, Math.min(e.from, to)), to }
  }
  const changes = marks.map((m) => {
    const d = clamp(m.doc, state.doc.length)
    const b = clamp(m.base, base.length)
    return { from: d.from, to: d.to, insert: base.slice(b.from, b.to) }
  })
  // one undo step of its own; past the document's filters as an undo is (the text and the marks go together)
  view.dispatch(state.update({ changes, effects: setMarks.of([]), annotations: [isolateHistory.of('full'), theFiles.of({ marks, base })], filter: false }))
  return true
}

/** Keep Yours: the marks go, the text stays; no undo step. False when there are none. */
export function keepYours(view: Target): boolean {
  if (marksOf(view.state).length === 0) return false
  view.dispatch(view.state.update({ effects: setMarks.of([]), annotations: Transaction.addToHistory.of(false) }))
  return true
}

/**
 * An undo of Use the File's puts back the marks it replaced, in the document as it was before the step, and leaves the
 * marks a merge made since; a redo takes back only those, and its undo puts them back again.
 */
const restore = invertedEffects.of((tr) => {
  const step = tr.changes.invertedDesc
  const files = tr.annotation(theFiles)
  if (files) return [putBack.of({ ...files, by: {}, step })]
  const out: StateEffect<unknown>[] = []
  for (const e of tr.effects) {
    if (e.is(putBack)) out.push(takeBack.of(e.value.by))
    else if (e.is(takeBack)) {
      const g = tr.startState.field(field).groups.find((h) => h.by === e.value)
      if (g?.base) out.push(putBack.of({ marks: g.marks, base: g.base, by: e.value, step }))
    }
  }
  return out
})

// ── drawing ────────────────────────────────────────────────────────────────────────────────────────

const LINE = Decoration.line({ class: 'kea-conflict' })

/** The lines (1-based, inclusive) a mark covers: not the line whose break it starts at, nor the one it ends at the start of. */
function linesOf(doc: Text, e: Extent): [number, number] {
  let first = doc.lineAt(e.from).number
  if (e.to > e.from && e.from === doc.line(first).to && first < doc.lines) first++
  let last = doc.lineAt(e.to).number
  if (e.to > e.from && e.to === doc.line(last).from && last > first) last--
  return [first, Math.max(first, last)]
}

function build(view: EditorView): DecorationSet {
  const marks = marksOf(view.state)
  if (marks.length === 0) return Decoration.none
  const doc = view.state.doc
  const b = new RangeSetBuilder<Decoration>()
  let done = 0
  for (const { from, to } of view.visibleRanges) {
    const top = doc.lineAt(from).number
    const bottom = doc.lineAt(to).number
    for (const m of marks) {
      const [first, last] = linesOf(doc, m.doc)
      for (let n = Math.max(first, top, done + 1); n <= Math.min(last, bottom); n++) {
        const at = doc.line(n).from
        b.add(at, at, LINE)
        done = n
      }
    }
  }
  return b.finish()
}

const drawing = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.startState.field(field) !== u.state.field(field)) this.decorations = build(u.view)
    }
  },
  { decorations: (v) => v.decorations },
)

/** A file document's marks: the field, their lines drawn, and their return on an undo of Use the File's. */
export function marks(): Extension {
  return [field, drawing, restore]
}
