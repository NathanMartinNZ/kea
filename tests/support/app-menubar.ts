// ⌘Q and menu-bar mode through the real app, for the app-level suites. No test can press ⌘Q (a key sent over CDP never
// reaches the native menu) or click the real menu bar, so `⌘Q` clicks the application menu's `app.closeToMenuBar` item,
// and the menu-bar item is read and clicked through main's test API (`__keaTest.menuBar()`, `clickMenuBarItem(id)`;
// app/main/src/testHooks.ts). The first-quit sheet is the window's `alertdialog` "Quit Kea".

import type { Locator, Page } from '@playwright/test'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { STEP_MS, until, type Kea } from './app.ts'

/**
 * Why a run's Kea cannot run from the menu bar (a tray icon on Linux), or null where it can: the tests of that mode
 * skip by name where it is not null (on Linux a run has no tray host).
 */
export const NO_MENU_BAR: string | null = harnessOs.display.trayProblem
/**
 * Why a closed window cannot be reopened from the Dock here, or null on macOS: Linux has no Dock, and with no
 * tray host on a run's display closing the last window quits Kea. The close-and-reopen tests skip that part by
 * name where it is not null.
 */
export const NO_DOCK: string | null = harnessOs.system === 'darwin' ? null : 'Linux has no Dock to reopen a closed window from, and with no tray host on the run’s display closing the last window quits Kea'
/** Main's `dock` while Kea runs from the menu bar, and with a window: macOS hides and shows the Dock icon; Linux has no Dock. */
export const DOCK_HIDDEN: boolean | null = harnessOs.system === 'darwin' ? false : null
export const DOCK_SHOWN: boolean | null = harnessOs.system === 'darwin' ? true : null

/** The menu-bar item as main reports it: whether it exists, its title (the needs-you count), the Dock icon, core's state. */
export interface MenuBarProbe {
  item: boolean
  title: string | null
  dock: boolean | null
  state: { live: number; onQuit: string; count: number; sessions: { id: string; title: string; reason: string; glyph: string }[]; badge: boolean } | null
  sheetSeen: boolean
}

type MenuBarApi = { menuBar(): MenuBarProbe; clickMenuBarItem(id: string): boolean }

/** `⌘Q` (`app.closeToMenuBar`), as the application menu runs it. */
export async function pressQuit(kea: Kea): Promise<void> {
  await kea.app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('app.closeToMenuBar')
    if (!item) throw new Error('no app.closeToMenuBar menu item')
    ;(item as unknown as { click(): void }).click()
  })
}

export function menuBar(kea: Kea): Promise<MenuBarProbe> {
  return kea.app.evaluate(() => (globalThis as unknown as { __keaTest: MenuBarApi }).__keaTest.menuBar())
}

/** Click an item of the menu-bar item's menu (`app.openKea`, `app.quit`, `session:<id>`); false when there is none. */
export function clickMenuBarItem(kea: Kea, id: string): Promise<boolean> {
  return kea.app.evaluate((_e, x) => (globalThis as unknown as { __keaTest: MenuBarApi }).__keaTest.clickMenuBarItem(x), id)
}

/** The first-quit sheet. */
export function quitSheet(page: Page): Locator {
  return page.getByRole('alertdialog', { name: 'Quit Kea' })
}

/**
 * Wait until Kea runs from the menu bar: no window, the Dock icon hidden (Linux: none), the menu-bar item there. Resolves
 * with main's probe.
 */
export async function inMenuBar(kea: Kea, ms = STEP_MS): Promise<MenuBarProbe> {
  return until(
    'Kea in the menu bar',
    async () => {
      const windows = await kea.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      const m = await menuBar(kea)
      return windows === 0 && m.item && m.dock === DOCK_HIDDEN ? m : undefined
    },
    ms,
  )
}

/** Wait until main's menu-bar state (core's) satisfies `pred`. */
export async function menuBarState(kea: Kea, what: string, pred: (s: NonNullable<MenuBarProbe['state']>) => boolean, ms = STEP_MS): Promise<MenuBarProbe> {
  let last: MenuBarProbe | null = null
  return until(
    `the menu-bar state: ${what}`,
    async () => {
      last = await menuBar(kea)
      return last.state && pred(last.state) ? last : undefined
    },
    ms,
  ).catch((e: Error) => {
    throw new Error(`${e.message} (last: ${JSON.stringify(last)})`)
  })
}
