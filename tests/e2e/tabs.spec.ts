// The main area's tab strip with file and diff tabs: Kea launched through tests/e2e/fixtures.ts, a session started,
// files opened the way every caller opens them (`viewer.open`, tests/support/app-tabs.ts). What the viewer shows inside
// its mount belongs to the viewer's journeys (tests/e2e/viewer.spec.ts); this file covers the strip and what happens to
// the terminals under it.

import { PROMPT, STEP_MS, until } from '../support/app.ts'
import { addProject, agentTerminal, demoRepo, startSession, tabKinds, waitForeground, waitLive } from '../support/app-sessions.ts'
import { viewing } from '../support/app-status.ts'
import { fileTabs, openFile, viewerShown } from '../support/app-tabs.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

test('E-TERM-12 · files opened in a session: the preview tab is reused until pinned, ↵ pins it, ⌘⇧] steps through terminals and file tabs alike, ⌘T from a file tab shows the new shell, Esc and ⌘W close a file tab back to the Agent terminal; the session’s terminals stay alive under a file tab and its tabs are there after the pane was away', async ({ run, launch }) => {
  const kea = await launch()
  await kea.oneColumn()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'tabs')
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)
  const shell = await kea.newTab()
  await kea.clickTab(agent)
  const instances = async () => Object.fromEntries((await kea.views()).filter((v) => v.ptyId === agent || v.ptyId === shell).map((v) => [v.ptyId, v.instance]))
  const before = await instances()
  expect(Object.keys(before).sort(), 'both terminals alive').toEqual([agent, shell].sort())
  expect(await viewing(kea), 'the Agent tab is what the window views').toBe(id)
  const shape = async () => (await fileTabs(kea)).map((t) => `${t.path} ${t.kind}${t.pinned ? '' : ' preview'}${t.selected ? ' *' : ''}`)
  const shown = async () => ({ terminal: await kea.shown(), viewer: await viewerShown(kea) })

  // 1. a file opens in the preview tab, over the terminal area: no terminal is on screen, both stay alive as they were
  expect(await openFile(kea, { sessionId: id, path: 'README.md', mode: 'file' })).toBe(true)
  await expect.poll(shown, { message: 'the file tab on screen, with the keyboard' }).toEqual({ terminal: null, viewer: { path: 'README.md', mode: 'file', focused: true } })
  expect(await shape()).toEqual(['README.md file preview *'])
  expect(await tabKinds(page), 'the terminals’ tabs are as they were').toEqual(['agent', 'shell'])
  expect(await instances(), 'no terminal was rebuilt or let go').toEqual(before)
  expect(await viewing(kea), 'a file tab is not the Agent tab').toBeNull()
  expect(await openFile(kea, { sessionId: 'another-session', path: 'README.md', mode: 'file' }), 'only the session on screen').toBe(false)

  // 2. the next open reuses the preview tab; ↵ in it pins it; the open after that gets a new preview tab
  await openFile(kea, { sessionId: id, path: 'src/index.ts', mode: 'diff', line: 3 })
  await expect.poll(shape).toEqual(['src/index.ts diff preview *'])
  await page.keyboard.press('Enter')
  await expect.poll(shape).toEqual(['src/index.ts diff *'])
  await openFile(kea, { sessionId: id, path: 'README.md', mode: 'file' })
  await expect.poll(shape).toEqual(['src/index.ts diff', 'README.md file preview *'])
  // the path that has a tab shows that tab, in the mode asked for (File · Diff)
  await openFile(kea, { sessionId: id, path: 'src/index.ts', mode: 'file' })
  await expect.poll(shape).toEqual(['src/index.ts file *', 'README.md file preview'])

  // 3. ⌘⇧] steps through every tab and around: file, file, Agent, shell, file
  const step = async () => {
    await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
    return shown()
  }
  expect(await step()).toMatchObject({ terminal: null, viewer: { path: 'README.md' } })
  await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
  await until('the Agent terminal on screen', async () => (await kea.shown()) === agent || undefined)
  expect(await viewerShown(kea)).toBeNull()
  await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
  await until('the shell on screen', async () => (await kea.shown()) === shell || undefined)
  expect(await step()).toMatchObject({ terminal: null, viewer: { path: 'src/index.ts', focused: true } })
  expect(await instances(), 'stepping through file tabs rebuilt no terminal').toEqual(before)

  // 4. ⌘T on a file tab: the new shell takes the active tab once it is listed; its tab closes with ⌘W
  const extra = await kea.newTab()
  expect(await viewerShown(kea)).toBeNull()
  expect((await shape()).some((t) => t.endsWith('*')), 'no file tab is the active one').toBe(false)
  await page.keyboard.press(sysKey('Meta+w'))
  await until('the new shell’s tab closed', async () => !(await kea.tabIds()).includes(extra) || undefined)

  // 5. the pane goes and comes back (the composer, then Esc): the file tabs and the one on screen are as they were
  await page.locator('[role=tablist][aria-label="Open files"] [role=tab][data-path="README.md"]').click()
  await expect.poll(shown).toMatchObject({ terminal: null, viewer: { path: 'README.md', focused: true } })
  await page.keyboard.press(sysKey('Meta+n'))
  await until('the composer', () => page.getByRole('region', { name: 'New session' }).isVisible().then((v) => v || undefined))
  await page.keyboard.press('Escape')
  await expect.poll(shown, { message: 'back on the session: its file tab again' }).toMatchObject({ terminal: null, viewer: { path: 'README.md' } })
  expect(await shape()).toEqual(['src/index.ts file', 'README.md file preview *'])

  // 6. Esc closes the file tab on screen and the Agent terminal is back, with the keyboard; ⌘W closes the other one from
  // its tab; on the Agent tab ⌘W does nothing
  await page.locator('[role=tabpanel].viewer-mount').focus()
  await page.keyboard.press('Escape')
  await until('the Agent terminal on screen', async () => (await kea.shown()) === agent || undefined)
  expect(await shape()).toEqual(['src/index.ts file'])
  await kea.enter('echo back-on-the-agent')
  await kea.waitScreen('typing reaches the Agent terminal', (s) => s.includes('back-on-the-agent\n'))
  await page.locator('[role=tablist][aria-label="Open files"] [role=tab][data-path="src/index.ts"]').click()
  await expect.poll(shown).toMatchObject({ terminal: null, viewer: { path: 'src/index.ts' } })
  await page.keyboard.press(sysKey('Meta+w'))
  await until('the Agent terminal on screen again', async () => (await kea.shown()) === agent || undefined)
  expect(await fileTabs(kea)).toEqual([])
  await page.keyboard.press(sysKey('Meta+w'))
  await kea.waitScreen('the Agent tab is still there', (s) => s.includes(PROMPT))
  expect(await tabKinds(page)).toEqual(['agent', 'shell'])
  expect(await viewing(kea), 'the Agent tab is viewed again').toBe(id)
  await kea.assertUnfocused()
})

