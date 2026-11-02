import { redo, undo, undoDepth } from '@codemirror/commands'
import { EditorState, Text, Transaction } from '@codemirror/state'
import { L } from '@kea/protocol/limits'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applyFromDisk, undoHistory } from './history.ts'
import { keepYours, marks, marksOf, setMarks, useTheFiles, type Mark } from './marks.ts'
import { merge, type Merge } from './rebase.ts'
import { reloadChanges } from './reload.ts'

/** A document with unsaved text as the viewer keeps it: its state, and `base`, the file's text it last read. */
class Doc {
  state: EditorState
  base: Text
  clock = 0
  constructor(base: readonly string[]) {
    this.base = Text.of([...base])
    this.state = EditorState.create({ doc: this.base, extensions: [undoHistory(), marks()] })
  }
  dispatch = (tr: Transaction): void => {
    this.state = tr.state
  }
  get text(): string {
    return this.state.doc.toString()
  }
  get marks(): readonly Mark[] {
    return marksOf(this.state, this.base)
  }
  /** The user changes `[from, to)` to `insert`: one undo step of its own. */
  type(from: number, to: number, insert: string): void {
    this.dispatch(this.state.update({ changes: { from, to, insert }, userEvent: 'input.type', annotations: Transaction.time.of((this.clock += 1000)) }))
  }
  /** The user makes the document these lines, changing only the lines that differ. */
  edit(lines: readonly string[]): void {
    const r = reloadChanges(this.state.doc, lines)
    if (r) this.dispatch(this.state.update({ changes: r.changes, userEvent: 'input.paste', annotations: Transaction.time.of((this.clock += 1000)) }))
  }
  /** The file now has these lines: merged as the viewer merges a read, and they become `base`. */
  disk(lines: readonly string[], marksMax?: number): Merge {
    const r = merge({ base: this.base, doc: this.state.doc, disk: lines, marks: marksOf(this.state, this.base), ...(marksMax === undefined ? {} : { marksMax }) })
    applyFromDisk(this, { changes: r.changes ?? [], effects: [setMarks.of(r.marks)], agreed: r.agreed })
    this.base = Text.of([...lines])
    return r
  }
  /** The file's text over each mark. */
  fileTexts(): string[] {
    return this.marks.map((m) => this.base.sliceString(m.base.from, m.base.to))
  }
  /** The document's text over each mark. */
  markedTexts(): string[] {
    return this.marks.map((m) => this.state.doc.sliceString(m.doc.from, m.doc.to))
  }
}

const linesOf = (s: string) => s.split('\n')

/** Marks are in order, inside the texts, and never overlap. */
function expectSound(ms: readonly Mark[], doc: Text, base: Text): void {
  let docTo = -1
  let baseTo = -1
  for (const m of ms) {
    expect(m.doc.from).toBeGreaterThanOrEqual(0)
    expect(m.doc.from).toBeLessThanOrEqual(m.doc.to)
    expect(m.doc.to).toBeLessThanOrEqual(doc.length)
    expect(m.base.from).toBeLessThanOrEqual(m.base.to)
    expect(m.base.to).toBeLessThanOrEqual(base.length)
    expect(m.doc.from).toBeGreaterThanOrEqual(docTo)
    expect(m.base.from).toBeGreaterThanOrEqual(baseTo)
    docTo = m.doc.to
    baseTo = m.base.to
  }
}

// ── the oracle: a line-level three-way merge ──────────────────────────────────────────────────────────

interface Hunk {
  /** `base` lines `[a, b)` become `lines`. */
  a: number
  b: number
  lines: readonly string[]
}

/** The line changes from `base` to `to`, by the same two-way diff as the viewer's (so both align repeated lines alike). */
function hunksOf(base: readonly string[], to: readonly string[]): Hunk[] {
  const t = Text.of([...base])
  const r = reloadChanges(t, to)
  if (!r) return []
  const out: Hunk[] = []
  let shift = 0
  for (const c of r.changes) {
    const count = t.replace(c.from, c.to, c.insert).lines - t.lines + (c.toLine - c.fromLine)
    const at = c.fromLine + shift
    out.push({ a: c.fromLine, b: c.toLine, lines: to.slice(at, at + count) })
    shift += count - (c.toLine - c.fromLine)
  }
  expect(applyHunks(base, 0, base.length, out)).toEqual(to)
  return out
}

function applyHunks(base: readonly string[], a: number, b: number, hunks: readonly Hunk[]): string[] {
  const out: string[] = []
  let k = a
  for (const h of hunks) {
    out.push(...base.slice(k, h.a), ...h.lines)
    k = h.b
  }
  out.push(...base.slice(k, b))
  return out
}

