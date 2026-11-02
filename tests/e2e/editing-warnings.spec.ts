// Editing in the file viewer when the file changes under the user's unsaved text, and the warning before unsaved changes
// are lost: Kea launched through tests/e2e/fixtures.ts, a session started in a demo repository, its files opened as a
// person opens them (a click on their row in Files) and typed into. The agent's writes are the test's own, made whole in
// the session's worktree (tests/support/app-warnings.ts `agentWrites`). The window's close button and the quit items are
// driven through main, as tests/support/app-menubar.ts drives `⌘Q`, never through the harness's own close and quit,
// which let every unsaved file go first. editing.spec.ts covers typing and saving themselves.

import fs from 'node:fs'
import path from 'node:path'
import { until, type Kea, type KeaRun } from '../support/app.ts'
import { inMenuBar, menuBar, menuBarState, NO_DOCK, NO_MENU_BAR, pressQuit, quitSheet } from '../support/app-menubar.ts'
import { clickFile } from '../support/app-files.ts'
import { addProject, demoRepo, paneSession, selectSession, sessionMenu, sessionRow, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { fileTab, fileTabs, viewerShown } from '../support/app-tabs.ts'
import { commitAll, sessionWorktree, viewerRows, viewerText, waitBody, writeFiles } from '../support/app-viewer.ts'
import {
  agentWrites,
  CANCEL,
  closeWindowAsking,
  diskText,
  DONT_SAVE,
  editNotice,
  editState,
  exitOf,
  heldAnswers,
  holdAnswers,
  markedLines,
  numbered,
  quitCompletely,
  releaseAnswers,
  SAVE,
  sessionCwd,
  typeAtLineEnd,
  UNDO,
  unsavedSheet,
  waitEdit,
  windowCount,
} from '../support/app-warnings.ts'
import { sysKey } from '../support/keys.ts'
import { expect, test } from './fixtures.ts'

const FILE = 'src/values.ts'
const NAME = 'values.ts'
const SAVE_KEY = sysKey('Meta+s')
const CONFLICT_ONE = 'Changed on disk where you edited (1 place)'

/** A demo project with `files` committed, and a session started in it: its id and its worktree. */
async function sessionWith(kea: Kea, run: KeaRun, files: Record<string, string>): Promise<{ id: string; worktree: string }> {
  await kea.pretendFocused(true)
  const repo = demoRepo(run)
  writeFiles(repo.root, files)
  commitAll(repo.root, 'Add files')
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'edit')
  await waitLive(kea, id)
  return { id, worktree: sessionWorktree(repo.root) }
}

/** Click `rel` in Files; resolves once its text is on screen and can be edited. */
async function openEditable(kea: Kea, rel: string): Promise<void> {
  await clickFile(kea, rel)
  await waitBody(kea, rel, 'text')
  await waitEdit(kea, `${rel} editable`, (s) => s.path === rel && s.editable)
}

/** The document on screen reads `text`. */
async function waitText(kea: Kea, what: string, text: string): Promise<void> {
  let last = ''
  await until(what, async () => (last = await viewerText(kea)) === text || undefined).catch((e: Error) => {
    throw new Error(`${e.message}\nshown: ${JSON.stringify(last)}\nwanted: ${JSON.stringify(text)}`)
  })
}

test('E-FV-15 · the agent writes the open file: a clean file takes the write and ⌘Z does not take it out; under unsaved text its change to other lines comes in, the user’s text stays, and undo takes out only the user’s typing, never the agent’s text', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, { [FILE]: numbered(40) })
  await openEditable(kea, FILE)

  // 1. clean: the write is on screen at once, out of the undo history
  const first = numbered(40, { 30: "export const v30 = 'agent one'" })
  agentWrites(worktree, FILE, first)
  await waitText(kea, 'the agent’s write on screen', first)
  await page.keyboard.press(UNDO)
  expect(await viewerText(kea), '⌘Z does not take the agent’s write out').toBe(first)
  expect((await editState(kea))?.unsaved, 'the document is the file').toBe(false)

  // 2. the user types on line 3; the agent then rewrites lines 30 and 31, far from it
  await typeAtLineEnd(kea, 3, ' // mine')
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)
  await expect(fileTab(page, FILE), 'the tab’s dot').toHaveClass(/\bunsaved\b/)
  expect(await viewerText(kea)).toBe(numbered(40, { 3: 'export const v3 = 3 // mine', 30: "export const v30 = 'agent one'" }))
  const second = numbered(40, { 30: "export const v30 = 'agent two'", 31: "export const v31 = 'agent two'" })
  agentWrites(worktree, FILE, second)
  const merged = numbered(40, { 3: 'export const v3 = 3 // mine', 30: "export const v30 = 'agent two'", 31: "export const v31 = 'agent two'" })
  await waitText(kea, 'the agent’s lines merged under the user’s text', merged)
  const after = await editState(kea)
  expect(after, 'still unsaved, nothing marked').toMatchObject({ unsaved: true, editable: true, notice: null })
  await expect(markedLines(page)).toHaveCount(0)
  expect(diskText(worktree, FILE), 'nothing was saved').toBe(second)

  // 3. undo takes out the user's typing and nothing else, however often it is pressed
  for (let i = 0; i < 3; i++) await page.keyboard.press(UNDO)
  expect(await viewerText(kea), 'the agent’s text stays').toBe(second)
  await waitEdit(kea, 'the document is the file again', (s) => !s.unsaved)
  await expect(fileTab(page, FILE)).not.toHaveClass(/\bunsaved\b/)
})

