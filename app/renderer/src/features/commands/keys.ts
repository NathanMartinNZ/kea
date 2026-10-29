// Key routing: every keydown is checked against the app's bindings before any element sees it. "Primary" is the
// system's app modifier: ⌘ on macOS, Ctrl+Shift on Linux.
//
//   primary bindings               → the command runs; the event never reaches the terminal
//   ⌃Tab, ⌃⇧Tab, F6, ⇧F6           → intercepted everywhere, though not primary
//   ⌃`                             → intercepted only while focus is outside the terminal
//   ⌘←, ⌘→, ⌘⌫ in a terminal       → ⌃A, ⌃E, ⌃U for the PTY (macOS only); they are not app bindings
//   copy, paste                    → macOS: native menu roles, whose ⌘C / ⌘V are the menu's (copy / paste events
//                                    reach the focused element); Linux: the router asks main for the role
//                                    (Ctrl+Shift+C / V, Ctrl+Insert, Shift+Insert), the menu registering no key
//   ⌘A in a terminal               → Select All of the terminal's text (macOS; on Linux Ctrl+A is the shell's)
//   Ctrl+C, Ctrl+V in a terminal   → Linux with `terminal.ctrlCopyPaste` on: the copy role while the person has
//                                    selected text there (else the PTY's interrupt), the paste role; off, the PTY's,
//                                    and Ctrl+C over such a selection is the moment of a one-time hint
//   a scoped binding               → only while its context has the keyboard (`scope.ts`); a scoped key without
//                                    primary is the context's own and is passed to it (a viewer's keys; ↵ in the
//                                    detached overlay; F2 and ⌦ in the file tree), which finds its command with
//                                    `scopedBinding`
//   a `file panel` primary binding → while the panel has the keyboard, the command (⌘X ⌘C ⌘V ⌘Z: the tree's Cut, Copy,
//                                    Paste, Undo); prevented also when it cannot run, so neither the page's own editing
//                                    (undo, copying a stale selection) nor the Edit menu's roles act there
//   any other primary key in a     → kept from the PTY; the native menu may still act on it (⌘H, ⌘M, ⌘Q). On Linux
//   terminal                         a Ctrl+Shift arrow, Home, F-key… no command takes reaches the PTY (the OS
//                                    layer's `keptFromTerminal`)
//   everything else                → the focused element (in a terminal: the PTY), untouched; on Linux every
//                                    Ctrl+<key> is so
//
// The bindings matched are the table's defaults until `setBindings` gives the ones in use: the defaults with the
// person's `keybindings.json` applied (`bindings.svelte.ts` follows core's store and calls it).
//
// Pure functions over a KeyboardEvent-like object, so the table is unit-tested (U-KB-1; Linux's rules U-PLT-41).

import { bindings, NATIVE_ROLES, parseChord, protocolOs, SELECT_ALL_COMMAND, type Binding, type KeyLabels, type KeyScope } from '@kea/protocol'

// The router's chord lists are the OS layer's (`keys`): the keybindings file is validated against the same ones

export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const CODE_KEYS: Readonly<Record<string, string>> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  NumpadAdd: '=',
  NumpadSubtract: '-',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Backspace: 'backspace',
  Tab: 'tab',
  Escape: 'escape',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Space: 'space',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Insert: 'insert',
}

/**
 * The canonical key of an event. Letters and digits follow the character (so `⌘Q` is Q on any layout) unless a
 * modifier composed something else (`⌥⌘Q` gives `œ`), then the physical key; punctuation follows the physical key.
 */
export function keyOf(e: KeyLike): string | null {
  if (/^[a-zA-Z0-9]$/.test(e.key)) return e.key.toLowerCase()
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(c)) return c.slice(5)
  if (/^Numpad[0-9]$/.test(c)) return c.slice(6)
  if (/^F([1-9]|1[0-9])$/.test(c)) return c.toLowerCase()
  return CODE_KEYS[c] ?? null
}

/** `cmd+shift+]`, in the order `chordText` (protocol) writes; null for a bare modifier or an unknown key. */
export function chordOf(e: KeyLike): string | null {
  const key = keyOf(e)
  if (!key) return null
  return `${e.metaKey ? 'cmd+' : ''}${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${key}`
}

export type Route =
  /** Run the command; preventDefault so neither the element nor the menu acts. */
  | { do: 'command'; id: string; args?: unknown }
  /** A native menu role acts (copy / paste) by the menu's own key (macOS); the terminal's own key handling never sees the key. */
  | { do: 'native'; id: string }
  /**
   * Copy or paste where the menu has no key for it (Linux): main runs the role on the focused element; preventDefault.
   * `plain`: by plain Ctrl+C or Ctrl+V (`ctrlKeyRole`), whose copy clears the terminal's selection once it has run.
   */
  | { do: 'edit'; id: string; role: 'copy' | 'paste'; plain?: true }
  /** Send these bytes to the PTY instead. */
  | { do: 'pty'; data: string }
  /** Keep the key from the terminal, but let the native menu act on it. */
  | { do: 'swallow' }
  /** Keep the key from everything, the page and the menu's roles included (the file list's own keys while they cannot run). */
  | { do: 'prevent' }
  /** Not Kea's: the focused element gets it unchanged. */
  | { do: 'pass' }

