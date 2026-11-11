import { readFileSync } from 'node:fs'
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state'
import { highlightActiveLine, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { activeLine, CurrentLineMarks, currentLines } from './activeLine.ts'
import { baseExtensions } from './editor.ts'

const DOC = ['one', 'two', 'three', 'four', 'five'].join('\n')

function stateWith(...ranges: [anchor: number, head?: number][]): EditorState {
  return EditorState.create({
    doc: DOC,
    selection: EditorSelection.create(ranges.map(([anchor, head]) => EditorSelection.range(anchor, head ?? anchor))),
    extensions: EditorState.allowMultipleSelections.of(true),
  })
}

/** The lines (1-based) a set marks, each with the class the stylesheet fills. */
function lines(state: EditorState, set: DecorationSet): number[] {
  const out: number[] = []
  for (const it = set.iter(); it.value; it.next()) {
    expect(it.value.spec.class).toBe('cm-activeLine')
    out.push(state.doc.lineAt(it.from).number)
  }
  return out
}

const marked = (state: EditorState) => lines(state, currentLines(state))
/** The offset of `column` on line `n`. */
const at = (n: number, column: number) => stateWith([0]).doc.line(n).from + column

function flat(e: Extension): unknown[] {
  return Array.isArray(e) ? e.flatMap(flat) : [e]
}

/** A stand-in for the editor's view of `state`: a folded block is one line on screen, starting where its first line does. */
function viewOf(state: EditorState): EditorView {
  const lineBlockAt = (pos: number) => {
    let from = state.doc.lineAt(pos).from
    foldedRanges(state).between(pos, pos, (start) => void (from = state.doc.lineAt(start).from))
    return { from }
  }
  return { state, lineBlockAt } as unknown as EditorView
}

/** What the view tells its plugins after `tr`: its height changes as lines are folded or unfolded. */
function updateFor(tr: Transaction): ViewUpdate {
  const heightChanged = tr.docChanged || foldedRanges(tr.startState) !== foldedRanges(tr.state)
  return { view: viewOf(tr.state), state: tr.state, startState: tr.startState, docChanged: tr.docChanged, selectionSet: tr.selection !== undefined, heightChanged } as unknown as ViewUpdate
}

describe('the current line', () => {
  it('U-FV-32 · the line of each caret is marked current and no line is while any range selects text, whichever way it was made, so a selection shows on every line it covers; every viewer document uses this in place of CodeMirror’s, and the fill is translucent', () => {
    // a caret: its line
    expect(marked(stateWith([at(3, 2)]))).toEqual([3])
    // a range over three lines, dragged down and dragged up: none, the line it ends on included
    expect(marked(stateWith([at(2, 1), at(4, 2)]))).toEqual([])
    expect(marked(stateWith([at(4, 2), at(2, 1)]))).toEqual([])
    // a range within one line, and a caret beside a range: none
    expect(marked(stateWith([at(1, 0), at(1, 2)]))).toEqual([])
    expect(marked(stateWith([at(1, 1)], [at(3, 0), at(4, 1)]))).toEqual([])
    // several carets: each one's line, once
    expect(marked(stateWith([at(1, 1)], [at(4, 3)]))).toEqual([1, 4])
    expect(marked(stateWith([at(5, 0)], [at(5, 3)]))).toEqual([5])
    // the line on screen: a caret on the last line of a folded block marks the line the fold is shown on
    const folded = stateWith([at(4, 1)])
    expect(lines(folded, currentLines(folded, (pos) => (folded.doc.lineAt(pos).number >= 2 && folded.doc.lineAt(pos).number <= 4 ? folded.doc.line(2).from : folded.doc.lineAt(pos).from)))).toEqual([2])

    // the file view and the diff both have it, and not CodeMirror's, which marks the line a selection ends on
    const base = flat(baseExtensions({ eol: 'lf', store: null, guides: null, label: 'a.ts' }))
    expect(base).toContain(activeLine())
    expect(base).not.toContain(highlightActiveLine())

    // the fill is a tint over whatever is behind it, never an opaque colour that could hide a selection
    const css = readFileSync(new URL('./viewer.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const fills = [...css.matchAll(/([^{}]*\.cm-activeLine(?![\w-])[^{}]*)\{([^}]*)\}/g)].flatMap((m) => [...m[2]!.matchAll(/background(?:-color)?\s*:\s*([^;]+);/g)].map((b) => `${m[1]!.trim()}: ${b[1]!.trim()}`))
    expect(fills).toEqual(['.viewer .cm-editor .cm-activeLine: color-mix(in srgb, var(--text-1) calc(var(--opacity-active-line) * 100%), transparent)'])
  })

  it('U-FV-32 · folding the lines around the caret marks the line the fold is shown on, and unfolding them marks the caret’s own line again, the caret not moving', () => {
    const doc = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    const start = EditorState.create({ doc, extensions: codeFolding() })
    const caret = start.doc.line(5).from + 2
    let state = start.update({ selection: { anchor: caret } }).state
    const marks = new CurrentLineMarks(viewOf(state))
    const shown = () => lines(state, marks.decorations)
    const apply = (spec: TransactionSpec) => {
      const tr = state.update(spec)
      state = tr.state
      marks.update(updateFor(tr))
    }
    expect(shown()).toEqual([5])

    // lines 4 to 8 folded under line 3, as the fold gutter does it: the caret stays on line 5, inside the fold
    const fold = { from: state.doc.line(3).to, to: state.doc.line(8).to }
    apply({ effects: foldEffect.of(fold) })
    expect(state.selection.main.head).toBe(caret)
    expect(shown()).toEqual([3])

    apply({ effects: unfoldEffect.of(fold) })
    expect(state.selection.main.head).toBe(caret)
    expect(shown()).toEqual([5])
  })
})
