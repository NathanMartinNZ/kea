// Editing files in the file view: Kea launched through tests/e2e/fixtures.ts, a session started in a demo repository,
// files put into its worktree and opened as the user opens them (a click on a row in Files), then typed into, undone,
// saved, found and replaced, and left and shown again with unsaved text. What the document holds is read from the
// viewer's read-only probe (tests/support/app-viewer.ts); what a save wrote is read from the file on disk. The keys
// are this system's (tests/support/keys.ts, tests/support/app-editing.ts `documentKey`).

import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol'
import { until, type Kea } from '../support/app.ts'
import { chooseEditMenuRole, documentKey, tabUnsavedMark, tryToEditDocument, waitDocument, waitFileText } from '../support/app-editing.ts'
import { clickFile, GIT_MS, panelRegion, TrashWorld, tree, treeRow, treeRowInView, waitTree } from '../support/app-files.ts'
import { addProject, agentTerminal, demoRepo, selectSession, sessionRow, startSession, waitLive } from '../support/app-sessions.ts'
import { clickFileTab, fileTab, fileTabs, pinFileTab, viewerShown } from '../support/app-tabs.ts'
import { commitAll, plainText, sessionWorktree, viewer, viewerRows, viewerText, waitBody, waitViewer, writeFiles } from '../support/app-viewer.ts'
import { waitEdit } from '../support/app-warnings.ts'
import { expect, test } from './fixtures.ts'
import { sysKey, textKey } from '../support/keys.ts'

/** A demo project with `files` committed, and a session started in it: its id and its worktree. */
async function editingSession(kea: Kea, run: Parameters<typeof demoRepo>[0], files: Record<string, string | Uint8Array>, prompt = 'editing'): Promise<{ id: string; worktree: string; repo: string }> {
  await kea.pretendFocused(true)
  const repo = demoRepo(run)
  if (Object.keys(files).length > 0) {
    writeFiles(repo.root, files)
    commitAll(repo.root, 'Add files')
  }
  await addProject(kea, repo.root)
  const id = await startSession(kea, prompt)
  await waitLive(kea, id)
  return { id, worktree: sessionWorktree(repo.root), repo: repo.root }
}

/** `⌃G`, `line[:col]`, `↵`. */
async function goToLine(kea: Kea, where: string): Promise<void> {
  const page = await kea.page()
  await page.keyboard.press(sysKey('Control+g'))
  await page.locator('.viewer .kea-goto .kea-bar-input').waitFor()
  await page.keyboard.type(where)
  await page.keyboard.press('Enter')
  await page.locator('.viewer .kea-goto').waitFor({ state: 'detached' })
}

/** `lines` with line `n` (1-based) replaced by `text`. */
const withLine = (lines: readonly string[], n: number, text: string): string[] => lines.map((l, i) => (i === n - 1 ? text : l))

/** Click line `n` of the document on screen (counted among the lines drawn) past its end; `alt` adds a cursor there. */
async function clickLineEnd(kea: Kea, n: number, alt = false): Promise<void> {
  const page = await kea.page()
  const line = page.locator('.viewer .cm-editor:not(.cm-merge-a) .cm-content .cm-line').nth(n - 1)
  const box = await line.boundingBox()
  if (!box) throw new Error(`line ${n} is not drawn`)
  await line.click({ position: { x: box.width - 4, y: box.height / 2 }, ...(alt ? { modifiers: ['Alt'] } : {}) })
}

