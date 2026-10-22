// The viewer's two bars: Find in File (`⌘F`) and Go to Line (`⌃G`). Each is an editor panel above the text, so it
// belongs to the document on screen and goes with it. Their inputs are ordinary fields outside the document: typing in
// them is not typing in the file.
//
// Find drives `@codemirror/search` (which also draws the matches): incremental, with a match count, the case / whole
// word / regular expression toggles, `↵` and `⇧↵` for the next and the previous match. Both bars use `Esc` and `↵`
// themselves and say so (`preventDefault`), so the tab strip's Esc (close the tab) and ↵ (pin it) are not run under
// them (`tab.ts`).

import { closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, search, searchPanelOpen, SearchQuery, setSearchQuery } from '@codemirror/search'
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, showPanel, type Panel, type ViewUpdate } from '@codemirror/view'
import { chordLabel } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { parseLineCol, positionAt } from './viewState.ts'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (text !== undefined) e.textContent = text
  return e
}

// ── Find ───────────────────────────────────────────────────────────────────────────────────────────

/** Where the matches start, up to the count's cap; `more`: there are matches past it. */
function matchStarts(state: EditorState, query: SearchQuery): { starts: number[]; more: boolean } {
  const starts: number[] = []
  if (!query.valid) return { starts, more: false }
  const cursor = query.getCursor(state)
  for (;;) {
    const r = cursor.next()
    if (r.done) return { starts, more: false }
    if (starts.length === L.viewerFindCountMax) return { starts, more: true }
    starts.push(r.value.from)
  }
}

/** `3 of 17`, `17 results`, `9999+ results`, `No results`. */
export function countLabel(starts: readonly number[], more: boolean, selectionFrom: number, selected: boolean): string {
  if (starts.length === 0) return 'No results'
  const total = `${starts.length}${more ? '+' : ''}`
  if (selected) {
    let lo = 0
    let hi = starts.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const v = starts[mid] as number
      if (v === selectionFrom) return `${mid + 1} of ${total}`
      if (v < selectionFrom) lo = mid + 1
      else hi = mid - 1
    }
  }
  return `${total} ${starts.length === 1 && !more ? 'result' : 'results'}`
}

