// The window's menu on Linux: `Alt` pressed and released alone opens it, `Alt` with another key or a click does not; it
// opens under the header's menu button, which only Linux draws; the header keeps clear of the Window Controls Overlay's
// rectangle. The menu's layout and accelerators are main's (app/main/src/os/linux.test.ts).
import fs from 'node:fs'
import path from 'node:path'
import { render } from 'svelte/server'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { darwin as protocolDarwin } from '@kea/protocol/os/darwin'
import { linux as protocolLinux } from '@kea/protocol/os/linux'

const opened: [number, number][] = []
vi.mock('../lib/bridge.ts', () => ({ openWindowMenu: (x: number, y: number) => opened.push([x, y]) }))

const { AltAlone, menuAnchor, openMenuUnderButton } = await import('./windowMenu.ts')
const { default: WindowMenuButton } = await import('./WindowMenuButton.svelte')
const { windowMenuUi } = await import('./windowMenuState.svelte.ts')

const key = (k: string, o: Partial<{ altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; repeat: boolean; isComposing: boolean }> = {}) => ({ key: k, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false, ...o })

describe('the window menu on Linux', () => {
  it('U-PLT-17 · Alt pressed and released alone opens the menu under the header button; Alt with another key, a click or a modifier does not; only Linux has the button', () => {
    const a = new AltAlone()
    const alone = () => {
      a.down(key('Alt', { altKey: true }))
      return a.up(key('Alt'))
    }
    expect(alone()).toBe(true)
    // held, the key repeats: still alone
    a.down(key('Alt', { altKey: true }))
    a.down(key('Alt', { altKey: true, repeat: true }))
    expect(a.up(key('Alt'))).toBe(true)
    // Alt+F (a chord), Ctrl+Alt, Shift+Alt: not alone
    a.down(key('Alt', { altKey: true }))
    a.down(key('f', { altKey: true }))
    expect(a.up(key('Alt'))).toBe(false)
    a.down(key('Alt', { altKey: true, ctrlKey: true }))
    expect(a.up(key('Alt'))).toBe(false)
    a.down(key('Shift', { shiftKey: true }))
    a.down(key('Alt', { altKey: true, shiftKey: true }))
    expect(a.up(key('Alt'))).toBe(false)
    // a click while Alt is down, the window losing focus, an input method's composition
    a.down(key('Alt', { altKey: true }))
    a.reset()
    expect(a.up(key('Alt'))).toBe(false)
    a.down(key('Alt', { altKey: true, isComposing: true }))
    expect(a.up(key('Alt'))).toBe(false)
    // another key's release does not open it, and the next Alt alone still does
    a.down(key('Alt', { altKey: true }))
    expect(a.up(key('x'))).toBe(false)
    expect(alone()).toBe(true)

    // under the button: its bottom-left corner, in the window's coordinates
    expect(menuAnchor({ getBoundingClientRect: () => ({ left: 8.4, bottom: 43.6 }) })).toEqual({ x: 8, y: 44 })
    expect(menuAnchor(null)).toEqual({ x: 0, y: 0 })

    // the button: a named control that says it opens a menu, which the anchor finds
    const html = render(WindowMenuButton).body
    expect(html).toMatch(/<button[^>]*aria-label="Menu"/)
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('data-window-menu')
    // only Linux draws it (App.svelte reads the flag), and the header keeps clear of the overlay there
    expect([protocolLinux.window.menuButton, protocolDarwin.window.menuButton]).toEqual([true, false])
    const app = fs.readFileSync(path.join(import.meta.dirname, 'App.svelte'), 'utf8')
    expect(app).toContain('protocolOs.window.menuButton')
    const css = fs.readFileSync(path.join(import.meta.dirname, 'window.css'), 'utf8')
    // the header keeps the overlay's rectangle alone: the space beside it is its first or last cluster's own
    expect(css).toMatch(/\.window\.menu-button \.sidebar-header,[^{]*\{\s*padding-left: env\(titlebar-area-x, 0px\);/)
    expect(css).toMatch(/\.window\.menu-button \.main-header \{\s*padding-right: calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\);/)
    expect(css).toMatch(/\.header-cluster \{[^}]*padding: 0 var\(--space-2\);/)
    expect(opened).toEqual([])
  })

  it('U-PLT-17 · while the window draws the menu, the button says so and Alt alone or the button closes it without asking main again', () => {
    expect(render(WindowMenuButton).body).toContain('aria-expanded="false"')
    windowMenuUi.open = { at: { x: 8, y: 44 }, items: [{ id: 'menu:0', label: 'File', enabled: true, submenu: [] }], inTerminal: false }
    expect(render(WindowMenuButton).body).toContain('aria-expanded="true"')
    const before = opened.length
    openMenuUnderButton()
    expect(windowMenuUi.open).toBeNull()
    expect(opened.length, 'main was not asked').toBe(before)
  })

  it('U-PLT-17 · Alt alone twice before main’s items arrive asks main once and opens nothing: the second press closes the menu the first asked for', () => {
    const items = [{ id: 'menu:0', label: 'File', enabled: true, submenu: [] }]
    vi.stubGlobal('document', { querySelector: () => null }) // no header button: the menu opens at the corner
    onTestFinished(() => void vi.unstubAllGlobals())
    const before = opened.length
    openMenuUnderButton()
    openMenuUnderButton()
    expect(opened.length, 'main was asked once').toBe(before + 1)
    windowMenuUi.arrived({ at: { x: 8, y: 44 }, items }, false)
    expect(windowMenuUi.open, 'the cancelled opening').toBeNull()
    // the next press opens it again, once main's items come
    openMenuUnderButton()
    windowMenuUi.arrived({ at: { x: 8, y: 44 }, items }, true)
    expect(windowMenuUi.open).toMatchObject({ at: { x: 8, y: 44 }, inTerminal: true })
    // items main sends with no opening asked for open nothing either
    windowMenuUi.open = null
    windowMenuUi.arrived({ at: { x: 8, y: 44 }, items }, false)
    expect(windowMenuUi.open).toBeNull()
  })
})