interface Chunk {
  a: number
  b: number
  mine: Hunk[]
  theirs: Hunk[]
}

/**
 * The merge by chunks: hunks of either side that overlap or touch adjacent lines are one chunk, and a chunk that ends
 * the text takes in the chunk before it when one unchanged empty line lies between them (their characters meet there).
 * `merged`: the disk's chunks applied, the user's kept where both differ. `files(max)`: Use the File's on every mark,
 * the conflicts past `max` joined into the last mark kept (every chunk inside that mark takes the disk's lines).
 */
function oracle(base: readonly string[], mine: readonly string[], theirs: readonly string[]) {
  const n = base.length
  const all = [...hunksOf(base, mine).map((h) => ({ h, mine: true })), ...hunksOf(base, theirs).map((h) => ({ h, mine: false }))].sort((x, y) => x.h.a - y.h.a || x.h.b - y.h.b)
  const chunks: Chunk[] = []
  for (const { h, mine: m } of all) {
    const last = chunks.at(-1)
    if (last && h.a <= last.b) {
      last.b = Math.max(last.b, h.b)
      ;(m ? last.mine : last.theirs).push(h)
    } else chunks.push({ a: h.a, b: h.b, mine: m ? [h] : [], theirs: m ? [] : [h] })
  }
  for (;;) {
    const last = chunks.at(-1)
    const prev = chunks.at(-2)
    if (!last || !prev || last.b !== n || prev.b !== last.a - 1 || base[last.a - 1] !== '') break
    chunks.splice(-2, 2, { a: prev.a, b: n, mine: [...prev.mine, ...last.mine], theirs: [...prev.theirs, ...last.theirs] })
  }
  const order = (hs: Hunk[]) => [...hs].sort((x, y) => x.a - y.a || x.b - y.b)
  const kinds = chunks.map((c) => {
    const m = applyHunks(base, c.a, c.b, order(c.mine))
    const t = applyHunks(base, c.a, c.b, order(c.theirs))
    // as lists: no lines and one empty line are different texts
    const kind = c.mine.length === 0 ? 'theirs' : c.theirs.length === 0 ? 'mine' : JSON.stringify(m) === JSON.stringify(t) ? 'same' : 'conflict'
    return { m, t, kind }
  })
  const conflicts = kinds.flatMap((k, i) => (k.kind === 'conflict' ? [i] : []))
  const build = (disk: (i: number) => boolean) => {
    const out: string[] = []
    let k = 0
    chunks.forEach((c, i) => {
      out.push(...base.slice(k, c.a), ...(disk(i) ? kinds[i]!.t : kinds[i]!.m))
      k = c.b
    })
    out.push(...base.slice(k))
    return out
  }
  return {
    conflicts: conflicts.length,
    merged: build((i) => kinds[i]!.kind === 'theirs'),
    files: (max: number) => {
      const joinFrom = conflicts.length > max ? (conflicts[max - 1] as number) : Infinity
      const joinTo = conflicts.at(-1) ?? -1
      return build((i) => kinds[i]!.kind !== 'mine' || (i >= joinFrom && i <= joinTo))
    },
  }
}

// ── random texts and edits ───────────────────────────────────────────────────────────────────────

const baseArb = fc.tuple(fc.array(fc.constantFrom('', 'a', 'b', 'x'), { minLength: 1, maxLength: 6 }), fc.boolean()).map(([ls, newline]) => {
  if (newline) return [...ls.slice(0, 5), '']
  return ls.at(-1) === '' ? [...ls.slice(0, -1), 'z'] : ls
})

const editsArb = (own: string) =>
  fc.array(fc.record({ kind: fc.constantFrom('insert', 'delete', 'replace'), at: fc.nat(), count: fc.integer({ min: 1, max: 2 }), lines: fc.array(fc.constantFrom('', 'a', 'x', own), { minLength: 1, maxLength: 2 }) }), { minLength: 1, maxLength: 3 })

/** Each side's edits: made apart, or at the same lines with each side's own text (more places both changed). */
const sidesArb = fc.oneof(
  fc.tuple(editsArb('m'), editsArb('t')),
  editsArb('m').chain((mine) => fc.tuple(fc.constant(mine), fc.tuple(...mine.map((e) => fc.array(fc.constantFrom('', 'a', 't'), { minLength: 1, maxLength: 2 }).map((lines) => ({ ...e, lines })))))),
)