test('E-FV-15 · the agent rewrites the line the user changed: it is marked and keeps the user’s text; ⌘S saves nothing while it is; Compare shows the file against the document, says when the file changes meanwhile, and Esc returns with that change merged; Use the File’s takes the file’s text and ⌘Z puts the mark back; Keep Yours clears it and ⌘S saves the user’s text', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, { [FILE]: numbered(40) })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 10, ' // mine')
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)

  // the agent rewrites line 10 too, and line 25
  const theirs = numbered(40, { 10: "export const v10 = 'agent'", 25: "export const v25 = 'agent'" })
  const mine = numbered(40, { 10: 'export const v10 = 10 // mine', 25: "export const v25 = 'agent'" })
  agentWrites(worktree, FILE, theirs)
  const marked = await waitEdit(kea, 'the line both changed marked', (s) => s.notice === CONFLICT_ONE)
  expect(marked.unsaved).toBe(true)
  expect(await viewerText(kea), 'the user’s line stays; the agent’s other line comes in').toBe(mine)
  await expect(markedLines(page), 'the marked line').toHaveText(['export const v10 = 10 // mine'])
  await expect(editNotice(page).getByRole('button')).toHaveText(['Compare', 'Use the File’s', 'Keep Yours'])

  // ⌘S while a line is marked saves nothing and takes the keyboard to the notice's actions
  await page.keyboard.press(SAVE_KEY)
  await expect(editNotice(page).getByRole('button', { name: 'Compare' }), 'the notice’s first action has the keyboard').toBeFocused()
  expect(diskText(worktree, FILE), 'nothing saved').toBe(theirs)

  // Compare (↵ on it): the file's text against the document, read-only; Esc returns to the document, still marked
  await page.keyboard.press('Enter')
  const compare = await waitBody(kea, FILE, 'diff')
  expect(compare.ui.notices, 'the file’s own notices are not Compare’s').toEqual([])
  expect((await editState(kea))?.notice).toBe('Comparing with the file on disk · Esc returns')
  await expect(page.locator('.viewer .cm-deletedChunk .cm-deletedLine'), 'the file’s line, against the user’s').toHaveText(["export const v10 = 'agent'"])
  await expect(editNotice(page).getByRole('button')).toHaveText(['Use the File’s', 'Keep Yours'])
  // the agent writes another line meanwhile: Compare says so and goes on showing what it began with
  const theirs2 = numbered(40, { 10: "export const v10 = 'agent'", 25: "export const v25 = 'agent'", 30: "export const v30 = 'agent'" })
  const mine2 = numbered(40, { 10: 'export const v10 = 10 // mine', 25: "export const v25 = 'agent'", 30: "export const v30 = 'agent'" })
  agentWrites(worktree, FILE, theirs2)
  await waitEdit(kea, 'Compare says the file changed', (s) => s.body === 'diff' && (s.notice ?? '').includes('changed since'))
  await page.keyboard.press('Escape')
  await waitBody(kea, FILE, 'text')
  await expect(page.locator('.viewer .cm-editor:not(.cm-merge-a) .cm-content'), 'the document has the keyboard').toBeFocused()
  // the change comes in now, merged under the user's text, which stays marked
  await waitText(kea, 'the agent’s new line merged in', mine2)
  await waitEdit(kea, 'still marked', (s) => s.unsaved && s.notice === CONFLICT_ONE)
  await expect(markedLines(page)).toHaveCount(1)

  // Use the File's: the marked line takes the file's text, and the document is the file again
  await editNotice(page).getByRole('button', { name: 'Use the File’s' }).click()
  await waitText(kea, 'the file’s text', theirs2)
  await waitEdit(kea, 'nothing unsaved, nothing marked', (s) => !s.unsaved && s.notice === null)
  await expect(markedLines(page)).toHaveCount(0)
  // ⌘Z: the user's line again, marked again
  await page.keyboard.press(UNDO)
  await waitText(kea, 'the user’s line back', mine2)
  await waitEdit(kea, 'marked again', (s) => s.unsaved && s.notice === CONFLICT_ONE)
  await expect(markedLines(page)).toHaveText(['export const v10 = 10 // mine'])

  // Keep Yours: the mark goes, the user's text stays unsaved; ⌘S saves it over the agent's write
  await editNotice(page).getByRole('button', { name: 'Keep Yours' }).click()
  await waitEdit(kea, 'no mark, still unsaved', (s) => s.unsaved && s.notice === null)
  await expect(markedLines(page)).toHaveCount(0)
  await page.keyboard.press(SAVE_KEY)
  await waitEdit(kea, 'saved', (s) => !s.unsaved)
  expect(diskText(worktree, FILE)).toBe(mine2)
  await expect(fileTab(page, FILE)).not.toHaveClass(/\bunsaved\b/)
})

