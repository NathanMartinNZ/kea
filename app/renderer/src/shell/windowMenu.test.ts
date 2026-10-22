// The window's menu on Linux: `Alt` pressed and released alone opens it, `Alt` with another key or a click does not; it
// opens under the header's menu button, which only Linux draws; the header keeps clear of the Window Controls Overlay's
// rectangle. The menu's layout and accelerators are main's (app/main/src/os/linux.test.ts).
import fs from 'node:fs'
import path from 'node:path'
import { render } from 'svelte/server'
import { describe, expect, it, vi } from 'vitest'
import { darwin as protocolDarwin } from '@kea/protocol/os/darwin'
import { linux as protocolLinux } from '@kea/protocol/os/linux'

const opened: [number, number][] = []
vi.mock('../lib/bridge.ts', () => ({ openWindowMenu: (x: number, y: number) => opened.push([x, y]) }))

const { AltAlone, menuAnchor } = await import('./windowMenu.ts')
const { default: WindowMenuButton } = await import('./WindowMenuButton.svelte')

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
    expect(css).toMatch(/\.window\.menu-button \.sidebar-header,[^{]*\{\s*padding-left: calc\(env\(titlebar-area-x, 0px\) \+ var\(--space-2\)\);/)
    expect(css).toMatch(/\.window\.menu-button \.main-header \{\s*padding-right: calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\) \+ var\(--space-2\)\);/)
    expect(opened).toEqual([])
  })
})
