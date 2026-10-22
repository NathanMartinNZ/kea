// The agent journeys: Kea launched through tests/e2e/fixtures.ts with tools/fake-agent as `claude`
// (tests/support/app.ts: the run's shim first on PATH, with its home and CLAUDE_CONFIG_DIR inside the KEA_HOME). These
// tests make it the default agent and give the shim a scenario and an event log; the real CLI is never run (E-AGT-1
// launches with no `claude` in the run's shim folder or anywhere else, checked before Kea starts).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { assertLoginShellAgents, loginShellLookup } from '../../tools/perf/src/launch.ts'
import { STEP_MS, until, type Kea, type KeaRun } from '../support/app.ts'
import { addProject, demoRepo, promptBox, rowState, sessionMenu, startSession, tabOf, waitRow } from '../support/app-sessions.ts'
import { clipboard, recordClipboard } from '../support/app-server.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

/** Make fake-agent `claude` the default agent, running `scenario` and logging to the returned file. */
function useFakeClaude(run: KeaRun, name: string, scenario: string): { log: string } {
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
  const file = path.join(run.home, `${name}.yaml`)
  fs.writeFileSync(file, scenario)
  const log = path.join(run.home, `${name}.log`)
  writeAgentShim(run.agentBin, 'claude', { env: { FAKE_AGENT_SCENARIO: file, FAKE_AGENT_LOG: log } })
  return { log }
}

interface AgentStart {
  argv: string[]
  argvHash: string
  cwd: string
}

/** The fake agents' `start` records (tools/fake-agent README "Event log"). */
function starts(log: string): AgentStart[] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { t: string } & AgentStart)
    .filter((r) => r.t === 'start')
}

/** The prompt as the agent received it: the one argument after `--`. */
function promptOf(s: AgentStart): string | null {
  const i = s.argv.lastIndexOf('--')
  return i >= 0 && i === s.argv.length - 2 ? s.argv[i + 1]! : null
}

/** Wait for the session's Agent tab on screen holding the page's keyboard. */
async function agentFocused(kea: Kea): Promise<string> {
  const page = await kea.page()
  const pty = await tabOf(kea, 'agent')
  await until('the Agent terminal on screen', async () => (await kea.shown()) === pty || undefined)
  await page.locator('.terminal-host.shown').click({ timeout: STEP_MS })
  await until('the Agent terminal holding the keyboard', () => page.evaluate(() => !!document.activeElement && !!document.querySelector('.terminal-host.shown')?.contains(document.activeElement)) || undefined)
  return pty
}

const composer = (page: Page) => page.getByRole('region', { name: 'New session' })

