// V-6: the terminal's chrome: tab strip variants, the find bar, the detached overlay, jump-to-bottom.

import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS, type Kea } from '../../../tests/support/app.ts'
import { fakeAgentTerminal } from '../../../tests/support/app-fake-agent.ts'
import { commitFiles, serverScript, waitServer } from '../../../tests/support/app-server.ts'
import { waitRow } from '../../../tests/support/app-sessions.ts'
import { openFile, pinFileTab } from '../../../tests/support/app-tabs.ts'
import { tinyRepo } from '../../repo-factory/src/index.ts'
import { addProject } from '../../../tests/support/app-sessions.ts'
import { frame, openKea, permission, runCommand, session, status } from './scene.ts'
import { GallerySet } from './shots.ts'

type Page = Awaited<ReturnType<Kea['page']>>

/** The main column's top: header, tab strip and the first rows of the terminal. */
const TOP = { x: 504, y: 0, width: 936, height: 300 }
const MAIN = { x: 504, y: 0, width: 936, height: 900 }

const WORKING = `steps:
  - hook: UserPromptSubmit
  - ${frame('⏺ Reading src/hello.js', '', '✶ Working…')}
  - wait: { answer: "~" }
`

async function strip(page: Page): Promise<void> {
  await page.locator('.tabstrip').waitFor({ timeout: STEP_MS })
}

test('V-6 · terminal chrome', async ({ run, launch }) => {
  const set = new GallerySet('V-6', 'Terminal chrome')
  // an OSC 52 write counts while the window is not focused (it never is here); the write itself is recorded, not made
  const kea = await openKea(run, launch, { settings: { terminal: { clipboardWrite: 'always' } } })
  const page = await kea.page()
  const repo = tinyRepo({ name: 'atlas-web', parent: run.home })
  commitFiles(repo.root, { 'start.sh': serverScript() }, { executable: true })
  await addProject(kea, repo.root, 'atlas-web')
  const id = await session(kea, 'v6', 'fix the auth redirect', WORKING, { open: false })
  const agent = await fakeAgentTerminal(kea, id)
  await strip(page)
  await set.shot(kea, 'tabs-agent', 'One tab: Agent (active: --text-1 on --surface-0, merging with the terminal) and +', 'Terminal', { rect: TOP })

  // Server, a shell that runs a program, a pinned file tab and a preview tab
  await page.keyboard.press('Meta+r')
  await waitServer(kea, 'running')
  const shell = await kea.newTab()
  await kea.enter('sleep 600')
  await expect(page.locator(`[role=tab][data-pty="${shell}"]`)).toHaveText('Terminal 1')
  await expect(page.locator(`[role=tab][data-pty="${shell}"]`)).toHaveAttribute('data-tip', 'sleep', { timeout: STEP_MS })
  await openFile(kea, { sessionId: id, path: 'README.md', mode: 'file' })
  await pinFileTab(kea, 'README.md')
  await openFile(kea, { sessionId: id, path: 'src/hello.js', mode: 'file' })
  await kea.clickTab(shell)
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'tabs-all', 'Agent, Server, Terminal 1 (active; its tooltip names what runs in it), +, then the file tabs: one pinned, one preview (italic)', 'Terminal', { rect: TOP })

  // the agent needs you while another tab is on screen: the dot on the Agent tab
  await status(kea, id, 'needsYou', ...permission('npm test'))
  await expect(page.locator(`[role=tab][data-pty="${agent}"] .tab-dot`)).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'tabs-dot', 'The Agent tab’s dot: its agent needs you while another tab is on screen', 'Terminal', { rect: TOP })

  // a program writes the clipboard (OSC 52): the note at the strip's right end
  await page.evaluate(() => (window as unknown as { __keaProbe: { write(d: string): Promise<void> } }).__keaProbe.write('\x1b]52;c;a2Vh\x07'))
  await expect(page.locator('.tab-note')).toBeVisible({ timeout: STEP_MS })
  await set.shot(kea, 'tabs-copied', '"Copied by terminal" at the strip’s right end, 11 px --text-3', 'Terminal', { rect: TOP })

  // find in terminal: the 28 px bar docked top-right
  await kea.press('Control+c')
  await kea.enter('for i in $(seq 1 200); do echo "line $i of the build log"; done')
  await kea.waitScreen('the lines', (s) => s.includes('line 200 of the build log'))
  await page.keyboard.press('Meta+f')
  await page.getByRole('search').getByRole('textbox').waitFor({ timeout: STEP_MS })
  await page.keyboard.insertText('build log')
  await expect(page.locator('.find-count')).toContainText('of', { timeout: STEP_MS })
  await set.shot(kea, 'find', 'Find in terminal (⌘F): a 28 px bar docked top-right, matches marked in the terminal', 'Terminal', { rect: MAIN })
  await page.getByRole('button', { name: 'Match case' }).click().catch(() => page.locator('.find-toggle').first().click())
  await set.shot(kea, 'find-toggle', 'The find bar with a toggle on', 'Terminal', { rect: { x: 904, y: 44, width: 536, height: 120 } })
  await page.keyboard.press('Escape')

  // scrolled up: Jump to bottom
  await page.locator('.terminal-host.shown').hover()
  await page.mouse.wheel(0, -600)
  await page.getByRole('button', { name: 'Jump to bottom' }).waitFor({ timeout: STEP_MS })
  await page.mouse.move(1000, 400)
  await set.shot(kea, 'jump', 'Scrolled up: "Jump to bottom" over the terminal’s corner, and the 8 px overlay scrollbar', 'Terminal', { rect: MAIN })

  // the detached overlay: stopped by you, then crashed with its exit code
  await kea.clickTab(agent)
  await runCommand(kea, 'session.stop', { id })
  await waitRow(kea, id, 'detached', (r) => r.lifecycle === 'detached')
  await page.getByRole('status', { name: 'Session ended' }).waitFor({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'detached', 'Detached: the last screen dimmed to 60 % under one centred row, "Session ended · Resume ↵ · Restart ⌘↵"', 'Terminal', { rect: MAIN })

  const crashed = await session(kea, 'v6-crash', 'run the migration', `steps:\n  - hook: UserPromptSubmit\n  - print: "✶ Working…"\n  - exit: 3\n`)
  await waitRow(kea, crashed, 'crashed', (r) => r.lifecycle === 'detached' && r.status === 'failed')
  await page.keyboard.press('Escape')
  await page.locator(`[role=treeitem][data-session-id="${crashed}"]`).click({ position: { x: 30, y: 14 } })
  await page.getByRole('status', { name: 'Session ended' }).waitFor({ timeout: STEP_MS })
  await page.mouse.move(1000, 700)
  await set.shot(kea, 'detached-crashed', 'Detached after a crash: the row says what ended, with the exit code', 'Terminal', { rect: MAIN })
})
