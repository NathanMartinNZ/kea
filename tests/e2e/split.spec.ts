// The agent beside the work pane (the split): Kea launched through tests/e2e/fixtures.ts with the split chosen and the
// window wide enough for it. The work pane's strip, the keyboard between the panes, widths and modes, the layers drawn
// per pane, the empty work pane, what counts as viewed, and the status row's usage meter. One column keeps the Agent tab
// (tests/e2e/tabs.spec.ts).

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { clockTime, L } from '@kea/protocol'
import { COLOR, SIZE_PX, SPACE_PX } from '../../packages/ui/src/generated/tokens.ts'
import { ICON_PATHS } from '../../packages/ui/src/icons.ts'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { harnessUserHome } from '../../tools/perf/src/launch.ts'
import { PROMPT, STEP_MS, until, type Kea, type KeaRun } from '../support/app.ts'
import { addProject, agentTerminal, demoRepo, paneSession, promptBox, rowState, selectSession, sessionMenu, sessionRow, startSession, tabKinds, tabOf, waitLive, waitRow } from '../support/app-sessions.ts'
import { AGENT_MARK, agentEvents, claudeByDefault, fakeAgentTerminal, gate, startFakeSession } from '../support/app-fake-agent.ts'
import { tooltip } from '../support/app-palette.ts'
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

/** The strip as a person reads it: the terminals' tab titles, `+`, then `│` (the files' own tab list) and the file tabs' titles. */
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

/**
 * The share (0–1) of the device pixels in the top `--size-focus-line` rows of the element at `selector` that are
 * painted in `--text-2`, the focus line's colour; its outer column on either side is left out (a tab's hairline edges).
 */
async function focusLineShare(page: Page, selector: string): Promise<number> {
  const r = (await page.locator(selector).boundingBox())!
  const shot = await page.screenshot({ clip: { x: r.x + 1, y: r.y, width: r.width - 2, height: SIZE_PX['focus-line'] } })
  return page.evaluate(
    async ([b64, hex]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const g = canvas.getContext('2d')!
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, canvas.width, canvas.height).data
      const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - want[0]!) + Math.abs(d[i + 1]! - want[1]!) + Math.abs(d[i + 2]! - want[2]!) <= 24) n++
      return n / (d.length / 4)
    },
    [shot.toString('base64'), COLOR['text-2']] as const,
  )
}

/** The work pane's strip as drawn: each tab's title (`+` for New Terminal) and the path of the first icon in it. */
function stripIcons(page: Page): Promise<[string, string | null][]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.work-pane .tabstrip .tab')].map((t) => [
      t.classList.contains('add') ? '+' : (t.querySelector('.tab-title')?.textContent ?? t.textContent ?? '').trim(),
      t.querySelector('svg path')?.getAttribute('d') ?? null,
    ]),
  )
}

