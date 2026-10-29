// The agent beside the work pane (the split): Kea launched through tests/e2e/fixtures.ts with the split chosen and the
// window wide enough for it. The work pane's strip, the keyboard between the panes, widths and modes, the layers drawn
// per pane, the empty work pane, and what counts as viewed. One column keeps the Agent tab (tests/e2e/tabs.spec.ts).

import type { Page } from '@playwright/test'
import { PROMPT, STEP_MS, until, type Kea } from '../support/app.ts'
import { addProject, agentTerminal, demoRepo, rowState, sessionMenu, sessionRow, startSession, tabKinds, waitLive, waitRow } from '../support/app-sessions.ts'
import { AGENT_MARK, claudeByDefault, fakeAgentTerminal, gate, startFakeSession } from '../support/app-fake-agent.ts'
import { ingest, notifications, permission, viewing } from '../support/app-status.ts'
import { fileTabs, openFile, viewerShown } from '../support/app-tabs.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

/** A window that holds the split with both side columns open, on every system (and inside a laptop's display). */
const WIDE = { width: 1440, height: 880 }
/** One that does not: with both side columns open its main column is below the split's need on every system. */
const NARROW = { width: 1280, height: 820 }

/** Why a command cannot run now, as the palette and the menu bar say it. */
function reason(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((c) => (window as unknown as { __keaProbe: { reason(id: string): string | undefined } }).__keaProbe.reason(c), id)
}

/** Choose the split and size the window for it; resolves once it is drawn. */
async function drawSplit(kea: Kea): Promise<void> {
  await kea.setLayout({ agentBeside: true })
  await kea.resize(WIDE.width, WIDE.height)
  await until('the split drawn', async () => (await kea.layout()).split ?? undefined)
}

/** Where the keyboard is: a region of the window, by what holds the focused element. */
function region(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const a = document.activeElement
    if (!a || a === document.body) return null
    for (const [name, sel] of [
      ['agent', '.agent-pane'],
      ['work', '.work-pane'],
      ['sidebar', 'aside.sidebar-column'],
      ['files', 'section.file-panel'],
      ['header', '.main-header'],
    ] as const)
      if (a.closest(sel)) return name
    return 'other'
  })
}

/** The session's active pane, as its pane marks it (`work` or `agent`). */
function activePane(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('[data-active-pane]')?.getAttribute('data-active-pane') ?? null)
}

/** The strip as a person reads it: the terminals' tab titles, `+`, then `│` and the file tabs' titles. */
function strip(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const bar = document.querySelector('.work-pane .tabstrip')
    for (const t of bar?.querySelectorAll('[role=tablist][aria-label=Terminals] [role=tab]') ?? []) out.push(t.querySelector('.tab-title')?.textContent ?? t.textContent ?? '')
    if (bar?.querySelector('.tab.add')) out.push('+')
    const files = bar?.querySelectorAll('[role=tablist][aria-label="Open files"] [role=tab]') ?? []
    if (files.length > 0) out.push('│')
    for (const t of files) out.push(t.querySelector('.tab-title')?.textContent ?? '')
    return out.map((s) => s.trim())
  })
}

/** A new session on the demo repo with the shell pseudo-agent, its agent pane drawn; resolves with its ids. */
async function splitSession(kea: Kea, prompt: string): Promise<{ id: string; agent: string }> {
  await addProject(kea, demoRepo(kea.run).root)
  await drawSplit(kea)
  const id = await startSession(kea, prompt)
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)
  return { id, agent }
}

/** The agent's terminal is drawn in the agent pane: its host there holds its element (not the work pane, not the dock). */
function agentDrawn(page: Page, agent: string): Promise<boolean> {
  return page.evaluate((pty) => document.querySelector(`.agent-pane .terminal-host.shown[data-pty="${pty}"] .kea-terminal`) !== null && document.querySelector(`.work-pane .terminal-host[data-pty="${pty}"]`) === null, agent)
}

/** A line typed where the keyboard is reaches `ptyId`'s shell (its echo is on its screen) and no other terminal's. */
async function typedInto(kea: Kea, ptyId: string, others: readonly string[], tag: string): Promise<void> {
  await kea.enter(`echo ${tag}-$((40+2))`)
  await until(`${tag} answered in ${ptyId}`, async () => (await kea.terminalText(ptyId)).includes(`${tag}-42`) || undefined)
  for (const o of others) expect(await kea.terminalText(o), `${tag} not in ${o}`).not.toContain(`${tag}-42`)
}

