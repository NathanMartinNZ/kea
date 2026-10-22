// V-10 and V-14: the dialogs — the delete confirmation with its counts, the first-quit sheet, a toast — and the
// menu-bar item's menu with sessions that need you, the first-quit sheet over them, and a session whose agent waits for
// the trust question.

import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS, until } from '../../../tests/support/app.ts'
import { inMenuBar, menuBar, pressQuit, quitSheet } from '../../../tests/support/app-menubar.ts'
import { commitFiles } from '../../../tests/support/app-server.ts'
import { addProject, rowState, selectSession, sessionMenu, waitRow } from '../../../tests/support/app-sessions.ts'
import { commitAll } from '../../../tests/support/app-viewer.ts'
import { L } from '../../../packages/protocol/src/index.ts'
import { tinyRepo } from '../../repo-factory/src/index.ts'
import { cwdOf, demoProject, frame, openKea, permission, question, session, status, write } from './scene.ts'
import { GallerySet } from './shots.ts'

/** The main column: sheets attach to its top, toasts sit at its bottom right. */
const MAIN = { x: 504, y: 0, width: 936, height: 900 }
const SHEET = { x: 504, y: 0, width: 936, height: 360 }
const CORNER = { x: 904, y: 660, width: 536, height: 240 }
const ROWS = { x: 0, y: 0, width: 240, height: 300 }

/** A teardown script that fails: an archive or a delete completes anyway and says so. */
const TEARDOWN = '#!/bin/sh\necho "stopping the preview database"\necho "teardown failed on purpose"\nexit 3\n'

test('V-10 · dialogs', async ({ run, launch }) => {
  const set = new GallerySet('V-10', 'Dialogs')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
  commitFiles(root, { '.kea/teardown.sh': TEARDOWN }, { executable: true })
  await addProject(kea, root, 'atlas-web')

  // ── the delete confirmation: what would be lost, in exact numbers ──
  const fix = await session(kea, 'v10-fix', 'Fix auth redirect')
  const wt = await cwdOf(kea, fix)
  write(wt, { 'src/auth/login.js': 'export const login = () => "/signin"\n', 'src/auth/session.js': 'export const session = () => null\n' })
  commitAll(wt, 'Add the auth module')
  write(wt, { 'src/auth/callback.js': 'export const callback = () => "/"\n' })
  commitAll(wt, 'Handle the callback')
  write(wt, { 'README.md': '# Atlas\n\nA small service.\n', 'src/auth/token.js': 'export const token = () => "t"\n', 'notes.txt': 'check the deep link\n' })
  await selectSession(kea, fix)
  await sessionMenu(kea, fix, 'session.delete')
  const del = page.getByRole('alertdialog', { name: 'Delete session' })
  await expect(del.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'delete', 'Delete session: attached to the top of the main pane; what is lost and what stays restorable, in exact numbers; Cancel is the default and rests on --surface-2, Delete is --danger text, not filled', 'Floating layers', { rect: SHEET })
  await set.shot(kea, 'delete-window', 'The same sheet in its window: nothing else moves', 'Floating layers')
  await page.keyboard.press('Escape')
  await expect(del).toHaveCount(0)

  // ── a toast: a failure with no place of its own (a delete whose teardown failed leaves no row to say so) ──
  const cron = await session(kea, 'v10-cron', 'Remove the old cron')
  await waitRow(kea, cron, 'live', (r) => r.lifecycle === 'live')
  await sessionMenu(kea, cron, 'session.delete')
  await expect(del.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled({ timeout: STEP_MS })
  await del.getByRole('button', { name: 'Delete', exact: true }).click()
  await until('the row gone', async () => (await rowState(page, cron)) === null || undefined)
  const toast = page.getByRole('alert').filter({ hasText: 'The teardown of' })
  await expect(toast).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 300)
  await set.shot(kea, 'toast', 'A toast: bottom right, the message and one action (View log); only for a failure with no natural place in the window', 'Floating layers', { rect: CORNER })
  await set.shot(kea, 'toast-window', 'The toast in its window', 'Floating layers', { rect: MAIN })
  await toast.getByRole('button', { name: 'View log' }).click()
  const log = page.getByRole('dialog', { name: 'Session log' })
  await expect(log).toContainText('teardown failed on purpose', { timeout: STEP_MS })
  await set.shot(kea, 'log', 'The session log the toast opens: a sheet that confirms nothing (Close is its one button)', 'Floating layers', { rect: { ...MAIN, height: 520 } })
  await page.keyboard.press('Escape')

  // ── the first-quit sheet (once): one sentence and three buttons ──
  await selectSession(kea, fix)
  await pressQuit(kea)
  await expect(quitSheet(page)).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'first-quit', 'The first-quit sheet: Keep in Menu Bar is the default and the one filled accent button, Quit Completely is quiet, Stop All and Quit is --danger text', 'Menu-bar item', { rect: SHEET })
  await page.keyboard.press('Escape')
  await expect(quitSheet(page)).toHaveCount(0)
})

test('V-14 · menu-bar item, first-quit sheet, trust-pending row', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const set = new GallerySet('V-14', 'Menu-bar item, first-quit sheet, trust-pending row')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  await demoProject(kea, 'atlas-web')

  // an agent that waits for the trust question: no SessionStart within L.trustWindowMs in a project not yet trusted
  const trust = await session(
    kea,
    'v14-trust',
    'Update the changelog',
    `fireSessionStart: false
steps:
  - ${frame('Do you trust the files in this folder?', '', '❯ 1. Yes, proceed', '  2. No, exit')}
  - wait: { answer: "~" }
`,
  )
  const billing = await session(kea, 'v14-billing', 'Add billing page')
  const hooks = await session(kea, 'v14-hooks', 'Retry failed webhooks')
  await status(kea, billing, 'needsYou', ...permission('pnpm add stripe'))
  await status(kea, hooks, 'needsYou', ...question('Which queue should the retries use?'))
  await waitRow(kea, trust, 'the trust question', (r) => r.status === 'needsYou', L.trustWindowMs + STEP_MS)
  await selectSession(kea, trust)
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'trust-row', 'A session whose agent waits for the trust question: the needs-you dot and "question", like any other question', 'Sidebar', { rect: ROWS })
  await set.shot(kea, 'trust-window', 'The same session on screen: the agent’s own question is in its terminal', 'Sidebar, Terminal')

  // the first-quit sheet over sessions that need you
  await pressQuit(kea)
  await expect(quitSheet(page)).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'first-quit', 'The first-quit sheet with three sessions running', 'Menu-bar item', { rect: { x: 504, y: 0, width: 936, height: 360 } })

  // Keep in Menu Bar: the window goes, the menu-bar item stays. Its menu is a native NSMenu (Kea's tokens do not apply
  // and no page can be captured), so the page says what main put in it
  await quitSheet(page).getByRole('button', { name: 'Keep in Menu Bar' }).click()
  await inMenuBar(kea)
  const m = await menuBar(kea)
  const rows = (m.state?.sessions ?? []).map((s) => `${s.glyph === 'needsYou' ? '●' : s.glyph} ${s.title} — ${s.reason}`)
  set.note(`The menu-bar item (native NSMenu, not captured): the template icon followed by “${m.title ?? ''}”. Its menu, as main built it: ${rows.join(' · ')} · — · Open Kea · Quit Kea Completely.`)
  expect(rows.length, 'the three sessions that need you are in the menu').toBe(3)
})
