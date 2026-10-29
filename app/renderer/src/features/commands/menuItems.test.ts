import { describe, expect, it } from 'vitest'
import { commandById, effectiveBindings, systemTitle, type KeyOverride } from '@kea/protocol'
import { darwin } from '@kea/protocol/os/darwin'
import { linux } from '@kea/protocol/os/linux'
import type { ProtocolOs } from '@kea/protocol'
import { selectAllKeys } from './keys.ts'
import { surfaceItems, type MenuSource } from './menuItems.ts'

/** Every command listed and runnable, titles and keys of `os`, with the person's `overrides` applied. */
function source(os: ProtocolOs, overrides: KeyOverride[] = [], reasons: Record<string, string> = {}): MenuSource {
  const labels = effectiveBindings(overrides, undefined, os.keys).labels
  return { inMenus: () => true, reason: (id) => reasons[id], title: (c) => systemTitle(c, os), key: (id) => labels.get(id)?.[0] }
}

const item = (items: ReturnType<typeof surfaceItems>, id: string) => items.find((i) => i.id === id)

describe('contextual menu items', () => {
  it('U-KB-13 · the terminal menu: Copy, Paste, Select All, Find and Clear in that order, each with its key on either system; Copy kept, disabled with its reason, while nothing is selected', () => {
    // the window's source: a command's key now, else the key the router gives it (⌘A's Select All on macOS)
    const withRouter = (os: ProtocolOs, reasons: Record<string, string> = {}): MenuSource => {
      const base = source(os, [], reasons)
      return { ...base, key: (id) => base.key(id) ?? selectAllKeys(id, os.keys)[0] }
    }
    const args = { ptyId: 'p1' }
    const mac = surfaceItems('terminal ⌃', args, withRouter(darwin))
    expect(mac.map((i) => [i.label, i.shortcut])).toEqual([
      ['Copy', '⌘C'],
      ['Paste', '⌘V'],
      ['Select All', '⌘A'],
      ['Find', '⌘F'],
      ['Clear Terminal and Scrollback', '⌘K'],
    ])
    const lin = surfaceItems('terminal ⌃', args, withRouter(linux))
    expect(lin.map((i) => [i.label, i.shortcut])).toEqual([
      ['Copy', 'Ctrl+Shift+C'],
      ['Paste', 'Ctrl+Shift+V'],
      ['Select All', undefined],
      ['Find', 'Ctrl+Shift+F'],
      ['Clear Terminal and Scrollback', 'Ctrl+Shift+K'],
    ])
    // nothing selected: Copy is there, disabled, its reason said
    const none = surfaceItems('terminal ⌃', args, withRouter(darwin, { 'terminal.copy': 'Nothing is selected' }))
    expect(item(none, 'terminal.copy')).toMatchObject({ disabled: true, reason: 'Nothing is selected', shortcut: '⌘C' })
    expect(item(none, 'terminal.paste')?.disabled).toBeUndefined()
    // the menu asks for each command with the terminal it was opened on
    const asked: unknown[] = []
    surfaceItems('terminal ⌃', args, { ...withRouter(darwin), inMenus: (_id, a) => (asked.push(a), true) })
    expect(asked.every((a) => a === args)).toBe(true)
    // ⌘A is Select All's in a terminal only; Linux's Ctrl+A is the shell's
    expect([selectAllKeys('terminal.selectAll', darwin.keys), selectAllKeys('terminal.selectAll', linux.keys), selectAllKeys('terminal.copy', darwin.keys)]).toEqual([['⌘A'], [], []])
  })

  it('U-KB-17 · each item shows the key its command has now, the person’s bindings applied, on either system', () => {
    const mac = surfaceItems('session ⌃', { id: 's1' }, source(darwin))
    expect(item(mac, 'session.archive')?.shortcut).toBe('⌘⇧⌫')
    expect(item(mac, 'session.reportStatus')?.shortcut).toBe('⌥⌘J')
    expect(item(mac, 'session.rename')?.shortcut).toBeUndefined()

    // a rebound key is the one shown; a key taken away shows none
    const rebound = surfaceItems('session ⌃', { id: 's1' }, source(darwin, [{ command: 'session.archive', chord: 'cmd+shift+y' }, { command: 'session.reportStatus', chord: null }]))
    expect(item(rebound, 'session.archive')?.shortcut).toBe('⇧⌘Y')
    expect(item(rebound, 'session.reportStatus')?.shortcut).toBeUndefined()

    // Linux's labels and keys
    const lin = surfaceItems('session ⌃', { id: 's1' }, source(linux))
    expect(item(lin, 'session.archive')?.shortcut).toBe('Ctrl+Shift+Backspace')
    expect(item(lin, 'session.reveal')?.label).toBe(systemTitle(commandById('session.reveal')!, linux))
    expect(item(lin, 'session.reveal')?.label).not.toBe(item(mac, 'session.reveal')?.label) // "Reveal … in Finder" is macOS's
  })

  it('U-KB-17 · a key that works only in one place is not shown; the table’s order is kept; a reason disables the item', () => {
    const items = surfaceItems('session ⌃', { id: 's1' }, source(darwin, [], { 'session.archive': 'Stop the session first' }))
    // Resume's ↵ works only on the detached overlay
    expect(item(items, 'session.resume')?.shortcut).toBeUndefined()
    expect(item(items, 'session.restart')?.shortcut).toBeUndefined()
    expect(items.map((i) => i.id).indexOf('session.rename')).toBeLessThan(items.map((i) => i.id).indexOf('session.delete'))
    expect(item(items, 'session.archive')).toMatchObject({ disabled: true, reason: 'Stop the session first', shortcut: '⌘⇧⌫' })
    expect(item(items, 'session.rename')?.disabled).toBeUndefined()

    // only the commands the source lists for these arguments
    const some = surfaceItems('session ⌃', { id: 's1' }, { ...source(darwin), inMenus: (id) => id === 'session.rename' })
    expect(some.map((i) => i.id)).toEqual(['session.rename'])
  })
})
