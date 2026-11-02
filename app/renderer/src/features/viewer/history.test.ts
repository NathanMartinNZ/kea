import { redo, undo, undoDepth } from '@codemirror/commands'
import { EditorSelection, EditorState, Text, Transaction } from '@codemirror/state'
import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { applyFromDisk, clearHistory, historyBytes, historyClearedForMemory, settleHistory, stateFromDisk, touchedSpans, undoHistory } from './history.ts'
import { marks, marksOf, setMarks, useTheFiles } from './marks.ts'
import { merge } from './rebase.ts'
import { reloadChanges } from './reload.ts'

/** A file document as the viewer keeps it: its state, and `base`, the file's text as last read or saved. */
class Doc {
  state: EditorState
  base: Text
  clock = 0
  constructor(lines: readonly string[]) {
    this.base = Text.of([...lines])
    this.state = EditorState.create({ doc: this.base, extensions: [undoHistory(), marks()] })
  }
  dispatch = (tr: Transaction): void => {
    this.state = tr.state
  }
  get text(): string {
    return this.state.doc.toString()
  }
  /** The user changes `[from, to)` to `insert`: one undo step of its own. */
  type(from: number, to: number, insert: string): void {
    this.dispatch(this.state.update({ changes: { from, to, insert }, userEvent: 'input.type', annotations: Transaction.time.of((this.clock += 1000)) }))
  }
  save(): void {
    this.base = this.state.doc
  }
  /** The file now has `lines`: reloaded into a document with no unsaved text, merged into one with some. */
  disk(lines: readonly string[]): ReturnType<typeof merge> | null {
    let r: ReturnType<typeof merge> | null = null
    if (this.state.doc.eq(this.base)) applyFromDisk(this, { changes: reloadChanges(this.state.doc, lines)?.changes ?? [] })
    else {
      r = merge({ base: this.base, doc: this.state.doc, disk: lines, marks: marksOf(this.state, this.base) })
      applyFromDisk(this, { changes: r.changes ?? [], effects: [setMarks.of(r.marks)], agreed: r.agreed })
    }
    this.base = Text.of([...lines])
    return r
  }
}