test('E-FV-15 · a save that meets the agent’s newer write merges it and saves both; the reads of the write that arrive after the save change nothing', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, { [FILE]: numbered(40) })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 3, ' // mine')
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)

  // the agent rewrites line 30; the window's read of it is held, so the save is the first to meet it
  await holdAnswers(kea, ['viewer.read'])
  const theirs = numbered(40, { 30: "export const v30 = 'agent'" })
  agentWrites(worktree, FILE, theirs)
  await until('the window’s read of the agent’s write, held', async () => (await heldAnswers(kea, 'viewer.read')) > 0 || undefined)
  expect(await viewerText(kea), 'not on screen yet').toBe(numbered(40, { 3: 'export const v3 = 3 // mine' }))
  await page.keyboard.press(SAVE_KEY)
  const both = numbered(40, { 3: 'export const v3 = 3 // mine', 30: "export const v30 = 'agent'" })
  await until('both changes on disk', () => diskText(worktree, FILE) === both || undefined)
  await waitEdit(kea, 'saved', (s) => !s.unsaved && s.notice === null)
  expect(await viewerText(kea), 'the agent’s line merged in').toBe(both)
  // the reads held are older than the save: they change nothing
  await releaseAnswers(kea, 'viewer.read')
  await until('the held reads through', async () => (await heldAnswers(kea, 'viewer.read')) === 0 || undefined)
  expect(await viewerText(kea)).toBe(both)
  expect((await editState(kea))?.unsaved).toBe(false)
  await expect(fileTab(page, FILE)).not.toHaveClass(/\bunsaved\b/)
})

test('E-FV-15 · a save that meets the agent’s write while its file is not on screen: the file’s text is merged when it is shown again, and saved again', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const OTHER = 'src/other.ts'
  const { worktree } = await sessionWith(kea, run, { [FILE]: numbered(40), [OTHER]: numbered(5) })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 3, ' // mine')
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)

  // the agent rewrites line 30, unread by the window; ⌘S meets it, and its answer is held while another tab shows
  await holdAnswers(kea, ['viewer.read', 'viewer.save'])
  const theirs = numbered(40, { 30: "export const v30 = 'agent'" })
  agentWrites(worktree, FILE, theirs)
  await until('the window’s read of the agent’s write, held', async () => (await heldAnswers(kea, 'viewer.read')) > 0 || undefined)
  await page.keyboard.press(SAVE_KEY)
  await until('the save’s answer, held', async () => (await heldAnswers(kea, 'viewer.save')) > 0 || undefined)
  await releaseAnswers(kea, 'viewer.read')
  await openEditable(kea, OTHER)
  await releaseAnswers(kea, 'viewer.save')
  await until('the save’s answer through', async () => (await heldAnswers(kea, 'viewer.save')) === 0 || undefined)
  expect(diskText(worktree, FILE), 'nothing written over the agent’s change').toBe(theirs)

  // shown again: the agent's line merged in, and the save made again with both
  await openEditable(kea, FILE)
  const both = numbered(40, { 3: 'export const v3 = 3 // mine', 30: "export const v30 = 'agent'" })
  await waitText(kea, 'the agent’s line merged in', both)
  await until('both changes on disk', () => diskText(worktree, FILE) === both || undefined)
  await waitEdit(kea, 'saved', (s) => !s.unsaved && s.notice === null)
  await expect(fileTab(page, FILE)).not.toHaveClass(/\bunsaved\b/)
})

