// Review sets (`pnpm gallery --review`): states that are one or two clicks away in the running app, kept as screens for
// a design review of the whole app: the header's dev-server control in each state, the file panel's notes, the palette,
// the finder, tooltips, the Keyboard Shortcuts sheet, every Settings page, and one pass under the light theme.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS, until, type Kea } from '../../../tests/support/app.ts'
import { tryLock } from '../../../packages/kit/src/index.ts'
import { waitChanges, waitTree } from '../../../tests/support/app-files.ts'
import { openPalette, tooltip } from '../../../tests/support/app-palette.ts'
import { commitFiles, serverScript, waitServer } from '../../../tests/support/app-server.ts'
import { addProject, selectSession, startSession } from '../../../tests/support/app-sessions.ts'
import { fixtureGitEnv, tinyRepo } from '../../repo-factory/src/index.ts'
import { cwdOf, demoProject, frame, openKea, pageDelay, permission, REVIEW, runCommand, session, status, write } from './scene.ts'
import { GallerySet } from './shots.ts'

type Page = Awaited<ReturnType<Kea['page']>>

const HEADER = { x: 504, y: 0, width: 936, height: 120 }
const PANEL = { x: 240, y: 0, width: 264, height: 420 }
const MAIN = { x: 504, y: 0, width: 936, height: 900 }

const WORKING = `steps:
  - hook: UserPromptSubmit
  - ${frame('⏺ Reading src/hello.js', '', '✶ Working…')}
  - wait: { answer: "~" }
`

/** Rest the pointer on a control until its tooltip shows. */
async function tipOn(kea: Kea, page: Page, selector: string): Promise<void> {
  await page.mouse.move(700, 500)
  await page.locator(selector).first().hover()
  await pageDelay(kea, 700)
  await expect(tooltip(page)).toBeVisible({ timeout: STEP_MS })
}