test('E-FV-13 · a file clicked in Files is typed into, deleted from, undone and redone by key and by the Edit menu one step at a time, and typed at several cursors (⌥-click, ⌘D); the first key pins its preview tab, the tab’s dot shows while it is unsaved, and ⌘S writes the file and clears the dot', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const FILE = 'src/calc.ts'
  const original = ['export function add(a: number, b: number) {', '  const total = a + b', '  return total', '}', '', 'export function twice(n: number) {', '  const total = n * 2', '  return total', '}', '']
  const { worktree } = await editingSession(kea, run, { [FILE]: original.join('\n') })
  const onDisk = path.join(worktree, FILE)

  // a click in Files: the preview tab, an editable document with the keyboard, no dot
  await clickFile(kea, FILE)
  const opened = await waitBody(kea, FILE, 'text')
  expect([opened.ui.editable, opened.ui.readOnly, opened.ui.unsaved]).toEqual([true, null, false])
  await expect(page.locator('.viewer .viewer-readonly'), 'no Read-only label').toHaveCount(0)
  expect((await fileTabs(kea)).find((t) => t.path === FILE)).toMatchObject({ pinned: false, selected: true })
  await until('the document has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  expect(await tabUnsavedMark(kea, FILE)).toEqual({ dot: false, name: null })

  // 1. one key typed: in the text, the preview tab pinned by it, the dot on the tab
  await goToLine(kea, '2')
  await page.keyboard.press('End')
  await page.keyboard.type(';')
  const t1 = withLine(original, 2, '  const total = a + b;')
  await waitDocument(kea, 'the key typed', t1.join('\n'))
  await until('the preview tab pinned by the first key', async () => (await fileTab(page, FILE).getAttribute('data-pinned')) === 'true' || undefined)
  await until('the tab’s dot', async () => (await tabUnsavedMark(kea, FILE)).dot || undefined)
  expect(await tabUnsavedMark(kea, FILE)).toEqual({ dot: true, name: 'calc.ts, unsaved' })
  expect((await viewer(kea))?.ui.unsaved).toBe(true)

  // 2. more typing elsewhere (the cursor moved first: its own undo step), then a deletion: the line's text selected and deleted
  await goToLine(kea, '7')
  await page.keyboard.press('End')
  await page.keyboard.type(' // two')
  const t2 = withLine(t1, 7, '  const total = n * 2 // two')
  await waitDocument(kea, 'typed on line 7', t2.join('\n'))
  await goToLine(kea, '8')
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('Backspace')
  const t3 = withLine(t2, 8, '  ')
  await waitDocument(kea, 'line 8’s text deleted', t3.join('\n'))

  // 3. undo and redo by key, one step each; undone back to the file the document is clean, its dot gone
  await page.keyboard.press(documentKey('Meta+z'))
  await waitDocument(kea, '⌘Z: the deletion undone', t2.join('\n'))
  await page.keyboard.press(documentKey('Meta+z'))
  await waitDocument(kea, '⌘Z: the typing on line 7 undone', t1.join('\n'))
  await page.keyboard.press(documentKey('Meta+z'))
  await waitDocument(kea, '⌘Z: the first key undone', original.join('\n'))
  await until('back to the file: no dot', async () => !(await tabUnsavedMark(kea, FILE)).dot || undefined)
  expect((await viewer(kea))?.ui.unsaved).toBe(false)
  await page.keyboard.press(documentKey('Meta+Shift+z'))
  await waitDocument(kea, '⌘⇧Z: the first key again', t1.join('\n'))
  await page.keyboard.press(documentKey('Meta+Shift+z'))
  await waitDocument(kea, '⌘⇧Z: the typing on line 7 again', t2.join('\n'))
  await page.keyboard.press(documentKey('Meta+Shift+z'))
  await waitDocument(kea, '⌘⇧Z: the deletion again', t3.join('\n'))
  await until('the dot again', async () => (await tabUnsavedMark(kea, FILE)).dot || undefined)

  // 4. several cursors: a click at the end of line 1, a ⌥-click at the end of line 6; what is typed lands at both
  await clickLineEnd(kea, 1)
  await clickLineEnd(kea, 6, true)
  await page.keyboard.type(' // fn')
  const t4 = withLine(withLine(t3, 1, `${t3[0]} // fn`), 6, `${t3[5]} // fn`)
  await waitDocument(kea, 'typed at both cursors', t4.join('\n'))
  // Esc collapses the cursors to the main one (the one added last) and leaves the tab open
  await page.keyboard.press('Escape')
  await page.keyboard.type('!')
  const t5 = withLine(t4, 6, `${t4[5]}!`)
  await waitDocument(kea, 'one cursor after Esc', t5.join('\n'))
  expect(await viewerShown(kea)).toEqual({ path: FILE, mode: 'file', focused: true })
  // ⌘D: the word at the cursor, then its next occurrences; what is typed replaces each
  await goToLine(kea, '2:9')
  for (let i = 0; i < 3; i++) await page.keyboard.press(documentKey('Meta+d'))
  await page.keyboard.type('sum')
  const t6 = t5.map((l, i) => (i === 1 || i === 2 || i === 6 ? l.replace('total', 'sum') : l))
  await waitDocument(kea, 'every selected occurrence replaced', t6.join('\n'))

  // 5. ⌘S: the file on disk is the document's text; the dot goes
  await page.keyboard.press(sysKey('Meta+s'))
  await waitFileText(onDisk, 'the file saved', t6.join('\n'))
  await until('the dot gone', async () => !(await tabUnsavedMark(kea, FILE)).dot || undefined)
  expect(await tabUnsavedMark(kea, FILE)).toEqual({ dot: false, name: null })
  expect((await viewer(kea))?.ui.unsaved).toBe(false)
  expect(await viewerText(kea)).toBe(fs.readFileSync(onDisk, 'utf8'))

  // 6. the Edit menu's Undo and Redo, one step each: the last typing undone (unsaved again), then redone (the saved
  // text again: clean)
  await chooseEditMenuRole(kea, 'undo')
  await waitDocument(kea, 'Edit › Undo: the typing at the three occurrences undone', t5.join('\n'))
  await until('unsaved again: the dot', async () => (await tabUnsavedMark(kea, FILE)).dot || undefined)
  await chooseEditMenuRole(kea, 'redo')
  await waitDocument(kea, 'Edit › Redo: the typing at the three occurrences again', t6.join('\n'))
  await until('the saved text again: no dot', async () => !(await tabUnsavedMark(kea, FILE)).dot || undefined)
})

