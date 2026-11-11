// V-17: the agent beside the work pane (the split): the two panes at the gallery's width, the empty work pane, the
// agent pane's status row with Claude's usage limits at its right end, the setup state, the detached overlay, the focus
// line on each pane, the strip at its narrowest, and one column at 1280.

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS, type Kea } from '../../../tests/support/app.ts'
import { agentEvents, fakeAgentTerminal, gate } from '../../../tests/support/app-fake-agent.ts'
import { addProject, sessionMenu, startSession, waitLive, waitRow } from '../../../tests/support/app-sessions.ts'
import { openFile } from '../../../tests/support/app-tabs.ts'
import { writeAgentShim } from '../../fake-agent/src/index.ts'
import { tinyRepo } from '../../repo-factory/src/index.ts'
import { frame, openKea, permission, session, status, until } from './scene.ts'
import { GallerySet, sizeWindow, WINDOW } from './shots.ts'

/** The main column at the gallery's width: header, both panes. */
const MAIN = { x: 504, y: 0, width: 936, height: 900 }
const TOP = { x: 504, y: 0, width: 936, height: 300 }

const WORKING = `steps:
  - hook: UserPromptSubmit
  - ${frame('⏺ Reading src/hello.js', '', '✶ Working…')}
  - wait: { answer: "~" }
`

test('V-17 · the split', async ({ run, launch }) => {
  const set = new GallerySet('V-17', 'The agent beside the work pane')
  const kea = await openKea(run, launch, { settings: { agents: { claude: { usageLimits: true } } } })
  const page = await kea.page()
  await kea.setLayout({ agentBeside: true })
  await until('the split drawn', async () => (await kea.layout()).split ?? undefined)
  const repo = tinyRepo({ name: 'atlas-web', parent: run.home })
  await addProject(kea, repo.root, 'atlas-web')
  const id = await session(kea, 'v17', 'fix the auth redirect', WORKING, { open: false })
  // another Claude session, in the background, whose status line reports the account's usage limits on demand
  const usage = await replyingClaude(kea, 'v17-usage')
  await fakeAgentTerminal(kea, id)

  // a new session: the work pane is empty, the file view's empty state, only + in its strip
  await expect(page.locator('.work-pane .work-empty')).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'empty', 'The split at 1440: the work pane empty (only + in its strip, "No file open"), the agent pane beside it with its status row, its focus line', 'Terminal', { rect: MAIN })

  // two shells and a file: terminals left of the files, the work pane active
  await kea.newTab()
  await kea.newTab()
  await openFile(kea, { sessionId: id, path: 'README.md', mode: 'file' })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'work', 'Terminal 1, Terminal 2, +, the separator, README.md; the work pane has the keyboard: its focus line under the strip', 'Terminal', { rect: MAIN })

  // the agent needs the person: the status row says so
  await page.keyboard.press('Meta+BracketRight')
  await status(kea, id, 'needsYou', ...permission('npm test'))
  await set.shot(kea, 'needs-you', 'The agent pane active, its status row: the glyph and "Needs permission"; the work pane keeps its file', 'Terminal, Status', { rect: TOP })

  // Claude's usage limits at the status row's right end (the account's, reported by the other session): in the meta
  // colour, then past the warning and danger ratios, then at the session window's limit
  const meter = page.locator('.agent-pane .usage-meter')
  await usage.report(42, 18)
  await expect(meter).toContainText('7d 18%', { timeout: STEP_MS })
  await set.shot(kea, 'usage', 'The status row with Claude’s usage limits at its right end, `5h 42% · 7d 18%` in mono, tabular figures, the meta colour', 'Terminal, Status', { rect: TOP })
  await usage.report(84, 96)
  await expect(meter).toContainText('7d 96%', { timeout: STEP_MS })
  await set.shot(kea, 'usage-high', 'The session window past the warning ratio in the warning colour, the weekly past the danger ratio in the danger colour', 'Terminal, Status', { rect: TOP })
  await usage.report(100, 61)
  await expect(meter).toContainText('5h limit', { timeout: STEP_MS })
  await set.shot(kea, 'usage-limit', 'The session window at its limit: `5h limit ·` and the time it resets', 'Terminal, Status', { rect: TOP })

  // the strip at its narrowest: the agent widened to the work pane's minimum, many shells
  for (let i = 0; i < 4; i++) await kea.newTab()
  const divider = page.getByRole('separator', { name: 'Resize agent pane' })
  await divider.focus()
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft')
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'narrowest', 'The work pane at its minimum: the terminal tabs scroll, + and the file tabs stay; the divider at its stop', 'Terminal', { rect: TOP })
  await divider.dblclick()

  // the agent stopped: the detached overlay, once, in the agent pane
  await sessionMenu(kea, id, 'session.stop')
  await waitRow(kea, id, 'detached', (r) => r.lifecycle === 'detached')
  await expect(page.locator('.agent-pane .detached-overlay')).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'detached', 'Detached: the agent’s last screen dimmed under the overlay in the agent pane only; the work pane unchanged', 'Terminal', { rect: MAIN })

  // one column at 1280: the Agent tab first in the strip
  await sizeWindow(kea, { width: 1280, height: WINDOW.height })
  await until('one column', async () => ((await kea.layout()).split === null ? true : undefined))
  await set.shot(kea, 'one-column', 'At 1280 with both side columns open: one column, the Agent tab first in the strip, the usage limits at its right end while the Agent tab is shown', 'Terminal, Status', { rect: { x: 504, y: 0, width: 776, height: 300 } })
  await sizeWindow(kea)
  set.note('The split at 1728 is not shot: the gallery’s window is 1440 wide, inside a laptop’s display.')
})

/**
 * Start a Claude session in the background whose agent ends a reply each time `report` is called, its status line then
 * handing on the shares used it is given (the session window's, then the weekly's): resets in two hours and in four days.
 */
async function replyingClaude(kea: Kea, name: string): Promise<{ report(session: number, week: number): Promise<void> }> {
  const g = gate(kea.run, name)
  const limits = path.join(kea.run.home, `${name}-limits.json`)
  const scenario = path.join(kea.run.home, `${name}.yaml`)
  const replies = `  - ${g.step}\n  - hook: Stop\n`.repeat(4)
  fs.writeFileSync(scenario, `version: 1\nname: ${name}\nsteps:\n  - ${frame('')}\n${replies}  - wait: { answer: "~" }\n`)
  const log = path.join(kea.run.home, `${name}.log`)
  writeAgentShim(kea.run.agentBin, 'claude', { env: { FAKE_AGENT_SCENARIO: scenario, FAKE_AGENT_LOG: log, FAKE_AGENT_RATE_LIMITS: limits } })
  const id = await startSession(kea, 'check the usage limits', { background: true })
  await waitLive(kea, id)
  await until(`the fake agent of ${name} started`, () => agentEvents(log).some((e) => e.t === 'start') || undefined)
  const now = Math.floor(Date.now() / 1000)
  return {
    async report(session, week) {
      fs.writeFileSync(limits, JSON.stringify({ five_hour: { used_percentage: session, resets_at: now + 2 * 3600 }, seven_day: { used_percentage: week, resets_at: now + 4 * 86_400 } }))
      await g.open()
    },
  }
}