export interface RouteContext {
  /** Keyboard focus is in a terminal. */
  inTerminal: boolean
  /** The focused context's scopes for scoped bindings (viewer tab, diff tab, …), most specific first; none in a terminal. */
  scopes?: readonly KeyScope[]
  /** A handler for the command exists and allows it now (with the binding's argument, e.g. `⌘3`'s index). */
  has(id: string, args?: unknown): boolean
  /** Plain Ctrl+C and Ctrl+V copy and paste in a terminal (`terminal.ctrlCopyPaste`), where the router owns the clipboard. */
  ctrlCopyPaste?: boolean
  /** The terminal with the keyboard holds text the person selected (not the find bar's match). */
  userSelection?: boolean
}

const BY_CHORD = new Map<string, Binding[]>() // bounded: one entry per binding in use (≤ the command table's keys plus one per command)

/** The bindings to match from now on: the table's defaults, or those with the person's file applied. */
export function setBindings(list: readonly Binding[]): void {
  BY_CHORD.clear()
  for (const b of list) {
    const at = BY_CHORD.get(b.chord)
    if (at) at.push(b)
    else BY_CHORD.set(b.chord, [b])
  }
}
setBindings(bindings())

/** Chords matched now (the resource report's `keyChords`). */
export function bindingChords(): number {
  return BY_CHORD.size
}

/** The chord's binding in the first of `scopes` that binds it. */
function scoped(list: readonly Binding[], scopes: readonly KeyScope[]): Binding | undefined {
  for (const s of scopes) {
    const b = list.find((x) => x.scope === s)
    if (b) return b
  }
  return undefined
}

function lookup(chord: string, scopes: readonly KeyScope[]): Binding | undefined {
  const list = BY_CHORD.get(chord)
  if (list) return scoped(list, scopes) ?? list.find((b) => b.scope === null)
  // ⌘+ is typed with or without ⇧ (the = key); ⌘− likewise
  if (/\+shift\+[=-]$/.test(chord)) return lookup(chord.replace('shift+', ''), scopes)
  return undefined
}

/**
 * A context's own key: the command a keydown is bound to in one of `scopes` (most specific first), or undefined. The
 * router passes a scoped key without the primary modifier on to its context; the context asks here which command it is
 * (`]` in a diff tab, `⌥Z` in a file tab, `↵` in the detached overlay) and runs it.
 */
export function scopedBinding(e: KeyLike, scopes: readonly KeyScope[]): Binding | undefined {
  const chord = chordOf(e)
  const list = chord ? BY_CHORD.get(chord) : undefined
  return list ? scoped(list, scopes) : undefined
}

/**
 * Where a keydown goes, by this system's rules (`keys`). The bindings matched are the ones `setBindings` gave, which
 * are this system's.
 */
export function routeKey(e: KeyLike, ctx: RouteContext, keys: KeyLabels = protocolOs.keys): Route {
  const chord = chordOf(e)
  if (!chord) return { do: 'pass' }
  const plain = ctrlKeyRole(chord, ctx, keys)
  if (plain) return { do: 'edit', id: plain === 'copy' ? 'terminal.copy' : 'terminal.paste', role: plain, plain: true }
  const text = keys.terminalText[chord]
  if (ctx.inTerminal && text !== undefined) return { do: 'pty', data: text }
  // Select All in a terminal selects its text; prevented, so the Edit menu's role does not select the hidden textarea
  if (ctx.inTerminal && chord === keys.terminalSelectAll) return ctx.has(SELECT_ALL_COMMAND) ? { do: 'command', id: SELECT_ALL_COMMAND } : { do: 'swallow' }
  const c = parseChord(chord)
  if (!c) return { do: 'pass' }
  const b = lookup(chord, ctx.scopes ?? [])
  if (b) {
    const role = NATIVE_ROLES[b.id]
    if (role && keys.clipboard === 'menu') return { do: 'native', id: b.id }
    // Linux: copy with nothing selected does nothing, and its key still never reaches the PTY
    if (role) return ctx.has(b.id, b.args) ? { do: 'edit', id: b.id, role } : ctx.inTerminal ? { do: 'swallow' } : { do: 'pass' }
    const rule = keys.intercepts[chord]
    const intercepted = keys.primary(c) || rule === 'always' || (rule === 'outsideTerminal' && !ctx.inTerminal)
    if (intercepted && ctx.has(b.id, b.args)) return { do: 'command', id: b.id, ...(b.args !== undefined ? { args: b.args } : {}) }
    if (b.scope === 'file panel' && keys.primary(c)) return { do: 'prevent' }
  }
  // The text-editing keys are the only ⌘ combinations that reach the PTY (on Linux: see `keptFromTerminal`)
  return ctx.inTerminal && keys.keptFromTerminal(c, b !== undefined) ? { do: 'swallow' } : { do: 'pass' }
}