test('R-2 · header, dev server, file panel, tooltips', async ({ run, launch }) => {
  test.skip(!REVIEW, 'a review set: pnpm gallery --review')
  test.setTimeout(180_000)
  const set = new GallerySet('R-2', 'Header, dev-server control, file panel notes, tooltips')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
  // a dev server that takes a moment to listen, and one that exits at once (a second project)
  commitFiles(root, { 'start.sh': serverScript(['--delay', '4000']) }, { executable: true })
  await addProject(kea, root, 'atlas-web')
  const id = await session(kea, 'r2-a', 'Fix auth redirect', WORKING)
  await selectSession(kea, id)
  await waitTree(kea, 'listed', (rows) => rows.length > 0)
  await waitServer(kea, 'stopped')
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'header-clean', 'The header of a session with no changes: no diff stat; ▶ Run in its slot', 'Header, Dev server control', { rect: HEADER })
  await set.shot(kea, 'panel-empty-files', 'Files of a clean worktree', 'File tree', { rect: PANEL })
  // the keyboard in the tree before any row was chosen: the ring is the list's own
  await page.keyboard.press('Meta+Shift+e')
  await until('the keyboard in the file panel', async () => (await page.evaluate(() => !!document.activeElement?.closest('section.file-panel'))) || undefined)
  await set.shot(kea, 'panel-focus-no-row', 'The keyboard in the tree, on no row yet: the focus ring inside the list’s edge', 'File tree, Space and shape', { rect: PANEL })
  await page.keyboard.press('ArrowDown')
  await set.shot(kea, 'panel-focus-row', 'After ↓: the row the keyboard is on, on --surface-3; no ring', 'File tree', { rect: PANEL })
  await page.keyboard.press('Escape')
  await runCommand(kea, 'files.showChanges')
  await expect(page.getByText('No changes yet.')).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'panel-no-changes', 'Changes, empty: "No changes yet." in --text-3, top-left with the list', 'File tree', { rect: PANEL })
  await runCommand(kea, 'files.showFiles')

  // only renames: the diff stat says the files, never +0 −0
  const wt = await cwdOf(kea, id)
  execFileSync('git', ['-C', wt, 'mv', 'src/hello.js', 'src/greeting.js'], { env: fixtureGitEnv(), stdio: 'ignore' })
  await runCommand(kea, 'files.showChanges')
  await waitChanges(kea, 'the rename', (rows) => rows.length > 0)
  await expect(page.locator('.diff-stat')).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'header-rename-only', 'Only a rename changed: the diff stat says "1 file" (small call b), not +0 −0', 'Header', { rect: HEADER })
  write(wt, { 'src/auth/login.js': 'export const login = () => "/signin"\n', 'README.md': '# Atlas\n\nA small service.\n' })
  await expect(page.locator('.diff-stat .add')).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'panel-changes', 'Changes: the scope switch, totals, the branch line, rows', 'File tree', { rect: PANEL })
  await runCommand(kea, 'files.showFiles')

  // ── the dev-server control, state by state ──
  await page.keyboard.press('Meta+r')
  await waitServer(kea, 'running', 30_000)
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'server-running-no-port', 'Running before a port was seen (this server takes 4 s to listen): ■ Stop alone; the diff stat before it has not moved. (Starting… lasts only until the process is up: too short to capture.)', 'Dev server control', { rect: HEADER })
  await page.locator('.server-chip').waitFor({ timeout: 30_000 })
  await set.shot(kea, 'server-running', 'Running: the :PORT ↗ chip and ■ Stop', 'Dev server control', { rect: HEADER })
  await tipOn(kea, page, '[role=group][aria-label="Dev server"] button[data-command="server.toggle"]')
  await set.shot(kea, 'tooltip-command', 'A tooltip: 11 px on --surface-4, the command and its key in a chip', 'Floating layers', { rect: HEADER })
  await tipOn(kea, page, '.branch-chip')
  await set.shot(kea, 'tooltip-branch', 'The branch chip’s tooltip', 'Floating layers, Header', { rect: HEADER })
  await tipOn(kea, page, '.session-title')
  await set.shot(kea, 'tooltip-rename', 'The title’s hint', 'Floating layers, Header', { rect: HEADER })
  await page.mouse.move(1000, 700)
  await page.keyboard.press('Meta+r')
  await waitServer(kea, 'stopped', 30_000)

  // the status of a session with a permission question while its dev server ran: the Server tab is in the strip
  await status(kea, id, 'needsYou', ...permission('pnpm add stripe'))
  await set.shot(kea, 'server-tab', 'After a run: the Server tab stays in the strip; the session needs you', 'Terminal, Dev server control', { rect: { ...MAIN, height: 300 } })

  // ── a server that exits at once ──
  fs.writeFileSync(path.join(wt, 'start.sh'), serverScript(['--exit', '1']), { mode: 0o755 })
  await page.keyboard.press('Meta+r')
  await waitServer(kea, 'crashed', 30_000)
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'server-exited', 'Exited 1 with Restart: the slot’s widest usual state', 'Dev server control', { rect: HEADER })

  // ── the header's popover and overflow menu ──
  await page.locator('[data-config-summary]').click()
  await page.locator('.session-popover').waitFor({ timeout: STEP_MS })
  {
    await set.shot(kea, 'popover', 'The config summary’s popover: read-only launch config, the folder cut in its middle, why this status', 'Header, Floating layers', { rect: MAIN })
    await page.keyboard.press('Escape')
  }
  await page.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menu').waitFor({ timeout: STEP_MS })
  await set.shot(kea, 'header-menu', 'The header’s ⋯ menu', 'Header, Floating layers', { rect: MAIN })
  await page.keyboard.press('Escape')
})

test('R-3 · palette, finder, keyboard shortcuts', async ({ run, launch }) => {
  test.skip(!REVIEW, 'a review set: pnpm gallery --review')
  test.setTimeout(180_000)
  const set = new GallerySet('R-3', 'Command palette, finder, Keyboard Shortcuts')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  await demoProject(kea, 'docs-site')
  await demoProject(kea, 'atlas-web')
  const a = await session(kea, 'r3-a', 'Fix auth redirect', WORKING)
  const b = await session(kea, 'r3-b', 'Add billing page')
  await status(kea, b, 'needsYou', ...permission('pnpm add stripe'))
  await selectSession(kea, a)
  const wt = await cwdOf(kea, a)
  write(wt, { 'app/renderer/src/features/files/changes.ts': 'export const a = 1\n', 'app/renderer/src/features/files/finder.ts': 'export const b = 2\n', 'app/renderer/src/features/sessions/model.ts': 'export const c = 3\n' })
  await waitTree(kea, 'listed', (rows) => rows.length > 0)

  await openPalette(kea)
  await page.mouse.move(1300, 800)
  await set.shot(kea, 'palette', 'The command palette (⇧⌘P): 560 px wide in the top third, one input, one list of 32 px rows, sections, keys right-aligned in 11 px chips', 'Floating layers')
  await page.keyboard.type('new')
  await pageDelay(kea, 150)
  await set.shot(kea, 'palette-typed', 'Typed: the matches, the first one current', 'Floating layers')
  await page.keyboard.press('Escape')

  await openPalette(kea, 'Meta+p')
  await page.keyboard.type('fi')
  await expect(page.locator('.finder-row').first()).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'finder', 'File mode (⌘P): a row is the file’s name and its folder cut in its middle, the matched letters marked', 'Floating layers, Typography')
  await page.keyboard.press('Escape')

  await runCommand(kea, 'app.shortcuts')
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'shortcuts', 'Keyboard Shortcuts: every command by category with its key now', 'Floating layers, Keyboard map')
  await page.keyboard.press('Escape')
})

