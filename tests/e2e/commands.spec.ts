// Commands: the palette, the menu bar, keybindings.json, tooltips and key routing, with tools/fake-agent as Claude Code
// (Kea launched through tests/e2e/fixtures.ts). Keys are real key events; the menu bar is read from main's application
// menu and an item is chosen by its click handler, so no menu opens on screen. Nothing reaches the person's editor,
// browser, file manager or clipboard: the editor is a fake one, links and reveals are recorded by main, and copy and
// paste are clipboard events made in the page with their own data (what the Edit menu's roles fire).

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { COMMANDS, L, MAIN_COMMANDS, protocolOs, toAccelerator } from '@kea/protocol'
import { counterCommand, counterNumbers, PROMPT, shq, STEP_MS, until, type Kea, type KeaRun } from '../support/app.ts'
import { AGENT_MARK, claudeByDefault, fakeAgentTerminal, gate, startFakeSession } from '../support/app-fake-agent.ts'
import { finder, finderRows, waitChanges, waitTree } from '../support/app-files.ts'
import { chooseMenuItem, focusIn, keyboardList, keyboardRows, menuBar, menuItem, openPalette, palette, paletteInput, paletteRows, tooltip, waitMenuItem, waitPalette, writeKeybindings } from '../support/app-palette.ts'
import { clipboard, commitFiles, EditorWorld, listening, opened, recordClipboard, serverAddress, serverScript, waitServer, worktreesOf } from '../support/app-server.ts'
import { addProject, demoRepo, paneSession, projectRow, rowState, sessionIds, tabKinds, tabOf, waitRow } from '../support/app-sessions.ts'
import { fileTabs, viewerShown } from '../support/app-tabs.ts'
import { commitAll, writeFiles } from '../support/app-viewer.ts'
import { expect, test } from './fixtures.ts'
import { sysAccel, sysKey, sysLabel, TERMINAL_TEXT_KEYS } from '../support/keys.ts'

/** A fake agent's screen: its mark, the prompt, then `lines` (YAML flow sequence). */
const frame = (...lines: string[]) => `frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', ...lines])}`

/** An agent at its prompt: every line entered there is written back, so a test sees what reached it. */
const AT_PROMPT = ['steps:', `  - ${frame()}`, 'onLine:', '  - print: "GOT {{line}}\\r\\n"'].join('\n')

const NESTED = { 'packages/app/src/main.ts': 'export const main = 1\n', 'packages/app/src/util.ts': 'export const util = 2\n' }

/** A key of the person's own in `keybindings.json`: as the file writes it, as it is pressed, as a chip shows it. */
interface OwnKey {
  file: string
  press: string
  label: string
}
/**
 * Keys no command has on this system, given to Toggle Sidebar (E-KB-2), Settings and Show Disk Usage (E-KB-4): `⇧⌘…`
 * on macOS; on Linux with Alt, since `cmd+shift+…` reads as Ctrl+Shift+… there and Ctrl+Shift+U is IBus's.
 */
const ownKey = (mac: OwnKey, linux: OwnKey): OwnKey => (protocolOs.system === 'linux' ? linux : mac)
const MY_SIDEBAR = ownKey({ file: 'cmd+shift+y', press: 'Meta+Shift+y', label: '⇧⌘Y' }, { file: 'ctrl+shift+alt+y', press: 'Control+Shift+Alt+y', label: 'Ctrl+Shift+Alt+Y' })
const MY_SETTINGS = ownKey({ file: 'cmd+shift+u', press: 'Meta+Shift+u', label: '⇧⌘U' }, { file: 'ctrl+shift+alt+u', press: 'Control+Shift+Alt+u', label: 'Ctrl+Shift+Alt+U' })
const MY_DISK = ownKey({ file: 'cmd+shift+d', press: 'Meta+Shift+d', label: '⇧⌘D' }, { file: 'ctrl+shift+alt+d', press: 'Control+Shift+Alt+d', label: 'Ctrl+Shift+Alt+D' })
/** The menu bar's accelerator for a label as this system shows it. */
const accel = (label: string): string => toAccelerator(label) ?? label

declare const __keaProbe: {
  layout(): { drawn: { sidebar: number; tree: number } }
  pane(): { kind: string; id?: string; projectId?: string }
  palette: { usage(id: string): number }
  views(): { ptyId: string; shown: boolean; cols: number; rows: number; findOpen: boolean; decorations: number }[]
  terminal(ptyId: string): { selectAll(): void; clearSelection(): void; hasSelection(): boolean; buffer: { active: { viewportY: number; baseY: number } } } | undefined
}

const sidebarShown = (page: Page): Promise<boolean> => page.evaluate(() => __keaProbe.layout().drawn.sidebar > 0)
const pane = (page: Page): Promise<{ kind: string; id?: string; projectId?: string }> => page.evaluate(() => __keaProbe.pane())
const inTerminal = (kea: Kea): Promise<boolean> => focusIn(kea, '.terminal-host.shown')

/** A click in the shown terminal, as a person does before typing into it (low in it: the palette floats over its top). */
async function clickTerminal(kea: Kea): Promise<void> {
  const page = await kea.page()
  const host = page.locator('.terminal-host.shown')
  const box = await host.boundingBox()
  await host.click({ position: { x: 20, y: Math.max(20, (box?.height ?? 40) - 20) } })
  await until('the keyboard in the terminal', () => inTerminal(kea))
}

/** Type a line at the fake agent's prompt and wait for the agent to write it back: the keyboard is in its terminal. */
async function reachesAgent(kea: Kea, line: string): Promise<void> {
  await kea.type(line)
  await kea.press('Enter')
  await kea.waitScreen(`“${line}” at the agent`, (s) => s.includes(`GOT ${line}`))
}

/** A demo project (with `files` committed) added to the window. */
async function project(kea: Kea, run: KeaRun, files: Record<string, string> = {}, name = 'demo'): Promise<string> {
  const repo = demoRepo(run, name)
  if (Object.keys(files).length > 0) {
    writeFiles(repo.root, files)
    commitAll(repo.root, 'Add files')
  }
  await addProject(kea, repo.root, name)
  return repo.root
}

