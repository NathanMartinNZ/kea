// Open in editor, and the paths in a terminal that open there: Kea launched through tests/e2e/fixtures.ts and
// driven as a person drives it: `⌘⇧O`, the header's split button and its menu, a double-click or `⌘↵` on a row of the
// file tree, `⌘↵` on a row of the Changes list and in a diff tab, “Open All in Editor”, a `⌘`-click in a terminal, the
// toast. No editor, terminal app, file manager or browser is ever started: the editors, `open` and `gh` Kea finds are
// the fake editor's stand-ins under the run's own HOME (tests/support/app-server.ts `EditorWorld`), and each records
// the argv it was run with.

import fs from 'node:fs'
import path from 'node:path'
import { EDITOR_DEFS } from '@kea/core/src/editor/catalog.ts'
import { installTool } from '@kea-tools/fake-editor/src/index.ts'
import { L } from '@kea/protocol'
import { PROMPT, STEP_MS, until } from '../support/app.ts'
import { changeRows, clickChange, GIT_MS, panelModes, panelRegion, treeRowInView, treeRows } from '../support/app-files.ts'
import { addProject, agentTerminal, demoRepo, promptBox, projectRow, sessionMenu, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { cellOf, clipboard, commandReason, commitFiles, editorButton, EditorWorld, menuLabels, openEditorMenu, recordClipboard, worktreesOf } from '../support/app-server.ts'
import { viewerShown } from '../support/app-tabs.ts'
import { expect, test } from './fixtures.ts'
import { MOD_CLICK, sysKey } from '../support/keys.ts'
import { protocolOs } from '../../packages/protocol/src/os/index.ts'

/** The file manager's name in a title: Finder, or File Manager on Linux. */
const FILE_MANAGER = protocolOs.words.fileManager
/** Whether the stand-ins and their launches take Linux's shape (tests/support/app-server.ts `EditorWorld`). */
const LINUX = protocolOs.system === 'linux'

const def = (id: string) => EDITOR_DEFS.find((d) => d.id === id)!
const worktree = (root: string, slug: string): string => {
  const w = worktreesOf(root).find((x) => x.branch.includes(slug))
  if (!w) throw new Error(`no worktree on a branch with ${slug}: ${JSON.stringify(worktreesOf(root))}`)
  return w.dir
}

test('E-ED-1 · VS Code installed, `code` not on PATH: ⌘⇧O opens the worktree; a double-click on a file in the tree opens it in that worktree’s window, and so does ⌘↵ on a tree row; ⌘↵ on a Changes row opens the file at its first changed line and in the diff tab at the cursor’s line; “Open All in Editor” is unavailable past its limit and otherwise opens every changed file still on disk; ⌘-click on `file:line:col` in terminal output lands on the position, and on a path that is not a file of the worktree does nothing', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const world = new EditorWorld(run)
  world.editor('vscode')
  world.open()
  const repo = demoRepo(run)
  const LONG = 'src/long.js'
  const long = Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1}`)
  commitFiles(repo.root, { [LONG]: `${long.join('\n')}\n` })
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'edit')
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)
  const dir = worktree(repo.root, 'edit')
  const button = editorButton(page)
  await expect(button).toHaveAttribute('data-editor', 'vscode', { timeout: STEP_MS })
  await expect(button.getByRole('button', { name: 'Code', exact: true })).toBeVisible()
  expect(world.launches(), 'nothing is launched by looking').toEqual([])
  let seen = 0
  /** The stand-ins run since the last call (exactly `n` of them). */
  const next = async (n: number) => {
    const all = await world.waitLaunches(seen + n)
    const fresh = all.slice(seen)
    seen = all.length
    return fresh
  }
  const keyboardIn = (selector: string) => until(`the keyboard in ${selector}`, () => page.evaluate((s) => !!document.activeElement?.closest(s), selector).then((x) => x || undefined))

  // ⌘⇧O opens the worktree with the bundle's own CLI (the folder first: its window is the one that opens)
  await page.keyboard.press(sysKey('Meta+Shift+KeyO'))
  expect(await next(1)).toEqual([{ tool: 'code', argv: [dir] }])

  // A double-click on the file's row in the tree: the worktree first, so it opens in that folder's window,
  // then the file
  await (await treeRowInView(kea, 'src/math.js')).dblclick()
  expect(await next(1)).toEqual([{ tool: 'code', argv: [dir, path.join(dir, 'src/math.js')] }])
  // ⌘↵ with the keyboard on a tree row (the double-click left it in the tree; typing a name moves it): the same road
  await keyboardIn('[role=tree]')
  await page.keyboard.type('hel')
  await until('the keyboard on hello.js', async () => (await treeRows(kea)).find((r) => r.selected)?.path === 'src/hello.js' || undefined)
  await page.keyboard.press(sysKey('Meta+Enter'))
  expect(await next(1)).toEqual([{ tool: 'code', argv: [dir, path.join(dir, 'src/hello.js')] }])

  // ⌘↵ on a Changes row opens the file at its first changed line. The session changed lines 12 and 20
  const changed = [...long]
  changed[11] = 'export const line12 = "twelve"'
  changed[19] = 'export const line20 = "twenty"'
  fs.writeFileSync(path.join(dir, LONG), `${changed.join('\n')}\n`)
  await clickChange(kea, LONG)
  await expect.poll(() => viewerShown(kea), { message: 'the diff tab on screen, with the keyboard' }).toMatchObject({ path: LONG, mode: 'diff', focused: true })
  await page.keyboard.press(sysKey('Meta+Shift+g'))
  await keyboardIn('[role=listbox][aria-label="Changes"]')
  expect((await changeRows(kea)).find((r) => r.selected)?.path, 'the keyboard is on the row that was clicked').toBe(LONG)
  await page.keyboard.press(sysKey('Meta+Enter'))
  expect(await next(1)).toEqual([{ tool: 'code', argv: [dir, '--goto', `${path.join(dir, LONG)}:12:1`] }])
  // … and in the diff tab, at the cursor's line: ⌥↓ twice puts it on the second change
  await page.locator('.viewer .cm-content .cm-line').first().click()
  await expect.poll(() => viewerShown(kea)).toMatchObject({ path: LONG, focused: true })
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press(sysKey('Meta+Enter'))
  expect(await next(1)).toEqual([{ tool: 'code', argv: [dir, '--goto', `${path.join(dir, LONG)}:20:1`] }])

  // “Open All in Editor” in the Changes header's ⋯ menu. One file over its limit: unavailable, and the menu says why
  const many = Array.from({ length: L.openAllChangedMax }, (_, i) => `many/f${String(i + 1).padStart(2, '0')}.txt`)
  for (const f of many) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), `${f}\n`)
  }
  const total = many.length + 1
  await until(`the header counts ${total} changes`, async () => (await panelModes(kea)).some((m) => m.label === `Changes ${total}`) || undefined, GIT_MS)
  const actions = panelRegion(page).getByRole('button', { name: 'Changes actions' })
  const menu = page.getByRole('menu', { name: 'Changes actions' })
  const openAll = menu.locator('[role=menuitem][data-command="files.openAllChanged"]')
  await actions.click()
  await expect(openAll).toHaveAttribute('aria-disabled', 'true')
  await expect(openAll).toHaveAttribute('aria-description', `Opens at most ${L.openAllChangedMax} files at once; ${total} are changed`)
  await openAll.click({ force: true })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // a deleted file is not on disk any more: it counts as a change, and is not one to open
  fs.rmSync(path.join(dir, many.at(-1)!))
  fs.rmSync(path.join(dir, 'src/counter.js'))
  await until(`the header counts ${total} changes, one of them a deletion`, async () => ((await panelModes(kea)).some((m) => m.label === `Changes ${total}`) && (await changeRows(kea)).some((r) => r.path === 'src/counter.js' && r.letter === 'D')) || undefined, GIT_MS)
  expect(world.launches(), 'the unavailable item opened nothing').toHaveLength(seen)
  await actions.click()
  await expect(openAll).not.toHaveAttribute('aria-disabled', 'true')
  await openAll.click()
  // one editor call per file, in the list's order (by path), each in the worktree's window; the deleted one is skipped
  const opened = [...many.slice(0, -1), LONG].sort((a, b) => (a < b ? -1 : 1))
  expect(opened).toHaveLength(L.openAllChangedMax)
  expect(await next(opened.length)).toEqual(opened.map((f) => ({ tool: 'code', argv: [dir, path.join(dir, f)] })))

  // ⌘-click on `src/math.js:2:5` in terminal output. Paths that are not files of this worktree are not links
  await kea.clickTab(agent)
  await kea.enter('clear')
  await kea.enter(`printf '%s\\n' 'at src/math.js:2:5 here' 'gone src/nope.js:1:1 here' 'out /etc/hosts:1 here' 'paren src/hello.js(3,9) here'`) // os-ok: test data
  await kea.waitScreen('the lines on screen', (s) => s.split('\n').some((l) => l.startsWith('paren src/hello.js(3,9) here')))
  const screen = page.locator('.terminal-host.shown .xterm-screen')
  /** Hover `text`, wait for the link's target on hover when it is to be a link (`target`), then ⌘-click it. */
  const click = async (text: string, target: string | null) => {
    const at = await cellOf(kea, text, 4)
    await screen.hover({ position: at })
    if (target !== null) await expect(page.locator('[role=tooltip]', { hasText: target }), `${text} is a link`).toBeVisible({ timeout: STEP_MS })
    await screen.click({ position: at, modifiers: [MOD_CLICK] })
  }
  await click('src/nope.js:1:1', null)
  await click('/etc/hosts:1', null) // os-ok: test data
  await click('src/math.js:2:5', 'src/math.js:2:5')
  await click('src/hello.js(3,9)', 'src/hello.js:3:9')
  expect(await next(2)).toEqual([
    { tool: 'code', argv: [dir, '--goto', `${path.join(dir, 'src/math.js')}:2:5`] },
    { tool: 'code', argv: [dir, '--goto', `${path.join(dir, 'src/hello.js')}:3:9`] },
  ])
  // a plain click selects nothing and opens nothing
  await screen.click({ position: await cellOf(kea, 'src/math.js:2:5', 4) })
  // Every launch got its paths as arguments of its own, from the worktree
  expect(new Set(world.cwds())).toEqual(new Set([dir]))
  await kea.enter('echo still-a-terminal')
  await kea.waitScreen('typing still reaches the terminal', (s) => s.includes('still-a-terminal\n'))
  expect(world.launches()).toHaveLength(seen)
  await kea.assertUnfocused()
})

test('E-ED-2 · editor details: only Cursor installed → the button targets it and lists no other editor; pressed feedback; Finder, Copy path and the terminal app; a newly installed editor is listed; the button follows the default editor setting; all strategies failing gives one toast with "Choose editor…"; in-place and detached sessions open; a default that is not installed reads `Open in…` and offers to change it; Create Pull Request through gh', async ({ run, launch }) => {
  test.setTimeout(240_000)
  const world = new EditorWorld(run)
  world.editor('cursor')
  world.open()
  const ghostty = world.terminalApp('Ghostty')
  const repo = demoRepo(run)
  const kea = await launch()
  const page = await kea.page()
  await recordClipboard(page)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'tools')
  await waitLive(kea, id)
  await agentTerminal(kea, id)
  const dir = worktree(repo.root, 'tools')
  const button = editorButton(page)
  const settingsFile = path.join(run.home, 'settings.json')
  const setDefault = (editor: string) => fs.writeFileSync(settingsFile, `${JSON.stringify({ general: { defaultAgent: 'shell', defaultEditor: editor } }, null, 2)}\n`)
  const pick = async (label: string) => {
    await page.getByRole('menu').locator('[role=menuitem]', { hasText: label }).click({ timeout: STEP_MS })
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  /** Open the split button's menu and wait until it lists exactly `labels` (it looks again at what is installed). */
  const menuShows = async (labels: string[]) => {
    const menu = await openEditorMenu(page)
    await expect.poll(() => menuLabels(menu), { timeout: STEP_MS }).toEqual(labels)
  }
  let seen = 0
  /** The stand-ins run since the last call. */
  const next = async (n: number) => {
    const all = await world.waitLaunches(seen + n)
    const fresh = all.slice(seen)
    seen = all.length
    return fresh
  }

  // ── Only Cursor is installed, so the primary button is Cursor's and VS Code is nowhere ──
  await expect(button).toHaveAttribute('data-editor', 'cursor', { timeout: STEP_MS })
  const primary = button.getByRole('button', { name: 'Cursor', exact: true })
  await expect(primary).toBeVisible()
  // The menu lists what is installed: no other editor; then the file manager, Copy path, the terminal app
  await menuShows([`Reveal Worktree in ${FILE_MANAGER}`, 'Copy Worktree Path', 'Open in Terminal App'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // ── The click answers at once with the pressed state, which then goes ──
  await primary.click()
  await expect(primary).toHaveClass(/pressed/)
  expect(await next(1)).toEqual([{ tool: 'cursor', argv: [dir] }])
  await expect(primary).not.toHaveClass(/pressed/, { timeout: STEP_MS })

  // ── The file manager (asked of main, which opens nothing under the harness), Copy path, the terminal app ──
  await openEditorMenu(page)
  await pick(`Reveal Worktree in ${FILE_MANAGER}`)
  await until('Reveal asked of main', () => kea.logLines('main').some((l) => l.msg === 'reveal not opened (perf)') || undefined)
  await openEditorMenu(page)
  await pick('Copy Worktree Path')
  await until('the worktree path copied', async () => (await clipboard(page)).at(-1) === dir || undefined)
  await openEditorMenu(page)
  await pick('Open in Terminal App')
  // macOS: `open -a` with the bundle; Linux: the app's command, started in the folder with its folder argument
  expect(await next(1)).toEqual([LINUX ? { tool: 'ghostty', argv: [`--working-directory=${dir}`] } : { tool: 'open', argv: ['-a', ghostty, dir] }])

  // ── An editor installed since is found when the menu opens, and offered beside the default ──
  world.editor('zed')
  await menuShows([`Reveal Worktree in ${FILE_MANAGER}`, 'Copy Worktree Path', 'Open in Zed', 'Open in Terminal App'])
  await pick('Open in Zed')
  expect(await next(1)).toEqual([{ tool: path.basename(def('zed').cli), argv: [dir] }])
  await expect(button, 'the primary click is still the default editor').toHaveAttribute('data-editor', 'cursor')

  // ── The button follows the setting (settings.json, as the Settings window will write it) ──
  setDefault('zed')
  await expect(button).toHaveAttribute('data-editor', 'zed', { timeout: STEP_MS })
  const zed = button.getByRole('button', { name: 'Zed', exact: true })
  await zed.click()
  expect(await next(1)).toEqual([{ tool: path.basename(def('zed').cli), argv: [dir] }])
  await menuShows([`Reveal Worktree in ${FILE_MANAGER}`, 'Copy Worktree Path', 'Open in Cursor', 'Open in Terminal App'])
  await page.keyboard.press('Escape')

  // ── Every strategy fails → one toast with the last attempt's stderr and "Choose editor…" ──
  const openFails = LINUX ? 'xdg-open: no method available for opening it' : 'LSOpenURLsWithRole() failed with error -10814'
  installTool(LINUX ? path.join(world.bin, def('zed').linux.commands[0] as string) : path.join(world.apps, def('zed').appName, def('zed').cli), { as: 'zed-cli', log: world.log, exit: 1, stderr: 'zed: cannot start' })
  world.open({ exit: 1, stderr: openFails })
  await page.keyboard.press(sysKey('Meta+Shift+KeyO'))
  // `open` is told which app by the path of the bundle that was found, for the folder and for the URL;
  // Linux has no app to name: the editor's URL goes to xdg-open
  const zedBundle = path.join(world.apps, def('zed').appName)
  const fallbacks = LINUX
    ? [['zed-cli', dir], ['xdg-open', `zed://file${dir}`]]
    : [
        ['zed-cli', dir],
        ['open', '-a', zedBundle, dir],
        ['open', '-a', zedBundle, `zed://file${dir}`],
      ]
  expect((await next(fallbacks.length)).map((l) => [l.tool, ...l.argv])).toEqual(fallbacks)
  const toast = page.getByRole('alert')
  await expect(toast).toHaveCount(1, { timeout: STEP_MS })
  await expect(toast).toContainText(`Couldn't open Zed: ${openFails}`)
  await toast.getByRole('button', { name: 'Choose editor…' }).click()
  const choose = page.getByRole('menu', { name: 'Choose editor' })
  await expect(choose).toBeVisible({ timeout: STEP_MS })
  expect(await menuLabels(choose)).toEqual(['Open in Cursor', 'Open in Zed'])
  await pick('Open in Cursor')
  expect(await next(1)).toEqual([{ tool: 'cursor', argv: [dir] }])
  await expect(toast).toHaveCount(0)
  world.open()
  world.editor('zed')

  // ── session.createPR in the header's overflow: `gh pr create --web` in the worktree; unavailable without gh ──
  expect(await commandReason(kea, 'session.createPR', { id })).toBe('The GitHub CLI (gh) is not installed')
  world.gh()
  await openEditorMenu(page) // looks again at what is installed
  await page.keyboard.press('Escape')
  await until('gh found', async () => (await commandReason(kea, 'session.createPR', { id })) === null || undefined)
  await page.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menu', { name: 'Session actions' }).locator('[role=menuitem][data-command="session.createPR"]').click({ timeout: STEP_MS })
  expect(await next(1)).toEqual([{ tool: 'gh', argv: ['pr', 'create', '--web'] }])
  expect(world.cwds().at(-1)).toBe(dir)

  // ── A detached session still opens its folder; an in-place session opens the project's root ──
  await sessionMenu(kea, id, 'session.stop')
  await waitRow(kea, id, 'detached after Stop', (r) => r.lifecycle === 'detached')
  await page.keyboard.press(sysKey('Meta+Shift+KeyO'))
  expect(await next(1)).toEqual([{ tool: path.basename(def('zed').cli), argv: [dir] }])
  const composer = page.getByRole('region', { name: 'New session' })
  await projectRow(page, 'demo').hover()
  await page.getByRole('button', { name: 'New Session in demo' }).click()
  await expect(composer.getByRole('button', { name: 'Project: demo' })).toBeVisible({ timeout: STEP_MS })
  const toggle = composer.getByRole('switch', { name: 'Worktree' })
  await expect(toggle).toBeChecked({ timeout: STEP_MS })
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await promptBox(page).click()
  const inPlace = await startSession(kea, 'in place', { open: false })
  await waitLive(kea, inPlace)
  await agentTerminal(kea, inPlace)
  await expect(button).toHaveAttribute('data-editor', 'zed', { timeout: STEP_MS })
  await button.getByRole('button', { name: 'Zed', exact: true }).click()
  expect(await next(1)).toEqual([{ tool: path.basename(def('zed').cli), argv: [repo.root] }])
  expect(await commandReason(kea, 'session.createPR', { id: inPlace }), 'no branch of its own, no pull request').toBe('The session has no branch (in place)')

  // ── A default editor that is not installed: `Open in…`, the menu, an offer to change it — and no toast ──
  setDefault('windsurf')
  await expect(button).toHaveAttribute('data-editor', '', { timeout: STEP_MS })
  await expect(button.getByRole('button')).toHaveText(['Open in…'])
  await page.keyboard.press(sysKey('Meta+Shift+KeyO'))
  const menu = page.getByRole('menu', { name: 'Open in' })
  await expect(menu, '⌘⇧O opens the menu instead').toBeVisible({ timeout: STEP_MS })
  expect(await menuLabels(menu)).toEqual([`Reveal Worktree in ${FILE_MANAGER}`, 'Copy Worktree Path', 'Open in Cursor', 'Open in Zed', 'Open in Terminal App', 'Change Default Editor…'])
  await expect(page.getByRole('alert'), 'a predictable state is not an error').toHaveCount(0)
  await menu.locator('[role=menuitem]', { hasText: 'Change Default Editor…' }).click()
  const defaults = page.getByRole('menu', { name: 'Default editor' })
  await expect(defaults).toBeVisible({ timeout: STEP_MS })
  expect(await menuLabels(defaults)).toEqual(['Cursor', 'Zed'])
  await defaults.locator('[role=menuitem]', { hasText: 'Cursor' }).click()
  await expect(button).toHaveAttribute('data-editor', 'cursor', { timeout: STEP_MS })
  expect((JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { general: { defaultEditor: string } }).general.defaultEditor).toBe('cursor')
  await button.getByRole('button', { name: 'Cursor', exact: true }).click()
  expect(await next(1)).toEqual([{ tool: 'cursor', argv: [repo.root] }])
  expect(world.launches()).toHaveLength(seen)
  await kea.waitScreen('the in-place session’s terminal is still there', (s) => s.includes(PROMPT))
  await kea.assertUnfocused()
})