const PAGES = ['general', 'terminal', 'agents', 'notifications', 'files', 'keyboard', 'projects', 'disk', 'advanced', 'about'] as const

async function settingsPages(kea: Kea, set: GallerySet, design: string): Promise<void> {
  const page = await kea.page()
  await page.keyboard.press('Meta+,')
  const sheet = page.getByRole('dialog', { name: /^Settings: / })
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  for (const id of PAGES) {
    await sheet.locator(`[role=tab][data-page="${id}"]`).click()
    await expect(sheet.locator(`[role=tabpanel][data-page="${id}"]`)).toBeVisible({ timeout: STEP_MS })
    await page.mouse.move(1380, 450)
    await pageDelay(kea, 200)
    await set.shot(kea, `settings-${id}`, `Settings › ${id}`, design)
  }
  await page.keyboard.press('Escape')
}

test('R-4 · settings pages', async ({ run, launch }) => {
  test.skip(!REVIEW, 'a review set: pnpm gallery --review')
  test.setTimeout(180_000)
  const set = new GallerySet('R-4', 'Settings, page by page')
  const kea = await openKea(run, launch)
  await demoProject(kea, 'atlas-web')
  const a = await session(kea, 'r4-a', 'Fix auth redirect', WORKING)
  await selectSession(kea, a)
  await settingsPages(kea, set, 'Floating layers, Settings')

  // the dev-only performance HUD: ticked in Settings › Advanced, a panel over the window's corner
  const page = await kea.page()
  await page.keyboard.press('Meta+,')
  const sheet = page.getByRole('dialog', { name: /^Settings: / })
  await sheet.locator('[role=tab][data-page="advanced"]').click()
  await sheet.getByRole('checkbox', { name: /performance HUD/ }).check()
  await page.keyboard.press('Escape')
  const hud = page.locator('[data-hud]')
  await expect(hud).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1300, 300)
  await pageDelay(kea, 1200)
  await set.shot(kea, 'hud', 'The performance HUD (development builds only): a floating panel on --surface-4 in the bottom-left corner', 'Diagnostics, Floating layers', { rect: { x: 0, y: 500, width: 760, height: 400 } })
  await hud.getByRole('button', { name: 'Read' }).click()
  await expect(hud.locator('[data-hud-report]')).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'hud-report', 'With the resource report read', 'Diagnostics, Resources', { rect: { x: 0, y: 300, width: 760, height: 600 } })
  await hud.getByRole('button', { name: 'Hide the performance HUD' }).click()
  await expect(hud).toHaveCount(0)
})

