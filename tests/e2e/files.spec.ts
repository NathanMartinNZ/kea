// The file panel: Kea launched through tests/e2e/fixtures.ts, a session started in a demo repository, and the tree, the
// Changes list, the header's diff stat and the finder used with real clicks and keys. What they open is read from the
// main area's tabs and the viewer's mount (tests/support/app-tabs.ts): the viewer itself is viewer.spec.ts's.
//
// Nothing here reaches the person's editor, file manager, Trash or clipboard: Open in Editor runs the fake editor under
// the run's own HOME (tests/support/app-server.ts `EditorWorld`), a reveal is logged by main and not opened, the
// `trash` tool is the run's own stand-in (tests/support/app-files.ts `TrashWorld`), and clipboard writes are recorded
// in the page.

import fs from 'node:fs'
import path from 'node:path'
import { until, type Kea } from '../support/app.ts'
import { agentEvents, claudeByDefault, fakeAgentTerminal, startFakeSession } from '../support/app-fake-agent.ts'
import { changeRow, changeRows, changesList, clickChange, clickFile, diffStatText, finder, finderRows, fsmonitorHint, fsmonitorProblem, fsmonitorRuns, GIT_MS, gitConfig, panelModes, panelRegion, showMode, SlowGit, stopFsmonitorDaemon, TrashWorld, tree, treeRow, treeRows, treeText, waitChanges, waitTree } from '../support/app-files.ts'
import { clipboard, EditorWorld, recordClipboard } from '../support/app-server.ts'
import { addProject, agentTerminal, demoRepo, menuCommands, projectRow, selectSession, startSession, waitLive } from '../support/app-sessions.ts'
import { fileTabs, pinFileTab, viewerShown } from '../support/app-tabs.ts'
import { commitAll, gitIn, sessionWorktree, writeFiles } from '../support/app-viewer.ts'
import { expect, test } from './fixtures.ts'
import { skipNote } from '../support/skip.ts'
import { sysKey, sysLabel } from '../support/keys.ts'

/** A demo project with `files` committed, and a session started in it: its id and its worktree. */
async function sessionWith(kea: Kea, run: Parameters<typeof demoRepo>[0], files: Record<string, string | Uint8Array> = {}, name = 'demo'): Promise<{ id: string; worktree: string; repo: string }> {
  await kea.pretendFocused(true)
  const repo = demoRepo(run, name)
  if (Object.keys(files).length > 0) {
    writeFiles(repo.root, files)
    commitAll(repo.root, 'Add files')
  }
  await addProject(kea, repo.root, name)
  const id = await startSession(kea, 'files')
  await waitLive(kea, id)
  return { id, worktree: sessionWorktree(repo.root), repo: repo.root }
}

const focusIn = (kea: Kea, selector: string): Promise<boolean> => kea.page().then((page) => page.evaluate((s) => !!document.activeElement?.closest(s), selector))
const selectedRow = async (kea: Kea): Promise<string | null> => (await treeRows(kea)).find((r) => r.selected)?.path ?? null

/** A colour token as the browser computes it: `rgb(…)`. */
const tokenColour = (kea: Kea, token: string): Promise<string> =>
  kea.page().then((page) =>
    page.evaluate((t) => {
      const probe = document.body.appendChild(document.createElement('span'))
      probe.style.color = `var(${t})`
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    }, token),
  )

const NESTED = { 'packages/app/src/main.ts': 'export const main = 1\n', 'packages/app/src/util.ts': 'export const util = 2\n' }
/** Folders no test opens in the tree before something reveals a file in them. */
const DEEP = { 'lib/top.ts': 'export const top = 0\n', 'lib/deep/other.ts': 'export const other = 1\n', 'lib/deep/inner/leaf.ts': 'export const leaf = 2\n' }

