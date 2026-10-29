// Projects and sessions through the window, for the app-level suites: add a project with ⌘O (main's folder picker
// answers with the folder the harness queued, `__keaTest.queueFolder`, since no dialog may open under `--kea-perf`),
// start sessions from the composer, select them in the sidebar, and read what the sidebar rows say (`data-session-id`,
// `data-lifecycle`, `data-status`; each component's "Locatable as" line names it). Sessions run the `shell`
// pseudo-agent, the harness's default (tests/support/app.ts): its Agent tab is a login shell with the test prompt.

import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { tinyRepo, type FixtureRepo } from '@kea-tools/repo-factory/src/index.ts'
import { processTable } from '../../tools/perf/src/launch.ts'
import { PROMPT, STEP_MS, until, type Kea, type KeaRun } from './app.ts'
import { sysKey } from './keys.ts'

/** A demo repository (repo factory `tiny`) inside the run's home, so the run's cleanup removes it. */
export function demoRepo(run: KeaRun, name = 'demo'): FixtureRepo {
  return tinyRepo({ name, parent: run.home })
}

/** A plain folder (no repository) inside the run's home, with one file. */
export function plainFolder(run: KeaRun, name = 'notes'): string {
  const dir = path.join(run.home, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n')
  return fs.realpathSync(dir)
}

/** The sidebar row of a project (level 1) by its name. */
export function projectRow(page: Page, name: string): Locator {
  return page.locator(`[role=treeitem][aria-level="1"][aria-label=${JSON.stringify(name)}]`)
}

/** The sidebar row of a session by its id. */
export function sessionRow(page: Page, id: string): Locator {
  return page.locator(`[role=treeitem][data-session-id="${id}"]`)
}

/** ⌘O with `root` queued as the picker's answer; resolves once the project's row is in the sidebar. */
export async function addProject(kea: Kea, root: string, name = path.basename(root)): Promise<void> {
  await kea.app.evaluate((_e, p) => (globalThis as unknown as { __keaTest: { queueFolder(p: string): void } }).__keaTest.queueFolder(p), root)
  const page = await kea.page()
  await page.keyboard.press(sysKey('Meta+o'))
  await projectRow(page, name).waitFor({ timeout: STEP_MS })
}

/** Every session row's id, top to bottom (archived groups included only while open). */
export async function sessionIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('[role=treeitem][data-session-id]')].map((e) => e.getAttribute('data-session-id') ?? ''))
}

export interface RowState {
  lifecycle: string
  status: string
  title: string
  selected: boolean
}

/** What a session's row says now (null: not listed). */
export async function rowState(page: Page, id: string): Promise<RowState | null> {
  return page.evaluate((sid) => {
    const e = document.querySelector(`[role=treeitem][data-session-id="${sid}"]`)
    if (!e) return null
    return { lifecycle: e.getAttribute('data-lifecycle') ?? '', status: e.getAttribute('data-status') ?? '', title: e.getAttribute('aria-label') ?? '', selected: e.getAttribute('aria-selected') === 'true' }
  }, id)
}

/** Wait until a session's row satisfies `pred`. */
export async function waitRow(kea: Kea, id: string, what: string, pred: (r: RowState) => boolean, ms = STEP_MS): Promise<RowState> {
  const page = await kea.page()
  let last: RowState | null = null
  return until(
    `session ${id}: ${what}`,
    async () => {
      last = await rowState(page, id)
      return last && pred(last) ? last : undefined
    },
    ms,
  ).catch((e: Error) => {
    throw new Error(`${e.message} (last: ${JSON.stringify(last)})`)
  })
}

/** The prompt of the composer. */
export function promptBox(page: Page): Locator {
  return page.getByRole('region', { name: 'New session' }).getByRole('textbox', { name: 'Prompt' })
}

/**
 * ⌘N, type `prompt`, then ⌘↵ (or ⌥⌘↵ with `background`), as a person does; resolves with the new session's id once its
 * row is listed. With `open: false` the composer is already open and ⌘N is not pressed. `beforeStart` runs
 * just before the key that starts it (the ⌘↵-to-row budget, P-UI-4, arms its probe there).
 */