test('E-TERM-24 · the strips as painted: in the split the pane with the keyboard draws the focus line across the top of its active tab, a terminal’s or a file’s, from edge to edge, or across the top of the agent’s status row, and the other pane draws none; each tab leads with its icon, a terminal’s or a file’s, and + is the plus icon; in one column the active tab has the line', async ({ launch }) => {
  const kea = await launch()
  const page = await kea.page()
  await kea.pretendFocused(true)
  const { id } = await splitSession(kea, 'lines')
  const tab = '.work-pane .tab.active'
  const row = '.agent-pane .status-row'
  const drawn = (selector: string, what: string) => until(what, async () => ((await focusLineShare(page, selector)) > 0.9 ? true : undefined))

  // a terminal tab with the keyboard in the work pane
  await kea.newTab()
  await until('the work pane with the keyboard', async () => ((await region(page)) === 'work' ? true : undefined))
  await drawn(tab, 'the line across the top of the active terminal tab')
  expect(await focusLineShare(page, row), 'no line over the status row').toBeLessThan(0.05)

  // a file tab
  expect(await openFile(kea, { sessionId: id, path: 'README.md', mode: 'file' })).toBe(true)
  await expect.poll(() => viewerShown(kea)).toMatchObject({ path: 'README.md' })
  await drawn(tab, 'the line across the top of the active file tab')
  expect(await stripIcons(page)).toEqual([
    ['Terminal 1', ICON_PATHS.terminal],
    ['+', ICON_PATHS.plus],
    ['README.md', ICON_PATHS.file],
  ])

  // a press on the status row gives the agent the keyboard (in the file `⌘]` indents): its row has the line, the work
  // pane's tab none
  await page.locator(row).click()
  await until('the agent pane with the keyboard', async () => ((await region(page)) === 'agent' ? true : undefined))
  await drawn(row, 'the line across the top of the status row')
  expect(await focusLineShare(page, tab), 'no line over the work pane’s tab').toBeLessThan(0.05)

  // one column: the Agent tab, shown with the keyboard, has the line and leads with a terminal's icon
  await kea.setLayout({ agentBeside: false })
  await until('one column', async () => (!(await kea.layout()).split ? true : undefined))
  await until('the Agent tab shown', async () => ((await page.locator(tab).getAttribute('data-kind')) === 'agent' ? true : undefined))
  await drawn(tab, 'the line across the top of the Agent tab')
  expect(await page.locator(tab).locator('svg path').first().getAttribute('d')).toBe(ICON_PATHS.terminal)
})

// ── the usage meter: Claude's usage limits at the status row's right end ──

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const STATUS_ROW = '.agent-pane .status-row'
/** The strip in one column: the tabs, and at its right end the meter while the Agent tab is shown. */
const STRIP = '.terminal-pane .tabstrip'
/** The fake agent's prompt, then nothing until the test ends: its usage is the test's to report. */
const WAITS = `steps:\n  - frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}'])}\n  - wait: { answer: z }\n`

/** Kea's settings with the usage meter on or off and Claude Code (the fake agent) the composer's default; core follows the file as it changes. */
function usageSetting(run: KeaRun, on: boolean): void {
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' }, agents: { claude: { usageLimits: on } } }, null, 2)}\n`)
}

/** How many replies a replying session's agent can end, one each time the test asks (more than any test asks for). */
const REPLIES = 8

/** The run's file of rate limits, which a replying session's agent reads at each status line run (FAKE_AGENT_RATE_LIMITS). */
const rateLimitsFile = (run: KeaRun) => path.join(run.home, 'rate-limits.json')

/**
 * Start a fake Claude session whose agent ends a reply each time `reply()` is called: its status line, which Kea
 * injects with the setting on, then runs again and hands on the rate limits the run's file holds then, in Claude's own
 * form. Its first run, at start, carries none: there is no reply yet.
 */
async function replyingSession(kea: Kea, name: string, prompt: string): Promise<{ id: string; reply: () => Promise<number> }> {
  const g = gate(kea.run, name)
  const scenario = path.join(kea.run.home, `${name}.yaml`)
  const replies = Array.from({ length: REPLIES }, () => `  - ${g.step}\n  - hook: Stop\n`).join('')
  fs.writeFileSync(scenario, `version: 1\nname: ${name}\nsteps:\n  - frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}'])}\n${replies}  - wait: { answer: z }\n`)
  const log = path.join(kea.run.home, `${name}.log`)
  writeAgentShim(kea.run.agentBin, 'claude', { env: { FAKE_AGENT_SCENARIO: scenario, FAKE_AGENT_LOG: log, FAKE_AGENT_RATE_LIMITS: rateLimitsFile(kea.run) } })
  const id = await startSession(kea, prompt)
  await waitLive(kea, id)
  await until(`the fake agent of ${name} started`, () => agentEvents(log).some((e) => e.t === 'start') || undefined)
  return { id, reply: g.open }
}

/**
 * Claude's usage limits as the agent of `s` reports them after its next reply: each window's share used and its reset
 * (wall ms; Claude gives it in whole seconds).
 */