test('E-PAL-1 · the palette: ⌘⇧P finds a session by a few letters and ↵ shows it with the keyboard in its terminal; > lists commands only, each with its key, and Run Dev Server dimmed with its reason where there is no start.sh, ↵ on it opening the project’s settings; a command run from it leaves the keyboard in the terminal; a project’s row starts a session there; / and ⌘P are the finder, and ↵ on a file shows it in the preview tab', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await project(kea, run, NESTED)
  const auth = await startFakeSession(kea, 'e-pal-1-auth', 'fix the auth redirect', AT_PROMPT)
  const docs = await startFakeSession(kea, 'e-pal-1-docs', 'tidy the docs', AT_PROMPT)
  await fakeAgentTerminal(kea, docs.id)
  await clickTerminal(kea)
  const authTitle = (await rowState(page, auth.id))!.title

  // ── a session, by a few letters of its title ──
  await openPalette(kea)
  await expect(palette(page)).toBeVisible()
  await page.keyboard.type('auth')
  const found = await waitPalette(kea, 'the auth session leads', (r) => r[0]?.kind === 'session' && r[0].id === auth.id)
  expect(found[0]).toMatchObject({ section: 'Sessions', title: authTitle, current: true, disabled: false })
  expect(found[0]!.marked.toLowerCase()).toBe('auth')
  expect(found[0]!.detail, 'its project and branch').toContain('demo')
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  await until('the auth session on screen', async () => (await paneSession(page)) === auth.id || undefined)
  await fakeAgentTerminal(kea, auth.id)
  await until('the keyboard in its terminal', () => inTerminal(kea))
  await reachesAgent(kea, 'hello auth')

  // ── > : commands only; the one that cannot run is listed dimmed with its reason ──
  await openPalette(kea)
  await page.keyboard.type('>run dev')
  const cmds = await waitPalette(kea, 'Run Dev Server leads the commands', (r) => r[0]?.id === 'server.toggle')
  expect(cmds.every((r) => r.kind === 'command' && r.section === 'Actions')).toBe(true)
  expect(cmds[0]).toMatchObject({ title: 'Run Dev Server', disabled: true, reason: 'No start.sh in this worktree', detail: 'No start.sh in this worktree', remedy: 'Set a run command…', shortcut: sysLabel('⌘R'), current: true })
  await expect(palette(page).locator('[role=option][data-id="server.toggle"]')).toHaveAttribute('aria-disabled', 'true')
  // ↵ on the dimmed row offers the other way to say what to run: the project's settings
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  const settings = page.getByRole('dialog', { name: 'Settings: Project settings · demo' })
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await until('the keyboard back in the terminal', () => inTerminal(kea))

  // an unavailable command with nothing to offer does nothing on ↵, and the palette stays
  await openPalette(kea)
  await page.keyboard.type('>unarchive')
  const un = await waitPalette(kea, 'Unarchive leads', (r) => r[0]?.id === 'session.unarchive')
  expect(un[0]).toMatchObject({ disabled: true, reason: 'The session is not archived', remedy: '' })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press('Escape')

  // ── a command that runs: its key on the row, and the keyboard in the terminal afterwards ──
  await openPalette(kea)
  await page.keyboard.type('>toggle sidebar')
  const toggle = await waitPalette(kea, 'Toggle Sidebar leads', (r) => r[0]?.id === 'view.toggleSidebar')
  expect(toggle[0]).toMatchObject({ title: 'Toggle Sidebar', shortcut: sysLabel('⌘B'), disabled: false, detail: 'View' })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  await until('the sidebar hidden', async () => !(await sidebarShown(page)) || undefined)
  await until('the keyboard in the terminal', () => inTerminal(kea))
  await reachesAgent(kea, 'after a command')
  // a click on a row runs it too
  await openPalette(kea)
  await page.keyboard.type('>toggle sidebar')
  await waitPalette(kea, 'Toggle Sidebar leads', (r) => r[0]?.id === 'view.toggleSidebar')
  await palette(page).locator('[role=option][data-id="view.toggleSidebar"]').click()
  await until('the sidebar back', async () => (await sidebarShown(page)) || undefined)
  expect(await page.evaluate(() => __keaProbe.palette.usage('view.toggleSidebar'))).toBe(2)

  // ── everything together: a query that a session, a command and the project all match ──
  await openPalette(kea)
  await page.keyboard.type('d')
  const mixed = await waitPalette(kea, 'sessions, commands and the project', (r) => new Set(r.map((x) => x.kind)).size === 3)
  expect([...new Set(mixed.map((r) => r.section))].sort()).toEqual(['Actions', 'Projects', 'Sessions'])
  expect(mixed.length).toBeLessThanOrEqual(L.paletteResults)
  // the sections are whole: no section's rows are split by another's
  const sections = mixed.map((r) => r.section)
  expect(sections.filter((s, i) => i === 0 || s !== sections[i - 1])).toHaveLength(3)

  // ── a project: a new session there ──
  await paletteInput(page).fill('demo')
  const proj = await waitPalette(kea, 'the project leads', (r) => r[0]?.kind === 'project')
  expect(proj[0]).toMatchObject({ section: 'Projects', title: 'demo', detail: 'New session', marked: 'demo' })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  await until('the composer for the project', async () => (await pane(page)).kind === 'composer' || undefined)
  await expect(page.getByRole('region', { name: 'New session' })).toBeVisible()
  await page.keyboard.press('Escape')
  await until('the session back on screen', async () => (await paneSession(page)) === auth.id || undefined)

  // ── files: / in the palette, and ⌘P, are the finder ──
  await openPalette(kea)
  await page.keyboard.type('/util')
  await expect(finder(page)).toBeVisible()
  await expect(palette(page)).toHaveCount(0)
  await until('util.ts leads', async () => (await finderRows(kea))[0]?.path === 'packages/app/src/util.ts' || undefined)
  // without the slash it is the palette again
  await paletteInput(page).fill('util')
  await expect(palette(page)).toBeVisible()
  await expect(finder(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await openPalette(kea, sysKey('Meta+p'))
  await expect(finder(page)).toBeVisible()
  await page.keyboard.type('main')
  await until('main.ts leads', async () => (await finderRows(kea))[0]?.path === 'packages/app/src/main.ts' || undefined)
  await page.keyboard.press('Enter')
  await expect(finder(page)).toHaveCount(0)
  await until('the file in the viewer', async () => (await viewerShown(kea))?.path === 'packages/app/src/main.ts' || undefined)
  expect(await fileTabs(kea)).toEqual([{ path: 'packages/app/src/main.ts', kind: 'file', pinned: false, selected: true }])
  // from the finder > reaches the commands
  await openPalette(kea, sysKey('Meta+p'))
  await page.keyboard.type('>focus terminal')
  await waitPalette(kea, 'Focus Terminal leads', (r) => r[0]?.id === 'terminal.focus')
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
  await kea.assertUnfocused()
})

test('E-PAL-2 · palette details: an empty query lists the session that needs you, then the recent ones, then the most-used commands; Esc gives the keyboard back to the terminal or the tree it came from, ⌘⇧P and ⌘P pressed while it is open keep it and change what it lists, and a press outside closes it; ⌘↵ on a session opens it in the editor and the window stays where it was; New Session in Project… lists the projects in the palette, Backspace goes back, and the project picked gets the composer', async ({ run, launch }) => {
  const editors = new EditorWorld(run)
  editors.editor('vscode')
  claudeByDefault(run)
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  const root = await project(kea, run, NESTED)
  const first = await startFakeSession(kea, 'e-pal-2-first', 'write the first thing', AT_PROMPT)
  const second = await startFakeSession(kea, 'e-pal-2-second', 'write the second thing', AT_PROMPT)
  const ask = gate(run, 'e-pal-2-ask')
  const asks = await startFakeSession(
    kea,
    'e-pal-2-asks',
    'asks for permission',
    `steps:
  - hook: UserPromptSubmit
  - ${frame('✶ Working…')}
  - ${ask.step}
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
  - ${frame('Bash(npm test)  Allow? (y/n)')}
  - wait: { answer: y }
`,
    { background: true },
  )
  // the composer the background start left open goes; the second session is on screen again
  await page.keyboard.press('Escape')
  await fakeAgentTerminal(kea, second.id)
  await clickTerminal(kea)
  await ask.open()
  await waitRow(kea, asks.id, 'needs you', (r) => r.status === 'needsYou')

  // ── the empty query ──
  const STARTERS = ['session.new', 'project.add', 'files.goToFile', 'server.toggle', 'session.openInEditor', 'app.settings']
  await openPalette(kea)
  await expect(paletteInput(page)).toHaveValue('')
  const empty = await waitPalette(kea, 'the session that needs you leads', (r) => r[0]?.id === asks.id)
  // the session that needs you, then the one seen before this one (the one on screen is not offered), then the commands
  expect(empty.map((r) => `${r.section}:${r.id}`)).toEqual([`Sessions:${asks.id}`, `Sessions:${first.id}`, ...STARTERS.map((id) => `Actions:${id}`)])
  expect(STARTERS).toHaveLength(L.paletteRecentCommands)
  expect(empty[0]).toMatchObject({ kind: 'session', current: true })
  await expect(palette(page).locator(`[role=option][data-id="${asks.id}"] .kea-glyph`)).toHaveAttribute('data-glyph', 'needsYou')
  // ↓ ↑ walk the rows and wrap
  await page.keyboard.press('ArrowUp')
  await waitPalette(kea, 'the last row is current', (r) => r.at(-1)?.current === true)
  await page.keyboard.press('ArrowDown')
  await waitPalette(kea, 'the first row again', (r) => r[0]?.current === true)

  // ── Esc gives the keyboard back to where it was ──
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
  expect(await inTerminal(kea), 'back in the terminal').toBe(true)
  await reachesAgent(kea, 'back in the terminal')
  // … to the tree, when it came from there; pressed again while open, ⌘⇧P keeps it, with its text selected
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
  await page.keyboard.press(sysKey('Meta+Shift+e'))
  await until('the keyboard in the tree', () => focusIn(kea, '[role=tree]'))
  await openPalette(kea)
  await page.keyboard.type('zzz')
  await expect(palette(page).getByRole('status')).toHaveText('No match.')
  await openPalette(kea)
  await expect(palette(page)).toBeVisible()
  expect(await paletteInput(page).evaluate((e: HTMLInputElement) => [e.value, e.selectionStart, e.selectionEnd])).toEqual(['zzz', 0, 3])
  // ⌘P while it is open: the same layer, now the finder; ⌘⇧P: the palette again
  await openPalette(kea, sysKey('Meta+p'))
  await expect(finder(page)).toBeVisible()
  await expect(page.locator('.palette')).toHaveCount(1)
  await openPalette(kea)
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toHaveCount(0)
  expect(await focusIn(kea, '[role=tree]'), 'back in the tree').toBe(true)
  // a press outside closes it, and the press goes where it was aimed
  await openPalette(kea)
  await clickTerminal(kea)
  await expect(page.locator('.palette')).toHaveCount(0)
  await reachesAgent(kea, 'after a press outside')

  // ── ⌘↵ on a session opens it in the editor; the window stays on the session it showed ──
  await openPalette(kea)
  await page.keyboard.type('first thing')
  const hit = await waitPalette(kea, 'the first session leads', (r) => r[0]?.id === first.id)
  const branch = hit[0]!.detail.split(' · ')[1] ?? ''
  expect(branch, 'the row names the session’s branch').not.toBe('')
  await page.keyboard.press(sysKey('Meta+Enter'))
  await expect(page.locator('.palette')).toHaveCount(0)
  const launches = await editors.waitLaunches(1)
  const dir = worktreesOf(root).find((w) => w.branch === branch)?.dir
  expect(dir, `a worktree on ${branch}`).toBeTruthy()
  expect(launches.at(-1)!.argv.map((a) => (fs.existsSync(a) ? fs.realpathSync(a) : a)), 'the editor was given the first session’s folder').toContain(fs.realpathSync(dir as string))
  expect(await paneSession(page)).toBe(second.id)
  expect(await inTerminal(kea), 'the keyboard where it was').toBe(true)

  // ── a command that needs an argument asks for it in the palette ──
  await project(kea, run, {}, 'other')
  const otherId = await projectRow(page, 'other').getAttribute('data-project-id')
  await openPalette(kea)
  await page.keyboard.type('>new session in')
  const cmd = await waitPalette(kea, 'New Session in Project… leads', (r) => r[0]?.id === 'session.newInProject')
  expect(cmd[0]).toMatchObject({ title: 'New Session in Project…', shortcut: sysLabel('⌘⇧N'), disabled: false })
  await page.keyboard.press('Enter')
  const choices = await waitPalette(kea, 'the projects', (r) => r.length === 2 && r.every((x) => x.kind === 'choice'))
  expect(choices.map((r) => [r.section, r.title])).toEqual([
    ['New Session in Project…', 'demo'],
    ['New Session in Project…', 'other'],
  ])
  await expect(page.locator('.palette')).toHaveAttribute('data-mode', 'argument')
  await expect(paletteInput(page)).toHaveValue('')
  await expect(paletteInput(page)).toHaveAttribute('placeholder', 'New session in project…')
  // typing narrows the choices
  await page.keyboard.type('oth')
  const narrowed = await waitPalette(kea, 'one project left', (r) => r.length === 1)
  expect(narrowed[0]).toMatchObject({ title: 'other', marked: 'oth', current: true })
  // Backspace in the empty input goes back to the commands
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
  await waitPalette(kea, 'both projects again', (r) => r.length === 2 && r.every((x) => x.kind === 'choice'))
  await page.keyboard.press('Backspace')
  await waitPalette(kea, 'the empty palette again', (r) => r[0]?.kind === 'session')
  await expect(page.locator('.palette')).toHaveAttribute('data-mode', 'all')
  // picked: the composer opens for that project, with no project picker in between
  await page.keyboard.type('>new session in')
  await waitPalette(kea, 'New Session in Project… leads', (r) => r[0]?.id === 'session.newInProject')
  await page.keyboard.press('Enter')
  await waitPalette(kea, 'the projects', (r) => r.length === 2 && r.every((x) => x.kind === 'choice'))
  await page.keyboard.press('ArrowDown')
  await waitPalette(kea, 'other is current', (r) => r[1]?.current === true)
  await page.keyboard.press('Enter')
  await expect(page.locator('.palette')).toHaveCount(0)
  await until('the composer for the other project', async () => {
    const p = await pane(page)
    return (p.kind === 'composer' && p.projectId === otherId) || undefined
  })
  await page.keyboard.press('Escape')
  await until('the session back on screen', async () => (await paneSession(page)) === second.id || undefined)

  // ── what the palette ran most leads the commands of the empty query ──
  for (const shown of [false, true]) {
    await openPalette(kea)
    await page.keyboard.type('>toggle sidebar')
    await waitPalette(kea, 'Toggle Sidebar leads', (r) => r[0]?.id === 'view.toggleSidebar')
    await page.keyboard.press('Enter')
    await until(`the sidebar ${shown ? 'back' : 'hidden'}`, async () => (await sidebarShown(page)) === shown || undefined)
  }
  await openPalette(kea)
  const used = await waitPalette(kea, 'the commands by use', (r) => r.some((x) => x.id === 'view.toggleSidebar'))
  expect(used.filter((r) => r.kind === 'command').map((r) => r.id)).toEqual(['view.toggleSidebar', 'session.newInProject', ...STARTERS.slice(0, L.paletteRecentCommands - 2)])
  // > alone: every command, the most used first
  await page.keyboard.type('>')
  const all = await waitPalette(kea, 'the commands', (r) => r.length > L.paletteRecentCommands && r.every((x) => x.kind === 'command'))
  expect(all.slice(0, 2).map((r) => r.id)).toEqual(['view.toggleSidebar', 'session.newInProject'])
  expect(all).toHaveLength(Math.min(COMMANDS.length, L.paletteResults))
  await page.keyboard.press('Escape')
  await kea.assertUnfocused()
})

const REGIONS = [
  ['the sidebar', 'aside.sidebar-column'],
  ['the file panel', 'section.file-panel'],
  ['the header', '.main-header'],
  ['the terminal', '.terminal-host.shown'],
] as const

/** F6 until the keyboard is in the region (sidebar, file panel, header, terminal, in that order). */
async function focusRegion(kea: Kea, selector: string): Promise<void> {
  const page = await kea.page()
  for (let i = 0; i < REGIONS.length && !(await focusIn(kea, selector)); i++) await page.keyboard.press('F6')
  await until(`the keyboard in ${selector}`, () => focusIn(kea, selector))
}

/** Resolves after `n` animation frames of the page: what a key pressed before them changed is drawn by then. */
const frames = (page: Page, n: number): Promise<void> =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count
        const f = (): void => void (--left > 0 ? requestAnimationFrame(f) : resolve())
        requestAnimationFrame(f)
      }),
    n,
  )

