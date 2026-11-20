import { describe, expect, it } from 'vitest'
import { bindings, CATEGORIES, chordText, commandTitle, COMMANDS, KEY_SCOPES, MAIN_COMMANDS, menuSections, NATIVE_ROLES, parseChord, parseShortcut, SURFACES, surfaceMenu, systemKeys, systemTitle, toAccelerator, zMenuState } from './commands.ts'

import { darwin } from './os/darwin.ts'
import { linux } from './os/linux.ts'

describe('command table', () => {
  it('U-KB-2 · state-dependent titles split cleanly from the base title', () => {
    // a row's titles by state are its one title read apart: `Run / Stop Dev Server` → Run Dev
    // Server, Stop Dev Server, or two whole titles as they are (`Show Agent Beside Terminals / Show Agent as a Tab`); a
    // title with a note on it is shown without the note: `Open in… (each detected editor)` → Open in…
    for (const c of COMMANDS) {
      if (!c.titles) continue
      const bare = c.title.replace(/\s*\([^)]*\)$/, '')
      const parts = bare.split(' / ')
      const last = parts.at(-1) as string
      const tail = last.includes(' ') ? last.slice(last.indexOf(' ')) : ''
      const shared = parts.map((p, i) => (i < parts.length - 1 ? p + tail : p))
      const whole = parts.every((p) => p.includes(' '))
      expect([JSON.stringify(shared), ...(whole ? [JSON.stringify(parts)] : [])], c.id).toContain(JSON.stringify(c.titles))
    }
    expect(COMMANDS.filter((c) => c.titles).map((c) => c.id)).toEqual(['files.cut', 'files.copy', 'files.undo', 'server.toggle', 'view.toggleAgentPane', 'view.openIn', 'app.checkUpdates'])
  })

  it('U-KB-2 · unique ids, a category for every command, every default binding unique in its scope', () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
    for (const c of COMMANDS) {
      expect(CATEGORIES).toContain(c.category)
      if (c.keyScope) expect(KEY_SCOPES).toContain(c.keyScope)
      if (c.keyArgs) expect(c.keyArgs).toHaveLength(c.keys?.length ?? -1)
    }
    const seen = new Map<string, string>()
    for (const b of bindings()) {
      const k = `${b.scope ?? '*'}|${b.chord}`
      expect(seen.get(k), `${b.chord} bound twice (${seen.get(k)}, ${b.id})`).toBeUndefined()
      seen.set(k, b.id)
    }
  })

  it('U-KB-2 · command bindings parse into chords and Electron accelerators', () => {
    expect(chordText(parseShortcut('⌘⇧]')!)).toBe('cmd+shift+]')
    expect(chordText(parseShortcut('⇧⌘R')!)).toBe('cmd+shift+r')
    expect(chordText(parseShortcut('⌥⌘Q')!)).toBe('cmd+alt+q')
    expect(chordText(parseShortcut('⌃⇧Tab')!)).toBe('ctrl+shift+tab')
    expect(chordText(parseShortcut('⌘+')!)).toBe('cmd+=')
    expect(chordText(parseShortcut('⌘−')!)).toBe('cmd+-')
    expect(chordText(parseShortcut('⌘⇧⌫')!)).toBe('cmd+shift+backspace')
    expect(chordText(parseShortcut('⇧F6')!)).toBe('shift+f6')
    expect(chordText(parseShortcut('⌃`')!)).toBe('ctrl+`')
    expect(parseShortcut('⌘')).toBeNull()
    expect(parseShortcut('double-click')).toBeNull()
    expect(toAccelerator('⌘⇧[')).toBe('Cmd+Shift+[')
    expect(toAccelerator('⌘+')).toBe('Cmd+Plus')
    expect(toAccelerator('⌥⌘Q')).toBe('Cmd+Alt+Q')
    expect(toAccelerator('⌘,')).toBe('Cmd+,')
    expect(toAccelerator('⌘⇧⌫')).toBe('Cmd+Shift+Backspace')
    for (const c of COMMANDS) for (const k of c.keys ?? []) expect(toAccelerator(k), `${c.id} ${k}`).not.toBeNull()
  })

  it('U-KB-5 · every contextual menu is generated from the surfaces column, in table order, only with available commands', () => {
    const order = new Map(COMMANDS.map((c, i) => [c.id, i]))
    for (const s of SURFACES) {
      const ids = surfaceMenu(s)
      expect(ids.length).toBeGreaterThan(0)
      expect(ids.every((id) => COMMANDS.find((c) => c.id === id)?.surfaces?.includes(s))).toBe(true)
      expect([...ids].sort((a, b) => (order.get(a) as number) - (order.get(b) as number))).toEqual(ids)
    }
    expect(surfaceMenu('session ⌃').slice(0, 4)).toEqual(['session.rename', 'session.openInEditor', 'session.reveal', 'session.copyBranch'])
    expect(surfaceMenu('editor ▾')).toEqual(['session.reveal', 'session.copyWorktreePath', 'view.openIn', 'view.openInTerminalApp'])
    expect(surfaceMenu('menu-bar item')).toEqual(['app.checkUpdates', 'app.openKea', 'app.quit'])
    // a terminal's menu reads as a terminal app's: the clipboard first, then Find and Clear
    expect(surfaceMenu('terminal ⌃')).toEqual(['terminal.copy', 'terminal.paste', 'terminal.selectAll', 'terminal.find', 'terminal.clear'])
    // the file tree's menus: a row's, and the folder's own (the Files bar, the space under the rows)
    expect(surfaceMenu('file ⌃')).toEqual(['files.newFile', 'files.newFolder', 'files.openInEditor', 'files.reveal', 'files.cut', 'files.copy', 'files.paste', 'files.copyPath', 'files.copyRelativePath', 'files.rename', 'files.trash', 'files.discard'])
    expect(surfaceMenu('files ⌃')).toEqual(['files.newFile', 'files.newFolder', 'files.reveal', 'files.paste', 'files.copyPath', 'files.collapseAll'])
    expect(surfaceMenu('header ⋯', (id) => id !== 'session.rename')[0]).toBe('session.resume')
  })

  it('U-KB-2 · the menu bar has one section per category in category order, listing included commands in table order', () => {
    const include = new Set(['terminal.find', 'app.quit', 'terminal.newShell', 'session.new'])
    expect(menuSections((id) => include.has(id))).toEqual([
      { category: 'Session', ids: ['session.new'] },
      { category: 'Terminal', ids: ['terminal.newShell', 'terminal.find'] },
      { category: 'App', ids: ['app.quit'] },
    ])
  })

  it('U-KB-2 · the menu state from the renderer accepts only table commands and at most one entry per command', () => {
    expect(zMenuState.safeParse({ commands: [{ id: 'terminal.find', enabled: true }] }).success).toBe(true)
    expect(zMenuState.safeParse({ commands: [{ id: 'evil.run', enabled: true }] }).success).toBe(false)
    expect(zMenuState.safeParse({ commands: Array.from({ length: COMMANDS.length + 1 }, () => ({ id: 'terminal.find', enabled: true })) }).success).toBe(false)
  })
})