test('E-SES-1 · create a session with the keyboard only (⌘N → type → ⌘↵) with fake-agent as Claude: the row is listed at once in `creating`, then `working`; its worktree exists on the branch the composer showed; the terminal shows the agent; the prompt reached the agent verbatim (its argv hash)', async ({ run, launch }) => {
  const { log } = useFakeClaude(
    run,
    'e-ses-1',
    `version: 1
name: E-SES-1
steps:
  - altScreen: enter
  - hook: UserPromptSubmit
  - frame: ["✻ fake-agent · {{model}}", "fake-agent argv sha256={{argvHash}}", "", "✶ Working…"]
  - wait: { for: key, timeoutMs: 60000 }
  - hook: { event: Stop, fields: { last_assistant_message: "Done." } }
  - frame: ["✻ fake-agent · {{model}}", "fake-agent argv sha256={{argvHash}}", "", "⏺ Done.", "", "> "]
`,
  )
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  // the composer opened on the project (E-PRJ-1); close it so ⌘N opens it, as a person starts
  await page.keyboard.press('Escape')
  await until('the composer closed', async () => (await composer(page).count()) === 0 || undefined)
  const prompt = 'fix the login redirect loop'
  let branch = ''
  let pressedAt = 0
  const id = await startSession(kea, prompt, {
    beforeStart: async () => {
      // the agent is Claude Code (the default agent), ready: nothing blocks Start
      await expect(composer(page).getByRole('button', { name: /^Agent: Claude Code$/ })).toBeVisible()
      // the branch the composer shows for this prompt (core's slug, once validation answered for it)
      const field = composer(page).getByRole('textbox', { name: 'Branch name' })
      branch = await until('the branch name for the prompt', async () => {
        const v = await field.evaluate((e) => (e as HTMLInputElement).value || (e as HTMLInputElement).placeholder)
        return v.includes('redirect-loop') ? v : undefined
      })
      pressedAt = performance.now()
    },
  })
  const listedMs = performance.now() - pressedAt
  const first = await rowState(page, id)
  // listed at once, in `creating` (a fresh worktree takes longer than a sidebar update)
  expect(first?.lifecycle, `the row as first listed (${listedMs.toFixed(0)} ms after ⌘↵)`).toBe('creating')
  await waitRow(kea, id, 'working', (r) => r.lifecycle === 'live' && r.status === 'working')

  // the worktree, on the composer's branch, is where the agent runs
  expect(branch).toMatch(/^kea\/.*login-redirect-loop$/)
  const wt = gitIn(repo.root, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((b) => ({ dir: /^worktree (.+)$/m.exec(b)?.[1] ?? '', branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? '' }))
    .find((w) => w.branch === branch)
  expect(wt, `a worktree on ${branch}`).toBeDefined()
  expect(fs.existsSync(wt!.dir)).toBe(true)

  // the terminal shows the agent; the agent got the prompt as one argument, byte for byte, and prints the hash of its argv
  const started = await until('the agent’s start record', () => starts(log)[0])
  expect(fs.realpathSync(started.cwd)).toBe(fs.realpathSync(wt!.dir))
  expect(promptOf(started)).toBe(prompt)
  const hash = createHash('sha256').update(JSON.stringify(started.argv)).digest('hex')
  expect(started.argvHash).toBe(hash)
  await agentFocused(kea)
  await kea.waitScreen('the agent’s screen with its argv hash', (s) => s.includes(`fake-agent argv sha256=${hash}`) && s.includes('Working'))

  // a key ends the turn: the row leaves `working`
  await kea.press('x')
  await kea.waitScreen('the turn done', (s) => s.includes('Done.'))
  await waitRow(kea, id, 'the turn finished', (r) => r.status !== 'working')
  await kea.assertUnfocused()
})

test('E-CMP-1 · a hostile prompt (quotes, $(), backticks, newlines, a leading --help, emoji) reaches the agent as identical bytes and runs nothing', async ({ run, launch }) => {
  const { log } = useFakeClaude(
    run,
    'e-cmp-1',
    `version: 1
name: E-CMP-1
steps:
  - altScreen: enter
  - hook: UserPromptSubmit
  - frame: ["✻ fake-agent", "fake-agent argv sha256={{argvHash}}"]
  - hook: Stop
`,
  )
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const marker = path.join(run.home, 'e-cmp-1-ran')
  const hostile = `--help "double" 'single' $(touch ${marker}) \`touch ${marker}\` \\back\\slash; rm -rf ~ && echo $HOME\nsecond line\n\tthird ‽ 🦊👩‍💻 é`
  // the composer is open on the new project; the prompt holds the keyboard
  await until('the prompt focused', () => promptBox(page).evaluate((e) => e === document.activeElement).catch(() => false) || undefined)
  await startSession(kea, hostile, { open: false })
  const started = await until('the agent’s start record', () => starts(log)[0])
  expect(promptOf(started), 'the prompt, one argv element, byte for byte').toBe(hostile)
  expect(Buffer.from(promptOf(started)!, 'utf8').equals(Buffer.from(hostile, 'utf8'))).toBe(true)
  await agentFocused(kea)
  await kea.waitScreen('the agent running', (s) => s.includes(`fake-agent argv sha256=${started.argvHash}`))
  expect(fs.existsSync(marker), 'nothing in the prompt ran').toBe(false)
  await kea.assertUnfocused()
})

test('E-AGT-1 · no `claude` on the PATH: the composer still opens at once, lists Claude Code greyed as not installed (⌘1 opens the Agent menu) and choosing it copies its install command, and Start is disabled with the reason', async ({ run, launch }) => {
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
  // no `claude` anywhere Kea looks. The run's shim folder stays first on PATH without its `claude`: it still shadows the
  // other agents' commands, which may sit in a folder the login shell adds by itself (npm's /opt/homebrew/bin). Both
  // the login shell's PATH, after its profile ran (path_helper), and core's fallback one are checked before Kea starts
  fs.rmSync(path.join(run.agentBin, 'claude'))
  expect(loginShellLookup(run.launchEnv()).agents.claude, 'no claude on the login shell’s PATH').toBeNull()
  assertLoginShellAgents(run.launchEnv(), run.agentBin)
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const box = composer(page)
  await until('the prompt focused', () => promptBox(page).evaluate((e) => e === document.activeElement).catch(() => false) || undefined)
  await expect(box.getByRole('button', { name: /^Agent: Claude Code$/ })).toBeVisible({ timeout: STEP_MS })
  // the reason, with the command to copy, under the prompt; Start disabled with it as the tooltip
  const problems = box.getByRole('list', { name: 'Problems' })
  await expect(problems).toContainText('Claude Code is not installed', { timeout: STEP_MS })
  const reason = (await problems.locator('li.hard').first().textContent()) ?? ''
  const install = /Install it with: (.+?)(?:Copy install command|$)/.exec(reason)?.[1]?.trim()
  expect(install, `the install command in “${reason}”`).toBeTruthy()
  await expect(problems.getByRole('button', { name: 'Copy install command' })).toBeVisible()
  const start = box.getByRole('button', { name: 'Start', exact: true })
  await expect(start).toBeDisabled()
  expect(await start.getAttribute('aria-description')).toContain(`Install it with: ${install}`)
  expect(await box.locator('.composer-start').getAttribute('data-tip')).toContain(`Install it with: ${install}`)
  // ⌘1 in the composer opens the Agent menu: Claude Code listed as not installed, with the copy action
  await page.keyboard.press(sysKey('Meta+1'))
  const menu = page.getByRole('menu', { name: 'Agent' })
  await expect(menu).toBeVisible({ timeout: STEP_MS })
  const missing = menu.getByRole('menuitem', { name: /Claude Code — not installed · copy install command/ })
  await expect(missing).toBeVisible()
  // greyed, yet it can be chosen, and choosing it copies the install command (recorded in the page: a test never writes
  // the person's clipboard)
  await expect(missing).toHaveClass(/\bmuted\b/)
  await expect(missing).not.toHaveAttribute('aria-disabled', 'true')
  const colour = (l: typeof missing) => l.evaluate((e) => getComputedStyle(e).color)
  const grey = await page.evaluate(() => {
    const probe = document.createElement('i')
    probe.style.color = 'var(--text-3)'
    document.body.append(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  })
  expect(await colour(missing), 'greyed like a disabled item').toBe(grey)
  expect(await colour(menu.getByRole('menuitem', { name: 'Shell', exact: true })), 'an installed agent is not').not.toBe(grey)
  await recordClipboard(page)
  await page.keyboard.press('Enter') // the menu opens on its first item, the missing agent's
  await expect(menu).toHaveCount(0)
  await until('the install command copied', async () => (await clipboard(page)).at(-1) === install || undefined)
  // ⌘↵ starts nothing
  await promptBox(page).focus()
  await page.keyboard.insertText('anything')
  await page.keyboard.press(sysKey('Meta+Enter'))
  await expect(start).toBeDisabled()
  expect(await page.locator('[role=treeitem][data-session-id]').count(), 'no session started').toBe(0)
  await kea.assertUnfocused()
})

test('E-SES-4 · titles: the agent names the session; the user renames it; a later title from the agent is ignored', async ({ run, launch }) => {
  useFakeClaude(
    run,
    'e-ses-4',
    `version: 1
name: E-SES-4
steps:
  - altScreen: enter
  - hook: UserPromptSubmit
  - transcript: { record: ai-title, title: "Agent title one" }
  - frame: ["✻ fake-agent", "", "turn one"]
  - wait: { for: key, timeoutMs: 60000 }
  - hook: Stop
  - frame: ["✻ fake-agent", "", "turn one done", "> "]
onLine:
  - hook: UserPromptSubmit
  - transcript: { record: ai-title, title: "Agent title two" }
  - frame: ["✻ fake-agent", "", "turn two: {{line}}"]
  - wait: { for: key, timeoutMs: 60000 }
  - hook: Stop
  - frame: ["✻ fake-agent", "", "turn two done: {{line}}", "> "]
`,
  )
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'name this session', { open: false })
  // the agent's title replaces the one from the slug
  await waitRow(kea, id, 'the agent’s title', (r) => r.title === 'Agent title one')
  await agentFocused(kea)
  await kea.press('x')
  await kea.waitScreen('turn one done', (s) => s.includes('turn one done'))
  await waitRow(kea, id, 'turn one finished', (r) => r.status !== 'working')
  // the user's name wins from now on
  await sessionMenu(kea, id, 'session.rename')
  const rename = page.getByRole('textbox', { name: 'Session title' })
  await expect(rename).toBeFocused({ timeout: STEP_MS })
  await rename.fill('My own name')
  await page.keyboard.press('Enter')
  await waitRow(kea, id, 'renamed', (r) => r.title === 'My own name')
  // a second turn in which the agent writes another title: read during the turn, at the latest when its Stop ends the
  // watch (U-AGT-19), so by the time the row leaves `working` it was seen, and refused: the user named the session
  await agentFocused(kea)
  await kea.enter('again')
  await waitRow(kea, id, 'turn two working', (r) => r.status === 'working')
  await kea.waitScreen('turn two', (s) => s.includes('turn two: again'))
  await kea.press('x')
  await kea.waitScreen('turn two done', (s) => s.includes('turn two done: again'))
  await waitRow(kea, id, 'turn two finished', (r) => r.status !== 'working')
  expect((await rowState(page, id))?.title).toBe('My own name')
  await kea.assertUnfocused()
})