test('E-FV-14 · unsaved text and its undo steps stay with the file across another tab, another session (whose sidebar row says “unsaved”), File ↔ Diff (the diff says unsaved changes are not shown), the split and a rename in the tree; ⌘L asks first and Save and Send saves, then sends the lines of the saved file; ⌘S then another tab at once: saved, and clean when shown again', async ({ run, launch }) => {
  test.setTimeout(180_000)
  const kea = await launch()
  const page = await kea.page()
  const A = 'src/a.ts'
  const B = 'src/b.ts'
  const base = ['export function area(w: number, h: number) {', '  const size = w * h', '  return size', '}', '']
  const { id, worktree } = await editingSession(kea, run, { [A]: base.join('\n'), [B]: 'export const b = 1\n' })
  const other = await startSession(kea, 'other')
  await waitLive(kea, other)
  const agent = await agentTerminal(kea, id)
  // the file is changed on disk (the session's change), so its tab offers File · Diff
  const disk = [...base.slice(0, 3), '  // checked', ...base.slice(3)]
  writeFiles(worktree, { [A]: disk.join('\n') })

  await clickFile(kea, A)
  await waitBody(kea, A, 'text')
  await waitDocument(kea, 'the file as it is on disk', disk.join('\n'))
  await until('the document has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  await goToLine(kea, '2')
  await page.keyboard.press('End')
  await page.keyboard.type(' // mine')
  const mine = withLine(disk, 2, '  const size = w * h // mine')
  await waitDocument(kea, 'typed', mine.join('\n'))
  await until('the dot', async () => (await tabUnsavedMark(kea, A)).dot || undefined)

  /** The file `p` on screen again: the unsaved text, and its undo step there (undone back to the file: clean; redone). */
  const stillUnsaved = async (p: string, how: string) => {
    await waitBody(kea, p, 'text')
    await waitDocument(kea, `${how}: the unsaved text`, mine.join('\n'))
    expect(await tabUnsavedMark(kea, p), `${how}: the dot`).toMatchObject({ dot: true })
    if (!(await viewerShown(kea))?.focused) await page.locator('.viewer .cm-content .cm-line').first().click()
    await page.keyboard.press(documentKey('Meta+z'))
    await waitDocument(kea, `${how}: ⌘Z undoes the typing`, disk.join('\n'))
    await until(`${how}: undone back to the file, no dot`, async () => !(await tabUnsavedMark(kea, p)).dot || undefined)
    await page.keyboard.press(documentKey('Meta+Shift+z'))
    await waitDocument(kea, `${how}: ⌘⇧Z types it again`, mine.join('\n'))
    await until(`${how}: the dot again`, async () => (await tabUnsavedMark(kea, p)).dot || undefined)
  }

  // 1. another tab, and back
  await clickFile(kea, B)
  await waitBody(kea, B, 'text')
  await pinFileTab(kea, B)
  expect(await tabUnsavedMark(kea, A), 'the tab of the file left has the dot').toMatchObject({ dot: true })
  await clickFileTab(kea, A)
  await stillUnsaved(A, 'another tab')

  // 2. another session, and back: the row of the session left says "unsaved"
  await selectSession(kea, other)
  await expect(sessionRow(page, id).locator('[data-unsaved]')).toHaveText('unsaved')
  await expect(sessionRow(page, other).locator('[data-unsaved]')).toHaveCount(0)
  expect((await viewerRows(kea)).viewerUnsaved, 'the unsaved document is kept while its session is away').toBe(1)
  await selectSession(kea, id)
  await stillUnsaved(A, 'another session')

  // 3. File → Diff: the diff is the file on disk, and says the unsaved changes are not in it; Diff → File
  const toggle = (label: string) => page.locator('.viewer .viewer-switch[aria-label="File or diff"] button', { hasText: label })
  await toggle('Diff').waitFor({ timeout: GIT_MS })
  await toggle('Diff').click()
  const diff = await waitBody(kea, A, 'diff')
  expect(diff.ui.notices).toContain('Unsaved changes are not shown')
  await expect(page.locator('.viewer .viewer-notice')).toContainText('Unsaved changes are not shown')
  expect(await viewerText(kea), 'the diff’s new side is the file on disk').toBe(disk.join('\n'))
  await toggle('File').click()
  await stillUnsaved(A, 'File · Diff')

  // 4. the split turned over, and back
  const beside = (await kea.layout()).agentBeside
  await kea.setLayout({ agentBeside: !beside })
  await until('the layout turned over', async () => (await kea.layout()).agentBeside === !beside || undefined)
  await stillUnsaved(A, 'the split turned over')
  await kea.setLayout({ agentBeside: beside })
  await until('the layout back', async () => (await kea.layout()).agentBeside === beside || undefined)
  await stillUnsaved(A, 'the split back')

  // 5. renamed in the tree (F2): the tab and its unsaved document follow the file
  const RENAMED = 'src/renamed.ts'
  await treeRow(page, A).click()
  await tree(page).focus()
  await page.keyboard.press('F2')
  await page.keyboard.type('renamed')
  await page.keyboard.press('Enter')
  await until('the tab follows the rename', async () => {
    const tabs = await fileTabs(kea)
    return (tabs.some((t) => t.path === RENAMED) && !tabs.some((t) => t.path === A)) || undefined
  })
  expect(fs.readFileSync(path.join(worktree, RENAMED), 'utf8'), 'the file renamed on disk, its text as it was').toBe(disk.join('\n'))
  await stillUnsaved(RENAMED, 'renamed')
  expect(await tabUnsavedMark(kea, RENAMED)).toEqual({ dot: true, name: 'renamed.ts, unsaved' })

  // 6. ⌘L on lines 3–4 asks first; Cancel sends nothing; Save and Send saves, then sends
  const ask = page.getByRole('alertdialog', { name: 'renamed.ts has unsaved changes' })
  await goToLine(kea, '3')
  for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press(sysKey('Meta+l'))
  await expect(ask).toBeVisible()
  expect(await ask.getByRole('button').allInnerTexts()).toEqual(['Save and Send', 'Send Anyway', 'Cancel'])
  await expect(ask.getByRole('button', { name: 'Save and Send' }), 'Save and Send is the default').toBeFocused()
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  expect(fs.readFileSync(path.join(worktree, RENAMED), 'utf8'), 'Cancel saves nothing').toBe(disk.join('\n'))
  expect((await kea.terminalText(agent)).includes(`${RENAMED}:`), 'nor sends anything').toBe(false)
  await page.keyboard.press(sysKey('Meta+l'))
  await ask.getByRole('button', { name: 'Save and Send' }).click()
  await waitFileText(path.join(worktree, RENAMED), 'saved first', mine.join('\n'))
  const sent = await until('the reference at the agent’s prompt', async () => {
    const t = await kea.terminalText(agent)
    return t.includes(`${RENAMED}:3-4`) ? t : undefined
  })
  expect(sent.trimEnd().endsWith(`${RENAMED}:3-4`), `not submitted\n${sent}`).toBe(true)
  expect(fs.readFileSync(path.join(worktree, RENAMED), 'utf8').split('\n').slice(2, 4), 'the lines sent are the saved file’s').toEqual(mine.slice(2, 4))
  await until('saved: no dot', async () => !(await tabUnsavedMark(kea, RENAMED)).dot || undefined)

  // 7. ⌘S and at once another tab: the save lands, and the file is clean when shown again
  await page.locator('.viewer .cm-content .cm-line').first().click()
  await goToLine(kea, '3')
  await page.keyboard.press('End')
  await page.keyboard.type(' // last')
  const last = withLine(mine, 3, '  return size // last')
  await waitDocument(kea, 'typed again', last.join('\n'))
  await until('the dot', async () => (await tabUnsavedMark(kea, RENAMED)).dot || undefined)
  await page.keyboard.press(sysKey('Meta+s'))
  await clickFileTab(kea, B)
  await waitFileText(path.join(worktree, RENAMED), 'the save landed', last.join('\n'))
  await clickFileTab(kea, RENAMED)
  const back = await waitBody(kea, RENAMED, 'text')
  await waitDocument(kea, 'the saved text', last.join('\n'))
  expect([back.ui.unsaved, (await tabUnsavedMark(kea, RENAMED)).dot], 'clean').toEqual([false, false])
  expect((await viewerRows(kea)).viewerUnsaved).toBe(0)
})

test('E-FV-14 · a file renamed onto the path of a deleted file whose text is unsaved: the warning asks about that one first, and after Don’t Save the renamed file’s unsaved text is on screen at the path, typed into and undone there; renamed again onto a clean deleted file on screen, its unsaved text is on screen there too', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const A = 'src/a.ts'
  const B = 'src/b.ts'
  const C = 'src/c.ts'
  const { worktree } = await editingSession(kea, run, { [A]: 'export const a = 1\n', [B]: 'export const b = 1\n', [C]: 'export const c = 1\n' })

  /** Type `text` at the end of the first line of the document on screen. */
  const typeAtEnd = async (text: string) => {
    await page.locator('.viewer .cm-content .cm-line').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(text)
  }
  /** Rename `from` to `name` from its row's menu in Files, which leaves the file on screen where it is. */
  const renameFromMenu = async (from: string, name: string) => {
    await treeRow(page, from).click({ button: 'right' })
    await page.getByRole('menu', { name: 'File menu' }).locator('[data-command="files.rename"]').click()
    await panelRegion(page).getByRole('textbox').fill(name)
    await page.keyboard.press('Enter')
  }
  const onlyTab = (p: string) => until(`one tab, ${p}`, async () => ((await fileTabs(kea)).map((t) => t.path).join() === p ? true : undefined))

  // b.ts typed into, then deleted on disk: its text stays, unsaved; then a.ts typed into
  await clickFile(kea, B)
  await waitBody(kea, B, 'text')
  await typeAtEnd(' // b')
  await waitDocument(kea, 'typed in b.ts', 'export const b = 1 // b\n')
  fs.rmSync(path.join(worktree, B))
  await waitEdit(kea, 'b.ts deleted on disk', (s) => s.path === B && s.notice === 'Deleted on disk · Save to create it again')
  await clickFile(kea, A)
  await waitBody(kea, A, 'text')
  await typeAtEnd(' // a')
  const mine = 'export const a = 1 // a\n'
  await waitDocument(kea, 'typed in a.ts', mine)

  // 1. a.ts renamed to b.ts: b.ts's unsaved text is asked about first, on screen; Don't Save, and the rename is made
  await renameFromMenu(A, 'b.ts')
  const ask = page.getByRole('alertdialog', { name: 'Do you want to save the changes you made to b.ts?' })
  await expect(ask).toBeVisible()
  expect((await viewerShown(kea))?.path).toBe(B)
  await ask.getByRole('button', { name: 'Don’t Save' }).click()
  await onlyTab(B)
  expect(fs.readFileSync(path.join(worktree, B), 'utf8'), 'renamed on disk').toBe('export const a = 1\n')
  // a.ts's unsaved text is on screen at b.ts; typing goes into it, and its undo steps came with it
  await waitDocument(kea, 'a.ts’s unsaved text at b.ts', mine)
  await waitEdit(kea, 'unsaved and editable at b.ts', (s) => s.path === B && s.unsaved && s.editable)
  await typeAtEnd('!')
  await waitDocument(kea, 'typed on at b.ts', 'export const a = 1 // a!\n')
  expect((await viewerRows(kea)).viewerUnsaved, 'one unsaved document').toBe(1)
  await page.keyboard.press(documentKey('Meta+z'))
  await waitDocument(kea, '⌘Z: the last typing undone', mine)
  await page.keyboard.press(documentKey('Meta+z'))
  await waitDocument(kea, '⌘Z: a.ts’s typing undone', 'export const a = 1\n')
  await page.keyboard.press(documentKey('Meta+Shift+z'))
  await waitDocument(kea, '⌘⇧Z: a.ts’s typing again', mine)

  // 2. c.ts on screen, clean, deleted on disk; b.ts renamed onto it with no question: its unsaved text is on screen
  await clickFile(kea, C)
  await waitBody(kea, C, 'text')
  fs.rmSync(path.join(worktree, C))
  await waitEdit(kea, 'c.ts deleted on disk, read-only', (s) => s.path === C && s.readOnly === 'deleted on disk')
  await renameFromMenu(B, 'c.ts')
  await onlyTab(C)
  await waitDocument(kea, 'the moved unsaved text at c.ts', mine)
  await waitEdit(kea, 'unsaved and editable at c.ts', (s) => s.path === C && s.unsaved && s.editable)
  expect(await tabUnsavedMark(kea, C)).toMatchObject({ dot: true })
  await typeAtEnd('?')
  await waitDocument(kea, 'typed on at c.ts', 'export const a = 1 // a?\n')
  expect((await viewerRows(kea)).viewerUnsaved, 'one unsaved document').toBe(1)
})

