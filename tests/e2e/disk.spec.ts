// Disk usage and diagnostics: Settings › Disk over real worktrees, and Copy diagnostics. Kea runs through
// tests/e2e/fixtures.ts (unfocused, a temp KEA_HOME, hermetic git) with tools/fake-agent as Claude Code; the real CLI
// is never run. The test writes what no click can set up: the worktrees' files, a commit on a session's branch and,
// with Kea closed, when a session was last shown or archived (days ago: nobody waits a week in a test). Sizes on screen
// are compared with the disk, measured by the view's own rule. The clipboard is the page's recorder
// (tests/support/app-server.ts), never the user's.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { formatBytes, KEA_HOME_MARK, L, outsidePaths, platformLineText, scrubPaths, SETTINGS, type PlatformReport } from '@kea/protocol'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import type { Locator, Page } from '@playwright/test'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { harnessUserHome } from '../../tools/perf/src/launch.ts'
import { shq, STEP_MS, until, type Kea, type KeaRun } from '../support/app.ts'
import { agentEvents, claudeByDefault, startFakeSession } from '../support/app-fake-agent.ts'
import { chooseMenuItem, waitMenuItem } from '../support/app-palette.ts'
import { clipboard, commitFiles, recordClipboard } from '../support/app-server.ts'
import { addProject, demoRepo, rowState, selectSession, sessionMenu, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

/** An agent that draws its prompt and waits: the session stays live and writes nothing. */
const IDLE = `steps:
  - frame: ["✻ fake-agent", "", "> "]
  - wait: { answer: z }
`

/**
 * A folder's size as the Disk view counts it: the allocated blocks of everything in it, links not followed,
 * nothing deduplicated.
 */
function allocated(p: string): number {
  const st = fs.lstatSync(p)
  let n = st.blocks * 512
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) n += allocated(path.join(p, name))
  return n
}

/** `bytes` of data in a file of the worktree, on disk when this returns. */
function fill(cwd: string, rel: string, bytes: number): void {
  const file = path.join(cwd, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61), { flush: true })
}

/** A session with the idle fake agent; resolves with its id and its worktree. */
async function session(kea: Kea, name: string): Promise<{ id: string; cwd: string; title: string }> {
  const s = await startFakeSession(kea, name, name, IDLE, { background: true })
  const cwd = String(agentEvents(s.log).find((e) => e.t === 'start')?.cwd)
  expect(fs.existsSync(path.join(cwd, 'src', 'math.js')), `${name}: a worktree of the demo repository`).toBe(true)
  const title = (await waitRow(kea, s.id, 'listed', () => true)).title
  return { id: s.id, cwd, title }
}

/**
 * With Kea closed: note that a window last showed session `id` at `at` (core's `kv` row `disk:<sessionId>`, what it
 * writes each time a session leaves the screen).
 */
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

/**
 * After an Archive: wait until `done`, pressing the archive sheet's own Archive if Kea asks first, as it does for an
 * agent the status engine still takes for busy.
 */
async function archiveAnswered(page: Page, done: () => Promise<boolean>): Promise<void> {
  const ask = page.getByRole('alertdialog', { name: 'Archive session' })
  const asked = await until('the session archived, or the question', async () => ((await done()) ? 'done' : (await ask.isVisible()) ? 'asked' : undefined))
  if (asked === 'done') return
  await ask.getByRole('button', { name: 'Archive', exact: true }).click()
  await until('the session archived', async () => (await done()) || undefined)
}

const settings = (page: Page, section: string): Locator => page.getByRole('dialog', { name: `Settings: ${section}`, exact: true })
const diskRow = (page: Page, id: string): Locator => page.locator(`[data-disk-row="${id}"]`)
const rowIds = (page: Page): Promise<string[]> => page.locator('[data-disk-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-disk-row') ?? ''))
const focusedRow = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.closest('[data-disk-row]')?.getAttribute('data-disk-row') ?? null)

/** What a row says of its size: `4.2 MB · 1.0 MB rebuildable`. */
function sizeOf(cwd: string): string {
  const rebuildable = fs.existsSync(path.join(cwd, 'node_modules')) ? allocated(path.join(cwd, 'node_modules')) : 0
  return `${formatBytes(allocated(cwd))} · ${rebuildable ? `${formatBytes(rebuildable)} rebuildable` : 'nothing rebuildable'}`
}

