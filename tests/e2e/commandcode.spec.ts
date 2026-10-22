// The composer with two agents: Kea launched through tests/e2e/fixtures.ts with tools/fake-agent as `claude` and as
// Command Code's `cmd` (tests/support/app.ts puts the run's shims first on PATH for every command of every adapter; the
// real CLIs are never run). The fake `cmd` answers detection with the recorded 1.79.2 texts
// (fixtures/cli/commandcode/), loads the kea-mod.ts the built app ships and keeps its files in the run's own HOME.

import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { parseModels } from '../../packages/adapters/src/commandcode/detect.ts'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { harnessUserHome } from '../../tools/perf/src/launch.ts'
import { STEP_MS, until, type KeaRun } from '../support/app.ts'
import { addProject, demoRepo, promptBox, startSession, waitRow } from '../support/app-sessions.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

const LIST_MODELS = path.resolve(import.meta.dirname, '../../fixtures/cli/commandcode/1.79.2/list-models.txt')

/** Both fake agents with an event log each (their default scenario: one short turn); Claude Code is the default agent. */
function useBothAgents(run: KeaRun): { claude: string; cmd: string } {
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
  const logs = { claude: path.join(run.home, 'claude.log'), cmd: path.join(run.home, 'cmd.log') }
  writeAgentShim(run.agentBin, 'claude', { env: { FAKE_AGENT_LOG: logs.claude } })
  writeAgentShim(run.agentBin, 'commandcode', { name: 'cmd', env: { FAKE_AGENT_HOME: harnessUserHome(run.home), FAKE_AGENT_LOG: logs.cmd } })
  return logs
}

/** The argv of each start a fake agent logged. */
function startArgvs(log: string): string[][] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { t: string; argv: string[] })
    .filter((r) => r.t === 'start')
    .map((r) => r.argv)
}

const composer = (page: Page) => page.getByRole('region', { name: 'New session' })
const selectors = (page: Page) => composer(page).getByRole('group', { name: 'Agent options' })
const promptFocused = (page: Page) => until('the prompt holding the keyboard', () => promptBox(page).evaluate((e) => e === document.activeElement).catch(() => false) || undefined)
const labels = (menu: Locator) => menu.locator('.kea-menu-label').allTextContents()

/** `⌘<digit>` from the prompt opens a selector's menu; resolves with the open menu. */
async function openSelector(page: Page, digit: 1 | 2 | 3 | 4, name: string): Promise<Locator> {
  await promptFocused(page)
  await page.keyboard.press(sysKey(`Meta+${digit}`))
  const menu = page.getByRole('menu', { name, exact: true })
  await expect(menu).toBeVisible({ timeout: STEP_MS })
  return menu
}

/** Choose in a selector's menu with the keyboard (`keys`: arrows, Home, End or type-ahead letters), then `↵`; the prompt has the keyboard again. */
async function choose(page: Page, digit: 1 | 2 | 3 | 4, name: string, keys: readonly string[]): Promise<void> {
  const menu = await openSelector(page, digit, name)
  for (const k of keys) await page.keyboard.press(k)
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await promptFocused(page)
}

/** The selector row as it reads: each button's accessible name (`Agent: …`, `Model: …`, `Effort: …`, `Permission mode: …`). */
async function shown(page: Page): Promise<string[]> {
  return selectors(page)
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
}

const CLAUDE_CHOSEN = ['Agent: Claude Code', 'Model: sonnet', 'Effort: xhigh', 'Permission mode: Auto']
const CMD_DEFAULT = ['Agent: Command Code', 'Model: default', 'Effort: model default', 'Permission mode: Ask before edits']
const CMD_CHOSEN = ['Agent: Command Code', 'Model: deepseek/deepseek-v4-pro', 'Effort: low', 'Permission mode: Plan']