const shownView = (page: Page): Promise<{ ptyId: string; findOpen: boolean; decorations: number } | undefined> => page.evaluate(() => __keaProbe.views().find((v) => v.shown))

test('E-KB-2 · keyboard details: the app’s shortcuts act from the sidebar, the file panel, the header and the terminal alike; ⌘W on the Agent tab closes nothing and the menu’s Close Tab is disabled there; ⌘R never reloads the window; a tooltip names its command’s key; keybindings.json changes a key live — the router, the menu bar, the palette, the tooltip and the keyboard list all follow, a conflict and the entries left out are reported, a file that does not parse keeps the keys that did, and without the file the defaults are back', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await project(kea, run, NESTED)
  const s = await startFakeSession(kea, 'e-kb-2', 'keys everywhere', AT_PROMPT)
  const agent = await fakeAgentTerminal(kea, s.id)
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
  await clickTerminal(kea)
  await page.keyboard.press(sysKey('Meta+t'))
  const shell = await until('the shell tab on screen', async () => {
    const id = await kea.shown()
    return id && id !== agent ? id : undefined
  })
  await kea.waitScreen('the shell’s prompt', (x) => x.includes(PROMPT))
  await page.keyboard.press(sysKey('Meta+Shift+['))
  await until('the Agent tab on screen again', async () => (await kea.shown()) === agent || undefined)

  // ── every command of the table is in the menu bar; nothing there reloads the window ──
  const menu = await menuBar(kea)
  // an item in Help is `help:<id>` (macOS has Keyboard Shortcuts and Copy Diagnostics in the app menu as well; Linux in Help only)
  const ids = new Set(menu.map((m) => m.id.replace(/^help:/, '')))
  expect(COMMANDS.map((c) => c.id).filter((id) => !ids.has(id)), 'commands with no menu item').toEqual(['app.openKea'])
  expect(menu.filter((m) => m.role === 'reload' || m.role === 'forcereload' || m.role === 'forceReload')).toEqual([])
  expect(menu.filter((m) => m.accelerator === sysAccel('⌘R')).map((m) => m.id)).toEqual(['server.toggle'])
  expect(menu.find((m) => m.id === 'terminal.copy')).toMatchObject({ role: 'copy', menu: 'Edit' })
  expect(menu.find((m) => m.id === 'help:app.shortcuts')).toMatchObject({ label: 'Keyboard Shortcuts', enabled: true })
  // titles and availability follow the window's state
  expect(menu.find((m) => m.id === 'server.toggle')).toMatchObject({ label: 'Run Dev Server', enabled: false })
  expect(menu.find((m) => m.id === 'files.toggleIgnored')).toMatchObject({ menu: 'Files', enabled: true })
  expect(menu.find((m) => m.id === 'files.refresh')).toMatchObject({ menu: 'Files', enabled: true })
  for (const id of MAIN_COMMANDS.filter((x) => x !== 'app.openKea')) expect(menu.filter((m) => m.id === id), id).toHaveLength(1)

  // ── the same keys from every region ──
  for (const [name, selector] of REGIONS) {
    const where = `from ${name}`
    // ⌘⇧P and ⌘P: the palette and the finder; Esc gives the keyboard back to the region
    await focusRegion(kea, selector)
    await openPalette(kea)
    await expect(palette(page), where).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.palette')).toHaveCount(0)
    expect(await focusIn(kea, selector), `the keyboard back in ${name}`).toBe(true)
    await openPalette(kea, sysKey('Meta+p'))
    await expect(finder(page), where).toBeVisible()
    await page.keyboard.press('Escape')
    expect(await focusIn(kea, selector), `the keyboard back in ${name}`).toBe(true)
    // ⌘B hides the sidebar and shows it again
    await page.keyboard.press(sysKey('Meta+b'))
    await until(`the sidebar hidden ${where}`, async () => !(await sidebarShown(page)) || undefined)
    await page.keyboard.press(sysKey('Meta+b'))
    await until(`the sidebar back ${where}`, async () => (await sidebarShown(page)) || undefined)
    // ⌘⇧] and ⌘⇧[: the next tab and back
    await focusRegion(kea, selector)
    await page.keyboard.press(sysKey('Meta+Shift+]'))
    await until(`the shell tab ${where}`, async () => (await kea.shown()) === shell || undefined)
    await focusRegion(kea, selector)
    await page.keyboard.press(sysKey('Meta+Shift+['))
    await until(`the Agent tab ${where}`, async () => (await kea.shown()) === agent || undefined)
    // ⌘+ and ⌘0: the terminal's font, and the menu bar's Reset Font Size follows
    await focusRegion(kea, selector)
    await page.keyboard.press(sysKey('Meta+Equal'))
    await waitMenuItem(kea, 'terminal.fontReset', `enabled ${where}`, (m) => m.enabled)
    await page.keyboard.press(sysKey('Meta+0'))
    await waitMenuItem(kea, 'terminal.fontReset', `disabled again ${where}`, (m) => !m.enabled)
    // ⌘F: the find bar of the terminal on screen
    await focusRegion(kea, selector)
    await page.keyboard.press(sysKey('Meta+f'))
    await until(`the find bar ${where}`, async () => (await shownView(page))?.findOpen || undefined)
    await page.keyboard.press('Escape')
    await until('the find bar closed', async () => (await shownView(page))?.findOpen === false || undefined)
    // ⌘,: Settings
    await focusRegion(kea, selector)
    await page.keyboard.press(sysKey('Meta+,'))
    await expect(page.getByRole('dialog', { name: /^Settings: / }), where).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /^Settings: / })).toHaveCount(0)
  }

  // ── ⌘W on the Agent tab closes nothing; ⌘R reloads nothing ──
  await clickTerminal(kea)
  expect(await kea.shown()).toBe(agent)
  expect(await menuItem(kea, 'terminal.closeTab')).toMatchObject({ label: 'Close Tab', enabled: false, accelerator: sysAccel('⌘W') })
  const tabsBefore = await tabKinds(page)
  await page.evaluate(() => void ((window as unknown as { __keaMark: number }).__keaMark = 1))
  await page.keyboard.press(sysKey('Meta+w'))
  await page.keyboard.press(sysKey('Meta+r'))
  // the keys went nowhere: the agent got neither, and the next line it reads is whole
  await reachesAgent(kea, 'still here')
  expect(await tabKinds(page)).toEqual(tabsBefore)
  expect(await paneSession(page)).toBe(s.id)
  expect(await page.evaluate(() => (window as unknown as { __keaMark?: number }).__keaMark), 'the window was not reloaded').toBe(1)
  expect((await kea.screen()).includes('GOT wstill here') || (await kea.screen()).includes('GOT rstill here')).toBe(false)
  // on the shell tab Close Tab is there to be chosen, and ⌘W closes it
  await page.keyboard.press(sysKey('Meta+Shift+]'))
  await until('the shell tab', async () => (await kea.shown()) === shell || undefined)
  await waitMenuItem(kea, 'terminal.closeTab', 'enabled on a shell tab', (m) => m.enabled)
  await page.keyboard.press(sysKey('Meta+w'))
  await until('the shell tab closed', async () => (await tabKinds(page)).length === tabsBefore.length - 1 || undefined)
  await until('the Agent tab on screen', async () => (await kea.shown()) === agent || undefined)

  // ── a tooltip names the command and its key ──
  const plus = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: `New Session (${sysLabel('⌘N')})` })
  await plus.hover()
  await expect(tooltip(page)).toBeVisible()
  await expect(tooltip(page).locator('span')).toHaveText('New Session')
  await expect(tooltip(page).locator('kbd')).toHaveText(sysLabel('⌘N'))
  // it never takes the pointer, and it goes when the pointer does
  expect(await tooltip(page).evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none')
  await page.locator('.terminal-host.shown').hover()
  await expect(tooltip(page)).toHaveCount(0)

  // ── keybindings.json, live ──
  // Restart Dev Server's key, as this system shows it: `⇧⌘R` (glyphs) on macOS, `Ctrl+Shift+F5` (words) on Linux
  const RESTART = sysLabel('⇧⌘R')
  writeKeybindings(
    run,
    `// my keys
[
  { "command": "view.toggleSidebar", "key": "${MY_SIDEBAR.file}" },
  { "command": "terminal.newShell", "key": "${RESTART}" }, // takes Restart Dev Server's key
  { "command": "no.such.command", "key": "cmd+u" },
  { "command": "files.refresh", "key": "ctrl+x" },
  { "command": "session.archive", "key": null },
]
`,
  )
  // the menu bar shows the keys now
  await waitMenuItem(kea, 'view.toggleSidebar', 'the new key', (m) => m.accelerator === accel(MY_SIDEBAR.label))
  expect(await menuItem(kea, 'terminal.newShell')).toMatchObject({ accelerator: accel(RESTART) })
  expect(await menuItem(kea, 'server.restart'), 'the key it lost').toMatchObject({ accelerator: '' })
  expect(await menuItem(kea, 'session.archive'), 'a key taken away').toMatchObject({ accelerator: '' })
  expect(await menuItem(kea, 'files.refresh'), 'an entry left out changes nothing').toMatchObject({ accelerator: '' })
  // the router: the new key acts, the old one no longer does
  await clickTerminal(kea)
  await page.keyboard.press(MY_SIDEBAR.press)
  await until('the sidebar hidden by the new key', async () => !(await sidebarShown(page)) || undefined)
  await page.keyboard.press(sysKey('Meta+b'))
  await frames(page, 3)
  expect(await sidebarShown(page), '⌘B no longer toggles it').toBe(false)
  await page.keyboard.press(MY_SIDEBAR.press)
  await until('the sidebar back', async () => (await sidebarShown(page)) || undefined)
  // the conflict: ⇧⌘R is New Shell Tab's now
  await page.keyboard.press(sysKey('Meta+Shift+r'))
  const second = await until('a shell tab opened by ⇧⌘R', async () => {
    const id = await kea.shown()
    return id && id !== agent ? id : undefined
  })
  expect(second).not.toBe(shell)
  await page.keyboard.press(sysKey('Meta+Shift+['))
  await until('the Agent tab on screen', async () => (await kea.shown()) === agent || undefined)
  // the palette's chip and the tooltip say the key now
  await openPalette(kea)
  await page.keyboard.type('>toggle sidebar')
  const row = await waitPalette(kea, 'Toggle Sidebar leads', (r) => r[0]?.id === 'view.toggleSidebar')
  expect(row[0]!.shortcut).toBe(MY_SIDEBAR.label)
  await page.keyboard.press('Escape')
  const add = page.getByRole('tablist', { name: 'Terminals' }).getByRole('button', { name: `New Shell Tab (${RESTART})` })
  await add.hover()
  await expect(tooltip(page).locator('kbd')).toHaveText(RESTART)
  await expect(tooltip(page).locator('span')).toHaveText('New Shell Tab')
  await page.locator('.terminal-host.shown').hover()

  // the keyboard list (the Keyboard Shortcuts sheet; the same list is Settings › Keyboard)
  expect(await chooseMenuItem(kea, 'help:app.shortcuts')).toBe(true)
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet).toBeVisible()
  const listed = await keyboardRows(kea)
  expect(listed.map((r) => r.id)).toEqual(COMMANDS.map((c) => c.id))
  // each row shows its command's id: an entry of the file names a command by it, and nothing else in Kea says it
  expect(listed.map((r) => r.shownId)).toEqual(COMMANDS.map((c) => c.id))
  const of = (id: string) => listed.find((r) => r.id === id)
  expect(of('view.toggleSidebar')).toMatchObject({ keys: [MY_SIDEBAR.label], changed: true })
  expect(of('terminal.newShell')).toMatchObject({ keys: [RESTART], changed: true })
  expect(of('server.restart')).toMatchObject({ keys: [], changed: false })
  expect(of('session.archive')).toMatchObject({ keys: [], changed: true })
  expect(of('server.toggle')).toMatchObject({ keys: [sysLabel('⌘R')], changed: false })
  expect(of('files.refresh')).toMatchObject({ keys: [], changed: false })
  await expect(keyboardList(page).getByRole('list', { name: 'Conflicts' }).getByRole('listitem')).toHaveText([`${RESTART} is now New Shell Tab; Restart Dev Server has lost it.`])
  const left = await keyboardList(page).getByRole('list', { name: 'Entries left out' }).getByRole('listitem').allTextContents()
  expect(left).toHaveLength(2)
  expect(left[0]).toMatch(/^Entry 3: .*no\.such\.command/)
  expect(left[1]).toMatch(/^Entry 4: /)
  // Open keybindings.json: asked of main, which opens nothing under the harness
  await keyboardList(page).getByRole('button', { name: 'Open keybindings.json' }).click()
  await until('main was asked to open the file', () => kea.logLines('main').some((l) => l.msg === 'home item not opened (perf)') || undefined)

  // a file that does not parse: said so, and the keys that did parse stay in use
  writeKeybindings(run, '[ { "command": "view.toggleSidebar", "key": ')
  await expect(keyboardList(page).getByRole('alert')).toContainText('keybindings.json does not parse')
  expect((await keyboardRows(kea)).find((r) => r.id === 'view.toggleSidebar')).toMatchObject({ keys: [MY_SIDEBAR.label], changed: true })
  expect(await menuItem(kea, 'view.toggleSidebar')).toMatchObject({ accelerator: accel(MY_SIDEBAR.label) })

  // no file: the defaults are back, everywhere
  fs.rmSync(path.join(run.home, 'keybindings.json'))
  await waitMenuItem(kea, 'view.toggleSidebar', 'the default key', (m) => m.accelerator === sysAccel('⌘B'))
  await expect(keyboardList(page).getByRole('alert')).toHaveCount(0)
  await expect(keyboardList(page).getByRole('list', { name: 'Conflicts' })).toHaveCount(0)
  expect((await keyboardRows(kea)).filter((r) => r.changed)).toEqual([])
  expect((await keyboardRows(kea)).find((r) => r.id === 'server.restart')?.keys).toEqual([RESTART])
  // Esc closes the sheet and the keyboard is back in the terminal
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await until('the keyboard in the terminal', () => inTerminal(kea))
  await page.keyboard.press(sysKey('Meta+b'))
  await until('⌘B toggles the sidebar again', async () => !(await sidebarShown(page)) || undefined)
  await page.keyboard.press(sysKey('Meta+b'))
  await until('the sidebar back', async () => (await sidebarShown(page)) || undefined)
  await kea.assertUnfocused()
})

