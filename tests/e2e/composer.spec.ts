// The composer's journeys: Kea launched through tests/e2e/fixtures.ts (unfocused, temp KEA_HOME, hermetic git),
// projects added with ⌘O and sessions started from the composer as a person does it, with the keyboard. Sessions run
// the `shell` pseudo-agent, the harness's default (tests/support/app.ts).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { L } from '@kea/protocol'
import { STEP_MS, until } from '../support/app.ts'
import { addProject, agentTerminal, demoRepo, paneSession, projectRow, promptBox, rowState, sessionIds, startSession, waitLive } from '../support/app-sessions.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const worktrees = (root: string) =>
  gitIn(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
const branchList = (root: string) => gitIn(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort()
const isFocused = (l: import('@playwright/test').Locator) => l.evaluate((e) => e === document.activeElement).catch(() => false)
/** How long core's answers are held back in E-CMP-6: long enough to look at the composer in between. */
const HELD_MS = 120 * L.storeTickMs

test('E-CMP-6 · ⌘N while the composer is already open and the keyboard is elsewhere (a sidebar row): the prompt takes the keyboard again; Start pressed by key keeps the keyboard while the session is being started, and ↵ again starts no second one', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const prompt = promptBox(page)
  // adding the first project opens its composer with the prompt focused (E-PRJ-1)
  await until('the prompt focused', () => isFocused(prompt).then((f) => f || undefined))
  await projectRow(page, 'demo').focus()
  expect(await isFocused(prompt), 'the keyboard is on the project row').toBe(false)
  await page.keyboard.press(sysKey('Meta+n'))
  await until('⌘N to give the prompt the keyboard', () => isFocused(prompt).then((f) => f || undefined))
  await page.keyboard.type('typed')
  expect(await prompt.inputValue(), 'what is typed lands in the prompt').toBe('typed')

  // Start pressed by key, with core's answer to it held back (the test hook's late replies): the row is listed at
  // once, and while the session is being started the keyboard is still on the button, which reads as busy (a button
  // that disabled itself would drop the keyboard to nothing, and ↵ and Esc would then do nothing in the composer)
  const start = page.getByRole('button', { name: 'Start', exact: true })
  await until('Start to be enabled', () => start.isEnabled().catch(() => false) || undefined)
  const before = new Set(await sessionIds(page))
  const started = async () => (await sessionIds(page)).filter((x) => !before.has(x))
  expect(await kea.debug('core', 'lateReplies', String(HELD_MS))).toBe(HELD_MS)
  await start.focus()
  await page.keyboard.press('Enter')
  const id = await until('the new session’s row, listed before core’s answer', async () => (await started())[0])
  expect(await paneSession(page), 'core has not answered yet: the composer is still there').toBeNull()
  expect(await isFocused(start), 'the keyboard is still on Start').toBe(true)
  await expect(start, 'it reads as busy').toHaveAttribute('aria-disabled', 'true')
  // ↵ again while it starts: nothing more is started
  await page.keyboard.press('Enter')
  await kea.debug('core', 'lateReplies', '0')
  await until('the session in the main pane', () => paneSession(page).then((x) => x === id || undefined))
  await waitLive(kea, id)
  expect(await started(), 'one session, not two').toEqual([id])
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== null), 'the keyboard is somewhere').toBe(true)
  await kea.assertUnfocused()
})

test('E-CMP-7 · a window rebuilt as GNOME’s Wayland session needs for a minimized one (forced here through the test hook): the composer’s draft, typed and never started, is kept for its project, so ⌘N in the new window opens it; the old window is gone', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const prompt = promptBox(page)
  await until('the prompt focused', () => isFocused(prompt).then((f) => f || undefined))
  const typed = 'a draft typed before the window was minimized'
  await page.keyboard.type(typed)
  expect(await prompt.inputValue()).toBe(typed)
  const rebuilt = await kea.app.evaluate(() => (globalThis as unknown as { __keaTest: { rebuildWindow(): Promise<boolean> } }).__keaTest.rebuildWindow())
  expect(rebuilt, 'there was a window to rebuild').toBe(true)
  await until('the old window gone', () => page.isClosed() || undefined)
  const fresh = await kea.page()
  await until('the new window’s project row', () => projectRow(fresh, 'demo').isVisible().catch(() => false) || undefined)
  await fresh.keyboard.press(sysKey('Meta+n'))
  const again = promptBox(fresh)
  await until('the new window’s composer', () => again.isVisible().catch(() => false) || undefined)
  expect(await again.inputValue(), 'the draft came over').toBe(typed)
  await kea.assertUnfocused()
})

