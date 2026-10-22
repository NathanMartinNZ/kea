import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { COLOR } from '@kea/ui/tokens'
import { blend, FindSession, openFindBar, resultsText, type FindBarState, type FindResults, type SearchAddonLike, type SearchOptionsLike } from './find.ts'
import { terminalUi, uiState } from './ui.svelte.ts'

class FakeSearch implements SearchAddonLike {
  static live = 0
  decorations = 0
  calls: string[] = []
  private cb: ((e: { resultIndex: number; resultCount: number }) => void) | null = null
  private readonly matches: number
  constructor(matches: number) {
    this.matches = matches
    FakeSearch.live++
  }
  findNext(term: string, o?: SearchOptionsLike): boolean {
    return this.find('next', term, o)
  }
  findPrevious(term: string, o?: SearchOptionsLike): boolean {
    return this.find('previous', term, o)
  }
  private find(dir: string, term: string, o?: SearchOptionsLike): boolean {
    this.calls.push(`${dir} ${term} case=${o?.caseSensitive} regex=${o?.regex} inc=${o?.incremental ?? false}`)
    const n = Math.min(this.matches, L.searchHighlightsMax) // the addon stops highlighting at its limit
    this.decorations = n
    this.cb?.({ resultIndex: n ? 0 : -1, resultCount: n })
    return n > 0
  }
  clearDecorations(): void {
    this.decorations = 0
  }
  clearActiveDecoration(): void {}
  onBeforeSearch() {
    return { dispose: () => {} }
  }
  onDidChangeResults(cb: (e: { resultIndex: number; resultCount: number }) => void) {
    this.cb = cb
    return { dispose: () => (this.cb = null) }
  }
  dispose(): void {
    FakeSearch.live--
  }
}

/**
 * The addon over xterm's decoration list as it behaves upstream: a removal is applied later, and one made while
 * an earlier removal of the same batch is still waiting can miss. The addon removes the active match's decoration first
 * and the highlights after it, so a highlight stays in the list (`stuck`) unless the list was settled in between.
 */
class LeakySearch implements SearchAddonLike {
  highlights = 0
  active = false
  stuck = 0
  private waiting = false
  private term: string | null = null
  private before: (() => void) | null = null
  private readonly matches: (term: string) => number
  constructor(matches: (term: string) => number) {
    this.matches = matches
  }
  get decorations(): number {
    return this.highlights + (this.active ? 1 : 0) + this.stuck
  }
  /** What a registration does to the list, and what `settle` asks for. */
  settle(): void {
    this.waiting = false
  }
  findNext(term: string): boolean {
    return this.find(term)
  }
  findPrevious(term: string): boolean {
    return this.find(term)
  }
  /** The addon's own search again after output or a resize (its `_updateMatches`). */
  again(): void {
    const term = this.term
    this.term = null
    if (term !== null) this.find(term)
  }
  private find(term: string): boolean {
    this.before?.()
    if (term !== this.term) {
      this.clearDecorations()
      this.highlights = this.matches(term)
    }
    this.term = term
    this.clearActiveDecoration()
    if (this.highlights === 0) return false
    this.settle() // the new active match's decoration is registered
    this.active = true
    return true
  }
  clearDecorations(): void {
    this.clearActiveDecoration()
    if (this.highlights > 0 && this.waiting) this.stuck++
    this.highlights = 0
    this.term = null
  }
  clearActiveDecoration(): void {
    if (!this.active) return
    this.active = false
    this.waiting = true
  }
  onBeforeSearch(cb: () => void) {
    this.before = cb
    return { dispose: () => (this.before = null) }
  }
  onDidChangeResults() {
    return { dispose: () => {} }
  }
  dispose(): void {}
}

const deco = { matchBackground: '#000000', matchOverviewRuler: '#000000', activeMatchBackground: '#000000', activeMatchBorder: '#000000', activeMatchColorOverviewRuler: '#000000' }