test('E-TERM-17 · the split: the strip reads Terminal 1, Terminal 2, +, │, the file with no Agent tab; Esc on a file returns the keyboard to the agent; Next Tab from the agent pane switches the work pane and leaves the keyboard with the agent; ⌘W in the agent pane closes nothing; F6’s five stops; the pane keys; Send Reference keeps the file and focuses the agent', async ({ launch }) => {
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const { agent } = await splitSession(kea, 'split')
  expect(await kea.shown('agent')).toBe(agent)
  expect(await tabKinds(page), 'no Agent tab in the strip').toEqual([])

  // two shells, each taking the keyboard as it opens, and a file: terminals left of the files
  const t1 = await kea.newTab()
  expect(await region(page), 'New Terminal gives the new shell the keyboard').toBe('work')
  expect(await agentDrawn(page, agent), 'the agent stays drawn in its pane').toBe(true)
  const t2 = await kea.newTab()
  expect(await strip(page)).toEqual(['Terminal 1', 'Terminal 2', '+'])
  expect(await kea.onScreen(), 'the agent stays beside the work pane').toEqual(expect.arrayContaining([agent, t2]))
  expect(await agentDrawn(page, agent)).toBe(true)

  // a file opened with the agent last active: Esc returns the keyboard there, and a line typed reaches the agent
  await page.keyboard.press(sysKey('Meta+BracketRight'))
  await until('the agent pane with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))
  expect(await openFile(kea, { sessionId: await paneId(page), path: 'README.md', mode: 'file' })).toBe(true)
  await expect.poll(() => viewerShown(kea)).toMatchObject({ path: 'README.md', focused: true })
  expect(await strip(page)).toEqual(['Terminal 1', 'Terminal 2', '+', '│', 'README.md'])
  expect(await kea.shown('agent'), 'the agent is still drawn').toBe(agent)
  await page.keyboard.press('Escape')
  await until('the file closed', async () => ((await fileTabs(kea)).length === 0 ? true : undefined))
  await until('the keyboard back with the agent', async () => ((await region(page)) === 'agent' ? true : undefined))
  expect(await kea.shown('work'), 'the work pane shows the tab before the file').toBe(t2)
  await typedInto(kea, agent, [t1, t2], 'e17-esc')

  // Next Tab from the agent pane: the work pane changes, the keyboard stays with the agent
  await page.keyboard.press(sysKey('Meta+Shift+BracketRight'))
  await until('the work pane on Terminal 1', async () => ((await kea.shown('work')) === t1 ? true : undefined))
  expect(await region(page)).toBe('agent')
  await typedInto(kea, agent, [t1, t2], 'e17-next')

  // ⌘W in the agent pane closes nothing
  const before = await kea.tabIds()
  await page.keyboard.press(sysKey('Meta+w'))
  await kea.echo('e17-close')
  expect(await kea.tabIds()).toEqual(before)
  expect(await kea.shown('agent')).toBe(agent)

  // the pane keys
  await page.keyboard.press(sysKey('Meta+BracketLeft'))
  await until('the work pane with the keyboard', async () => ((await region(page)) === 'work' ? true : undefined))
  expect(await activePane(page)).toBe('work')
  await typedInto(kea, t1, [agent, t2], 'e17-work')
  await page.keyboard.press(sysKey('Meta+BracketRight'))
  await until('the agent with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))
  expect(await activePane(page)).toBe('agent')

  // F6: sidebar → file panel → header → work pane → agent pane, and around
  const trail: (string | null)[] = []
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('F6')
    const was = trail.at(-1)
    trail.push(await until('the next region', async () => {
      const r = await region(page)
      return r !== was ? r : undefined
    }))
  }
  expect(trail).toEqual(['sidebar', 'files', 'header', 'work', 'agent'])

  // Send Reference from the viewer: the file stays on screen, the agent takes the keyboard with the reference typed
  await openFile(kea, { sessionId: await paneId(page), path: 'README.md', mode: 'file' })
  await expect.poll(() => viewerShown(kea)).toMatchObject({ path: 'README.md', focused: true })
  await page.keyboard.press(sysKey('Meta+l'))
  await until('the reference at the agent’s prompt', async () => (await kea.terminalText(agent)).includes('README.md') || undefined)
  await until('the agent with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))
  expect(await viewerShown(kea), 'the file is still on screen').toMatchObject({ path: 'README.md' })
})

/** The session the main pane shows. */
function paneId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = (window as unknown as { __keaProbe: { pane(): { kind: string; id?: string } } }).__keaProbe.pane()
    return p.id ?? ''
  })
}