function findPanel(view: EditorView): Panel {
  const dom = el('div', 'kea-bar kea-find', { role: 'search', 'aria-label': 'Find in file' })
  const input = el('input', 'kea-bar-input', { type: 'text', placeholder: 'Find', 'aria-label': 'Find in file', 'main-field': 'true', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' })
  const count = el('span', 'kea-bar-count', { 'aria-live': 'polite' })
  const toggle = (label: string, title: string) => el('button', 'kea-bar-toggle', { type: 'button', 'data-tip': title, 'aria-label': title, 'aria-pressed': 'false' }, label)
  const caseB = toggle('Aa', 'Match Case')
  const wordB = toggle('ab', 'Match Whole Word')
  const regexB = toggle('.*', 'Use Regular Expression')
  const prev = el('button', 'kea-bar-button', { type: 'button', 'data-tip': 'Previous match', 'data-tip-key': chordLabel('shift+enter'), 'aria-label': 'Previous match' }, '↑')
  const next = el('button', 'kea-bar-button', { type: 'button', 'data-tip': 'Next match', 'data-tip-key': chordLabel('enter'), 'aria-label': 'Next match' }, '↓')
  const close = el('button', 'kea-bar-button', { type: 'button', 'data-tip': 'Close', 'data-tip-key': 'Esc', 'aria-label': 'Close find' }, '×')
  dom.append(input, count, caseB, wordB, regexB, prev, next, close)

  let shown: SearchQuery | null = null
  let starts: number[] = []
  let more = false

  const label = () => {
    const q = getSearchQuery(view.state)
    if (q.search === '') count.textContent = ''
    else if (!q.valid) count.textContent = 'Invalid expression'
    else {
      const sel = view.state.selection.main
      count.textContent = countLabel(starts, more, sel.from, !sel.empty)
    }
    dom.classList.toggle('none', q.search !== '' && starts.length === 0)
  }
  const recount = () => {
    const q = getSearchQuery(view.state)
    ;({ starts, more } = q.search === '' ? { starts: [], more: false } : matchStarts(view.state, q))
    label()
  }
  /** Move to the next or the previous match. CodeMirror then selects the whole field (its own bar's habit); the caret stays where it was instead, so typing on adds to what is searched for. */
  const step = (run: (v: EditorView) => boolean) => {
    const from = input.selectionStart
    const to = input.selectionEnd
    run(view)
    if (view.root.activeElement === input) input.setSelectionRange(from, to)
  }
  /** The fields as the query has them (the bar reopened, or the query seeded from the selection). */
  const show = (q: SearchQuery) => {
    shown = q
    if (input.value !== q.search) input.value = q.search
    caseB.setAttribute('aria-pressed', String(q.caseSensitive))
    wordB.setAttribute('aria-pressed', String(q.wholeWord))
    regexB.setAttribute('aria-pressed', String(q.regexp))
  }
  /** The fields became the query: the matches are drawn, and the first one at or after the selection is shown. */
  const commit = () => {
    const q = new SearchQuery({ search: input.value, caseSensitive: caseB.getAttribute('aria-pressed') === 'true', wholeWord: wordB.getAttribute('aria-pressed') === 'true', regexp: regexB.getAttribute('aria-pressed') === 'true' })
    shown = q
    // incremental: from where the selection starts, so typing on keeps the match it is on
    view.dispatch({ effects: setSearchQuery.of(q), selection: EditorSelection.cursor(view.state.selection.main.from) })
    if (q.valid && q.search !== '') step(findNext)
  }
  const done = () => {
    closeSearchPanel(view)
    view.focus()
  }

  input.addEventListener('input', commit)
  for (const b of [caseB, wordB, regexB]) {
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))
      commit()
      input.focus()
    })
  }
  prev.addEventListener('click', () => step(findPrevious))
  next.addEventListener('click', () => step(findNext))
  close.addEventListener('click', done)
  // buttons never take the keyboard from the field
  for (const b of [caseB, wordB, regexB, prev, next, close]) b.addEventListener('mousedown', (e) => e.preventDefault())
  dom.addEventListener('keydown', (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      done()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? findPrevious : findNext)
    }
  })

  show(getSearchQuery(view.state))
  return {
    dom,
    top: true,
    mount() {
      recount()
      input.focus()
      input.select()
    },
    update(u: ViewUpdate) {
      const q = getSearchQuery(u.state)
      const changed = !shown || !q.eq(shown)
      if (changed) show(q)
      if (changed || u.docChanged || !q.eq(getSearchQuery(u.startState))) recount()
      else if (u.selectionSet) label()
    },
  }
}

/** Open the find bar (or take the keyboard back to it); a selection on one line becomes what is searched for. */
export function openFindBar(view: EditorView): void {
  openSearchPanel(view)
}

export function findBarOpen(state: EditorState): boolean {
  return searchPanelOpen(state)
}

// ── Go to Line ─────────────────────────────────────────────────────────────────────────────────────

const toggleGoto = StateEffect.define<boolean>()

const gotoOpen = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleGoto)) value = e.value
    return value
  },
  provide: (f) => showPanel.from(f, (on) => (on ? gotoPanel : null)),
})

/** Put the cursor at `line[:col]` and bring it to the middle of the view. */
export function goTo(view: EditorView, p: { line: number; col: number }): void {
  const pos = positionAt(view.state.doc, p)
  view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
}

function gotoPanel(view: EditorView): Panel {
  const dom = el('div', 'kea-bar kea-goto')
  const lines = view.state.doc.lines
  const input = el('input', 'kea-bar-input', { type: 'text', placeholder: `Line[:column], 1–${lines}`, 'aria-label': 'Go to line', spellcheck: 'false', autocomplete: 'off' })
  dom.append(input)
  const close = () => {
    view.dispatch({ effects: toggleGoto.of(false) })
    view.focus()
  }
  dom.addEventListener('keydown', (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const p = parseLineCol(input.value)
      if (!p) {
        dom.classList.add('none')
        return
      }
      view.dispatch({ effects: toggleGoto.of(false) })
      goTo(view, p)
      view.focus()
    }
  })
  input.addEventListener('input', () => dom.classList.remove('none'))
  // leaving the field ends the bar: it is a question, not a place
  input.addEventListener('blur', () => {
    if (view.state.field(gotoOpen, false)) view.dispatch({ effects: toggleGoto.of(false) })
  })
  return { dom, top: true, mount: () => input.focus() }
}

export function openGotoBar(view: EditorView): void {
  if (!view.state.field(gotoOpen, false)) view.dispatch({ effects: toggleGoto.of(true) })
}

/** Both bars, for a document's state. */
export function bars(): Extension {
  return [search({ top: true, createPanel: findPanel }), gotoOpen]
}
