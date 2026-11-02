// An editable file's document: what replaces `readOnly()` while the file can be edited. Typing, deleting, selections
// and multiple cursors, cut / copy / paste, indent and outdent, move and copy lines, and the keys a code editor has.
// The keys Kea's commands already own stay theirs: `⌥↑` / `⌥↓` step through the changes, `⌘↵` opens the editor, `⌘[`
// / `⌘]` are the `editable file` scope's Indent Less / More, and on Linux no chord the key router takes is bound here.
//
// Copy, cut and a drag give the file's own line ending; the document itself has none (each line is a line, and text
// pasted with any ending splits into lines), so a save joins its lines with the file's ending.

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { copyLineDown, copyLineUp, defaultKeymap, historyKeymap, indentLess, indentMore, moveLineDown, moveLineUp, simplifySelection } from '@codemirror/commands'
import { indentOnInput, indentUnit } from '@codemirror/language'
import { closeSearchPanel, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, type Extension, type SelectionRange, type Text } from '@codemirror/state'
import { EditorView, keymap, rectangularSelection, type Command, type KeyBinding } from '@codemirror/view'
import { COMMANDS, chordText, parseShortcut, protocolOs, type KeyScope } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { PATH_DRAG_TYPE } from '../terminal/drop.ts'
import { findBarOpen } from './bars.ts'
import { lineBreakOf } from './decode.ts'
import { isFromDisk } from './readonly.ts'
import type { LineEnding } from '@kea/protocol'

/** What the document asks of its owner. */
export interface EditingHost {
  /** The document has text that is not on disk (Esc then leaves the tab alone). */
  unsaved(): boolean
  /** Save the file (Linux's plain `Ctrl+S`, a text field's key there). */
  save(): void
}

export interface EditingOptions {
  eol: LineEnding
  /** The indent unit: `"\t"` or spaces (`indentStringOf`). */
  indent: string
  /** The language's comment tokens, brackets and indent rule (`languageAids.ts`). */
  aids: Extension
  host: EditingHost
}

/** The document's indent unit: a tab when its lines are indented with tabs, else the smallest run of spaces, else `fallback`. */
export function indentStringOf(doc: Text, fallback: string): string {
  let smallest = 0
  const n = Math.min(doc.lines, L.viewerIndentScanLines)
  for (let i = 1; i <= n; i++) {
    const text = doc.line(i).text
    if (text.charCodeAt(0) === 9) return '\t'
    if (text.charCodeAt(0) !== 32) continue
    let k = 1
    while (text.charCodeAt(k) === 32) k++
    // a line of spaces only says nothing; one space is a comment's continuation (` * …`), not a level
    if (k === text.length || k < 2) continue
    if (smallest === 0 || k < smallest) smallest = k
  }
  return smallest === 0 ? fallback : ' '.repeat(Math.min(L.viewerIndentMax, smallest))
}

// ── keys ───────────────────────────────────────────────────────────────────────────────────────────

const linux = protocolOs.system === 'linux'

/** A CodeMirror key name (`Shift-Mod-k`) as the key router's canonical chord on this system (`ctrl+shift+k` on Linux). */
export function codeMirrorChord(name: string, mac = !linux): string | null {
  const parts = name.split(/-(?!$)/)
  const key = parts.pop() as string
  const c = { cmd: false, ctrl: false, alt: false, shift: false, key: '' }
  for (const p of parts) {
    if (p === 'Mod') c[mac ? 'cmd' : 'ctrl'] = true
    else if (p === 'Cmd' || p === 'Meta') c.cmd = true
    else if (p === 'Ctrl' || p === 'Control') c.ctrl = true
    else if (p === 'Alt') c.alt = true
    else if (p === 'Shift') c.shift = true
    else return null
  }
  const named: Readonly<Record<string, string>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Backspace: 'backspace', Delete: 'delete', Escape: 'escape', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Tab: 'tab', Space: 'space' }
  if (named[key]) c.key = named[key] as string
  else if ([...key].length === 1) {
    if (key !== key.toLowerCase()) c.shift = true
    c.key = key.toLowerCase()
  } else return null
  return chordText(c)
}

/**
 * The key scopes another context provides, never a file document: their keys (the detached overlay's `↵`, the file
 * panel's `Delete`, a diff tab's keys) are the document's while it has the keyboard.
 */
const OTHER_SCOPES = new Set<KeyScope>(['diff tab', 'file panel', 'detached overlay'])

/** The chords the key router takes on Linux while a file document has the keyboard: every other command's Linux key. */
function routerChords(): ReadonlySet<string> {
  const out = new Set<string>()
  for (const def of COMMANDS)
    for (const k of def.keyScope && OTHER_SCOPES.has(def.keyScope) ? [] : (def.linuxKeys ?? [])) {
      const c = parseShortcut(k)
      if (c) out.add(chordText(c))
    }
  return out
}

/** CodeMirror's bindings a key of Kea's owns: change stepping, Open in Editor, Indent Less / More, and its own Esc. */
const TAKEN = new Set(['Escape', 'Alt-ArrowUp', 'Alt-ArrowDown', 'Mod-Enter', 'Mod-i', 'Mod-[', 'Mod-]'])

