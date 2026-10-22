// V-5: the composer: empty, filled, each dropdown open, validation errors, a missing agent.

import fs from 'node:fs'
import path from 'node:path'
import { assertLoginShellAgents } from '../../perf/src/launch.ts'
import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS, type Kea } from '../../../tests/support/app.ts'
import { promptBox } from '../../../tests/support/app-sessions.ts'
import { demoProject, openKea } from './scene.ts'
import { GallerySet } from './shots.ts'

type Page = Awaited<ReturnType<Kea['page']>>

const composer = (page: Page) => page.getByRole('region', { name: 'New session' })
/** The composer and the room its menus open into. */
const AREA = { x: 504, y: 150, width: 936, height: 470 }

test('V-5 · composer', async ({ run, launch }) => {
  const set = new GallerySet('V-5', 'Composer')
  const kea = await openKea(run, launch)
  const page = await kea.page()
  await demoProject(kea, 'atlas-web')
  await demoProject(kea, 'docs-site')
  const box = composer(page)
  await expect(promptBox(page)).toBeFocused({ timeout: STEP_MS })
  await expect(box.getByRole('button', { name: 'Start', exact: true })).toBeEnabled({ timeout: STEP_MS })
  await set.shot(kea, 'empty', 'Empty: the prompt focused, the selector row, the footer with the base branch, the Worktree toggle and the one filled accent button', 'Composer', { rect: AREA })

  await page.keyboard.insertText('Fix the redirect after sign-in: users land on / instead of the page they came from.\n\nKeep the existing tests green, and add one for a deep link.')
  await box.getByRole('textbox', { name: 'Branch name' }).fill('kea/fix-auth-redirect')
  await promptBox(page).focus()
  await set.shot(kea, 'filled', 'Filled: a prompt of several lines and a branch name typed in place', 'Composer', { rect: AREA })

  // each dropdown, opened with its own key (⌘1…⌘4) or its button
  for (const [key, name, caption] of [
    ['Meta+1', 'Agent', 'The Agent menu (⌘1)'],
    ['Meta+2', 'Model', 'The Model menu (⌘2)'],
    ['Meta+3', 'Effort', 'The Effort menu (⌘3)'],
    ['Meta+4', 'Permission mode', 'The Permission mode menu (⌘4)'],
  ] as const) {
    await page.keyboard.press(key)
    await page.getByRole('menu', { name }).waitFor({ timeout: STEP_MS })
    await set.shot(kea, `menu-${name.toLowerCase().replaceAll(' ', '-')}`, caption, 'Composer, Floating layers', { rect: AREA })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name })).toHaveCount(0)
    await expect(promptBox(page)).toBeFocused({ timeout: STEP_MS })
  }
  await box.getByRole('button', { name: /^Base branch/ }).click()
  await page.getByRole('menu', { name: 'Base branch' }).waitFor({ timeout: STEP_MS })
  await set.shot(kea, 'menu-base', 'The base branch menu', 'Composer, Floating layers', { rect: AREA })
  await page.keyboard.press('Escape')
  await box.getByRole('button', { name: /^Project:/ }).click()
  await page.getByRole('menu', { name: 'Projects' }).waitFor({ timeout: STEP_MS })
  await set.shot(kea, 'menu-project', 'The project picker', 'Composer, Floating layers', { rect: AREA })
  await page.keyboard.press('Escape')

  // validation: a branch that exists (a problem with its two ways out), then a name git refuses (hard: Start disabled)
  await box.getByRole('textbox', { name: 'Branch name' }).fill('main')
  await expect(box.getByRole('list', { name: 'Problems' })).toBeVisible({ timeout: STEP_MS })
  await promptBox(page).focus()
  await set.shot(kea, 'problem-branch-exists', 'A validation problem under the footer: the branch exists, with its ways out as links', 'Composer', { rect: AREA })
  await box.getByRole('textbox', { name: 'Branch name' }).fill('not a branch..name')
  await expect(box.getByRole('button', { name: 'Start', exact: true })).toBeDisabled({ timeout: STEP_MS })
  await promptBox(page).focus()
  await set.shot(kea, 'problem-hard', 'A hard problem in --danger: Start is disabled (no filled accent button while it cannot start)', 'Composer', { rect: AREA })

  // the Worktree toggle off: in place
  await box.getByRole('textbox', { name: 'Branch name' }).fill('')
  await box.getByRole('switch', { name: 'Worktree' }).click()
  await promptBox(page).focus()
  await set.shot(kea, 'in-place', 'Worktree off: base branch and branch name give way to the quiet "In place · main"', 'Composer', { rect: AREA })
})

test('V-5 · composer, an agent CLI missing', async ({ run, launch }) => {
  const set = new GallerySet('V-5b', 'Composer: agent CLI missing')
  // no `claude` anywhere Kea looks (as E-AGT-1): the run's shim folder stays first on PATH without it
  fs.rmSync(path.join(run.agentBin, 'claude'))
  assertLoginShellAgents(run.launchEnv(), run.agentBin)
  const kea = await openKea(run, launch)
  const page = await kea.page()
  await demoProject(kea, 'atlas-web')
  const box = composer(page)
  await expect(box.getByRole('list', { name: 'Problems' })).toContainText('is not installed', { timeout: STEP_MS })
  // a new project's default branch is known once its bases were read
  await expect(box.getByRole('button', { name: /^Base branch: main/ })).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'missing', 'The default agent is not installed: the reason with "Copy install command", Start disabled', 'Empty states', { rect: AREA })
  await page.keyboard.press('Meta+1')
  await page.getByRole('menu', { name: 'Agent' }).waitFor({ timeout: STEP_MS })
  await set.shot(kea, 'missing-menu', 'The Agent menu lists it greyed, "not installed — copy install command", and it can still be picked', 'Empty states, Floating layers', { rect: AREA })
  await page.keyboard.press('Escape')
})