test('E-WT-5 · Remove Build Folders… from the menu bar asks first: the sheet names the session, the folders that would go and the one kept because it holds a git repository, and says it cannot be undone; Cancel is the default and leaves everything; Remove takes the folders and keeps the repository; from a row of Settings › Disk it acts at once and the row says what was kept', async ({ run, launch }) => {
  test.setTimeout(180_000)
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, demoRepo(run).root)
  const a = await session(kea, 'e-wt-5')
  await selectSession(kea, a.id)
  // `node_modules` is ignored at any depth: one that can be rebuilt, and one that holds a dependency cloned and patched
  // there, with a commit that exists nowhere else
  const blob = path.join(a.cwd, 'node_modules/pkg/blob.bin')
  const patched = path.join(a.cwd, 'tools/node_modules/patched')
  fill(a.cwd, 'node_modules/pkg/blob.bin', 2_000_000)
  fs.mkdirSync(patched, { recursive: true })
  gitIn(patched, 'init', '-q')
  fs.writeFileSync(path.join(patched, 'fix.js'), 'export const fixed = true\n')
  gitIn(patched, 'add', '-A')
  gitIn(patched, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'a local fix')
  const commit = gitIn(patched, 'rev-parse', 'HEAD').trim()
  const kept = () => expect(gitIn(patched, 'rev-parse', 'HEAD').trim(), 'the patched dependency and its commit').toBe(commit)

  // ── from the menu bar: a question first, the safe button the default ──
  await waitMenuItem(kea, 'session.removeBuildFolders', 'enabled, and it says it asks', (m) => m.enabled && m.label === 'Remove Build Folders…')
  expect(await chooseMenuItem(kea, 'session.removeBuildFolders')).toBe(true)
  const ask = page.getByRole('alertdialog', { name: 'Remove build folders' })
  await expect(ask).toContainText(`Remove the build folders of ${a.title}?`, { timeout: STEP_MS })
  await expect(ask.locator('[data-build-folders]')).toHaveText('1 folder: node_modules', { timeout: STEP_MS })
  await expect(ask.locator('[data-build-kept]')).toHaveText('1 folder kept: it holds a git repository (tools/node_modules)')
  await expect(ask).toContainText('Setup re-creates them. This cannot be undone')
  expect(await page.evaluate(() => document.activeElement?.textContent), 'the safe button has the keyboard').toBe('Cancel')
  expect(fs.existsSync(blob), 'nothing went while it asks').toBe(true)
  await page.keyboard.press('Enter')
  await expect(ask).toHaveCount(0)
  expect(fs.existsSync(blob), 'cancelled: nothing went').toBe(true)
  // asked again, and answered Remove
  expect(await chooseMenuItem(kea, 'session.removeBuildFolders')).toBe(true)
  await expect(ask.locator('[data-build-folders]')).toHaveText('1 folder: node_modules', { timeout: STEP_MS })
  await ask.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(ask).toHaveCount(0)
  await until('node_modules removed', () => !fs.existsSync(path.join(a.cwd, 'node_modules')) || undefined)
  kept()

  // ── from a row of Settings › Disk: at once, and the row says what stayed ──────────
  fill(a.cwd, 'node_modules/pkg/blob.bin', 2_000_000)
  expect(await chooseMenuItem(kea, 'app.showDisk')).toBe(true)
  const sheet = settings(page, 'Disk')
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  // (the worktree was measured after the removal, within the hour: Refresh measures it as it is now)
  await sheet.getByRole('button', { name: 'Refresh' }).click()
  // what holds a repository is not counted as rebuildable
  const size = diskRow(page, a.id).locator('[data-disk-size]')
  await expect(size).toHaveText(`${formatBytes(allocated(a.cwd))} · ${formatBytes(allocated(path.join(a.cwd, 'node_modules')))} rebuildable`, { timeout: STEP_MS })
  await diskRow(page, a.id).getByRole('button', { name: /^Remove build folders/ }).click()
  await until('node_modules removed again', () => !fs.existsSync(path.join(a.cwd, 'node_modules')) || undefined)
  await expect(diskRow(page, a.id).locator('[data-disk-kept]')).toHaveText('1 folder kept: it holds a git repository', { timeout: STEP_MS })
  await expect(size).toHaveText(`${formatBytes(allocated(a.cwd))} · nothing rebuildable`, { timeout: STEP_MS })
  kept()
  expect(await page.getByRole('alertdialog').count(), 'no question from the Disk view').toBe(0)
  await page.keyboard.press('Escape')
})

