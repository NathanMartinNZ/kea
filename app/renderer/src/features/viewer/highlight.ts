// Syntax colours in the editor: the highlight worker's tokens drawn as mark decorations, for the lines on
// screen only. A document's `TokenStore` is given to its editor state through a facet; when the worker's chunks arrive
// the owner dispatches `tokensArrived`, and the decorations of the viewport are rebuilt. Lines the worker has not
// reached yet are plain text that colours in place. In a document the user can edit, the lines they edit keep their
// colours until fresh ones arrive (editTokens.ts asks for them).

import { Facet, RangeSetBuilder, StateEffect, type ChangeSet, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { STYLE_BITS, STYLE_PLAIN, syntaxCss, tokenClass } from './syntax.ts'
import { tokenStart, tokenStyle, type ShiftedLines, type TokenStore } from './tokens.ts'
import type { LineEdit } from './worker/protocol.ts'

/** The document's tokens (one store per document; null: none, plain text). */
export const tokenStore = Facet.define<TokenStore, TokenStore | null>({ combine: (v) => v[0] ?? null })

/** Tokens were added to the store: redraw the lines on screen. */
export const tokensArrived = StateEffect.define<null>()

const marks: (Decoration | undefined)[] = [] // bounded: one per style value (syntax.ts: at most 2^STYLE_BITS)
function mark(style: number): Decoration {
  return (marks[style] ??= Decoration.mark({ class: tokenClass(style) }))
}

/** The scroller moved sideways far enough for other columns to need their colours. */
const columnsMoved = StateEffect.define<null>()

/** The columns of a long line that get colours: what is on screen and one view's width on either side. */
interface Columns {
  from: number
  to: number
}

/**
 * A line far wider than the view (a minified bundle's) has thousands of tokens, and every one drawn is an element:
 * only the tokens near the columns on screen are drawn, and the rest follow as the view scrolls sideways. Columns are
 * counted in characters, which is exact for the text such lines hold; tabs and wide characters only make the margin
 * smaller. With word wrap on, the whole line is on screen and nothing is left out.
 */
function columnsOf(view: EditorView, left: number, width: number): Columns | null {
  const cw = view.defaultCharacterWidth
  if (view.lineWrapping || !(cw > 0) || !(width > 0)) return null
  return { from: Math.max(0, Math.floor((left - width) / cw)), to: Math.ceil((left + 2 * width) / cw) }
}

function build(view: EditorView, cols: Columns | null): { set: DecorationSet; clipped: boolean } {
  const store = view.state.facet(tokenStore)
  if (!store) return { set: Decoration.none, clipped: false }
  const doc = view.state.doc
  const b = new RangeSetBuilder<Decoration>()
  let clipped = false
  let done = 0 // the last line already drawn (two visible ranges can share a line)
  for (const { from, to } of view.visibleRanges) {
    let line = doc.lineAt(from)
    for (;;) {
      if (line.number > done) {
        done = line.number
        const t = store.line(line.number - 1)
        if (t) {
          const first = cols && line.length > cols.to ? cols.from : 0
          const last = cols && line.length > cols.to ? cols.to : line.length
          if (last < line.length) clipped = true
          for (let i = t.from; i < t.to; i++) {
            const v = t.data[i] as number
            const start = tokenStart(v)
            // tokens kept across an edit can be longer than the line they now sit on, until fresh ones arrive
            if (start >= last) break
            const style = tokenStyle(v)
            if (style === STYLE_PLAIN) continue
            const end = i + 1 < t.to ? Math.min(tokenStart(t.data[i + 1] as number), line.length) : line.length
            if (end > start && end > first) b.add(line.from + start, line.from + end, mark(style))
          }
        }
      }
      if (line.to >= to || line.number >= doc.lines) break
      line = doc.line(line.number + 1)
    }
  }
  return { set: b.finish(), clipped }
}

/** Changes that share lines: old lines `[from, to)` became new lines `[newFrom, newTo)`; `at` holds each change's fromA, toA, fromB, toB. */
interface Group {
  from: number
  to: number
  newFrom: number
  newTo: number
  at: number[]
}

function groupsOf(changes: ChangeSet, a: Text, b: Text): Group[] {
  const out: Group[] = []
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const from = a.lineAt(fromA).number - 1
    const g = out.at(-1)
    // a change that starts on the line the one before it ends on (two cursors in one line) edits the same lines
    if (g && from < g.to) {
      g.to = Math.max(g.to, a.lineAt(toA).number)
      g.newTo = b.lineAt(toB).number
      g.at.push(fromA, toA, fromB, toB)
      return
    }
    out.push({ from, to: a.lineAt(toA).number, newFrom: b.lineAt(fromB).number - 1, newTo: b.lineAt(toB).number, at: [fromA, toA, fromB, toB] })
  })
  return out
}