test('E-TERM-18 · widths and modes: the agent divider drags, resets and steps, and its width outlives a relaunch; a side column toggled leaves the agent’s width; a window narrowed below the need is one column with the keyboard’s tab shown, and the split comes back past the hysteresis; the View toggle and its reason', async ({ launch }) => {
  let kea = await launch()
  let page = await kea.page()
  await kea.pretendFocused(true)
  const { id, agent } = await splitSession(kea, 'widths')
  const divider = () => page.getByRole('separator', { name: 'Resize agent pane' })
  const agentWidth = async () => Number(await divider().getAttribute('aria-valuenow'))
  const first = await agentWidth()

  // a drag to the left widens the agent; the stored width is kept
  const box = (await divider().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  await until('the agent wider', async () => ((await agentWidth()) > first ? true : undefined))
  const dragged = await agentWidth()
  expect((await kea.layout()).agentWidth).toBe(dragged)
  // the arrows step it, a double-click forgets it
  await divider().focus()
  await page.keyboard.press('ArrowRight')
  await until('the agent narrower by a step', async () => ((await agentWidth()) < dragged ? true : undefined))
  await divider().dblclick()
  await until('the agent at its first share', async () => ((await kea.layout()).agentWidth === null ? true : undefined))
  expect(await agentWidth()).toBe(first)

  // a stored width stays while the sidebar toggles; the work pane takes the difference
  await divider().focus()
  await page.keyboard.press('ArrowLeft')
  const stored = await until('a stored width', async () => (await kea.layout()).agentWidth ?? undefined)
  await page.keyboard.press(sysKey('Meta+b'))
  await until('the sidebar hidden', async () => ((await kea.layout()).drawn.sidebar === 0 ? true : undefined))
  expect(await agentWidth(), 'the agent kept its width').toBe(stored)
  await page.keyboard.press(sysKey('Meta+b'))
  await until('the sidebar back', async () => ((await kea.layout()).drawn.sidebar > 0 ? true : undefined))

  // narrowed below the need (both side columns open at NARROW): one column, the Agent tab first and on screen, since
  // the agent pane had the keyboard
  await page.keyboard.press(sysKey('Meta+BracketRight'))
  await until('the agent with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))
  await kea.resize(NARROW.width, NARROW.height)
  await until('one column', async () => ((await kea.layout()).split === null ? true : undefined))
  expect(await tabKinds(page), 'the Agent tab is back in the strip').toEqual(['agent'])
  expect(await kea.shown('work')).toBe(agent)
  expect(await page.locator('.agent-pane').count()).toBe(0)
  // the View toggle is unavailable while the window cannot hold the split, with its reason; the choice is kept
  expect(await reason(page, 'view.toggleAgentPane')).toBe('The window is too narrow to show the agent beside terminals')
  expect((await kea.layout()).agentBeside).toBe(true)
  // back to the width: the split again, the agent's width as stored
  await kea.resize(WIDE.width, WIDE.height)
  await until('the split again', async () => (await kea.layout()).split ?? undefined)
  expect(await kea.shown('agent')).toBe(agent)
  expect(await agentWidth()).toBe(stored)

  // a relaunch keeps the stored width and the split
  await kea.close()
  kea = await launch({ ready: 'window' })
  page = await kea.page()
  await kea.pretendFocused(true)
  await kea.resize(WIDE.width, WIDE.height)
  await until('the split after a relaunch', async () => (await kea.layout()).split ?? undefined)
  expect((await kea.layout()).agentWidth).toBe(stored)
  await agentTerminal(kea, id)
  expect(await kea.shown('agent'), 'the agent pane after the relaunch').toBe(agent)
})

test('E-TERM-19 · layers per pane: find in one pane leaves the other alone and ⌘F in the other moves the bar; Jump to bottom over the pane scrolled up only; OSC 52 from the active pane’s terminal reaches the clipboard and from the other pane’s does not; a detached session’s overlay is drawn once, in the agent pane, and one ↵ resumes it once', async ({ launch }) => {
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  await page.evaluate(() => {
    const w = window as unknown as { __keaClipboard: string[] }
    w.__keaClipboard = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t: string) => void w.__keaClipboard.push(t) })
  })
  const clipboard = () => page.evaluate(() => [...(window as unknown as { __keaClipboard: string[] }).__keaClipboard])
  const { agent } = await splitSession(kea, 'layers')
  const shell = await kea.newTab()

  // find in the work pane: one bar, over the work pane
  await kea.echo('e19-work')
  await page.keyboard.press(sysKey('Meta+f'))
  const bar = page.locator('.find-bar')
  await until('the find bar in the work pane', async () => ((await page.locator('.work-pane .find-bar').count()) === 1 ? true : undefined))
  await page.keyboard.type('e19')
  expect(await bar.count(), 'one bar in the window').toBe(1)
  // ⌘F in the agent pane moves it there with the query
  await page.keyboard.press('Escape')
  await page.keyboard.press(sysKey('Meta+BracketRight'))
  await until('the agent with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))
  await page.keyboard.press(sysKey('Meta+f'))
  await until('the find bar in the agent pane', async () => ((await page.locator('.agent-pane .find-bar').count()) === 1 ? true : undefined))
  expect(await page.locator('.work-pane .find-bar').count()).toBe(0)
  await page.keyboard.press('Escape')
  await until('the agent with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))

  // OSC 52: the agent pane is active, so the shell beside it cannot write the clipboard; the agent can
  const osc = (text: string) => `printf '\\e]52;c;%s\\a' "$(printf %s ${text} | base64)"`
  await page.keyboard.press(sysKey('Meta+BracketLeft'))
  await until('the work pane with the keyboard', async () => ((await region(page)) === 'work' ? true : undefined))
  // the shell writes after the keyboard has gone back to the agent
  await kea.enter(`sleep 1; ${osc('e19-from-shell')}; echo e19-shell-done`)
  await page.keyboard.press(sysKey('Meta+BracketRight'))
  await until('the shell has written', async () => (await kea.terminalText(shell)).includes('e19-shell-done') || undefined, STEP_MS)
  expect(await clipboard(), 'the other pane’s terminal does not reach the clipboard').toEqual([])
  await kea.enter(`${osc('e19-from-agent')}; echo e19-agent-done`)
  await until('the agent’s write applied', async () => ((await clipboard()).includes('e19-from-agent') ? true : undefined))
  await until('Copied by terminal in the agent pane', async () => ((await page.locator('.agent-pane .status-row', { hasText: 'Copied by terminal' }).count()) === 1 ? true : undefined))

  // Jump to bottom: over the work pane's terminal scrolled up, not over the agent beside it
  await page.keyboard.press(sysKey('Meta+BracketLeft'))
  await until('the work pane with the keyboard', async () => ((await region(page)) === 'work' ? true : undefined))
  await kea.enter('seq 100 499')
  await kea.waitScreen('the numbers printed', (sc) => sc.split('\n').some((l) => l.trim() === '499'))
  const host = (await page.locator('.work-pane .terminal-host.shown').boundingBox())!
  await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2)
  await page.mouse.wheel(0, -400)
  const jump = (where: string) => page.locator(`${where} .jump-bottom`)
  await until('Jump to bottom over the work pane', async () => ((await jump('.work-pane').count()) === 1 ? true : undefined))
  expect(await jump('.agent-pane').count(), 'none over the agent').toBe(0)

  // the agent stopped: the session is detached, its overlay drawn once, over the agent pane
  await sessionMenu(kea, await paneId(page), 'session.stop')
  await waitRow(kea, await paneId(page), 'detached', (r) => r.lifecycle === 'detached')
  await until('the detached overlay', async () => ((await page.locator('.detached-overlay').count()) === 1 ? true : undefined))
  expect(await page.locator('.agent-pane .detached-overlay').count(), 'in the agent pane').toBe(1)
  // ↵ with the keyboard in the agent's ended terminal: one resume, one new agent
  const id = await paneId(page)
  await page.keyboard.press(sysKey('Meta+BracketRight'))
  await page.keyboard.press('Enter')
  await waitRow(kea, id, 'live after Resume', (r) => r.lifecycle === 'live')
  const resumed = await until('the resumed agent beside the work pane', async () => {
    const a = await kea.shown('agent')
    return a && a !== agent ? a : undefined
  })
  await until('its prompt', async () => (await kea.terminalText(resumed)).includes(PROMPT) || undefined)
  expect(await page.locator('.detached-overlay').count()).toBe(0)
  expect((await rowState(page, id))!.lifecycle).toBe('live')
})