test('E-FV-16 · files that open read-only — mixed line endings, invalid UTF-8, over the full-feature size, no permission, inside .git — take no typing, deleting, paste, cut or drop; the header says “Read-only” after the language, with the reason as its tooltip', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const { worktree } = await editingSession(kea, run, {})
  const big = plainText(1, L.viewerFullBytes + 1000)
  writeFiles(worktree, {
    'mixed.txt': 'one\r\ntwo\nthree\n',
    'bad.txt': Buffer.from([0x6f, 0x6b, 0x20, 0xc3, 0x28, 0x20, 0x62, 0x61, 0x64, 0x0a]),
    'big.txt': big,
    'locked.txt': 'locked\n',
    'vendor/dep/.git/config': '[core]\n\tbare = false\n',
  })
  fs.chmodSync(path.join(worktree, 'locked.txt'), 0o444)
  // the tree never lists a `.git` folder: a link in the worktree leads to the file inside one
  fs.symlinkSync('vendor/dep/.git/config', path.join(worktree, 'dep-git-config'))

  const cases: { file: string; reason: string | RegExp }[] = [
    { file: 'mixed.txt', reason: 'mixed line endings' },
    { file: 'bad.txt', reason: 'not valid UTF-8' },
    { file: 'big.txt', reason: /^over [\d.]+ MB$/ },
    { file: 'locked.txt', reason: 'no permission' },
    { file: 'dep-git-config', reason: 'inside .git' },
  ]
  for (const { file, reason } of cases) {
    await clickFile(kea, file)
    const shown = await waitBody(kea, file, 'text', 30_000)
    const before = await viewerText(kea)
    expect(shown.ui.editable, `${file}: not editable`).toBe(false)
    if (typeof reason === 'string') expect(shown.ui.readOnly, file).toBe(reason)
    else expect(shown.ui.readOnly, file).toMatch(reason)
    const label = page.locator('.viewer .viewer-header .viewer-readonly')
    await expect(label, `${file}: the header says so`).toHaveText('Read-only')
    expect(await label.getAttribute('data-tip'), `${file}: the reason is its tooltip`).toBe(shown.ui.readOnly)
    if (file === 'dep-git-config') expect(shown.ui.link, 'the link’s target, inside a .git folder').toBe('vendor/dep/.git/config')
    // after the language
    expect(await page.locator('.viewer .viewer-header .viewer-language + .viewer-readonly').count(), `${file}: after the language`).toBe(1)
    // everything that would change the text changes nothing, and ⌘S saves nothing
    await page.locator('.viewer .cm-content .cm-line').first().click()
    await page.keyboard.press('End')
    await tryToEditDocument(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press(sysKey('Meta+s'))
    expect(await viewerText(kea), `${file}: the text as it was`).toBe(before)
    expect((await viewer(kea))?.ui.unsaved, `${file}: nothing unsaved`).toBe(false)
    expect(await tabUnsavedMark(kea, file), `${file}: no dot`).toEqual({ dot: false, name: null })
  }
  expect(fs.readFileSync(path.join(worktree, 'locked.txt'), 'utf8')).toBe('locked\n')
  expect(fs.readFileSync(path.join(worktree, 'vendor/dep/.git/config'), 'utf8')).toBe('[core]\n\tbare = false\n')
  expect((await viewerRows(kea)).viewerUnsaved).toBe(0)
})

