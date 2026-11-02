// An agent's writes merged into a document with unsaved text: a three-way merge by place, at line granularity.
// `base` is the file's text as the document last read or saved it, `doc` the document now, `disk` the file's lines now.
// Each side's changes against `base` are found as a reload's are (`reload.ts`), in `base` positions. Pure: no view and
// no history; the caller applies the result out of history and makes the disk's text the new `base`.
//
// A place is the union of both sides' changes that overlap or touch adjacent `base` lines (git's rule), and of the
// earlier marks it meets. Its extent in characters follows `replaceLines`' convention, line breaks included: its lines
// with the break after each or, when it ends the text, with the break before its first line; lines put in are a point.
// Places whose extents meet are one place: lines put in before a final empty line and lines put in at the end are at
// the same character, and kept apart their order would be the sides' rather than the lines'. Then a place only the disk
// changed is applied; one where the document already has the disk's text needs nothing (it agrees); one both changed
// differently is marked and keeps the user's text. A mark holds the place's extent in the document and in the new
// `base` (the disk's text), whose text is what Use the File's puts back.
//
// An earlier mark takes part by its base extent and is worked out again with the place it falls in: it goes when the
// document's text there is the disk's, and takes the disk's newest text when the agent wrote there again. Kept as it
// was instead, a mark could disagree with the places around it, since a diff can line repeated lines (empty ones above
// all) up differently from one merge to the next.

import { ChangeSet, Text, type ChangeDesc } from '@codemirror/state'
import { L } from '@kea/protocol/limits'
import { reloadChanges, type ReloadChange } from './reload.ts'

/** A range of a text, `from` ≤ `to`; a point when they are equal. */
export interface Extent {
  from: number
  to: number
}

/** A place changed on disk where the user edited too: its extent in the document, and in `base` (the file's text). */
export interface Mark {
  doc: Extent
  base: Extent
}

export interface MergeInput {
  base: Text
  doc: Text
  /** The file's text now. */
  disk: Text | readonly string[]
  /** The document's marks, their base extents in `base`. */
  marks: readonly Mark[]
  /** The most marks kept; L.viewerMarksMax unless a test says otherwise. */
  marksMax?: number
}

export interface Merge {
  /**
   * The disk's lines are `base`'s: no text changes and the marks stay, but the document takes the disk's version,
   * ending, encoding and mode (only an ending or a byte order mark changed).
   */
  same: boolean
  /** What to apply to the document (in its positions), out of history; null: nothing. */
  changes: ChangeSet | null
  /** The marks after the merge: document extents in the document after `changes`, base extents in the disk's text. */
  marks: Mark[]
  /**
   * The document extents (before `changes`) of the places that already had the disk's text: nothing is applied there,
   * but the history guard treats them as written by the disk.
   */
  agreed: Extent[]
}

/** `e` through `changes`, so that text put in at either edge stays outside it; a point when its ends cross. */
export function mapExtent(e: Extent, changes: ChangeDesc): Extent {
  const to = changes.mapPos(e.to, -1)
  return { from: Math.min(changes.mapPos(e.from, 1), to), to }
}

interface Place {
  /** Its changes' `base` lines, `[a, b)`; none when `a > b` (marks alone). */
  a: number
  b: number
  /** The hull of the marks it holds; none when `markFrom > markTo`. */
  markFrom: number
  markTo: number
  /** Its extent in `base`. */
  from: number
  to: number
  mine: boolean
  theirs: ReloadChange[]
}

/** The extent of `base` lines `[a, b)`, as `replaceLines` takes them out or puts lines in. */
function linesExtent(base: Text, a: number, b: number): Extent {
  const n = base.lines
  if (b < n) return { from: base.line(a + 1).from, to: base.line(b + 1).from }
  if (a === b) return { from: base.length, to: base.length }
  return { from: a > 0 ? base.line(a).to : 0, to: base.length }
}

function place(base: Text, p: Omit<Place, 'from' | 'to'>): Place {
  let from = p.markFrom
  let to = p.markTo
  if (p.a <= p.b) {
    const e = linesExtent(base, p.a, p.b)
    from = Math.min(from, e.from)
    to = Math.max(to, e.to)
  }
  return { ...p, from, to }
}