test('E-FT-2 · the file tree with real clicks and keys: folders open and close (a single-child chain as one row), a click shows a file in the preview tab, the arrows, typing a name, Space and Enter walk it, ⌘↵ and a double-click open the editor; a file written, changed or deleted on disk shows with its letter, its folder’s dot and the header’s count; ignored files stay hidden until asked for; the row’s menu runs the `file ⌃` commands; the viewer’s breadcrumb reveals a folder that was closed, and a file in folders the tree never loaded, from Changes too; and the tree comes back as it was after another session was shown', async ({ run, launch }) => {
  const editors = new EditorWorld(run)
  editors.editor('vscode')
  const kea = await launch()
  const { id, worktree } = await sessionWith(kea, run, { ...NESTED, ...DEEP })
  const page = await kea.page()
  await recordClipboard(page)

  // the root, folders first; nothing below it until a folder is opened
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
  expect(await treeText(kea)).toEqual(['lib', 'packages', 'src', 'test', '.gitignore', '.kea-fixture-repo', 'package.json', 'README.md'])
  expect((await panelModes(kea)).map((m) => m.label)).toEqual(['Files', 'Changes'])

  // a click opens a folder; a chain of single-child folders is one row
  await treeRow(page, 'src').click()
  await waitTree(kea, 'src is open', (rows) => rows.some((r) => r.path === 'src/index.js'))
  await treeRow(page, 'packages').click()
  await waitTree(kea, 'the chain is one row', (rows) => rows.some((r) => r.path === 'packages/app/src/main.ts'))
  expect((await treeText(kea)).slice(0, 5)).toEqual(['lib', 'packages/app/src', '  main.ts', '  util.ts', 'src'])
  // … and closes as one
  await treeRow(page, 'packages/app/src').click()
  await waitTree(kea, 'the chain is closed', (rows) => !rows.some((r) => r.path.startsWith('packages/')) && rows.some((r) => r.path === 'packages' && r.expanded === false))

  // a click on a file: the viewer's preview tab, with the keyboard
  await treeRow(page, 'src/index.js').click()
  await until('the file in the viewer', async () => (await viewerShown(kea))?.path === 'src/index.js' || undefined)
  expect(await viewerShown(kea)).toEqual({ path: 'src/index.js', mode: 'file', focused: true })
  expect(await fileTabs(kea)).toEqual([{ path: 'src/index.js', kind: 'file', pinned: false, selected: true }])
  expect(await selectedRow(kea)).toBe('src/index.js')

  // the keyboard: ⌘⇧E puts it in the tree, on the selected row
  await page.keyboard.press(sysKey('Meta+Shift+e'))
  await until('the keyboard in the tree', () => focusIn(kea, '[role=tree]'))
  await page.keyboard.press('ArrowDown')
  expect(await selectedRow(kea)).toBe('src/math.js')
  await page.keyboard.press('ArrowLeft') // a file: to its folder
  expect(await selectedRow(kea)).toBe('src')
  await page.keyboard.press('ArrowLeft') // an open folder: closed
  await waitTree(kea, 'src is closed', (rows) => !rows.some((r) => r.path === 'src/index.js'))
  await page.keyboard.press('ArrowRight')
  await waitTree(kea, 'src is open again', (rows) => rows.some((r) => r.path === 'src/index.js'))
  await page.keyboard.press('ArrowRight') // open: into it
  // (waited for: the rows of a folder just listed again are drawn a frame after the tree knows them, and a read in
  // between finds no row selected; seen once on a loaded machine)
  await until('the keyboard on the folder’s first row', async () => (await selectedRow(kea)) === 'src/counter.js' || undefined)
  // typing a name
  await page.keyboard.type('rea')
  expect(await selectedRow(kea)).toBe('README.md')
  // Space: shown, and the keyboard stays in the tree
  await page.keyboard.press('Space')
  await until('README.md in the preview tab', async () => (await viewerShown(kea))?.path === 'README.md' || undefined)
  expect(await focusIn(kea, '[role=tree]')).toBe(true)
  expect(await fileTabs(kea), 'the preview tab is reused').toEqual([{ path: 'README.md', kind: 'file', pinned: false, selected: true }])
  // ⌘↵: the editor (the run's stand-in), at that file
  await page.keyboard.press(sysKey('Meta+Enter'))
  expect((await editors.waitLaunches(1)).at(-1)).toMatchObject({ tool: 'code' })
  expect(editors.launches().at(-1)?.argv.join(' ')).toContain(path.join(fs.realpathSync(worktree), 'README.md'))
  // a double-click too
  await treeRow(page, 'package.json').dblclick()
  expect((await editors.waitLaunches(2)).at(-1)?.argv.join(' ')).toContain('package.json')
  // Enter: shown, and the keyboard goes with it (the double-click left it in the tree, on that row)
  await until('the keyboard in the tree', () => focusIn(kea, '[role=tree]'))
  expect(await selectedRow(kea)).toBe('package.json')
  await page.keyboard.press('Enter')
  await until('package.json in the viewer, with the keyboard', async () => {
    const v = await viewerShown(kea)
    return (v?.path === 'package.json' && v.focused) || undefined
  })

  // live: what happens on disk shows by itself
  writeFiles(worktree, { 'src/index.js': 'changed\n', 'src/brand-new.js': 'new\n', 'node_modules/pkg/index.js': 'ignored\n' })
  fs.rmSync(path.join(worktree, 'src/hello.js'))
  const live = await waitTree(kea, 'the changes are decorated', (rows) => rows.find((r) => r.path === 'src/index.js')?.git === 'M' && rows.find((r) => r.path === 'src/brand-new.js')?.git === 'U' && !rows.some((r) => r.path === 'src/hello.js'), GIT_MS)
  expect(live.find((r) => r.path === 'src')?.git, 'the folder’s dot').toBe('dot')
  expect(live.some((r) => r.path === 'node_modules'), 'ignored: hidden').toBe(false)
  await until('the header counts the three changes', async () => (await panelModes(kea)).some((m) => m.label === 'Changes 3') || undefined, GIT_MS)
  // the name and the letter in the state's colour
  await expect(treeRow(page, 'src/index.js').locator('.ft-name')).toHaveCSS('color', await tokenColour(kea, '--warn'))
  await expect(treeRow(page, 'src/brand-new.js').locator('.fp-letter')).toHaveCSS('color', await tokenColour(kea, '--ok'))
  // ignored files, when asked for: listed, dimmed (`node_modules` is left out of the stream by the kernel: a new one is
  // found at the next refresh)
  // (showing ignored files has no control in the panel: its command is run as the palette would run it. Refresh has
  // one, the Changes header's menu, and is clicked there)
  const runCommand = (cmd: string): Promise<boolean> => page.evaluate((c) => (window as unknown as { __keaProbe: { run(id: string): boolean } }).__keaProbe.run(c), cmd)
  expect(await runCommand('files.toggleIgnored')).toBe(true)
  await showMode(kea, 'Changes')
  await panelRegion(page).getByRole('button', { name: 'Changes actions' }).click()
  await page.getByRole('menu', { name: 'Changes actions' }).locator('[data-command="files.refresh"]').click()
  await showMode(kea, 'Files')
  await waitTree(kea, 'node_modules is listed', (rows) => rows.find((r) => r.path === 'node_modules')?.ignored === true)
  expect(await runCommand('files.toggleIgnored')).toBe(true)
  await waitTree(kea, 'node_modules is hidden again', (rows) => !rows.some((r) => r.path === 'node_modules'))

  // the row's menu: the `file ⌃` commands, Discard only for a changed file, none that opens a file for a folder
  await treeRow(page, 'src/index.js').click({ button: 'right' })
  expect(await menuCommands(page, 'File menu')).toEqual(['files.openInEditor', 'files.reveal', 'files.copyPath', 'files.copyRelativePath', 'files.discard'])
  await page.getByRole('menu', { name: 'File menu' }).locator('[data-command="files.copyRelativePath"]').click()
  await until('the relative path copied', async () => (await clipboard(page)).at(-1) === 'src/index.js' || undefined)
  await treeRow(page, 'package.json').click({ button: 'right' })
  expect(await menuCommands(page, 'File menu')).toEqual(['files.openInEditor', 'files.reveal', 'files.copyPath', 'files.copyRelativePath'])
  await page.getByRole('menu', { name: 'File menu' }).locator('[data-command="files.copyPath"]').click()
  await until('the path copied', async () => (await clipboard(page)).at(-1) === path.join(worktree, 'package.json') || undefined)
  await treeRow(page, 'src').click({ button: 'right' })
  expect(await menuCommands(page, 'File menu')).toEqual(['files.reveal', 'files.copyPath', 'files.copyRelativePath'])
  await page.getByRole('menu', { name: 'File menu' }).locator('[data-command="files.reveal"]').click()
  const reveal = await until('the reveal asked of main', () => kea.logLines('main').find((l) => l.msg === 'reveal not opened (perf)'))
  expect(reveal.path, 'Finder is not opened under the harness: main logs the request').toBe(path.join(fs.realpathSync(worktree), 'src'))

  // the viewer's breadcrumb reveals a folder in the tree (the other direction: from the viewer to the tree)
  await treeRow(page, 'packages').click()
  await waitTree(kea, 'packages is open', (rows) => rows.some((r) => r.path === 'packages/app/src/util.ts'))
  await treeRow(page, 'packages/app/src/util.ts').click()
  await until('util.ts in the viewer', async () => (await viewerShown(kea))?.path === 'packages/app/src/util.ts' || undefined)
  await treeRow(page, 'packages/app/src').click() // closed again
  await waitTree(kea, 'packages is closed', (rows) => !rows.some((r) => r.path === 'packages/app/src/util.ts'))
  await page.locator('.viewer .viewer-crumbs .crumb', { hasText: 'app' }).click()
  // the folders above it are opened, and the keyboard is on its row (the chain down to it is one row)
  await waitTree(kea, 'the folder is revealed', (rows) => rows.find((r) => r.selected)?.path === 'packages/app')
  await until('the keyboard in the tree', () => focusIn(kea, '[role=tree]'))

  // … and a file in folders the tree has never loaded: opened with ⌘P (no row of it exists), revealed by a click on
  // the breadcrumb's last segment while the panel shows Changes
  expect((await treeRows(kea)).find((r) => r.path === 'lib'), 'lib was never opened').toMatchObject({ expanded: false })
  await page.keyboard.press(sysKey('Meta+p'))
  await page.keyboard.type('leaf')
  await until('the leaf leads the finder', async () => (await finderRows(kea))[0]?.path === 'lib/deep/inner/leaf.ts' || undefined)
  await page.keyboard.press('Enter')
  await until('leaf.ts in the viewer', async () => (await viewerShown(kea))?.path === 'lib/deep/inner/leaf.ts' || undefined)
  expect((await treeRows(kea)).some((r) => r.path.startsWith('lib/')), 'opening it loaded nothing into the tree').toBe(false)
  await showMode(kea, 'Changes')
  await expect(page.locator('.viewer .viewer-crumbs .crumb')).toHaveText(['lib', 'deep', 'inner', 'leaf.ts'])
  await page.locator('.viewer .viewer-crumbs .crumb.last').click()
  // Files is shown again, every folder above the file is loaded and open, and the keyboard is on the file's row, in view
  await until('the panel shows Files', async () => (await panelModes(kea)).some((m) => m.on && m.label === 'Files') || undefined)
  const revealed = await waitTree(kea, 'the file is revealed', (rows) => rows.find((r) => r.selected)?.path === 'lib/deep/inner/leaf.ts')
  expect(revealed.filter((r) => r.path === 'lib' || r.path.startsWith('lib/')).map((r) => `${'  '.repeat(r.level - 1)}${r.label}`)).toEqual(['lib', '  deep', '    inner', '      leaf.ts', '    other.ts', '  top.ts'])
  await until('the keyboard in the tree', () => focusIn(kea, '[role=tree]'))
  const rowBox = await treeRow(page, 'lib/deep/inner/leaf.ts').boundingBox()
  const treeBox = await tree(page).boundingBox()
  expect(rowBox && treeBox && rowBox.y >= treeBox.y && rowBox.y + rowBox.height <= treeBox.y + treeBox.height, 'the row is inside the tree’s viewport').toBe(true)
  expect(await viewerShown(kea), 'the file tab is still the one on screen').toMatchObject({ path: 'lib/deep/inner/leaf.ts', mode: 'file' })

  // another session, and back: the tree is as it was (open folders, the row the keyboard was on)
  const before = await treeText(kea)
  expect(before).toContain('  brand-new.js [U]')
  const second = await startSession(kea, 'another')
  await waitLive(kea, second)
  await waitTree(kea, 'the other session’s tree', (rows) => rows.some((r) => r.path === 'README.md') && !rows.some((r) => r.path === 'src/brand-new.js'))
  expect((await panelModes(kea)).map((m) => m.label), 'the other session has no changes').toEqual(['Files', 'Changes'])
  await selectSession(kea, id)
  await waitTree(kea, 'the first session’s tree is back', (rows) => rows.some((r) => r.path === 'src/brand-new.js' && r.git === 'U'))
  expect(await treeText(kea)).toEqual(before)
  expect(await selectedRow(kea)).toBe('lib/deep/inner/leaf.ts')
})