async function reportUsage(kea: Kea, s: { reply: () => Promise<number> }, session: number, week: number, resets: { session: number; week: number }): Promise<void> {
  const limits = {
    five_hour: { used_percentage: session, resets_at: Math.floor(resets.session / 1000) },
    seven_day: { used_percentage: week, resets_at: Math.floor(resets.week / 1000) },
  }
  fs.writeFileSync(rateLimitsFile(kea.run), JSON.stringify(limits))
  await s.reply()
}

/** A reset as the meter says it: the clock time on the same day, else the weekday and the time. */
function resetWords(ms: number): string {
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString() ? clockTime(ms) : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${clockTime(ms)}`
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface MeterShown {
  /** The parts on the meter's line, as read; a part that wrapped out of sight is not. */
  text: string
  /** Each shown part's colour, named by the token it is (`plain` for --text-3). */
  levels: string[]
  /** From the last shown part to the row's right end, px (-1 with none shown). */
  rightGap: number
  /** The status words' box, in the agent pane's row. */
  words: { left: number; width: number } | null
}

/** The usage meter in `row` as a person sees it; null with none drawn. */
function meterIn(page: Page, row: string): Promise<MeterShown | null> {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)
    const m = r?.querySelector('.usage-meter')
    if (!r || !m) return null
    const token = (t: string): string => {
      const probe = document.createElement('span')
      probe.style.color = `var(${t})`
      document.body.append(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    }
    const names = new Map([
      [token('--text-3'), 'plain'],
      [token('--warn'), 'warn'],
      [token('--danger'), 'danger'],
    ])
    const bottom = m.getBoundingClientRect().bottom
    const shown = [...m.querySelectorAll('.usage-part')].filter((p) => p.getBoundingClientRect().top < bottom - 1)
    const last = shown.at(-1)
    const words = r.querySelector('.status-text')?.getBoundingClientRect()
    return {
      text: shown.map((p) => p.textContent ?? '').join(''),
      levels: shown.map((p) => names.get(getComputedStyle(p.querySelector('.usage-value')!).color) ?? 'other'),
      rightGap: last ? Math.round(r.getBoundingClientRect().right - last.getBoundingClientRect().right) : -1,
      words: words ? { left: words.left, width: words.width } : null,
    }
  }, row)
}

/** Wait until the meter in `row` shows `text`; resolves with what it shows. */
function waitMeter(page: Page, row: string, text: string): Promise<MeterShown> {
  return until(`the meter showing "${text}"`, async () => {
    const m = await meterIn(page, row)
    return m?.text === text ? m : undefined
  }).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify(await meterIn(page, row))}`)
  })
}

/** Narrow the agent pane's status row so its meter has `room` px beside the words (null: its own width again); resolves with what the meter shows. */
async function narrowRow(page: Page, room: number | null): Promise<MeterShown | null> {
  await page.evaluate(
    ([sel, px]) => {
      const r = document.querySelector<HTMLElement>(sel)!
      if (px === null) return void r.style.removeProperty('width')
      const s = getComputedStyle(r)
      const pads = s.boxSizing === 'border-box' ? parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) : 0
      const words = r.querySelector('.status-text')!.getBoundingClientRect().width
      r.style.width = `${px + parseFloat(s.columnGap) + words + pads}px`
    },
    [STATUS_ROW, room] as const,
  )
  return meterIn(page, STATUS_ROW)
}

/** Start a session whose agent is Command Code (`⌘1` opens the composer's Agent menu; it is the second agent). */
async function startCommandCode(kea: Kea, prompt: string): Promise<string> {
  const page = await kea.page()
  return startSession(kea, prompt, {
    beforeStart: async () => {
      await page.keyboard.press(sysKey('Meta+1'))
      const menu = page.getByRole('menu', { name: 'Agent', exact: true })
      await expect(menu).toBeVisible({ timeout: STEP_MS })
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await expect(menu).toHaveCount(0)
      await until('the prompt holding the keyboard again', () => promptBox(page).evaluate((e) => e === document.activeElement).catch(() => false) || undefined)
      await expect(page.getByRole('region', { name: 'New session' }).getByRole('group', { name: 'Agent options' }).getByRole('button').first()).toHaveAttribute('aria-label', 'Agent: Command Code')
    },
  })
}

