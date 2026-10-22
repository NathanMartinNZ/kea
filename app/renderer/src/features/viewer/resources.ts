// The viewer's rows of the renderer's resource report and what the app-level tests read of the viewer
// (`__keaProbe.viewer()`, lib/testProbes.ts). Read-only views of the plain registries; nothing here is used by the
// viewer itself.
//
//   viewerEditors      `EditorView`s alive: the file view's one, plus the diff instance's (1 unified, or 2 side by side)
//   viewerMerges       `MergeView`s alive (0 or 1)
//   viewerDocBytes     characters of text the editors hold (0 while no file or diff tab is on screen)
//   viewerCachedDocs   documents in the document cache (≤ L.viewerDocCache), and
//   viewerCachedBytes  their bytes (≤ L.viewerDocCacheBytes)
//   highlightWorkers   the highlight worker (0 or 1), highlightPending its unfinished requests, highlightGrammars
//                      the grammars it has loaded (recycled above L.highlightGrammarsMax)
//   viewerFollows      `viewer.follow` calls waiting on core (0 or 1), viewerReads reads in flight

import { foldedRanges } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { GitHead } from '@kea/protocol'
import { currentViewer, viewerStats, type ViewerUi } from './controller.svelte.ts'
import { fileEditorStats, scrollOf } from './editor.ts'
import { tokenStore } from './highlight.ts'
import { highlighterStats } from './highlighter.ts'
import { DIFF_CLASSES, diffStats } from './merge.ts'

export const VIEWER_ROWS = ['viewerEditors', 'viewerMerges', 'viewerDocBytes', 'viewerCachedDocs', 'viewerCachedBytes', 'highlightWorkers', 'highlightPending', 'highlightGrammars', 'viewerFollows', 'viewerReads'] as const

export function viewerResources(): Record<(typeof VIEWER_ROWS)[number], number> {
  const f = fileEditorStats()
  const d = diffStats()
  const h = highlighterStats()
  const v = viewerStats()
  return {
    viewerEditors: f.editors + d.unified + d.merges * 2,
    viewerMerges: d.merges,
    viewerDocBytes: f.docBytes + d.docBytes,
    viewerCachedDocs: v.cachedDocs,
    viewerCachedBytes: v.cachedBytes,
    highlightWorkers: h.workers,
    highlightPending: h.pending,
    highlightGrammars: h.grammars,
    viewerFollows: v.follows,
    viewerReads: v.reads,
  }
}

/** Prototypes for `Runtime.queryObjects` (the leak tests count live `EditorView` and `MergeView` instances). */
export const VIEWER_CLASSES = { EditorView, ...DIFF_CLASSES }

export interface ViewerProbe {
  ui: ViewerUi
  /** The document on screen (the file view's, or a diff's new side); null under an image, a preview, a note. */
  text: {
    lines: number
    chars: number
    /** The selection as 1-based lines and columns. */
    selection: { from: { line: number; col: number }; to: { line: number; col: number } }
    /** The scroll a tab keeps: the first visible line and the pixels scrolled past its top. */
    scroll: { line: number; offset: number; left: number }
    folds: number
    /** Lines the highlight worker's tokens have arrived for. */
    tokenised: number
    wrap: boolean
    findOpen: boolean
  } | null
  /** Files in the Changes list as the viewer knows it (the session's `git:` store), and whether the scope has a base. */
  git: { changed: number; head: GitHead | null }
  resources: Record<string, number>
  highlighter: { starts: number; workers: number; pending: number; grammars: number }
}

