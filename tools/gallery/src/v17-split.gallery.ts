// V-17: the agent beside the work pane (the split): the two panes at the gallery's width, the empty work pane, the
// agent pane's status row, the setup state, the detached overlay, the focus line on each pane, the strip at its
// narrowest, and one column at 1280.

import { expect, test } from '../../../tests/e2e/fixtures.ts'
import { STEP_MS } from '../../../tests/support/app.ts'
import { fakeAgentTerminal } from '../../../tests/support/app-fake-agent.ts'
import { addProject, sessionMenu, waitRow } from '../../../tests/support/app-sessions.ts'
import { openFile } from '../../../tests/support/app-tabs.ts'
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
  const kea = await openKea(run, launch)
  const page = await kea.page()
  await kea.setLayout({ agentBeside: true })
  await until('the split drawn', async () => (await kea.layout()).split ?? undefined)
  const repo = tinyRepo({ name: 'atlas-web', parent: run.home })
  await addProject(kea, repo.root, 'atlas-web')
  const id = await session(kea, 'v17', 'fix the auth redirect', WORKING, { open: false })
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
  await set.shot(kea, 'one-column', 'At 1280 with both side columns open: one column, the Agent tab first in the strip', 'Terminal', { rect: { x: 504, y: 0, width: 776, height: 300 } })
  await sizeWindow(kea)
  set.note('The split at 1728 is not shot: the gallery’s window is 1440 wide, inside a laptop’s display.')
})