const join = (base: Text, p: Place, q: Place): Place =>
  place(base, { a: Math.min(p.a, q.a), b: Math.max(p.b, q.b), markFrom: Math.min(p.markFrom, q.markFrom), markTo: Math.max(p.markTo, q.markTo), mine: p.mine || q.mine, theirs: [...p.theirs, ...q.theirs] })

/** `items` as places, in order: those that meet join, and a join can reach back to the place before (one that ends the text takes the break before it). */
function placesOf(base: Text, items: readonly Place[]): Place[] {
  const places: Place[] = []
  for (const item of [...items].sort((p, q) => p.from - q.from || p.to - q.to)) {
    places.push(item)
    while (places.length > 1) {
      const q = places[places.length - 1] as Place
      const p = places[places.length - 2] as Place
      if (p.to < q.from) break
      places.splice(-2, 2, join(base, p, q))
    }
  }
  return places
}

/** The user's text and the disk's merged; see the header. */
export function merge(m: MergeInput): Merge {
  const { base, doc } = m
  const diskLines = m.disk instanceof Text ? m.disk.toJSON() : m.disk
  const theirsR = reloadChanges(base, diskLines)
  if (!theirsR) return { same: true, changes: null, marks: [...m.marks], agreed: [] }
  const disk = m.disk instanceof Text ? m.disk : Text.of([...diskLines])
  const mineR = reloadChanges(base, doc.toJSON())
  const mine = ChangeSet.of(mineR?.changes ?? [], base.length)
  const theirs = ChangeSet.of(theirsR.changes, base.length)

  // every change, and every earlier mark (its base extent), on its own first
  const items: Place[] = []
  const none = { markFrom: Infinity, markTo: -Infinity }
  for (const c of mineR?.changes ?? []) items.push(place(base, { a: c.fromLine, b: c.toLine, ...none, mine: true, theirs: [] }))
  for (const c of theirsR.changes) items.push(place(base, { a: c.fromLine, b: c.toLine, ...none, mine: false, theirs: [c] }))
  for (const k of m.marks) {
    const to = Math.max(0, Math.min(k.base.to, base.length))
    const from = Math.max(0, Math.min(k.base.from, to))
    items.push(place(base, { a: Infinity, b: -Infinity, markFrom: from, markTo: to, mine: false, theirs: [] }))
  }
  const places = placesOf(base, items)

  const apply: ReloadChange[] = []
  const conflicts: Mark[] = []
  const agreed: Extent[] = []
  for (const p of places) {
    // the document has `base`'s text here: the disk's changes come in, and a mark here goes
    if (!p.mine) {
      apply.push(...p.theirs)
      continue
    }
    // the user's own place
    if (p.theirs.length === 0 && p.markFrom > p.markTo) continue
    const inDoc = { from: mine.mapPos(p.from, -1), to: mine.mapPos(p.to, 1) }
    const onDisk = { from: theirs.mapPos(p.from, -1), to: theirs.mapPos(p.to, 1) }
    if (doc.sliceString(inDoc.from, inDoc.to) === disk.sliceString(onDisk.from, onDisk.to)) {
      if (p.theirs.length > 0) agreed.push(inDoc)
      continue
    }
    conflicts.push({ doc: inDoc, base: onDisk })
  }

  const applied = ChangeSet.of(apply, base.length).map(mine)
  const marks = conflicts.map((k) => ({ doc: mapExtent(k.doc, applied), base: k.base }))
  const max = Math.max(1, m.marksMax ?? L.viewerMarksMax)
  if (marks.length > max) {
    // the rest join the last mark kept: one range from its start to the end of the last place
    const first = marks[max - 1] as Mark
    const last = marks[marks.length - 1] as Mark
    marks.splice(max - 1, marks.length, { doc: { from: first.doc.from, to: last.doc.to }, base: { from: first.base.from, to: last.base.to } })
  }
  return { same: false, changes: applied.empty ? null : applied, marks, agreed }
}