export function viewerProbe(): ViewerProbe | null {
  const c = currentViewer()
  if (!c) return null
  const view = c.textView()
  const h = highlighterStats()
  let text: ViewerProbe['text'] = null
  if (view) {
    const doc = view.state.doc
    const sel = view.state.selection.main
    const at = (pos: number) => {
      const line = doc.lineAt(pos)
      return { line: line.number, col: pos - line.from + 1 }
    }
    let folds = 0
    foldedRanges(view.state).between(0, doc.length, () => void folds++)
    const scroller = view.dom.closest<HTMLElement>('.cm-mergeView') ?? view.scrollDOM
    text = { lines: doc.lines, chars: doc.length, selection: { from: at(sel.from), to: at(sel.to) }, scroll: scrollOf(view, scroller), folds, tokenised: view.state.facet(tokenStore)?.lines ?? 0, wrap: view.lineWrapping, findOpen: view.dom.querySelector('.kea-find') !== null }
  }
  return { ui: c.ui, text, git: { changed: c.changedFiles().length, head: c.head() }, resources: viewerResources(), highlighter: { starts: h.starts, workers: h.workers, pending: h.pending, grammars: h.grammars } }
}

/** The whole text of the document on screen, with `\n` between lines. */
export function viewerText(): string | null {
  return currentViewer()?.textView()?.state.doc.toString() ?? null
}

/** What `⌘C` would put on the clipboard, without touching it: a copy event on the document, read back. */
export function viewerCopy(): string | null {
  const view = currentViewer()?.textView()
  if (!view) return null
  const data = new DataTransfer()
  view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
  return data.getData('text/plain')
}

/** A moment of an open, in ms from the call that opened it. */
export interface OpenMark {
  /** The frame that draws it, its paint excluded. */
  drawn: number
  /** The start of the frame after that one, by when its paint is done. */
  painted: number
}

/**
 * The viewer's open timings for the performance tests (tests/perf/app-viewer.test.ts): run `open` (a `viewer.open`)
 * and time, from that call, the frame that draws the document of `path` — its text, or its diff — and, with `colours`,
 * the frame that draws its first coloured token. A change made in a frame's animation callbacks is drawn by that
 * frame; one made between frames, by the next. `coloured` is null without `colours`.
 */
export function timeOpen(open: () => void, o: { path: string; colours: boolean; timeoutMs?: number }): Promise<{ text: OpenMark; coloured: OpenMark | null }> {
  return new Promise((resolve, reject) => {
    let text: OpenMark | null = null
    let coloured: OpenMark | null = null
    let textSeen = false
    let colourSeen = false
    // true from a frame's animation callbacks until its rendering is done: a task queued then runs after the paint
    let inFrame = false
    let ticking = true
    const tick = (): void => {
      if (!ticking) return
      inFrame = true
      setTimeout(() => {
        inFrame = false
      }, 0)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const t0 = performance.now()
    const mark = (set: (m: OpenMark) => void): void => {
      const now = performance.now() - t0
      // the frame after the drawing one starts once that paint is done
      const paintedBy = (drawn: number) =>
        requestAnimationFrame((t) => {
          set({ drawn, painted: t - t0 })
          done()
        })
      if (inFrame) paintedBy(now)
      else requestAnimationFrame((t) => paintedBy(t - t0))
    }
    const look = (): void => {
      const c = currentViewer()
      if (!c || c.ui.path !== o.path || (c.ui.body.kind !== 'text' && c.ui.body.kind !== 'diff')) return
      const view = c.textView()
      if (!view || !view.dom.isConnected) return
      if (!textSeen) {
        textSeen = true
        mark((m) => (text = m))
      }
      if (o.colours && !colourSeen && view.contentDOM.querySelector('[class*="kea-tok-"]')) {
        colourSeen = true
        mark((m) => (coloured = m))
      }
    }
    const watch = new MutationObserver(look)
    const timer = setTimeout(() => finish(new Error(`${o.path} was not ${textSeen ? 'coloured' : 'shown'}`)), o.timeoutMs ?? 20_000)
    const finish = (err: Error | null): void => {
      ticking = false
      clearTimeout(timer)
      watch.disconnect()
      if (err) reject(err)
      else resolve({ text: text as OpenMark, coloured })
    }
    const done = (): void => {
      if (text && (!o.colours || coloured)) finish(null)
    }
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-body'] })
    open()
    look()
  })
}
