// The command palette, the menu bar, the keyboard list and tooltips, as the app-level suites see them: locators and
// reads only. Keys are Playwright's; the menu bar is read from main's application menu, and an item is chosen there by
// its click handler (no menu is opened on screen, so nothing takes the keyboard).

import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { until, type Kea, type KeaRun } from './app.ts'
import { sysKey, sysLabel } from './keys.ts'

export const palette = (page: Page): Locator => page.getByRole('dialog', { name: 'Command Palette' })
export const paletteInput = (page: Page): Locator => page.locator('.palette input')
export const tooltip = (page: Page): Locator => page.locator('.kea-tooltip')
export const keyboardList = (page: Page): Locator => page.getByTestId('keyboard-list')

export interface PaletteRowSeen {
  kind: string
  id: string
  /** The section it is listed under ("Sessions", "Actions", "Projects", or the command whose argument is chosen). */
  section: string
  title: string
  /** The characters of the title the query matched. */
  marked: string
  detail: string
  /** The key shown on the row, or ''. */
  shortcut: string
  disabled: boolean
  /** Why a disabled command cannot run. */
  reason: string
  /** What ↵ does on a disabled row instead, or ''. */
  remedy: string
  current: boolean
}

/** The palette's rows as listed, top to bottom ([] while it is closed or in file mode). */
export async function paletteRows(kea: Kea): Promise<PaletteRowSeen[]> {
  const page = await kea.page()
  // the remedy's key (↵ on macOS, Enter on Linux) is left out
  return page.evaluate((enter) =>
    [...document.querySelectorAll('.palette [role=listbox][aria-label="Results"] [role=option]')].map((e) => ({
      kind: e.getAttribute('data-kind') ?? '',
      id: e.getAttribute('data-id') ?? '',
      section: e.closest('[role=group]')?.getAttribute('aria-label') ?? '',
      title: e.querySelector('.palette-title')?.textContent ?? '',
      marked: [...e.querySelectorAll('.palette-title mark')].map((m) => m.textContent ?? '').join(''),
      detail: e.querySelector('.palette-detail')?.textContent ?? '',
      shortcut: e.querySelector('.palette-kbd')?.textContent ?? '',
      disabled: e.getAttribute('aria-disabled') === 'true',
      reason: e.getAttribute('data-reason') ?? '',
      remedy: (e.querySelector('.palette-remedy')?.textContent ?? '').replace(enter, '').trim(),
      current: e.getAttribute('aria-selected') === 'true',
    })),
    sysLabel('↵'),
  )
}

/** Wait until the palette's rows satisfy `pred`. */
export async function waitPalette(kea: Kea, what: string, pred: (rows: PaletteRowSeen[]) => boolean): Promise<PaletteRowSeen[]> {
  let last: PaletteRowSeen[] = []
  return until(`the palette: ${what}`, async () => {
    last = await paletteRows(kea)
    return pred(last) ? last : undefined
  }).catch((e: Error) => {
    throw new Error(`${e.message} (rows: ${JSON.stringify(last.map((r) => `${r.kind}:${r.id}`))})`)
  })
}

/** Open the palette with its key and wait until its input has the keyboard. `key`: sysKey(`Meta+Shift+p`) or sysKey(`Meta+p`). */
export async function openPalette(kea: Kea, key = sysKey('Meta+Shift+p')): Promise<void> {
  const page = await kea.page()
  await page.keyboard.press(key)
  await until('the palette’s input to take the keyboard', () => page.evaluate(() => document.activeElement?.matches('.palette input') === true).then((x) => x || undefined))
}

/** Does the keyboard sit in an element matching `selector` (or inside one)? */
export const focusIn = (kea: Kea, selector: string): Promise<boolean> => kea.page().then((page) => page.evaluate((s) => !!document.activeElement?.closest(s), selector))

export interface MenuItemSeen {
  id: string
  label: string
  enabled: boolean
  /** The key the item shows, as Electron writes it (`Cmd+Shift+P`), or ''. */
  accelerator: string
  role: string
  /** The menu it is in: a top-level menu, or the submenu holding it (Linux's View › Files is `Files`). */
  menu: string
}

/** The application menu main built: every item with an id or a role, in order. */
export function menuBar(kea: Kea): Promise<MenuItemSeen[]> {
  return kea.app.evaluate(({ Menu }) => {
    const out: MenuItemSeen[] = []
    const walk = (items: Electron.MenuItem[], menu: string): void => {
      for (const it of items) {
        if (it.type === 'separator') continue
        if (it.id || it.role) out.push({ id: it.id ?? '', label: it.label, enabled: it.enabled, accelerator: it.accelerator ?? '', role: it.role ?? '', menu })
        if (it.submenu) walk(it.submenu.items, it.label)
      }
    }
    walk(Menu.getApplicationMenu()?.items ?? [], '')
    return out
  })
}

export async function menuItem(kea: Kea, id: string): Promise<MenuItemSeen | undefined> {
  return (await menuBar(kea)).find((m) => m.id === id)
}

/** Wait until the menu bar's item `id` satisfies `pred` (main rebuilds the menu when the window reports a change). */
export function waitMenuItem(kea: Kea, id: string, what: string, pred: (m: MenuItemSeen) => boolean): Promise<MenuItemSeen> {
  return until(`the menu item ${id}: ${what}`, async () => {
    const m = await menuItem(kea, id)
    return m && pred(m) ? m : undefined
  })
}

/** Choose a menu bar item as a click on it does (its click handler; no menu opens on screen). False: disabled or absent. */
export function chooseMenuItem(kea: Kea, id: string): Promise<boolean> {
  return kea.app.evaluate(({ Menu, BrowserWindow }, itemId) => {
    const it = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!it || !it.enabled) return false
    it.click(undefined, BrowserWindow.getAllWindows()[0], undefined)
    return true
  }, id)
}

/** Write the run's `keybindings.json`; core's watch service picks it up. */
export function writeKeybindings(run: KeaRun, text: string): void {
  fs.writeFileSync(path.join(run.home, 'keybindings.json'), text)
}

export interface KeyboardRowSeen {
  id: string
  /** The id as the row shows it: what an entry of keybindings.json names; null when the row shows none. */
  shownId: string | null
  title: string
  keys: string[]
  changed: boolean
}

/** The keyboard list's rows (Settings › Keyboard, the Keyboard Shortcuts sheet). */
export async function keyboardRows(kea: Kea): Promise<KeyboardRowSeen[]> {
  const page = await kea.page()
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="keyboard-list"] .keyboard-row')].map((e) => ({
      id: e.getAttribute('data-command') ?? '',
      shownId: e.querySelector('.keyboard-id')?.textContent ?? null,
      title: e.querySelector('.keyboard-title')?.textContent ?? '',
      keys: [...e.querySelectorAll('kbd')].map((k) => k.textContent ?? ''),
      changed: e.hasAttribute('data-changed'),
    })),
  )
}