test('E-CMP-3 · ⌥⌘↵ three times: three sessions start in the background, each in its own worktree; the composer stays, cleared and focused, with an inline "Started" confirmation each time', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const prompts = ['fix the login redirect', 'add a health check', 'tidy the readme']
  const ids: string[] = []
  // the person's time, from ⌘N to the third confirmation; typing is instant here, so this is Kea's part of it
  const t0 = performance.now()
  for (const [i, p] of prompts.entries()) {
    ids.push(await startSession(kea, p, { background: true, open: i === 0 }))
    // the composer stays: cleared, the keyboard still in the prompt, a one-line confirmation naming the new session
    await until('the prompt cleared', async () => (await promptBox(page).inputValue()) === '' || undefined)
    expect(await isFocused(promptBox(page)), `the prompt keeps the keyboard after start ${i + 1}`).toBe(true)
    const started = page.getByRole('region', { name: 'New session' }).getByRole('status')
    await expect(started, `confirmation ${i + 1}`).toContainText('Started', { timeout: STEP_MS })
    expect(await page.evaluate(() => (window as unknown as { __keaProbe: { pane(): { kind: string } } }).__keaProbe.pane().kind), 'the composer stays in the main pane').toBe('composer')
  }
  const userMs = performance.now() - t0
  expect(userMs, `three background starts took ${Math.round(userMs)} ms of the person’s time`).toBeLessThan(L.backgroundStartsUserTimeMs)
  expect(new Set(ids).size, 'three sessions').toBe(3)
  for (const id of ids) await waitLive(kea, id)
  // three independent worktrees, each on its own branch
  const wts = worktrees(repo.root).filter((w) => w !== repo.root)
  expect(wts, 'three worktrees besides the main checkout').toHaveLength(3)
  expect(new Set(wts).size).toBe(3)
  const branches = wts.map((w) => gitIn(w, 'rev-parse', '--abbrev-ref', 'HEAD').trim())
  expect(new Set(branches).size, `three branches (${branches.join(', ')})`).toBe(3)
  // the confirmation's link opens the last one
  await page.getByRole('region', { name: 'New session' }).getByRole('status').getByRole('button').click()
  await until('the last session in the main pane', async () => (await paneSession(page)) === ids[2] || undefined)
  await kea.assertUnfocused()
})

test('E-CMP-5 · Worktree toggle remembered per project: off in A, start; A’s next composer opens off with "In place · main" and the session runs in A’s root with no worktree or branch made; B (never launched) opens on; back on in A, start; A’s next composer opens on', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const a = demoRepo(run, 'alpha')
  const b = demoRepo(run, 'bravo')
  await addProject(kea, a.root)
  await addProject(kea, b.root)
  const branchesBefore = branchList(a.root)
  const composer = page.getByRole('region', { name: 'New session' })
  const toggle = composer.getByRole('switch', { name: 'Worktree' })
  const openIn = async (project: string) => {
    await projectRow(page, project).hover()
    await page.getByRole('button', { name: `New Session in ${project}` }).click()
    await expect(composer.getByRole('button', { name: `Project: ${project}` })).toBeVisible({ timeout: STEP_MS })
  }

  // A: Worktree off, start in place
  await openIn('alpha')
  await expect(toggle, 'a project with no launches opens with Worktree on').toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(composer.getByText('In place · main')).toBeVisible()
  await promptBox(page).click()
  const inPlace = await startSession(kea, 'work in place', { open: false })
  await waitLive(kea, inPlace)
  const agent = await agentTerminal(kea, inPlace)
  await kea.enter('pwd')
  // the whole buffer, wrapped rows joined: the path is longer than a row
  await until('the agent’s working directory: A’s root', async () => (await kea.terminalText(agent)).split('\n').some((l) => l.trim() === a.root) || undefined)
  expect(worktrees(a.root), 'no worktree made').toEqual([a.root])
  expect(branchList(a.root), 'no branch made').toEqual(branchesBefore)

  // A again: off, as last used
  await openIn('alpha')
  await expect(toggle, 'A’s composer opens with its last choice').not.toBeChecked()
  await expect(composer.getByText('In place · main')).toBeVisible()
  // B, never launched: on
  await openIn('bravo')
  await expect(toggle, 'B opens with Worktree on').toBeChecked()
  // A: on again, start
  await openIn('alpha')
  await toggle.click()
  await expect(toggle).toBeChecked()
  await promptBox(page).click()
  const isolated = await startSession(kea, 'work in a worktree', { open: false })
  await waitLive(kea, isolated)
  expect(worktrees(a.root).filter((w) => w !== a.root), 'a worktree for the second session').toHaveLength(1)
  await openIn('alpha')
  await expect(toggle, 'A’s composer opens on again').toBeChecked()
  expect((await rowState(page, inPlace))?.lifecycle).toBe('live')
  expect(await sessionIds(page)).toEqual(expect.arrayContaining([inPlace, isolated]))
  expect(fs.existsSync(path.join(a.root, '.git')), 'A is still a repository').toBe(true)
  await kea.assertUnfocused()
})
