// Syntax colours in the editor: the highlight worker's tokens drawn as mark decorations, for the lines on
// screen only. A document's `TokenStore` is given to its editor state through a facet; when the worker's chunks arrive
// the owner dispatches `tokensArrived`, and the decorations of the viewport are rebuilt. Lines the worker has not
// reached yet are plain text that colours in place.

import { Facet, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { STYLE_PLAIN, syntaxCss, tokenClass } from './syntax.ts'
import { tokenStart, tokenStyle, type TokenStore } from './tokens.ts'

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

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
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
      if (store && u.docChanged) {
        // the store follows the document: unchanged lines keep their tokens under their new numbers (tokens.ts `edit`)
        const edits: [number, number, number][] = []
        u.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
          const a = u.startState.doc
          edits.push([a.lineAt(fromA).number - 1, a.lineAt(toA).number, u.state.doc.lineAt(toB).number])
        })
        // last change first, so each one's line numbers are still the old document's
        for (const [from, oldTo, newTo] of edits.reverse()) store.edit(from, oldTo, newTo)
      }
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
