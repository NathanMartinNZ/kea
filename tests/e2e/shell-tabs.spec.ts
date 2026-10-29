// An extra shell tab, its name and tooltip, and closing it: Kea launched through tests/e2e/fixtures.ts and driven
// with the keyboard, as a person does: `⌘T`, a command, `⌃D`, `⌘W`. The command is `cat`, which waits on its terminal
// until its input ends.

import { PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { addProject, agentTerminal, demoRepo, paneSession, selectSession, startSession, waitForeground, waitLive } from '../support/app-sessions.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'
import { NO_DOCK } from '../support/app-menubar.ts'
import { tooltip } from '../support/app-palette.ts'

test('E-TERM-1 · ⌘T opens a shell tab named Terminal n, its tooltip what runs in it: a command started later names the tooltip, and the shell’s name is back when it ends, while the tab keeps its name; ⌘W on an idle shell closes it at once; with a program running in the foreground ⌘W asks first, names the program, and Cancel keeps the tab and the program; Close Tab ends both', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const first = (await kea.shown()) as string
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  const tab = (ptyId: string) => page.locator(`[role=tab][data-pty="${ptyId}"]`)
  /** The tab's name and what its tooltip and accessible description say runs in it. */
  const says = async (ptyId: string, name: string, running: string, o: { timeout?: number } = {}) => {
    await expect(tab(ptyId)).toHaveText(name)
    await expect(tab(ptyId)).toHaveAttribute('data-tip', running, o)
    await expect(tab(ptyId)).toHaveAccessibleDescription(running, o)
  }
  const sheet = page.getByRole('alertdialog', { name: 'Close tab' })
  // the first shell of the shells pane is its Terminal 1
  await says(first, 'Terminal 1', 'zsh')

  // ⌘T: a new shell tab, on screen, numbered after the first; its tooltip is the process in its foreground: the shell
  const idle = await kea.newTab()
  await expect(tab(idle)).toHaveAttribute('data-kind', 'shell')
  await says(idle, 'Terminal 2', 'zsh')
  await expect(tab(idle)).toHaveAttribute('aria-selected', 'true')
  // an idle shell closes at once: nothing is asked
  await page.keyboard.press(sysKey('Meta+w'))
  await until('the idle shell’s tab closed', async () => !(await kea.tabIds()).includes(idle) || undefined)
  await expect(sheet).toHaveCount(0)
  await until('its holder gone', () => !run.holders().some((h) => h.ptyId === idle && run.holderAlive(h)) || undefined)

  // the closed tab was the highest: the next one takes its number again. A command started later is named in its
  // tooltip (core asks the holder what runs in the foreground when something happens in the tab), and when it ends the
  // tooltip has the shell's name again; the tab's name stays
  const busy = await kea.newTab()
  await says(busy, 'Terminal 2', 'zsh')
  await kea.enter('cat')
  await waitForeground(run, busy, 'cat')
  await says(busy, 'Terminal 2', 'cat', { timeout: STEP_MS })
  await tab(busy).hover()
  await expect(tooltip(page), 'the tooltip shows it').toHaveText('cat', { timeout: STEP_MS })
  await page.locator('.terminal-host.shown').hover()
  await says(first, 'Terminal 1', 'zsh')
  await kea.press('Control+d') // end of input: cat exits, the shell has the terminal again
  await says(busy, 'Terminal 2', 'zsh', { timeout: STEP_MS })
  await kea.echo('after-cat')

  // a program running in the foreground: ⌘W asks first, naming it
  await kea.enter('cat')
  await waitForeground(run, busy, 'cat')
  await says(busy, 'Terminal 2', 'cat', { timeout: STEP_MS })
  const cat = run.holder(busy)
  await page.keyboard.press(sysKey('Meta+w'))
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  await expect(sheet).toContainText('cat is still running in this tab. Closing the tab ends it.')
  await expect(sheet.getByRole('button', { name: 'Cancel' }), 'the safe answer has the keyboard').toBeFocused()
  // Esc is Cancel: the tab and the program are as they were, and the terminal has the keyboard again
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect(await kea.tabIds()).toContain(busy)
  expect(run.holderAlive(cat), 'the shell is still running').toBe(true)
  await kea.enter('still-here')
  await kea.waitScreen('cat still answers', (s) => s.split('\n').filter((l) => l === 'still-here').length >= 2)

  // asked again, and answered Close Tab: the tab goes, and with it the shell and the program (SIGHUP, as closing a window does)
  await page.keyboard.press(sysKey('Meta+w'))
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  await sheet.getByRole('button', { name: 'Close Tab' }).click()
  await expect(sheet).toHaveCount(0)
  await until('the busy shell’s tab closed', async () => !(await kea.tabIds()).includes(busy) || undefined)
  await until('its holder gone', () => !run.holders().some((h) => h.ptyId === busy && run.holderAlive(h)) || undefined)
  // the first shell is on screen again, with the keyboard
  await until('the first shell on screen', async () => (await kea.shown()) === first || undefined)
  await kea.echo('after-close')
  await kea.assertUnfocused()
})