describe('find in terminal', () => {
  it('U-TERM-18 · the search addon exists only while the bar is open; highlights are capped and cleared on close', () => {
    let fake: FakeSearch | null = null
    const results: FindResults[] = []
    const s = new FindSession({ load: () => (fake = new FakeSearch(L.searchHighlightsMax * 5)), decorations: deco, settle: () => {}, cap: L.searchHighlightsMax, onResults: (r) => results.push(r) })
    expect(FakeSearch.live).toBe(1)
    s.search('err', { caseSensitive: false, regex: false }, 'incremental')
    expect(fake!.decorations).toBe(L.searchHighlightsMax)
    expect(results.at(-1)).toEqual({ index: 0, count: L.searchHighlightsMax, capped: true, error: null })
    expect(resultsText(results.at(-1)!, 'err')).toBe(`1 of ${L.searchHighlightsMax}+`)
    s.close()
    s.close()
    expect(fake!.decorations).toBe(0)
    expect(FakeSearch.live).toBe(0)
    expect(s.isOpen).toBe(false)
    expect(s.search('err', { caseSensitive: false, regex: false }, 'next')).toBe(false)
  })

  it('U-TERM-18 · ↵ / ⇧↵ go next / previous, typing searches incrementally, the toggles reach the addon; bad regex and no match are reported', () => {
    let fake: FakeSearch | null = null
    const results: FindResults[] = []
    const s = new FindSession({ load: () => (fake = new FakeSearch(3)), decorations: deco, settle: () => {}, cap: L.searchHighlightsMax, onResults: (r) => results.push(r) })
    s.search('Foo', { caseSensitive: true, regex: false }, 'incremental')
    s.search('Foo', { caseSensitive: true, regex: false }, 'next')
    s.search('F.o', { caseSensitive: false, regex: true }, 'previous')
    expect(fake!.calls).toEqual(['next Foo case=true regex=false inc=true', 'next Foo case=true regex=false inc=false', 'previous F.o case=false regex=true inc=false'])
    expect(resultsText(results.at(-1)!, 'F.o')).toBe('1 of 3')
    s.search('(', { caseSensitive: false, regex: true }, 'incremental')
    expect(results.at(-1)?.error).toBe('Invalid pattern')
    expect(fake!.calls).toHaveLength(3)
    s.search('', { caseSensitive: false, regex: false }, 'incremental')
    expect(resultsText(results.at(-1)!, '')).toBe('')
    const none = new FindSession({ load: () => new FakeSearch(0), decorations: deco, settle: () => {}, cap: L.searchHighlightsMax, onResults: (r) => results.push(r) })
    none.search('zzz', { caseSensitive: false, regex: false }, 'incremental')
    expect(resultsText(results.at(-1)!, 'zzz')).toBe('No results')
    s.close()
    none.close()
  })

  it('U-TERM-28 · ⌘F on a closed bar reopens it with the last query selected and searches it again, so the count and highlights come back; ⌘F on an open bar only refocuses it', () => {
    // a view's find side as TerminalView has it: a session (and its addon) only while the bar is open
    const results: FindResults[] = []
    let session: FindSession | null = null
    let addon: FakeSearch | null = null
    const view = {
      get findOpen() {
        return !!session?.isOpen
      },
      openFind(): FindSession {
        if (session?.isOpen) return session
        session = new FindSession({ load: () => (addon = new FakeSearch(7)), decorations: deco, settle: () => {}, cap: L.searchHighlightsMax, onResults: (r) => results.push(r) })
        return session
      },
      closeFind(): void {
        session?.close()
        session = null
      },
    }
    // the bar's state (ui.svelte.ts `FindState`): the query and toggles outlive the bar
    let bar: FindBarState = { open: false, query: '', caseSensitive: false, regex: false, focusSeq: 0 }
    const update = (patch: Partial<FindBarState>) => (bar = { ...bar, ...patch })

    // first open: nothing to search yet
    openFindBar(view, bar, update)
    expect([bar.open, bar.focusSeq]).toEqual([true, 1])
    expect(addon!.calls).toEqual([])
    // the user searches, case-sensitive, then closes the bar (Esc)
    update({ query: 'Kea', caseSensitive: true })
    view.openFind().search(bar.query, bar, 'incremental')
    expect(addon!.decorations).toBe(7)
    view.closeFind()
    update({ open: false })
    expect(addon!.decorations).toBe(0)
    results.length = 0

    // reopened: a new addon, the last query searched again with the same toggles, so matches show at once
    openFindBar(view, bar, update)
    expect([bar.open, bar.query, bar.focusSeq]).toEqual([true, 'Kea', 2])
    expect(addon!.calls).toEqual(['next Kea case=true regex=false inc=true'])
    expect(addon!.decorations).toBe(7)
    expect(resultsText(results.at(-1)!, bar.query)).toBe('1 of 7')

    // ⌘F while it is open: focus moves back into the field (and selects the query); no second search
    openFindBar(view, bar, update)
    expect(bar.focusSeq).toBe(3)
    expect(addon!.calls).toHaveLength(1)
    view.closeFind()
    expect(FakeSearch.live).toBe(0)
  })

  it('U-TERM-18 · match highlights are the warn colour blended onto the terminal canvas (opaque, as xterm requires)', () => {
    expect(blend(COLOR.warn, COLOR['surface-0'], 1)).toBe(COLOR.warn.toLowerCase())
    expect(blend(COLOR.warn, COLOR['surface-0'], 0)).toBe(COLOR['surface-0'].toLowerCase())
    expect(blend('#ffffff', '#000000', 0.5)).toBe('#808080')
  })
})

