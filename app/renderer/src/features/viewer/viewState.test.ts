import { foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language'
import { EditorSelection, EditorState, Text } from '@codemirror/state'
import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { foldingState, indentBlock, staleFoldEffects } from './folding.ts'
import { fromDisk, readOnly } from './readonly.ts'
import { reloadChanges } from './reload.ts'
import { EMPTY_VIEW } from './tab.ts'
import { captureView, parseLineCol, positionAt, positionOf, restoreFolds, selectionFor } from './viewState.ts'

const SOURCE = [
  'export function login(req) {', // 1
  '  const session = getSession(req)', // 2
  '  if (!session) {', // 3
  '    return redirect("/signin")', // 4
  '', // 5
  '    // unreachable', // 6
  '  }', // 7
  '  return session', // 8
  '}', // 9
  '', // 10
  'export function logout(req) {', // 11
  '  clear(req)', // 12
  '}', // 13
  '', // 14
]

const make = (lines: readonly string[], sel?: EditorSelection) => EditorState.create({ doc: Text.of([...lines]), extensions: [readOnly(), foldingState()], ...(sel ? { selection: sel } : {}) })
const foldLine = (state: EditorState, header: number) => {
  const block = indentBlock(state.doc, header, state.tabSize)!
  return state.update({ effects: foldEffect.of({ from: state.doc.line(header).to, to: state.doc.line(block.last).to }) }).state
}
const folded = (state: EditorState): [number, number][] => {
  const out: [number, number][] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => void out.push([state.doc.lineAt(from).number, state.doc.lineAt(to).number]))
  return out
}
const reload = (state: EditorState, lines: readonly string[]) => {
  const r = reloadChanges(state.doc, lines)
  if (!r) return state
  // as the editor applies a reload (editor.ts): the changes, then the folds the new text no longer has
  const next = state.update({ changes: r.changes, annotations: fromDisk.of(true) }).state
  return next.update({ effects: staleFoldEffects(next) }).state
}

