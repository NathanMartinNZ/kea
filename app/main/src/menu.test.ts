import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { COMMANDS, MAIN_COMMANDS, need, zMenuState } from '@kea/protocol'
import { darwin as protocolDarwin } from '@kea/protocol/os/darwin'
import { linux as protocolLinux } from '@kea/protocol/os/linux'
import { darwin } from './os/darwin.ts'
import { linux } from './os/linux.ts'
import { menuTemplate, windowMenuState, type MenuInput, type WindowMenuState } from './menu.ts'

function input(over: Partial<MenuInput> = {}): MenuInput {
  return { appName: 'Kea', renderer: null, hasWindow: true, dev: false, send: vi.fn(), main: { openKea: vi.fn(), closeToMenuBar: vi.fn(), quit: vi.fn(), checkUpdates: vi.fn(), reload: vi.fn() }, chrome: need(darwin.menu), system: protocolDarwin, ...over }
}

/** A renderer's report: these commands, each available or not. */
function reported(commands: Record<string, boolean>, keys: Record<string, string | null> = {}): WindowMenuState {
  return windowMenuState({ commands: Object.entries(commands).map(([id, enabled]) => ({ id, enabled })), keys })
}

const sub = (m: MenuItemConstructorOptions) => (m.submenu ?? []) as MenuItemConstructorOptions[]
const all = (t: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => t.flatMap((m) => [m, ...all(sub(m))])
const named = (t: MenuItemConstructorOptions[], label: string) => sub(t.find((m) => m.label === label) as MenuItemConstructorOptions)
const TOP = ['Kea', 'Edit', 'Session', 'Project', 'Terminal', 'Files', 'Viewer', 'Server', 'View', 'window', 'help']

// macOS's menu bar, on either system: its layout and its keys are passed in (Linux's menu is checked in
// os/linux.test.ts, U-PLT-17)
describe('menu bar', () => {
  it('U-KB-3 · the commands appear by category in table order, with their shortcuts shown but routed by the renderer', () => {
    const i = input({ renderer: reported({ 'terminal.find': true, 'terminal.newShell': true, 'terminal.nextTab': false, 'terminal.fontBigger': true }) })
    const t = menuTemplate(i)
    expect(t.map((m) => m.label ?? m.role)).toEqual(TOP)
    const term = named(t, 'Terminal')
    // the whole category in table order, copy, paste and select all left to the Edit menu's roles
    expect(term.map((m) => m.id)).toEqual(COMMANDS.filter((c) => c.category === 'Terminal' && !['terminal.copy', 'terminal.paste', 'terminal.selectAll'].includes(c.id)).map((c) => c.id))
    const pick = (id: string) => term.find((m) => m.id === id) as MenuItemConstructorOptions
    expect(['terminal.newShell', 'terminal.nextTab', 'terminal.find', 'terminal.fontBigger'].map((id) => pick(id).label)).toEqual(['New Terminal', 'Next Tab', 'Find', 'Increase Font Size'])
    expect(['terminal.newShell', 'terminal.nextTab', 'terminal.find', 'terminal.fontBigger'].map((id) => pick(id).enabled)).toEqual([true, false, true, true])
    expect(['terminal.newShell', 'terminal.nextTab', 'terminal.find', 'terminal.fontBigger'].map((id) => pick(id).accelerator)).toEqual(['Cmd+T', 'Cmd+Shift+]', 'Cmd+F', 'Cmd+Plus'])
    // A command the renderer did not report, or reported unavailable (Close Tab on the Agent tab), is listed disabled
    expect(pick('terminal.closeTab')).toMatchObject({ label: 'Close Tab', enabled: false, accelerator: 'Cmd+W' })
    // no shortcut of a generated item is registered with the system
    expect(all(t).filter((m) => m.click && m.accelerator && !MAIN_COMMANDS.includes(m.id as string)).every((m) => m.registerAccelerator === false)).toBe(true)
    ;(pick('terminal.find').click as () => void)()
    expect(i.send).toHaveBeenCalledWith('terminal.find', undefined)
    // a command with several keys runs with its first key's argument
    ;(named(t, 'Session').find((m) => m.id === 'session.jumpTo')?.click as () => void)()
    expect(i.send).toHaveBeenCalledWith('session.jumpTo', { index: 1 })
  })

  it('U-KB-3 · copy / paste are native roles; quit works with no window; standard macOS roles keep ⌘H ⌘M ⌃⌘F; nothing reloads on ⌘R', () => {
    const i = input({ hasWindow: false })
    const t = menuTemplate(i)
    const items = all(t)
    expect(items.find((m) => m.id === 'terminal.copy')?.role).toBe('copy')
    expect(items.find((m) => m.id === 'terminal.paste')?.role).toBe('paste')
    expect(items.filter((m) => m.id === 'terminal.copy' || m.id === 'terminal.paste')).toHaveLength(2)
    // Select All keeps its role (⌘A in a field outside the page), under the terminal command's id: the router sends ⌘A
    // in a terminal to the command
    expect(items.find((m) => m.id === 'terminal.selectAll')).toMatchObject({ role: 'selectAll', label: 'Select All' })
    expect(items.filter((m) => m.role === 'selectAll')).toHaveLength(1)
    const quit = items.find((m) => m.id === 'app.quit')
    expect(quit?.accelerator).toBe('Cmd+Alt+Q')
    expect(quit?.registerAccelerator).toBeUndefined()
    ;(quit?.click as () => void)()
    expect(i.main.quit).toHaveBeenCalled()
    const close = items.find((m) => m.id === 'app.closeToMenuBar')
    expect(close?.accelerator).toBe('Cmd+Q')
    ;(close?.click as () => void)()
    expect(i.main.closeToMenuBar).toHaveBeenCalled()
    expect(i.main.quit).toHaveBeenCalledTimes(1)
    const open = items.find((m) => m.id === 'app.openKea')
    ;(open?.click as () => void)()
    expect(i.main.openKea).toHaveBeenCalled()
    expect(all(menuTemplate(input())).some((m) => m.id === 'app.openKea')).toBe(false)
    // main's own commands are its items, once each: the generated lists leave them out
    for (const id of MAIN_COMMANDS) expect(items.filter((m) => m.id === id)).toHaveLength(1)
    for (const role of ['hide', 'minimize', 'togglefullscreen']) expect(items.some((m) => m.role === role)).toBe(true)
    // no window: the menus are all there, every window command disabled, even one a closed window had reported
    expect(t.map((m) => m.label ?? m.role)).toEqual(TOP)
    const stale = all(menuTemplate(input({ hasWindow: false, renderer: reported({ 'session.new': true }) })))
    expect(stale.find((m) => m.id === 'session.new')?.enabled).toBe(false)
    expect(items.filter((m) => m.click && !MAIN_COMMANDS.includes(m.id as string)).every((m) => m.enabled === false)).toBe(true)
    for (const dev of [false, true]) {
      const every = all(menuTemplate(input({ dev })))
      expect(every.some((m) => m.role === 'reload' || m.role === 'forceReload')).toBe(false)
      expect(every.filter((m) => m.accelerator === 'Cmd+R').every((m) => m.registerAccelerator === false)).toBe(true)
      expect(every.filter((m) => m.accelerator === 'Cmd+R').map((m) => m.id)).toEqual(['server.toggle'])
    }
  })

  it('U-KB-11 · every command of the table has an item, so each is found in the menus and by Help › Search', () => {
    const t = menuTemplate(input())
    const ids = all(t)
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
    // with a window, every command but Open Kea (which is there while there is none)
    expect(new Set(ids.filter((id) => !id.startsWith('help:')))).toEqual(new Set(COMMANDS.map((c) => c.id).filter((id) => id !== 'app.openKea')))
    expect(new Set(all(menuTemplate(input({ hasWindow: false }))).map((m) => m.id))).toContain('app.openKea')
    // no command twice, but for the Help menu's own Keyboard Shortcuts and Copy Diagnostics
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
    const help = t.at(-1) as MenuItemConstructorOptions
    expect(help.role).toBe('help')
    expect(sub(help).map((m) => [m.id, m.label])).toEqual([
      ['help:app.shortcuts', 'Keyboard Shortcuts'],
      ['help:app.copyDiagnostics', 'Copy Diagnostics'],
    ])
    const i = input({ renderer: reported({ 'app.shortcuts': true }) })
    const item = sub(menuTemplate(i).at(-1) as MenuItemConstructorOptions)[0] as MenuItemConstructorOptions
    expect(item.enabled).toBe(true)
    ;(item.click as () => void)()
    expect(i.send).toHaveBeenCalledWith('app.shortcuts', undefined)
    // every item has a label a person can search for, and none shows a key that works only in one context
    for (const m of all(t).filter((x) => x.id)) expect(m.label, m.id).toMatch(/\S/)
    expect(all(t).find((m) => m.id === 'viewer.goToLine')?.accelerator).toBeUndefined()
    // the row's note is not part of what the menu shows
    expect(all(t).find((m) => m.id === 'view.openIn')?.label).toBe('Open in…')
  })

  it('U-KB-11 · titles follow the state the renderer reports, and keys follow keybindings.json', () => {
    const state = zMenuState.parse({
      commands: [
        { id: 'server.toggle', enabled: true, title: 'Stop Dev Server' },
        { id: 'server.restart', enabled: true },
        { id: 'view.toggleSidebar', enabled: true },
        { id: 'files.refresh', enabled: true },
      ],
      keys: { 'server.restart': 'cmd+alt+r', 'view.toggleSidebar': null, 'files.refresh': 'cmd+shift+=', 'viewer.goToLine': 'ctrl+l' },
    })
    const t = menuTemplate(input({ renderer: windowMenuState(state) }))
    const item = (id: string) => all(t).find((m) => m.id === id) as MenuItemConstructorOptions
    expect(item('server.toggle')).toMatchObject({ label: 'Stop Dev Server', accelerator: 'Cmd+R', enabled: true })
    // the person's key in place of the table's; a key taken away shows none; a command given one shows it
    expect(item('server.restart').accelerator).toBe('Cmd+Alt+R')
    expect(item('view.toggleSidebar').accelerator).toBeUndefined()
    expect(item('view.toggleSidebar').registerAccelerator).toBeUndefined()
    expect(item('files.refresh')).toMatchObject({ accelerator: 'Cmd+Shift+Plus', registerAccelerator: false })
    // a scoped command shows none whatever its key
    expect(item('viewer.goToLine').accelerator).toBeUndefined()
    // with no title reported the table's stands
    expect((all(menuTemplate(input({ renderer: reported({ 'server.toggle': true }) }))).find((m) => m.id === 'server.toggle') as MenuItemConstructorOptions).label).toBe('Run / Stop Dev Server')
    // a title that is not one of the row's never reaches main
    expect(zMenuState.safeParse({ commands: [{ id: 'server.toggle', enabled: true, title: 'Anything' }] }).success).toBe(false)
    expect(zMenuState.safeParse({ commands: [{ id: 'session.new', enabled: true, title: 'New Session' }] }).success).toBe(false)
  })

  it('U-DST-38 · Check for Updates… sits after About in the app menu on macOS and first in File’s app group on Linux, works with no window, and takes main’s title (Restart to Update, Restart Kea)', () => {
    const mac = input({ hasWindow: false })
    const app = named(menuTemplate(mac), 'Kea')
    expect(app[0]).toMatchObject({ role: 'about' })
    expect(app[1]).toMatchObject({ id: 'app.checkUpdates', label: 'Check for Updates…' })
    expect(app[1]!.enabled, 'never disabled: main runs it').toBeUndefined()
    ;(app[1]!.click as () => void)()
    expect(mac.main.checkUpdates).toHaveBeenCalledTimes(1)
    for (const title of ['Restart to Update', 'Restart Kea']) expect(named(menuTemplate(input({ updateTitle: title })), 'Kea')[1]).toMatchObject({ id: 'app.checkUpdates', label: title })

    const lin = input({ chrome: need(linux.menu), system: protocolLinux })
    const file = named(menuTemplate(lin), 'File')
    const first = file.findIndex((m) => m.id === 'app.checkUpdates')
    expect(first).toBeGreaterThan(-1)
    expect(file[first - 1], 'the app group starts after a separator').toMatchObject({ type: 'separator' })
    expect(named(menuTemplate({ ...lin, updateTitle: 'Restart Kea' }), 'File')[first]).toMatchObject({ label: 'Restart Kea' })
  })
})
