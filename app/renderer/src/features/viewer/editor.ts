// The window's editors: exactly one file-view `EditorView`, and one diff instance (`merge.ts`), reused for
// every tab and every session. They live here, in plain module state — never in rune state — and are put into
// whichever viewer mount exists, as terminal views are. A document is an `EditorState`: showing a tab is
// `view.setState(...)`, and an editor that is not on screen holds an empty document.

import { standardKeymap, deleteCharBackward, deleteCharForward, deleteGroupBackward, deleteGroupForward, deleteLineBoundaryBackward, deleteLineBoundaryForward, deleteToLineEnd, insertNewlineAndIndent, splitLine, transposeChars } from '@codemirror/commands'
import { bracketMatching } from '@codemirror/language'
import { closeSearchPanel } from '@codemirror/search'
import { Compartment, EditorState, Text, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type KeyBinding, type ViewUpdate } from '@codemirror/view'
import type { LineChanges, LineEnding } from '@kea/protocol'
import { bars, findBarOpen } from './bars.ts'
import { lineBreakOf } from './decode.ts'
import { folding } from './folding.ts'
import { changeGutter } from './gutter.ts'
import { indentGuides, indentUnitOf } from './guides.ts'
import { tokenHighlighting, tokenStore } from './highlight.ts'
import type { ViewPolicy } from './policy.ts'
import { readOnly } from './readonly.ts'
import type { TabPosition, TabViewState } from './tab.ts'
import type { TokenStore } from './tokens.ts'
import { positionAt, restoreFolds, selectionFor } from './viewState.ts'

/** What the document on screen tells its owner (the viewer's controller). */
export interface EditorHooks {
  update(u: ViewUpdate): void
  /** A scroll came to rest. */
  scrolled(): void
}

// ── keys ───────────────────────────────────────────────────────────────────────────────────────────

const EDITS = new Set<unknown>([insertNewlineAndIndent, deleteCharBackward, deleteCharForward, deleteGroupBackward, deleteGroupForward, deleteLineBoundaryBackward, deleteLineBoundaryForward, deleteToLineEnd, splitLine, transposeChars])

/**
 * The keyboard of a read-only document: CodeMirror's standard keys for moving and selecting (`⌘A` included), without
 * the ones that edit — so `↵` is left to the tab strip (it pins a preview). `Esc` closes the find bar when it is open,
 * and is otherwise the strip's too (it closes the tab).
 */
export const NAVIGATION_KEYS: readonly KeyBinding[] = [
  {
    key: 'Escape',
    run: (view) => {
      if (!findBarOpen(view.state)) return false
      closeSearchPanel(view)
      return true
    },
  },
  ...standardKeymap.filter((b) => !EDITS.has(b.run) && !EDITS.has(b.shift)),
]

// ── a document's state ─────────────────────────────────────────────────────────────────────────────

const wrapping = new Compartment()
let hooks: EditorHooks | null = null
/** One listener for every state: it speaks to whoever owns the document on screen. */
const listener = EditorView.updateListener.of((u) => hooks?.update(u))

/**
 * What every text document of the viewer has, file or diff. `label`: what the text is, said to assistive technology
 * (the document is a read-only text box, and a text box without a name is only "edit text").
 */
export function baseExtensions(o: { eol: LineEnding; store: TokenStore | null; guides: number | null; label: string }): Extension[] {
  return [
    readOnly(),
    EditorView.contentAttributes.of({ 'aria-label': o.label }),
    EditorState.lineSeparator.of(lineBreakOf(o.eol)),
    drawSelection(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    bracketMatching(),
    o.guides === null ? [] : indentGuides(o.guides),
    tokenHighlighting(),
    o.store ? tokenStore.of(o.store) : [],
    bars(),
    keymap.of(NAVIGATION_KEYS),
    listener,
  ]
}

export interface FileDoc {
  /** The file's path in its folder: the text's accessible name. */
  path: string
  lines: readonly string[]
  eol: LineEnding
  policy: ViewPolicy
  /** Null: plain text (no grammar, or a very large file shown plain, `policy.plain`). */
  store: TokenStore | null
  wrap: boolean
  /** The git gutter's lines as far as they are known. */
  changes: LineChanges | null
}

/** A file's document, with what its tab kept: the selection and the folds; the scroll is `restoreScroll`'s. */
export function fileState(d: FileDoc, kept: TabViewState, goto: TabPosition | null): EditorState {
  const doc = Text.of(d.lines as string[])
  const state = EditorState.create({
    doc,
    selection: goto ? { anchor: positionAt(doc, goto) } : selectionFor(doc, kept.selection),
    extensions: [
      // the gutters, left to right: change markers, line numbers, fold chevrons
      changeGutter(d.changes),
      lineNumbers(),
      d.policy.folding ? folding() : [],
      baseExtensions({ eol: d.eol, store: d.store, guides: d.policy.plain ? null : indentUnitOf(doc, EMPTY.tabSize), label: d.path }),
      wrapping.of(d.wrap && d.policy.wrap ? EditorView.lineWrapping : []),
    ],
  })
  if (!d.policy.folding || kept.folds.length === 0) return state
  return state.update({ effects: restoreFolds(state, kept) }).state
}

export function setWrap(view: EditorView, on: boolean): void {
  view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) })
}