function edited(base: readonly string[], edits: readonly { kind: string; at: number; count: number; lines: string[] }[]): string[] {
  const out = [...base]
  for (const e of edits) {
    const at = e.at % (out.length + 1)
    if (e.kind === 'insert') out.splice(at, 0, ...e.lines)
    else if (e.kind === 'delete') out.splice(Math.min(at, out.length - 1), e.count)
    else out.splice(Math.min(at, out.length - 1), e.count, ...e.lines)
  }
  return out.length === 0 ? [''] : out
}

describe('the merge of an agent’s writes into unsaved text', () => {
  it('U-FV-22 · randomised against a line-level three-way merge: it never throws, marks never overlap, an agree place applies nothing, Use the File’s gives the disk’s text plus the user’s own places (a character typed after the merge included), a merge with no conflict keeps both sides’ changes', () => {
    let runs = 0
    let conflicted = 0
    let joined = 0
    fc.assert(
      fc.property(baseArb, sidesArb, fc.constantFrom(L.viewerMarksMax, 2, 1), fc.nat(), (base, [mineEdits, theirsEdits], max, typeAt) => {
        runs++
        const mine = edited(base, mineEdits)
        const theirs = edited(base, theirsEdits)
        const o = oracle(base, mine, theirs)
        const d = new Doc(base)
        d.edit(mine)
        const r = d.disk(theirs, max)
        // the disk's places applied, the user's text kept where both changed it differently
        expect(d.text).toBe(o.merged.join('\n'))
        expect(r.marks).toHaveLength(Math.min(o.conflicts, max))
        if (o.conflicts > 0) conflicted++
        if (o.conflicts > max) joined++
        expectSound(d.marks, d.state.doc, d.base)
        // nothing is applied where the document had the disk's text already, and history is cleared exactly then
        for (const e of r.agreed) expect(r.changes?.touchesRange(e.from, e.to) ?? false).toBe(false)
        if (mine.join('\n') !== base.join('\n')) expect(undoDepth(d.state) === 0).toBe(r.agreed.length > 0)

        const at = typeAt % (d.state.doc.length + 1)
        const inside = d.marks.some((m) => m.doc.from < at && at < m.doc.to)
        d.type(at, at, '§')
        expectSound(d.marks, d.state.doc, d.base)
        const typed = d.text
        const before = d.marks
        expect(useTheFiles(d, d.base)).toBe(before.length > 0)
        expect(d.text.replace('§', '')).toBe(o.files(max).join('\n'))
        expect(d.text.includes('§')).toBe(!inside)
        expect(d.marks).toEqual([])
        // its undo puts the user's text and the marks back
        if (before.length === 0) return
        undo(d)
        expect(d.text).toBe(typed)
        expect(d.marks).toEqual(before)
      }),
      { seed: 20261101, numRuns: 4000 },
    )
    expect(runs).toBe(4000)
    // the runs reach what they are meant to
    expect(conflicted).toBeGreaterThan(1000)
    expect(joined).toBeGreaterThan(30)
  })

  it('U-FV-22 · randomised, a second agent write over marks and the user’s typing: it never throws, marks never overlap, Use the File’s leaves none; when the agent writes the user’s text, every mark goes and nothing changes', () => {
    fc.assert(
      fc.property(baseArb, sidesArb, editsArb('u'), fc.boolean(), fc.nat(), (base, [mineEdits, theirsEdits], againEdits, same, typeAt) => {
        const d = new Doc(base)
        d.edit(edited(base, mineEdits))
        const theirs = edited(base, theirsEdits)
        d.disk(theirs, 2)
        d.type(typeAt % (d.state.doc.length + 1), typeAt % (d.state.doc.length + 1), 'q\n')
        const text = d.text
        const again = d.disk(same ? text.split('\n') : edited(theirs, againEdits), 2)
        expectSound(again.marks, d.state.doc, d.base)
        expectSound(d.marks, d.state.doc, d.base)
        if (same && text !== theirs.join('\n')) expect([again.changes, again.marks, d.text]).toEqual([null, [], text])
        useTheFiles(d, d.base)
        expect(d.marks).toEqual([])
      }),
      { seed: 20261102, numRuns: 3000 },
    )
  })

  it('U-FV-22 · repeated empty lines lined up otherwise by a later merge: marks stay apart and Use the File’s gives the file’s text; when the agent writes the user’s text every mark goes', () => {
    const d = new Doc(['', '', 'a', 'z'])
    d.edit(['', 'a', '', '', '', 'a', 'z'])
    d.disk(['x', '', 'a', 'z'], 2)
    d.type(7, 7, 'q\n')
    const r = d.disk(['x', '', 'a', '', 'z'], 2)
    expect(r.marks).toHaveLength(2)
    expectSound(d.marks, d.state.doc, d.base)
    useTheFiles(d, d.base)
    expect(d.text).toBe('x\n\na\n\nz')

    const e = new Doc(['x', 'x', '', 'x', '', 'z'])
    e.edit(['', '', 'x', 'x', '', 'z', 'a'])
    e.disk(['', '', 'x', 'x', '', 'z'], 2)
    expect(e.marks).toHaveLength(2)
    e.type(0, 0, 'q\n')
    const text = e.text
    const again = e.disk(text.split('\n'), 2)
    expect([again.changes, again.marks, e.marks, e.text]).toEqual([null, [], [], text])
  })

  it('U-FV-22 · places as unions: theirs-only applied, mine-only kept, identical places not applied twice, different ones marked; two theirs hunks inside one mine hunk are one place', () => {
    const base = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', '']
    const d = new Doc(base)
    d.edit(['l1', 'P2', 'l3', 'l4', 'l5', 'l6', 'l7', 'same', 'l8', 'P9', 'l10', ''])
    const r = d.disk(['l1', 'l2', 'l3', 'l4', 'T5', 'l6', 'l7', 'same', 'l8', 'l9', 'T10', ''])
    // the user's line 2 kept, the agent's line 5 in, the line both added once, lines 9 and 10 (adjacent) one marked place
    expect(d.text).toBe('l1\nP2\nl3\nl4\nT5\nl6\nl7\nsame\nl8\nP9\nl10\n')
    expect(r.marks).toHaveLength(1)
    expect(d.state.doc.sliceString(d.marks[0]!.doc.from, d.marks[0]!.doc.to)).toBe('P9\nl10\n')
    expect(d.fileTexts()).toEqual(['l9\nT10\n'])
    expect(r.agreed).toHaveLength(1)
    useTheFiles(d, d.base)
    expect(d.text).toBe('l1\nP2\nl3\nl4\nT5\nl6\nl7\nsame\nl8\nl9\nT10\n')

    const two = new Doc(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    two.edit(['a', 'X', 'Y', 'Z', 'g'])
    const r2 = two.disk(['a', 'b', 'C', 'd', 'E', 'f', 'g'])
    expect(r2.changes).toBeNull()
    expect(r2.marks).toHaveLength(1)
    expect(two.text).toBe('a\nX\nY\nZ\ng')
    expect(two.fileTexts()).toEqual(['b\nC\nd\nE\nf\n'])
    useTheFiles(two, two.base)
    expect(two.text).toBe('a\nb\nC\nd\nE\nf\ng')
  })

  it('U-FV-22 · a mark’s file text after the user edits next to it and at its start; text typed at its edges stays outside it', () => {
    const d = new Doc(['a', 'b', 'c', 'd', ''])
    d.edit(['a', 'b', 'P', 'd', ''])
    d.disk(['a', 'b', 'T', 'd', ''])
    const m = d.marks[0]!
    expect(d.state.doc.sliceString(m.doc.from, m.doc.to)).toBe('P\n')
    // next to it (the end of the line before), at its start, and at its end (the start of the line after)
    d.type(m.doc.from - 1, m.doc.from - 1, 'z')
    const at = d.marks[0]!.doc.from
    d.type(at, at, 'q')
    d.type(d.marks[0]!.doc.to, d.marks[0]!.doc.to, 'w')
    const k = d.marks[0]!
    expect(d.state.doc.sliceString(k.doc.from, k.doc.to)).toBe('P\n')
    // inside it, over its first character
    d.type(k.doc.from, k.doc.from + 1, 'R')
    expect(d.state.doc.sliceString(d.marks[0]!.doc.from, d.marks[0]!.doc.to)).toBe('R\n')
    expect(d.fileTexts()).toEqual(['T\n'])
    useTheFiles(d, d.base)
    expect(d.text).toBe('a\nbz\nqT\nwd\n')
  })

  it('U-FV-22 · a second agent write at a marked place takes the newest text; a mark goes when the disk agrees or the user typed the file’s text back', () => {
    const d = new Doc(['a', 'b', 'c', ''])
    d.edit(['a', 'P', 'c', ''])
    d.disk(['a', 'T1', 'c', ''])
    expect(d.fileTexts()).toEqual(['T1\n'])
    const again = d.disk(['a', 'T2', 'c', ''])
    expect(again.marks).toHaveLength(1)
    expect(d.fileTexts()).toEqual(['T2\n'])
    expect(d.text).toBe('a\nP\nc\n')
    useTheFiles(d, d.base)
    expect(d.text).toBe('a\nT2\nc\n')

    // the agent writes the user's text: the mark goes, nothing is applied
    const agree = new Doc(['a', 'b', 'c', ''])
    agree.edit(['a', 'P', 'c', ''])
    agree.disk(['a', 'T', 'c', ''])
    const r = agree.disk(['a', 'P', 'c', ''])
    expect([r.changes, r.marks, agree.marks]).toEqual([null, [], []])
    expect(r.agreed).toHaveLength(1)
    expect(agree.text).toBe('a\nP\nc\n')

    // the user types the file's text over their own, then the agent writes elsewhere: the mark goes, the agent's line comes in
    const back = new Doc(['a', 'b', 'c', 'd', 'e', ''])
    back.edit(['a', 'P', 'c', 'd', 'e', ''])
    back.disk(['a', 'T', 'c', 'd', 'e', ''])
    back.edit(['a', 'T', 'c', 'd', 'e', ''])
    expect(back.marks).toHaveLength(1)
    const r2 = back.disk(['a', 'T', 'c', 'd', 'E', ''])
    expect(r2.marks).toEqual([])
    expect(back.text).toBe('a\nT\nc\nd\nE\n')
  })

  it('U-FV-22 · Use the File’s undone restores the marks and redone takes them again; Keep Yours is no undo step', () => {
    const d = new Doc(['a', 'b', 'c', 'd', 'e', ''])
    d.edit(['a', 'P', 'c', 'Q', 'e', ''])
    d.disk(['a', 'T', 'c', 'U', 'e', ''])
    const marked = d.marks
    expect(marked).toHaveLength(2)
    const text = d.text
    expect(useTheFiles(d, d.base)).toBe(true)
    expect(d.text).toBe('a\nT\nc\nU\ne\n')
    expect(d.marks).toEqual([])
    expect(undo(d)).toBe(true)
    expect(d.text).toBe(text)
    expect(d.marks).toEqual(marked)
    expect(redo(d)).toBe(true)
    expect(d.text).toBe('a\nT\nc\nU\ne\n')
    expect(d.marks).toEqual([])
    expect(undo(d)).toBe(true)
    expect(d.marks).toEqual(marked)
    // Keep Yours: the marks go, and undo next takes out the user's own edit, not the marks' going
    const depth = undoDepth(d.state)
    expect(keepYours(d)).toBe(true)
    expect([d.marks, d.text, undoDepth(d.state)]).toEqual([[], text, depth])
    expect(keepYours(d)).toBe(false)
    undo(d)
    expect(d.marks).toEqual([])
    expect(d.text).not.toBe(text)
    // Use the File's after the file was merged again since the marks came back: their file text is the newest base's
    const later = new Doc(['a', 'b', 'c', 'd', ''])
    later.edit(['a', 'P', 'c', 'd', ''])
    later.disk(['a', 'T', 'c', 'd', ''])
    useTheFiles(later, later.base)
    later.disk(['new', 'a', 'T', 'c', 'd', ''])
    expect(later.text).toBe('new\na\nT\nc\nd\n')
    undo(later)
    expect(later.text).toBe('new\na\nP\nc\nd\n')
    expect(later.fileTexts()).toEqual(['T\n'])
    useTheFiles(later, later.base)
    expect(later.text).toBe('new\na\nT\nc\nd\n')
  })

  it('U-FV-22 · Use the File’s, then the agent writes text of another length away from the marks, then ⌘Z: the marks come back over the user’s text, and a later merge and Use the File’s give the file’s text, twice over', () => {
    const d = new Doc(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', ''])
    d.edit(['a', 'PPPPPPPPPP', 'c', 'd', 'e', 'QQQQQQQQQQ', 'g', 'h', ''])
    d.disk(['a', 'T', 'c', 'd', 'e', 'U', 'g', 'h', ''])
    expect(d.markedTexts()).toEqual(['PPPPPPPPPP\n', 'QQQQQQQQQQ\n'])
    useTheFiles(d, d.base)
    expect(d.text).toBe('a\nT\nc\nd\ne\nU\ng\nh\n')
    // a longer last line: after both places, so it moves nothing the undo puts back
    d.disk(['a', 'T', 'c', 'd', 'e', 'U', 'g', 'HH', ''])
    expect(d.text).toBe('a\nT\nc\nd\ne\nU\ng\nHH\n')
    expect(undo(d)).toBe(true)
    expect(d.text).toBe('a\nPPPPPPPPPP\nc\nd\ne\nQQQQQQQQQQ\ng\nHH\n')
    expect(d.markedTexts()).toEqual(['PPPPPPPPPP\n', 'QQQQQQQQQQ\n'])
    expect(d.fileTexts()).toEqual(['T\n', 'U\n'])
    // redone, then undone across another change from disk of another length
    expect(redo(d)).toBe(true)
    expect([d.text, d.marks]).toEqual(['a\nT\nc\nd\ne\nU\ng\nHH\n', []])
    d.disk(['a', 'T', 'c', 'd', 'e', 'U', 'g', 'HHHH', ''])
    expect(undo(d)).toBe(true)
    expect(d.text).toBe('a\nPPPPPPPPPP\nc\nd\ne\nQQQQQQQQQQ\ng\nHHHH\n')
    expect(d.markedTexts()).toEqual(['PPPPPPPPPP\n', 'QQQQQQQQQQ\n'])
    // the agent writes above and between the marks: merged in, the marks kept over the user's text
    d.disk(['new', 'a', 'T', 'c', 'DDDD', 'e', 'U', 'g', 'HHHH', ''])
    expect(d.text).toBe('new\na\nPPPPPPPPPP\nc\nDDDD\ne\nQQQQQQQQQQ\ng\nHHHH\n')
    expect(d.markedTexts()).toEqual(['PPPPPPPPPP\n', 'QQQQQQQQQQ\n'])
    expect(useTheFiles(d, d.base)).toBe(true)
    expect(d.text).toBe('new\na\nT\nc\nDDDD\ne\nU\ng\nHHHH\n')
    // the second round: a shorter line from disk between Use the File's and its undo
    d.disk(['new', 'a', 'T', 'c', 'DDDD', 'e', 'U', 'g', 'H', ''])
    expect(undo(d)).toBe(true)
    expect(d.text).toBe('new\na\nPPPPPPPPPP\nc\nDDDD\ne\nQQQQQQQQQQ\ng\nH\n')
    expect(d.markedTexts()).toEqual(['PPPPPPPPPP\n', 'QQQQQQQQQQ\n'])
    expect(d.fileTexts()).toEqual(['T\n', 'U\n'])
    expectSound(d.marks, d.state.doc, d.base)
    useTheFiles(d, d.base)
    expect(d.text).toBe('new\na\nT\nc\nDDDD\ne\nU\ng\nH\n')

    // lines after the one the agent writes: nothing out of range, and the marks over the user's lines rather than
    // shifted onto the lines after them
    const tail = new Doc(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'tail line one', 'tail line two', ''])
    tail.edit(['a', 'PPPPPPPPPP', 'c', 'd', 'e', 'QQQQQQQQQQ', 'g', 'h', 'tail line one', 'tail line two', ''])
    tail.disk(['a', 'T', 'c', 'd', 'e', 'U', 'g', 'h', 'tail line one', 'tail line two', ''])
    useTheFiles(tail, tail.base)
    tail.disk(['a', 'T', 'c', 'd', 'e', 'U', 'g', 'HH', 'tail line one', 'tail line two', ''])
    expect(undo(tail)).toBe(true)
    expect(tail.markedTexts()).toEqual(['PPPPPPPPPP\n', 'QQQQQQQQQQ\n'])
    useTheFiles(tail, tail.base)
    expect(tail.text).toBe('a\nT\nc\nd\ne\nU\ng\nHH\ntail line one\ntail line two\n')
  })

  it('U-FV-22 · an agent write after Use the File’s marks another place the user edited: ⌘Z puts the earlier marks back beside it and a redo takes back only those; a place put back that the agent writes again stays marked through a redo, with the newest text', () => {
    const d = new Doc(['a', 'b', 'c', 'd', 'e', ''])
    d.edit(['a', 'P', 'c', 'Q', 'e', ''])
    d.disk(['a', 'T', 'c', 'd', 'e', ''])
    expect(d.markedTexts()).toEqual(['P\n'])
    useTheFiles(d, d.base)
    // only marked, nothing applied: the history stays
    d.disk(['a', 'T', 'c', 'U', 'e', ''])
    expect(d.markedTexts()).toEqual(['Q\n'])
    expect(undo(d)).toBe(true)
    expect(d.text).toBe('a\nP\nc\nQ\ne\n')
    expect(d.markedTexts()).toEqual(['P\n', 'Q\n'])
    expect(d.fileTexts()).toEqual(['T\n', 'U\n'])
    expect(redo(d)).toBe(true)
    expect([d.text, d.markedTexts()]).toEqual(['a\nT\nc\nQ\ne\n', ['Q\n']])
    expect(undo(d)).toBe(true)
    expect(d.markedTexts()).toEqual(['P\n', 'Q\n'])
    useTheFiles(d, d.base)
    expect([d.text, d.marks]).toEqual(['a\nT\nc\nU\ne\n', []])

    const e = new Doc(['a', 'b', 'c', ''])
    e.edit(['a', 'P', 'c', ''])
    e.disk(['a', 'T', 'c', ''])
    useTheFiles(e, e.base)
    expect(undo(e)).toBe(true)
    e.disk(['a', 'T2', 'c', ''])
    expect(e.fileTexts()).toEqual(['T2\n'])
    // the redo gives the place the text Use the File's took, which the file no longer has
    expect(redo(e)).toBe(true)
    expect([e.text, e.markedTexts(), e.fileTexts()]).toEqual(['a\nT\nc\n', ['T\n'], ['T2\n']])
    useTheFiles(e, e.base)
    expect(e.text).toBe('a\nT2\nc\n')
  })

  it('U-FV-22 · randomised, Use the File’s, an agent write, then ⌘Z (and a redo and ⌘Z across another write): it never throws, the marks come back over the user’s text as it was beside those the agent write marked, and Use the File’s then gives what it gave before the undo', () => {
    let undone = 0
    let beside = 0
    let redone = 0
    fc.assert(
      fc.property(baseArb, sidesArb, editsArb('w'), editsArb('v'), fc.boolean(), (base, [mineEdits, theirsEdits], againEdits, thirdEdits, again) => {
        const d = new Doc(base)
        d.edit(edited(base, mineEdits))
        const theirs = edited(base, theirsEdits)
        d.disk(theirs, 2)
        if (d.marks.length === 0) return
        const kept = d.markedTexts()
        useTheFiles(d, d.base)
        d.disk(edited(theirs, againEdits), 2)
        expectSound(d.marks, d.state.doc, d.base)
        const since = d.marks.length
        // what Use the File's gives now, on a copy
        const copy = { state: d.state, dispatch: (tr: Transaction) => void (copy.state = tr.state) }
        useTheFiles(copy, d.base)
        const files = copy.state.doc.toString()
        if (!undo(d)) return
        undone++
        expectSound(d.marks, d.state.doc, d.base)
        if (since === 0) expect(d.markedTexts()).toEqual(kept)
        else {
          // every place put back is marked, alone or inside a mark the agent write made
          beside++
          for (const text of kept) expect(d.markedTexts().some((t) => t.includes(text))).toBe(true)
        }
        if (!again) {
          useTheFiles(d, d.base)
          expect([d.text, d.marks]).toEqual([files, []])
          return
        }
        // redone across another write, then undone: in range and in order throughout
        d.disk(edited(d.base.toJSON(), thirdEdits), 2)
        expectSound(d.marks, d.state.doc, d.base)
        if (!redo(d)) return
        redone++
        expectSound(d.marks, d.state.doc, d.base)
        undo(d)
        expectSound(d.marks, d.state.doc, d.base)
        useTheFiles(d, d.base)
        expect(d.marks).toEqual([])
      }),
      { seed: 20261103, numRuns: 3000 },
    )
    expect(undone).toBeGreaterThan(300)
    expect(beside).toBeGreaterThan(50)
    expect(redone).toBeGreaterThan(100)
  })

  it('U-FV-22 · extents: the user edits a line the agent deletes, deletes a line the agent edits, both on the last line with and without a final newline, an insertion before a line the agent deletes — Use the File’s gives the file’s text each time', () => {
    const cases: [string, string, string][] = [
      ['a\nb\nc\n', 'a\nP\nc\n', 'a\nc\n'],
      ['a\nb\nc\n', 'a\nc\n', 'a\nT\nc\n'],
      ['a\nb\n', 'a\nP\n', 'a\nT\n'],
      ['a\nb', 'a\nP', 'a\nT'],
      ['a\nb', 'a\nP', 'a'],
      ['a\nb', 'a', 'a\nT'],
      ['a\nb\n', 'a\nP\n', 'a\n'],
      ['a\nb\nc\n', 'a\nN\nb\nc\n', 'a\nc\n'],
      ['a\nb\nc', 'a\nb\nN\nc', 'a\nb'],
      ['only', 'mine', 'theirs'],
      ['', 'mine', 'theirs'],
      ['', 'mine\n', '\ntheirs'],
    ]
    for (const [base, mine, disk] of cases) {
      const d = new Doc(linesOf(base))
      d.edit(linesOf(mine))
      const r = d.disk(linesOf(disk))
      const name = JSON.stringify([base, mine, disk])
      expect(r.marks.length, name).toBe(1)
      expect(d.text, name).toBe(mine)
      useTheFiles(d, d.base)
      expect(d.text, name).toBe(disk)
    }
  })

  it('U-FV-22 · a point mark typed at stays a point and Use the File’s works; a point mark next to an applied insertion stays on its side', () => {
    const d = new Doc(linesOf('a\nb\nc\n'))
    d.edit(linesOf('a\nc\n'))
    d.disk(linesOf('a\nT\nc\n'))
    const p = d.marks[0]!
    expect(p.doc.from).toBe(p.doc.to)
    d.type(p.doc.from, p.doc.from, 'q')
    expect(d.marks[0]!.doc).toEqual({ from: p.doc.from, to: p.doc.from })
    // the text before it deleted up to it: still a point, never inverted
    d.type(p.doc.from - 1, p.doc.from, '')
    expect(d.marks[0]!.doc.from).toBe(d.marks[0]!.doc.to)
    useTheFiles(d, d.base)
    expect(d.text).toBe('aT\nqc\n')

    const side = new Doc(linesOf('a\nb\n\nc\n'))
    side.edit(linesOf('a\n\nc\n'))
    side.disk(linesOf('a\nT\n\nX\nc\n'))
    expect(side.text).toBe('a\n\nX\nc\n')
    expect(side.marks[0]!.doc).toEqual({ from: 2, to: 2 })
    useTheFiles(side, side.base)
    expect(side.text).toBe('a\nT\n\nX\nc\n')
  })

  it('U-FV-22 · an empty base line between an insertion place and a place ending the text: one place, Use the File’s gives the file’s text, the user’s unrelated line kept, the same change on both sides agrees', () => {
    const base = ['u', 'v', 'a', '', 'c']
    const d = new Doc(base)
    d.edit(['U', 'v', 'a', '', 'P'])
    const r = d.disk(['u', 'v', 'a', 'X', '', 'c'])
    expect(r.marks).toHaveLength(1)
    expectSound(d.marks, d.state.doc, d.base)
    expect(d.text).toBe('U\nv\na\n\nP')
    useTheFiles(d, d.base)
    expect(d.text).toBe('U\nv\na\nX\n\nc')

    const same = new Doc(base)
    same.edit(['u', 'v', 'a', 'X', '', 'P'])
    const r2 = same.disk(['u', 'v', 'a', 'X', '', 'P'])
    expect([r2.changes, r2.marks]).toEqual([null, []])
    expect(r2.agreed).toHaveLength(1)
    expect(same.text).toBe('u\nv\na\nX\n\nP')
  })

  it('U-FV-22 · an insertion before a final empty line and one at the end are one place: a blank line and a paragraph appended by the user while the agent appends a line is a conflict', () => {
    const d = new Doc(['b', ''])
    d.edit(['b', '', 'yy', ''])
    const r = d.disk(['b', 'zz', ''])
    expect(r.changes).toBeNull()
    expect(r.marks).toHaveLength(1)
    expect(d.text).toBe('b\n\nyy\n')
    useTheFiles(d, d.base)
    expect(d.text).toBe('b\nzz\n')
  })

  it('U-FV-22 · more conflicting places than L.viewerMarksMax: the rest join the last mark, and Use the File’s still gives the file’s text', () => {
    const n = L.viewerMarksMax + 3
    const base = Array.from({ length: n * 2 }, (_, i) => `line ${i}`)
    const mine = base.map((l, i) => (i % 2 === 0 ? `mine ${i}` : l))
    const theirs = base.map((l, i) => (i % 2 === 0 ? `theirs ${i}` : l))
    const d = new Doc(base)
    d.edit(mine)
    const r = d.disk(theirs)
    expect(r.marks).toHaveLength(L.viewerMarksMax)
    expectSound(d.marks, d.state.doc, d.base)
    const last = d.marks.at(-1)!
    // from the first conflict it joins to the end of the last, the lines between included
    expect(d.state.doc.sliceString(last.doc.from, last.doc.to)).toBe(`${mine.slice((L.viewerMarksMax - 1) * 2, n * 2 - 1).join('\n')}\n`)
    useTheFiles(d, d.base)
    expect(d.text).toBe(theirs.join('\n'))
  })

  it('U-FV-22 · lines equal to base with another ending or byte order mark: no text changes, the marks stay, and the caller takes the disk’s version and ending', () => {
    const d = new Doc(['a', 'b', 'c', ''])
    d.edit(['a', 'P', 'c', ''])
    d.disk(['a', 'T', 'c', ''])
    const kept = d.marks
    const r = merge({ base: d.base, doc: d.state.doc, disk: Text.of(['a', 'T', 'c', '']), marks: kept })
    expect(r).toEqual({ same: true, changes: null, marks: kept, agreed: [] })
    expect(merge({ base: d.base, doc: d.state.doc, disk: ['a', 'T', 'c', 'x'], marks: kept }).same).toBe(false)
  })
})