const editsOf = (groups: readonly Group[]): LineEdit[] => groups.map((g) => ({ from: g.from, to: g.to, lines: g.newTo - g.newFrom }))

/** The line edits `changes` made, turning `a` into `b`: numbered in `a`, ascending and apart. */
export function lineEdits(changes: ChangeSet, a: Text, b: Text): LineEdit[] {
  return editsOf(groupsOf(changes, a, b))
}

/**
 * The store follows the document `changes` turned `a` into `b`: unchanged lines keep their tokens under their new
 * numbers (tokens.ts `follow`). With `keep`, the edited lines keep the colours of their unchanged text, moved to its new
 * columns; text put in takes the colour before it.
 */
export function followEdits(store: TokenStore, changes: ChangeSet, a: Text, b: Text, keep = false): void {
  const groups = groupsOf(changes, a, b)
  store.follow(editsOf(groups), keep ? shiftedLines(store, groups, a, b) : null)
}

/** The edited lines' kept colours, read from the store before it follows the edits. */
function shiftedLines(store: TokenStore, groups: readonly Group[], a: Text, b: Text): ShiftedLines | null {
  const lines: number[] = []
  const starts: number[] = []
  const data: number[] = []
  for (const g of groups) {
    // the unchanged text in the group's lines: [new line, new column, old line, old column, length], in order
    const pieces: number[] = []
    const k = g.at.length / 4
    const fromA = g.at[0] as number
    pieces.push(g.newFrom, 0, g.from, 0, fromA - a.line(g.from + 1).from)
    for (let i = 0; i + 1 < k; i++) {
      const toA = g.at[4 * i + 1] as number
      const toB = g.at[4 * i + 3] as number
      const oldLine = a.lineAt(toA)
      const newLine = b.lineAt(toB)
      pieces.push(newLine.number - 1, toB - newLine.from, oldLine.number - 1, toA - oldLine.from, (g.at[4 * i + 4] as number) - toA)
    }
    const toA = g.at[4 * k - 3] as number
    const toB = g.at[4 * k - 1] as number
    const oldLast = a.line(g.to)
    pieces.push(g.newTo - 1, toB - b.line(g.newTo).from, g.to - 1, toA - oldLast.from, oldLast.to - toA)
    let line = -1
    let last = -1
    for (let p = 0; p < pieces.length; p += 5) {
      const [newLine, newCol, oldLine, oldCol, len] = pieces.slice(p, p + 5) as [number, number, number, number, number]
      if (newLine !== line) {
        line = newLine
        last = -1
      }
      if (len <= 0) continue
      const t = store.line(oldLine)
      if (!t) {
        // text whose colours are not known yet stays plain, not the colour before it
        if (lines.at(-1) === newLine && last !== STYLE_PLAIN) data.push(((newCol << STYLE_BITS) | STYLE_PLAIN) >>> 0)
        last = STYLE_PLAIN
        continue
      }
      if (lines.at(-1) !== newLine) {
        lines.push(newLine)
        starts.push(data.length)
      }
      // the token that covers the piece's first column, then those that start inside it
      let i = t.from
      let style = STYLE_PLAIN
      while (i < t.to && tokenStart(t.data[i] as number) <= oldCol) style = tokenStyle(t.data[i++] as number)
      for (let col = newCol; ; ) {
        if (style !== last) data.push(((col << STYLE_BITS) | style) >>> 0)
        last = style
        if (i >= t.to) break
        const v = t.data[i++] as number
        if (tokenStart(v) >= oldCol + len) break
        col = tokenStart(v) - oldCol + newCol
        style = tokenStyle(v)
      }
    }
  }
  if (lines.length === 0) return null
  starts.push(data.length)
  return { lines, chunk: { from: 0, to: lines.length, starts: Uint32Array.from(starts), data: Uint32Array.from(data) } }
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    /** The store's lines when the decorations on screen were built. */
    lines = 0
    private drawn: number
    /** The scroller's horizontal position and width as last measured (never read during an update). */
    private left = 0
    private width = 0
    /** Some line on screen has tokens that were left out. */
    private clipped = false
    private measuring = false

    constructor(view: EditorView) {
      this.decorations = Decoration.none
      this.drawn = -1
      this.draw(view)
      this.measure(view)
    }

    private draw(view: EditorView): void {
      const r = build(view, columnsOf(view, this.left, this.width))
      this.decorations = r.set
      this.clipped = r.clipped
      this.drawn = view.state.facet(tokenStore)?.version ?? 0
      this.lines = view.state.facet(tokenStore)?.lines ?? 0
    }

    /** Read the scroller once the layout is done; redraw when other columns are on screen than the ones drawn for. */
    measure(view: EditorView): void {
      if (this.measuring) return
      this.measuring = true
      view.requestMeasure({
        key: this,
        read: () => ({ left: view.scrollDOM.scrollLeft, width: view.scrollDOM.clientWidth }),
        write: (m) => {
          this.measuring = false
          const moved = Math.abs(m.left - this.left) > m.width / 2 || m.width !== this.width
          if (!moved) return
          const had = this.width > 0
          this.left = m.left
          this.width = m.width
          // the first measurement only matters to a view that has a long line on screen; later ones, when one was clipped
          if (this.clipped || !had) queueMicrotask(() => view.dispatch({ effects: columnsMoved.of(null) }))
        },
      })
    }

    update(u: ViewUpdate): void {
      const store = u.state.facet(tokenStore)
      // in a document the user can edit, the lines they edit keep their colours until the worker's arrive
      if (store && u.docChanged) followEdits(store, u.changes, u.startState.doc, u.state.doc, !u.state.readOnly)
      const version = store?.version ?? 0
      // other columns came on screen, or the document was set up anew (word wrap switched: then nothing is left out)
      const moved = u.transactions.some((tr) => tr.reconfigured || tr.effects.some((e) => e.is(columnsMoved)))
      if (u.docChanged || u.viewportChanged || moved || version !== this.drawn || u.startState.facet(tokenStore) !== store) this.draw(u.view)
      if (u.geometryChanged) this.measure(u.view)
    }
  },
  {
    decorations: (v) => v.decorations,
    eventObservers: {
      scroll(_e, view) {
        view.plugin(plugin)?.measure(view)
      },
    },
  },
)

/** The extension: put `tokenStore.of(store)` beside it in the document's state. */
export function tokenHighlighting(): Extension {
  return plugin
}

let sheet: CSSStyleSheet | null = null

/** The token classes' stylesheet (from the generated theme), added to the document once. The Markdown preview's code fences use the same classes. */
export function installSyntaxStyles(doc: Document = document): void {
  if (sheet) return
  sheet = new CSSStyleSheet()
  sheet.replaceSync(syntaxCss())
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
}

/** The lines whose tokens the decorations on screen were built from: what is drawn, not only stored. Null without colours. */
export function drawnTokenLines(view: EditorView): number | null {
  return view.plugin(plugin)?.lines ?? null
}