test('E-FV-15 · the file deleted under unsaved text: the text stays and the notice says so, and Save makes the file again with its mode', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, { [FILE]: numbered(40) })
  const abs = path.join(worktree, FILE)
  fs.chmodSync(abs, 0o600)
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 5, ' // kept')
  const kept = numbered(40, { 5: 'export const v5 = 5 // kept' })
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)

  fs.rmSync(abs)
  await waitEdit(kea, 'deleted on disk', (s) => s.notice === 'Deleted on disk · Save to create it again' && s.unsaved && s.editable)
  await expect(editNotice(page).getByRole('button')).toHaveText([SAVE])
  expect(await viewerText(kea), 'the user’s text stays').toBe(kept)
  await editNotice(page).getByRole('button', { name: SAVE }).click()
  await waitEdit(kea, 'saved', (s) => !s.unsaved && s.notice === null)
  expect(diskText(worktree, FILE)).toBe(kept)
  expect((fs.statSync(abs).mode & 0o777).toString(8), 'its mode').toBe('600')
})

test('E-FV-15 · a read already on its way when Compare opens does not end it: Compare stays and says the file has changed since; Esc returns the user’s document with its text and its mark, and the change is merged then', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, { [FILE]: numbered(40) })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 10, ' // mine')
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)
  agentWrites(worktree, FILE, numbered(40, { 10: "export const v10 = 'agent'" }))
  await waitEdit(kea, 'the line both changed marked', (s) => s.notice === CONFLICT_ONE)
  expect(await viewerText(kea)).toBe(numbered(40, { 10: 'export const v10 = 10 // mine' }))

  // the agent writes another line; the window's read of it is held, and Compare opens before it lands
  await holdAnswers(kea, ['viewer.read'])
  agentWrites(worktree, FILE, numbered(40, { 10: "export const v10 = 'agent'", 30: "export const v30 = 'agent'" }))
  await until('the window’s read of the agent’s write, held', async () => (await heldAnswers(kea, 'viewer.read')) > 0 || undefined)
  await editNotice(page).getByRole('button', { name: 'Compare' }).click()
  await waitBody(kea, FILE, 'diff')
  await releaseAnswers(kea, 'viewer.read')
  await until('the held read through', async () => (await heldAnswers(kea, 'viewer.read')) === 0 || undefined)
  const comparing = await waitEdit(kea, 'Compare says the file changed', (s) => (s.notice ?? '').includes('changed since'))
  expect(comparing.body, 'Compare stays on screen').toBe('diff')
  await expect(editNotice(page).getByRole('button')).toHaveText(['Use the File’s', 'Keep Yours'])
  await expect(page.locator('.viewer .cm-deletedChunk .cm-deletedLine'), 'what Compare began with').toHaveText(["export const v10 = 'agent'"])

  // Esc: the user's document, its text and its mark, then the agent's new line merged in
  await page.keyboard.press('Escape')
  await waitBody(kea, FILE, 'text')
  await waitText(kea, 'the agent’s new line merged in', numbered(40, { 10: 'export const v10 = 10 // mine', 30: "export const v30 = 'agent'" }))
  await waitEdit(kea, 'still marked', (s) => s.unsaved && s.editable && s.notice === CONFLICT_ONE)
  await expect(markedLines(page)).toHaveText(['export const v10 = 10 // mine'])
})

test('E-FV-15 · the file becomes binary under unsaved text: the text stays, read-only, and says so; the file put back byte for byte makes it editable again, and ⌘S saves it', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const original = numbered(40)
  const { worktree } = await sessionWith(kea, run, { [FILE]: original })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 5, ' // kept')
  const kept = numbered(40, { 5: 'export const v5 = 5 // kept' })
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)

  agentWrites(worktree, FILE, 'not text\0 any more\n')
  const binary = await waitEdit(kea, 'the file is now binary', (s) => s.notice === `${NAME} is now a binary file: your changes can’t be saved there`)
  expect(binary).toMatchObject({ unsaved: true, editable: false, readOnly: 'the file is now a binary file' })
  await expect(editNotice(page).getByRole('button')).toHaveText(['Copy All', DONT_SAVE])
  expect(await viewerText(kea), 'the user’s text stays').toBe(kept)

  // the file put back as it was, as `git checkout` puts it back: the document's changes can be saved there again
  agentWrites(worktree, FILE, original)
  await waitEdit(kea, 'editable again', (s) => s.editable && s.unsaved && s.readOnly === null && s.notice === null)
  expect(await viewerText(kea)).toBe(kept)
  await page.keyboard.press(SAVE_KEY)
  await waitEdit(kea, 'saved', (s) => !s.unsaved && s.notice === null)
  expect(diskText(worktree, FILE)).toBe(kept)
})