/**
 * What plain Ctrl+C or Ctrl+V does in a terminal where the router owns the clipboard (Linux) and the person asked for
 * it (`terminal.ctrlCopyPaste`): Ctrl+C copies while they have text selected there, Ctrl+V pastes. Null: the key is
 * the terminal's own (Ctrl+C with nothing selected interrupts).
 */
export function ctrlKeyRole(chord: string, ctx: RouteContext, keys: KeyLabels = protocolOs.keys): 'copy' | 'paste' | null {
  if (!ctx.inTerminal || !ctx.ctrlCopyPaste || keys.clipboard !== 'router') return null
  if (chord === 'ctrl+c') return ctx.userSelection ? 'copy' : null
  return chord === 'ctrl+v' ? 'paste' : null
}

/**
 * The one-time copy hint's moment: plain Ctrl+C in a terminal over text the person selected, on a system where it
 * interrupts rather than copies (Linux, `terminal.ctrlCopyPaste` off). The key still goes to the PTY.
 */
export function copyHintDue(chord: string | null, ctx: RouteContext, keys: KeyLabels = protocolOs.keys): boolean {
  return chord === 'ctrl+c' && ctx.inTerminal && !ctx.ctrlCopyPaste && ctx.userSelection === true && keys.clipboard === 'router'
}

/** The keys `terminal.ctrlCopyPaste` adds to Copy and Paste while it is on, as the key lists show them (Linux's only). */
export function ctrlCopyPasteKeys(id: string, on: boolean, keys: KeyLabels = protocolOs.keys): string[] {
  if (!on || keys.clipboard !== 'router') return []
  const key = id === 'terminal.copy' ? 'c' : id === 'terminal.paste' ? 'v' : null
  return key ? [keys.label({ cmd: false, ctrl: true, alt: false, shift: false, key })] : []
}

/**
 * The key the router gives Select All in a terminal (`⌘A` on macOS), as the key lists show it; none for any other
 * command, and none on Linux, where `Ctrl+A` is the shell's.
 */
export function selectAllKeys(id: string, keys: KeyLabels = protocolOs.keys): string[] {
  const c = id === SELECT_ALL_COMMAND && keys.terminalSelectAll ? parseChord(keys.terminalSelectAll) : null
  return c ? [keys.label(c)] : []
}

/** The system's primary modifier is down, whatever else is (`⌘`; `Ctrl+Shift` without Super on Linux). */
export function primaryDown(e: KeyLike | MouseEvent, keys: KeyLabels = protocolOs.keys): boolean {
  return keys.primary({ cmd: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key: '' })
}

/** The keydown holds the system's primary modifier and nothing else but, at will, Alt: `⌘↵` / `⌥⌘↵` on macOS, `Ctrl+Shift+Enter` / `Ctrl+Shift+Alt+Enter` on Linux. */
export function primaryHeld(e: KeyLike, keys: KeyLabels = protocolOs.keys): boolean {
  const m = keys.primaryMods
  return e.metaKey === m.cmd && e.ctrlKey === m.ctrl && e.shiftKey === m.shift
}

/** A key with the primary modifier as a label shows it (`⌘1`, `⌥⌘↵`; `Ctrl+Shift+1`, `Ctrl+Shift+Alt+Enter`). `key` is a chord's key (`1`, `enter`). */
export function primaryLabel(key: string, alt = false, keys: KeyLabels = protocolOs.keys): string {
  const m = keys.primaryMods
  return keys.label({ cmd: m.cmd, ctrl: m.ctrl, shift: m.shift, alt, key })
}

/** A click with the modifier that asks for the other action (a terminal link, a palette or finder row): `⌘` on macOS, `Ctrl` on Linux. */
export function modClick(e: { metaKey: boolean; ctrlKey: boolean }, keys: KeyLabels = protocolOs.keys): boolean {
  return keys.modClick(e)
}

/**
 * Keys the terminal itself translates before xterm encodes them: `⇧↵` sends `\n` while the program has not enabled the
 * kitty keyboard protocol (with it, xterm encodes `⇧↵` per the protocol). Returns the bytes to send, or null to let
 * xterm handle the key.
 */
export function terminalKeyOverride(e: KeyLike, kittyFlags: number): string | null {
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && kittyFlags === 0) return '\n'
  return null
}