/** A clipboard event made in the page with its own data, sent to the terminal on screen as the Edit menu's role sends one. */
function clipboardEvent(page: Page, type: 'copy' | 'paste', data: { text?: string; image?: boolean } = {}): Promise<{ text: string; prevented: boolean }> {
  return page.evaluate(
    ([kind, d]) => {
      const target = document.querySelector('.terminal-host.shown .xterm-helper-textarea')
      if (!target) throw new Error('no terminal on screen')
      const dt = new DataTransfer()
      if (d.text !== undefined) dt.setData('text/plain', d.text)
      if (d.image) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }))
      const ev = new ClipboardEvent(kind, { clipboardData: dt, bubbles: true, cancelable: true })
      target.dispatchEvent(ev)
      return { text: dt.getData('text/plain'), prevented: ev.defaultPrevented }
    },
    [type, data] as const,
  )
}

test('E-TERM-3 · terminal interactions: in a terminal whose program reads every key raw, keys without ⌘ reach it byte for byte (Esc, ⌃C, ⇧Tab, ⇧↵, ⌥ and function keys), ⌘← ⌘→ ⌘⌫ arrive as ⌃A ⌃E ⌃U, and only F6, ⇧F6, ⌃Tab, ⌃⇧Tab and the ⌘ keys do not; a copy takes the terminal’s selection; a paste reaches the program, an image-only clipboard sends ⌃V, several lines into a shell tab ask first and into the Agent tab do not; find counts and marks its matches; scrolled up, new output leaves the view where it is and Jump to bottom appears', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await project(kea, run)
  const other = await startFakeSession(kea, 'e-term-3-other', 'the other session', AT_PROMPT)
  const s = await startFakeSession(kea, 'e-term-3', 'terminal keys', AT_PROMPT)
  const agent = await fakeAgentTerminal(kea, s.id)
  await clickTerminal(kea)

  // a shell tab running a program that puts the terminal in raw mode, as vim does, and writes back every chunk it reads
  const program = path.join(run.home, 'keys.mjs')
  fs.writeFileSync(program, "process.stdin.setRawMode(true)\nlet n = 0\nprocess.stdout.write('READY\\r\\n')\nprocess.stdin.on('data', (d) => process.stdout.write(`K${++n}:${JSON.stringify(d.toString('latin1'))}\\r\\n`))\n")
  await page.keyboard.press(sysKey('Meta+t'))
  const shell = await until('the shell tab on screen', async () => {
    const id = await kea.shown()
    return id && id !== agent ? id : undefined
  })
  await kea.waitScreen('the shell’s prompt', (x) => x.includes(PROMPT))
  await kea.enter(`${shq(process.execPath)} ${shq(program)}`)
  await kea.waitScreen('the program reading keys', (x) => x.includes('READY'))

  let n = 0
  /** Press `key`; the program's next chunk is `bytes` (null: whatever the key sends, but something). */
  const reaches = async (key: string, bytes: string | null): Promise<void> => {
    await page.keyboard.press(key)
    n++
    const screen = await kea.waitScreen(`${key} at the program`, (x) => x.includes(`K${n}:`))
    if (bytes !== null) expect(screen, key).toContain(`K${n}:${JSON.stringify(bytes)}`)
    expect(screen.includes(`K${n + 1}:`), `${key} sent one chunk`).toBe(false)
  }

  // ── keys without ⌘ reach the program ──
  const KEYS: [string, string | null][] = [
    ['a', 'a'],
    ['Escape', '\x1b'],
    ['Control+c', '\x03'],
    ['Control+d', '\x04'],
    ['Control+z', '\x1a'],
    ['Control+w', '\x17'],
    ['Control+r', '\x12'],
    ['Control+b', '\x02'],
    ['Control+p', '\x10'],
    ['Tab', '\t'],
    ['Shift+Tab', '\x1b[Z'],
    ['Enter', '\r'],
    ['Shift+Enter', '\n'],
    ['ArrowUp', '\x1b[A'],
    ['F1', '\x1bOP'],
    ['F5', '\x1b[15~'],
    ['Shift+F5', null],
    ['Alt+b', null],
    ['Alt+ArrowLeft', null],
    ['Control+ArrowRight', null],
    // the Mac text-editing keys are translated for the PTY (macOS only: Linux has none)
    ...(TERMINAL_TEXT_KEYS
      ? ([
          ['Meta+ArrowLeft', '\x01'],
          ['Meta+ArrowRight', '\x05'],
          ['Meta+Backspace', '\x15'],
        ] as [string, string][])
      : []),
  ]
  for (const [key, bytes] of KEYS) await reaches(key, bytes)
  // ⌃` is the app's only outside the terminal: in it the key is the terminal's (which has no bytes for it) and the
  // keyboard stays
  await page.keyboard.press('Control+`')
  expect(await inTerminal(kea)).toBe(true)
  await reaches('z', 'z')

  // ── the app's intercepts: F6, ⇧F6, ⌃Tab never reach it ──
  await page.keyboard.press('F6')
  await until('F6 moved the keyboard to the sidebar', () => focusIn(kea, 'aside.sidebar-column'))
  // ⌃` outside the terminal gives the keyboard back to it
  await page.keyboard.press('Control+`')
  await until('⌃` gave the keyboard back to the terminal', () => inTerminal(kea))
  await page.keyboard.press('Shift+F6')
  await until('⇧F6 moved the keyboard to the header', () => focusIn(kea, '.main-header'))
  // so does Esc from a region that is not the terminal
  await page.keyboard.press('Escape')
  await until('Esc gave the keyboard back to the terminal', () => inTerminal(kea))
  await reaches('b', 'b')
  await page.keyboard.press('Control+Tab')
  await until('⌃Tab switched to the other session', async () => (await paneSession(page)) === other.id || undefined)
  await page.keyboard.press('Control+Tab')
  await until('⌃Tab switched back', async () => (await paneSession(page)) === s.id || undefined)
  await until('the shell tab on screen again, with the keyboard', async () => ((await kea.shown()) === shell && (await inTerminal(kea))) || undefined)
  await reaches('c', 'c')
  // ⌃⇧Tab, the fourth intercept: the previous session, and back; the program saw none of it
  await page.keyboard.press('Control+Shift+Tab')
  await until('⌃⇧Tab switched to the other session', async () => (await paneSession(page)) === other.id || undefined)
  await page.keyboard.press('Control+Shift+Tab')
  await until('⌃⇧Tab switched back', async () => (await paneSession(page)) === s.id || undefined)
  await until('the shell tab on screen once more, with the keyboard', async () => ((await kea.shown()) === shell && (await inTerminal(kea))) || undefined)
  await reaches('d', 'd')

  // ── copy and paste, as clipboard events with their own data (⌘C and ⌘V are the Edit menu's roles, which fire these
  // events; the keys themselves are never pressed here: they would use the person's clipboard) ──
  await page.evaluate((id) => __keaProbe.terminal(id)?.selectAll(), shell)
  const copied = await clipboardEvent(page, 'copy')
  expect(copied.prevented, 'the terminal put its selection on the event').toBe(true)
  expect(copied.text).toContain('READY')
  expect(copied.text).toContain('K1:"a"')
  await page.evaluate((id) => __keaProbe.terminal(id)?.clearSelection(), shell)
  // with nothing selected a copy is not the terminal's
  expect((await clipboardEvent(page, 'copy')).text).toBe('')
  await reaches('d', 'd')
  // a paste reaches the program; an image-only clipboard sends the agent's image-paste key (⌃V) instead
  await clipboardEvent(page, 'paste', { text: 'pasted' })
  n++
  await kea.waitScreen('the pasted text at the program', (x) => x.includes(`K${n}:"pasted"`))
  expect((await clipboardEvent(page, 'paste', { image: true })).prevented).toBe(true)
  n++
  await kea.waitScreen('⌃V at the program', (x) => x.includes(`K${n}:${JSON.stringify('\x16')}`))
  // several lines into a shell tab ask first: Esc pastes nothing, Paste pastes them
  expect((await clipboardEvent(page, 'paste', { text: 'one\ntwo' })).prevented).toBe(true)
  const ask = page.getByRole('alertdialog', { name: 'Paste into the shell' })
  await expect(ask).toContainText('Paste 2 lines into the shell?')
  await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(ask).toHaveCount(0)
  await until('the keyboard back in the terminal', () => inTerminal(kea))
  await reaches('e', 'e')
  await clipboardEvent(page, 'paste', { text: 'one\ntwo' })
  await ask.getByRole('button', { name: 'Paste' }).click()
  n++
  await kea.waitScreen('both lines at the program', (x) => x.includes(`K${n}:${JSON.stringify('one\rtwo')}`))
  await expect(ask).toHaveCount(0)
  // in the Agent tab several lines are the agent's to take: nothing is asked
  await page.keyboard.press(sysKey('Meta+Shift+['))
  await until('the Agent tab on screen', async () => (await kea.shown()) === agent || undefined)
  await until('the keyboard in it', () => inTerminal(kea))
  expect((await clipboardEvent(page, 'paste', { text: 'alpha\nbeta' })).prevented, 'left to the terminal').toBe(false)
  await expect(ask).toHaveCount(0)

  // a second shell tab, at its prompt, with a few lines to look through
  await page.keyboard.press(sysKey('Meta+t'))
  const plain = await until('a second shell tab', async () => {
    const id = await kea.shown()
    return id && id !== agent && id !== shell ? id : undefined
  })
  await kea.waitScreen('its prompt', (x) => x.includes(PROMPT))
  await kea.enter('echo one-$((1+1))')
  await kea.enter('echo two-$((2+2))')
  await kea.waitScreen('both lines ran', (x) => x.includes('one-2') && x.includes('two-4'))

  // ── find ──
  await page.keyboard.press(sysKey('Meta+f'))
  const field = page.getByRole('search').getByLabel('Find in terminal')
  await expect(field).toBeFocused()
  await page.keyboard.type('two-')
  const count = page.locator('.find-bar .find-count')
  await expect(count).toHaveText(/^\d+ of \d+$/)
  const total = Number((await count.textContent())!.split(' of ')[1])
  expect(total, 'the command line and its output').toBeGreaterThanOrEqual(2)
  expect((await shownView(page))!.decorations, 'the matches are marked').toBeGreaterThan(0)
  const first = await count.textContent()
  await page.keyboard.press('Enter')
  await expect(count).not.toHaveText(first as string)
  await page.keyboard.press('Shift+Enter')
  await expect(count).toHaveText(first as string)
  await page.keyboard.type('nothing-like-it')
  await expect(count).toHaveText('No results')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('search')).toHaveCount(0)
  await until('the keyboard back in the terminal', () => inTerminal(kea))
  // nothing of the search is left in the terminal (xterm can keep a removed decoration when several go in one batch, so
  // a query narrowed letter by letter would leave a mark)
  await until('the marks gone', async () => (await shownView(page))?.decorations === 0 || undefined)

  // ── scrolled up, new output leaves the view where it is ──
  await kea.enter(counterCommand(200))
  await kea.waitScreen('the counter running', (x) => counterNumbers(x).length > 5)
  const at = (): Promise<{ top: number; base: number }> =>
    page.evaluate((id) => {
      const b = __keaProbe.terminal(id)!.buffer.active
      return { top: b.viewportY, base: b.baseY }
    }, plain)
  await until('output past one screen', async () => (await at()).base > 30 || undefined)
  const host = (await page.locator('.terminal-host.shown').boundingBox())!
  await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2)
  await page.mouse.wheel(0, -400)
  const jump = page.getByRole('button', { name: 'Jump to bottom' })
  await expect(jump).toBeVisible()
  const up = await at()
  expect(up.top).toBeLessThan(up.base)
  await until('more output below', async () => (await at()).base > up.base + 100 || undefined)
  expect((await at()).top, 'the view stayed where it was').toBe(up.top)
  await jump.click()
  await until('at the bottom', async () => {
    const p = await at()
    return p.top === p.base || undefined
  })
  await expect(jump).toHaveCount(0)
  expect(await inTerminal(kea), 'the button did not take the keyboard').toBe(true)
  // typing jumps to the bottom too
  await page.mouse.wheel(0, -400)
  await expect(jump).toBeVisible()
  await page.keyboard.press('x')
  await expect(jump).toHaveCount(0)
  await page.keyboard.press('Control+c')
  await kea.waitScreen('the counter stopped at a prompt', (x) => x.trimEnd().endsWith(PROMPT.trimEnd()))
  await kea.assertUnfocused()
})