test('E-ST-11 · usage limits, with the setting on: a Claude Code session’s reading at the right end of the agent pane’s status row, `5h 25% · 7d 67%` in --text-3; a window at the warning ratio in --warn and at the danger ratio in --danger; at 100 % its limit and reset; the tooltip spells each window out; a narrow row drops the weekly part, then the meter, the words on its left unmoved; a second session of the agent shows the same reading before its own; none for a Command Code session; in one column at the strip’s right end while the Agent tab is shown; none with the setting off', async ({ run, launch }) => {
  test.setTimeout(180_000)
  usageSetting(run, true)
  writeAgentShim(run.agentBin, 'commandcode', { name: 'cmd', env: { FAKE_AGENT_HOME: harnessUserHome(run.home), FAKE_AGENT_LOG: path.join(run.home, 'e-st-11-cmd.log') } })
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, demoRepo(run).root)
  await drawSplit(kea)
  const one = await replyingSession(kea, 'e-st-11-one', 'measured')
  const agent = await fakeAgentTerminal(kea, one.id)
  expect(await meterIn(page, STATUS_ROW), 'no reading yet: no meter').toBeNull()

  // the first reading: both windows at the row's right end, inside its padding, in the meta colour
  const now = Date.now()
  const resets = { session: now + HOUR_MS, week: now + 3 * DAY_MS }
  await reportUsage(kea, one, 25, 67, resets)
  let m = await waitMeter(page, STATUS_ROW, '5h 25% · 7d 67%')
  expect(m.levels).toEqual(['plain', 'plain'])
  expect(m.rightGap, 'at the row’s right end').toBe(SPACE_PX[2])

  // the warning colour from the warning ratio, the danger colour from the danger ratio, each window on its own
  const warn = Math.round(L.usageWarnRatio * 100)
  const danger = Math.round(L.usageDangerRatio * 100)
  await reportUsage(kea, one, warn, 67, resets)
  m = await waitMeter(page, STATUS_ROW, `5h ${warn}% · 7d 67%`)
  expect(m.levels).toEqual(['warn', 'plain'])
  await reportUsage(kea, one, danger, warn, resets)
  m = await waitMeter(page, STATUS_ROW, `5h ${danger}% · 7d ${warn}%`)
  expect(m.levels).toEqual(['danger', 'warn'])

  // the tooltip, on either part: each window with its share and reset, and when it was seen
  await page.locator(`${STATUS_ROW} .usage-part[data-window="session"]`).hover()
  const tip = `Session limit: ${danger} % used, resets ${resetWords(resets.session)} · Weekly: ${warn} % used, resets ${resetWords(resets.week)} · as of `
  await expect(tooltip(page).locator('span')).toHaveText(new RegExp(`^${escapeRe(tip)}\\d\\d:\\d\\d$`), { timeout: STEP_MS })
  await page.mouse.move(1, 1)
  await expect(tooltip(page)).toHaveCount(0)

  // at 100 %: the window's limit and its reset
  await reportUsage(kea, one, 100, 67, resets)
  m = await waitMeter(page, STATUS_ROW, `5h limit · ${resetWords(resets.session)} · 7d 67%`)
  expect(m.levels).toEqual(['danger', 'plain'])

  // a narrow row: the weekly part gives way first, then the whole meter; the words on the left keep their place
  await reportUsage(kea, one, 25, 67, resets)
  m = await waitMeter(page, STATUS_ROW, '5h 25% · 7d 67%')
  const widths = await page.evaluate((sel) => Object.fromEntries([...document.querySelectorAll(`${sel} .usage-part`)].map((p) => [p.getAttribute('data-window') ?? '', p.getBoundingClientRect().width])), STATUS_ROW)
  expect(await narrowRow(page, widths.session! + widths.week! - 1)).toMatchObject({ text: '5h 25%', words: m.words })
  expect(await narrowRow(page, widths.session! - 1)).toMatchObject({ text: '', words: m.words })
  await narrowRow(page, null)
  await waitMeter(page, STATUS_ROW, '5h 25% · 7d 67%')

  // a second session of the same agent shows the account's reading before its own agent has said anything
  const two = await startFakeSession(kea, 'e-st-11-two', 'measured too', WAITS)
  const agentTwo = await fakeAgentTerminal(kea, two.id)
  await waitMeter(page, STATUS_ROW, '5h 25% · 7d 67%')

  // a Command Code session: no meter, while Claude Code's reading stands
  const cmd = await startCommandCode(kea, 'nothing to measure')
  await waitLive(kea, cmd)
  await until('the Command Code session in the main pane', async () => ((await paneSession(page)) === cmd ? true : undefined))
  await until('its agent in the agent pane', async () => {
    const shown = await kea.shown('agent')
    return shown !== null && shown !== agent && shown !== agentTwo && shown === (await tabOf(kea, 'agent')) ? true : undefined
  })
  expect(await meterIn(page, STATUS_ROW), 'no meter for Command Code').toBeNull()
  await selectSession(kea, one.id)
  await fakeAgentTerminal(kea, one.id)
  await waitMeter(page, STATUS_ROW, '5h 25% · 7d 67%')

  // one column: at the strip's right end while the Agent tab is shown, not beside a shell
  await kea.oneColumn()
  await kea.clickTab(agent)
  m = await waitMeter(page, STRIP, '5h 25% · 7d 67%')
  expect(m.rightGap, 'at the strip’s right end').toBe(SPACE_PX[2])
  await kea.newTab()
  await until('no meter while a shell is shown', async () => ((await meterIn(page, STRIP)) === null ? true : undefined))
  await kea.clickTab(agent)
  await waitMeter(page, STRIP, '5h 25% · 7d 67%')

  // the setting off: core holds no reading, and the meter goes
  usageSetting(run, false)
  await until('no meter with the setting off', async () => ((await meterIn(page, STRIP)) === null ? true : undefined))
})