test('E-CMP-2 · composer options with two agents: switching Claude Code → Command Code swaps the model list to Command Code’s own and drops the effort and the mode it does not have; dangerous modes are not listed; ⌘1…⌘4, type-ahead and ↵ choose and return the keyboard to the prompt; Shell has no knobs; each agent’s last-used choices in the project come back when it is chosen again', async ({ run, launch }) => {
  const logs = useBothAgents(run)
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, demoRepo(run).root)
  await promptFocused(page)

  // both CLIs detected in the background (the composer was usable meanwhile): the registry's order, Shell last
  let menu = await openSelector(page, 1, 'Agent')
  await expect(menu.locator('.kea-menu-label')).toHaveText(['Claude Code', 'Command Code', 'Shell'], { timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  expect(await shown(page)).toEqual(['Agent: Claude Code', 'Model: default', 'Effort: model default', 'Permission mode: Ask before edits'])

  // Claude Code's choices, by keyboard: type-ahead to Sonnet and to xhigh; Auto is a mode only Claude Code has
  menu = await openSelector(page, 2, 'Model')
  expect(await labels(menu)).toEqual(['Default (recommended)', 'Fable', 'Opus', 'Sonnet', 'Haiku', 'Best available', 'Opus plan, Sonnet execute', 'Custom model…'])
  await page.keyboard.press('Escape')
  await choose(page, 2, 'Model', ['s'])
  await choose(page, 3, 'Effort', ['x'])
  menu = await openSelector(page, 4, 'Permission mode')
  // no dangerous mode is listed while `agents.claude.allowDangerousModes` is off
  expect(await labels(menu)).toEqual(['Ask before edits', 'Accept edits', 'Plan', 'Auto', "Don't ask (deny anything not pre-approved)"])
  await menu.getByRole('menuitem', { name: 'Auto', exact: true }).click()
  await promptFocused(page)
  expect(await shown(page)).toEqual(CLAUDE_CHOSEN)

  // to Command Code: its defaults, not Claude Code's choices: the model list is the CLI's own, xhigh and Auto are gone
  await choose(page, 1, 'Agent', ['ArrowDown'])
  expect(await shown(page)).toEqual(CMD_DEFAULT)
  const listed = parseModels(fs.readFileSync(LIST_MODELS, 'utf8')).map((m) => m.id)
  expect(listed.length).toBeGreaterThan(1)
  menu = await openSelector(page, 2, 'Model')
  expect(await labels(menu)).toEqual(['Default (Command Code’s own)', ...listed, 'Custom model…'])
  await page.keyboard.press('Escape')
  menu = await openSelector(page, 3, 'Effort')
  expect(await labels(menu)).toEqual(['Model default', 'low', 'medium', 'high'])
  await page.keyboard.press('Escape')
  menu = await openSelector(page, 4, 'Permission mode')
  expect(await labels(menu), 'Command Code’s modes; its dangerous one is not listed').toEqual(['Ask before edits', 'Accept edits', 'Plan'])
  await page.keyboard.press('Escape')
  await choose(page, 2, 'Model', ['d'])
  await choose(page, 3, 'Effort', ['l'])
  await choose(page, 4, 'Permission mode', ['p'])
  expect(await shown(page)).toEqual(CMD_CHOSEN)

  // Shell has no knobs: they are removed, not disabled. Back to each agent: what was chosen for it in this draft
  await choose(page, 1, 'Agent', ['End'])
  expect(await shown(page)).toEqual(['Agent: Shell'])
  await choose(page, 1, 'Agent', ['Home'])
  expect(await shown(page)).toEqual(CLAUDE_CHOSEN)

  // start with Claude Code: the choices reach its command line
  const first = await startSession(kea, 'first task', { open: false })
  const claudeArgv = await until('Claude Code started', () => startArgvs(logs.claude)[0])
  expect(claudeArgv).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'xhigh', '--permission-mode', 'auto']))
  await waitRow(kea, first, 'live', (r) => r.lifecycle === 'live')

  // the next composer opens on the project's last start (Claude Code and its choices); Command Code was never started
  // here, so it opens on its defaults. Start with it: its choices and Kea's mod reach its command line
  const second = await startSession(kea, 'second task', {
    beforeStart: async () => {
      expect(await shown(page)).toEqual(CLAUDE_CHOSEN)
      await choose(page, 1, 'Agent', ['ArrowDown'])
      expect(await shown(page)).toEqual(CMD_DEFAULT)
      await choose(page, 2, 'Model', ['d'])
      await choose(page, 3, 'Effort', ['l'])
      await choose(page, 4, 'Permission mode', ['p'])
      expect(await shown(page)).toEqual(CMD_CHOSEN)
    },
  })
  const cmdArgv = await until('Command Code started', () => startArgvs(logs.cmd)[0])
  expect(cmdArgv.slice(0, 6)).toEqual(['--model', 'deepseek/deepseek-v4-pro', '--effort', 'low', '--permission-mode', 'plan'])
  expect(cmdArgv.slice(-3)).toEqual(['--trust', '--', 'second task'])
  // the mod is the copy the built app ships, written under this run's KEA_HOME; through it the agent's turn and title arrive
  const mod = cmdArgv[cmdArgv.indexOf('--mod') + 1]!
  expect(mod.startsWith(path.join(run.home, 'bin', 'agents', 'commandcode-'))).toBe(true)
  expect(fs.readFileSync(mod, 'utf8')).toBe(fs.readFileSync(path.resolve(import.meta.dirname, '../../packages/adapters/src/commandcode/kea-mod.ts'), 'utf8'))
  await waitRow(kea, second, 'titled by the agent, its turn finished', (r) => r.title.includes('Fake agent turn'))

  // a third composer: the project's last start was Command Code. Each agent's own last choices come back
  await page.keyboard.press(sysKey('Meta+n'))
  await promptFocused(page)
  expect(await shown(page)).toEqual(CMD_CHOSEN)
  await choose(page, 1, 'Agent', ['Home'])
  expect(await shown(page)).toEqual(CLAUDE_CHOSEN)
  await choose(page, 1, 'Agent', ['ArrowDown'])
  expect(await shown(page)).toEqual(CMD_CHOSEN)
  await kea.assertUnfocused()
})