test('E-KB-1 · the mouse-free tour: with keys alone a project is added (⌘O), a session started (⌘N, ⌘↵), the session asking for permission reached (⌘J) and answered, the changed file’s diff opened (⌘⇧G, ↵), the dev server run (⌘R), the worktree opened in VS Code (⌘⇧O) and the session archived (⌘⇧⌫); the keyboard is in the terminal whenever nothing else holds it, and no pointer event reaches the window', async ({ run, launch }) => {
  const editors = new EditorWorld(run)
  editors.editor('vscode')
  claudeByDefault(run)
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await page.evaluate(() => {
    const w = window as unknown as { __keaPointer: string[] }
    w.__keaPointer = []
    for (const type of ['pointerdown', 'mousedown', 'wheel']) window.addEventListener(type, () => w.__keaPointer.push(type), true)
  })
  const repo = demoRepo(run)
  commitFiles(repo.root, { 'start.sh': serverScript() }, { executable: true })

  // ── add a project: ⌘O (the folder picker's answer is queued) ──
  await addProject(kea, repo.root, 'demo')

  // ── create a session: ⌘N, the prompt, ⌘↵; the keyboard is in its terminal ──
  const other = await startFakeSession(kea, 'e-kb-1-other', 'the other session', AT_PROMPT)
  await fakeAgentTerminal(kea, other.id)
  await until('the keyboard in the new session’s terminal', () => inTerminal(kea))
  await reachesAgent(kea, 'typed without a click')
  // a second one, started in the background (⌥⌘↵), that changes a file once it is allowed to
  const ask = gate(run, 'e-kb-1-ask')
  const s = await startFakeSession(
    kea,
    'e-kb-1',
    'change the readme',
    `steps:
  - hook: UserPromptSubmit
  - ${frame('✶ Working…')}
  - ${ask.step}
  - hook: { event: PreToolUse, tool: Edit, input: { file_path: "README.md" } }
  - hook: { event: PermissionRequest, tool: Edit, input: { file_path: "README.md" } }
  - ${frame('Edit(README.md)  Allow? (y/n)')}
  - wait: { answer: y }
  - file: { op: append, path: README.md, content: "\\nChanged on the tour.\\n" }
  - hook: { event: PostToolUse, tool: Edit, input: { file_path: "README.md" } }
  - ${frame('⏺ README.md changed')}
  - hook: Stop
onLine:
  - print: "GOT {{line}}\\r\\n"
`,
    { background: true },
  )
  await page.keyboard.press('Escape')
  await until('the first session on screen again, with the keyboard', async () => ((await paneSession(page)) === other.id && (await inTerminal(kea))) || undefined)

  // ── approve a permission prompt: ⌘J goes to the session that asks, and the answer is typed ──
  await ask.open()
  await waitRow(kea, s.id, 'needs you', (r) => r.status === 'needsYou')
  await page.keyboard.press(sysKey('Meta+j'))
  await until('⌘J showed the session that asks', async () => (await paneSession(page)) === s.id || undefined)
  await kea.waitScreen('its question', (x) => x.includes('Allow? (y/n)'))
  await until('the keyboard in its terminal', () => inTerminal(kea))
  await page.keyboard.press('y')
  await kea.waitScreen('the agent went on', (x) => x.includes('README.md changed'))
  await waitRow(kea, s.id, 'no longer asking', (r) => r.status !== 'needsYou')

  // ── open the changed file's diff: ⌘⇧G, then ↵ on its row ──
  await page.keyboard.press(sysKey('Meta+Shift+g'))
  await waitChanges(kea, 'the changed file', (rows) => rows.some((r) => r.path === 'README.md'))
  await until('the keyboard in the Changes list', () => focusIn(kea, '[role=listbox][aria-label="Changes"]'))
  await page.keyboard.press('Home')
  await waitChanges(kea, 'its row current', (rows) => rows.find((r) => r.path === 'README.md')?.selected === true)
  await page.keyboard.press('Enter')
  await until('the diff of README.md in the viewer', async () => {
    const v = await viewerShown(kea)
    return (v?.path === 'README.md' && v.mode === 'diff') || undefined
  })
  expect((await fileTabs(kea)).map((t) => [t.path, t.kind, t.selected])).toEqual([['README.md', 'diff', true]])
  // ⌃` from a file tab brings the terminal shown before it back, with the keyboard in it; the diff's tab stays
  expect((await viewerShown(kea))?.focused, 'the keyboard is in the diff').toBe(true)
  await page.keyboard.press('Control+`')
  await until('⌃` showed the terminal with the keyboard in it', () => inTerminal(kea))
  expect(await kea.shown()).toBe(await tabOf(kea, 'agent'))
  expect((await fileTabs(kea)).map((t) => [t.path, t.selected])).toEqual([['README.md', false]])

  // ── run the dev server: ⌘R ──
  await waitServer(kea, 'stopped')
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'running')
  const served = await serverAddress(kea)
  expect(await inTerminal(kea), 'the keyboard stayed in the terminal').toBe(true)

  // ── open the worktree in VS Code: ⌘⇧O ──
  await page.keyboard.press(sysKey('Meta+Shift+o'))
  const launches = await editors.waitLaunches(1)
  const branch = /^Branch (.+): copy$/.exec((await page.locator('.main-header').getByRole('button', { name: /^Branch / }).getAttribute('aria-label')) ?? '')?.[1]
  const dir = worktreesOf(repo.root).find((w) => w.branch === branch)?.dir
  expect(dir, `the worktree on ${branch}`).toBeTruthy()
  const worktree = fs.realpathSync(dir as string)
  expect(launches.at(-1)!.argv.map((a) => (fs.existsSync(a) ? fs.realpathSync(a) : a)), 'the editor was given the session’s worktree').toContain(worktree)

  // ── archive the session: ⌘⇧⌫; with the dev server running it asks, and the sheet is answered from the keyboard ──
  await page.keyboard.press(sysKey('Meta+Shift+Backspace'))
  const sheet = page.getByRole('alertdialog', { name: 'Archive session' })
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sheet.getByRole('button', { name: 'Archive' })).toBeFocused()
  await page.keyboard.press('Enter')
  // archived: out of the list and into the closed Archived group, its dev server stopped
  await expect(page.getByRole('treeitem', { name: 'Archived (1)' })).toBeVisible()
  await expect(sheet).toHaveCount(0)
  expect(await sessionIds(page)).toEqual([other.id])
  // (an archived session runs no server: once its server has stopped its header offers none)
  await waitServer(kea, null)
  await until('the archived session’s dev server gone from its port', async () => !(await listening(served.port)) || undefined)

  expect(await page.evaluate(() => (window as unknown as { __keaPointer: string[] }).__keaPointer), 'no pointer event reached the window').toEqual([])
  await kea.assertUnfocused()
})

