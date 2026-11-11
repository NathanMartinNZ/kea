import { EditorState } from '@codemirror/state'
import type { LineChange } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { changeGutter, changeRuns, nextChange, setLineChanges } from './gutter.ts'
import { changeNear, rulerLayout, type RulerGeometry } from './ruler.ts'

/** A document of `lines` numbered lines with core's answer `changes` applied. */
function changed(lines: number, changes: LineChange[], o: { whole?: boolean; truncated?: boolean } = {}): EditorState {
  const doc = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')
  const state = EditorState.create({ doc, extensions: [changeGutter()] })
  return state.update({ effects: setLineChanges.of({ scope: 'uncommitted', base: 'HEAD', changes, whole: o.whole ?? false, truncated: o.truncated ?? false }) }).state
}

/** `text` put in at the start of line `n`. */
function insertAt(state: EditorState, n: number, text: string): EditorState {
  return state.update({ changes: { from: state.doc.line(n).from, insert: text } }).state
}

/** The changed runs as line spans. */
function regions(state: EditorState): { from: number; to: number }[] {
  return changeRuns(state).runs.map((r) => ({ from: state.doc.lineAt(r.from).number, to: state.doc.lineAt(r.to).number }))
}

/** The cursor on line `n`. */
function cursorOn(state: EditorState, n: number): EditorState {
  return state.update({ selection: { anchor: state.doc.line(n).from } }).state
}

/** A height map of unwrapped lines, each `LINE` px tall. */
const LINE = 10
const blocks = (state: EditorState) => (pos: number) => {
  const n = state.doc.lineAt(pos).number
  return { top: (n - 1) * LINE, bottom: n * LINE }
}

/** The ruler's marks for `state` on a ruler `height` device pixels tall, marks at least `min`. */
function layout(state: EditorState, height = 800, min = 4): ReturnType<typeof rulerLayout> {
  const g: RulerGeometry = { pad: 0, contentHeight: state.doc.lines * LINE, height, min }
  return rulerLayout(changeRuns(state), blocks(state), g)
}