test('A-7 · the usage meter for assistive technology: an image named by its windows in words ("Usage: session 25%, weekly 67%"), at the limit with its reset, described by the tooltip’s words, in the agent pane and in the one-column strip; not a stop for the keyboard and not a live region', async ({ run, launch }) => {
  usageSetting(run, true)
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, demoRepo(run).root)
  await drawSplit(kea)
  const s = await replyingSession(kea, 'a-7', 'read the limits')
  const agent = await fakeAgentTerminal(kea, s.id)
  const now = Date.now()
  const resets = { session: now + HOUR_MS, week: now + 3 * DAY_MS }
  await reportUsage(kea, s, 25, 67, resets)

  const pane = page.getByRole('region', { name: 'Agent' })
  const named = pane.getByRole('img', { name: 'Usage: session 25%, weekly 67%', exact: true })
  await expect(named).toBeVisible({ timeout: STEP_MS })
  expect(await named.evaluate((e) => ({ tabIndex: e.tabIndex, live: e.closest('[aria-live], [role=status]') !== null })), 'not focusable, not announced on each change').toEqual({ tabIndex: -1, live: false })
  // the resets and when it was seen, which the window's tooltip (hidden from assistive technology) shows the eye
  const described = `Session limit: 25% used, resets ${resetWords(resets.session)} · Weekly: 67% used, resets ${resetWords(resets.week)} · as of `
  await expect(named).toHaveAccessibleDescription(new RegExp(`^${escapeRe(described)}\\d\\d:\\d\\d$`))

  // at the limit the name says until when
  await reportUsage(kea, s, 100, 67, resets)
  await expect(pane.getByRole('img', { name: `Usage: session limit reached until ${resetWords(resets.session)}, weekly 67%`, exact: true })).toBeVisible({ timeout: STEP_MS })

  // in one column the strip's meter has the same name
  await kea.oneColumn()
  await kea.clickTab(agent)
  await expect(page.locator(STRIP).getByRole('img', { name: `Usage: session limit reached until ${resetWords(resets.session)}, weekly 67%`, exact: true })).toBeVisible({ timeout: STEP_MS })
})