test('E-TERM-20 · the empty work pane: a new session’s strip shows only + and its container the file view’s empty state, and no shell starts until + is pressed; a file opened shows and its close returns to the empty state; closing the last terminal with the keyboard in it gives the keyboard to the agent', async ({ launch }) => {
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const { id, agent } = await splitSession(kea, 'empty')
  expect(await strip(page)).toEqual(['+'])
  await expect(page.locator('.work-pane .work-empty')).toContainText('No file open')
  expect(await kea.tabPtys(), 'no terminal in the work pane').toEqual([])
  expect(await agentDrawn(page, agent)).toBe(true)

  // a file shows in the work pane; closing it returns to the empty state
  await openFile(kea, { sessionId: id, path: 'README.md', mode: 'file' })
  await expect.poll(() => viewerShown(kea)).toMatchObject({ path: 'README.md' })
  await expect(page.locator('.work-pane .work-empty')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.work-pane .work-empty')).toContainText('No file open')

  // + opens a shell; exiting it with the keyboard in it leaves the keyboard with the agent
  await page.locator('.work-pane .tab.add').click()
  const shell = await until('a shell in the work pane', async () => (await kea.shown('work')) ?? undefined)
  await until('the shell’s prompt', async () => (await kea.terminalText(shell)).includes(PROMPT) || undefined)
  await page.locator('.work-pane .terminal-host.shown').click({ position: { x: 20, y: 20 } })
  await kea.enter('exit')
  await until('the shell’s tab gone', async () => (!(await kea.tabPtys()).includes(shell) ? true : undefined))
  await expect(page.locator('.work-pane .work-empty')).toContainText('No file open')
  await until('the keyboard with the agent', async () => ((await region(page)) === 'agent' ? true : undefined))
  await typedInto(kea, agent, [], 'e20-agent')

  // archived: nothing can run, so + is unavailable and says why
  const title = (await rowState(page, id))!.title
  await sessionRow(page, id).hover()
  await page.getByRole('button', { name: `Archive ${title}` }).click()
  const ask = page.getByRole('alertdialog', { name: 'Archive session' })
  if (await ask.isVisible({ timeout: 1000 }).catch(() => false)) await ask.getByRole('button', { name: 'Archive' }).click()
  // the Archived group, collapsed: open it, and show the archived session
  const group = page.getByRole('treeitem', { name: 'Archived (1)' })
  await expect(group).toBeVisible({ timeout: STEP_MS })
  await group.click()
  await waitRow(kea, id, 'archived', (r) => r.lifecycle === 'archived')
  if ((await paneId(page)) !== id) {
    await sessionRow(page, id).click()
    await until('the archived session in the main pane', async () => ((await paneId(page)) === id ? true : undefined))
  }
  const add = page.locator('.work-pane .tab.add')
  await expect(add).toHaveAttribute('aria-disabled', 'true')
  await expect(add).toHaveAttribute('data-tip', 'Unarchive the session first')
})

test('E-ST-10 · viewed in the split: a session whose work pane shows a diff while its agent finishes a turn is viewed, so it is not unread and posts nothing; its status row says it needs the person; in one column the Agent tab is needed again', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  await addProject(kea, demoRepo(run).root)
  await drawSplit(kea)
  const finish = gate(run, 'e-st-10-finish')
  const ask = gate(run, 'e-st-10-ask')
  const s = await startFakeSession(
    kea,
    'e-st-10',
    'viewed beside a diff',
    `steps:
  - hook: UserPromptSubmit
  - frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', '✶ Working…'])}
  - ${finish.step}
  - hook: { event: Stop, fields: { last_assistant_message: "Done." } }
  - frame: ${JSON.stringify([AGENT_MARK, '', '⏺ Done.'])}
  - ${ask.step}
  - hook: { event: UserPromptSubmit, fields: { prompt: "push it" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "git push" } }
  - frame: ${JSON.stringify([AGENT_MARK, '', 'Bash(git push)  Allow? (y/n)'])}
  - wait: { answer: z }
`,
  )
  await fakeAgentTerminal(kea, s.id)
  await openFile(kea, { sessionId: s.id, path: 'README.md', mode: 'diff' })
  await expect.poll(() => viewerShown(kea)).toMatchObject({ path: 'README.md', mode: 'diff' })
  await until('the session viewed beside the diff', async () => ((await viewing(kea)) === s.id ? true : undefined))

  // the turn finishes while the diff is on screen: read, and nothing posted
  await finish.open()
  await waitRow(kea, s.id, 'finished and read', (r) => r.status === 'idle')
  expect((await notifications(kea)).live.filter((x) => x === `s:${s.id}`)).toEqual([])

  // it blocks: the status row says so
  await ask.open()
  await waitRow(kea, s.id, 'blocked', (r) => r.status === 'needsYou')
  await expect(page.locator('.agent-pane .status-row [role=status]').first()).not.toHaveText('')

  // one column: a diff on screen is not the Agent tab
  await kea.setLayout({ agentBeside: false })
  await until('one column', async () => ((await kea.layout()).split === null ? true : undefined))
  await until('a diff tab shown in one column is not viewed', async () => ((await viewing(kea)) === null ? true : undefined))
  await kea.pretendFocused(false)
  await kea.assertUnfocused()
})

