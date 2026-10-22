// V-15: an account condition — `limited` rows and the sidebar footer's line, before and at the reset — the
// report-wrong-status picker, a "teardown failed" row, "Copied by terminal", and Settings › Disk with Recently deleted
// (its own launch: a session not viewed for a week is a note made with Kea closed, as E-WT-2 makes it).

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS, until, type Kea, type KeaRun } from '../../../tests/support/app.ts'
import { fakeAgentTerminal } from '../../../tests/support/app-fake-agent.ts'
import { chooseMenuItem, waitMenuItem } from '../../../tests/support/app-palette.ts'
import { commitFiles } from '../../../tests/support/app-server.ts'
import { addProject, rowState, selectSession, sessionMenu, sessionRow, waitRow } from '../../../tests/support/app-sessions.ts'
import { commitAll } from '../../../tests/support/app-viewer.ts'
import { L } from '../../../packages/protocol/src/index.ts'
import { tinyRepo } from '../../repo-factory/src/index.ts'
import { cwdOf, demoProject, finished, limited, openKea, runCommand, session, status, write } from './scene.ts'
import { GallerySet } from './shots.ts'

type Page = Awaited<ReturnType<Kea['page']>>

const SIDEBAR = { x: 0, y: 0, width: 240, height: 900 }
const FOOTER = { x: 0, y: 760, width: 240, height: 140 }
const MAIN = { x: 504, y: 0, width: 936, height: 900 }
const TOP = { x: 504, y: 0, width: 936, height: 300 }

/** After an Archive: wait until `done`, pressing the archive sheet's own Archive if Kea asks first. */
async function archiveAnswered(page: Page, done: () => Promise<boolean>): Promise<void> {
  const ask = page.getByRole('alertdialog', { name: 'Archive session' })
  const asked = await until('the session archived, or the question', async () => ((await done()) ? 'done' : (await ask.isVisible()) ? 'asked' : undefined))
  if (asked === 'done') return
  await ask.getByRole('button', { name: 'Archive', exact: true }).click()
  await until('the session archived', async () => (await done()) || undefined)
}

test('V-15 · account condition, report wrong status, teardown failed, copied by terminal', async ({ run, launch }) => {
  test.setTimeout(180_000)
  const set = new GallerySet('V-15', 'Account condition, report wrong status, teardown failed, Copied by terminal')
  const kea = await openKea(run, launch, { settings: { terminal: { clipboardWrite: 'always' } } })
  const page = await kea.page()
  // (a new session goes to the project added last)
  await demoProject(kea, 'billing-api')
  const root = tinyRepo({ name: 'atlas-web', parent: run.home }).root
  commitFiles(root, { '.kea/teardown.sh': '#!/bin/sh\necho "teardown failed on purpose"\nexit 3\n' }, { executable: true })
  await addProject(kea, root, 'atlas-web')

  // ── a failed teardown: the archive completes anyway and the row says so ──
  const cron = await session(kea, 'v15-cron', 'Remove the old cron')
  await waitRow(kea, cron, 'live', (r) => r.lifecycle === 'live')
  await sessionMenu(kea, cron, 'session.archive')
  await archiveAnswered(page, async () => ((await rowState(page, cron))?.lifecycle ?? 'archived') === 'archived')
  const group = page.getByRole('treeitem', { name: 'Archived (1)' })
  await expect(group).toBeVisible({ timeout: STEP_MS })
  await group.click()
  await expect(sessionRow(page, cron)).toContainText('teardown failed', { timeout: STEP_MS })

  // ── a usage limit: the sessions it holds say `limited`, the footer says until when ──
  const rounding = await session(kea, 'v15-rounding', 'Invoice rounding')
  const refunds = await session(kea, 'v15-refunds', 'Refund partial payments')
  const readme = await session(kea, 'v15-readme', 'Update readme')
  await selectSession(kea, readme)
  await kea.pretendFocused(true)
  await status(kea, readme, 'idle', ...finished('Updated the readme.'))
  const later = Date.now() + 3 * 3_600_000
  await status(kea, rounding, 'limited', ...limited(later))
  await status(kea, refunds, 'limited', ...limited(later))
  await expect(page.locator('.condition-line')).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'limited', 'A usage limit: the sessions it holds show the slashed ring in --text-3 and "limited"; the footer has one 12 px --text-3 line led by a 5 px --warn dot, above the gear. An archived session whose teardown failed says "teardown failed" in its meta', 'Sidebar', { rect: SIDEBAR })
  await sessionRow(page, cron).hover()
  await set.shot(kea, 'teardown-failed', 'The "teardown failed" row under the pointer: Retry teardown and View log take the meta’s place', 'Sidebar', { rect: { x: 0, y: 0, width: 240, height: 300 } })
  await page.mouse.move(1000, 700)

  // the limited session on screen: the note under its terminal's header
  await selectSession(kea, rounding)
  await fakeAgentTerminal(kea, rounding)
  await set.shot(kea, 'limited-session', 'A limited session on screen', 'Sidebar, Terminal', { rect: MAIN })

  // ── report wrong status (⌥⌘J): the "Why this status?" popover with its picker ──
  await page.keyboard.press('Alt+Meta+j')
  const popover = page.locator('.session-popover')
  await expect(popover).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'report-status', 'Report Wrong Status (⌥⌘J): the header’s popover, --surface-4 with a 10 px radius, with the picker of what the status should have been', 'Floating layers', { rect: MAIN })
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)

  // ── Copied by terminal: a program wrote the clipboard (OSC 52; the page records the write, the clipboard is not touched) ──
  await page.evaluate(() => (window as unknown as { __keaProbe: { write(d: string): void } }).__keaProbe.write('\x1b]52;c;a2Vh\x07'))
  await expect(page.locator('.tab-note')).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'copied', '"Copied by terminal" at the tab strip’s right end, 11 px --text-3, for 2 s', 'Terminal', { rect: TOP })

  // ── at the reset: the line offers Continue all ──
  const soon = Date.now() + 2_000
  await status(kea, rounding, 'limited', ...limited(soon))
  await expect(page.getByRole('button', { name: 'Continue all' })).toBeVisible({ timeout: 30_000 })
  await page.mouse.move(1000, 400)
  await set.shot(kea, 'reset', 'At the reset time: the same line with a quiet Continue all', 'Sidebar', { rect: FOOTER })
  await set.shot(kea, 'reset-sidebar', 'The sidebar at the reset', 'Sidebar', { rect: SIDEBAR })
})

