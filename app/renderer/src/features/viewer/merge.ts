// The window's diff instance, on `@codemirror/merge`: the unified layout is one editor whose document
// is the new side, with what was removed shown above each change; side by side is a `MergeView`, two editors that
// scroll as one. Exactly one of the two exists at a time. The unified editor is reused for every diff (a document is
// a state); a merge view cannot be given two new documents, so it is built for the diff it shows and destroyed when
// the diff, or the layout, goes. Plain module state; hidden, the unified editor holds an empty document.
//
// Read-only: both sides have the viewer's read-only extension, and the merge package's accept / reject / revert
// controls are never asked for.

import { getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, MergeView, unifiedMergeView } from '@codemirror/merge'
import { EditorState, Text, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import type { LineEnding } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { baseExtensions, createEditor, emptyState, place, setEditorHooks, editorHooks, type EditorHooks } from './editor.ts'
import { indentUnitOf } from './guides.ts'
import type { TabPosition, TabViewState } from './tab.ts'
import type { TokenStore } from './tokens.ts'
import { positionAt, selectionFor } from './viewState.ts'

export const DIFF_LAYOUTS = ['unified', 'split'] as const
export type DiffLayout = (typeof DIFF_LAYOUTS)[number]

export interface DiffDoc {
  /** The file's path in its folder: each side's accessible name starts with it. */
  path: string
  oldLines: readonly string[]
  newLines: readonly string[]
  oldEol: LineEnding
  newEol: LineEnding
  /** Null: plain text. The unified layout draws only the new side's (what was removed is shown plain). */
  oldStore: TokenStore | null
  newStore: TokenStore | null
}

/** The diff on screen: the editor of the new side (where the selection, the find bar and the references live) and what scrolls it. */
export interface ShownDiff {
  layout: DiffLayout
  view: EditorView
  /** The old side's editor, side by side only. */
  old: EditorView | null
  scroller: HTMLElement
}

const COLLAPSE = { margin: L.diffContextLines, minSize: L.diffCollapseMinLines }
// a collapsed region reads `⋯ 42 unchanged lines`
const PHRASES = EditorState.phrases.of({ '$ unchanged lines': '⋯ $ unchanged lines' })

let unified: EditorView | null = null
let split: MergeView | null = null
let merges = 0

function side(lines: readonly string[], eol: LineEnding, store: TokenStore | null, label: string): Extension[] {
  const guides = indentUnitOf(Text.of(lines.slice(0, L.highlightChunkLines) as string[]), emptyState().tabSize)
  return [lineNumbers(), baseExtensions({ eol, store, guides, label }), PHRASES]
}

function endSplit(): void {
  if (!split) return
  split.destroy()
  split.dom.remove()
  split = null
}

function endUnified(): void {
  if (!unified) return
  unified.destroy()
  unified.dom.remove()
  unified = null
}

/** Show a diff in `host`, in `layout`, with what its tab kept (the selection; the scroll is `restoreScroll`'s). */
export function showDiff(host: HTMLElement, layout: DiffLayout, d: DiffDoc, kept: TabViewState, goto: TabPosition | null, h: EditorHooks): ShownDiff {
  setEditorHooks(h)
  const doc = Text.of(d.newLines as string[])
  const selection = goto ? { anchor: positionAt(doc, goto) } : selectionFor(doc, kept.selection)
  if (layout === 'unified') {
    endSplit()
    const view = (unified ??= createEditor())
    place(view, host)
    view.setState(
      EditorState.create({
        doc,
        selection,
        extensions: [
          side(d.newLines, d.newEol, d.newStore, `${d.path}, changes`),
          unifiedMergeView({ original: Text.of(d.oldLines as string[]), highlightChanges: true, gutter: true, mergeControls: false, syntaxHighlightDeletions: false, collapseUnchanged: COLLAPSE }),
        ],
      }),
    )
    return { layout, view, old: null, scroller: view.scrollDOM }
  }
  endUnified()
  endSplit()
  merges++
  const m = new MergeView({
    a: { doc: Text.of(d.oldLines as string[]), extensions: side(d.oldLines, d.oldEol, d.oldStore, `${d.path}, before`) },
    b: { doc, selection, extensions: side(d.newLines, d.newEol, d.newStore, `${d.path}, after`) },
    parent: host,
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: COLLAPSE,
  })
  m.dom.addEventListener('scrollend', () => editorHooks()?.scrolled(), { passive: true })
  split = m
  return { layout, view: m.b, old: m.a, scroller: m.dom }
}

/** The diff left the screen: no merge view exists, and the unified editor holds nothing and is in no mount. */
export function hideDiff(): void {
  endSplit()
  if (!unified) return
  unified.setState(emptyState())
  place(unified, null)
}

/** The old side's text as the diff on screen has it. */
export function originalOf(s: ShownDiff): Text {
  return s.old ? s.old.state.doc : getOriginalDoc(s.view.state)
}

/** Lines added and removed, counted from the diff on screen (the header uses git's own counts when it has them). */
export function diffCounts(s: ShownDiff): { added: number; removed: number } {
  const chunks = getChunks(s.view.state)?.chunks ?? []
  const a = originalOf(s)
  const b = s.view.state.doc
  const lines = (doc: Text, from: number, to: number) => (to <= from ? 0 : doc.lineAt(Math.min(to - 1, doc.length)).number - doc.lineAt(from).number + 1)
  let added = 0
  let removed = 0
  for (const c of chunks) {
    removed += lines(a, c.fromA, c.toA)
    added += lines(b, c.fromB, c.toB)
  }
  return { added, removed }
}

/** The next or the previous hunk. False when there is none that way. */
export function goToChunk(s: ShownDiff, dir: 1 | -1): boolean {
  const run = dir === 1 ? goToNextChunk : goToPreviousChunk
  return run({ state: s.view.state, dispatch: (tr) => s.view.dispatch(tr) })
}

/** Changes in the diff on screen. */
export function chunkCount(s: ShownDiff): number {
  return getChunks(s.view.state)?.chunks.length ?? 0
}

/** For the resource report and the leak tests. */
export function diffStats(): { unified: number; merges: number; mergesCreated: number; docBytes: number } {
  return { unified: unified ? 1 : 0, merges: split ? 1 : 0, mergesCreated: merges, docBytes: (unified?.state.doc.length ?? 0) + (split ? split.a.state.doc.length + split.b.state.doc.length : 0) }
}

/** The classes the leak tests count instances of. */
export const DIFF_CLASSES = { MergeView }