/** The window's calls to core have all been answered (a tab just chosen has been remembered by then). */
const settled = (kea: Kea): Promise<unknown> =>
  until('the window’s calls to core answered', async () => (await (await kea.page()).evaluate(() => (globalThis as unknown as { __keaProbe: { rpcPending(): number } }).__keaProbe.rpcPending() === 0)) || undefined)
/** The tab the strip marks as the one on screen. */
const selectedTab = (kea: Kea): Promise<string | null> => kea.page().then((page) => page.evaluate(() => document.querySelector('[role=tablist][aria-label=Terminals] [role=tab][aria-selected=true]')?.getAttribute('data-pty') ?? null))

test('E-TERM-13 · a session’s tab comes back with its window: closed on the first of its two shell tabs and reopened from the Dock, the window shows that shell again, the tabs in their order, and a session left on its Agent tab shows its Agent tab, not its last; the same after a reload, where a session moved back to its Agent tab stays there; and after Kea is quit and started again', async ({ run, launch }) => {
  test.setTimeout(120_000)
  const kea = await launch()
  await kea.oneColumn()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)

  // session A: Agent, two shells, the first shell on screen (neither where a session starts nor its last tab)
  const a = await startSession(kea, 'first')
  await waitLive(kea, a)
  const agentA = await agentTerminal(kea, a)
  const shellA1 = await kea.newTab()
  const shellA2 = await kea.newTab()
  await kea.clickTab(shellA1)
  const tabsA = [agentA, shellA1, shellA2]
  expect(await kea.tabIds()).toEqual(tabsA)
  // session B: Agent and one shell after it, the Agent tab on screen
  const b = await startSession(kea, 'second')
  await waitLive(kea, b)
  const agentB = await agentTerminal(kea, b)
  const shellB = await kea.newTab()
  await kea.clickTab(agentB)
  const tabsB = [agentB, shellB]
  expect(await kea.tabIds()).toEqual(tabsB)
  await selectSession(kea, a)
  await until('session A on its first shell, as it was left', async () => (await kea.shown()) === shellA1 || undefined)
  await settled(kea)

  /** The session in the main pane shows `tab`, and its strip says so; `tabs` in their order. */
  const shows = async (k: Kea, how: string, sessionId: string, tab: string, tabs: string[]) => {
    const page = await k.page()
    await until(`${how}: the session in the main pane`, async () => (await paneSession(page)) === sessionId || undefined)
    await until(`${how}: the tab it was left on is on screen`, async () => ((await k.shown()) === tab && (await selectedTab(k)) === tab) || undefined).catch(async (e: Error) => {
      throw new Error(`${e.message} (on screen: ${await k.shown()}, of ${JSON.stringify(await k.tabIds())}; wanted ${tab})`)
    })
    expect(await k.tabIds(), `${how}: its tabs, in their order`).toEqual(tabs)
    // and it stays: nothing that arrives later moves it
    await settled(k)
    expect([await k.shown(), await selectedTab(k)], `${how}: still that tab`).toEqual([tab, tab])
  }

  // ── the window closed and reopened from the Dock: a new window, which remembers nothing itself (macOS: Linux
  // has no Dock, and with no tray host closing the last window quits, NO_DOCK) ──
  if (NO_DOCK === null) {
    await kea.closeWindow()
    await kea.reopenWindow()
    await shows(kea, 'reopened', a, shellA1, tabsA)
  }
  await selectSession(kea, b)
  await shows(kea, NO_DOCK === null ? 'reopened, the other session' : 'the other session', b, agentB, tabsB)

  // ── a reload: B is left on its shell, A moved back to its Agent tab ──
  await kea.clickTab(shellB)
  await selectSession(kea, a)
  await shows(kea, 'back in A', a, shellA1, tabsA)
  await kea.clickTab(agentA)
  await selectSession(kea, b)
  await shows(kea, 'back in B', b, shellB, tabsB)
  await settled(kea)
  await kea.reloadWindow()
  await shows(kea, 'reloaded', b, shellB, tabsB)
  await selectSession(kea, a)
  await shows(kea, 'reloaded, the other session', a, agentA, tabsA)

  // ── Kea quit completely and started again: the sessions' terminals ran on in their holders ──
  await kea.clickTab(shellA1)
  await settled(kea)
  expect(await kea.quitFromMenu(), 'Kea quits cleanly').toEqual({ code: 0, signal: null })
  await kea.gone()
  const again = await launch()
  await shows(again, 'relaunched', a, shellA1, tabsA)
  await selectSession(again, b)
  await shows(again, 'relaunched, the other session', b, shellB, tabsB)
  await again.assertUnfocused()
})
