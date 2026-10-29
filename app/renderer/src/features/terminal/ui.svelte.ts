// UI state around the terminals: the find bar, "Jump to bottom", link hover and "Copy link", the paste confirmation,
// the "Copied by terminal" note, Linux's one-time copy hint and the terminal menu. Small values only: the text waiting for a paste confirmation is held here
// outside the state, and dropped once the sheet closes. A runes store: each field is its own `$state.raw`,
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
}

export interface TerminalUiFields {
  /** "Copied by terminal" is showing. */
  copied: boolean
  linkHover: { x: number; y: number; text: string } | null
  linkMenu: { x: number; y: number; target: string } | null
  paste: { ptyId: string; lines: number } | null
  /** The shown terminal is scrolled up. */
  scrolledUp: boolean
  find: FindState
  /** Linux's one-time hint: plain Ctrl+C interrupted, and copying is another key (or the setting). */
  copyHint: boolean
  /** The terminal menu: the terminal it was opened on and where. */
  menu: { ptyId: string; at: { x: number; y: number } } | null
}

class TerminalUiState implements TerminalUiFields {
  copied = $state(false)
  linkHover = $state.raw<TerminalUiFields['linkHover']>(null)
  linkMenu = $state.raw<TerminalUiFields['linkMenu']>(null)
  paste = $state.raw<TerminalUiFields['paste']>(null)
  scrolledUp = $state(false)
  copyHint = $state(false)
  menu = $state.raw<TerminalUiFields['menu']>(null)
  // bounded: one query for the window, at most `L.findQueryMaxChars`
  find = $state.raw<FindState>({ open: false, query: '', caseSensitive: false, regex: false, results: NO_RESULTS, focusSeq: 0 })

  /** Every field as plain data (tests: what the state holds). */
  snapshot(): TerminalUiFields {
    return { copied: this.copied, linkHover: this.linkHover, linkMenu: this.linkMenu, paste: this.paste, scrolledUp: this.scrolledUp, find: this.find, copyHint: this.copyHint, menu: this.menu }
  }
}

export const uiState = new TerminalUiState()

let copiedTimer: ReturnType<typeof setTimeout> | null = null // bounded: one timer, replaced by each write
let pendingPaste: string | null = null // bounded: one paste awaiting confirmation

export const terminalUi = {
  /** An OSC 52 write was applied: show the note for `L.osc52NoteMs`. */
  copiedByTerminal(): void {
    if (copiedTimer) clearTimeout(copiedTimer)
    uiState.copied = true
    copiedTimer = setTimeout(() => {
      copiedTimer = null
      uiState.copied = false
    }, L.osc52NoteMs)
  },
  linkHover(h: TerminalUiFields['linkHover']): void {
    uiState.linkHover = h
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
  scrolledUp(up: boolean): void {
    if (uiState.scrolledUp !== up) uiState.scrolledUp = up
  },
  copyHint(on: boolean): void {
    uiState.copyHint = on
  },
  /** Update the find bar; a query longer than `L.findQueryMaxChars` is cut to it. */
  find(patch: Partial<FindState>): void {
    const p = patch.query !== undefined && patch.query.length > L.findQueryMaxChars ? { ...patch, query: patch.query.slice(0, L.findQueryMaxChars) } : patch
    uiState.find = { ...uiState.find, ...p }
  },
}
