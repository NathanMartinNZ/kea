// A file document's undo history, and what keeps an undo from taking out what an agent wrote. Every change from disk is
// kept out of the history: CodeMirror maps the user's undo steps through it. The spans the user changed since the
// history began are kept as closed intervals of plain positions (a RangeSet would drop the empty ones a deletion
// leaves); a change from disk that meets one, or a place inside one where the document already had the disk's text,
// clears the history after it, since an undo there could take out the agent's text or glue it to the user's. Every
// transaction the history records counts as the user's: typing, an undo or a redo, Use the File's.
//
// The history's size is estimated as it grows: the characters each recorded change puts in and takes out, and
// L.viewerHistoryEntryBytes for each change and each selection range the history stores, the one before each step and
// those it keeps between steps (for undoing a selection). Past L.viewerHistoryMaxBytes the history is cleared and
// `historyClearedForMemory` says so until the next change.
//
// Clearing takes two transactions, the history's compartment emptied and then filled again (a field that stays in the
// configuration keeps its value). The spans and the estimate live in that compartment, so they start again with it.

import { history, historyField } from '@codemirror/commands'
import { Annotation, Compartment, StateEffect, StateField, Transaction, type ChangeDesc, type ChangeSet, type ChangeSpec, type EditorState, type Extension, type StateCommand, type TransactionSpec } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import { L } from '@kea/protocol/limits'
import { fromDisk, isFromDisk } from './readonly.ts'
import type { Extent } from './rebase.ts'

/** What a command needs of an editor: an `EditorView`, or a state and somewhere to send its transactions. */
type Target = Parameters<StateCommand>[0]

/** A change from disk: the text, what goes with it (the merge's marks), and the places that already had the disk's text. */
export interface DiskChange {
  changes: ChangeSpec | ChangeSet
  effects?: readonly StateEffect<unknown>[]
  /** Document extents (before `changes`) where nothing is applied because the document had the disk's text already. */
  agreed?: readonly Extent[]
}

type Due = 'touched' | 'memory'

interface Guard {
  // bounded: L.viewerTouchedMax spans, two numbers each; past it the two nearest join
  /** The user's spans since the history began: `[from, to]` pairs, ascending, none touching another. */
  spans: readonly number[]
  /** What the history is estimated to hold, in bytes. */
  bytes: number
  /** The history must be cleared, and why. */
  due: Due | null
}

const FRESH: Guard = { spans: [], bytes: 0, due: null }

const compartment = new Compartment()
const agreedAt = Annotation.define<readonly Extent[]>()
const clearedForMemory = StateEffect.define<boolean>()

/** `spans` with `[from, to]` in it; spans it touches join it. */
function withSpan(spans: readonly number[], from: number, to: number): number[] {
  const out: number[] = []
  let i = 0
  while (i < spans.length && (spans[i + 1] as number) < from) out.push(spans[i++] as number, spans[i++] as number)
  while (i < spans.length && (spans[i] as number) <= to) {
    from = Math.min(from, spans[i++] as number)
    to = Math.max(to, spans[i++] as number)
  }
  out.push(from, to)
  while (i < spans.length) out.push(spans[i++] as number)
  return out
}

/** `spans` through `changes`, outwards; spans that come to touch join. */
function mapped(spans: readonly number[], changes: ChangeDesc): number[] {
  const out: number[] = []
  for (let i = 0; i < spans.length; i += 2) {
    const from = changes.mapPos(spans[i] as number, -1)
    const to = changes.mapPos(spans[i + 1] as number, 1)
    if (out.length > 0 && from <= (out[out.length - 1] as number)) out[out.length - 1] = Math.max(out[out.length - 1] as number, to)
    else out.push(from, to)
  }
  return out
}

/** Past L.viewerTouchedMax spans, the two with the smallest gap between them join, until it fits. */
function capped(spans: number[]): number[] {
  while (spans.length > 2 * L.viewerTouchedMax) {
    let at = 0
    let gap = Infinity
    for (let i = 0; i + 3 < spans.length; i += 2) {
      const g = (spans[i + 2] as number) - (spans[i + 1] as number)
      if (g < gap) {
        gap = g
        at = i
      }
    }
    spans.splice(at + 1, 2)
  }
  return spans
}

/** Whether `[from, to]` meets a span (closed intervals: touching counts). */
function meets(spans: readonly number[], from: number, to: number): boolean {
  let lo = 0
  let hi = spans.length / 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((spans[2 * mid + 1] as number) < from) lo = mid + 1
    else hi = mid
  }
  return lo < spans.length / 2 && (spans[2 * lo] as number) <= to
}

/** `g` with `more` bytes estimated, due to be cleared once past the cap. */
const grown = (g: Guard, spans: readonly number[], more: number): Guard => {
  const bytes = g.bytes + more
  return { spans, bytes, due: g.due ?? (bytes > L.viewerHistoryMaxBytes ? 'memory' : null) }
}