test('E-FV-15 · a save that meets the agent’s write while an input method composes: nothing is saved again meanwhile; once the composition ends the write is merged and saved with the user’s text', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await sessionWith(kea, run, { [FILE]: numbered(40) })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 3, ' // mine')
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)

  // the agent rewrites line 30, unread by the window; ⌘S meets it, and its answer is held
  await holdAnswers(kea, ['viewer.read', 'viewer.save'])
  const theirs = numbered(40, { 30: "export const v30 = 'agent'" })
  agentWrites(worktree, FILE, theirs)
  await until('the window’s read of the agent’s write, held', async () => (await heldAnswers(kea, 'viewer.read')) > 0 || undefined)
  await page.keyboard.press(SAVE_KEY)
  await until('the save’s answer, held', async () => (await heldAnswers(kea, 'viewer.save')) > 0 || undefined)

  // an input method composes at the end of line 3 while the save's answer (the file changed) lands
  const ime = await page.context().newCDPSession(page)
  await ime.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 })
  await waitText(kea, 'the composition in the document', numbered(40, { 3: 'export const v3 = 3 // minek' }))
  await releaseAnswers(kea, 'viewer.save')
  await until('the save’s answer taken', async () => (await viewerRows(kea)).viewerSaving === 0 || undefined)
  const waiting = await editState(kea)
  expect(waiting, 'not saved again and again: the merge waits for the composition').toMatchObject({ unsaved: true, notice: null })
  expect(diskText(worktree, FILE), 'nothing written over the agent’s change').toBe(theirs)

  // the composition ends: the agent's line merged in, and the save made again with both
  await ime.send('Input.insertText', { text: 'か' })
  const both = numbered(40, { 3: 'export const v3 = 3 // mineか', 30: "export const v30 = 'agent'" })
  await waitText(kea, 'the agent’s line merged in', both)
  await until('both on disk', () => diskText(worktree, FILE) === both || undefined)
  await waitEdit(kea, 'saved', (s) => !s.unsaved && s.notice === null)
  await releaseAnswers(kea, 'viewer.read')
  await ime.detach()
})

test('E-FV-17 · ⌘W on a tab with unsaved changes asks Save, Don’t Save or Cancel, Save the default: Cancel or Esc keeps the tab unsaved, Save writes the file and closes the tab, Don’t Save closes it and leaves the file as it was; Esc on the tab itself does nothing', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const original = numbered(20)
  const { worktree } = await sessionWith(kea, run, { [FILE]: original })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 2, ' // first')
  const first = numbered(20, { 2: 'export const v2 = 2 // first' })
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)
  await expect(fileTab(page, FILE), 'the dot').toHaveClass(/\bunsaved\b/)
  await expect(fileTab(page, FILE)).toHaveAttribute('aria-label', `${NAME}, unsaved`)

  // Esc on the tab does nothing
  await page.keyboard.press('Escape')
  expect(await fileTabs(kea), 'the tab stays, pinned by the typing').toEqual([{ path: FILE, kind: 'file', pinned: true, selected: true }])
  await expect(unsavedSheet(page)).toHaveCount(0)
  expect(await viewerShown(kea)).toEqual({ path: FILE, mode: 'file', focused: true })

  // ⌘W asks; Save is the default and has the keyboard
  await page.keyboard.press(sysKey('Meta+w'))
  const sheet = unsavedSheet(page, NAME)
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('Your changes will be lost if you don’t save them.')
  await expect(sheet.getByRole('button')).toHaveText([SAVE, DONT_SAVE, CANCEL])
  const save = sheet.getByRole('button', { name: SAVE, exact: true })
  await expect(save).toHaveAttribute('data-default', 'true')
  await expect(save).toBeFocused()

  // Cancel keeps the tab, unsaved; so does Esc on the sheet
  await sheet.getByRole('button', { name: CANCEL }).click()
  await expect(sheet).toHaveCount(0)
  expect((await fileTabs(kea)).map((t) => t.path)).toEqual([FILE])
  await waitEdit(kea, 'still unsaved and editable', (s) => s.unsaved && s.editable)
  await page.keyboard.press(sysKey('Meta+w'))
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect((await fileTabs(kea)).map((t) => t.path)).toEqual([FILE])
  expect(await viewerText(kea)).toBe(first)
  expect(diskText(worktree, FILE), 'nothing written').toBe(original)

  // Save writes the file, then closes the tab
  await page.keyboard.press(sysKey('Meta+w'))
  await sheet.getByRole('button', { name: SAVE, exact: true }).click()
  await until('the tab closed', async () => (await fileTabs(kea)).length === 0 || undefined)
  expect(diskText(worktree, FILE)).toBe(first)

  // Don't Save closes the tab and leaves the file as it is on disk
  await openEditable(kea, FILE)
  expect(await viewerText(kea)).toBe(first)
  await typeAtLineEnd(kea, 4, ' // second')
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)
  await page.keyboard.press(sysKey('Meta+w'))
  await sheet.getByRole('button', { name: DONT_SAVE }).click()
  await until('the tab closed', async () => (await fileTabs(kea)).length === 0 || undefined)
  expect(diskText(worktree, FILE), 'nothing written').toBe(first)
  await openEditable(kea, FILE)
  expect(await viewerText(kea), 'the file as it is').toBe(first)
  expect((await editState(kea))?.unsaved).toBe(false)
})