test('E-WT-2 · Settings › Disk with four sessions, one archived and one not viewed for eight days with an unmerged commit: the worktrees are listed largest first with their sizes as they are on disk, the rebuildable share and the total; Stale lists the unviewed one and says its branch is not merged; Remove build folders, reached with the keyboard, removes the ignored node_modules and leaves an untracked notes folder, and the size and the total follow; a session archived and deleted from the view is under Recently deleted, and Restore brings it back', async ({ run, launch }) => {
  test.setTimeout(240_000)
  claudeByDefault(run)
  const first = await launch()
  await addProject(first, demoRepo(run).root)
  const big = await session(first, 'e-wt-2-big')
  const mid = await session(first, 'e-wt-2-mid')
  const old = await session(first, 'e-wt-2-old')
  const stale = await session(first, 'e-wt-2-stale')
  // what the worktrees hold: `node_modules` is ignored by the repository (rebuildable); `notes/` is untracked and not
  // ignored; one session has a commit of its own
  fill(big.cwd, 'node_modules/pkg/blob.bin', 6_000_000)
  fill(big.cwd, 'notes/plan.txt', 300_000)
  fill(mid.cwd, 'node_modules/pkg/blob.bin', 2_000_000)
  fill(mid.cwd, 'build.log', 1_000_000)
  fill(old.cwd, 'node_modules/pkg/blob.bin', 1_000_000)
  fill(stale.cwd, 'src/big.txt', 500_000)
  gitIn(stale.cwd, 'add', 'src/big.txt')
  gitIn(stale.cwd, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'work of its own')
  // one session is archived (an idle agent is nothing to ask about); the window ends on `big`, so `stale` is not the
  // one it shows again
  await sessionMenu(first, old.id, 'session.archive')
  // (an archived session's row is in its project's Archived group, which is closed: the row leaves the list)
  await archiveAnswered(await first.page(), async () => ((await rowState(await first.page(), old.id))?.lifecycle ?? 'archived') === 'archived')
  await selectSession(first, big.id)
  await first.close()
  lastShown(run, stale.id, Date.now() - (L.diskStaleDays + 1) * 86_400_000)

  const kea = await launch()
  const page = await kea.page()
  await waitRow(kea, big.id, 'listed again', (r) => r.lifecycle === 'live')
  await recordClipboard(page)

  // ── the view: `app.showDisk` opens Settings on its Disk page ──
  await waitMenuItem(kea, 'app.showDisk', 'enabled', (m) => m.enabled)
  expect(await chooseMenuItem(kea, 'app.showDisk')).toBe(true)
  const sheet = settings(page, 'Disk')
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  const all = [big, mid, old, stale]
  const size = (s: { id: string }) => diskRow(page, s.id).locator('[data-disk-size]')
  for (const s of all) await expect(size(s), `${s.title}: its size as it is on disk`).toHaveText(sizeOf(s.cwd), { timeout: STEP_MS })
  // largest first
  expect(await rowIds(page)).toEqual(all.map((s) => s.id))
  const total = () => `${formatBytes(all.reduce((n, s) => n + allocated(s.cwd), 0))} in 4 worktrees · ${formatBytes(all.reduce((n, s) => n + (fs.existsSync(path.join(s.cwd, 'node_modules')) ? allocated(path.join(s.cwd, 'node_modules')) : 0), 0))} rebuildable`
  await expect(sheet.locator('[data-disk-total]')).toHaveText(total())
  await expect(sheet.getByText('Sizes are upper bounds', { exact: false }), 'the view says what a size is').toBeVisible()
  // each row: its lifecycle and its branch state, asked of git as the row comes on screen
  await expect(diskRow(page, old.id)).toContainText('archived')
  await expect(diskRow(page, big.id)).toContainText('running')
  await expect(diskRow(page, big.id).locator('[data-disk-branch]')).toHaveText('1 uncommitted file · nothing unpushed · no commits of its own', { timeout: STEP_MS })
  await expect(diskRow(page, stale.id).locator('[data-disk-branch]')).toHaveText('nothing uncommitted · 1 unpushed commit · not merged', { timeout: STEP_MS })

  // ── Stale: the session no window showed for eight days, unmerged work and all ──
  await sheet.getByRole('button', { name: 'Stale (1)' }).click()
  expect(await rowIds(page)).toEqual([stale.id])
  await expect(diskRow(page, stale.id)).toContainText('not merged')
  await expect(sheet.locator('[data-disk-total]'), 'the total is of every worktree, whatever the filter').toHaveText(total())
  await sheet.getByRole('button', { name: 'All (4)' }).click()
  expect(await rowIds(page)).toEqual(all.map((s) => s.id))

  // ── Remove build folders, with the keyboard: the list is a grid with one tab stop ──
  await diskRow(page, big.id).getByRole('checkbox').focus()
  await page.keyboard.press('ArrowDown')
  expect(await focusedRow(page)).toBe(mid.id)
  await page.keyboard.press('ArrowUp')
  expect(await focusedRow(page)).toBe(big.id)
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Remove build folders')
  await page.keyboard.press('Enter')
  // Only the ignored folder goes; the size and the total follow
  await until('node_modules of the session removed', () => !fs.existsSync(path.join(big.cwd, 'node_modules')) || undefined)
  expect(fs.readFileSync(path.join(big.cwd, 'notes/plan.txt')).length, 'the untracked notes are untouched').toBe(300_000)
  expect(gitIn(big.cwd, 'status', '--porcelain', '-uall').trim()).toBe('?? notes/plan.txt')
  await expect(size(big)).toHaveText(sizeOf(big.cwd), { timeout: STEP_MS })
  expect(sizeOf(big.cwd)).toContain('nothing rebuildable')
  await expect(sheet.locator('[data-disk-total]')).toHaveText(total())
  // sorted again: with its notes alone it is now the smallest
  await until('the rows in their new order', async () => JSON.stringify(await rowIds(page)) === JSON.stringify([mid.id, old.id, stale.id, big.id]) || undefined)
  // nothing is left to remove: the action says so, and the keyboard is still on it, in the row, wherever the row went
  await expect(diskRow(page, big.id).getByRole('button', { name: /^Remove build folders/ }), 'nothing left to remove').toHaveAttribute('aria-disabled', 'true')
  expect(await focusedRow(page)).toBe(big.id)
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Remove build folders')
  // the other worktrees were not touched
  for (const s of [mid, old]) expect(fs.existsSync(path.join(s.cwd, 'node_modules/pkg/blob.bin')), s.title).toBe(true)

  // ── a selection: Archive, then Delete… with the normal confirmation; the view comes back each time ──
  await diskRow(page, mid.id).getByRole('checkbox').check()
  await expect(sheet.getByText('1 selected')).toBeVisible()
  const selection = sheet.getByRole('group', { name: 'The selected sessions' })
  await selection.getByRole('button', { name: 'Archive', exact: true }).click()
  // (when the archive asks first, its sheet stands in Settings' place, and the view comes back when it closes)
  await archiveAnswered(page, async () => ((await diskRow(page, mid.id).textContent().catch(() => '')) ?? '').includes('archived'))
  await expect(settings(page, 'Disk')).toBeVisible({ timeout: STEP_MS })
  await expect(diskRow(page, mid.id).getByRole('checkbox'), 'still selected').toBeChecked()
  await settings(page, 'Disk').getByRole('group', { name: 'The selected sessions' }).getByRole('button', { name: 'Delete…' }).click()
  const del = page.getByRole('alertdialog', { name: 'Delete session' })
  await expect(del).toContainText(`Delete ${mid.title}?`, { timeout: STEP_MS })
  await del.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(settings(page, 'Disk'), 'the view is back once the confirmation closed').toBeVisible({ timeout: STEP_MS })
  await until('the deleted session’s row gone', async () => !(await rowIds(page)).includes(mid.id) || undefined)
  // (the row leaves as the delete begins; the folder goes a moment later)
  await until('its worktree gone', () => !fs.existsSync(mid.cwd) || undefined)

  // ── Recently deleted: Restore brings it back, worktree and row ───────────
  const gone = settings(page, 'Disk').locator(`[data-disk-deleted="${mid.id}"]`)
  await expect(gone).toContainText(mid.title, { timeout: STEP_MS })
  await gone.getByRole('button', { name: `Restore ${mid.title}` }).click()
  await until('the restored session’s row', async () => (await rowIds(page)).includes(mid.id) || undefined)
  await expect(settings(page, 'Disk').locator('[data-disk-deleted="none"]')).toBeVisible({ timeout: STEP_MS })
  expect(fs.existsSync(path.join(mid.cwd, 'build.log')), 'its uncommitted file is back').toBe(true)
  await expect(size(mid)).toHaveText(sizeOf(mid.cwd), { timeout: STEP_MS })

  expect(await clipboard(page), 'nothing here copies').toEqual([])
  // the row the keyboard was on went with the restore: the keyboard is still in the sheet, so Esc closes it
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /^Settings: / })).toHaveCount(0)
  await kea.assertUnfocused()
})

