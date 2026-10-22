import { describe, expect, it } from 'vitest'
import { bindings, chordAccelerator, chordLabel, chordText, COMMANDS, parseChord, toAccelerator, zMenuState } from './commands.ts'
import { L } from './generated/limits.ts'
import { conflictText, DEFAULT_BINDINGS, effectiveBindings, keybindingsTemplate, parseKeyText, readKeybindings, rebindable } from './keybindings.ts'
import { darwin } from './os/darwin.ts'
import { linux } from './os/linux.ts'

// macOS's rules, on every system (both run this suite); Linux's have a test of their own (U-PLT-40)
const mac = darwin.keys

const chord = (s: string): string | null => {
  const c = parseKeyText(s, mac)
  return c ? chordText(c) : null
}

describe('keybindings.json', () => {
  it('U-KB-8 · a key is read as written by hand: modifiers in any order and case, named keys, the command table’s own notation; anything that is not one chord is refused', () => {
    expect(chord('cmd+shift+r')).toBe('cmd+shift+r')
    expect(chord('Shift+Cmd+R')).toBe('cmd+shift+r')
    expect(chord(' command + option + j ')).toBe('cmd+alt+j')
    expect(chord('ctrl+tab')).toBe('ctrl+tab')
    expect(chord('meta+enter')).toBe('cmd+enter')
    expect(chord('cmd+return')).toBe('cmd+enter')
    expect(chord('cmd+esc')).toBe('cmd+escape')
    expect(chord('cmd+plus')).toBe('cmd+=')
    expect(chord('cmd++')).toBe('cmd+=')
    expect(chord('cmd+minus')).toBe('cmd+-')
    expect(chord('cmd+shift+]')).toBe('cmd+shift+]')
    expect(chord('cmd+,')).toBe('cmd+,')
    expect(chord('f6')).toBe('f6')
    expect(chord('shift+F12')).toBe('shift+f12')
    expect(chord('cmd+arrowup')).toBe('cmd+up')
    expect(chord('⇧⌘R')).toBe('cmd+shift+r')
    expect(chord('⌥⌘J')).toBe('cmd+alt+j')
    for (const bad of ['', 'cmd', 'cmd+shift', 'cmd+r+t', 'hyper+r', 'cmd+cmd+r', 'cmd+f25', 'cmd+é', 'cmd+{', '⌘', 'cmd+ab']) expect(chord(bad), bad).toBeNull()
    // a word every object knows is no modifier and no key
    for (const bad of ['constructor+cmd+r', '__proto__+cmd+r', 'toString+r', 'cmd+constructor', 'cmd+__proto__', 'cmd+valueOf']) expect(chord(bad), bad).toBeNull()
    // every default of the table reads back as the chord the router matches
    for (const b of bindings(COMMANDS, mac)) expect(chordText(parseChord(b.chord)!), b.chord).toBe(b.chord)
  })

  it('U-KB-8 · a chord is shown in the command table’s notation and as an accelerator; the table’s own chords give the accelerators the menu bar already shows', () => {
    expect(chordLabel('cmd+shift+r', mac)).toBe('⇧⌘R')
    expect(chordLabel('cmd+ctrl+alt+shift+k', mac)).toBe('⌃⌥⇧⌘K')
    expect(chordLabel('cmd+enter', mac)).toBe('⌘↵')
    expect(chordLabel('cmd+=', mac)).toBe('⌘+')
    expect(chordLabel('cmd+-', mac)).toBe('⌘−')
    expect(chordLabel('shift+f6', mac)).toBe('⇧F6')
    expect(chordLabel('ctrl+tab', mac)).toBe('⌃Tab')
    expect(chordAccelerator('cmd+shift+r')).toBe('Cmd+Shift+R')
    expect(chordAccelerator('cmd+alt+j')).toBe('Cmd+Alt+J')
    expect(chordAccelerator('cmd+=')).toBe('Cmd+Plus')
    expect(chordAccelerator('cmd+shift+backspace')).toBe('Cmd+Shift+Backspace')
    expect(chordAccelerator('nonsense+q')).toBeNull()
    for (const c of COMMANDS) for (const k of c.keys ?? []) expect(chordAccelerator(chord(k)!), `${c.id} ${k}`).toBe(toAccelerator(k))
  })

  it('U-KB-8 · entries are validated one by one: a broken one is left out with its reason and the others apply; a command’s last entry counts', () => {
    const r = readKeybindings([
      { command: 'server.toggle', key: 'cmd+shift+y' },
      { command: 'no.such', key: 'cmd+y' },
      { command: 'session.archive', key: null },
      { command: 'terminal.find', key: 'ctrl+f' }, // no ⌘: it would take ⌃F from a program in a terminal
      { command: 'viewer.toggleWrap', key: 'alt+w' }, // a viewer tab's own key may do without ⌘, as its default does
      { command: 'terminal.clear', key: 'cmd+left' }, // a Mac text-editing key
      { command: 'terminal.newShell', key: 'cmd+c' }, // the native copy
      { command: 'app.quit', key: 'cmd+shift+q' }, // main's
      { command: 'terminal.copy', key: 'cmd+shift+c' }, // a native role
      { command: 'session.jumpTo', key: 'cmd+shift+1' }, // nine keys with a place each
      { command: 'files.refresh', key: 'cmd+what' },
      { command: 'files.refresh', key: 'cmd+shift+u', when: 'editorFocus' },
      'server.restart',
      { command: 'view.palette' },
      { command: 'server.toggle', key: 'cmd+shift+u' },
      { command: 'files.togglePanel', key: 'ctrl+tab' }, // one of the router's few chords without ⌘
      { command: 'files.toggleIgnored', key: '' },
    ], COMMANDS, mac)
    expect(r.overrides).toEqual([
      { command: 'session.archive', chord: null },
      { command: 'viewer.toggleWrap', chord: 'alt+w' },
      { command: 'server.toggle', chord: 'cmd+shift+u' },
      { command: 'files.togglePanel', chord: 'ctrl+tab' },
      { command: 'files.toggleIgnored', chord: null },
    ])
    expect(r.notices.map((n) => n.index)).toEqual([0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    const said = (i: number) => r.notices.find((n) => n.index === i)!.message
    expect(said(0)).toMatch(/Replaced by a later entry/)
    expect(said(1)).toBe('No command "no.such".')
    expect(said(3)).toMatch(/has no ⌘/)
    expect(said(5)).toContain(`⌘← moves to the start of the line in a terminal`)
    expect(said(6)).toContain(`⌘C is Copy`)
    expect(said(7)).toMatch(/Quit Kea Completely is run by the menu bar itself/)
    expect(said(8)).toMatch(/copy or paste/)
    expect(said(9)).toMatch(/several keys/)
    expect(said(10)).toMatch(/"cmd\+what" is not a key/)
    expect(said(11)).toMatch(/Unknown field "when"/)
    expect(said(12)).toMatch(/An entry is/)
    expect(said(13)).toMatch(/An entry is/)
    expect(r.notices.find((n) => n.index === 1)).toMatchObject({ command: 'no.such', key: 'cmd+y' })

    // only the first `keybindingsMaxEntries` entries are read, and the file says so
    const many = Array.from({ length: L.keybindingsMaxEntries + 3 }, () => ({ command: 'files.refresh', key: 'cmd+shift+u' }))
    const cut = readKeybindings(many, COMMANDS, mac)
    expect(cut.overrides).toEqual([{ command: 'files.refresh', chord: 'cmd+shift+u' }])
    expect(cut.notices[0]).toMatchObject({ index: -1, message: `Only the first ${L.keybindingsMaxEntries} entries are read; 3 more are ignored.` })

    // what cannot be rebound is said per command, and every reserved chord is one a default or the system already has
    expect(COMMANDS.filter((c) => rebindable(c, mac) !== null).map((c) => c.id)).toEqual(['session.jumpTo', 'terminal.copy', 'terminal.paste', 'view.cycleFocus', 'app.openKea', 'app.closeToMenuBar', 'app.quit'])
    for (const k of Object.keys(mac.terminalText)) expect(mac.reserved[k]).toBeDefined()
    for (const k of [...Object.keys(mac.reserved), ...Object.keys(mac.intercepts)]) expect(parseChord(k), k).not.toBeNull()
  })

  it('U-KB-9 · the bindings in use are the table’s with the entries applied: an entry replaces its command’s keys, null takes them away, and a chord another command had in the same context goes to the entry’s, reported as a conflict', () => {
    expect(DEFAULT_BINDINGS.bindings).toEqual(bindings())
    expect(DEFAULT_BINDINGS.conflicts).toEqual([])
    expect(DEFAULT_BINDINGS.changed.size).toBe(0)
    // a default's label is the one the table writes (macOS's column here; Linux's has a test of its own, U-PLT-40)
    const defaults = effectiveBindings([], COMMANDS, mac)
    expect(defaults.labels.get('server.restart')).toEqual(['⇧⌘R'])
    expect(defaults.labels.get('view.cycleFocus')).toEqual(['F6', '⇧F6'])
    expect(defaults.labels.get('session.jumpTo')).toHaveLength(9)
    expect(defaults.labels.get('files.refresh')).toBeUndefined()

    const e = effectiveBindings([
      { command: 'server.toggle', chord: 'cmd+shift+r' }, // Restart Dev Server's default
      { command: 'session.archive', chord: null },
      { command: 'files.refresh', chord: 'cmd+2' }, // one of Jump to Session's nine
      { command: 'viewer.find', chord: 'cmd+g' }, // a viewer tab's: ⌘F is free there again, and Find's ⌘F elsewhere is untouched
    ], COMMANDS, mac)
    const of = (id: string) => e.bindings.filter((b) => b.id === id).map((b) => `${b.scope ?? '*'}|${b.chord}`)
    expect(of('server.toggle')).toEqual(['*|cmd+shift+r'])
    expect(of('server.restart')).toEqual([])
    expect(of('session.archive')).toEqual([])
    expect(of('files.refresh')).toEqual(['*|cmd+2'])
    expect(of('session.jumpTo')).toHaveLength(8)
    expect(e.bindings.find((b) => b.id === 'session.jumpTo' && b.chord === 'cmd+3')?.args).toEqual({ index: 3 })
    expect(of('viewer.find')).toEqual(['viewer tab|cmd+g'])
    expect(of('terminal.find')).toEqual(['*|cmd+f'])
    expect(e.conflicts).toEqual([
      { chord: 'cmd+shift+r', scope: null, winner: 'server.toggle', loser: 'server.restart' },
      { chord: 'cmd+2', scope: null, winner: 'files.refresh', loser: 'session.jumpTo' },
    ])
    // in this system's notation (⇧⌘R on macOS)
    expect(conflictText(e.conflicts[0]!)).toBe(`${chordLabel('cmd+shift+r')} is now Run / Stop Dev Server; Restart Dev Server has lost it.`)
    expect(e.labels.get('server.toggle')).toEqual(['⇧⌘R'])
    expect(e.labels.get('server.restart')).toBeUndefined()
    expect(e.labels.get('session.archive')).toBeUndefined()
    expect(e.labels.get('files.refresh')).toEqual(['⌘2'])
    expect([...e.changed].sort()).toEqual(['files.refresh', 'server.toggle', 'session.archive', 'viewer.find'])
    // no chord is bound twice in one context, whatever the entries
    const seen = new Set<string>()
    for (const b of e.bindings) {
      const k = `${b.scope ?? '*'}|${b.chord}`
      expect(seen.has(k), k).toBe(false)
      seen.add(k)
    }
    // a second entry on the first one's chord takes it in turn
    const two = effectiveBindings(
      [
        { command: 'files.refresh', chord: 'cmd+u' },
        { command: 'files.toggleIgnored', chord: 'cmd+u' },
    ], COMMANDS, mac)
    expect(two.bindings.filter((b) => b.chord === 'cmd+u').map((b) => b.id)).toEqual(['files.toggleIgnored'])
    expect(two.conflicts).toEqual([{ chord: 'cmd+u', scope: null, winner: 'files.toggleIgnored', loser: 'files.refresh' }])
  })

  it('U-KB-9 · the menu state carries a command’s changed key as a chord and its title only as one the table lists', () => {
    const ok = (c: object, keys?: object) => zMenuState.safeParse({ commands: [c], ...(keys ? { keys } : {}) }).success
    expect(ok({ id: 'server.toggle', enabled: true, title: 'Stop Dev Server' }, { 'server.toggle': 'cmd+shift+y', 'session.archive': null })).toBe(true)
    expect(ok({ id: 'server.toggle', enabled: true }, { 'server.toggle': 'Cmd+Shift+Y' })).toBe(false)
    expect(ok({ id: 'server.toggle', enabled: true }, { 'evil.run': 'cmd+y' })).toBe(false)
    expect(ok({ id: 'server.toggle', enabled: true, title: 'Anything at all' })).toBe(false)
    expect(ok({ id: 'terminal.find', enabled: true, title: 'Find' })).toBe(false)
  })
})

describe('keybindings.json on Linux', () => {
  const keys = linux.keys
  const on = (s: string, k = keys): string | null => {
    const c = parseKeyText(s, k)
    return c ? chordText(c) : null
  }

  it('U-PLT-40 · one file serves both systems: primary is the system’s modifier, cmd and ⌘ read as ctrl+shift on Linux, super is refused there; the rules, the reserved list and the messages are Linux’s', () => {
    expect(on('primary+k')).toBe('ctrl+shift+k')
    expect(on('primary+k', mac)).toBe('cmd+k')
    expect(on('cmd+shift+b')).toBe('ctrl+shift+b')
    expect(on('Command+Option+J')).toBe('ctrl+alt+shift+j')
    expect(on('⇧⌘R')).toBe('ctrl+shift+r')
    expect(on('⌥⌘J')).toBe('ctrl+alt+shift+j')
    expect(on('Ctrl+Shift+R')).toBe('ctrl+shift+r')
    expect(on('ctrl+shift+cmd+x')).toBe('ctrl+shift+x')
    expect(on('shift+insert')).toBe('shift+insert')
    for (const bad of ['super+b', 'meta+b', 'primary+primary+x', 'cmd+command+x', 'ctrl+ctrl+x', 'shift+shift+x']) expect(on(bad), bad).toBeNull()
    // macOS reads the same words as before: super is ⌘ there, and ⌘ twice is no chord
    expect(on('super+b', mac)).toBe('cmd+b')
    expect(on('cmd+super+b', mac)).toBeNull()

    const r = readKeybindings([
      { command: 'server.toggle', key: 'cmd+shift+y' }, // ⌘ reads as Ctrl+Shift
      { command: 'terminal.find', key: 'ctrl+f' }, // no Ctrl+Shift: it would take ⌃F from a program in a terminal
      { command: 'files.refresh', key: 'super+r' },
      { command: 'files.toggleIgnored', key: 'ctrl+alt+t' }, // the desktop's
      { command: 'terminal.jumpToBottom', key: 'ctrl+shift+c' }, // the terminal's copy
      { command: 'viewer.toggleWrap', key: 'ctrl+w' }, // a viewer tab's own key may do without Ctrl+Shift
      { command: 'files.togglePanel', key: 'primary+alt+u' },
      { command: 'session.archive', key: 'what' },
      { command: 'session.jumpTo', key: 'ctrl+shift+alt+1' },
    ], COMMANDS, keys)
    expect(r.overrides).toEqual([
      { command: 'server.toggle', chord: 'ctrl+shift+y' },
      { command: 'viewer.toggleWrap', chord: 'ctrl+w' },
      { command: 'files.togglePanel', chord: 'ctrl+alt+shift+u' },
    ])
    const said = (i: number) => r.notices.find((n) => n.index === i)!.message
    expect(said(1)).toBe('Ctrl+F has no Ctrl+Shift: a shortcut that works everywhere must use Ctrl+Shift, so it never takes a key from a program in a terminal.')
    expect(said(2)).toBe('"super+r" uses Super, which the desktop keeps on Linux: write primary or ctrl+shift instead.')
    expect(said(3)).toBe('Ctrl+Alt+T opens a terminal (Ubuntu, KDE); it cannot be bound.')
    expect(said(4)).toBe('Ctrl+Shift+C is Copy in a terminal; it cannot be bound.')
    expect(said(7)).toBe('"what" is not a key: write it like "ctrl+shift+r".')
    expect(said(8)).toMatch(/several keys/)
    expect(COMMANDS.filter((c) => rebindable(c, keys) !== null).map((c) => c.id)).toEqual(['session.jumpTo', 'terminal.copy', 'terminal.paste', 'view.cycleFocus', 'app.openKea', 'app.closeToMenuBar', 'app.quit'])
    for (const k of [...Object.keys(keys.reserved), ...Object.keys(keys.intercepts)]) expect(parseChord(k), k).not.toBeNull()
    expect(keys.terminalText).toEqual({})
  })

  it('U-PLT-40 · the bindings in use are the Linux column with the entries applied, labelled as Linux writes them; the starter file’s example is free there', () => {
    const d = effectiveBindings([], COMMANDS, keys)
    expect(d.conflicts).toEqual([])
    expect(d.labels.get('server.restart')).toEqual(['Ctrl+Shift+F5'])
    expect(d.labels.get('view.cycleFocus')).toEqual(['F6', 'Shift+F6'])
    expect(d.labels.get('terminal.copy')).toEqual(['Ctrl+Shift+C', 'Ctrl+Insert'])
    expect(d.labels.get('session.jumpTo')).toHaveLength(9)
    const e = effectiveBindings([{ command: 'server.toggle', chord: 'ctrl+shift+f5' }], COMMANDS, keys)
    expect(e.conflicts).toEqual([{ chord: 'ctrl+shift+f5', scope: null, winner: 'server.toggle', loser: 'server.restart' }])
    expect(e.labels.get('server.toggle')).toEqual(['Ctrl+Shift+F5'])
    // the starter file: macOS's is unchanged; Linux's example is a Ctrl+Shift key no command has there
    expect(keybindingsTemplate(mac)).toBe(`// Kea key bindings. One entry per command: its id (Settings › Keyboard lists them all) and the key.
// A shortcut that works everywhere must use cmd; "key": null takes a command's shortcut away.
//
//   { "command": "terminal.jumpToBottom", "key": "cmd+shift+b" }
//
// The file is read again whenever it is saved.
[
]
`)
    const template = keybindingsTemplate(keys)
    expect(template).toContain('must use ctrl+shift (or primary')
    const example = template.split('\n').filter((l) => /^\/\/\s+\{/.test(l)).map((l) => JSON.parse(l.replace(/^\/\/\s+/, '')) as unknown)
    expect(example).toEqual([{ command: 'terminal.jumpToBottom', key: 'ctrl+shift+alt+b' }])
    const read = readKeybindings(example, COMMANDS, keys)
    expect(read.notices).toEqual([])
    expect(effectiveBindings(read.overrides, COMMANDS, keys).conflicts).toEqual([])
  })
})