test('E-FV-18 · find and replace in an editable file: ⌥⌘F opens the find bar with its replace row; Replace replaces the current match and moves to the next (by its button and by ↵ in the replace field); Replace All with a regular expression fills in its groups; one ⌘Z puts every match back; a read-only file has no replace row', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const FILE = 'src/names.ts'
  const original = ['const alpha_one = 1', 'const beta_two = 2', 'const alpha_three = 3', 'const gamma_four = 4', '']
  const { worktree } = await editingSession(kea, run, { [FILE]: original.join('\n') })
  writeFiles(worktree, { 'mixed.txt': 'one\r\ntwo\n' })
  const bar = page.locator('.viewer .kea-find')
  const find = bar.locator('.kea-bar-input:not(.kea-replace-input)')
  const replace = bar.locator('.kea-replace-input')
  const count = bar.locator('.kea-bar-count')

  await clickFile(kea, FILE)
  await waitBody(kea, FILE, 'text')
  await until('the document has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  await page.keyboard.press(sysKey('Alt+Meta+f'))
  await expect(replace, 'the replace row').toBeVisible()
  await expect(find, 'nothing to find yet: the keyboard in the find field').toBeFocused()
  await page.keyboard.type('alpha')
  await expect(count).toHaveText('1 of 2')

  // Replace: the current match, then the next is the current one
  await replace.click()
  await page.keyboard.type('omega')
  await bar.locator('button[aria-label="Replace"]').click()
  const once = withLine(original, 1, 'const omega_one = 1')
  await waitDocument(kea, 'the first match replaced', once.join('\n'))
  await expect(count).toHaveText('1 of 1')
  await expect(replace).toBeFocused()
  await page.keyboard.press('Enter')
  const twice = withLine(once, 3, 'const omega_three = 3')
  await waitDocument(kea, '↵ in the replace field: the next match replaced', twice.join('\n'))
  await expect(count).toHaveText('No results')

  // Replace All with a regular expression whose groups the replacement uses
  await bar.locator('[aria-label="Use Regular Expression"]').click()
  await find.fill('const (\\w+)_(\\w+) =')
  await expect(count).toHaveText(/ of 4$/)
  await replace.fill('const $2_$1 =')
  await bar.locator('button[aria-label="Replace all"]').click()
  const all = ['const one_omega = 1', 'const two_beta = 2', 'const three_omega = 3', 'const four_gamma = 4', '']
  await waitDocument(kea, 'every match replaced, its groups filled in', all.join('\n'))

  // Esc closes the bar; one ⌘Z puts every match back, the next undoes the single Replace before it
  await page.keyboard.press('Escape')
  await bar.waitFor({ state: 'detached' })
  await page.keyboard.press(documentKey('Meta+z'))
  await waitDocument(kea, 'one ⌘Z: Replace All undone', twice.join('\n'))
  await page.keyboard.press(documentKey('Meta+z'))
  await waitDocument(kea, 'the next ⌘Z: the last Replace undone', once.join('\n'))

  // a read-only file: its find bar has no replace row, ⌥⌘F pressed in it included (the typing after it is counted
  // once the key has been taken)
  await clickFile(kea, 'mixed.txt')
  const ro = await waitBody(kea, 'mixed.txt', 'text')
  expect(ro.ui.readOnly).toBe('mixed line endings')
  await until('the document has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  await page.keyboard.press(sysKey('Meta+f'))
  await expect(find).toBeFocused()
  await page.keyboard.press(sysKey('Alt+Meta+f'))
  await page.keyboard.type('two')
  await expect(count).toHaveText('1 of 1')
  await expect(replace).toHaveCount(0)
})

test('E-FV-19 · language aids: ⌘/ toggles a comment, brackets and quotes close as they are typed (no quotes in Markdown), ↵ indents one unit more after an opener and keeps the indentation in prose, a closing bracket typed at a line’s start goes back to its opener’s indentation; TypeScript, Python, Markdown and a Makefile (a tab under a rule)', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  const files: Record<string, string> = {
    'src/aids.ts': ['export function add(a: number, b: number) {', '  return a + b', '}', ''].join('\n'),
    'tool.py': ['def add(a, b):', '    return a + b', ''].join('\n'),
    'notes.md': ['# Notes', '', '- one', '  more', ''].join('\n'),
    Makefile: ['CC = cc', '', 'all: main.o', ''].join('\n'),
  }
  await editingSession(kea, run, files)
  const open = async (file: string, language: string) => {
    await clickFile(kea, file)
    const v = await waitBody(kea, file, 'text')
    expect([v.ui.language, v.ui.editable]).toEqual([language, true])
    await until('the document has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  }
  const cursor = async () => (await viewer(kea))?.text?.selection.from
  const comment = documentKey('Meta+Slash')

  // TypeScript
  let ts = files['src/aids.ts']!.split('\n')
  await open('src/aids.ts', 'TypeScript')
  await goToLine(kea, '2')
  await page.keyboard.press(comment)
  await waitDocument(kea, 'TypeScript: ⌘/ comments the line', withLine(ts, 2, '  // return a + b').join('\n'))
  await page.keyboard.press(comment)
  await waitDocument(kea, 'TypeScript: ⌘/ again uncomments it', ts.join('\n'))
  // ↵ after the opening bracket ending line 1: one unit (the file's two spaces) more; `}` typed there goes back to the opener's
  await goToLine(kea, '1')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  ts = [ts[0]!, '  ', ...ts.slice(1)]
  await waitDocument(kea, 'TypeScript: ↵ after `{` indents', ts.join('\n'))
  expect(await cursor()).toEqual({ line: 2, col: 3 })
  await page.keyboard.type('}')
  ts = withLine(ts, 2, '}')
  await waitDocument(kea, 'TypeScript: `}` at the line’s start outdents to its opener’s', ts.join('\n'))
  // at the end of the file: brackets and quotes close as they are typed, a closer typed over is not doubled, ↵ between
  // the braces puts the closer on its own line at the opener's indentation
  await page.keyboard.press(textKey('Meta+ArrowDown'))
  await page.keyboard.type('if (ok) {')
  await page.keyboard.press('Enter')
  await page.keyboard.type('say("hi')
  ts = [...ts.slice(0, -1), 'if (ok) {', '  say("hi")', '}']
  await waitDocument(kea, 'TypeScript: pairs closed, the block opened', ts.join('\n'))
  expect(await cursor(), 'inside the quotes').toEqual({ line: ts.length - 1, col: 10 })
  await page.keyboard.press('End')
  await page.keyboard.type(`('x`)
  ts = withLine(ts, ts.length - 1, `  say("hi")('x')`)
  await waitDocument(kea, 'TypeScript: a single quote closes too', ts.join('\n'))

  // Python: `#`, and a line ending in `:` opens a block of the file's four spaces
  let py = files['tool.py']!.split('\n')
  await open('tool.py', 'Python')
  await goToLine(kea, '2')
  await page.keyboard.press(comment)
  await waitDocument(kea, 'Python: ⌘/ comments the line', withLine(py, 2, '    # return a + b').join('\n'))
  await page.keyboard.press(comment)
  await waitDocument(kea, 'Python: ⌘/ again uncomments it', py.join('\n'))
  await goToLine(kea, '1')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('x = ["')
  py = [py[0]!, '    x = [""]', ...py.slice(1)]
  await waitDocument(kea, 'Python: ↵ after `:` indents; brackets and quotes close', py.join('\n'))

  // Markdown: an HTML comment; brackets close, quotes do not; ↵ keeps the line's indentation
  let md = files['notes.md']!.split('\n')
  await open('notes.md', 'Markdown')
  await goToLine(kea, '3')
  await page.keyboard.press(comment)
  await waitDocument(kea, 'Markdown: ⌘/ comments the line', withLine(md, 3, '<!-- - one -->').join('\n'))
  await page.keyboard.press(comment)
  await waitDocument(kea, 'Markdown: ⌘/ again uncomments it', md.join('\n'))
  await goToLine(kea, '4')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('"q" (x')
  md = [...md.slice(0, 4), '  "q" (x)', ...md.slice(4)]
  await waitDocument(kea, 'Markdown: ↵ keeps the indentation; `(` closes, `"` does not', md.join('\n'))

  // a Makefile: `#`, and the line under a rule starts with a tab
  let mk = files.Makefile!.split('\n')
  await open('Makefile', 'Makefile')
  await goToLine(kea, '1')
  await page.keyboard.press(comment)
  await waitDocument(kea, 'Makefile: ⌘/ comments the line', withLine(mk, 1, '# CC = cc').join('\n'))
  await page.keyboard.press(comment)
  await waitDocument(kea, 'Makefile: ⌘/ again uncomments it', mk.join('\n'))
  await goToLine(kea, '3')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('cc -o all main.o')
  mk = [...mk.slice(0, 3), '\tcc -o all main.o', ...mk.slice(3)]
  await waitDocument(kea, 'Makefile: the recipe under a rule starts with a tab', mk.join('\n'))
})

test('E-FV-20 · Move to Trash and Discard Changes… on a file with unsaved changes: each sheet says the unsaved changes will be lost; after Discard the document is the restored file with nothing unsaved; after Trash its tab and its document are gone', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const trash = new TrashWorld(run)
  const kea = await launch()
  const page = await kea.page()
  const KEEP = 'src/keep.ts'
  const GONE = 'src/gone.ts'
  const { worktree } = await editingSession(kea, run, { [KEEP]: 'export const keep = 1\n', [GONE]: 'export const gone = 1\n' })
  // the session changed keep.ts, so Discard Changes… is offered for it
  writeFiles(worktree, { [KEEP]: 'export const keep = 2\n' })
  await treeRowInView(kea, KEEP)
  await waitTree(kea, 'keep.ts changed', (rows) => rows.find((r) => r.path === KEEP)?.git === 'M', GIT_MS)
  const menuPick = async (p: string, command: string) => {
    await treeRow(page, p).click({ button: 'right' })
    await page.getByRole('menu', { name: 'File menu' }).locator(`[data-command="${command}"]`).click()
  }
  const typeInto = async (p: string) => {
    await clickFile(kea, p)
    await waitBody(kea, p, 'text')
    await until('the document has the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
    await page.keyboard.press('End')
    await page.keyboard.type(' // mine')
    await until(`${p} unsaved`, async () => (await tabUnsavedMark(kea, p)).dot || undefined)
  }

  // Discard Changes… on the changed file with unsaved text: the sheet says so; after it, the restored file, clean
  await typeInto(KEEP)
  await waitDocument(kea, 'typed', 'export const keep = 2 // mine\n')
  await menuPick(KEEP, 'files.discard')
  const discard = page.getByRole('alertdialog', { name: 'Discard changes' })
  await expect(discard).toContainText('Your unsaved changes to keep.ts will be lost.')
  await discard.getByRole('button', { name: 'Discard Changes' }).click()
  await expect(discard).toHaveCount(0)
  await waitFileText(path.join(worktree, KEEP), 'the file put back', 'export const keep = 1\n')
  await waitDocument(kea, 'the document is the restored file', 'export const keep = 1\n')
  await waitViewer(kea, 'nothing unsaved', (v) => v.ui.path === KEEP && !v.ui.unsaved && v.ui.editable)
  expect(await tabUnsavedMark(kea, KEEP)).toEqual({ dot: false, name: null })

  // Move to Trash on a file with unsaved text: the sheet says so; after it, its tab and document are gone
  await typeInto(GONE)
  await menuPick(GONE, 'files.trash')
  const trashSheet = page.getByRole('alertdialog', { name: 'Move to Trash' })
  await expect(trashSheet).toContainText('Your unsaved changes to gone.ts will be lost.')
  await trashSheet.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(trashSheet).toHaveCount(0)
  await until('its tab closed', async () => !(await fileTabs(kea)).some((t) => t.path === GONE) || undefined)
  expect(trash.moved()).toEqual(['gone.ts'])
  await until('no unsaved document kept', async () => (await viewerRows(kea)).viewerUnsaved === 0 || undefined)
})