/** `bytes` of data in a file of a worktree. */
function fill(cwd: string, rel: string, bytes: number): void {
  const file = path.join(cwd, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61), { flush: true })
}

/** With Kea closed: note that a window last showed session `id` at `at` (core's `kv` row `disk:<sessionId>`, as E-WT-2). */
function lastShown(run: KeaRun, id: string, at: number): void {
  const db = new DatabaseSync(path.join(run.home, 'kea.db'))
  try {
    const key = `disk:${id}`
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    const mark = { rebuildableBytes: null, capped: false, prunedAt: null, ...(row ? (JSON.parse(row.value) as object) : {}), viewedAt: at }
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(mark))
  } finally {
    db.close()
  }
}

test('V-15 · Settings › Disk with Recently deleted', async ({ run, launch }) => {
  test.setTimeout(240_000)
  const set = new GallerySet('V-15b', 'Settings › Disk')
  const first = await openKea(run, launch)
  await demoProject(first, 'atlas-web')
  const big = await session(first, 'v15-big', 'Fix auth redirect')
  const mid = await session(first, 'v15-mid', 'Add billing page')
  const old = await session(first, 'v15-old', 'Refactor api client')
  const stale = await session(first, 'v15-stale', 'Seo pass')
  const gone = await session(first, 'v15-gone', 'Find broken links')
  const cwd = { big: await cwdOf(first, big), mid: await cwdOf(first, mid), old: await cwdOf(first, old), stale: await cwdOf(first, stale), gone: await cwdOf(first, gone) }
  // `node_modules` is ignored by the repository (rebuildable); one session has a commit of its own
  for (const dir of Object.values(cwd)) write(dir, { '.gitignore': 'node_modules\n' })
  fill(cwd.big, 'node_modules/pkg/blob.bin', 6_000_000)
  fill(cwd.big, 'notes/plan.txt', 300_000)
  fill(cwd.mid, 'node_modules/pkg/blob.bin', 2_000_000)
  fill(cwd.mid, 'build.log', 1_000_000)
  fill(cwd.old, 'node_modules/pkg/blob.bin', 1_000_000)
  fill(cwd.stale, 'src/big.txt', 500_000)
  commitAll(cwd.stale, 'Rewrite the titles')
  fill(cwd.gone, 'report.txt', 200_000)
  const page1 = await first.page()
  await sessionMenu(first, old, 'session.archive')
  await archiveAnswered(page1, async () => ((await rowState(page1, old))?.lifecycle ?? 'archived') === 'archived')
  await selectSession(first, big)
  await first.close()
  lastShown(run, stale, Date.now() - (L.diskStaleDays + 1) * 86_400_000)

  const kea = await openKea(run, launch)
  const page = await kea.page()
  await waitRow(kea, big, 'listed again', (r) => r.lifecycle === 'live')
  await waitMenuItem(kea, 'app.showDisk', 'enabled', (m) => m.enabled)
  expect(await chooseMenuItem(kea, 'app.showDisk')).toBe(true)
  const sheet = () => page.getByRole('dialog', { name: 'Settings: Disk', exact: true })
  await expect(sheet()).toBeVisible({ timeout: STEP_MS })
  const row = (id: string) => page.locator(`[data-disk-row="${id}"]`)
  await expect(row(big).locator('[data-disk-size]')).toContainText('rebuildable', { timeout: STEP_MS })
  await expect(row(stale).locator('[data-disk-branch]')).toContainText('not merged', { timeout: STEP_MS })
  await expect(row(mid).locator('[data-disk-branch]')).toContainText('uncommitted', { timeout: STEP_MS })

  // one session deleted from the view: it is under Recently deleted, with Restore
  await row(gone).getByRole('checkbox').check()
  const selection = () => sheet().getByRole('group', { name: 'The selected sessions' })
  await selection().getByRole('button', { name: 'Archive', exact: true }).click()
  await archiveAnswered(page, async () => ((await row(gone).textContent().catch(() => '')) ?? '').includes('archived'))
  await expect(sheet()).toBeVisible({ timeout: STEP_MS })
  await selection().getByRole('button', { name: 'Delete…' }).click()
  const del = page.getByRole('alertdialog', { name: 'Delete session' })
  await expect(del.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled({ timeout: STEP_MS })
  await del.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(sheet()).toBeVisible({ timeout: STEP_MS })
  await expect(sheet().locator(`[data-disk-deleted="${gone}"]`)).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1300, 880)
  await set.shot(kea, 'disk', 'Settings › Disk: the total; the worktrees largest first with size, rebuildable share, last activity, lifecycle and branch state; All / Stale; a row’s actions; Recently deleted with Restore', 'Floating layers, Settings')

  await row(big).getByRole('checkbox').check()
  await row(mid).getByRole('checkbox').check()
  await set.shot(kea, 'disk-selected', 'Two rows selected: the selection’s actions above the list', 'Floating layers, Settings')
  await row(big).getByRole('checkbox').uncheck()
  await row(mid).getByRole('checkbox').uncheck()

  await sheet().getByRole('button', { name: /^Stale \(/ }).click()
  await expect(row(big)).toHaveCount(0)
  await set.shot(kea, 'disk-stale', 'Stale: only the session no window showed for a week, with what its branch still holds', 'Floating layers, Settings')
  await sheet().getByRole('button', { name: /^All \(/ }).click()

  // the keyboard on a row's action: the focus ring
  await row(big).getByRole('checkbox').focus()
  await page.keyboard.press('ArrowRight')
  await set.shot(kea, 'disk-focus', 'The keyboard in the grid: one tab stop, ← → between a row’s controls, the 2 px focus ring', 'Accessibility, Settings')
  await page.keyboard.press('Escape')
  await expect(sheet()).toHaveCount(0)

  // Remove Build Folders… from the palette, the menu bar or a key asks first: what would go, and that it cannot be undone
  await runCommand(kea, 'session.removeBuildFolders', { id: big })
  const ask = page.getByRole('alertdialog', { name: 'Remove build folders' })
  await expect(ask.locator('[data-build-folders]')).toBeVisible({ timeout: STEP_MS })
  await page.mouse.move(1300, 880)
  await set.shot(kea, 'remove-build-folders', 'Remove Build Folders… run from the palette: a confirmation sheet with the folders and their size; Cancel is the default, Remove in --danger text', 'Floating layers', { rect: { x: 504, y: 0, width: 936, height: 300 } })
  await page.keyboard.press('Escape')
  await expect(ask).toHaveCount(0)
})