// ── scroll (the first visible line and the pixels scrolled past its top) ──────────────────────────

/** The element that scrolls `view`: its own scroller, or the merge view's (side by side, both sides scroll as one). */
export type Scroller = HTMLElement

export function scrollOf(view: EditorView, scroller: Scroller = view.scrollDOM): NonNullable<TabViewState['scroll']> {
  // A measure still to come is taken first (reading a block's place takes it). Until then the editor's own numbers
  // are not this document's: a `scrollend` that arrives between a document put in and its first measure would be
  // read without the content's padding and before the scroll asked for, and the tab would keep that.
  view.lineBlockAtHeight(0)
  const top = Math.max(0, scroller.getBoundingClientRect().top - view.documentTop)
  const block = view.lineBlockAtHeight(top)
  return { line: view.state.doc.lineAt(block.from).number, offset: Math.max(0, Math.round(top - block.top)), left: Math.round(scroller.scrollLeft) }
}

/** Put a kept scroll position back: that line at the top, scrolled past by its offset. */
export function restoreScroll(view: EditorView, scroll: NonNullable<TabViewState['scroll']>, scroller: Scroller = view.scrollDOM): void {
  const doc = view.state.doc
  const line = doc.line(Math.min(Math.max(1, scroll.line), doc.lines))
  view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: -scroll.offset }) })
  if (scroll.left > 0) view.requestMeasure({ read: () => null, write: () => void (scroller.scrollLeft = scroll.left) })
}

/** Bring a position to the middle of the view (an open at `line:col`). */
export function reveal(view: EditorView, pos: number): void {
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
}

// ── the one file-view editor ───────────────────────────────────────────────────────────────────────

const EMPTY = EditorState.create({ doc: '', extensions: [readOnly()] })
let file: EditorView | null = null
let created = 0

export function emptyState(): EditorState {
  return EMPTY
}

/**
 * Put an editor into `host`, or take it out of the mount it is in (null). CodeMirror listens for scrolls on every
 * ancestor of an editor, and looks for its ancestors again only a second after the editor came into or went out of
 * view: until then it would hold the mount the editor left — a closed tab's whole frame — and across a move
 * from one mount straight into another it would hold it for as long as the editor stays in view. So it is told to look
 * now. `observer` is not in its public types: without it the old mount is held as described, nothing else changes
 * (L-FV-1 counts the nodes).
 */
export function place(view: EditorView, host: HTMLElement | null): void {
  if (view.dom.parentElement === host) return
  if (host) host.append(view.dom)
  else view.dom.remove()
  ;(view as unknown as { observer?: { listenForScroll?: () => void } }).observer?.listenForScroll?.()
}

/** Make an editor of this feature: its scroller reports when a scroll came to rest. */
export function createEditor(parent?: HTMLElement): EditorView {
  created++
  const view = new EditorView({ state: EMPTY, ...(parent ? { parent } : {}) })
  view.scrollDOM.addEventListener('scrollend', () => hooks?.scrolled(), { passive: true })
  return view
}

/** Show `state` in the file-view editor, inside `host`. */
export function showFile(host: HTMLElement, state: EditorState, h: EditorHooks): EditorView {
  hooks = h
  const view = (file ??= createEditor())
  place(view, host)
  view.setState(state)
  return view
}

/** The file view left the screen: its editor holds nothing and is in no mount. */
export function hideFile(): void {
  if (!file) return
  file.setState(EMPTY)
  place(file, null)
}

/** Who hears the document on screen; null when none is. */
export function setEditorHooks(h: EditorHooks | null): void {
  hooks = h
}

export function editorHooks(): EditorHooks | null {
  return hooks
}

/** For the resource report and the leak tests. */
export function fileEditorStats(): { editors: number; created: number; docBytes: number } {
  return { editors: file ? 1 : 0, created, docBytes: file ? file.state.doc.length : 0 }
}

/** The file-view editor, if it was ever made (probes). */
export function fileEditor(): EditorView | null {
  return file
}
