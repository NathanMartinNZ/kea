import { ChangeSet, EditorState, Text, type ChangeSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { followEdits } from './highlight.ts'
import { STYLE_BITS, STYLE_PLAIN } from './syntax.ts'
import { TokenStore, tokenStart, tokenStyle } from './tokens.ts'

/** A store whose every line has one token naming the line it was made for (its start column is the line's number). */
function storeOf(lines: number): TokenStore {
  const starts = new Uint32Array(lines + 1)
  const data = new Uint32Array(lines)
  for (let i = 0; i < lines; i++) {
    starts[i] = i
    data[i] = (i << STYLE_BITS) | 1
  }
  starts[lines] = lines
  const store = new TokenStore()
  store.put({ from: 0, to: lines, starts, data })
  return store
}

const madeFor = (store: TokenStore, line: number): number | null => {
  const t = store.line(line)
  return t ? tokenStart(t.data[t.from] as number) : null
}

describe('tokens follow the document', () => {
  it('U-FV-19 · a transaction with several changes of different line counts keeps every unchanged line’s tokens on its line', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    const state = EditorState.create({ doc: Text.of(lines) })
    const doc = state.doc
    // three lines put in before line 6 (0-based 5), line 101 (0-based 100) rewritten, line 151 (0-based 150) taken out
    const tr = state.update({
      changes: [
        { from: doc.line(6).from, insert: 'a\nb\nc\n' },
        { from: doc.line(101).from, to: doc.line(101).to, insert: 'rewritten' },
        { from: doc.line(151).from, to: doc.line(152).from },
      ],
    })
    const store = storeOf(200)
    followEdits(store, tr.changes, doc, tr.newDoc)
    const after = tr.newDoc
    expect(after.lines).toBe(202)
    for (let n = 0; n < after.lines; n++) {
      const text = after.line(n + 1).text
      const m = /^line (\d+)$/.exec(text)
      // a line the transaction did not touch has the tokens made for it; a touched one has none until fresh ones come
      // (lines 5 and 151 are touched at their start: the insertion and the end of the deletion)
      if (m && Number(m[1]) !== 5 && Number(m[1]) !== 151) expect(madeFor(store, n), `line ${n} (${text})`).toBe(Number(m[1]))
      else expect(madeFor(store, n), `line ${n} (${text})`).toBeNull()
    }
  })
})

/** A character's style in the tests below: its class, so every character's colour can be checked after an edit. */
const styleOf = (c: string): number => 1 + (c.charCodeAt(0) % 6)

/** A store of `doc` with one token per run of characters of the same style. */
function charStore(doc: Text): TokenStore {
  const starts: number[] = []
  const data: number[] = []
  for (let n = 1; n <= doc.lines; n++) {
    starts.push(data.length)
    const text = doc.line(n).text
    let last = -1
    for (let c = 0; c < text.length; c++) {
      const style = styleOf(text[c] as string)
      if (style !== last) data.push((c << STYLE_BITS) | style)
      last = style
    }
  }
  starts.push(data.length)
  const store = new TokenStore()
  store.put({ from: 0, to: doc.lines, starts: Uint32Array.from(starts), data: Uint32Array.from(data) })
  return store
}

/** The style drawn at column `col` of line `n`. */
function drawn(store: TokenStore, n: number, col: number): number {
  const t = store.line(n)
  let style = STYLE_PLAIN
  if (t) for (let i = t.from; i < t.to && tokenStart(t.data[i] as number) <= col; i++) style = tokenStyle(t.data[i] as number)
  return style
}

/** The text put in by the edits below: never in a document before, so what was not put in is the text that stayed. */
const PUT = '@'

describe('the lines the user edits', () => {
  it('U-FV-26 · keep the colours of their unchanged text at its new columns, text put in takes the colour before it, and they count as not tokenised until fresh tokens arrive', () => {
    // typing inside a word: the letter takes the word's colour, the rest of the line moves one column on
    const doc = Text.of(['const name = 1;', 'let other = 22;'])
    const store = charStore(doc)
    const tr = EditorState.create({ doc }).update({ changes: { from: 8, insert: PUT } })
    followEdits(store, tr.changes, doc, tr.newDoc, true)
    const line = tr.newDoc.line(1).text
    expect(line).toBe('const na@me = 1;')
    for (let c = 0; c < line.length; c++) expect(drawn(store, 0, c), `column ${c}`).toBe(styleOf(c === 8 ? 'a' : (line[c] as string)))
    // kept, but stale: not counted as tokenised until a chunk for the line replaces it
    expect(store.has(0)).toBe(true)
    expect(store.lines).toBe(1)
    store.put({ from: 0, to: 1, starts: Uint32Array.of(0, 1), data: Uint32Array.of(styleOf('c')) })
    expect(store.lines).toBe(2)
    // a read-only document's reload keeps nothing of the lines it replaces
    const plain = charStore(doc)
    followEdits(plain, tr.changes, doc, tr.newDoc)
    expect(plain.line(0)).toBeNull()
    expect(plain.lines).toBe(1)

    // random edits, several to a transaction (cursors on one line, lines split, joined, pasted, deleted): every
    // character that was not put in keeps its colour; a line with no colours has nothing but text put in
    let seed = 7
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return (seed >>> 8) % n
    }
    const alphabet = 'abc xyz 012 ;{}()"#'
    for (let round = 0; round < 300; round++) {
      const lines = Array.from({ length: 1 + rnd(8) }, () => Array.from({ length: rnd(14) }, () => alphabet[rnd(alphabet.length)]).join(''))
      const a = Text.of(lines)
      const store = charStore(a)
      const at = [...new Set(Array.from({ length: 1 + rnd(5) }, () => rnd(a.length + 1)))].sort((x, y) => x - y)
      const specs: ChangeSpec[] = []
      for (let i = 0; i < at.length; i++) {
        const from = at[i] as number
        const room = (i + 1 < at.length ? (at[i + 1] as number) : a.length) - from
        specs.push({ from, to: from + (rnd(3) === 0 ? rnd(room + 1) : 0), insert: [PUT, `${PUT}\n${PUT}`, '\n', '', `\n${PUT}\n\n`][rnd(5)] })
      }
      const changes = ChangeSet.of(specs, a.length)
      const b = changes.apply(a)
      followEdits(store, changes, a, b, true)
      // the lines a change touched are stale wherever they kept colours; every other line is counted
      const touched = new Set<number>()
      changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
        for (let n = b.lineAt(fromB).number; n <= b.lineAt(toB).number; n++) touched.add(n - 1)
      })
      expect(store.lines, `round ${round}`).toBe(b.lines - touched.size)
      for (let n = 0; n < b.lines; n++) {
        const text = b.line(n + 1).text
        const label = `round ${round}, line ${n} ${JSON.stringify(text)} of ${JSON.stringify(b.toString())} from ${JSON.stringify(a.toString())}`
        if (!store.has(n)) {
          expect(touched.has(n), label).toBe(true)
          expect(text.replaceAll(PUT, ''), label).toBe('')
          continue
        }
        for (let c = 0; c < text.length; c++) if (text[c] !== PUT) expect(drawn(store, n, c), `${label}, column ${c}`).toBe(styleOf(text[c] as string))
      }
    }
  })
})