test('E-FV-17 · ⌘Q with unsaved files in two sessions: the first-quit sheet first, then each file put on screen and asked in turn; Cancel on the second stops the quit with the first given back unsaved; the agent then rewrites the line the user changed, and at the next ⌘Q the marked file on screen is asked first, and Don’t Save on both lets Kea go', async ({ run, launch }) => {
  test.setTimeout(180_000)
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const ALPHA = 'src/alpha.ts'
  const BETA = 'src/beta.ts'
  const original = numbered(20)
  const repo = demoRepo(run)
  writeFiles(repo.root, { [ALPHA]: original, [BETA]: original })
  commitAll(repo.root, 'Add files')
  await addProject(kea, repo.root)
  const a = await startSession(kea, 'first')
  await waitLive(kea, a)
  const b = await startSession(kea, 'second')
  await waitLive(kea, b)
  const aDir = await sessionCwd(kea, a)
  const bDir = await sessionCwd(kea, b)

  // unsaved text in B's beta.ts, then in A's alpha.ts (A on screen)
  await openEditable(kea, BETA)
  await typeAtLineEnd(kea, 3, ' // b')
  await waitEdit(kea, 'beta.ts unsaved', (s) => s.unsaved)
  await selectSession(kea, a)
  await openEditable(kea, ALPHA)
  await typeAtLineEnd(kea, 3, ' // a')
  await waitEdit(kea, 'alpha.ts unsaved', (s) => s.unsaved)
  const alphaText = numbered(20, { 3: 'export const v3 = 3 // a' })
  const betaText = numbered(20, { 3: 'export const v3 = 3 // b' })
  await expect(sessionRow(page, a).locator('[data-unsaved]')).toHaveText('unsaved')
  await expect(sessionRow(page, b).locator('[data-unsaved]')).toHaveText('unsaved')
  await menuBarState(kea, 'both sessions’ terminals running', (s) => s.running >= 2)

  // 1. ⌘Q: the first-quit sheet, and no file asked about yet
  await pressQuit(kea)
  const quit = quitSheet(page)
  await expect(quit).toBeVisible()
  await expect(unsavedSheet(page)).toHaveCount(0)
  await quit.getByRole('button', { name: 'Stop All and Quit' }).click()
  // the file on screen first: A's alpha.ts
  const askA = unsavedSheet(page, 'alpha.ts')
  await expect(askA).toBeVisible()
  expect(await paneSession(page)).toBe(a)
  expect((await viewerShown(kea))?.path).toBe(ALPHA)
  await askA.getByRole('button', { name: DONT_SAVE }).click()
  // then B's beta.ts, its session and tab put on screen
  const askB = unsavedSheet(page, 'beta.ts')
  await expect(askB).toBeVisible()
  expect(await paneSession(page)).toBe(b)
  expect((await viewerShown(kea))?.path).toBe(BETA)
  // Cancel: the quit stops there
  await askB.getByRole('button', { name: CANCEL }).click()
  await expect(askB).toHaveCount(0)
  await expect(quit).toHaveCount(0)
  expect(await windowCount(kea), 'the window stays').toBe(1)
  expect((await menuBar(kea)).item, 'Kea is not in the menu bar').toBe(false)
  await waitEdit(kea, 'beta.ts still unsaved, editable', (s) => s.path === BETA && s.unsaved && s.editable)
  expect(await viewerText(kea)).toBe(betaText)
  // A's alpha.ts, set aside by Don't Save, is given back: unsaved, editable, its text kept
  await selectSession(kea, a)
  await waitEdit(kea, 'alpha.ts unsaved again', (s) => s.path === ALPHA && s.unsaved && s.editable && s.notice === null)
  expect(await viewerText(kea)).toBe(alphaText)
  await expect(fileTab(page, ALPHA)).toHaveClass(/\bunsaved\b/)
  await expect(sessionRow(page, a).locator('[data-unsaved]')).toHaveText('unsaved')
  await expect(sessionRow(page, b).locator('[data-unsaved]')).toHaveText('unsaved')
  expect([diskText(aDir, ALPHA), diskText(bDir, BETA)], 'nothing written').toEqual([original, original])

  // 2. B on screen; the agent rewrites the line the user changed in beta.ts: marked
  await selectSession(kea, b)
  await waitEdit(kea, 'beta.ts on screen', (s) => s.path === BETA && s.unsaved)
  const theirs = numbered(20, { 3: "export const v3 = 'agent'" })
  agentWrites(bDir, BETA, theirs)
  await waitEdit(kea, 'the line marked', (s) => s.notice === CONFLICT_ONE)

  // 3. ⌘Q again (the sheet was answered): the marked file on screen is asked first, with its mark on screen
  const exited = exitOf(kea)
  await pressQuit(kea)
  const askMarked = unsavedSheet(page, 'beta.ts')
  await expect(askMarked).toBeVisible()
  await expect(quit).toHaveCount(0)
  await expect(editNotice(page)).toContainText(CONFLICT_ONE)
  await expect(markedLines(page)).toHaveCount(1)
  await askMarked.getByRole('button', { name: DONT_SAVE }).click()
  const askAgain = unsavedSheet(page, 'alpha.ts')
  await expect(askAgain).toBeVisible()
  expect(await paneSession(page)).toBe(a)
  await askAgain.getByRole('button', { name: DONT_SAVE }).click()
  if (NO_MENU_BAR === null) {
    // Kea stays in the menu bar with its terminals running; the window and its unsaved text went
    await inMenuBar(kea)
  } else {
    // with nowhere to stay, every terminal is stopped and Kea quits
    expect(await exited).toEqual({ code: 0, signal: null })
    await kea.gone()
  }
  expect([diskText(aDir, ALPHA), diskText(bDir, BETA)], 'the user’s text was not written').toEqual([original, theirs])
})