test('E-DIAG-1 · Copy diagnostics from the menu bar puts versions, the platform report, the agent CLIs, sessions as counts, the holders, recent errors of every process and the resource report on the clipboard, with nothing a terminal showed and no path outside Kea’s folder; with “Include file paths” ticked in Settings › Advanced the paths are there; a console error of the window reaches renderer.log and the next copy; the performance HUD shows while its box is ticked and runs nothing once it is hidden', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  const page = await kea.page()
  await recordClipboard(page)
  const SECRET = 'TOPSECRET-e-diag-1'
  await kea.enter(`echo ${SECRET.slice(0, 9)}-$((1))$((0))-${SECRET.slice(10)} && printf '\\033]0;${SECRET}\\007'`)
  await kea.waitScreen('the terminal shows the secret', (s) => s.includes(SECRET.slice(0, 9)))

  // ── from the menu bar, with nothing ticked ──
  // Help's item: macOS also has one in the app menu, Linux has it in Help only
  await waitMenuItem(kea, 'help:app.copyDiagnostics', 'enabled', (m) => m.enabled)
  expect(await chooseMenuItem(kea, 'help:app.copyDiagnostics')).toBe(true)
  const copied = async (n: number): Promise<string> => until(`copy ${n}`, async () => (await clipboard(page))[n - 1])
  const plain = await copied(1)
  for (const heading of ['# Kea diagnostics', '## Kea', '## Platform', '## Agent CLIs', '## Sessions', '## Holders', '## Banners', '## Recent errors', '## Resources']) expect(plain.split('\n'), heading).toContain(heading)
  // The platform report main sent core, line by line, right after the Kea section
  const report = (await kea.app.evaluate(() => (globalThis as unknown as { __keaTest: { platformReport(): Promise<unknown> } }).__keaTest.platformReport())) as PlatformReport
  const all = plain.split('\n')
  const at = all.indexOf('## Platform')
  // as the copy scrubs them: a line that names a system folder (Linux's `/proc`) says `<path>` there
  const scrub = (line: string): string => scrubPaths(line, { home: run.home })
  expect(all.slice(at + 1, at + 2 + report.lines.length)).toEqual([`${report.version} · ${report.arch}`, ...report.lines.map(platformLineText)].map(scrub))
  expect(all[at - 1]).toBe('')
  expect(all.indexOf('## Kea')).toBeLessThan(at)
  expect(plain).toContain(`file paths: left out (${KEA_HOME_MARK} is Kea’s own folder, <path> any other path)`)
  expect(plain).toContain(`home ${KEA_HOME_MARK}`)
  expect(plain).toMatch(/^1 holder, 0 orphaned$/m)
  // the resource report: every process's rows, this feature's among them, as names and numbers
  for (const row of [/^main:$/m, /^core:$/m, /^ptyhost:$/m, /^renderer[^\n]*:$/m, /^ {2}core\.disk {2}rows=0 /m, /^ {2}renderer\.hudTimers {2}0$/m, /^ {2}renderer\.diagnosticsAsks {2}\d+$/m]) expect(plain).toMatch(row)
  // nothing a terminal showed or was titled, and no path outside Kea's own folder
  expect(plain).not.toContain('TOPSECRET')
  expect(plain).not.toContain(run.home)
  expect(outsidePaths(plain)).toEqual([])

  // ── the window's own errors are its log, and the next copy has them ──
  await page.evaluate(() => console.error('e-diag-1: the window said so'))
  const rendererLog = path.join(run.home, 'logs', 'renderer.log')
  await until('the line in renderer.log', () => (fs.existsSync(rendererLog) && fs.readFileSync(rendererLog, 'utf8').includes('e-diag-1: the window said so')) || undefined)

  // ── Settings › Advanced: the tick box, the button and what it says it did ──
  await page.keyboard.press(sysKey('Meta+,'))
  await page.getByRole('dialog', { name: /^Settings: / }).getByRole('tab', { name: 'Advanced', exact: true }).click()
  const advanced = page.getByRole('dialog', { name: 'Settings: Advanced', exact: true })
  await advanced.getByRole('checkbox', { name: 'Include file paths' }).check()
  // pressed by key: the button keeps the keyboard while the copy is made and after it (a button that disabled itself
  // meanwhile would drop it, and Esc would then no longer close the sheet)
  const copy = advanced.getByRole('button', { name: 'Copy diagnostics' })
  await copy.focus()
  await page.keyboard.press('Enter')
  const withPaths = await copied(2)
  expect(withPaths).toContain('file paths: included')
  expect(withPaths).toContain(`home ${run.home}`)
  expect(withPaths).toMatch(/renderer error e-diag-1: the window said so/)
  expect(withPaths).not.toContain('TOPSECRET')
  await expect(advanced.locator('[data-diagnostics="copied"]')).toContainText('file paths included')
  expect(await clipboard(page)).toHaveLength(2)
  expect(await copy.evaluate((e) => e === document.activeElement), 'the keyboard is still on the button').toBe(true)

  // ── the performance HUD (a development build has it): numbers while shown, nothing running once hidden ──
  const resources = (): Promise<Record<string, number>> => page.evaluate(() => (window as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources())
  expect((await resources())['renderer.hudTimers']).toBe(0)
  await advanced.getByRole('checkbox', { name: 'Show the performance HUD' }).check()
  const hud = page.locator('[data-hud]')
  await expect(hud).toBeVisible({ timeout: STEP_MS })
  await expect(hud.locator('[data-hud-frames]')).toContainText(/\d+\.\d ms \(\d+ fps\), longest/, { timeout: STEP_MS })
  await expect(hud.locator('[data-hud-calls]')).toContainText('stores followed')
  await expect(hud.locator('[data-hud-bytes]')).toContainText('B/s')
  expect((await resources())['renderer.hudTimers']).toBe(2)
  // pressed by key: "Read" keeps the keyboard while every process is asked and after it, as "Read again" (a button that
  // disabled itself meanwhile would drop it)
  const read = hud.getByRole('button', { name: 'Read', exact: true })
  await read.focus()
  await page.keyboard.press('Enter')
  await expect(hud.locator('[data-hud-report]')).toContainText('renderer.hudTimers  2', { timeout: STEP_MS })
  const again = hud.getByRole('button', { name: 'Read again', exact: true })
  await expect(again, 'pressable again').not.toHaveAttribute('aria-disabled', 'true')
  expect(await again.evaluate((e) => e === document.activeElement), 'the keyboard is still on the button').toBe(true)
  await hud.getByRole('button', { name: 'Hide the performance HUD' }).click()
  await expect(hud).toHaveCount(0)
  expect((await resources())['renderer.hudTimers']).toBe(0)
  await expect(advanced.getByRole('checkbox', { name: 'Show the performance HUD' })).not.toBeChecked()
  await kea.assertUnfocused()
})