// ── Settings, Disk and diagnostics, run as any other command ──

test('E-PAL-3 · the palette runs the Settings, Disk and diagnostics commands: Show Disk Usage opens Settings on Disk with the session’s worktree listed; Copy Diagnostics puts its text on the (recorded) clipboard; Remove Build Folders… is dimmed with its reason while no session is on screen and, with one, asks first and removes nothing on Esc; Keyboard Shortcuts opens the list; Settings opens the sheet and its row shows ⌘,; each leaves the keyboard in the terminal', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await recordClipboard(page)
  const root = await project(kea, run)

  /** `>words` in the palette until the command leads; resolves with its row. */
  const find = async (words: string, id: string) => {
    await openPalette(kea)
    await page.keyboard.type(`>${words}`)
    return (await waitPalette(kea, `${id} leads`, (r) => r[0]?.id === id))[0]!
  }

  // ── with only the composer on screen: a command about a session says why it cannot run ──
  expect(await find('remove build', 'session.removeBuildFolders')).toMatchObject({ title: 'Remove Build Folders…', disabled: true, reason: 'No session is selected', remedy: '', shortcut: '' })
  await page.keyboard.press('Enter')
  await expect(palette(page), 'nothing to offer: the palette stays').toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)

  const s = await startFakeSession(kea, 'e-pal-3', 'build things', AT_PROMPT, { open: false })
  await fakeAgentTerminal(kea, s.id)
  await clickTerminal(kea)
  const title = (await rowState(page, s.id))!.title
  const worktree = worktreesOf(root)[0]!.dir
  fs.mkdirSync(path.join(worktree, 'node_modules', 'left-pad'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')

  // ── Show Disk Usage: Settings, on Disk, with this session's worktree ──
  expect(await find('show disk', 'app.showDisk')).toMatchObject({ title: 'Show Disk Usage', disabled: false, shortcut: '' })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  const disk = page.getByRole('dialog', { name: 'Settings: Disk', exact: true })
  await expect(disk).toBeVisible({ timeout: STEP_MS })
  await expect(disk.locator(`[data-disk-row="${s.id}"]`)).toContainText(title, { timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(disk).toHaveCount(0)
  await until('the keyboard back in the terminal', () => inTerminal(kea))

  // ── Copy Diagnostics: the text, on the page's recorder (never the person's clipboard) ──
  expect(await find('copy diag', 'app.copyDiagnostics')).toMatchObject({ title: 'Copy Diagnostics', disabled: false, shortcut: '' })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  const copied = await until('the diagnostics copied', async () => (await clipboard(page))[0])
  for (const heading of ['# Kea diagnostics', '## Agent CLIs', '## Sessions', '## Recent errors']) expect(copied.split('\n'), heading).toContain(heading)
  expect(await clipboard(page)).toHaveLength(1)
  await until('the keyboard in the terminal', () => inTerminal(kea))

  // ── Remove Build Folders…: available now, and it asks first ──
  expect(await find('remove build', 'session.removeBuildFolders')).toMatchObject({ disabled: false, reason: '' })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  const ask = page.getByRole('alertdialog', { name: 'Remove build folders' })
  await expect(ask).toBeVisible({ timeout: STEP_MS })
  await expect(ask).toContainText(`Remove the build folders of ${title}?`)
  await expect(ask.locator('[data-build-folders]')).toContainText('node_modules', { timeout: STEP_MS })
  expect(await ask.getByRole('button', { name: 'Cancel' }).evaluate((e) => e === document.activeElement), 'Cancel is the default').toBe(true)
  await page.keyboard.press('Escape')
  await expect(ask).toHaveCount(0)
  expect(fs.existsSync(path.join(worktree, 'node_modules', 'left-pad', 'index.js')), 'nothing was removed').toBe(true)
  await until('the keyboard in the terminal', () => inTerminal(kea))

  // ── Keyboard Shortcuts: the list, every command with its keys ──
  expect(await find('keyboard shortcuts', 'app.shortcuts')).toMatchObject({ title: 'Keyboard Shortcuts', disabled: false })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  const list = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(list).toBeVisible({ timeout: STEP_MS })
  const rows = await keyboardRows(kea)
  expect(rows.map((r) => r.id)).toEqual(COMMANDS.map((c) => c.id))
  expect(rows.find((r) => r.id === 'app.settings')).toMatchObject({ title: 'Settings', keys: [sysLabel('⌘,')], changed: false })
  expect(rows.find((r) => r.id === 'app.showDisk')).toMatchObject({ title: 'Show Disk Usage', keys: [], changed: false })
  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await until('the keyboard in the terminal', () => inTerminal(kea))

  // ── Settings: its row shows its key; ↵ opens the sheet ──
  expect(await find('settings', 'app.settings')).toMatchObject({ title: 'Settings', disabled: false, shortcut: sysLabel('⌘,') })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  const settings = page.getByRole('dialog', { name: /^Settings: / })
  await expect(settings).toBeVisible({ timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await reachesAgent(kea, 'after the palette')
  expect(await clipboard(page), 'one copy, the one asked for').toHaveLength(1)
  await kea.assertUnfocused()
})

test('E-KB-4 · keybindings.json gives Settings and Show Disk Usage keys of the person’s own: both act from the sidebar, the file panel, the header and the terminal, ⌘, no longer opens Settings, and the menu bar, the palette, the gear’s tooltip and Settings › Keyboard all say the new keys; with the file removed the defaults are back everywhere', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await project(kea, run, NESTED)
  const s = await startFakeSession(kea, 'e-kb-4', 'keys of my own', AT_PROMPT)
  await fakeAgentTerminal(kea, s.id)
  await waitTree(kea, 'the root is listed', (rows) => rows.some((r) => r.path === 'README.md'))
  await clickTerminal(kea)
  const settings = page.getByRole('dialog', { name: /^Settings: / })
  const gear = page.locator('.sidebar-footer [data-command="app.settings"]')
  expect(await menuItem(kea, 'app.settings')).toMatchObject({ accelerator: sysAccel('⌘,') })
  expect(await menuItem(kea, 'app.showDisk')).toMatchObject({ label: 'Show Disk Usage', accelerator: '' })
  await expect(gear).toHaveAttribute('aria-label', `Settings (${sysLabel('⌘,')})`)

  writeKeybindings(run, `[\n  { "command": "app.settings", "key": "${MY_SETTINGS.file}" },\n  { "command": "app.showDisk", "key": "${MY_DISK.file}" },\n]\n`)
  // the menu bar
  await waitMenuItem(kea, 'app.settings', 'the new key', (m) => m.accelerator === accel(MY_SETTINGS.label))
  await waitMenuItem(kea, 'app.showDisk', 'a key where it had none', (m) => m.accelerator === accel(MY_DISK.label))

  // the router, from every region: the new keys act, and Esc gives the keyboard back to the region
  for (const [name, selector] of REGIONS) {
    await focusRegion(kea, selector)
    await page.keyboard.press(MY_SETTINGS.press)
    await expect(settings, `Settings from ${name}`).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    expect(await focusIn(kea, selector), `the keyboard back in ${name}`).toBe(true)
    await page.keyboard.press(MY_DISK.press)
    await expect(page.getByRole('dialog', { name: 'Settings: Disk', exact: true }), `Disk from ${name}`).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    expect(await focusIn(kea, selector), `the keyboard back in ${name}`).toBe(true)
    // the key it had is nobody's now
    await page.keyboard.press(sysKey('Meta+,'))
    await frames(page, 3)
    expect(await settings.count(), `⌘, no longer opens Settings (${name})`).toBe(0)
  }

  // the palette's chips
  for (const [words, id, chip] of [
    ['settings', 'app.settings', MY_SETTINGS.label],
    ['show disk', 'app.showDisk', MY_DISK.label],
  ] as const) {
    await openPalette(kea)
    await page.keyboard.type(`>${words}`)
    const rows = await waitPalette(kea, `${id} leads`, (r) => r[0]?.id === id)
    expect(rows[0]!.shortcut, id).toBe(chip)
    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)
  }
  // the gear's tooltip and its name
  await expect(gear).toHaveAttribute('aria-label', `Settings (${MY_SETTINGS.label})`)
  await gear.hover()
  await expect(tooltip(page).locator('span')).toHaveText('Settings')
  await expect(tooltip(page).locator('kbd')).toHaveText(MY_SETTINGS.label)
  await page.locator('.terminal-host.shown').hover()
  await expect(tooltip(page)).toHaveCount(0)

  // Settings › Keyboard, reached with the new key
  await clickTerminal(kea)
  await page.keyboard.press(MY_SETTINGS.press)
  await expect(settings).toBeVisible()
  await settings.getByRole('tab', { name: 'Keyboard', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Settings: Keyboard', exact: true })).toBeVisible()
  const of = async (id: string) => (await keyboardRows(kea)).find((r) => r.id === id)
  expect(await of('app.settings')).toMatchObject({ keys: [MY_SETTINGS.label], changed: true })
  expect(await of('app.showDisk')).toMatchObject({ keys: [MY_DISK.label], changed: true })
  await expect(keyboardList(page).getByRole('list', { name: 'Conflicts' })).toHaveCount(0)
  await expect(keyboardList(page).getByRole('list', { name: 'Entries left out' })).toHaveCount(0)

  // ── the file removed: the defaults, everywhere, while the list is still on screen ──
  fs.rmSync(path.join(run.home, 'keybindings.json'))
  await waitMenuItem(kea, 'app.settings', 'its own key again', (m) => m.accelerator === sysAccel('⌘,'))
  await waitMenuItem(kea, 'app.showDisk', 'no key again', (m) => m.accelerator === '')
  await until('the list follows', async () => (await of('app.settings'))?.changed === false || undefined)
  expect(await of('app.settings')).toMatchObject({ keys: [sysLabel('⌘,')], changed: false })
  expect(await of('app.showDisk')).toMatchObject({ keys: [], changed: false })
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await until('the keyboard in the terminal', () => inTerminal(kea))
  await expect(gear).toHaveAttribute('aria-label', `Settings (${sysLabel('⌘,')})`)
  await page.keyboard.press(MY_DISK.press)
  await page.keyboard.press(MY_SETTINGS.press)
  await frames(page, 3)
  expect(await settings.count(), 'the keys from the file are nobody’s again').toBe(0)
  await page.keyboard.press(sysKey('Meta+,'))
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await openPalette(kea)
  await page.keyboard.type('>show disk')
  expect((await waitPalette(kea, 'Show Disk Usage leads', (r) => r[0]?.id === 'app.showDisk'))[0]!.shortcut).toBe('')
  await page.keyboard.press('Escape')
  await reachesAgent(kea, 'nothing reached the agent meanwhile')
  await kea.assertUnfocused()
})