test('E-FT-3 · Changes with real clicks: the header’s diff stat shows it; the list has each change’s letter, name, folder and counts, a rename as `old → new` and a deleted file struck through; a click shows the diff; the scope switch, the totals and the branch line follow the scope; the `changes ⋯` menu runs its commands; Discard Changes… asks first, puts a changed file back and moves an untracked one to the (run’s own) Trash; with nothing left it says “No changes yet.”', async ({ run, launch }) => {
  const trash = new TrashWorld(run)
  const kea = await launch()
  const { worktree } = await sessionWith(kea, run)
  const page = await kea.page()
  await recordClipboard(page)
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
  expect(await diffStatText(kea), 'no changes: no diff stat').toBeNull()

  // committed on the branch: an edit and a rename; not committed: an edit, a new file, a deletion
  writeFiles(worktree, { 'src/math.js': 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b\n' })
  gitIn(worktree, 'mv', 'src/counter.js', 'src/tally.js')
  commitAll(worktree, 'work')
  writeFiles(worktree, { 'README.md': '# demo\n\nchanged\n', 'notes/todo.md': 'one\ntwo\n' })
  fs.rmSync(path.join(worktree, 'src/hello.js'))

  // the header's diff stat: a click shows Changes
  await until('the diff stat', async () => ((await diffStatText(kea)) ?? '').startsWith('+') || undefined, GIT_MS)
  await page.locator('.main-header .diff-stat').click()
  await until('the panel shows Changes', async () => (await panelModes(kea)).some((m) => m.on && m.label === 'Changes 5') || undefined, GIT_MS)
  const rows = await waitChanges(kea, 'the five changes', (r) => r.length === 5)
  expect(rows.map((r) => `${r.letter} ${r.name} | ${r.dir}`)).toEqual(['M README.md | ', 'U todo.md | notes', 'D hello.js | src', 'M math.js | src', 'R counter.js → tally.js | src']) // by path, compared by code unit
  expect(rows.find((r) => r.path === 'src/hello.js')).toMatchObject({ struck: true })
  expect(rows.find((r) => r.path === 'notes/todo.md')?.stat, 'an untracked file has only lines added').toBe('+2')
  expect(rows.find((r) => r.path === 'README.md')?.stat).toMatch(/^\+\d+ −\d+$/)
  await expect(panelRegion(page).getByLabel('Totals')).toHaveText(/5 files\s*\+\d+ −\d+/)
  await expect(panelRegion(page).getByLabel('Branch')).toHaveText(/kea\/files\s*← main\s*↑1/)

  // a click: the diff, in the preview tab
  await changeRow(page, 'src/math.js').click()
  await until('the diff in the viewer', async () => (await viewerShown(kea))?.mode === 'diff' || undefined)
  expect(await fileTabs(kea)).toEqual([{ path: 'src/math.js', kind: 'diff', pinned: false, selected: true }])
  // the keyboard: ⌘⇧G puts it in the list; ↓ and Enter show the next change's diff
  await page.keyboard.press(sysKey('Meta+Shift+g'))
  await until('the keyboard in the list', () => focusIn(kea, '[role=listbox][aria-label="Changes"]'))
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Space')
  await until('the rename’s diff, the keyboard still in the list', async () => (await viewerShown(kea))?.path === 'src/tally.js' || undefined)
  expect(await focusIn(kea, '[role=listbox][aria-label="Changes"]')).toBe(true)

  // Uncommitted: what `git status` shows
  await panelRegion(page).getByRole('button', { name: 'Uncommitted' }).click()
  const uncommitted = await waitChanges(kea, 'the uncommitted changes', (r) => r.length === 3 && !r.some((x) => x.path === 'src/math.js'))
  expect(uncommitted.map((r) => `${r.letter} ${r.path}`)).toEqual(['M README.md', 'U notes/todo.md', 'D src/hello.js'])
  await expect(panelRegion(page).getByLabel('Totals')).toHaveText(/3 files/)
  // the header's menu
  await panelRegion(page).getByRole('button', { name: 'Changes actions' }).click()
  expect(await menuCommands(page, 'Changes actions')).toEqual(['files.toggleScope', 'files.copyChangedList', 'files.openAllChanged', 'files.refresh'])
  await page.getByRole('menu', { name: 'Changes actions' }).locator('[data-command="files.copyChangedList"]').click()
  await until('the list copied', async () => (await clipboard(page)).at(-1) === 'README.md\nnotes/todo.md\nsrc/hello.js' || undefined)
  await panelRegion(page).getByRole('button', { name: 'Changes actions' }).click()
  await page.getByRole('menu', { name: 'Changes actions' }).locator('[data-command="files.toggleScope"]').click()
  await waitChanges(kea, 'Branch again', (r) => r.length === 5)

  // Discard Changes…: asked first, the safe button has the keyboard, and Cancel changes nothing
  const sheet = page.getByRole('alertdialog', { name: 'Discard changes' })
  await changeRow(page, 'README.md').click({ button: 'right' })
  expect(await menuCommands(page, 'File menu')).toContain('files.discard')
  await page.getByRole('menu', { name: 'File menu' }).locator('[data-command="files.discard"]').click()
  await expect(sheet).toContainText('README.md')
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(sheet).toHaveCount(0)
  expect(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8')).toBe('# demo\n\nchanged\n')
  // confirmed: the file is as the base has it, and the row goes
  await changeRow(page, 'README.md').click({ button: 'right' })
  await page.getByRole('menu', { name: 'File menu' }).locator('[data-command="files.discard"]').click()
  await sheet.getByRole('button', { name: 'Discard Changes' }).click()
  await waitChanges(kea, 'README.md is no longer changed', (r) => !r.some((x) => x.path === 'README.md'))
  expect(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8')).toBe(gitIn(worktree, 'show', 'main:README.md'))
  // an untracked file: to the Trash (the run's own), said so
  await changeRow(page, 'notes/todo.md').click({ button: 'right' })
  await page.getByRole('menu', { name: 'File menu' }).locator('[data-command="files.discard"]').click()
  await expect(sheet).toContainText('Trash')
  await sheet.getByRole('button', { name: 'Move to Trash' }).click()
  await waitChanges(kea, 'the untracked file is gone', (r) => !r.some((x) => x.path === 'notes/todo.md'))
  expect(trash.moved()).toEqual(['todo.md'])
  expect(fs.existsSync(path.join(worktree, 'notes/todo.md'))).toBe(false)
  // a deleted file comes back, an edit committed on the branch goes back to the base, a rename is undone
  for (const [p, button] of [['src/hello.js', 'Restore'], ['src/math.js', 'Discard Changes'], ['src/tally.js', 'Discard Changes']] as const) {
    await changeRow(page, p).click({ button: 'right' })
    await page.getByRole('menu', { name: 'File menu' }).locator('[data-command="files.discard"]').click()
    await sheet.getByRole('button', { name: button }).click()
    await waitChanges(kea, `${p} is no longer changed`, (r) => !r.some((x) => x.path === p))
  }
  // (the rename's two halves: the new file to the Trash, then the old one back)
  await waitChanges(kea, 'nothing is changed any more', (r) => r.length === 0)
  expect(fs.existsSync(path.join(worktree, 'src/hello.js'))).toBe(true)
  expect(fs.existsSync(path.join(worktree, 'src/counter.js')), 'the rename is undone: the old file is back').toBe(true)
  expect(trash.moved()).toEqual(['tally.js', 'todo.md'])
  expect(gitIn(worktree, 'diff', '--name-only', 'main')).toBe('')
  await expect(panelRegion(page).getByText('No changes yet.')).toBeVisible()
  expect(await changeRows(kea)).toEqual([])
  await until('no diff stat any more', async () => (await diffStatText(kea)) === null || undefined)
  await expect(changesList(page)).toBeVisible()
})

test('E-FT-4 · ⌘P finds a file: the finder opens as a floating layer with the keyboard in it, each key narrows the list and marks what matched, Enter shows the file in the preview tab, ⌘↵ opens it in the editor, ⌥↵ types its path at the agent’s prompt and gives the agent the keyboard (in one column it shows the Agent tab), and Esc puts the keyboard back where it was', async ({ run, launch }) => {
  const editors = new EditorWorld(run)
  editors.editor('vscode')
  const kea = await launch()
  const { id } = await sessionWith(kea, run, { ...NESTED, 'docs/my notes (draft).md': 'notes\n' })
  const page = await kea.page()
  const agent = await agentTerminal(kea, id)
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))

  // from the tree: Esc gives the keyboard back to it
  await page.keyboard.press(sysKey('Meta+Shift+e'))
  await until('the keyboard in the tree', () => focusIn(kea, '[role=tree]'))
  await page.keyboard.press(sysKey('Meta+p'))
  await expect(finder(page).getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(finder(page)).toHaveCount(0)
  expect(await focusIn(kea, '[role=tree]')).toBe(true)

  // typing narrows the list; the best match leads and shows what matched
  await page.keyboard.press(sysKey('Meta+p'))
  await page.keyboard.type('util')
  const hits = await until('the match', async () => {
    const rows = await finderRows(kea)
    return rows[0]?.path === 'packages/app/src/util.ts' ? rows : undefined
  })
  expect(hits[0]).toMatchObject({ current: true, marked: 'util' })
  // Enter: the preview tab, with the keyboard
  await page.keyboard.press('Enter')
  await expect(finder(page)).toHaveCount(0)
  await until('the file in the viewer', async () => (await viewerShown(kea))?.path === 'packages/app/src/util.ts' || undefined)
  expect(await fileTabs(kea)).toEqual([{ path: 'packages/app/src/util.ts', kind: 'file', pinned: false, selected: true }])

  // the search icon in the panel's header opens it too; ↓ moves; ⌘↵ opens the editor
  await panelRegion(page).getByRole('button', { name: `Go to File (${sysLabel('⌘P')})` }).click()
  await expect(finder(page).getByRole('combobox')).toBeFocused()
  await page.keyboard.type('main')
  await until('main.ts leads', async () => (await finderRows(kea))[0]?.path === 'packages/app/src/main.ts' || undefined)
  await page.keyboard.press(sysKey('Meta+Enter'))
  await expect(finder(page)).toHaveCount(0)
  expect((await editors.waitLaunches(1)).at(-1)?.argv.join(' ')).toContain('packages/app/src/main.ts')

  // ⌥↵: the path at the agent's prompt, shell-escaped and not submitted, and the keyboard the agent's; the file stays
  // in the work pane beside it
  await page.keyboard.press(sysKey('Meta+p'))
  await page.keyboard.type('my notes')
  await until('the notes lead', async () => (await finderRows(kea))[0]?.path === 'docs/my notes (draft).md' || undefined)
  await page.keyboard.press('Alt+Enter')
  await until('the Agent terminal with the keyboard', async () => (await kea.keyboard()) === agent || undefined)
  const screen = await kea.waitScreen('the path at the prompt', (s) => s.includes('docs/my\\ notes\\ \\(draft\\).md'))
  expect(screen.trimEnd().endsWith('docs/my\\ notes\\ \\(draft\\).md'), `not submitted: nothing follows it\n${screen}`).toBe(true)
  expect(await viewerShown(kea)).toEqual({ path: 'packages/app/src/util.ts', mode: 'file', focused: false })

  // nothing matches
  await page.keyboard.press(sysKey('Meta+p'))
  await page.keyboard.type('zzzz-no-such-file')
  await expect(finder(page).getByRole('status')).toHaveText('No matching files.')
  expect(await finderRows(kea)).toEqual([])
  await page.keyboard.press('Escape')

  // one column: ⌥↵ with the file on screen shows the Agent tab in its place
  await kea.oneColumn()
  await page.keyboard.press(sysKey('Meta+p'))
  await page.keyboard.type('util')
  await until('util.ts leads', async () => (await finderRows(kea))[0]?.path === 'packages/app/src/util.ts' || undefined)
  await page.keyboard.press('Enter')
  await until('the file on screen, with the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  await page.keyboard.press(sysKey('Meta+p'))
  await page.keyboard.type('my notes')
  await until('the notes lead', async () => (await finderRows(kea))[0]?.path === 'docs/my notes (draft).md' || undefined)
  await page.keyboard.press('Alt+Enter')
  await until('the Agent tab on screen in place of the file', async () => ((await viewerShown(kea)) === null && (await kea.shown()) === agent) || undefined)
})

test('E-FT-7 · ⌘P while the viewer is on screen: ⌥↵ with a file tab on screen types the file’s relative path at the fake agent’s prompt, not submitted, and gives the agent the keyboard, the file tab staying beside it, so what is typed next follows the path; Enter with a diff tab on screen shows the chosen file in the preview tab, flips the diff tab itself to the file view when the file is its own, and leaves a pinned diff tab alone', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const repo = demoRepo(run)
  writeFiles(repo.root, { 'docs/my notes (draft).md': 'notes\n' })
  commitAll(repo.root, 'Add notes')
  await addProject(kea, repo.root)
  // the agent draws its prompt and waits there: a submitted line would be answered and logged
  const { id, log } = await startFakeSession(kea, 'finder', 'wait for me', ['steps:', '  - frame: ["✻ fake-agent · {{model}}", "", "> "]', 'onLine:', '  - print: "SUBMITTED {{line}}\\r\\n"'].join('\n'))
  const agent = await fakeAgentTerminal(kea, id)
  const worktree = sessionWorktree(repo.root)
  const NOTES = 'docs/my\\ notes\\ \\(draft\\).md'
  const shape = async () => (await fileTabs(kea)).map((t) => `${t.path} ${t.kind}${t.pinned ? '' : ' preview'}${t.selected ? ' *' : ''}`)
  /** ⌘P, type `query`, wait until `path` leads the list. */
  const find = async (query: string, path: string) => {
    await page.keyboard.press(sysKey('Meta+p'))
    await expect(finder(page).getByRole('combobox')).toBeFocused()
    await page.keyboard.type(query)
    await until(`${path} leads the finder`, async () => (await finderRows(kea))[0]?.path === path || undefined)
  }

  // 1. a file tab on screen, with the keyboard; ⌥↵ in the finder
  await clickFile(kea, 'src/math.js')
  await until('math.js in the viewer, with the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  await find('my notes', 'docs/my notes (draft).md')
  await page.keyboard.press('Alt+Enter')
  await expect(finder(page)).toHaveCount(0)
  // the agent has the keyboard, the path is at its prompt, shell-escaped, and nothing was submitted; the file tab stays
  // in the work pane
  await until('the Agent terminal with the keyboard', async () => (await kea.keyboard()) === agent || undefined)
  expect(await viewerShown(kea)).toEqual({ path: 'src/math.js', mode: 'file', focused: false })
  const typed = await kea.waitScreen('the path at the agent’s prompt', (s) => s.includes(NOTES))
  expect(typed.trimEnd().endsWith(`> ${NOTES}`), `at the prompt, nothing after it\n${typed}`).toBe(true)
  expect(await shape(), 'the file tab is still on screen in the work pane').toEqual(['src/math.js file preview *'])
  // the keyboard is the agent's: what a person types next follows the path, and only their Enter submits it
  await until('the keyboard in the Agent terminal', () => focusIn(kea, '.terminal-host.shown'))
  // (a path typed for a shell is followed by a space: the next word starts after it)
  await page.keyboard.type('is the file')
  await kea.waitScreen('the typing follows the path', (s) => s.trimEnd().endsWith(`> ${NOTES} is the file`))
  expect(agentEvents(log).filter((e) => e.t === 'line'), 'nothing submitted so far').toEqual([])
  expect(await kea.screen()).not.toContain('SUBMITTED')
  await page.keyboard.press('Enter')
  await kea.waitScreen('the line the person submitted', (s) => s.includes(`SUBMITTED ${NOTES} is the file`))

  // 2. a diff tab on screen (the preview tab); Enter in the finder shows the chosen file there
  writeFiles(worktree, { 'src/math.js': 'export const add = (a, b) => a + b\n' })
  await clickChange(kea, 'src/math.js')
  await until('the diff on screen, with the keyboard', async () => {
    const v = await viewerShown(kea)
    return (v?.mode === 'diff' && v.focused) || undefined
  })
  expect(await shape()).toEqual(['src/math.js diff preview *'])
  await find('hello', 'src/hello.js')
  await page.keyboard.press('Enter')
  await expect(finder(page)).toHaveCount(0)
  await until('hello.js in the viewer, with the keyboard', async () => {
    const v = await viewerShown(kea)
    return (v?.path === 'src/hello.js' && v.mode === 'file' && v.focused) || undefined
  })
  expect(await shape(), 'the preview tab was reused').toEqual(['src/hello.js file preview *'])
  // the diff tab's own file: one tab per file, so that tab shows the file view
  await clickChange(kea, 'src/math.js')
  await until('the diff on screen again', async () => (await viewerShown(kea))?.mode === 'diff' || undefined)
  await find('math.js', 'src/math.js')
  await page.keyboard.press('Enter')
  await until('math.js as a file', async () => {
    const v = await viewerShown(kea)
    return (v?.path === 'src/math.js' && v.mode === 'file' && v.focused) || undefined
  })
  expect(await shape()).toEqual(['src/math.js file preview *'])
  // a pinned diff tab stays as it is; the file opens in a preview tab beside it
  await clickChange(kea, 'src/math.js')
  await until('the diff on screen again', async () => (await viewerShown(kea))?.mode === 'diff' || undefined)
  await pinFileTab(kea, 'src/math.js')
  await find('counter', 'src/counter.js')
  await page.keyboard.press('Enter')
  await until('counter.js in the viewer', async () => (await viewerShown(kea))?.path === 'src/counter.js' || undefined)
  expect(await shape()).toEqual(['src/math.js diff', 'src/counter.js file preview *'])
})

test('E-FT-5 · a row of the file tree dragged onto the terminal types its path there, shell-escaped and not submitted; dragged with ⌥ held it types `@path`, quoted for a name with a space', async ({ run, launch }) => {
  const kea = await launch()
  const { id } = await sessionWith(kea, run, { 'docs/my notes.md': 'notes\n' })
  const page = await kea.page()
  await agentTerminal(kea, id)
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
  await treeRow(page, 'docs').click()
  await waitTree(kea, 'docs is open', (rows) => rows.some((r) => r.path === 'docs/my notes.md'))
  const area = page.locator('.agent-pane .terminal-area')

  await treeRow(page, 'docs/my notes.md').dragTo(area)
  const typed = await kea.waitScreen('the path at the prompt', (s) => s.includes('docs/my\\ notes.md'))
  expect(typed.trimEnd().endsWith('docs/my\\ notes.md'), `not submitted\n${typed}`).toBe(true)

  await page.keyboard.down('Alt')
  await treeRow(page, 'README.md').dragTo(area)
  await page.keyboard.up('Alt')
  const mention = await kea.waitScreen('the mention at the prompt', (s) => s.includes('@README.md'))
  expect(mention.trimEnd().endsWith('docs/my\\ notes.md @README.md'), `the mention follows the path, a space apart\n${mention}`).toBe(true)
  // a name with a space: the agent's quoted form, which reads back as that file (`@docs/my notes.md` would name `docs/my`)
  await page.keyboard.down('Alt')
  await treeRow(page, 'docs/my notes.md').dragTo(area)
  await page.keyboard.up('Alt')
  const quoted = await kea.waitScreen('the quoted mention at the prompt', (s) => s.includes('@"docs/my notes.md"'))
  expect(quoted.trimEnd().endsWith('@README.md @"docs/my notes.md"'), `after the first mention, a space apart\n${quoted}`).toBe(true)
  await expect(tree(page)).toBeVisible()
})

test('E-KB-3 · a column hidden while the keyboard is in it gives the keyboard to the main pane: ⌘⇧E pressed in the file tree hides the panel and what is typed next reaches the terminal, not the hidden tree; ⌘⇧G pressed in the Changes list with a file tab on screen gives it to the viewer; ⌘B with the keyboard in the sidebar gives it to the terminal', async ({ run, launch }) => {
  const kea = await launch()
  const { id } = await sessionWith(kea, run)
  const page = await kea.page()
  const agent = await agentTerminal(kea, id)
  const panelColumn = page.locator('section.file-panel')
  const inTerminal = () => until('the keyboard in the terminal on screen', () => focusIn(kea, '.terminal-host.shown'))
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))

  // the keyboard in the tree, on a row: a click on a folder
  await treeRow(page, 'src').click()
  await waitTree(kea, 'src is open', (rows) => rows.some((r) => r.path === 'src/index.js'))
  await until('the keyboard in the tree', () => focusIn(kea, '[role=tree]'))
  // ⌘⇧E there hides the panel, and the keyboard is the terminal's
  await page.keyboard.press(sysKey('Meta+Shift+e'))
  await expect(panelColumn).toBeHidden()
  await inTerminal()
  // what is typed now is the terminal's: in the hidden tree, these keys would move its row and Enter would open a file
  await kea.enter('echo typed-$((40+2))')
  await kea.waitScreen('the line typed reached the shell', (s) => s.includes('typed-42'))
  expect(await fileTabs(kea), 'no file was opened from the hidden tree').toEqual([])
  expect(await kea.shown()).toBe(agent)
  expect(await selectedRow(kea), 'and its row did not move').toBe('src')

  // ⌘⇧E again shows it, with the keyboard in the tree; a click on a file gives the keyboard to the viewer
  await page.keyboard.press(sysKey('Meta+Shift+e'))
  await expect(panelColumn).toBeVisible()
  await until('the keyboard in the tree', () => focusIn(kea, '[role=tree]'))
  await treeRow(page, 'src/index.js').click()
  await until('the file in the viewer, with the keyboard', async () => (await viewerShown(kea))?.focused || undefined)
  // ⌘⇧G: Changes, with the keyboard in its list; pressed again there it hides the panel, and the main pane's file tab
  // has the keyboard
  await page.keyboard.press(sysKey('Meta+Shift+g'))
  await until('the keyboard in the Changes list', () => focusIn(kea, '[role=listbox][aria-label="Changes"]'))
  await page.keyboard.press(sysKey('Meta+Shift+g'))
  await expect(panelColumn).toBeHidden()
  await until('the keyboard in the viewer', async () => (await viewerShown(kea))?.focused || undefined)
  expect(await viewerShown(kea)).toEqual({ path: 'src/index.js', mode: 'file', focused: true })
  await page.keyboard.press('Escape')
  await until('the file tab closed', async () => (await viewerShown(kea)) === null || undefined)
  await inTerminal()

  // the sidebar: F6 from the terminal, the last stop, puts the keyboard on its row; ⌘B hides it, and the terminal has
  // the keyboard
  await page.keyboard.press('F6')
  await until('the keyboard in the sidebar', () => focusIn(kea, 'aside.sidebar-column'))
  await page.keyboard.press(sysKey('Meta+b'))
  await expect(page.locator('aside.sidebar-column')).toBeHidden()
  await inTerminal()
  await kea.echo('after-sidebar')
})

/** The worktrees of `repo`'s sessions (every worktree but the repository's own checkout). */
function sessionWorktrees(repo: string): string[] {
  const real = fs.realpathSync(repo)
  return gitIn(repo, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((b) => /^worktree (.+)$/m.exec(b)?.[1] ?? '')
    .filter((d) => d !== '' && fs.realpathSync(d) !== real)
}

test('E-FT-6 · a git status slower than a second brings up the panel’s hint: Dismiss closes it for that session for good, another session is still offered it, and its button turns on the project’s “Use git fsmonitor”: the hint goes at once, each worktree’s own config has the setting, the project’s settings show it on, and turning it off there takes it out again and stops git’s daemon', async ({ run, launch }) => {
  const noDaemon = fsmonitorProblem()
  test.skip(noDaemon !== null, skipNote(noDaemon ?? ''))
  const git = new SlowGit(run)
  const kea = await launch()
  const { id, worktree, repo } = await sessionWith(kea, run)
  const page = await kea.page()
  const hint = fsmonitorHint(page)
  const counted = (n: number): Promise<true> => until(`Changes ${n}`, async () => (await panelModes(kea)).some((m) => m.label === `Changes ${n}`) || undefined, GIT_MS)
  try {
    await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
    // a status of ordinary speed: nothing is suggested
    writeFiles(worktree, { 'one.txt': '1\n' })
    await counted(1)
    await expect(hint).toHaveCount(0)
    expect(gitConfig(worktree, '--get', 'core.fsmonitor'), 'never set by itself').toBe('')

    // a slow one: the hint, with its two buttons
    git.slow(true)
    writeFiles(worktree, { 'two.txt': '2\n' })
    await expect(hint).toBeVisible({ timeout: GIT_MS })
    await expect(hint).toContainText('Git status is slow in this repository.')
    await expect(hint.getByRole('button', { name: 'Use git fsmonitor' })).toBeVisible()
    // Dismiss: gone, and the next slow status does not bring it back
    await hint.getByRole('button', { name: 'Dismiss' }).click()
    await expect(hint).toHaveCount(0)
    writeFiles(worktree, { 'three.txt': '3\n' })
    await counted(3)
    await expect(hint).toHaveCount(0)

    // another session of the project: it is offered there (the hint is closed per session)
    git.slow(false)
    const second = await startSession(kea, 'another')
    await waitLive(kea, second)
    await waitTree(kea, 'the other session’s tree', (rows) => rows.some((r) => r.path === 'README.md') && !rows.some((r) => r.path === 'one.txt'))
    const other = sessionWorktrees(repo).find((d) => fs.realpathSync(d) !== fs.realpathSync(worktree))
    if (!other) throw new Error('the second session has no worktree of its own')
    git.slow(true)
    writeFiles(other, { 'four.txt': '4\n' })
    await expect(hint).toBeVisible({ timeout: GIT_MS })
    // back in the first session it stays closed (saved with the session's panel state), slow status or not
    await selectSession(kea, id)
    await waitTree(kea, 'the first session’s tree', (rows) => rows.some((r) => r.path === 'one.txt'))
    writeFiles(worktree, { 'five.txt': '5\n' })
    await counted(4)
    await expect(hint).toHaveCount(0)
    await selectSession(kea, second)
    await waitTree(kea, 'the other session’s tree', (rows) => rows.some((r) => r.path === 'four.txt'))
    await expect(hint).toBeVisible({ timeout: GIT_MS })

    // its button: the project's setting; the hint goes with the click, not with the next status
    git.slow(false)
    await hint.getByRole('button', { name: 'Use git fsmonitor' }).click()
    await expect(hint).toHaveCount(0)
    await until('core.fsmonitor in the worktree’s own config', () => (gitConfig(other, '--worktree', '--get', 'core.fsmonitor') === 'true' && gitConfig(other, '--worktree', '--get', 'core.untrackedCache') === 'true') || undefined)
    expect(gitConfig(repo, '--local', '--get', 'core.fsmonitor'), 'not in the repository’s shared config').toBe('')
    // the project's settings show it on; turned off there, the keys go and git's daemon is stopped
    await projectRow(page, 'demo').click({ button: 'right' })
    await page.getByRole('menu', { name: 'Project menu' }).locator('[role=menuitem][data-command="project.settings"]').click()
    const settings = page.getByRole('dialog', { name: 'Project settings' })
    const toggle = settings.getByRole('switch', { name: 'Use git fsmonitor for this repo' })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await until('the setting to be taken out of the worktree’s config', () => gitConfig(other, '--get', 'core.fsmonitor') === '' || undefined)
    await until('git’s daemon to be stopped', () => !fsmonitorRuns(other) || undefined)
  } finally {
    git.slow(false)
    // whatever the test got to: no daemon of git's outlives it (the run's cleanup does not know of them)
    for (const wt of sessionWorktrees(repo)) stopFsmonitorDaemon(wt)
  }
})