describe('change ruler', () => {
  it('U-FV-31 · the changed regions follow the lines typed above and inside them until core answers again; ⌥↓ goes to where they are now', () => {
    // lines 10–12 modified, line 30 added
    const start = changed(40, [
      { kind: 'modified', from: 10, to: 12 },
      { kind: 'added', from: 30, to: 30 },
    ])
    expect(regions(start)).toEqual([
      { from: 10, to: 12 },
      { from: 30, to: 30 },
    ])
    // three lines typed above the first change: both move down
    const above = insertAt(start, 2, 'a\nb\nc\n')
    expect(regions(above)).toEqual([
      { from: 13, to: 15 },
      { from: 33, to: 33 },
    ])
    // ⌥↓ from the top lands on the change's first line as it is now, and on the next one after it
    expect(nextChange(cursorOn(above, 1), 1)).toBe(13)
    expect(nextChange(cursorOn(above, 13), 1)).toBe(33)
    expect(nextChange(cursorOn(above, 33), 1), 'around the end').toBe(13)
    expect(nextChange(cursorOn(above, 20), -1)).toBe(13)
    expect(nextChange(cursorOn(above, 13), -1), 'around the start').toBe(33)
    // a line typed inside the first change: it grows, the second moves down
    const inside = insertAt(above, 14, 'more\n')
    expect(regions(inside)).toEqual([
      { from: 13, to: 16 },
      { from: 34, to: 34 },
    ])
    expect(nextChange(cursorOn(inside, 20), 1)).toBe(34)
    // core's next answer replaces them
    const answered = inside.update({ effects: setLineChanges.of({ scope: 'uncommitted', base: 'HEAD', changes: [{ kind: 'added', from: 2, to: 4 }], whole: false, truncated: false }) }).state
    expect(regions(answered)).toEqual([{ from: 2, to: 4 }])
    // a deletion stays below its line; one before the first line stays above the line that was first
    const deleted = changed(20, [
      { kind: 'deleted', from: 0, to: 0 },
      { kind: 'deleted', from: 5, to: 5 },
    ])
    const typed = insertAt(deleted, 1, 'x\n')
    expect(regions(typed)).toEqual([
      { from: 2, to: 2 },
      { from: 6, to: 6 },
    ])
    expect(nextChange(cursorOn(typed, 2), 1)).toBe(6)
  })

  it('U-FV-31 · each change is as tall as its share of the file at its place in the whole file; one shorter than the least height is that height, centred on the change, as VS Code draws its overview ruler', () => {
    // 400 lines of 10 px on an 800-pixel ruler: a line is 2 pixels
    const state = changed(400, [
      { kind: 'deleted', from: 0, to: 0 },
      { kind: 'deleted', from: 50, to: 50 },
      { kind: 'added', from: 101, to: 200 },
      { kind: 'modified', from: 300, to: 300 },
      { kind: 'modified', from: 400, to: 400 },
    ])
    expect(layout(state)).toEqual([
      // a deletion is a mark of the least height on its boundary, kept on the ruler at the top
      { kind: 'deleted', y: 0, h: 4 },
      { kind: 'deleted', y: 98, h: 4 },
      // a quarter of the file: a quarter of the ruler
      { kind: 'added', y: 200, h: 200 },
      // three quarters of the way down; one line (rows 598–600) is shorter than the least height: centred on it
      { kind: 'modified', y: 597, h: 4 },
      // the last line: kept on the ruler at the bottom
      { kind: 'modified', y: 796, h: 4 },
    ])
    // the content's top padding moves every mark down with its lines
    const padded = rulerLayout(changeRuns(state), blocks(state), { pad: 400, contentHeight: 4000 + 2 * 400, height: 960, min: 4 })
    expect(padded.find((m) => m.kind === 'added')).toEqual({ kind: 'added', y: 280, h: 200 })
    // typed lines above a change move its mark
    const typed = insertAt(changed(400, [{ kind: 'modified', from: 300, to: 300 }]), 1, 'x\n'.repeat(100))
    expect(layout(typed)).toEqual([{ kind: 'modified', y: 637, h: 4 }])
  })

  it('U-FV-31 · changes on the same pixel rows are one mark of their kind; a file new as a whole fills the ruler; no changes, or too many to read, show no ruler', () => {
    // 4 000 lines on an 800-pixel ruler: five lines a pixel. A change every fourth line merges into one mark
    const many = changed(
      4000,
      Array.from({ length: 1000 }, (_, i) => ({ kind: 'modified' as const, from: 4 * i + 1, to: 4 * i + 1 })),
    )
    expect(layout(many)).toEqual([{ kind: 'modified', y: 0, h: 800 }])
    // lines 10 and 12 share their rows; an added line beside them is drawn as its own kind
    const near = changed(4000, [
      { kind: 'modified', from: 10, to: 10 },
      { kind: 'modified', from: 12, to: 12 },
      { kind: 'added', from: 14, to: 14 },
    ])
    expect(layout(near)).toEqual([
      { kind: 'modified', y: 0, h: 4 },
      { kind: 'added', y: 1, h: 4 },
    ])
    expect(layout(changed(400, [], { whole: true }))).toEqual([{ kind: 'added', y: 0, h: 800 }])
    expect(layout(changed(400, [], { truncated: true }))).toEqual([])
    expect(layout(changed(400, []))).toEqual([])
    expect(layout(EditorState.create({ doc: 'a\nb', extensions: [changeGutter()] }))).toEqual([])
  })

  it('U-FV-31 · a click on the ruler goes to the change nearest it', () => {
    const state = changed(400, [
      { kind: 'added', from: 11, to: 20 },
      { kind: 'deleted', from: 50, to: 50 },
      { kind: 'modified', from: 91, to: 100 },
    ])
    const near = (y: number) => changeNear(changeRuns(state), state.doc, blocks(state), 0, y)
    expect(near(0)).toBe(11)
    expect(near(150), 'inside the change').toBe(11)
    expect(near(340)).toBe(11)
    expect(near(360), 'the deletion below line 50').toBe(50)
    expect(near(3999)).toBe(91)
    expect(changeNear(changeRuns(changed(400, [], { whole: true })), state.doc, blocks(state), 0, 3000)).toBe(1)
    expect(changeNear(changeRuns(changed(400, [])), state.doc, blocks(state), 0, 3000)).toBeNull()
  })
})
