// Find in terminal: incremental search with a match count, ↵ / ⇧↵ for next / previous, case and regex toggles. The
// search addon is loaded only while the find bar is open; its highlights are capped at `L.searchHighlightsMax` and
// cleared, with the addon disposed, when the bar closes.
//
// xterm.js applies a decoration's removal from its list later, and a removal made while an earlier one of the same
// batch still waits can miss, leaving a disposed decoration in the list (and drawn) for the terminal's life. The addon
// removes the active match's decoration first and the highlights right after it, which is that case. So before anything
// clears highlights (every search, the addon's own after output included, and every clear) the session takes the
// active match off and has the terminal settle its list (`settle`); the highlights then go in order, which is safe.

import type { Disposable } from '@kea/terminal'

export interface SearchDecorations {
  matchBackground: string
  matchBorder?: string
  matchOverviewRuler: string
  activeMatchBackground: string
  activeMatchBorder: string
  activeMatchColorOverviewRuler: string
}

export interface SearchOptionsLike {
  caseSensitive: boolean
  regex: boolean
  incremental?: boolean
  decorations: SearchDecorations
}

/** The slice of `@xterm/addon-search`'s SearchAddon used here. */
export interface SearchAddonLike extends Disposable {
  findNext(term: string, o?: SearchOptionsLike): boolean
  findPrevious(term: string, o?: SearchOptionsLike): boolean
  clearDecorations(): void
  clearActiveDecoration(): void
  /** Fires at the start of every search, the addon's own (after output or a resize) included. */
  onBeforeSearch(cb: () => void): Disposable
  onDidChangeResults(cb: (e: { resultIndex: number; resultCount: number }) => void): Disposable
}

export interface FindToggles {
  caseSensitive: boolean
  regex: boolean
}

export interface FindResults {
  /** 0-based index of the current match; -1 when none is selected. */
  index: number
  count: number
  /** The count reached the highlight cap: there may be more. */
  capped: boolean
  error: string | null
}

export const NO_RESULTS: FindResults = { index: -1, count: 0, capped: false, error: null }

export interface FindSessionOptions {
  /** Create the addon and load it into the terminal. */
  load(): SearchAddonLike
  decorations: SearchDecorations
  /** Have the terminal apply the decoration removals it is holding. */
  settle(): void
  cap: number
  onResults(r: FindResults): void
}

export class FindSession {
  private addon: SearchAddonLike | null
  private subs: Disposable[]
  private readonly o: FindSessionOptions
  private last: FindResults = NO_RESULTS

  constructor(o: FindSessionOptions) {
    this.o = o
    this.addon = o.load()
    const a = this.addon
    this.subs = [
      a.onDidChangeResults((e) => this.report({ index: e.resultIndex, count: e.resultCount, capped: e.resultCount >= o.cap, error: null })),
      a.onBeforeSearch(() => this.settle(a)),
    ]
  }

  get isOpen(): boolean {
    return this.addon !== null
  }

  get results(): FindResults {
    return this.last
  }

  /** `incremental` while typing; `next` / `previous` for ↵ / ⇧↵. */
  search(query: string, t: FindToggles, dir: 'incremental' | 'next' | 'previous'): boolean {
    const a = this.addon
    if (!a) return false
    if (!query) {
      this.clear(a)
      this.report(NO_RESULTS)
      return false
    }
    if (t.regex) {
      try {
        new RegExp(query)
      } catch {
        this.clear(a)
        this.report({ ...NO_RESULTS, error: 'Invalid pattern' })
        return false
      }
    }
    const opts: SearchOptionsLike = { caseSensitive: t.caseSensitive, regex: t.regex, decorations: this.o.decorations, ...(dir === 'incremental' ? { incremental: true } : {}) }
    try {
      const found = dir === 'previous' ? a.findPrevious(query, opts) : a.findNext(query, opts)
      if (!found) this.report({ ...NO_RESULTS })
      return found
    } catch (e) {
      this.report({ ...NO_RESULTS, error: e instanceof Error ? e.message : String(e) })
      return false
    }
  }

  /** Close the bar: highlights cleared, the addon disposed. Idempotent. */
  close(): void {
    const a = this.addon
    if (!a) return
    this.addon = null
    try {
      this.clear(a)
    } finally {
      for (const s of this.subs) s.dispose()
      this.subs = []
      a.dispose()
    }
  }

  /** The active match's decoration removed and out of the terminal's list before any highlight is. */
  private settle(a: SearchAddonLike): void {
    a.clearActiveDecoration()
    this.o.settle()
  }

  private clear(a: SearchAddonLike): void {
    this.settle(a)
    a.clearDecorations()
  }

  private report(r: FindResults): void {
    this.last = r
    this.o.onResults(r)
  }
}

/** What ⌘F needs from the terminal on screen (`TerminalView`). */
export interface FindHost {
  readonly findOpen: boolean
  openFind(): FindSession
}

/** The bar's state that outlives it (ui.svelte.ts `FindState`). */
export interface FindBarState extends FindToggles {
  open: boolean
  query: string
  /** Bumped to move focus into the field and select the query. */
  focusSeq: number
}

/**
 * ⌘F. A closed bar opens with the last query selected (typing replaces it) and searches it again with the last toggles,
 * so the count and highlights come back with it: closing disposed the search addon and its highlights, so the new
 * session has nothing until it searches. On an open bar, ⌘F only moves focus back into the field.
 */
export function openFindBar(host: FindHost, bar: FindBarState, update: (patch: Partial<FindBarState>) => void): void {
  const reopening = !host.findOpen
  const session = host.openFind()
  update({ open: true, focusSeq: bar.focusSeq + 1 })
  if (reopening && bar.query) session.search(bar.query, { caseSensitive: bar.caseSensitive, regex: bar.regex }, 'incremental')
}

/** `#rrggbb` of `fg` laid over `bg` at `alpha` (xterm decorations take opaque `#RRGGBB` only). */
export function blend(fg: string, bg: string, alpha: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const f = p(fg)
  const b = p(bg)
  return `#${f.map((c, i) => Math.round(c * alpha + (b[i] as number) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

/** The bar's count text: "3 of 17", "No results", or the count and a "+" at the highlight cap. */
export function resultsText(r: FindResults, query: string): string {
  if (r.error) return r.error
  if (!query) return ''
  if (r.count === 0) return 'No results'
  const total = r.capped ? `${r.count}+` : String(r.count)
  return r.index >= 0 ? `${r.index + 1} of ${total}` : total
}
