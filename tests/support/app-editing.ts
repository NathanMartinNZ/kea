// Editing a file in the viewer, for the app-level suites: an editable document's own keys on this system, the Edit
// menu's Undo and Redo chosen as a click on them does, the tab's unsaved dot, what is typed against a read-only
// document, and the file on disk.

import fs from 'node:fs'
import type { Page } from '@playwright/test'
import { protocolOs } from '../../packages/protocol/src/os/index.ts'
import { STEP_MS, until, type Kea } from './app.ts'
import { fileTab } from './app-tabs.ts'
import { textKey } from './keys.ts'
import { viewerText } from './app-viewer.ts'

/**
 * An editable document's own key (CodeMirror's `Mod-z`, `Mod-Shift-z`, `Mod-d`, `Mod-/`), written as on a Mac, as this
 * system presses it: the document's keys are a text field's, `⌘` being `Ctrl` on Linux.
 */
export function documentKey(press: string): string {
  return protocolOs.system === 'linux' ? press.replace(/\bMeta\b/, 'Control') : press
}

/**
 * Choose the Edit menu's Undo or Redo as a click on it does. The items are Kea's own (`edit:undo`, `edit:redo`): their
 * click asks the window to take the step, so the same call serves the menu bar and Linux's window menu. Resolves once
 * the item has run.
 */
export async function chooseEditMenuRole(kea: Kea, role: 'undo' | 'redo'): Promise<void> {
  const ran = await kea.app.evaluate(
    ({ Menu, BrowserWindow }, id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id)
      const win = BrowserWindow.getAllWindows()[0]
      if (!item || !item.enabled || !win) return false
      item.click(undefined, win, win.webContents)
      return true
    },
    `edit:${role}`,
  )
  if (!ran) throw new Error(`no enabled Edit menu item edit:${role}`)
}

/** What the file tab of `path` says about unsaved changes: its dot (`unsaved`) and its accessible name. */
export async function tabUnsavedMark(kea: Kea, path: string): Promise<{ dot: boolean; name: string | null }> {
  const tab = fileTab(await kea.page(), path)
  return tab.evaluate((e) => ({ dot: e.classList.contains('unsaved'), name: e.getAttribute('aria-label') }))
}

/** Wait until the document on screen holds exactly `text`. */
export async function waitDocument(kea: Kea, what: string, text: string, ms = STEP_MS): Promise<void> {
  let last = ''
  await until(
    what,
    async () => {
      last = await viewerText(kea)
      return last === text || undefined
    },
    ms,
  ).catch((e: Error) => {
    throw new Error(`${e.message}\n  document: ${JSON.stringify(last)}\n  wanted:   ${JSON.stringify(text)}`)
  })
}

/** Wait until the file at `file` holds exactly `text`. */
export async function waitFileText(file: string, what: string, text: string, ms = STEP_MS): Promise<void> {
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)
  await until(what, () => read() === text || undefined, ms).catch((e: Error) => {
    throw new Error(`${e.message}\n  on disk: ${JSON.stringify(read())}\n  wanted:  ${JSON.stringify(text)}`)
  })
}

/** Everything the user could do to change a document's text: typing, deleting, a paste, a cut, a drop, an input event. */
export async function tryToEditDocument(page: Page): Promise<void> {
  await page.keyboard.type('typed text')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Delete')
  await page.keyboard.press(textKey('Meta+Backspace'))
  await page.evaluate(() => {
    const content = document.querySelector('.viewer .cm-editor:not(.cm-merge-a) .cm-content') as HTMLElement
    const data = new DataTransfer()
    data.setData('text/plain', 'pasted text')
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    content.dispatchEvent(new ClipboardEvent('cut', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }))
    content.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    content.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'inserted', bubbles: true, cancelable: true }))
  })
}