describe('the find-bar query', () => {
  it('U-TERM-31 · the window keeps one find query of limited length: a longer one (a paste, say) is cut to the limit, a shorter one kept whole', () => {
    const long = 'q'.repeat(L.findQueryMaxChars * 50)
    terminalUi.find({ query: long })
    expect(uiState.snapshot().find.query).toHaveLength(L.findQueryMaxChars)
    expect(uiState.snapshot().find.query).toBe(long.slice(0, L.findQueryMaxChars))
    terminalUi.find({ query: 'needle', regex: true })
    expect(uiState.snapshot().find).toMatchObject({ query: 'needle', regex: true })
    terminalUi.find({ regex: false })
    expect(uiState.snapshot().find).toMatchObject({ query: 'needle', regex: false })
    terminalUi.find({ query: '' })
  })

  it('U-TERM-52 · no decoration outlives its search: the active match is taken off and the terminal’s list settled before highlights are cleared (a new query, the addon searching again after output, an emptied or broken query, closing the bar)', () => {
    const plain = { caseSensitive: false, regex: false }
    const open = (): { s: FindSession; a: LeakySearch } => {
      const a = new LeakySearch((term) => ('two-4 two-4'.includes(term) ? 2 : 0))
      return { a, s: new FindSession({ load: () => a, decorations: deco, settle: () => a.settle(), cap: L.searchHighlightsMax, onResults: () => {} }) }
    }
    // typed letter by letter, each letter a new query over the last one's highlights; then one with no match
    let { s, a } = open()
    for (const q of ['t', 'tw', 'two', 'two-']) s.search(q, plain, 'incremental')
    expect(a.decorations, 'two highlights and the active match').toBe(3)
    s.search('two-', plain, 'next')
    s.search('two-n', plain, 'incremental')
    expect([a.decorations, a.stuck]).toEqual([0, 0])
    // output arrives while the bar is open: the addon searches again by itself
    s.search('two', plain, 'incremental')
    a.again()
    expect([a.decorations, a.stuck]).toEqual([3, 0])
    // the query emptied, a broken pattern, the bar closed: each clears with the active match still shown
    s.search('', plain, 'incremental')
    expect([a.decorations, a.stuck]).toEqual([0, 0])
    s.search('two', plain, 'incremental')
    s.search('(', { caseSensitive: false, regex: true }, 'incremental')
    expect([a.decorations, a.stuck]).toEqual([0, 0])
    s.search('two', plain, 'incremental')
    s.close()
    expect([a.decorations, a.stuck]).toEqual([0, 0])
    ;({ s, a } = open())
    s.close()
    expect(a.decorations).toBe(0)
  })
})