describe('the undo history of a file document', () => {
  it('U-FV-22 · history guard: a backspace at a line’s end then the agent rewrites the line, the agent deletes a line the user edited, an agree place inside a span — history is cleared; an agent change next to (not in) a span keeps it, and an undo never takes out the agent’s text', () => {
    // a backspace at the end of the first line, saved; the agent rewrites the line (an undo would glue `c` to its text)
    const a = new Doc(['abc', 'def', ''])
    a.type(2, 3, '')
    a.save()
    a.disk(['XY', 'def', ''])
    expect([a.text, undoDepth(a.state), historyBytes(a.state), touchedSpans(a.state)]).toEqual(['XY\ndef\n', 0, 0, []])
    expect(undo(a)).toBe(false)

    // the agent deletes a line the user edited
    const b = new Doc(['a', 'b', 'c', ''])
    b.type(3, 3, 'x')
    b.save()
    b.disk(['a', 'c', ''])
    expect([b.text, undoDepth(b.state)]).toEqual(['a\nc\n', 0])

    // next to it, not in it: the line after the user's typing; the undo takes out only the user's text
    const c = new Doc(['a', 'b', 'c', 'd', ''])
    c.type(3, 3, 'x')
    c.save()
    c.disk(['a', 'bx', 'C', 'd', ''])
    expect(undoDepth(c.state)).toBe(1)
    undo(c)
    expect(c.text).toBe('a\nb\nC\nd\n')
    // the same under unsaved text: the agent's line merged in, the undo takes out the user's own
    const u = new Doc(['a', 'b', 'c', 'd', ''])
    u.type(3, 3, 'x')
    u.disk(['a', 'b', 'c', 'D', ''])
    expect(u.text).toBe('a\nbx\nc\nD\n')
    undo(u)
    expect(u.text).toBe('a\nb\nc\nD\n')
    // touching counts: the last line taken out takes the line break right after the user's typing
    const t = new Doc(['a', 'b', 'c'])
    t.type(3, 3, 'x')
    t.save()
    t.disk(['a', 'bx'])
    expect(undoDepth(t.state)).toBe(0)

    // the agent writes what the user typed: nothing is applied, but an undo would take out text the file has
    const e = new Doc(['a', 'b', 'c', ''])
    e.type(2, 3, 'P')
    const r = e.disk(['a', 'P', 'c', ''])
    expect([r?.changes, r?.agreed.length, undoDepth(e.state), e.text]).toEqual([null, 1, 0, 'a\nP\nc\n'])
  })

  it('U-FV-22 · undo, redo and Use the File’s count as the user’s changes; the guard tests before mapping; a clean reload after a save is checked the same way', () => {
    // typed, undone (clean again), the agent rewrites the line: a redo would put the user's text into the agent's
    const f = new Doc(['a', 'b', 'c', ''])
    f.type(2, 3, 'X')
    undo(f)
    expect(f.text).toBe('a\nb\nc\n')
    f.disk(['a', 'B', 'c', ''])
    expect(redo(f)).toBe(false)
    expect(f.text).toBe('a\nB\nc\n')

    // Use the File's, then the agent writes there again: its undo would put the user's text over the agent's newest
    const g = new Doc(['a', 'b', 'c', 'd', 'e', ''])
    g.type(2, 3, 'P')
    g.disk(['a', 'T', 'c', 'd', 'e', ''])
    expect([marksOf(g.state).length, undoDepth(g.state)]).toEqual([1, 1])
    useTheFiles(g, g.base)
    g.disk(['a', 'T2', 'c', 'd', 'e', ''])
    expect(undo(g)).toBe(false)
    expect(g.text).toBe('a\nT2\nc\nd\ne\n')

    // a line put in above and a line rewritten below the user's typing: neither meets it before mapping
    const m = new Doc(['abc', 'def', 'ghi', ''])
    m.type(5, 5, 'X')
    m.save()
    m.disk(['new', 'abc', 'dXef', 'GHI', ''])
    expect(undoDepth(m.state)).toBe(1)
    undo(m)
    expect(m.text).toBe('new\nabc\ndef\nGHI\n')

    // off screen: the same guard, the clear included
    const o = new Doc(['abc', 'def', ''])
    o.type(2, 3, '')
    const next = stateFromDisk(o.state, { changes: reloadChanges(o.state.doc, ['XY', 'def', ''])!.changes })
    expect([next.doc.toString(), undoDepth(next)]).toEqual(['XY\ndef\n', 0])
    const far = stateFromDisk(o.state, { changes: reloadChanges(o.state.doc, ['ab', 'DEF', ''])!.changes })
    expect(undoDepth(far)).toBe(1)
  })

  it('U-FV-22 · more spans than L.viewerTouchedMax: the two nearest join', () => {
    const n = L.viewerTouchedMax + 1
    const short = 10
    const d = new Doc(Array.from({ length: n + 1 }, (_, i) => (i === short ? 'a' : 'aaaa')))
    for (let line = 1; line <= n; line++) {
      const at = d.state.doc.line(line).from
      d.type(at, at, 'x')
    }
    const spans = touchedSpans(d.state)
    expect(spans).toHaveLength(L.viewerTouchedMax)
    // the short line's typing and the next line's are the nearest: one span now, every other span as typed
    const doc = d.state.doc
    expect(spans[short]).toEqual({ from: doc.line(short + 1).from, to: doc.line(short + 2).from + 1 })
    expect(spans[0]).toEqual({ from: 0, to: 1 })
    expect(spans.at(-1)).toEqual({ from: doc.line(n).from, to: doc.line(n).from + 1 })
  })

  it('U-FV-24 · the history estimate: characters put in and taken out, an entry per change and per selection range a step stores (multi-cursor); changes from disk do not count; past L.viewerHistoryMaxBytes the history is cleared and says so until the next change; every clear starts the estimate again', () => {
    const E = L.viewerHistoryEntryBytes
    let clock = 0
    const time = () => Transaction.time.of((clock += 1000))
    const t = {
      state: EditorState.create({
        doc: 'one\ntwo\nthree\n',
        selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4), EditorSelection.cursor(8)]),
        extensions: [EditorState.allowMultipleSelections.of(true), undoHistory()],
      }),
      dispatch(tr: Transaction) {
        t.state = tr.state
      },
    }
    expect(historyBytes(t.state)).toBe(0)
    // three cursors type one character: three changes and the three ranges the step stores
    t.dispatch(t.state.update(t.state.replaceSelection('x'), { userEvent: 'input.type', annotations: time() }))
    expect(historyBytes(t.state)).toBe(3 + 3 * E + 3 * E)
    // five characters taken out at once
    let bytes = historyBytes(t.state)
    t.dispatch(t.state.update({ changes: { from: 0, to: 5 }, selection: { anchor: 0 }, userEvent: 'delete', annotations: time() }))
    expect(historyBytes(t.state)).toBe(bytes + 5 + E + 3 * E)
    bytes = historyBytes(t.state)
    // a change from disk away from the user's: not the history's
    applyFromDisk(t, { changes: { from: t.state.doc.length, insert: 'disk\n' } })
    expect(undoDepth(t.state)).toBe(2)
    expect(historyBytes(t.state)).toBe(bytes)
    // an undo is a step too
    undo(t)
    expect(historyBytes(t.state)).toBe(bytes + 5 + E + E)
    expect(historyClearedForMemory(t.state)).toBe(false)

    // a selection the history stores between steps: an entry for each range of the selection before it (the undo put
    // the three cursors back); one it joins to the last (the same kind soon after, the same shape) stores nothing
    bytes = historyBytes(t.state)
    expect(t.state.selection.ranges).toHaveLength(3)
    t.dispatch(t.state.update({ selection: { anchor: 1 }, userEvent: 'select.pointer', annotations: time() }))
    expect(historyBytes(t.state)).toBe(bytes + 3 * E)
    t.dispatch(t.state.update({ selection: { anchor: 2 }, userEvent: 'select.pointer', annotations: time() }))
    expect(historyBytes(t.state)).toBe(bytes + 4 * E)
    t.dispatch(t.state.update({ selection: { anchor: 3 }, userEvent: 'select.pointer', annotations: Transaction.time.of(clock + 100) }))
    expect(historyBytes(t.state)).toBe(bytes + 4 * E)
    // out of history: nothing stored
    t.dispatch(t.state.update({ selection: { anchor: 4 }, annotations: Transaction.addToHistory.of(false) }))
    expect(historyBytes(t.state)).toBe(bytes + 4 * E)

    // past the cap: cleared after the change, and the notice stays until the next change
    t.dispatch(t.state.update({ changes: { from: 0, insert: 'y'.repeat(L.viewerHistoryMaxBytes) }, userEvent: 'input.paste' }))
    expect(undoDepth(t.state)).toBeGreaterThan(0)
    settleHistory(t)
    expect([historyBytes(t.state), undoDepth(t.state), historyClearedForMemory(t.state), touchedSpans(t.state)]).toEqual([0, 0, true, []])
    // a selection stored, then a change from disk: the notice stays
    t.dispatch(t.state.update({ selection: { anchor: 1 } }))
    applyFromDisk(t, { changes: { from: 0, insert: 'more ' } })
    expect([historyClearedForMemory(t.state), historyBytes(t.state)]).toEqual([true, E])
    t.dispatch(t.state.update({ changes: { from: 0, insert: 'z' }, userEvent: 'input.type' }))
    expect([historyClearedForMemory(t.state), historyBytes(t.state), undoDepth(t.state)]).toEqual([false, E + 1 + E + E, 1])
    // nothing due: settling does nothing
    settleHistory(t)
    expect(undoDepth(t.state)).toBe(1)
    // a clear by hand starts it again too, and says nothing about memory
    clearHistory(t)
    expect([historyBytes(t.state), undoDepth(t.state), historyClearedForMemory(t.state)]).toEqual([0, 0, false])
    t.dispatch(t.state.update({ changes: { from: 0, insert: 'q' }, userEvent: 'input.type' }))
    expect(undo(t)).toBe(true)
  })
})