export async function startSession(kea: Kea, prompt: string, o: { background?: boolean; open?: boolean; beforeStart?: () => Promise<unknown> } = {}): Promise<string> {
  const page = await kea.page()
  const before = new Set(await sessionIds(page))
  if (o.open !== false) await page.keyboard.press(sysKey('Meta+n'))
  const box = promptBox(page)
  await until('the composer’s prompt to take the keyboard', () => box.evaluate((e) => e === document.activeElement).catch(() => false) || undefined)
  if (prompt) await page.keyboard.insertText(prompt)
  await until('the prompt to hold the text', async () => (await box.inputValue()) === prompt || undefined)
  // Start is enabled once validation answered without a hard problem
  await until('Start to be enabled', () => page.getByRole('button', { name: 'Start', exact: true }).isEnabled().catch(() => false) || undefined)
  await o.beforeStart?.()
  await page.keyboard.press(o.background ? sysKey('Alt+Meta+Enter') : sysKey('Meta+Enter'))
  return until('the new session’s row', async () => (await sessionIds(page)).find((x) => !before.has(x)))
}

/** Wait until the session is live (its agent running). */
export function waitLive(kea: Kea, id: string, ms = STEP_MS): Promise<RowState> {
  return waitRow(kea, id, 'live', (r) => r.lifecycle === 'live', ms)
}

/** Select a session with a click on its row, as a person does; resolves once the main pane shows it. */
export async function selectSession(kea: Kea, id: string): Promise<void> {
  const page = await kea.page()
  // near its left edge, on the title: a hovered row shows its actions (Archive, Retry teardown) on the right
  const row = sessionRow(page, id)
  const box = await row.boundingBox({ timeout: STEP_MS })
  await row.click({ timeout: STEP_MS, ...(box ? { position: { x: Math.min(box.width / 4, 40), y: box.height / 2 } } : {}) })
  await until(`session ${id} in the main pane`, () => paneSession(page).then((p) => p === id || undefined))
}

/** The session the main pane shows, if any (`__keaProbe.pane()`). */
export async function paneSession(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const p = (window as unknown as { __keaProbe: { pane(): { kind: string; id?: string } } }).__keaProbe.pane()
    return p.kind === 'session' ? (p.id ?? null) : null
  })
}

/** The ptyId of the shown session's tab of `kind` (agent, setup, shell…), once it is there. */
export async function tabOf(kea: Kea, kind: string): Promise<string> {
  const page = await kea.page()
  // in the split the Agent terminal has no tab: the agent pane names it
  return until(`a ${kind} tab`, () => page.evaluate((k) => document.querySelector(`[role=tablist][aria-label=Terminals] [role=tab][data-kind="${k}"], .agent-pane[data-kind="${k}"][data-pty]`)?.getAttribute('data-pty') ?? undefined, kind))
}

/** The kinds of the shown session's tabs, in strip order (`agent`, `shell`, `script`). */
export async function tabKinds(page: Page): Promise<string[]> {
  return page.locator('[role=tablist][aria-label=Terminals] [role=tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind') ?? ''))
}

/** The kind of the shown session's terminal tab on screen (`agent`, `shell`, `script`); null while none is the active tab. */
export async function activeTabKind(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('[role=tablist][aria-label=Terminals] [role=tab][aria-selected=true]')?.getAttribute('data-kind') ?? null)
}

/**
 * Show a session and wait until its Agent terminal is on screen (its tab in one column, the agent pane in the split)
 * with the shell pseudo-agent's prompt; resolves with the agent's ptyId.
 */
export async function agentTerminal(kea: Kea, id: string): Promise<string> {
  const page = await kea.page()
  if ((await paneSession(page)) !== id) await selectSession(kea, id)
  const pty = await tabOf(kea, 'agent')
  await until('the Agent terminal on screen', async () => (await kea.onScreen()).includes(pty) || undefined)
  await until('the agent shell’s prompt', async () => (await kea.terminalText(pty)).includes(PROMPT) || undefined)
  return pty
}

/** Open a session's context menu (right-click its row) and pick the item running `command` (`data-command`). */
export async function sessionMenu(kea: Kea, id: string, command: string): Promise<void> {
  const page = await kea.page()
  await sessionRow(page, id).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Session menu' })
  await menu.locator(`[role=menuitem][data-command="${command}"]`).click({ timeout: STEP_MS })
}

/** The menu items (their `data-command`) a context menu lists, in order. */
export async function menuCommands(page: Page, name: string): Promise<string[]> {
  const menu = page.getByRole('menu', { name })
  await menu.waitFor({ timeout: STEP_MS })
  return menu.locator('[role=menuitem]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command') ?? ''))
}

/**
 * Wait until the shell of `ptyId` runs `program` in the foreground: a child of the holder's shell with that executable
 * (after its exec, so the shell has already made it the terminal's foreground job, which is what core's busy check
 * reads). A key typed before that point would race the shell.
 */
export async function waitForeground(run: KeaRun, ptyId: string, program: string): Promise<void> {
  const shell = run.holder(ptyId).childPid
  await until(`${program} in the foreground of ${ptyId}`, () => processTable().some((p) => p.ppid === shell && path.basename(p.comm) === program) || undefined)
}