test('E-TERM-14 · a closable tab has a close button: shell and file tabs show it when active or under the pointer, the Agent tab has none; a click on it closes that tab, not the one on screen, an idle shell at once, a shell running a program after the same question as ⌘W; the keyboard stays in the terminal on screen', async ({ run, launch }) => {
  const kea = await launch()
  await kea.oneColumn()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'close')
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)
  const idle = await kea.newTab()
  const busy = await kea.newTab()
  const tab = (ptyId: string) => page.locator(`[role=tablist][aria-label=Terminals] [role=tab][data-pty="${ptyId}"]`)
  const close = (ptyId: string) => tab(ptyId).locator('.tab-close')
  const sheet = page.getByRole('alertdialog', { name: 'Close tab' })

  // 1. where the button shows: on the active tab; on another closable tab only under the pointer; never on the Agent tab
  await expect(close(busy), 'the active shell tab').toBeVisible()
  await expect(close(idle), 'an inactive shell tab, not hovered').toBeHidden()
  await expect(close(agent), 'the Agent tab is not closable').toHaveCount(0)
  await tab(idle).hover()
  await expect(close(idle), 'under the pointer').toBeVisible()
  await expect(close(idle)).toHaveAttribute('data-command', 'terminal.closeTab')
  await expect(tab(idle), 'the button adds nothing to the tab’s name').toHaveText('Terminal 1')
  await expect(tab(idle)).toHaveAccessibleName('Terminal 1')
  await expect(tab(idle), 'what runs in it is its description, as its tooltip').toHaveAccessibleDescription('zsh')
  await expect(tab(busy)).toHaveAccessibleName('Terminal 2')

  // 2. a click on an inactive idle shell's button closes that tab at once; the tab on screen stays, with the keyboard
  await close(idle).click()
  await until('the idle shell’s tab closed', async () => !(await kea.tabIds()).includes(idle) || undefined)
  await expect(sheet).toHaveCount(0)
  await until('its holder gone', () => !run.holders().some((h) => h.ptyId === idle && run.holderAlive(h)) || undefined)
  expect(await kea.shown(), 'the shell on screen is still the one on screen').toBe(busy)
  await kea.echo('still-typing-here')

  // 3. a program running in the foreground: the button asks first, as ⌘W does; Cancel keeps both, Close Tab ends both
  await kea.enter('cat')
  await waitForeground(run, busy, 'cat')
  const cat = run.holder(busy)
  await close(busy).click()
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  await expect(sheet).toContainText('cat is still running in this tab. Closing the tab ends it.')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect(await kea.tabIds()).toContain(busy)
  expect(run.holderAlive(cat), 'the program is still running').toBe(true)
  await close(busy).click()
  await sheet.getByRole('button', { name: 'Close Tab' }).click()
  await until('the busy shell’s tab closed', async () => !(await kea.tabIds()).includes(busy) || undefined)
  await until('its holder gone', () => !run.holders().some((h) => h.ptyId === busy && run.holderAlive(h)) || undefined)
  await until('the Agent terminal on screen', async () => (await kea.shown()) === agent || undefined)

  // 4. a file tab: the same button, and the terminal it covered is back with the keyboard
  expect(await openFile(kea, { sessionId: id, path: 'README.md', mode: 'file' })).toBe(true)
  await expect.poll(async () => (await viewerShown(kea))?.path).toBe('README.md')
  const fileClose = page.locator('[role=tablist][aria-label="Open files"] [role=tab][data-path="README.md"] .tab-close')
  await expect(fileClose, 'the active file tab').toBeVisible()
  await fileClose.click()
  await until('the file tab closed', async () => (await fileTabs(kea)).length === 0 || undefined)
  await until('the Agent terminal on screen again', async () => (await kea.shown()) === agent || undefined)
  await kea.enter('echo after-the-file')
  await kea.waitScreen('typing reaches the Agent terminal', (s) => s.includes('after-the-file\n'))
  expect(await tabKinds(page)).toEqual(['agent'])
  await kea.assertUnfocused()
})