// ── the disk's whole round on a Command Code session ──

/** tools/fake-agent as Command Code's `cmd` running `scenario`, with an event log of its own (its files under the run's HOME). */
function fakeCommandCode(run: KeaRun, name: string, scenario: string): { log: string } {
  const file = path.join(run.home, `${name}.yaml`)
  fs.writeFileSync(file, `version: 1\nname: ${name}\n${scenario.trimEnd()}\n`)
  const log = path.join(run.home, `${name}.log`)
  writeAgentShim(run.agentBin, 'commandcode', { env: { FAKE_AGENT_HOME: harnessUserHome(run.home), FAKE_AGENT_SCENARIO: file, FAKE_AGENT_LOG: log } })
  return { log }
}

/**
 * With Kea closed: the session was archived at `at` (the pruning of its build folders counts from
 * `sessions.archived_at`; nobody waits a week in a test).
 */
function archivedAt(run: KeaRun, id: string, at: number): void {
  const db = new DatabaseSync(path.join(run.home, 'kea.db'))
  try {
    const done = db.prepare("UPDATE sessions SET archived_at = ? WHERE id = ? AND lifecycle = 'archived'").run(at, id)
    expect(done.changes, 'the archived session’s row').toBe(1)
  } finally {
    db.close()
  }
}

