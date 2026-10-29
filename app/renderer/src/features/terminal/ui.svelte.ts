// UI state around the terminals: the find bar, "Jump to bottom", link hover and "Copy link", the paste confirmation,
// the "Copied by terminal" note, Linux's one-time copy hint and the terminal menu. Each names the terminal it belongs
// to, so each pane draws only its own terminal's layers. Small values only: the text waiting for a paste confirmation
// is held here outside the state, and dropped once the sheet closes. A runes store: each field is its own `$state.raw`,
// replaced, never mutated; components read `uiState.<field>`, everything writes through `terminalUi`.

import { L } from '@kea/protocol'
import { NO_RESULTS, type FindResults } from './find.ts'

export interface FindState {
  open: boolean
  query: string
  caseSensitive: boolean
  regex: boolean
  results: FindResults
  /** Bumped to move focus into the field (⌘F while the bar is already open). */
  focusSeq: number
  /** The terminal searched: the bar is docked on it. */
  ptyId: string | null
}

export interface TerminalUiFields {
  /** The terminal whose program's clipboard write shows "Copied by terminal". */
  copied: string | null
  linkHover: { ptyId: string; x: number; y: number; text: string } | null
  linkMenu: { ptyId: string; x: number; y: number; target: string } | null
  paste: { ptyId: string; lines: number } | null
  /** The terminals on screen that are scrolled up. */
  scrolledUp: readonly string[]
  find: FindState
  /** Linux's one-time hint, on the terminal where plain Ctrl+C interrupted (copying is another key, or the setting). */
  copyHint: string | null
  /** The terminal menu: the terminal it was opened on and where. */
  menu: { ptyId: string; at: { x: number; y: number } } | null
}

class TerminalUiState implements TerminalUiFields {
  copied = $state<string | null>(null)
  linkHover = $state.raw<TerminalUiFields['linkHover']>(null)
  linkMenu = $state.raw<TerminalUiFields['linkMenu']>(null)
  paste = $state.raw<TerminalUiFields['paste']>(null)
  // bounded: the terminals on screen, one per pane
  scrolledUp = $state.raw<readonly string[]>([])
  copyHint = $state<string | null>(null)
  menu = $state.raw<TerminalUiFields['menu']>(null)
  // bounded: one query for the window, at most `L.findQueryMaxChars`
  find = $state.raw<FindState>({ open: false, query: '', caseSensitive: false, regex: false, results: NO_RESULTS, focusSeq: 0, ptyId: null })

  /** Every field as plain data (tests: what the state holds). */
  snapshot(): TerminalUiFields {
    return { copied: this.copied, linkHover: this.linkHover, linkMenu: this.linkMenu, paste: this.paste, scrolledUp: this.scrolledUp, find: this.find, copyHint: this.copyHint, menu: this.menu }
  }
}

export const uiState = new TerminalUiState()

let copiedTimer: ReturnType<typeof setTimeout> | null = null // bounded: one timer, replaced by each write
let pendingPaste: string | null = null // bounded: one paste awaiting confirmation

/** Whether a terminal is scrolled up ("Jump to bottom" shows over it). */
export function isScrolledUp(ptyId: string | null | undefined): boolean {
  return ptyId != null && uiState.scrolledUp.includes(ptyId)
}

export const terminalUi = {
  /** An OSC 52 write from `ptyId`'s program was applied: show the note for `L.osc52NoteMs`. */
  copiedByTerminal(ptyId: string): void {
    if (copiedTimer) clearTimeout(copiedTimer)
    uiState.copied = ptyId
    copiedTimer = setTimeout(() => {
      copiedTimer = null
      uiState.copied = null
    }, L.osc52NoteMs)
  },
  linkHover(h: TerminalUiFields['linkHover']): void {
    uiState.linkHover = h
  },
  /** The pointer left a link in `ptyId`: its target goes, not another terminal's. */
  linkLeave(ptyId: string): void {
    if (uiState.linkHover?.ptyId === ptyId) uiState.linkHover = null
  },
  linkMenu(m: TerminalUiFields['linkMenu']): void {
    uiState.linkMenu = m
    uiState.linkHover = null
  },
  /** Open the terminal menu (null closes it); the link's hover goes, as for "Copy link". */
  openMenu(m: TerminalUiFields['menu']): void {
    uiState.menu = m
    if (m) uiState.linkHover = null
  },
  askPaste(ptyId: string, lines: number, text: string): void {
    pendingPaste = text
    uiState.paste = { ptyId, lines }
  },
  /** Close the paste sheet; returns the text when the user confirmed. */
  settlePaste(confirmed: boolean): string | null {
    const text = pendingPaste
    pendingPaste = null
    uiState.paste = null
    return confirmed ? text : null
  },
  scrolledUp(ptyId: string, up: boolean): void {
    const has = uiState.scrolledUp.includes(ptyId)
    if (up && !has) uiState.scrolledUp = [...uiState.scrolledUp, ptyId]
    else if (!up && has) uiState.scrolledUp = uiState.scrolledUp.filter((id) => id !== ptyId)
  },
  copyHint(ptyId: string | null): void {
    uiState.copyHint = ptyId
  },
  /** Update the find bar; a query longer than `L.findQueryMaxChars` is cut to it. */
  find(patch: Partial<FindState>): void {
    const p = patch.query !== undefined && patch.query.length > L.findQueryMaxChars ? { ...patch, query: patch.query.slice(0, L.findQueryMaxChars) } : patch
    uiState.find = { ...uiState.find, ...p }
  },
  /** A search's results, kept only while the bar is on that terminal. */
  findResults(ptyId: string, results: FindResults): void {
    if (uiState.find.ptyId === ptyId) uiState.find = { ...uiState.find, results }
  },
  /** The bar closes if it is on one of `ids` (a pane's switch closes find on its own terminals only); returns that one. */
  closeFindOn(ids: Iterable<string>): string | null {
    const on = uiState.find.ptyId
    if (on === null) return null
    for (const id of ids) {
      if (id === on) {
        uiState.find = { ...uiState.find, open: false, results: NO_RESULTS }
        return on
      }
    }
    return null
  },
}