const screenReader = (kea: Kea, on: boolean): Promise<void> => kea.app.evaluate((_e, v) => (globalThis as unknown as { __keaTest: { screenReader(on: boolean): void } }).__keaTest.screenReader(v), on)

/** The terminals that hold xterm's screen-reader copy of their screen. */
function copies(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('.terminal-host[data-pty]')].filter((h) => h.querySelector('.xterm-accessibility') !== null).map((h) => h.getAttribute('data-pty') ?? ''))
}

test('A-6 · the split for assistive technology: two named regions, the agent divider a separator with its value and range, ⇧F6 back through the five stops, the status row a live region that says the agent needs the person, and one screen-reader copy, the active pane’s', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  await addProject(kea, demoRepo(run).root)
  await drawSplit(kea)
  const s = await startFakeSession(kea, 'a-6', 'read aloud', `steps:\n  - frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}'])}\n  - wait: { answer: z }\n`)
  const agent = await fakeAgentTerminal(kea, s.id)
  const shell = await kea.newTab()

  // the panes are regions with names; the divider between them a separator with its value and its range
  await expect(page.getByRole('region', { name: 'Terminals and files' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Agent' })).toBeVisible()
  const sep = page.getByRole('separator', { name: 'Resize agent pane' })
  const [now, min, max] = await Promise.all(['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map(async (a) => Number(await sep.getAttribute(a))))
  expect(min! <= now! && now! <= max!, `${min} ≤ ${now} ≤ ${max}`).toBe(true)
  expect(now).toBe((await kea.layout()).split!.agent)

  // ⇧F6 from the agent pane: work pane, header, file panel, sidebar, and back to the agent
  await page.keyboard.press(sysKey('Meta+BracketRight'))
  await until('the agent with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))
  const trail: (string | null)[] = []
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+F6')
    const was = trail.at(-1) ?? 'agent'
    trail.push(await until('the previous region', async () => {
      const r = await region(page)
      return r !== was ? r : undefined
    }))
  }
  expect(trail).toEqual(['work', 'header', 'files', 'sidebar', 'agent'])

  // the status row is a live region: it says the agent needs the person, where no notification comes
  const live = page.locator('.agent-pane .status-row [role=status]').first()
  await ingest(kea, s.id, 'hook', { t: 'turn.started' }, permission('npm test'))
  await waitRow(kea, s.id, 'needs you', (r) => r.status === 'needsYou')
  await expect(live).toContainText(/permission|needs you/i)

  // one screen-reader copy: the active pane's terminal, and it moves with the keyboard
  await screenReader(kea, true)
  await until('the copy in the agent', async () => (JSON.stringify(await copies(page)) === JSON.stringify([agent]) ? true : undefined))
  await page.keyboard.press(sysKey('Meta+BracketLeft'))
  await until('the copy in the shell', async () => (JSON.stringify(await copies(page)) === JSON.stringify([shell]) ? true : undefined))
  await screenReader(kea, false)
  await until('no copy', async () => ((await copies(page)).length === 0 ? true : undefined))
  await kea.pretendFocused(false)
})

test('E-TERM-21 · the work pane keeps its place: a click on its tab gives it the keyboard from the agent pane; the tab it showed comes back after a trip to one column with the keyboard in the agent pane; closing its shown terminal shows the tab before it; find open on the agent closes, highlights and all, when the mode changes', async ({ launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const { agent } = await splitSession(kea, 'keeps its place')
  const t1 = await kea.newTab()
  const t2 = await kea.newTab()
  const t3 = await kea.newTab()
  expect(await strip(page)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3', '+'])
  const toAgent = async () => {
    await page.keyboard.press(sysKey('Meta+BracketRight'))
    await until('the agent with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))
  }
  const workShows = (tab: string, what: string) =>
    until(what, async () => ((await kea.shown('work')) === tab ? true : undefined)).catch(async (e: Error) => {
      throw new Error(`${e.message}: the work pane shows ${await kea.shown('work')} (Terminal 1 ${t1}, 2 ${t2}, 3 ${t3})`)
    })

  // a click on Terminal 2's tab while the agent pane has the keyboard: the work pane shows it, with the keyboard
  await toAgent()
  await page.locator(`.work-pane [role=tab][data-pty="${t2}"]`).click()
  await until('Terminal 2 with the keyboard', async () => ((await kea.shown('work')) === t2 && (await region(page)) === 'work') || undefined)
  await typedInto(kea, t2, [agent, t1, t3], 'clicked')

  // the keyboard in the agent pane, a trip to one column and back: the work pane shows Terminal 2 again, neither the
  // first terminal nor the last
  await toAgent()
  await kea.resize(NARROW.width, NARROW.height)
  await until('one column', async () => ((await kea.layout()).split === null ? true : undefined))
  expect(await kea.shown('work'), 'one column shows the Agent tab, whose pane had the keyboard').toBe(agent)
  await kea.resize(WIDE.width, WIDE.height)
  await until('the split again', async () => (await kea.layout()).split ?? undefined)
  await until('the agent in its pane again', async () => ((await kea.shown('agent')) === agent ? true : undefined))
  await workShows(t2, 'Terminal 2 in the work pane again')

  // Terminal 2 closed with ⌘W from the work pane (its shell idle, so nothing asks): the tab before it, not the last
  await page.keyboard.press(sysKey('Meta+BracketLeft'))
  await until('Terminal 2 with the keyboard', async () => ((await kea.shown()) === t2 && (await region(page)) === 'work') || undefined)
  await page.keyboard.press(sysKey('Meta+w'))
  await until('Terminal 2 closed', async () => (!(await kea.tabIds()).includes(t2) ? true : undefined))
  await workShows(t1, 'the tab before it on screen')

  // find open on the agent, its matches highlighted; one column: the bar closes, and the agent keeps no search
  await toAgent()
  await kea.enter('for i in 1 2 3; do echo eterm21-match; done')
  await until('the matches printed', async () => ((await kea.terminalText(agent)).match(/^eterm21-match$/gm) ?? []).length === 3 || undefined)
  await page.keyboard.press(sysKey('Meta+f'))
  await page.locator('.find-bar').waitFor({ state: 'attached', timeout: STEP_MS })
  await page.keyboard.insertText('eterm21-match')
  await until('the matches highlighted', async () => ((await kea.views()).find((v) => v.ptyId === agent)?.decorations ?? 0) > 0 || undefined)
  await kea.oneColumn()
  await until('no search left on the agent', async () => {
    const v = (await kea.views()).find((x) => x.ptyId === agent)
    return (v !== undefined && !v.findOpen && v.decorations === 0) || undefined
  }).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify((await kea.views()).map((v) => ({ pty: v.ptyId, findOpen: v.findOpen, decorations: v.decorations })))}`)
  })
  await expect(page.locator('.find-bar')).toHaveCount(0)
  const searches = await page.evaluate(() => (window as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources()['renderer.searchAddons'])
  expect(searches, 'the resource report’s search addons').toBe(0)
})