type Start = { t: string; argv: string[]; cwd: string; sessionId: string }
const startsOf = (log: string): Start[] => (agentEvents(log) as unknown as Start[]).filter((e) => e.t === 'start')

test('E-WT-6 · a Command Code session through the disk’s whole round: its worktree is measured in Settings › Disk with its rebuildable share; archived, and the archive a day past general.pruneArchivedBuildDirsDays at the next launch, its build folders are gone and its untracked notes are not; unarchived, setup runs again and brings them back, and Resume continues the same conversation with Kea’s mod; deleted from the view it is under Recently deleted, and Restore brings the worktree, the notes and (setup again) the build folders back, and Resume continues it once more', async ({ run, launch }) => {
  test.setTimeout(240_000)
  claudeByDefault(run)
  const marks = path.join(run.home, 'e-wt-6-setup.txt')
  const repo = demoRepo(run)
  // setup says why it ran and makes the build folder (ignored by the repository: rebuildable)
  commitFiles(repo.root, { '.kea/setup.sh': `#!/bin/sh\necho "$KEA_SETUP_REASON" >> ${shq(marks)}\nmkdir -p node_modules/dep\nhead -c 400000 /dev/zero > node_modules/dep/blob.bin\n` }, { executable: true })
  const cmd = fakeCommandCode(run, 'e-wt-6', IDLE)
  const setups = (): string => (fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8') : '')
  let kea = await launch()
  let page = await kea.page()
  await recordClipboard(page)
  await addProject(kea, repo.root)

  // ── a Command Code session, chosen in the composer; setup runs, then the agent ──
  const box = page.getByRole('region', { name: 'New session' })
  await box.getByRole('button', { name: /^Agent: / }).click()
  await page.getByRole('menu', { name: 'Agent' }).locator('[role=menuitem]').filter({ hasText: 'Command Code' }).click({ timeout: STEP_MS })
  await expect(box.getByRole('button', { name: 'Agent: Command Code' })).toBeVisible()
  const id = await startSession(kea, 'e-wt-6 round', { open: false })
  await waitLive(kea, id)
  const first = await until('Command Code started', () => startsOf(cmd.log)[0])
  const { cwd, sessionId: conversation } = first
  expect(first.argv).toEqual(expect.arrayContaining(['--mod', '--trust']))
  expect(setups()).toBe('create\n')
  fill(cwd, 'notes/keep.txt', 200_000)
  const title = (await waitRow(kea, id, 'listed', () => true)).title

  // ── measured ─────────────────
  const openDisk = async (): Promise<Locator> => {
    await waitMenuItem(kea, 'app.showDisk', 'enabled', (m) => m.enabled)
    expect(await chooseMenuItem(kea, 'app.showDisk')).toBe(true)
    await expect(settings(page, 'Disk')).toBeVisible({ timeout: STEP_MS })
    return settings(page, 'Disk')
  }
  const size = (): Locator => diskRow(page, id).locator('[data-disk-size]')
  await openDisk()
  expect(sizeOf(cwd)).toMatch(/ · .+ rebuildable$/)
  await expect(size(), 'its size as it is on disk, with what setup built').toHaveText(sizeOf(cwd), { timeout: STEP_MS })
  await expect(diskRow(page, id)).toContainText('running')

  // ── archived, from its row ──
  await diskRow(page, id).getByRole('button', { name: `Archive ${title}` }).click()
  await archiveAnswered(page, async () => ((await diskRow(page, id).textContent().catch(() => '')) ?? '').includes('archived'))
  await expect(settings(page, 'Disk')).toBeVisible({ timeout: STEP_MS })
  expect(fs.existsSync(path.join(cwd, 'node_modules/dep/blob.bin')), 'an archive alone removes nothing').toBe(true)

  // ── a week later: with Kea closed the archive is dated a day past the setting's days ──────────
  const days = SETTINGS.find((k) => k.key === 'general.pruneArchivedBuildDirsDays')!.default as number
  expect(days).toBeGreaterThan(0)
  await kea.close()
  archivedAt(run, id, Date.now() - (days + 1) * 86_400_000)
  kea = await launch({ ready: 'window' })
  page = await kea.page()
  await recordClipboard(page)
  await until('the build folders pruned', () => !fs.existsSync(path.join(cwd, 'node_modules')) || undefined)
  expect(fs.readFileSync(path.join(cwd, 'notes/keep.txt')).length, 'the untracked notes are untouched').toBe(200_000)
  expect(gitIn(cwd, 'status', '--porcelain', '-uall').trim()).toBe('?? notes/keep.txt')
  await openDisk()
  await expect(size()).toHaveText(sizeOf(cwd), { timeout: STEP_MS })
  expect(sizeOf(cwd)).toContain('nothing rebuildable')
  await expect(diskRow(page, id)).toContainText('archived')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /^Settings: / })).toHaveCount(0)

  // ── unarchived: setup runs again because the folders were pruned, and brings them back ──
  await page.getByRole('treeitem', { name: 'Archived (1)' }).click()
  await waitRow(kea, id, 'archived, listed', (r) => r.lifecycle === 'archived')
  await sessionMenu(kea, id, 'session.unarchive')
  await until('setup ran again, for the unarchive', () => setups() === 'create\nunarchive\n' || undefined)
  await until('the build folder back', () => fs.existsSync(path.join(cwd, 'node_modules/dep/blob.bin')) || undefined)
  await waitRow(kea, id, 'detached after Unarchive', (r) => r.lifecycle === 'detached')
  // Resume: the same conversation, with Kea's mod and --trust again
  // (from the row's menu: after a Restore in a project with a setup script the pane's only tab is Setup, and the
  // detached overlay, which lives on the Agent tab or on a pane with no tab, is not there to press)
  const resume = async (n: number): Promise<Start> => {
    await sessionMenu(kea, id, 'session.resume')
    await waitRow(kea, id, 'live after Resume', (r) => r.lifecycle === 'live')
    return until(`Command Code start ${n}`, () => startsOf(cmd.log)[n - 1])
  }
  const second = await resume(2)
  expect(second.argv.slice(0, 2)).toEqual(['--resume', conversation])
  expect(second.argv).toEqual(expect.arrayContaining(['--mod', '--trust']))
  expect(second).toMatchObject({ cwd, sessionId: conversation })

  // ── deleted from the view, then restored from Recently deleted ───────────
  // (a size measured within the hour is not walked again when the view opens; the view's Refresh does)
  await openDisk()
  await settings(page, 'Disk').getByRole('button', { name: 'Refresh' }).click()
  await expect(size(), 'what setup built again is counted').toHaveText(sizeOf(cwd), { timeout: STEP_MS })
  expect(sizeOf(cwd)).toMatch(/ · .+ rebuildable$/)
  await diskRow(page, id).getByRole('button', { name: `Delete ${title}…` }).click()
  const del = page.getByRole('alertdialog', { name: 'Delete session' })
  await expect(del).toContainText(`Delete ${title}?`, { timeout: STEP_MS })
  await del.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(settings(page, 'Disk')).toBeVisible({ timeout: STEP_MS })
  await until('its row gone', async () => !(await rowIds(page)).includes(id) || undefined)
  await until('its worktree gone', () => !fs.existsSync(cwd) || undefined)
  const gone = settings(page, 'Disk').locator(`[data-disk-deleted="${id}"]`)
  await expect(gone).toContainText(title, { timeout: STEP_MS })
  await gone.getByRole('button', { name: `Restore ${title}` }).click()
  await until('the restored session’s row', async () => (await rowIds(page)).includes(id) || undefined)
  await until('setup ran once more, for the restore', () => setups() === 'create\nunarchive\nrestore\n' || undefined)
  expect(fs.readFileSync(path.join(cwd, 'notes/keep.txt')).length, 'its uncommitted notes are back').toBe(200_000)
  await waitRow(kea, id, 'detached', (r) => r.lifecycle === 'detached')
  // the restore makes the session detached and then runs setup: the build folder is whole once setup ends
  // (so it is waited for: read at once, it could lose the race with setup under load)
  const blob = path.join(cwd, 'node_modules/dep/blob.bin')
  await until('the build folder built again', () => (fs.existsSync(blob) && fs.statSync(blob).size === 400_000) || undefined)
  // the restored worktree was walked as it came back, while setup was still building: Refresh measures what is there now
  await settings(page, 'Disk').getByRole('button', { name: 'Refresh' }).click()
  await expect(size()).toHaveText(sizeOf(cwd), { timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /^Settings: / })).toHaveCount(0)
  const third = await resume(3)
  expect(third.argv.slice(0, 2)).toEqual(['--resume', conversation])
  expect(third).toMatchObject({ cwd, sessionId: conversation })
  expect(await clipboard(page), 'nothing here copies').toEqual([])
  await kea.assertUnfocused()
})