const guard = StateField.define<Guard>({
  create: () => FRESH,
  update(g, tr) {
    const agreed = tr.annotation(agreedAt)
    if (!tr.docChanged && !agreed) {
      // no change, but the history may store the selection before it (one it joins to the last it stores leaves the
      // history as it was)
      if (tr.annotation(Transaction.addToHistory) === false || tr.startState.field(historyField, false) === tr.state.field(historyField, false)) return g
      return grown(g, g.spans, L.viewerHistoryEntryBytes * tr.startState.selection.ranges.length)
    }
    if (tr.annotation(Transaction.addToHistory) === false) {
      // tested before mapping: a change from disk where the user changed something makes an undo unsafe
      let due = g.due
      if (due === null && isFromDisk(tr) && g.spans.length > 0) {
        let hit = agreed?.some((e) => meets(g.spans, e.from, e.to)) ?? false
        if (!hit) tr.changes.iterChangedRanges((from, to) => void (hit ||= meets(g.spans, from, to)))
        if (hit) due = 'touched'
      }
      if (!tr.docChanged) return due === g.due ? g : { ...g, due }
      return { spans: mapped(g.spans, tr.changes), bytes: g.bytes, due }
    }
    // recorded by the history: the step stores its changes and the selection before it
    let spans = mapped(g.spans, tr.changes)
    let more = L.viewerHistoryEntryBytes * tr.startState.selection.ranges.length
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      spans = withSpan(spans, fromB, toB)
      more += toA - fromA + inserted.length + L.viewerHistoryEntryBytes
    })
    return grown(g, capped(spans), more)
  },
})

/** True from a clear for memory until the next recorded change. */
const note = StateField.define<boolean>({
  create: () => false,
  update(cleared, tr) {
    for (const e of tr.effects) if (e.is(clearedForMemory)) return e.value
    return cleared && !(tr.docChanged && tr.annotation(Transaction.addToHistory) !== false)
  },
})

const recording = (): Extension => [history(), guard]

const dueOf = (state: EditorState): Due | null => state.field(guard, false)?.due ?? null

/** The two transactions that clear the history; the spans and the estimate start again with it. */
function clearing(memory: boolean): TransactionSpec[] {
  return [
    { effects: memory ? [compartment.reconfigure([]), clearedForMemory.of(true)] : compartment.reconfigure([]), annotations: Transaction.addToHistory.of(false) },
    { effects: compartment.reconfigure(recording()), annotations: Transaction.addToHistory.of(false) },
  ]
}

function clearOn(view: Target, memory: boolean): void {
  if (compartment.get(view.state) === undefined) return
  for (const spec of clearing(memory)) view.dispatch(view.state.update(spec))
}

/** Clear the document's undo history. */
export function clearHistory(view: Target): void {
  clearOn(view, false)
}

/** Clear the history if it is due to be (the estimate past its cap, or a change from disk that met the user's). */
export function settleHistory(view: Target): void {
  const due = dueOf(view.state)
  if (due !== null) clearOn(view, due === 'memory')
}

/**
 * A history due to be cleared after the user's own change (the estimate past its cap) is cleared once the update is
 * over: a view cannot be updated from inside an update.
 */
const settle = ViewPlugin.define((view) => {
  let queued = false
  let gone = false
  const check = (): void => {
    if (queued || dueOf(view.state) === null) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (!gone) settleHistory(view)
    })
  }
  check()
  return { update: check, destroy: () => void (gone = true) }
})

/** The undo history of a file document, editable or not, with its guard and its estimate. */
export function undoHistory(): Extension {
  return [note, compartment.of(recording()), settle]
}

/** What the document's undo history is estimated to hold, in bytes. */
export function historyBytes(state: EditorState): number {
  return state.field(guard, false)?.bytes ?? 0
}

/** The history was cleared to save memory, and the user has changed nothing since (the notice). */
export function historyClearedForMemory(state: EditorState): boolean {
  return state.field(note, false) ?? false
}

/** The spans the user changed since the history began, ascending. */
export function touchedSpans(state: EditorState): Extent[] {
  const spans = state.field(guard, false)?.spans ?? []
  const out: Extent[] = []
  for (let i = 0; i < spans.length; i += 2) out.push({ from: spans[i] as number, to: spans[i + 1] as number })
  return out
}

function diskSpec(c: DiskChange): TransactionSpec {
  const out = [fromDisk.of(true), Transaction.addToHistory.of(false)]
  return { changes: c.changes, effects: c.effects ?? [], annotations: c.agreed && c.agreed.length > 0 ? [...out, agreedAt.of(c.agreed)] : out }
}

/** Apply a change from disk to the document on screen, out of history; the history is cleared after it when it must be. */
export function applyFromDisk(view: Target, c: DiskChange): void {
  view.dispatch(view.state.update(diskSpec(c)))
  settleHistory(view)
}

/** `applyFromDisk` for a document off screen: the state after it, cleared history included. */
export function stateFromDisk(state: EditorState, c: DiskChange): EditorState {
  let next = state.update(diskSpec(c)).state
  const due = dueOf(next)
  if (due !== null) for (const spec of clearing(due === 'memory')) next = next.update(spec).state
  return next
}
