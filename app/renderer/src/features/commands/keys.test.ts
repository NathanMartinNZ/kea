import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindings, COMMANDS, MAIN_COMMANDS, NATIVE_ROLES, parseShortcut, type KeyLabels } from '@kea/protocol'
import { darwin } from '@kea/protocol/os/darwin'
import { linux } from '@kea/protocol/os/linux'
import { selectorFor } from '../composer/keys.ts'
import { chordOf, copyHintDue, ctrlCopyPasteKeys, ctrlKeyRole, modClick, primaryHeld, primaryLabel, routeKey, scopedBinding, setBindings, terminalKeyOverride, type KeyLike, type RouteContext } from './keys.ts'

/** A keydown as Chromium reports it on a US layout; `mac`: ⌥ composes another character, as on a Mac (⌥⌘Q → œ). */
function key(spec: string, mac = true): KeyLike {
  const parts = spec.split('+')
  const name = parts.pop() as string
  const mods = new Set(parts)
  const shift = mods.has('shift')
  const CODES: Record<string, [string, string, string?]> = {
    '[': ['BracketLeft', '[', '{'],
    ']': ['BracketRight', ']', '}'],
    '=': ['Equal', '=', '+'],
    '-': ['Minus', '-', '_'],
    '`': ['Backquote', '`', '~'],
    ',': ['Comma', ',', '<'],
    '\\': ['Backslash', '\\', '|'],
    left: ['ArrowLeft', 'ArrowLeft'],
    right: ['ArrowRight', 'ArrowRight'],
    up: ['ArrowUp', 'ArrowUp'],
    down: ['ArrowDown', 'ArrowDown'],
    backspace: ['Backspace', 'Backspace'],
    enter: ['Enter', 'Enter'],
    tab: ['Tab', 'Tab'],
    escape: ['Escape', 'Escape'],
    insert: ['Insert', 'Insert'],
    home: ['Home', 'Home'],
    pageup: ['PageUp', 'PageUp'],
    pagedown: ['PageDown', 'PageDown'],
    ';': ['Semicolon', ';', ':'],
  }
  let code: string
  let k: string
  if (/^[a-z]$/.test(name)) {
    code = `Key${name.toUpperCase()}`
    // ⌥ composes another character on a Mac (⌥⌘Q → œ)
    k = mac && mods.has('alt') ? 'œ' : shift ? name.toUpperCase() : name
  } else if (/^[0-9]$/.test(name)) {
    code = `Digit${name}`
    k = shift ? '!' : name
  } else if (/^f\d+$/.test(name)) {
    code = name.toUpperCase()
    k = code
  } else {
    const c = CODES[name]
    if (!c) throw new Error(`no key ${name}`)
    code = c[0]
    k = shift && c[2] ? c[2] : c[1]
  }
  return { key: k, code, metaKey: mods.has('cmd'), ctrlKey: mods.has('ctrl'), altKey: mods.has('alt'), shiftKey: shift }
}

const ALL: RouteContext['has'] = (id) => !MAIN_COMMANDS.includes(id)
const term: RouteContext = { inTerminal: true, has: ALL }
const outside: RouteContext = { inTerminal: false, has: ALL }

/** Route by one system's rules and its column of the table (both systems run this suite). */
function routing(keys: KeyLabels): (e: KeyLike, ctx: RouteContext) => ReturnType<typeof routeKey> {
  beforeAll(() => setBindings(bindings(COMMANDS, keys)))
  afterAll(() => setBindings(bindings()))
  return (e, ctx) => routeKey(e, ctx, keys)
}