describe('what a tab keeps of its view', () => {
  it('U-FV-6 · selection and folds go to line numbers and back; folds survive a reload where the lines around them are unchanged; a line:col lands inside the document', () => {
    // ── positions ──────────
    const doc = Text.of([...SOURCE])
    expect(positionAt(doc, { line: 1, col: 1 })).toBe(0)
    expect(positionAt(doc, { line: 2, col: 3 })).toBe(doc.line(2).from + 2)
    // past the end of a line, of the document, or before its start: the nearest place that exists
    expect(positionAt(doc, { line: 2, col: 999 })).toBe(doc.line(2).to)
    expect(positionAt(doc, { line: 999, col: 1 })).toBe(doc.line(doc.lines).from)
    expect(positionAt(doc, { line: 0, col: 0 })).toBe(0)
    expect(positionAt(doc, { line: -5, col: -5 })).toBe(0)
    expect(positionOf(doc, doc.line(4).from + 4)).toEqual({ line: 4, col: 5 })
    expect(positionOf(doc, 10_000)).toEqual({ line: doc.lines, col: 1 })
    for (const pos of [0, 5, doc.line(5).from, doc.length]) expect(positionAt(doc, positionOf(doc, pos))).toBe(pos)
    expect(parseLineCol('42')).toEqual({ line: 42, col: 1 })
    expect(parseLineCol(' 42:7 ')).toEqual({ line: 42, col: 7 })
    expect(parseLineCol('42,7')).toEqual({ line: 42, col: 7 })
    expect(parseLineCol('42:0')).toEqual({ line: 42, col: 1 })
    for (const bad of ['', 'abc', '0', '-3', '4:', ':4', '4:5:6', '1e3', '12345678901']) expect(parseLineCol(bad), bad).toBeNull()

    // ── indentation folds (VS Code's strategy) ──
    expect(indentBlock(doc, 1, 4)).toEqual({ last: 8 })
    // blank lines inside do not end the block; the closing brace is not part of it
    expect(indentBlock(doc, 3, 4)).toEqual({ last: 6 })
    expect(indentBlock(doc, 11, 4)).toEqual({ last: 12 })
    for (const n of [2, 4, 5, 8, 9, 10, 13, 14]) expect(indentBlock(doc, n, 4), `line ${n}`).toBeNull()
    expect(indentBlock(Text.of(['a', '\tb', '\t\tc', '  d', 'e']), 1, 4)).toEqual({ last: 4 })

    // ── round trip ──────────
    let state = make(SOURCE, EditorSelection.single(doc.line(4).from + 4, doc.line(8).from + 2))
    state = foldLine(state, 11)
    state = foldLine(state, 3)
    const kept = captureView(state, { line: 3, offset: 6, left: 0 })
    expect(kept).toEqual({
      scroll: { line: 3, offset: 6, left: 0 },
      selection: { anchor: { line: 4, col: 5 }, head: { line: 8, col: 3 } },
      // in the order they were made: the newest last
      folds: [
        { from: 11, to: 12 },
        { from: 3, to: 6 },
      ],
    })
    // plain data: it survives a structured clone (the strip keeps it, and it must never hold the document)
    expect(structuredClone(kept)).toEqual(kept)
    // on a state made from the same text again (the tab shown again, the file read again)
    let again = make(SOURCE, selectionFor(doc, kept.selection))
    again = again.update({ effects: restoreFolds(again, kept) }).state
    expect(folded(again)).toEqual([
      [3, 6],
      [11, 12],
    ])
    // the order they were made in comes back with them
    expect(captureView(again, kept.scroll)).toEqual(kept)
    // an unfolded range is forgotten
    const open = again.update({ effects: unfoldEffect.of({ from: again.doc.line(3).to, to: again.doc.line(6).to }) }).state
    expect(captureView(open, null).folds).toEqual([{ from: 11, to: 12 }])
    // a tab never shown, and a selection that points outside a shorter file
    expect(selectionFor(doc, EMPTY_VIEW.selection)).toBeUndefined()
    expect(restoreFolds(again, EMPTY_VIEW)).toEqual([])
    expect(selectionFor(Text.of(['only']), { anchor: { line: 40, col: 9 }, head: { line: 52, col: 1 } })!.main).toMatchObject({ anchor: 4, head: 0 })

    // ── folds restored only where the text still folds the same way ──
    const changed = [...SOURCE]
    changed.splice(5, 1) // the block under line 3 lost a line: it now ends on line 4
    let other = make(changed)
    other = other.update({ effects: restoreFolds(other, kept) }).state
    // line 11's block moved up a line, so that fold does not apply either; nothing is folded wrongly
    expect(folded(other)).toEqual([])
    expect(restoreFolds(make(['a']), { ...EMPTY_VIEW, folds: [{ from: 0, to: 3 }, { from: 99, to: 100 }] })).toEqual([])

    // ── a reload: the smallest change, so folds elsewhere stay ─────────
    let live = foldLine(foldLine(make(SOURCE), 3), 11)
    // the agent rewrites line 8 and adds two lines at the top
    const edited = ['// header', '', ...SOURCE]
    edited[9] = '  return session ?? null'
    live = reload(live, edited)
    expect(live.doc.toString()).toBe(edited.join('\n'))
    expect(folded(live)).toEqual([
      [5, 8],
      [13, 14],
    ])
    expect(captureView(live, null).folds).toEqual([
      { from: 5, to: 8 },
      { from: 13, to: 14 },
    ])
    // the folded block's own header line is removed: its fold goes, the other stays
    const cut = edited.filter((_, i) => i !== 4)
    live = reload(live, cut)
    expect(live.doc.toString()).toBe(cut.join('\n'))
    expect(folded(live)).toEqual([[12, 13]])
    // a line added inside a folded block stays folded away with it
    const inside = [...cut]
    inside.splice(12, 0, '  audit(req)')
    live = reload(live, inside)
    expect(folded(live)).toEqual([[12, 14]])
    // a line added after the block's last line: the block is no longer what was folded, so it opens
    const grown = [...inside]
    grown.splice(14, 0, '  done(req)')
    live = reload(live, grown)
    expect(live.doc.toString()).toBe(grown.join('\n'))
    expect(folded(live)).toEqual([])

    // ── the reload itself: nothing for the same text, only the differing lines for anything else ──
    const t = Text.of(['a', 'b', 'c', 'd'])
    expect(reloadChanges(t, ['a', 'b', 'c', 'd'])).toBeNull()
    const apply = (base: Text, to: readonly string[]) => {
      const r = reloadChanges(base, to)
      return r ? EditorState.create({ doc: base }).update({ changes: r.changes }).state.doc.toString() : base.toString()
    }
    const cases: string[][] = [
      ['a', 'X', 'c', 'd'],
      ['a', 'b', 'c', 'd', 'e'],
      ['z', 'a', 'b', 'c', 'd'],
      ['a', 'b', 'X', 'Y', 'c', 'd'],
      ['a', 'd'],
      ['a', 'b', 'c'],
      ['b', 'c', 'd'],
      ['a', 'b', 'c', 'd', ''],
      [''],
      ['x'],
      ['a', 'a', 'b', 'c', 'd'],
      ['a', 'b', 'c', 'd', 'd'],
      ['d', 'c', 'b', 'a'],
      ['X', 'b', 'c', 'Y'],
      ['X', 'b', 'Y', 'd', 'Z'],
      ['b', 'd'],
      ['c'],
    ]
    for (const lines of cases) {
      expect(apply(t, lines), lines.join('|')).toBe(lines.join('\n'))
      // the first line that differs is where tokenising resumes
      let first = 0
      while (first < 4 && first < lines.length && t.line(first + 1).text === lines[first]) first++
      expect(reloadChanges(t, lines)!.firstLine, lines.join('|')).toBe(first)
    }
    for (const from of [[''], ['x'], ['a', ''], ['', '', '']]) for (const to of [[''], ['y'], ['a', 'b', ''], ['', 'x']]) expect(apply(Text.of(from), to), `${JSON.stringify(from)} → ${JSON.stringify(to)}`).toBe(to.join('\n'))
    // changes in two places are two changes: the lines between them are not touched
    const two = reloadChanges(Text.of(['a', 'b', 'c', 'd', 'e', 'f']), ['a', 'B', 'c', 'd', 'E', 'f'])!
    expect(two.changes.map((c) => [c.from, c.to, c.insert.toString()])).toEqual([
      [2, 3, 'B'],
      [8, 9, 'E'],
    ])
    // random edits of a longer text always land on the new text
    let seed = 7
    const rnd = (k: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k
    const base = Array.from({ length: 200 }, (_, i) => `row ${i % 23}`)
    for (let round = 0; round < 60; round++) {
      const next = [...base]
      for (let e = 0; e < 1 + rnd(5); e++) {
        const at = rnd(next.length + 1)
        const kind = rnd(3)
        if (kind === 0) next.splice(at, 0, ...Array.from({ length: 1 + rnd(4) }, () => `new ${rnd(9)}`))
        else if (kind === 1) next.splice(at, 1 + rnd(4))
        else if (at < next.length) next[at] = `edit ${rnd(9)}`
      }
      if (next.length === 0) next.push('')
      expect(apply(Text.of(base), next), `round ${round}`).toBe(next.join('\n'))
    }
    // a middle over the line-diff limit is replaced as one change, and still lands on the new text
    const big1 = Array.from({ length: L.viewerReloadDiffLines + 3 }, (_, i) => `old ${i}`)
    const big2 = ['same', ...Array.from({ length: L.viewerReloadDiffLines + 3 }, (_, i) => `new ${i}`), 'end']
    const one = reloadChanges(Text.of(['same', ...big1, 'end']), big2)!
    expect(one.changes).toHaveLength(1)
    expect(one.firstLine).toBe(1)

    // the cap on a tab's folds (L.viewerTabFoldsMax): the newest are the ones kept
    const many = Array.from({ length: (L.viewerTabFoldsMax + 5) * 2 }, (_, i) => (i % 2 === 0 ? `block ${i / 2}` : '  body'))
    let big = make(many)
    for (let h = 1; h < many.length; h += 2) big = foldLine(big, h)
    const capped = captureView(big, null).folds
    expect(capped).toHaveLength(L.viewerTabFoldsMax)
    expect(capped.at(-1)).toEqual({ from: many.length - 1, to: many.length })
    expect(capped[0]).toEqual({ from: 11, to: 12 })
  })
})
