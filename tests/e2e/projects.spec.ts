// The projects journeys: Kea launched through tests/e2e/fixtures.ts (unfocused, temp KEA_HOME, hermetic git with the
// test identity), projects added with ⌘O (tests/support/app-sessions.ts).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { INIT_COMMIT_MESSAGE } from '@kea/core/src/sessions/projects.ts'
import { GIT_IDENTITY, STEP_MS, until } from '../support/app.ts'
import { diffStatText, panelModes, treeRow, waitTree } from '../support/app-files.ts'
import { addProject, agentTerminal, plainFolder, promptBox, startSession, waitLive } from '../support/app-sessions.ts'
import { viewerShown } from '../support/app-tabs.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

test('E-PRJ-2 · a plain folder as a project: sessions in place only, no git UI, the file tree works and there is no Changes tab; "Initialise git…" makes the repository with one empty commit by the user’s identity, and a worktree session then starts at once', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const folder = plainFolder(run, 'notes')
  await addProject(kea, folder)
  const composer = page.getByRole('region', { name: 'New session' })
  const toggle = composer.getByRole('switch', { name: 'Worktree' })
  // in place only: the switch is off and cannot be turned on; no base or branch to choose
  await expect(toggle).not.toBeChecked({ timeout: STEP_MS })
  await expect(toggle).toBeDisabled()
  await expect(composer.getByRole('textbox', { name: 'Branch name' })).toHaveCount(0)
  await expect(composer.getByRole('button', { name: /^Base branch/ })).toHaveCount(0)
  const inPlace = await startSession(kea, 'take notes', { open: false })
  await waitLive(kea, inPlace)
  const agent = await agentTerminal(kea, inPlace)
  await kea.enter('pwd')
  await until('the agent runs in the folder', async () => (await kea.terminalText(agent)).split('\n').some((l) => l.trim() === folder) || undefined)
  // no git UI: no branch chip in the header
  await expect(page.getByRole('main', { name: 'Session' }).getByRole('button', { name: /^Branch / })).toHaveCount(0)
  // The file tree works without git (no decorations), and there is no Changes tab, no diff stat, no way to show Changes
  const tree = await waitTree(kea, 'the folder’s file is listed', (rows) => rows.some((r) => r.path === 'notes.txt'))
  expect(tree.map((r) => `${r.path}|${r.git}`)).toEqual(['notes.txt|null'])
  expect((await panelModes(kea)).map((m) => m.label)).toEqual(['Files'])
  expect(await diffStatText(kea)).toBeNull()
  expect(await page.evaluate(() => (window as unknown as { __keaProbe: { reason(id: string): string | undefined } }).__keaProbe.reason('files.showChanges'))).toBe('This folder is not a git repository')
  // a file written there shows by itself; a click shows it in the viewer
  fs.writeFileSync(path.join(folder, 'more.txt'), 'more\n')
  await waitTree(kea, 'the new file is listed, undecorated', (rows) => rows.some((r) => r.path === 'more.txt' && r.git === null))
  await treeRow(page, 'more.txt').click()
  await until('the file in the viewer', async () => (await viewerShown(kea))?.path === 'more.txt' || undefined)
  await page.keyboard.press(sysKey('Meta+Shift+g'))
  expect((await panelModes(kea)).map((m) => m.label), '⌘⇧G shows no Changes here').toEqual(['Files'])

  // "Initialise git…": git init and one empty commit, by the user's own identity, with the folder's files untouched
  await page.keyboard.press(sysKey('Meta+n'))
  // pressed by key, and git cannot write the folder the first time: a toast says why and the keyboard is still on the
  // button (a button that disabled itself while git ran would drop it: ↵ would then do nothing, and Esc would no longer
  // close the composer)
  const init = page.getByRole('button', { name: 'Initialise git…' })
  fs.chmodSync(folder, 0o555)
  try {
    await init.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('alert'), 'why git was not initialised').toContainText('Initialise git: git init failed', { timeout: STEP_MS })
    await expect(init, 'pressable again').not.toHaveAttribute('aria-disabled', 'true')
    expect(await init.evaluate((e) => e === document.activeElement), 'the keyboard is still on "Initialise git…"').toBe(true)
    expect(fs.existsSync(path.join(folder, '.git')), 'nothing was made').toBe(false)
  } finally {
    fs.chmodSync(folder, 0o755)
  }
  // ↵ again, now that the folder can be written
  await page.keyboard.press('Enter')
  await expect(init, 'a git project now').toHaveCount(0, { timeout: STEP_MS })
  expect(gitIn(folder, 'log', '--format=%an <%ae> · %s').trim().split('\n')).toEqual([`${GIT_IDENTITY.name} <${GIT_IDENTITY.email}> · ${INIT_COMMIT_MESSAGE}`])
  expect(gitIn(folder, 'status', '--porcelain').trim(), 'the folder’s files are left untracked').toBe('?? more.txt\n?? notes.txt')
  // a worktree session starts at once: no "no commit yet" problem. The button went while it held the keyboard, and the
  // Worktree switch beside it, which it has just unlocked, has it now (the keyboard never goes to nothing): Space turns
  // it on
  await expect(toggle).toBeEnabled()
  await expect(toggle, 'the keyboard is on the Worktree switch').toBeFocused({ timeout: STEP_MS })
  await page.keyboard.press('Space')
  await expect(toggle).toBeChecked()
  await expect(composer.getByRole('list', { name: 'Problems' })).toHaveCount(0)
  await promptBox(page).click()
  const isolated = await startSession(kea, 'first branch', { open: false })
  await waitLive(kea, isolated)
  await expect(page.getByRole('main', { name: 'Session' }).getByRole('button', { name: /^Branch kea\// }), 'the branch chip of a worktree session').toBeVisible({ timeout: STEP_MS })
  expect(gitIn(folder, 'worktree', 'list').trim().split('\n'), 'a worktree beside the folder’s own checkout').toHaveLength(2)
  await kea.assertUnfocused()
})