describe('key routing on macOS', () => {
  // macOS's rules and keys
  const routeKey = routing(darwin.keys)

  it('U-KB-1 · ⌘ bindings run their command from the terminal and from anywhere else', () => {
    for (const ctx of [term, outside]) {
      expect(routeKey(key('cmd+t'), ctx)).toEqual({ do: 'command', id: 'terminal.newShell' })
      expect(routeKey(key('cmd+w'), ctx)).toEqual({ do: 'command', id: 'terminal.closeTab' })
      expect(routeKey(key('cmd+shift+]'), ctx)).toEqual({ do: 'command', id: 'terminal.nextTab' })
      expect(routeKey(key('cmd+shift+['), ctx)).toEqual({ do: 'command', id: 'terminal.previousTab' })
      expect(routeKey(key('cmd+k'), ctx)).toEqual({ do: 'command', id: 'terminal.clear' })
      expect(routeKey(key('cmd+shift+p'), ctx)).toEqual({ do: 'command', id: 'view.palette' })
      expect(routeKey(key('cmd+f'), ctx)).toEqual({ do: 'command', id: 'terminal.find' })
      expect(routeKey(key('cmd+1'), ctx)).toEqual({ do: 'command', id: 'session.jumpTo', args: { index: 1 } })
      expect(routeKey(key('cmd+shift+backspace'), ctx)).toEqual({ do: 'command', id: 'session.archive' })
      expect(routeKey(key('cmd+alt+j'), ctx)).toEqual({ do: 'command', id: 'session.reportStatus' })
    }
  })

  it('U-KB-1 · ⌘+ works with and without ⇧ (the = key); ⌘− and ⌘0', () => {
    expect(routeKey(key('cmd+='), term)).toEqual({ do: 'command', id: 'terminal.fontBigger' })
    expect(routeKey(key('cmd+shift+='), term)).toEqual({ do: 'command', id: 'terminal.fontBigger' })
    expect(routeKey(key('cmd+-'), term)).toEqual({ do: 'command', id: 'terminal.fontSmaller' })
    expect(routeKey(key('cmd+0'), term)).toEqual({ do: 'command', id: 'terminal.fontReset' })
  })

  it('U-KB-1 · in a terminal ⌘← ⌘→ ⌘⌫ become ⌃A ⌃E ⌃U; elsewhere they are left to the focused field', () => {
    expect(routeKey(key('cmd+left'), term)).toEqual({ do: 'pty', data: '\x01' })
    expect(routeKey(key('cmd+right'), term)).toEqual({ do: 'pty', data: '\x05' })
    expect(routeKey(key('cmd+backspace'), term)).toEqual({ do: 'pty', data: '\x15' })
    for (const k of ['cmd+left', 'cmd+right', 'cmd+backspace']) expect(routeKey(key(k), outside)).toEqual({ do: 'pass' })
  })

  it('U-KB-1 · ⌃C, Esc, ⇧Tab, ⇧↵, ⌥-combos, function keys and plain keys are never taken from the terminal', () => {
    for (const k of ['ctrl+c', 'escape', 'shift+tab', 'shift+enter', 'ctrl+enter', 'alt+left', 'alt+right', 'alt+b', 'alt+backspace', 'f1', 'f5', 'f12', 'ctrl+a', 'ctrl+g', 'ctrl+`', 'a', 'enter', 'tab', ']', '[', 'alt+z', 'alt+down']) {
      expect(routeKey(key(k), term), k).toEqual({ do: 'pass' })
    }
  })

  it('U-KB-1 · the listed non-⌘ exceptions: ⌃Tab, ⌃⇧Tab, F6, ⇧F6 everywhere; ⌃` only outside the terminal', () => {
    for (const ctx of [term, outside]) {
      expect(routeKey(key('ctrl+tab'), ctx)).toEqual({ do: 'command', id: 'session.next' })
      expect(routeKey(key('ctrl+shift+tab'), ctx)).toEqual({ do: 'command', id: 'session.previous' })
      expect(routeKey(key('f6'), ctx)).toEqual({ do: 'command', id: 'view.cycleFocus', args: { step: 1 } })
      expect(routeKey(key('shift+f6'), ctx)).toEqual({ do: 'command', id: 'view.cycleFocus', args: { step: -1 } })
    }
    expect(routeKey(key('ctrl+`'), term)).toEqual({ do: 'pass' })
    expect(routeKey(key('ctrl+`'), outside)).toEqual({ do: 'command', id: 'terminal.focus' })
  })

  it('U-KB-1 · ⌘C / ⌘V are native menu roles; other ⌘ keys never reach the PTY, but the native menu may act on them', () => {
    expect(routeKey(key('cmd+c'), term)).toEqual({ do: 'native', id: 'terminal.copy' })
    expect(routeKey(key('cmd+v'), term)).toEqual({ do: 'native', id: 'terminal.paste' })
    expect(Object.keys(NATIVE_ROLES).sort()).toEqual(['terminal.copy', 'terminal.paste'])
    // ⌘A in a terminal selects the terminal's text, prevented so the Edit menu's role does not act; with no
    // terminal command built yet it is kept from the PTY like any ⌘ key
    expect(routeKey(key('cmd+a'), term)).toEqual({ do: 'command', id: 'terminal.selectAll' })
    expect(routeKey(key('cmd+a'), { inTerminal: true, has: () => false })).toEqual({ do: 'swallow' })
    // unbound (⌘H), main's own (⌥⌘Q, ⌘Q), or bound but not built yet
    expect(routeKey(key('cmd+h'), term)).toEqual({ do: 'swallow' })
    expect(routeKey(key('cmd+alt+q'), term)).toEqual({ do: 'swallow' })
    expect(routeKey(key('cmd+q'), term)).toEqual({ do: 'swallow' })
    const none: RouteContext = { inTerminal: true, has: () => false }
    expect(routeKey(key('cmd+b'), none)).toEqual({ do: 'swallow' })
    expect(routeKey(key('ctrl+tab'), none)).toEqual({ do: 'pass' })
    // outside a terminal an unbuilt or unbound ⌘ key is the field's (⌘A selects the input's text)
    expect(routeKey(key('cmd+a'), outside)).toEqual({ do: 'pass' })
    expect(routeKey(key('cmd+b'), { inTerminal: false, has: () => false })).toEqual({ do: 'pass' })
  })

  it("U-KB-4 · scoped bindings apply in their context only; a viewer's own non-⌘ keys stay with the viewer", () => {
    const viewer: RouteContext = { inTerminal: false, scopes: ['viewer tab'], has: ALL }
    const diff: RouteContext = { inTerminal: false, scopes: ['diff tab'], has: ALL }
    expect(routeKey(key('cmd+f'), viewer)).toEqual({ do: 'command', id: 'viewer.find' })
    expect(routeKey(key('cmd+l'), viewer)).toEqual({ do: 'command', id: 'viewer.sendReference' })
    expect(routeKey(key('cmd+l'), term)).toEqual({ do: 'swallow' })
    expect(routeKey(key(']'), diff)).toEqual({ do: 'pass' })
    expect(routeKey(key('cmd+shift+\\'), diff)).toEqual({ do: 'command', id: 'viewer.toggleDiffLayout' })
    // the detached overlay: ⌘↵ restarts; ↵ is the overlay's own key, passed to it; outside it neither is taken
    const overlay: RouteContext = { inTerminal: true, scopes: ['detached overlay'], has: ALL }
    expect(routeKey(key('cmd+enter'), overlay)).toEqual({ do: 'command', id: 'session.restart' })
    expect(routeKey(key('enter'), overlay)).toEqual({ do: 'pass' })
    expect(routeKey(key('cmd+enter'), term)).toEqual({ do: 'swallow' })
    expect(routeKey(key('enter'), term)).toEqual({ do: 'pass' })
  })

  it('U-KB-7 · a context in several scopes gets the bindings of each, the first scope winning a chord bound in two; its own keys are found the same way', () => {
    // a diff tab is a `diff tab` and a `viewer tab` (⌘⇧\\ is the diff tab's, ⌘F and ⌘L any viewer tab's)
    const diff: RouteContext = { inTerminal: false, scopes: ['diff tab', 'viewer tab'], has: ALL }
    expect(routeKey(key('cmd+shift+\\'), diff)).toEqual({ do: 'command', id: 'viewer.toggleDiffLayout' })
    expect(routeKey(key('cmd+f'), diff)).toEqual({ do: 'command', id: 'viewer.find' })
    expect(routeKey(key('cmd+l'), diff)).toEqual({ do: 'command', id: 'viewer.sendReference' })
    // ⌘↵ is bound in the file panel, in a viewer tab and in the detached overlay: the scope decides, in the order given
    expect(routeKey(key('cmd+enter'), { inTerminal: false, scopes: ['file panel'], has: ALL })).toEqual({ do: 'command', id: 'files.openInEditor' })
    expect(routeKey(key('cmd+enter'), { inTerminal: false, scopes: ['file tab', 'viewer tab'], has: ALL })).toEqual({ do: 'command', id: 'viewer.openInEditor' })
    expect(routeKey(key('cmd+enter'), { inTerminal: false, scopes: ['viewer tab', 'file panel'], has: ALL })).toEqual({ do: 'command', id: 'viewer.openInEditor' })
    expect(routeKey(key('cmd+enter'), { inTerminal: false, scopes: ['file panel', 'viewer tab'], has: ALL })).toEqual({ do: 'command', id: 'files.openInEditor' })
    // a file tab is not a diff tab: the diff's bindings do not apply, and with no scope ⌘F is the terminal's Find
    const file: RouteContext = { inTerminal: false, scopes: ['file tab', 'viewer tab'], has: ALL }
    expect(routeKey(key('cmd+shift+\\'), file)).toEqual({ do: 'pass' })
    expect(routeKey(key('cmd+f'), outside)).toEqual({ do: 'command', id: 'terminal.find' })
    // a scoped command that is not built is not replaced by the unscoped one on the same chord
    expect(routeKey(key('cmd+f'), { inTerminal: false, scopes: ['file tab', 'viewer tab'], has: (id) => id !== 'viewer.find' })).toEqual({ do: 'pass' })
    // the context's own keys (passed on by the router): which command a key is in these scopes
    expect(routeKey(key(']'), diff)).toEqual({ do: 'pass' })
    expect(scopedBinding(key(']'), ['diff tab', 'viewer tab'])).toMatchObject({ id: 'viewer.nextFile', scope: 'diff tab' })
    expect(scopedBinding(key('['), ['diff tab', 'viewer tab'])?.id).toBe('viewer.previousFile')
    expect(scopedBinding(key(']'), ['file tab', 'viewer tab'])).toBeUndefined()
    expect(scopedBinding(key('ctrl+g'), ['file tab', 'viewer tab'])?.id).toBe('viewer.goToLine')
    expect(scopedBinding(key('enter'), ['detached overlay'])?.id).toBe('session.resume')
    expect(scopedBinding(key('cmd+t'), ['diff tab', 'viewer tab']), 'an unscoped binding is the router\'s, not a context\'s own').toBeUndefined()
  })

  it('U-KB-1 · every unscoped ⌘ binding in the table routes to its own command', () => {
    for (const c of COMMANDS) {
      if (c.keyScope || NATIVE_ROLES[c.id] || MAIN_COMMANDS.includes(c.id)) continue
      for (const k of c.keys ?? []) {
        const chord = parseShortcut(k)
        if (!chord?.cmd) continue
        const spec = [chord.cmd && 'cmd', chord.ctrl && 'ctrl', chord.alt && 'alt', chord.shift && 'shift', chord.key].filter(Boolean).join('+')
        expect(routeKey(key(spec), term), `${c.id} ${k}`).toMatchObject({ do: 'command', id: c.id })
      }
    }
  })

  it('U-KB-1 · chords: letters follow the character, ⌥-composed letters fall back to the physical key', () => {
    expect(chordOf(key('cmd+shift+]'))).toBe('cmd+shift+]')
    expect(chordOf(key('cmd+alt+q'))).toBe('cmd+alt+q')
    expect(chordOf({ key: 'q', code: 'KeyA', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe('cmd+q') // AZERTY
    expect(chordOf({ key: 'Meta', code: 'MetaLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull()
  })
})

describe('terminal key overrides', () => {
  it('U-TERM-21 · ⇧↵ sends a newline while the program has not enabled the kitty keyboard protocol; with it, xterm encodes ⇧↵', () => {
    expect(terminalKeyOverride(key('shift+enter'), 0)).toBe('\n')
    expect(terminalKeyOverride(key('shift+enter'), 1)).toBeNull()
    expect(terminalKeyOverride(key('enter'), 0)).toBeNull()
    expect(terminalKeyOverride(key('ctrl+enter'), 0)).toBeNull()
    expect(terminalKeyOverride(key('shift+alt+enter'), 0)).toBeNull()
  })
})

describe('key routing on Linux', () => {
  // Linux's rules and its column of the table, on every system
  const route = routing(linux.keys)
  const k = (spec: string) => key(spec, false)

  it('U-PLT-41 · Ctrl+Shift bindings run their command from the terminal and from anywhere else; every unscoped one of the Linux column routes to its own command', () => {
    for (const ctx of [term, outside]) {
      expect(route(k('ctrl+shift+t'), ctx)).toEqual({ do: 'command', id: 'terminal.newShell' })
      expect(route(k('ctrl+shift+w'), ctx)).toEqual({ do: 'command', id: 'terminal.closeTab' })
      expect(route(k('ctrl+shift+]'), ctx)).toEqual({ do: 'command', id: 'terminal.nextTab' })
      expect(route(k('ctrl+shift+p'), ctx)).toEqual({ do: 'command', id: 'files.goToFile' })
      expect(route(k('ctrl+shift+alt+p'), ctx)).toEqual({ do: 'command', id: 'view.palette' })
      expect(route(k('ctrl+shift+1'), ctx)).toEqual({ do: 'command', id: 'session.jumpTo', args: { index: 1 } })
      expect(route(k('ctrl+shift+backspace'), ctx)).toEqual({ do: 'command', id: 'session.archive' })
      expect(route(k('ctrl+shift+alt+j'), ctx)).toEqual({ do: 'command', id: 'session.reportStatus' })
      expect(route(k('ctrl+shift+='), ctx)).toEqual({ do: 'command', id: 'terminal.fontBigger' })
      expect(route(k('ctrl+shift+-'), ctx)).toEqual({ do: 'command', id: 'terminal.fontSmaller' })
      expect(route(k('ctrl+shift+f5'), ctx)).toEqual({ do: 'command', id: 'server.restart' })
      expect(route(k('ctrl+shift+pagedown'), ctx)).toEqual({ do: 'command', id: 'view.focusAgent' })
      expect(route(k('ctrl+shift+pageup'), ctx)).toEqual({ do: 'command', id: 'view.focusWork' })
    }
    for (const c of COMMANDS) {
      if (c.keyScope || NATIVE_ROLES[c.id] || MAIN_COMMANDS.includes(c.id)) continue
      for (const s of c.linuxKeys ?? []) {
        const chord = parseShortcut(s)!
        const spec = [chord.ctrl && 'ctrl', chord.alt && 'alt', chord.shift && 'shift', chord.key].filter(Boolean).join('+')
        for (const ctx of chord.key === '`' ? [outside] : [term, outside]) expect(route(k(spec), ctx), `${c.id} ${s}`).toMatchObject({ do: 'command', id: c.id })
      }
    }
  })

  it('U-PLT-41 · Ctrl+<key> always reaches the terminal; there are no Mac text-editing keys; a Ctrl+Shift letter, digit or punctuation key no command has is kept from it, a Ctrl+Shift arrow, Home or F-key is not', () => {
    for (const s of ['ctrl+c', 'ctrl+w', 'ctrl+t', 'ctrl+k', 'ctrl+p', 'ctrl+r', 'ctrl+n', 'ctrl+a', 'ctrl+e', 'ctrl+u', 'ctrl+d', 'ctrl+z', 'ctrl+g', 'ctrl+left', 'ctrl+right', 'ctrl+enter', 'ctrl+backspace', 'ctrl+-', 'ctrl+=', 'ctrl+1', 'home', 'escape', 'shift+tab', 'shift+enter', 'alt+b', 'alt+left', 'alt+z', 'alt+g', 'f1', 'f5', 'f12', 'a', ']']) {
      expect(route(k(s), term), s).toEqual({ do: 'pass' })
    }
    // ⌘← ⌘→ ⌘⌫ are macOS's: Super+← is not Kea's at all
    for (const s of ['cmd+left', 'cmd+right', 'cmd+backspace', 'cmd+t']) expect(route(k(s), term), s).toEqual({ do: 'pass' })
    // xterm sends nothing for these (Ctrl+Shift+A is no ⌃A), so keeping them takes nothing a program reads
    for (const s of ['ctrl+shift+a', 'ctrl+shift+z', 'ctrl+shift+;', 'ctrl+shift+alt+x', 'ctrl+shift+q', 'ctrl+shift+alt+q']) {
      expect(route(k(s), term), s).toEqual({ do: 'swallow' })
      expect(route(k(s), outside), s).toEqual({ do: 'pass' })
    }
    // a program tells these from the plain ones (CSI 1;6D), so it gets them
    for (const s of ['ctrl+shift+left', 'ctrl+shift+up', 'ctrl+shift+home', 'ctrl+pageup', 'ctrl+pagedown', 'ctrl+shift+f2', 'ctrl+shift+enter']) expect(route(k(s), term), s).toEqual({ do: 'pass' })
    // a command's key that cannot run now is still never the program's
    expect(route(k('ctrl+shift+w'), { inTerminal: true, has: () => false })).toEqual({ do: 'swallow' })
    expect(route(k('ctrl+shift+backspace'), { inTerminal: true, has: () => false })).toEqual({ do: 'swallow' })
    // the few intercepted keys without the primary modifier, as on macOS
    for (const ctx of [term, outside]) {
      expect(route(k('ctrl+tab'), ctx)).toEqual({ do: 'command', id: 'session.next' })
      expect(route(k('ctrl+shift+tab'), ctx)).toEqual({ do: 'command', id: 'session.previous' })
      expect(route(k('f6'), ctx)).toEqual({ do: 'command', id: 'view.cycleFocus', args: { step: 1 } })
      expect(route(k('shift+f6'), ctx)).toEqual({ do: 'command', id: 'view.cycleFocus', args: { step: -1 } })
    }
    expect(route(k('ctrl+`'), term)).toEqual({ do: 'pass' })
    expect(route(k('ctrl+`'), outside)).toEqual({ do: 'command', id: 'terminal.focus' })
  })

  it('U-PLT-41 · copy is Ctrl+Shift+C or Ctrl+Insert and paste Ctrl+Shift+V or Shift+Insert, run by the router through the Edit role; with nothing to copy the key is still kept from the terminal', () => {
    for (const ctx of [term, outside]) {
      expect(route(k('ctrl+shift+c'), ctx)).toEqual({ do: 'edit', id: 'terminal.copy', role: 'copy' })
      expect(route(k('ctrl+insert'), ctx)).toEqual({ do: 'edit', id: 'terminal.copy', role: 'copy' })
      expect(route(k('ctrl+shift+v'), ctx)).toEqual({ do: 'edit', id: 'terminal.paste', role: 'paste' })
      expect(route(k('shift+insert'), ctx)).toEqual({ do: 'edit', id: 'terminal.paste', role: 'paste' })
    }
    const nothingSelected: RouteContext['has'] = (id) => id !== 'terminal.copy'
    expect(route(k('ctrl+shift+c'), { inTerminal: true, has: nothingSelected })).toEqual({ do: 'swallow' })
    expect(route(k('ctrl+insert'), { inTerminal: true, has: nothingSelected })).toEqual({ do: 'swallow' })
    expect(route(k('ctrl+shift+c'), { inTerminal: false, has: nothingSelected })).toEqual({ do: 'pass' })
    // a text field keeps its own Ctrl+C / Ctrl+V
    expect(route(k('ctrl+c'), outside)).toEqual({ do: 'pass' })
    expect(route(k('ctrl+v'), outside)).toEqual({ do: 'pass' })
  })

  it("U-PLT-41 · scoped Ctrl+Shift bindings apply in their context; copy and paste keep working in a viewer; the viewer's own Alt keys stay with it", () => {
    const viewer: RouteContext = { inTerminal: false, scopes: ['file tab', 'viewer tab'], has: ALL }
    expect(route(k('ctrl+shift+f'), viewer)).toEqual({ do: 'command', id: 'viewer.find' })
    expect(route(k('ctrl+shift+alt+c'), viewer)).toEqual({ do: 'command', id: 'viewer.copyReference' })
    expect(route(k('ctrl+shift+c'), viewer)).toEqual({ do: 'edit', id: 'terminal.copy', role: 'copy' })
    expect(route(k('ctrl+shift+enter'), viewer)).toEqual({ do: 'command', id: 'viewer.openInEditor' })
    expect(route(k('alt+g'), viewer)).toEqual({ do: 'pass' })
    expect(scopedBinding(k('alt+g'), ['file tab', 'viewer tab'])?.id).toBe('viewer.goToLine')
    expect(scopedBinding(k('alt+z'), ['file tab', 'viewer tab'])?.id).toBe('viewer.toggleWrap')
    expect(route(k('ctrl+shift+alt+v'), { inTerminal: false, scopes: ['Markdown file', 'file tab', 'viewer tab'], has: ALL })).toEqual({ do: 'command', id: 'viewer.toggleMarkdownPreview' })
    const overlay: RouteContext = { inTerminal: true, scopes: ['detached overlay'], has: ALL }
    expect(route(k('ctrl+shift+enter'), overlay)).toEqual({ do: 'command', id: 'session.restart' })
    expect(route(k('enter'), overlay)).toEqual({ do: 'pass' })
  })

  it('U-PLT-41 · the composer, the palette and links: Ctrl+Shift+1…4 open the selectors, Ctrl+Shift+Enter starts, labels read Ctrl+Shift+…, a link opens with Ctrl+click', () => {
    expect(['1', '2', '3', '4'].map((d) => selectorFor(k(`ctrl+shift+${d}`), linux.keys))).toEqual(['agent', 'model', 'effort', 'mode'])
    expect([selectorFor(k('cmd+1'), linux.keys), selectorFor(k('ctrl+1'), linux.keys), selectorFor(k('ctrl+shift+alt+1'), linux.keys), selectorFor(k('ctrl+shift+5'), linux.keys)]).toEqual([null, null, null, null])
    expect(primaryHeld(k('ctrl+shift+enter'), linux.keys)).toBe(true)
    expect(primaryHeld(k('ctrl+shift+alt+enter'), linux.keys)).toBe(true)
    expect(primaryHeld(k('ctrl+enter'), linux.keys)).toBe(false)
    expect(primaryHeld(k('cmd+enter'), linux.keys)).toBe(false)
    expect([primaryLabel('1', false, linux.keys), primaryLabel('enter', false, linux.keys), primaryLabel('enter', true, linux.keys)]).toEqual(['Ctrl+Shift+1', 'Ctrl+Shift+Enter', 'Ctrl+Shift+Alt+Enter'])
    expect([primaryLabel('1', false, darwin.keys), primaryLabel('enter', false, darwin.keys), primaryLabel('enter', true, darwin.keys)]).toEqual(['⌘1', '⌘↵', '⌥⌘↵'])
    expect([modClick({ metaKey: false, ctrlKey: true }, linux.keys), modClick({ metaKey: true, ctrlKey: false }, linux.keys)]).toEqual([true, false])
    expect([modClick({ metaKey: true, ctrlKey: false }, darwin.keys), modClick({ metaKey: false, ctrlKey: true }, darwin.keys)]).toEqual([true, false])
  })
})

describe('plain Ctrl+C and Ctrl+V on Linux', () => {
  const route = routing(linux.keys)
  const k = (spec: string) => key(spec, false)
  const on = { ...term, ctrlCopyPaste: true }

  it('U-PLT-58 · with the setting on, Ctrl+C copies text the person selected in a terminal and Ctrl+V pastes; with nothing selected, or the find bar’s match, Ctrl+C interrupts', () => {
    expect(route(k('ctrl+c'), { ...on, userSelection: true })).toEqual({ do: 'edit', id: 'terminal.copy', role: 'copy', plain: true })
    expect(route(k('ctrl+c'), { ...on, userSelection: false })).toEqual({ do: 'pass' }) // none, or the find bar's
    expect(route(k('ctrl+c'), on)).toEqual({ do: 'pass' })
    expect(route(k('ctrl+v'), on)).toEqual({ do: 'edit', id: 'terminal.paste', role: 'paste', plain: true })
    expect(route(k('ctrl+v'), { ...on, userSelection: true })).toEqual({ do: 'edit', id: 'terminal.paste', role: 'paste', plain: true })
    // the shifted keys are the same with it on or off, and plain: false
    expect(route(k('ctrl+shift+c'), { ...on, userSelection: true })).toEqual({ do: 'edit', id: 'terminal.copy', role: 'copy' })
    expect(route(k('ctrl+shift+v'), on)).toEqual({ do: 'edit', id: 'terminal.paste', role: 'paste' })
    // other Ctrl keys stay the terminal's
    for (const s of ['ctrl+x', 'ctrl+z', 'ctrl+d', 'ctrl+alt+c', 'ctrl+alt+v']) expect(route(k(s), { ...on, userSelection: true }), s).toEqual({ do: 'pass' })
  })

  it('U-PLT-58 · with the setting off, or outside a terminal, or on macOS, Ctrl+C and Ctrl+V are not Kea’s', () => {
    for (const s of ['ctrl+c', 'ctrl+v']) {
      expect(route(k(s), { ...term, userSelection: true }), s).toEqual({ do: 'pass' })
      expect(route(k(s), { ...term, ctrlCopyPaste: false, userSelection: true }), s).toEqual({ do: 'pass' })
      // a field keeps its own Ctrl+C and Ctrl+V
      expect(route(k(s), { ...outside, ctrlCopyPaste: true, userSelection: true }), s).toEqual({ do: 'pass' })
      expect(ctrlKeyRole(s, { ...on, userSelection: true }, darwin.keys), s).toBeNull() // macOS copies with ⌘C
    }
    expect(ctrlKeyRole('ctrl+c', { ...on, userSelection: true }, linux.keys)).toBe('copy')
    // the key lists show the extra keys while it is on, on Linux only
    expect([ctrlCopyPasteKeys('terminal.copy', true, linux.keys), ctrlCopyPasteKeys('terminal.paste', true, linux.keys)]).toEqual([['Ctrl+C'], ['Ctrl+V']])
    expect(ctrlCopyPasteKeys('terminal.copy', false, linux.keys)).toEqual([])
    expect(ctrlCopyPasteKeys('terminal.copy', true, darwin.keys)).toEqual([])
    expect(ctrlCopyPasteKeys('session.new', true, linux.keys)).toEqual([])
  })

  it('U-TERM-55 · the copy hint’s moment: Ctrl+C over text the person selected in a terminal, on Linux, with the setting off', () => {
    const sel = { ...term, userSelection: true }
    expect(copyHintDue('ctrl+c', sel, linux.keys)).toBe(true)
    expect(copyHintDue('ctrl+c', { ...sel, userSelection: false }, linux.keys)).toBe(false) // nothing to copy: an interrupt was meant
    expect(copyHintDue('ctrl+c', term, linux.keys)).toBe(false)
    expect(copyHintDue('ctrl+c', { ...sel, ctrlCopyPaste: true }, linux.keys)).toBe(false) // it copied
    expect(copyHintDue('ctrl+c', { ...outside, userSelection: true }, linux.keys)).toBe(false)
    expect(copyHintDue('ctrl+c', sel, darwin.keys)).toBe(false)
    expect(copyHintDue('ctrl+v', sel, linux.keys)).toBe(false)
    expect(copyHintDue(null, sel, linux.keys)).toBe(false)
  })
})