describe('the Linux column', () => {
  const keys = linux.keys

  it('U-PLT-6 · the Linux key column: no two commands on one key in one context, no plain Ctrl+<letter>, none on the reserved list, every app-wide key a Ctrl+Shift chord; labels read Ctrl+Shift+…', () => {
    for (const c of COMMANDS) {
      // a Linux key exactly where there is a macOS one, as many where they run with arguments; but a file list key
      // whose Linux key is plain Ctrl (the list's own, `listKeys`), which the column cannot hold
      const listKey = c.keyScope === 'file panel' && /\blist key Ctrl\+[A-Z] on Linux\b/.test(c.other ?? '')
      if (listKey) {
        const chord = parseChord(`ctrl+${/Ctrl\+([A-Z])/.exec(c.other as string)![1]!.toLowerCase()}`)!
        expect(keys.listKeys[chordText(chord)], c.id).toBe(c.id)
      }
      expect(c.linuxKeys !== undefined || listKey, c.id).toBe(c.keys !== undefined)
      if (c.keyArgs) expect(c.linuxKeys, c.id).toHaveLength(c.keyArgs.length)
      expect(systemKeys(c, keys)).toEqual(c.linuxKeys ?? [])
      expect(systemKeys(c, darwin.keys)).toEqual(c.keys ?? [])
      for (const k of c.linuxKeys ?? []) {
        const chord = parseShortcut(k)
        expect(chord, `${c.id} ${k}`).not.toBeNull()
        // written as its label shows it, so the table, the chips and the menus agree; no Mac glyph
        expect(keys.label(chord!), c.id).toBe(k)
        expect(k, c.id).not.toMatch(/[⌘⇧⌥⌃↵⌫←→↑↓−]/)
        expect(toAccelerator(k), `${c.id} ${k}`).not.toBeNull()
      }
    }
    const seen = new Map<string, string>()
    const appWideOthers: string[] = []
    for (const b of bindings(COMMANDS, keys)) {
      const c = parseChord(b.chord)!
      const where = `${b.id} ${b.chord}`
      const at = `${b.scope ?? '*'}|${b.chord}`
      expect(seen.get(at), `${b.chord} bound twice (${seen.get(at)}, ${b.id})`).toBeUndefined()
      seen.set(at, b.id)
      // never Super: the desktop has it
      expect(c.cmd, where).toBe(false)
      // Ctrl alone belongs to the terminal, scoped or not
      expect(c.ctrl && !c.shift && !c.alt && /^[a-z]$/.test(c.key), where).toBe(false)
      // none on the reserved list, but the keys it reserves for these very commands
      if (keys.reserved[b.chord] !== undefined) expect(['terminal.copy', 'terminal.paste', 'app.closeToMenuBar', 'app.quit'], where).toContain(b.id)
      if (b.scope === null && !keys.primary(c)) appWideOthers.push(b.chord)
    }
    // every key that works everywhere is a Ctrl+Shift chord, but the few others the key router takes and copy's
    // and paste's Insert keys
    expect(appWideOthers).toEqual(['ctrl+tab', 'ctrl+insert', 'shift+insert', 'ctrl+`', 'f6', 'shift+f6'])
    for (const k of appWideOthers) if (!k.endsWith('insert')) expect(keys.intercepts[k], k).toBeDefined()
    expect(NATIVE_ROLES[seen.get('*|ctrl+insert')!]).toBe('copy')
    expect(NATIVE_ROLES[seen.get('*|shift+insert')!]).toBe('paste')
    // the reserved list is chords only (Super is refused as a whole), and the main commands' keys are on it
    for (const k of Object.keys(keys.reserved)) expect(parseChord(k)?.cmd, k).toBe(false)
    for (const id of MAIN_COMMANDS) for (const k of systemKeys(COMMANDS.find((c) => c.id === id)!, keys)) expect(keys.reserved[chordText(parseShortcut(k)!)], id).toBeDefined()
    // labels: Ctrl, Shift, Alt in that order, the primary modifier first, named keys by their word
    expect(keys.label({ cmd: false, ctrl: true, alt: true, shift: true, key: 'p' })).toBe('Ctrl+Shift+Alt+P')
    expect(keys.label({ cmd: false, ctrl: true, alt: false, shift: true, key: 'enter' })).toBe('Ctrl+Shift+Enter')
    expect(keys.label({ cmd: false, ctrl: false, alt: true, shift: false, key: 'down' })).toBe('Alt+Down')
    expect(keys.label({ cmd: false, ctrl: true, alt: false, shift: true, key: '=' })).toBe('Ctrl+Shift+=')
    // an accelerator lists the modifiers in chordText's order
    expect(toAccelerator('Ctrl+Shift+Alt+P')).toBe('Ctrl+Alt+Shift+P')
    expect(toAccelerator('Ctrl+Shift+=')).toBe('Ctrl+Shift+Plus')
    expect(toAccelerator('Shift+Insert')).toBe('Shift+Insert')
    expect(toAccelerator('Ctrl+`')).toBe('Ctrl+`')
    expect(parseShortcut('Ctrl+Ctrl+N')).toBeNull()
    expect(parseShortcut('Hyper+N')).toBeNull()
  })

  it("U-PLT-42 · titles on Linux: File Manager for Finder, Close Kea for Close to Menu Bar; macOS's are the table's", () => {
    const at = (id: string) => COMMANDS.find((c) => c.id === id)!
    expect(systemTitle(at('session.reveal'), linux)).toBe('Reveal Worktree in File Manager')
    expect(systemTitle(at('project.reveal'), linux)).toBe('Reveal in File Manager')
    expect(systemTitle(at('files.reveal'), linux)).toBe('Reveal in File Manager')
    expect(systemTitle(at('app.closeToMenuBar'), linux)).toBe('Close Kea')
    for (const c of COMMANDS) {
      expect(systemTitle(c, darwin), c.id).toBe(c.title)
      expect(systemTitle(c, linux), c.id).not.toMatch(/Finder|Menu Bar/)
      // a title by state stays the same on both systems
      expect(commandTitle(c, linux) === commandTitle(c, darwin) || !c.titles, c.id).toBe(true)
    }
  })
})
