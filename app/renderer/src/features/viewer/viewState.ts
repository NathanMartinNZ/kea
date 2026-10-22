// What a tab keeps of its view, to and from an editor state: the selection and the folds as line numbers, so they can
// be put back on a document that was read again (and may have changed). The scroll position is the editor's to measure
// (`editor.ts`); everything here is pure over the state (U-FV-6).

import { EditorSelection, type EditorState, type StateEffect, type Text } from '@codemirror/state'
import { L } from '@kea/protocol/limits'
import { foldEffects, foldsOf } from './folding.ts'
import type { TabPosition, TabViewState } from './tab.ts'

/** The document position of a 1-based line and column, each kept inside the document. */
export function positionAt(doc: Text, p: TabPosition): number {
  const line = doc.line(Math.min(Math.max(1, Math.trunc(p.line)), doc.lines))
  return line.from + Math.min(Math.max(1, Math.trunc(p.col)), line.length + 1) - 1
}

export function positionOf(doc: Text, pos: number): TabPosition {
  const at = Math.min(Math.max(0, pos), doc.length)
  const line = doc.lineAt(at)
  return { line: line.number, col: at - line.from + 1 }
}

/** The state's selection and folds, as a tab keeps them. `scroll` is passed through. */
export function captureView(state: EditorState, scroll: TabViewState['scroll']): TabViewState {
  const sel = state.selection.main
  const folds = foldsOf(state)
  return {
    scroll,
    selection: { anchor: positionOf(state.doc, sel.anchor), head: positionOf(state.doc, sel.head) },
    // the newest are kept (the strip holds the same cap, `shell/tabs.ts`)
    folds: folds.length > L.viewerTabFoldsMax ? folds.slice(-L.viewerTabFoldsMax) : folds,
  }
}

/** The selection a tab kept, on `doc`. */
export function selectionFor(doc: Text, sel: TabViewState['selection']): EditorSelection | undefined {
  return sel ? EditorSelection.single(positionAt(doc, sel.anchor), positionAt(doc, sel.head)) : undefined
}

/** The effects that put a tab's folds back on `state` (those that still fold the same way). */
export function restoreFolds(state: EditorState, view: TabViewState): StateEffect<unknown>[] {
  return foldEffects(state, view.folds)
}

/** Parse `line[:col]` (Go to Line); null for anything else. */
export function parseLineCol(text: string): TabPosition | null {
  const m = /^\s*(\d{1,9})(?:\s*[:,]\s*(\d{1,9}))?\s*$/.exec(text)
  if (!m) return null
  const line = Number(m[1])
  if (line < 1) return null
  return { line, col: m[2] === undefined ? 1 : Math.max(1, Number(m[2])) }
}