test('E-FV-17 · the window’s close button with an unsaved file asks first: Cancel keeps the window and the text unsaved; Don’t Save closes the window and Kea runs on, the file as it was', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const original = numbered(20)
  const { worktree } = await sessionWith(kea, run, { [FILE]: original })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 2, ' // mine')
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)

  // Cancel: the window stays, the text unsaved
  await closeWindowAsking(kea)
  const sheet = unsavedSheet(page, NAME)
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: CANCEL }).click()
  await expect(sheet).toHaveCount(0)
  expect(await windowCount(kea)).toBe(1)
  await waitEdit(kea, 'still unsaved, editable', (s) => s.unsaved && s.editable)
  expect(await viewerText(kea)).toBe(numbered(20, { 2: 'export const v2 = 2 // mine' }))

  // Don't Save: the window closes
  const closed = page.waitForEvent('close')
  const exited = exitOf(kea)
  await closeWindowAsking(kea)
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: DONT_SAVE }).click()
  await closed
  expect(diskText(worktree, FILE), 'nothing written').toBe(original)
  if (NO_DOCK !== null) {
    // with nowhere to keep Kea, closing its last window quits it
    expect(await exited).toEqual({ code: 0, signal: null })
    await kea.gone()
    return
  }
  // Kea runs on without its window; reopened, the file is as it is on disk
  expect(await windowCount(kea)).toBe(0)
  expect((await kea.processes()).core, 'core runs on').not.toBeNull()
  await kea.reopenWindow()
  await openEditable(kea, FILE)
  expect(await viewerText(kea)).toBe(original)
  expect((await editState(kea))?.unsaved).toBe(false)
})

