// Unsaved files in a running Kea, for the app-level suites: what the file viewer's probe says of a document's text
// (editable or why not, unsaved, the notice line), the warning sheet that asks before unsaved changes are lost, writes
// made to an open file as an agent makes them, and the ways to close the window or quit that ask first. The harness's
// own `closeWindow`, `quitFromMenu` and `close` let every unsaved file go before they act; these do not.

import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { STEP_MS, until, type Kea } from './app.ts'
import { viewer, type ViewerState } from './app-viewer.ts'
import { sysKey, textKey } from './keys.ts'

/** The viewer's editing fields (`__keaProbe.viewer().ui`), with the notice line's text and the labels of its actions. */
export interface EditState {
  path: string
  body: string
  editable: boolean
  /** Why the text cannot be edited now (the header's "Read-only" tooltip), or null. */
  readOnly: string | null
  /** The document has text that is not on disk (the tab's dot). */
  unsaved: boolean
  /** The notice line about the document's text, or null. */
  notice: string | null
}

type EditUi = ViewerState['ui'] & { editable?: boolean; readOnly?: string | null; unsaved?: boolean; editNotice?: { text: string } | null }

/** What the viewer on screen says of its document's text; null while a terminal shows. */
export async function editState(kea: Kea): Promise<EditState | null> {
  const v = await viewer(kea)
  if (!v) return null
  const ui = v.ui as EditUi
  return { path: ui.path, body: ui.body.kind, editable: ui.editable === true, readOnly: ui.readOnly ?? null, unsaved: ui.unsaved === true, notice: ui.editNotice?.text ?? null }
}

/** Wait until the viewer's document is in the state `pred` accepts; fails with `what` and the last state seen. */
export async function waitEdit(kea: Kea, what: string, pred: (s: EditState) => boolean, ms = STEP_MS): Promise<EditState> {
  let last: EditState | null = null
  try {
    return await until(
      what,
      async () => {
        last = await editState(kea)
        return last && pred(last) ? last : undefined
      },
      ms,
    )
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\nlast: ${JSON.stringify(last)}`)
  }
}

/** `n` lines of TypeScript, `export const v<i> = <i>` (1-based), with the lines `edits` names replaced; a final newline. */
export function numbered(n: number, edits: Readonly<Record<number, string>> = {}): string {
  return `${Array.from({ length: n }, (_, i) => edits[i + 1] ?? `export const v${i + 1} = ${i + 1}`).join('\n')}\n`
}

/**
 * Write a file of a session's worktree as an agent does, whole: a temporary file in the same folder renamed over it, so
 * a read never meets it half written.
 */
export function agentWrites(worktree: string, rel: string, text: string): void {
  const abs = path.join(worktree, rel)
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.agent-write`)
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, abs)
}

/** A file of a worktree as it is on disk. */
export function diskText(worktree: string, rel: string): string {
  return fs.readFileSync(path.join(worktree, rel), 'utf8')
}

/** The warning before the unsaved changes to the file named `name` are lost (any file's when no name is given). */
export function unsavedSheet(page: Page, name?: string): Locator {
  return page.getByRole('alertdialog', { name: name === undefined ? /^Do you want to save the changes you made to / : `Do you want to save the changes you made to ${name}?` })
}

/** The warning's buttons. */
export const SAVE = 'Save'
export const DONT_SAVE = 'Don’t Save'
export const CANCEL = 'Cancel'

/** The notice line about the document's text, under the viewer's header. */
export function editNotice(page: Page): Locator {
  return page.locator('.viewer .viewer-edit-notice')
}

/** The document's lines marked as changed on disk where the user edited too. */
export function markedLines(page: Page): Locator {
  return page.locator('.viewer .cm-editor:not(.cm-merge-a) .cm-line.kea-conflict')
}

/** `⌃G` to the end of line `n` of the document with the keyboard, as the user goes there. */
export async function toLineEnd(kea: Kea, n: number): Promise<void> {
  const page = await kea.page()
  await page.keyboard.press(sysKey('Control+g'))
  await page.locator('.viewer .kea-goto .kea-bar-input').waitFor({ timeout: STEP_MS })
  await page.keyboard.type(String(n))
  await page.keyboard.press('Enter')
  await page.locator('.viewer .kea-goto').waitFor({ state: 'detached', timeout: STEP_MS })
  await page.keyboard.press('End')
  const v = await viewer(kea)
  if (v?.text?.selection.from.line !== n) throw new Error(`the cursor is on line ${v?.text?.selection.from.line}, not ${n}`)
}

/** Type `text` at the end of line `n` (one input, as an input method commits it: one undo step). */
export async function typeAtLineEnd(kea: Kea, n: number, text: string): Promise<void> {
  await toLineEnd(kea, n)
  await (await kea.page()).keyboard.insertText(text)
}

/** `⌘Z` (Linux `Ctrl+Z`): the document's own undo, a text field's key. */
export const UNDO = textKey('Meta+z')

/**
 * Quit Kea Completely as the application menu's item (`app.quit`, `⌥⌘Q`) runs it, without letting unsaved files go
 * first: the windows are asked about them.
 */
export async function quitCompletely(kea: Kea): Promise<void> {
  await kea.app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('app.quit')
    if (!item) throw new Error('no app.quit menu item')
    ;(item as unknown as { click(): void }).click()
  })
}

/** Click the window's close button, as main's `BrowserWindow.close()` does; unsaved files are asked about first. */
export async function closeWindowAsking(kea: Kea): Promise<void> {
  const n = await kea.app.evaluate(({ BrowserWindow }) => {
    const ws = BrowserWindow.getAllWindows()
    ws[0]?.close()
    return ws.length
  })
  if (n !== 1) throw new Error(`expected one window, found ${n}`)
}

/** How many windows main has. */
export function windowCount(kea: Kea): Promise<number> {
  return kea.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

/** Main's exit status, once it has exited. */
export function exitOf(kea: Kea): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const proc = kea.app.process()
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve({ code: proc.exitCode, signal: proc.signalCode })
    else proc.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

type Probe = {
  store(name: string): { rows: Record<string, { cwd?: string }> | null }
  holdAnswers(methods: string[]): void
  heldAnswers(): Record<string, number>
  releaseAnswers(method?: string): void
}
const probe = (): Probe => (globalThis as unknown as { __keaProbe: Probe }).__keaProbe

/** A session's worktree, as core's sessions store lists it. */
export async function sessionCwd(kea: Kea, id: string): Promise<string> {
  const page = await kea.page()
  return until(`the worktree of session ${id}`, () => page.evaluate(`(${probe.toString()})().store('sessions').rows?.[${JSON.stringify(id)}]?.cwd`) as Promise<string | undefined>)
}

/** Hold core's answers to `methods` in the window until they are released (a slow core). */
export async function holdAnswers(kea: Kea, methods: string[]): Promise<void> {
  await (await kea.page()).evaluate(`(${probe.toString()})().holdAnswers(${JSON.stringify(methods)})`)
}

/** How many of core's answers to `method` wait at its hold. */
export async function heldAnswers(kea: Kea, method: string): Promise<number> {
  const held = (await (await kea.page()).evaluate(`(${probe.toString()})().heldAnswers()`)) as Record<string, number>
  return held[method] ?? 0
}

/** Let the answers held for `method` through, and hold it no more. */
export async function releaseAnswers(kea: Kea, method: string): Promise<void> {
  await (await kea.page()).evaluate(`(${probe.toString()})().releaseAnswers(${JSON.stringify(method)})`)
}
