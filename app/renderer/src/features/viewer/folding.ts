// Folding by indentation (VS Code's default strategy): a line can be folded when the lines after it are indented
// deeper, up to the last such line before the indentation comes back (blank lines inside do not end the block, blank
// lines after it are not part of it). Fold chevrons sit in the gutter and show while it is hovered; a folded range
// reads `⋯`.
//
// The folds a tab keeps while hidden are line numbers, in the order they were made, so the newest survive the
// cap: `foldLog` records that order, since CodeMirror's own fold set is ordered by position.

import { codeFolding, foldEffect, foldGutter, foldService, foldable, foldedRanges, unfoldEffect } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'

/** The width of a line's leading whitespace in columns, or -1 for a blank line. */
function indentOf(text: string, tabSize: number): number {
  let col = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 32) col++
    else if (c === 9) col += tabSize - (col % tabSize)
    else return col
  }
  return -1
}

/** The lines `header` (1-based) folds away: up to `last`, or null when nothing below it is indented deeper. */
export function indentBlock(doc: Text, header: number, tabSize: number): { last: number } | null {
  const own = indentOf(doc.line(header).text, tabSize)
  if (own < 0) return null
  let last = 0
  for (let n = header + 1; n <= doc.lines; n++) {
    const indent = indentOf(doc.line(n).text, tabSize)
    if (indent < 0) continue
    if (indent <= own) break
    last = n
  }
  return last > 0 ? { last } : null
}

const indentFolds = foldService.of((state, lineStart) => {
  const header = state.doc.lineAt(lineStart)
  const block = indentBlock(state.doc, header.number, state.tabSize)
  return block ? { from: header.to, to: state.doc.line(block.last).to } : null
})

type Range = { from: number; to: number }

/** Folds put back together (a tab shown again): the order they were made in, which the fold effects beside it cannot say. */
const madeInOrder = StateEffect.define<readonly Range[]>()

/** The folds in the order they were made (positions, mapped through changes). */
const foldLog = StateField.define<readonly Range[]>({
  create: () => [],
  update(log, tr) {
    let next = log
    if (tr.docChanged) next = next.map((r) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) })).filter((r) => r.to > r.from)
    for (const e of tr.effects) {
      if (e.is(foldEffect)) next = [...next.filter((r) => r.from !== e.value.from || r.to !== e.value.to), { from: e.value.from, to: e.value.to }]
      else if (e.is(unfoldEffect)) next = next.filter((r) => r.from !== e.value.from || r.to !== e.value.to)
    }
    for (const e of tr.effects) if (e.is(madeInOrder)) next = e.value
    return next
  },
})

/** A tab's folds as it keeps them: header line and last line (1-based), oldest first. */
export function foldsOf(state: EditorState): { from: number; to: number }[] {
  // what is folded now decides; the log only gives the order
  const now = new Set<string>()
  foldedRanges(state).between(0, state.doc.length, (from, to) => void now.add(`${from}:${to}`))
  const out: { from: number; to: number }[] = []
  for (const r of state.field(foldLog, false) ?? []) {
    if (!now.delete(`${r.from}:${r.to}`)) continue
    out.push({ from: state.doc.lineAt(r.from).number, to: state.doc.lineAt(r.to).number })
  }
  // a fold the log never saw (none today) still counts, in document order, as the oldest
  const rest = [...now].map((k) => k.split(':').map(Number) as [number, number]).map(([from, to]) => ({ from: state.doc.lineAt(from).number, to: state.doc.lineAt(to).number }))
  return [...rest, ...out]
}

/**
 * The effects that fold `folds` again in `state` (a tab shown again). A fold is restored only where the text
 * still folds the same way: the same header line still ends its block on the same last line.
 */
export function foldEffects(state: EditorState, folds: readonly { from: number; to: number }[]): StateEffect<unknown>[] {
  const ranges: Range[] = []
  for (const f of folds) {
    if (f.from < 1 || f.from > state.doc.lines) continue
    const header = state.doc.line(f.from)
    const range = foldable(state, header.from, header.to)
    if (!range || state.doc.lineAt(range.to).number !== f.to) continue
    if (!ranges.some((r) => r.from === range.from)) ranges.push({ from: range.from, to: range.to })
  }
  if (ranges.length === 0) return []
  // CodeMirror takes several folds in one transaction only in document order; the order they were made in rides along
  return [...[...ranges].sort((a, b) => a.from - b.from).map((r) => foldEffect.of(r)), madeInOrder.of(ranges)]
}

/**
 * After a reload: the effects that open every fold the new text no longer folds that way — its header line
 * went or changed place, or its block now ends elsewhere. Folds whose lines are unchanged are left alone.
 */
export function staleFoldEffects(state: EditorState): StateEffect<unknown>[] {
  const out: StateEffect<unknown>[] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    const header = state.doc.lineAt(from)
    const range = from === header.to ? foldable(state, header.from, header.to) : null
    if (!range || range.from !== from || range.to !== to) out.push(unfoldEffect.of({ from, to }))
  })
  return out
}

function marker(open: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = open ? 'kea-fold kea-fold-open' : 'kea-fold kea-fold-closed'
  el.textContent = open ? '⌄' : '›'
  el.dataset.tip = open ? 'Fold' : 'Unfold'
  return el
}

/** The folding extension of the file view (left out in plain-text mode). */
export function folding(): Extension {
  return [indentFolds, foldLog, codeFolding({ placeholderText: '⋯' }), foldGutter({ markerDOM: marker })]
}

/** Folding for a state that has no view (unit tests, and the cache's states): the same without the gutter. */
export function foldingState(): Extension {
  return [indentFolds, foldLog, codeFolding({ placeholderText: '⋯' })]
}