test('R-5 · the light theme', async ({ run, launch }) => {
  test.skip(!REVIEW, 'a review set: pnpm gallery --review')
  test.setTimeout(180_000)
  const set = new GallerySet('R-5', 'Under kea-light (the terminal theme; chrome keeps its colours)')
  const kea = await openKea(run, launch, { settings: { terminal: { fontFamily: 'SF Mono', fontSize: 13, theme: 'kea-light' } } })
  const page = await kea.page()
  const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
  await addProject(kea, root, 'atlas-web')
  const a = await session(kea, 'r5-a', 'Fix auth redirect', WORKING)
  await selectSession(kea, a)
  await waitTree(kea, 'listed', (rows) => rows.length > 0)
  const wt = await cwdOf(kea, a)
  write(wt, { 'src/hello.js': 'export function hello(name) {\n  // greet\n  return `Hello, ${name}!`\n}\n' })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'window', 'The window: the terminal on the light theme’s background, its padding included; the active tab stays on --surface-0', 'Colour, Terminal')
  await page.locator('.kea-terminal').first().click()
  await page.keyboard.press('Meta+f')
  await page.locator('.find-bar input').waitFor({ timeout: STEP_MS })
  await page.keyboard.type('Working')
  await set.shot(kea, 'find', 'The find bar over a light terminal', 'Terminal', { rect: { x: 504, y: 0, width: 936, height: 300 } })
  await page.keyboard.press('Escape')
  await page.locator('[role=tree][aria-label="Files"] [data-path="src"]').click()
  await page.locator('[role=tree][aria-label="Files"] [data-path="src/hello.js"]').click()
  await page.locator('.viewer').waitFor({ timeout: STEP_MS })
  await pageDelay(kea, 400)
  await set.shot(kea, 'viewer', 'A file tab under the light theme: the viewer is chrome and stays dark', 'File viewer, Colour')
  await settingsPages(kea, set, 'Floating layers')
})

test('R-6 · banner strip, setup strips, the reconnecting bar', async ({ run, launch }) => {
  test.skip(!REVIEW, 'a review set: pnpm gallery --review')
  test.setTimeout(240_000)
  const set = new GallerySet('R-6', 'Banner strip, setup strips, the reconnecting bar')
  // (the shell pseudo-agent: a session whose setup has not finished is not live yet, and the fake agent's start waits for that)
  const kea = await openKea(run, launch, { agent: false })
  const page = await kea.page()
  // a setup script that waits, then fails: its tab, the running strip with Skip, the failed strip with its two ways on
  const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
  const mode = path.join(run.home, 'setup-mode')
  fs.writeFileSync(mode, 'wait')
  commitFiles(root, { '.kea/setup.sh': `#!/bin/sh\necho "installing dependencies"\nwhile [ "$(cat '${mode}')" = wait ]; do /bin/sleep 0.2; done\necho "setup failed on purpose"\nexit 3\n` }, { executable: true })
  await addProject(kea, root, 'atlas-web')
  const id = await startSession(kea, 'Fix auth redirect', { open: false })
  await selectSession(kea, id)
  const running = page.getByRole('status').filter({ hasText: 'Setup is running' })
  await expect(running).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'setup-running', 'Setup runs first, in its tab: the strip says so, with Skip', 'Terminal, Setup script', { rect: { ...MAIN, height: 300 } })
  fs.writeFileSync(mode, 'fail')
  const failed = page.getByRole('status').filter({ hasText: /Setup failed/i })
  await expect(failed).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'setup-failed', 'Setup failed: Retry, and Start agent anyway', 'Terminal, Setup script', { rect: { ...MAIN, height: 300 } })

  // ── the banner strip: a settings file that does not parse ──
  const settings = path.join(run.home, 'settings.json')
  const good = fs.readFileSync(settings, 'utf8')
  fs.writeFileSync(settings, `${good.trimEnd().slice(0, -1)},\n  "terminal": { "fontSize": 900 }\n`)
  const banners = page.getByRole('region', { name: 'Banners' })
  await expect(banners.getByRole('status').first()).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'banner', 'The banner strip under the header: one 28 px line, a 5 px dot (--danger for an error), the message in --text-1, the fix in --text-3, one quiet action', 'Banner strip', { rect: { ...MAIN, height: 300 } })
  fs.writeFileSync(settings, good)
  await expect(banners.getByRole('status')).toHaveCount(0, { timeout: STEP_MS })

  // ── the reconnecting bar: core away longer than the delay; kept away by holding its lock, as C-KILL-24 ───────────
  const away = await kea.signal('core', 'SIGKILL')
  const lock = await until('core’s lock', () => tryLock(path.join(run.home, 'run', 'core.lock')) ?? undefined)
  try {
    const bar = page.locator('.reconnecting-bar')
    await bar.waitFor({ state: 'visible', timeout: STEP_MS })
    await set.shot(kea, 'reconnecting', 'Reconnecting…: a bar the size of the tab strip, laid over it; nothing moves', 'Terminal', { rect: { ...MAIN, height: 300 } })
  } finally {
    lock.dispose()
  }
  await kea.restarted('core', away)
  await page.locator('.reconnecting-bar').waitFor({ state: 'detached', timeout: STEP_MS })
})