/** `defaultKeymap` as an editable document has it: without the keys above, and on Linux without the router's chords. */
export function documentKeymap(onLinux = linux): KeyBinding[] {
  const router = onLinux ? routerChords() : null
  return defaultKeymap.filter((b) => {
    const name = (onLinux ? b.linux : b.mac) ?? b.key
    if (name === undefined) return true
    if (b.key !== undefined && TAKEN.has(b.key)) return false
    if (TAKEN.has(name)) return false
    if (router) {
      const chord = codeMirrorChord(name, false)
      if (chord && router.has(chord)) return false
      const shifted = b.shift ? codeMirrorChord(`Shift-${name}`, false) : null
      if (shifted && router.has(shifted)) return false
    }
    return true
  })
}

/** Tab: one indent unit at each cursor with nothing selected; the selected lines indented otherwise. */
export const insertIndent: Command = (view) => {
  const { state } = view
  if (state.readOnly) return false
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view)
  view.dispatch(state.update(state.replaceSelection(state.facet(indentUnit)), { scrollIntoView: true, userEvent: 'input.indent' }))
  return true
}

function escapeKey(host: EditingHost): Command {
  return (view) => {
    if (findBarOpen(view.state)) {
      closeSearchPanel(view)
      return true
    }
    if (view.state.selection.ranges.length > 1) return simplifySelection(view)
    // with unsaved text Esc does nothing more: a reflexive Esc then ↵ never reaches a warning's Save
    return host.unsaved()
  }
}

function keys(host: EditingHost): Extension {
  const own: KeyBinding[] = [
    ...historyKeymap.map((b) => ({ ...b, preventDefault: true })),
    { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
    // Linux: Ctrl+Shift+L is Send Reference to Agent
    ...(linux ? [] : [{ key: 'Mod-Shift-l', run: selectSelectionMatches, preventDefault: true }]),
    { key: 'Escape', run: escapeKey(host) },
    linux ? { key: 'Ctrl-Alt-ArrowUp', run: moveLineUp, preventDefault: true } : { key: 'Ctrl-Cmd-ArrowUp', run: moveLineUp, preventDefault: true },
    linux ? { key: 'Ctrl-Alt-ArrowDown', run: moveLineDown, preventDefault: true } : { key: 'Ctrl-Cmd-ArrowDown', run: moveLineDown, preventDefault: true },
    { key: 'Shift-Alt-ArrowUp', run: copyLineUp, preventDefault: true },
    { key: 'Shift-Alt-ArrowDown', run: copyLineDown, preventDefault: true },
    { key: 'Tab', run: insertIndent, shift: indentLess, preventDefault: true },
    // ⌥Z is the wrap's key: kept from the text even where the wrap cannot change (it would type Ω)
    { key: 'Alt-z', run: () => true, preventDefault: true },
    // a text field's Save on Linux, where the command's key is Ctrl+Shift+S
    ...(linux ? [{ key: 'Ctrl-s', run: () => (host.save(), true), preventDefault: true }] : []),
    ...closeBracketsKeymap,
  ]
  return keymap.of([...own, ...documentKeymap()])
}

// ── limits, clipboard, drops ───────────────────────────────────────────────────────────────────────

/** At most `max` selection ranges: the main one and those nearest it are kept. */
export function capSelection(ranges: readonly SelectionRange[], mainIndex: number, max: number): EditorSelection | null {
  if (ranges.length <= max) return null
  const main = ranges[mainIndex] as SelectionRange
  const kept = [...ranges].sort((a, b) => Math.abs(a.head - main.head) - Math.abs(b.head - main.head)).slice(0, max)
  kept.sort((a, b) => a.from - b.from)
  return EditorSelection.create(kept, kept.indexOf(main))
}

const cursorCap = EditorState.transactionFilter.of((tr) => {
  const sel = tr.newSelection
  const capped = capSelection(sel.ranges, sel.mainIndex, L.viewerCursorMax)
  return capped ? [tr, { selection: capped, sequential: true }] : tr
})

/** Typing and pasting stop at L.viewerEditMaxChars; what makes the document smaller, and the file's own text, always pass. */
const sizeCap = EditorState.changeFilter.of((tr) => !tr.docChanged || isFromDisk(tr) || tr.newDoc.length <= L.viewerEditMaxChars || tr.newDoc.length <= tr.startState.doc.length)

/** Copy, cut and a drag give the file's line ending (the document's own is `\n`). */
export function fileLineEnding(eol: LineEnding): Extension {
  return endingSlot.of(endingFilter(eol))
}

const endingSlot = new Compartment()

function endingFilter(eol: LineEnding): Extension {
  const br = lineBreakOf(eol)
  return br === '\n' ? [] : EditorView.clipboardOutputFilter.of((text) => text.replace(/\n/g, br))
}

/** The file's line ending changed (a merge took the file's): copy and cut give the new one. */
export function setFileLineEnding(view: EditorView, eol: LineEnding): void {
  view.dispatch({ effects: endingSlot.reconfigure(endingFilter(eol)) })
}

/** Dropped text is inserted; dropped files and the file panel's rows are not (CodeMirror would insert a file's text). */
const drops = EditorView.domEventHandlers({
  drop(e) {
    const types = e.dataTransfer ? [...e.dataTransfer.types] : []
    if (!types.includes('Files') && !types.includes(PATH_DRAG_TYPE)) return false
    e.preventDefault()
    return true
  },
})

/** The editable document's extensions. */
export function editing(o: EditingOptions): Extension {
  return [
    EditorState.allowMultipleSelections.of(true),
    EditorView.editable.of(true),
    EditorView.contentAttributes.of({ 'aria-readonly': 'false' }),
    indentUnit.of(o.indent),
    rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey }),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey),
    cursorCap,
    sizeCap,
    drops,
    o.aids,
    closeBrackets(),
    indentOnInput(),
    keys(o.host),
  ]
}