test('E-FV-17 · deleting a session with an unsaved file asks about it; after Don’t Save the file is closing while the delete runs, and when the delete fails the file is unsaved again with its text; Quit Kea Completely then asks about it, and Don’t Save quits', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const original = numbered(20)
  const { id, worktree } = await sessionWith(kea, run, { [FILE]: original })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 2, ' // mine')
  const mine = numbered(20, { 2: 'export const v2 = 2 // mine' })
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)

  // core stops for good once the delete starts (tests/support/app-child-hooks.cjs `hold`)
  const held = path.join(run.home, 'held-delete')
  await kea.debug('core', 'hold', `delete:stop|${held}`)
  await sessionMenu(kea, id, 'session.delete')
  const del = page.getByRole('alertdialog', { name: 'Delete session' })
  await del.getByRole('button', { name: 'Delete' }).click()
  const sheet = unsavedSheet(page, NAME)
  await expect(sheet).toBeVisible()
  expect((await viewerShown(kea))?.path).toBe(FILE)
  await sheet.getByRole('button', { name: DONT_SAVE }).click()
  await until('core holding the delete', () => (fs.existsSync(held) && fs.readFileSync(held, 'utf8') === id) || undefined)
  // set aside while the delete runs: read-only, closing
  const closing = await waitEdit(kea, 'the file closing', (s) => s.notice === 'Closing…' && !s.editable)
  expect(closing.readOnly).toBe('Closing…')

  // the delete fails: core goes away in the middle of it (its restart leaves the session as it was)
  const core = await kea.pid('core')
  await kea.signal('core', 'SIGKILL')
  await kea.restarted('core', core)
  await waitEdit(kea, 'unsaved again, editable', (s) => s.path === FILE && s.unsaved && s.editable && s.notice === null)
  expect(await viewerText(kea), 'the user’s text').toBe(mine)
  await expect(fileTab(page, FILE)).toHaveClass(/\bunsaved\b/)
  await waitRow(kea, id, 'the session still there', (r) => r.lifecycle === 'live')
  await expect(sessionRow(page, id).locator('[data-unsaved]')).toHaveText('unsaved')
  expect(diskText(worktree, FILE), 'nothing written').toBe(original)

  // Quit Kea Completely asks about it too; Don't Save stops every terminal and quits
  const exited = exitOf(kea)
  await quitCompletely(kea)
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: DONT_SAVE }).click()
  expect(await exited).toEqual({ code: 0, signal: null })
  await kea.gone()
  expect(diskText(worktree, FILE), 'nothing written').toBe(original)
})

test('E-FV-17 · a marked file under Compare when its session is deleted: after Don’t Save Compare’s line says it is closing and offers nothing; when the delete fails it offers Use the File’s and Keep Yours again, and Esc returns the user’s text with its mark', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { id, worktree } = await sessionWith(kea, run, { [FILE]: numbered(20) })
  await openEditable(kea, FILE)
  await typeAtLineEnd(kea, 2, ' // mine')
  const mine = numbered(20, { 2: 'export const v2 = 2 // mine' })
  await waitEdit(kea, 'unsaved', (s) => s.unsaved)
  const theirs = numbered(20, { 2: "export const v2 = 'agent'" })
  agentWrites(worktree, FILE, theirs)
  await waitEdit(kea, 'the line both changed marked', (s) => s.notice === CONFLICT_ONE)
  await editNotice(page).getByRole('button', { name: 'Compare' }).click()
  await waitBody(kea, FILE, 'diff')
  await expect(editNotice(page).getByRole('button')).toHaveText(['Use the File’s', 'Keep Yours'])

  // the delete asks about the file with Compare on screen; Don't Save sets it aside while core holds the delete
  const held = path.join(run.home, 'held-delete')
  await kea.debug('core', 'hold', `delete:stop|${held}`)
  await sessionMenu(kea, id, 'session.delete')
  await page.getByRole('alertdialog', { name: 'Delete session' }).getByRole('button', { name: 'Delete' }).click()
  const sheet = unsavedSheet(page, NAME)
  await expect(sheet).toBeVisible()
  expect((await editState(kea))?.body, 'Compare stays on screen').toBe('diff')
  await sheet.getByRole('button', { name: DONT_SAVE }).click()
  await until('core holding the delete', () => (fs.existsSync(held) && fs.readFileSync(held, 'utf8') === id) || undefined)
  await waitEdit(kea, 'Compare’s line closing', (s) => s.body === 'diff' && s.notice === 'Closing…')
  await expect(editNotice(page).getByRole('button'), 'nothing offered while it closes').toHaveCount(0)

  // the delete fails: core goes away in the middle of it
  const core = await kea.pid('core')
  await kea.signal('core', 'SIGKILL')
  await kea.restarted('core', core)
  await waitEdit(kea, 'Compare given back', (s) => s.body === 'diff' && (s.notice ?? '').startsWith('Comparing with the file on disk'))
  await expect(editNotice(page).getByRole('button')).toHaveText(['Use the File’s', 'Keep Yours'])
  await page.locator('.viewer .cm-content').first().click()
  await page.keyboard.press('Escape')
  await waitBody(kea, FILE, 'text')
  await waitEdit(kea, 'unsaved, still marked', (s) => s.unsaved && s.editable && s.notice === CONFLICT_ONE)
  expect(await viewerText(kea), 'the user’s text').toBe(mine)
  await expect(markedLines(page)).toHaveText(['export const v2 = 2 // mine'])
  expect(diskText(worktree, FILE), 'nothing written').toBe(theirs)
})
