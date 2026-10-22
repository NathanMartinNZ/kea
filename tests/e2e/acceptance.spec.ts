// Both agents end to end with the keyboard only: every action is a real key on the element a person would use, unless a
// line says otherwise, and a probe only reads state or sets up what no key can (files on disk, a fake agent's script
// and its gates, a settings file). Kea runs through tests/e2e/fixtures.ts with tools/fake-agent as `claude` and as
// Command Code's `cmd`, which behaves as Command Code 1.79.2 was recorded doing: it loads the kea-mod.ts the built app
// ships, whose events reach core through real `kea-helper hook` processes. The real CLIs are never run, and nothing
// reaches the person's editor, browser, file manager or clipboard.

import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { L } from '@kea/protocol'
import { parseXColor, THEMES, toRgbString } from '@kea/terminal'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { harnessUserHome, loginShellLookup } from '../../tools/perf/src/launch.ts'
import { STEP_MS, until, type Kea, type KeaRun } from '../support/app.ts'
import { AGENT_MARK, agentEvents, gate } from '../support/app-fake-agent.ts'
import { waitChanges } from '../support/app-files.ts'
import { focusIn, openPalette, palette, waitPalette } from '../support/app-palette.ts'
import { clipboard, commitFiles, EditorWorld, recordClipboard, serverScript, waitServer, worktreesOf } from '../support/app-server.ts'
import { addProject, demoRepo, paneSession, promptBox, rowState, sessionIds, sessionRow, startSession, tabOf, waitLive, waitRow } from '../support/app-sessions.ts'
import { fileTabs, viewerShown } from '../support/app-tabs.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

/** A fake agent's screen: its mark, the prompt, then `lines` (YAML flow sequence). */
const frame = (...lines: string[]) => `frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', ...lines])}`

interface FakeAgent {
  /** The agent's event log (tools/fake-agent README "Event log"). */
  log: string
}

/** Claude Code as the composer's default agent: written before Kea launches, which reads it then. */
function claudeByDefault(run: KeaRun): void {
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
}

/** Give the fake agents started from now on under `flavour`'s command `scenario` (YAML after `version: 1`) and a log of their own. */
function fakeAgent(run: KeaRun, flavour: 'claude' | 'commandcode', name: string, scenario: string, env: Record<string, string> = {}): FakeAgent {
  const file = path.join(run.home, `${name}.yaml`)
  fs.writeFileSync(file, `version: 1\nname: ${name}\n${scenario.trimEnd()}\n`)
  const log = path.join(run.home, `${name}.log`)
  // the fake Command Code keeps its files where Kea's adapter looks: under the run's own HOME (it has no config-dir variable)
  const home: Record<string, string> = flavour === 'commandcode' ? { FAKE_AGENT_HOME: harnessUserHome(run.home) } : {}
  writeAgentShim(run.agentBin, flavour, { env: { ...home, FAKE_AGENT_SCENARIO: file, FAKE_AGENT_LOG: log, ...env } })
  return { log }
}

/** The `start` records of the agents that logged to `log` (their argv, conversation id and folder), once there are `n`. */
function agentStarts(log: string, n: number): Promise<{ argv: string[]; sessionId: string; cwd: string }[]> {
  return until(`${n} fake agent start(s) in ${path.basename(log)}`, () => {
    const starts = agentEvents(log).filter((r) => r.t === 'start') as unknown as { argv: string[]; sessionId: string; cwd: string }[]
    return starts.length >= n ? starts : undefined
  })
}

const composer = (page: Page): Locator => page.getByRole('region', { name: 'New session' })
const promptFocused = (page: Page) => until('the prompt holding the keyboard', () => promptBox(page).evaluate((e) => e === document.activeElement).catch(() => false) || undefined)
const inTerminal = (kea: Kea): Promise<boolean> => focusIn(kea, '.terminal-host.shown')
const menuLabels = (menu: Locator): Promise<string[]> => menu.locator('.kea-menu-label').allTextContents()

/** The composer's selector row as it reads: each button's accessible name (`Agent: …`, `Model: …`, …). */
function selectorsShown(page: Page): Promise<string[]> {
  return composer(page)
    .getByRole('group', { name: 'Agent options' })
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
}

/** `⌘<digit>` from the prompt opens a selector's menu; resolves with the open menu. */
async function openSelector(page: Page, digit: 1 | 2 | 3 | 4, name: string): Promise<Locator> {
  await promptFocused(page)
  await page.keyboard.press(sysKey(`Meta+${digit}`))
  const menu = page.getByRole('menu', { name, exact: true })
  await expect(menu).toBeVisible({ timeout: STEP_MS })
  return menu
}

/** Choose Command Code in the composer's Agent menu by key (`⌘1`, `↓`, `↵`), once detection has listed it. */
async function chooseCommandCode(page: Page): Promise<void> {
  const menu = await openSelector(page, 1, 'Agent')
  await expect(menu.locator('.kea-menu-label')).toHaveText(['Claude Code', 'Command Code', 'Shell'], { timeout: STEP_MS })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await promptFocused(page)
  expect((await selectorsShown(page))[0]).toBe('Agent: Command Code')
}

/** From now on the page records every press of a pointer and every wheel turn; `pointerEvents` reads them. */
async function recordPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keaPointer: string[] }
    w.__keaPointer = []
    for (const type of ['pointerdown', 'mousedown', 'wheel']) window.addEventListener(type, () => w.__keaPointer.push(type), true)
  })
}
const pointerEvents = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __keaPointer: string[] }).__keaPointer)

/** From now on the page records every status the session's row shows (each change once); `statusesSeen` reads them. */
async function recordStatuses(page: Page, id: string): Promise<void> {
  await page.evaluate((sid) => {
    const w = window as unknown as { __keaStatuses: Record<string, string[]> }
    w.__keaStatuses ??= {}
    const read = () => document.querySelector(`[role=treeitem][data-session-id="${sid}"]`)?.getAttribute('data-status') ?? ''
    const seen = (w.__keaStatuses[sid] = [read()])
    new MutationObserver(() => {
      const s = read()
      if (seen.at(-1) !== s) seen.push(s)
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] })
  }, id)
}
const statusesSeen = (page: Page, id: string): Promise<string[]> => page.evaluate((sid) => [...((window as unknown as { __keaStatuses: Record<string, string[]> }).__keaStatuses[sid] ?? [])], id)

/** Run a command from the palette with keys alone: `⌘⇧P`, `>` and a few of its title's words, `↵` on the row that leads. */
async function runFromPalette(kea: Kea, words: string, id: string): Promise<void> {
  const page = await kea.page()
  await openPalette(kea)
  await page.keyboard.type(`>${words}`)
  const rows = await waitPalette(kea, `${id} leads`, (r) => r[0]?.id === id)
  expect(rows[0], `${id} can run`).toMatchObject({ disabled: false, current: true })
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
}

/** The session popover ("Why this status?"), opened from the palette; resolves with the dialog. */
async function openWhy(kea: Kea): Promise<Locator> {
  await runFromPalette(kea, 'why this status', 'session.whyStatus')
  const dialog = (await kea.page()).getByRole('dialog', { name: 'Session details' })
  await expect(dialog).toBeVisible({ timeout: STEP_MS })
  return dialog
}
const whyEntries = (dialog: Locator): Locator => dialog.getByRole('list', { name: 'Why this status?' }).locator('li')
/** A value of the popover's launch config, by its label (`Agent`, `Agent session`, …). */
const configValue = (dialog: Locator, label: string): Promise<string> =>
  dialog.locator('dl.popover-config').evaluate((dl, want) => {
    const dt = [...dl.querySelectorAll('dt')].find((e) => e.textContent === want)
    return dt?.nextElementSibling?.querySelector('.popover-value')?.textContent ?? ''
  }, label)

/** The session's journal from core's `status.why`, oldest first: `source · event`. */
async function whyLines(kea: Kea, id: string): Promise<string[]> {
  const why = (await (await kea.page()).evaluate((sid) => (window as unknown as { __keaProbe: { call(m: string, a: unknown): Promise<unknown> } }).__keaProbe.call('status.why', { id: sid }), id)) as { entries: { source: string; event: string }[] }
  return why.entries.map((e) => `${e.source} · ${e.event}`)
}

/** The session's row shows no status that asks for the person. */
const FINISHED = ['idle', 'unread']

test('E-AGT-2 · Command Code end to end with keys alone: chosen in the composer (⌘1 ↓ ↵) and started in the background beside a working Claude Code session; its mod reports the turn (working), a tool queued with nothing run for L.ccPermissionQueuedMs raises "needs you", ⌘J shows it, the answer typed in its terminal lets it finish, and "Why this status?" lists the mod’s events as exact ones; the changed file’s diff, the dev server, VS Code; Stop Agent, then ↵ on the detached overlay resumes the same conversation with the mod again; Claude Code’s row keeps its own status throughout; ⌘⇧⌫ archives; no pointer event reaches the window', async ({ run, launch }) => {
  test.setTimeout(180_000)
  const editors = new EditorWorld(run)
  editors.editor('vscode')
  claudeByDefault(run)
  // Claude Code: works on until `z`, then asks for permission
  const claude = fakeAgent(
    run,
    'claude',
    'e-agt-2-claude',
    `steps:
  - hook: UserPromptSubmit
  - ${frame('✶ Working…')}
  - wait: { answer: z }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "git push" } }
  - ${frame('Bash(git push)  Allow? (y/n)')}
  - wait: { answer: y }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "git push" } }
  - hook: { event: Stop, fields: { last_assistant_message: "Pushed." } }
  - ${frame('⏺ Pushed.')}
`,
  )
  // Command Code 1.79.2's turn, in the order it emits one: a call queued, and nothing runs until the answer
  const ask = gate(run, 'e-agt-2-ask')
  const cmd = fakeAgent(
    run,
    'commandcode',
    'e-agt-2-cmd',
    `steps:
  - hook: run_start
  - hook: turn_start
  - ${frame('✶ Working…')}
  - ${ask.step}
  - hook: { event: tool_queued, tool: shell_command, input: { command: "npm test", description: "Run the tests" } }
  - ${frame('shell_command(npm test)  Allow? (y/n)')}
  - wait: { answer: y }
  - hook: { event: tool_running, tool: shell_command }
  - file: { op: append, path: README.md, content: "\\nChanged by Command Code.\\n" }
  - hook: { event: tool_completed, tool: shell_command }
  - hook: turn_end
  - transcript: { record: user, text: "{{prompt}}" }
  - transcript: { record: assistant, text: "All tests pass." }
  - hook: { event: run_end, fields: { result: { finalText: "All tests pass." } } }
  - hook: { event: session_titled, fields: { title: "Run the tests" } }
  - transcript: { record: title, title: "Run the tests" }
  - ${frame('⏺ All tests pass.')}
`,
  )
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await recordPointer(page)
  const repo = demoRepo(run)
  commitFiles(repo.root, { 'start.sh': serverScript() }, { executable: true })

  // ── a project (⌘O), and a Claude Code session beside which Command Code will run ──
  await addProject(kea, repo.root, 'demo')
  const claudeId = await startSession(kea, 'push the branch', { open: false })
  await waitLive(kea, claudeId)
  await waitRow(kea, claudeId, 'working', (r) => r.status === 'working')
  await recordStatuses(page, claudeId)
  await kea.waitScreen('Claude Code on screen', (s) => s.includes('Working…'))
  await until('the keyboard in its terminal', () => inTerminal(kea))

  // ── Command Code, detected, chosen by key; started in the background (⌥⌘↵) ──
  await page.keyboard.press(sysKey('Meta+n'))
  await chooseCommandCode(page)
  expect(await selectorsShown(page)).toEqual(['Agent: Command Code', 'Model: default', 'Effort: model default', 'Permission mode: Ask before edits'])
  const cmdId = await startSession(kea, 'run the tests', { open: false, background: true })
  await page.keyboard.press('Escape')
  await until('Claude Code’s session on screen again, with the keyboard', async () => ((await paneSession(page)) === claudeId && (await inTerminal(kea))) || undefined)
  await waitLive(kea, cmdId)
  await recordStatuses(page, cmdId)
  // the launch: the mod is a copy under this run's KEA_HOME, with its one option; `--trust` for the worktree Kea made;
  // the prompt after `--`; no conversation id of Kea's
  const [started] = await agentStarts(cmd.log, 1)
  const argv = started!.argv
  const mod = argv[argv.indexOf('--mod') + 1]!
  expect(mod.startsWith(path.join(run.home, 'bin', 'agents', 'commandcode-'))).toBe(true)
  expect(argv[argv.indexOf('--mod-option') + 1]).toMatch(/^kea=[A-Za-z0-9_-]+$/)
  expect(argv.slice(-3)).toEqual(['--trust', '--', 'run the tests'])
  expect(argv).not.toContain('--name')
  const conversation = started!.sessionId
  expect(argv).not.toContain(conversation)

  // ── the mod's `run_start` is the turn; the row is working ──
  await waitRow(kea, cmdId, 'working (the mod’s run_start)', (r) => r.status === 'working')
  // the call is queued, and nothing of it runs: after its permission wait (L.ccPermissionQueuedMs) the mod says a
  // prompt is up
  await ask.open()
  const asking = await waitRow(kea, cmdId, 'needs you after L.ccPermissionQueuedMs', (r) => r.status === 'needsYou', L.ccPermissionQueuedMs * 3)
  expect(asking.selected, 'it is not the session on screen').toBe(false)
  expect(await sessionRow(page, cmdId).locator('.sb-label').textContent()).toBe('permission')
  expect((await rowState(page, claudeId))!.status, 'Claude Code’s row is its own').toBe('working')

  // ── ⌘J goes to it; the answer is typed in its terminal ──
  await page.keyboard.press(sysKey('Meta+j'))
  await until('⌘J showed the Command Code session', async () => (await paneSession(page)) === cmdId || undefined)
  await kea.waitScreen('its question', (x) => x.includes('Allow? (y/n)'))
  await until('the keyboard in its terminal', () => inTerminal(kea))
  await page.keyboard.press('y')
  await kea.waitScreen('the agent went on', (x) => x.includes('All tests pass.'))
  // its turn finished, and it named the session (the mod's `run_end` and `session_titled`)
  await waitRow(kea, cmdId, 'finished and titled by the agent', (r) => FINISHED.includes(r.status) && r.title === 'Run the tests')
  expect(await statusesSeen(page, cmdId), 'working, asking, working again, finished: nothing else').toEqual(expect.arrayContaining(['working', 'needsYou']))
  expect((await statusesSeen(page, cmdId)).filter((s) => s === 'needsYou'), 'asked once').toHaveLength(1)

  // ── "Why this status?" lists what the mod reported, each an exact event (source `hook`: the mod delivers through
  // `kea-helper hook`), with nothing estimated ──
  let why = await openWhy(kea)
  await expect(whyEntries(why).last()).toHaveText(/^\d\d:\d\d:\d\d hook · turn finished → ready$/, { timeout: STEP_MS })
  const lines = (await whyEntries(why).allTextContents()).map((t) => t.replace(/^\d\d:\d\d:\d\d /, ''))
  const from = lines.indexOf('hook · turn started → working')
  expect(from, `the turn’s start in ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0)
  expect(lines.slice(from)).toEqual(['hook · turn started → working', 'hook · permission asked → blocked (shell_command: npm test)', expect.stringMatching(/^hook · answered → working/), 'hook · turn finished → ready'])
  expect(lines.filter((l) => l.startsWith('heuristic · ')), 'none of it read from the terminal').toEqual([])
  expect(lines.slice(0, from), 'before the turn: Kea’s own line for the launch, then the mod’s first event').toEqual(['reconcile · agent started → starting', 'hook · agent session started → starting (startup)'])
  await expect(why.getByText('Status is estimated from terminal activity.')).toHaveCount(0)
  await expect(why.getByRole('list', { name: 'Waiting on you' })).toHaveCount(0)
  expect(await configValue(why, 'Agent')).toBe('Command Code 1.79.2')
  expect(await configValue(why, 'Agent session'), 'the conversation id is the agent’s own, learned from the mod').toBe(conversation)
  await page.keyboard.press('Escape')
  await expect(why).toHaveCount(0)
  await until('the keyboard back in the terminal', () => inTerminal(kea))

  // ── the changed file's diff (⌘⇧G, ↵), then ⌃` back to the terminal ──
  await page.keyboard.press(sysKey('Meta+Shift+g'))
  await waitChanges(kea, 'the file Command Code changed', (rows) => rows.some((r) => r.path === 'README.md'))
  await until('the keyboard in the Changes list', () => focusIn(kea, '[role=listbox][aria-label="Changes"]'))
  await page.keyboard.press('Home')
  await waitChanges(kea, 'its row current', (rows) => rows.find((r) => r.path === 'README.md')?.selected === true)
  await page.keyboard.press('Enter')
  await until('the diff of README.md in the viewer', async () => {
    const v = await viewerShown(kea)
    return (v?.path === 'README.md' && v.mode === 'diff') || undefined
  })
  expect((await fileTabs(kea)).map((t) => [t.path, t.kind, t.selected])).toEqual([['README.md', 'diff', true]])
  await page.keyboard.press('Control+`')
  await until('⌃` showed the terminal with the keyboard in it', () => inTerminal(kea))
  expect(await kea.shown()).toBe(await tabOf(kea, 'agent'))

  // ── the dev server (⌘R) and VS Code (⌘⇧O), in the Command Code session's worktree ──
  await waitServer(kea, 'stopped')
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'running')
  await page.keyboard.press(sysKey('Meta+Shift+o'))
  const launches = await editors.waitLaunches(1)
  const worktree = fs.realpathSync(started!.cwd)
  expect(worktreesOf(repo.root).map((w) => w.dir), 'the agent runs in a worktree of the project').toContain(worktree)
  expect(launches.at(-1)!.argv.map((a) => (fs.existsSync(a) ? fs.realpathSync(a) : a)), 'the editor was given the session’s worktree').toContain(worktree)

  // ── Stop Agent (the palette); ↵ on the detached overlay resumes the same conversation ──
  fakeAgent(
    run,
    'commandcode',
    'e-agt-2-cmd',
    `steps:
  - ${frame('RESUMED {{sessionId}}')}
onLine:
  - hook: run_start
  - print: "GOT {{line}}\\r\\n"
  - wait: { answer: k }
  - hook: { event: run_end, fields: { result: { finalText: "ok" } } }
`,
  )
  await runFromPalette(kea, 'stop agent', 'session.stop')
  const stopped = await waitRow(kea, cmdId, 'detached after Stop', (r) => r.lifecycle === 'detached')
  expect(stopped.status, 'the dashed ring, not the failure glyph').toBe('detached')
  const overlay = page.getByRole('status', { name: 'Session ended' })
  await expect(overlay).toContainText('Session stopped', { timeout: STEP_MS })
  await until('the keyboard in the ended terminal’s area', () => focusIn(kea, '.terminal-area, .terminal-host'))
  await page.keyboard.press('Enter')
  await waitRow(kea, cmdId, 'live after Resume', (r) => r.lifecycle === 'live')
  const [, resumed] = await agentStarts(cmd.log, 2)
  expect(resumed!.argv.slice(0, 2), 'the adapter’s resume argv').toEqual(['--resume', conversation])
  expect(resumed!.argv[resumed!.argv.indexOf('--mod') + 1], 'the mod is passed again: a resumed session keeps none').toBe(mod)
  expect(resumed!.argv).toContain('--trust')
  expect(resumed!.argv, 'no prompt: the conversation goes on').not.toContain('--')
  expect(resumed!.sessionId, 'the same conversation').toBe(conversation)
  expect(resumed!.cwd).toBe(started!.cwd)
  await kea.waitScreen('the resumed agent', (x) => x.includes(`RESUMED ${conversation}`))
  await expect(overlay).toHaveCount(0)
  // the resumed agent's mod reports as before: a turn typed at its prompt is working, then finished
  await until('the keyboard in the resumed agent’s terminal', () => inTerminal(kea))
  await kea.enter('again')
  await kea.waitScreen('the line at the agent', (x) => x.includes('GOT again'))
  await waitRow(kea, cmdId, 'working (the resumed mod’s run_start)', (r) => r.status === 'working')
  await page.keyboard.press('k')
  await waitRow(kea, cmdId, 'finished (the resumed mod’s run_end)', (r) => FINISHED.includes(r.status))
  why = await openWhy(kea)
  await expect(whyEntries(why).last()).toHaveText(/ hook · turn finished → ready$/, { timeout: STEP_MS })
  expect(await configValue(why, 'Agent session'), 'still the same conversation').toBe(conversation)
  expect(await whyEntries(why).allTextContents(), 'the mod reported the resume').toEqual(expect.arrayContaining([expect.stringMatching(/ hook · agent session started → \w+ \(resume\)$/)]))
  await page.keyboard.press('Escape')
  await expect(why).toHaveCount(0)

  // ── Claude Code beside it: all this time its row said working and nothing else; now it asks, by its own hooks ──
  expect(await statusesSeen(page, claudeId), 'Claude Code’s row through Command Code’s whole journey').toEqual(['working'])
  const cmdStatus = (await rowState(page, cmdId))!.status
  await page.keyboard.press('Control+Tab')
  await until('⌃Tab showed Claude Code’s session', async () => (await paneSession(page)) === claudeId || undefined)
  await until('the keyboard in its terminal', () => inTerminal(kea))
  await page.keyboard.press('z')
  await waitRow(kea, claudeId, 'Claude Code needs you', (r) => r.status === 'needsYou')
  await kea.waitScreen('its question', (x) => x.includes('Bash(git push)  Allow? (y/n)'))
  expect((await rowState(page, cmdId))!.status, 'Command Code’s row is its own').toBe(cmdStatus)
  await page.keyboard.press('y')
  await kea.waitScreen('Claude Code went on', (x) => x.includes('Pushed.'))
  await waitRow(kea, claudeId, 'Claude Code finished', (r) => FINISHED.includes(r.status))
  expect(agentEvents(claude.log).filter((e) => e.t === 'start'), 'one Claude Code, never restarted').toHaveLength(1)

  // ── archive the Command Code session (⌘⇧⌫): with the dev server running it asks; answered from the keyboard ──
  await page.keyboard.press('Control+Tab')
  await until('⌃Tab showed the Command Code session', async () => (await paneSession(page)) === cmdId || undefined)
  await until('the keyboard in its terminal', () => inTerminal(kea))
  await page.keyboard.press(sysKey('Meta+Shift+Backspace'))
  const sheet = page.getByRole('alertdialog', { name: 'Archive session' })
  await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sheet.getByRole('button', { name: 'Archive' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('treeitem', { name: 'Archived (1)' })).toBeVisible()
  await expect(sheet).toHaveCount(0)
  expect(await sessionIds(page)).toEqual([claudeId])

  expect(await pointerEvents(page), 'no pointer event reached the window').toEqual([])
  await kea.assertUnfocused()
})

/** The composer's Worktree switch, reached and turned by keys (Tab from the prompt until it has the keyboard, then Space). */
async function toggleWorktree(page: Page, on: boolean): Promise<void> {
  const sw = composer(page).getByRole('switch', { name: 'Worktree' })
  await promptFocused(page)
  for (let i = 0; i < 12 && !(await sw.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(sw).toBeFocused()
  if ((await sw.isChecked()) !== on) await page.keyboard.press('Space')
  await expect(sw).toBeChecked({ checked: on })
  await promptBox(page).focus()
  await promptFocused(page)
}

/**
 * Wait until the status engine has no timer left (a trust window is one, for `L.trustWindowMs`), then resolve with
 * what core says the session waits on: read from core itself, which answers after the timer's own effect, where the row
 * would follow a store tick later.
 */
async function noTrustQuestion(kea: Kea, id: string): Promise<string[]> {
  await until('no timer of the status engine left', async () => (await kea.debug<Record<string, { timers: number }>>('core', 'kit'))['core.status']!.timers === 0 || undefined, L.trustWindowMs + STEP_MS)
  const why = (await (await kea.page()).evaluate((sid) => (window as unknown as { __keaProbe: { call(m: string, a: unknown): Promise<unknown> } }).__keaProbe.call('status.why', { id: sid }), id)) as { attention: { kind: string; summary: string }[] }
  return why.attention.map((a) => `${a.kind}: ${a.summary}`)
}

test('E-AGT-3 · a Command Code too old for mods (1.78.0): the session launches named (`--name kea-…`, no `--mod`) and is followed from its terminal alone: working while its output flows, finished when it goes quiet, never "needs you" for a prompt no event names, and "Why this status?" says the status is estimated from terminal activity; quiet at its start and after a Resume it gets no "Trust this folder?" that nothing could answer; the name is never the session’s title; Resume takes the conversation by that name', async ({ run, launch }) => {
  test.setTimeout(120_000)
  claudeByDefault(run)
  const go = gate(run, 'e-agt-3-go')
  // what a 1.79.2 would report through the mod is still in the script: this version loads no mod, so nobody hears it
  const cmd = fakeAgent(
    run,
    'commandcode',
    'e-agt-3',
    `steps:
  - ${frame('✶ Working…')}
  - ${go.step}
  - hook: run_start
  - loop:
      times: 25
      steps:
        - print: "."
        - sleep: 100
  - hook: { event: tool_queued, tool: shell_command, input: { command: "npm test" } }
  - ${frame('shell_command(npm test)  Allow? (y/n)')}
  - wait: { answer: y }
  - hook: { event: tool_running, tool: shell_command }
  - hook: { event: run_end, fields: { result: { finalText: "All tests pass." } } }
  - ${frame('⏺ All tests pass.')}
`,
    { FAKE_AGENT_CLI_VERSION: '1.78.0' },
  )
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await recordPointer(page)
  await addProject(kea, demoRepo(run).root, 'demo')
  await chooseCommandCode(page)
  const id = await startSession(kea, 'run the tests', { open: false })
  await waitLive(kea, id)
  await recordStatuses(page, id)
  const slugTitle = (await rowState(page, id))!.title

  // no mod for this version; the conversation is named instead, and the name stands in for its id
  const [started] = await agentStarts(cmd.log, 1)
  const argv = started!.argv
  expect(argv).not.toContain('--mod')
  expect(argv).not.toContain('--mod-option')
  const name = argv[argv.indexOf('--name') + 1]!
  expect(name).toMatch(/^kea-[0-9A-Za-z-]{8,64}$/)
  expect(argv.slice(-3)).toEqual(['--trust', '--', 'run the tests'])

  // the terminal works as ever; its output flowing is all Kea knows (tier 3): working
  await kea.waitScreen('the agent on screen', (s) => s.includes('Working…'))
  // quiet at its start, in a project whose trust no agent's event ever confirmed: no trust window runs for a launch
  // that can report nothing, so no "Trust this folder?" comes up that nothing could answer
  expect(await noTrustQuestion(kea, id), 'no trust question for the quiet start').toEqual([])
  await go.open()
  await waitRow(kea, id, 'working, from its output alone', (r) => r.status === 'working')
  // its prompt comes up and it goes quiet: no event says a prompt is there, and nothing guesses one. Quiet for tier 3's
  // interval reads as a finished turn
  await kea.waitScreen('its question', (x) => x.includes('Allow? (y/n)'))
  await waitRow(kea, id, 'quiet: finished, as far as the terminal says', (r) => FINISHED.includes(r.status))
  expect(await statusesSeen(page, id), 'never "needs you"').not.toContain('needsYou')
  expect(await sessionRow(page, id).locator('.sb-label').count(), 'no label on the row').toBe(0)

  // "Why this status?" says what the status is going on
  let why = await openWhy(kea)
  await expect(why.getByRole('note').filter({ hasText: 'Status is estimated from terminal activity.' })).toBeVisible({ timeout: STEP_MS })
  const lines = (await whyEntries(why).allTextContents()).map((t) => t.replace(/^\d\d:\d\d:\d\d /, ''))
  expect(lines.filter((l) => !l.startsWith('user · '))).toEqual(['reconcile · agent started → starting', 'heuristic · turn started → working', 'heuristic · turn finished → ready'])
  await expect(why.getByRole('list', { name: 'Waiting on you' })).toHaveCount(0)
  expect(await configValue(why, 'Agent')).toBe('Command Code 1.78.0')
  expect(await configValue(why, 'Agent session'), 'the name stands in for the conversation id').toBe(name)
  await page.keyboard.press('Escape')
  await expect(why).toHaveCount(0)
  await until('the keyboard back in the terminal', () => inTerminal(kea))

  // the answer typed in the terminal reaches the agent, which goes on
  await page.keyboard.press('y')
  await kea.waitScreen('the agent went on', (x) => x.includes('All tests pass.'))
  // the name Kea gave is the agent's title for the conversation (its meta file), and never the session's
  expect((await rowState(page, id))!.title).toBe(slugTitle)
  expect(slugTitle.startsWith('kea-')).toBe(false)

  // Stop, then ↵ on the overlay: the conversation is resumed by its name, again without a mod
  await runFromPalette(kea, 'stop agent', 'session.stop')
  await waitRow(kea, id, 'detached after Stop', (r) => r.lifecycle === 'detached')
  await expect(page.getByRole('status', { name: 'Session ended' })).toContainText('Session stopped', { timeout: STEP_MS })
  await page.keyboard.press('Enter')
  await waitRow(kea, id, 'live after Resume', (r) => r.lifecycle === 'live')
  const [, resumed] = await agentStarts(cmd.log, 2)
  expect(resumed!.argv.slice(0, 2)).toEqual(['--resume', name])
  expect(resumed!.argv).not.toContain('--mod')
  expect(resumed!.sessionId, 'the same conversation').toBe(started!.sessionId)
  // the resumed agent sits quiet at its gate: again no trust question (a trust window started for the resume would turn
  // the row to "needs you", and "Why this status?" would read "no hook in the trust window → blocked")
  await kea.waitScreen('the resumed agent on screen', (s) => s.includes('Working…'))
  expect(await noTrustQuestion(kea, id), 'no trust question for the quiet resume').toEqual([])
  why = await openWhy(kea)
  expect((await whyEntries(why).allTextContents()).filter((t) => t.includes('trust'))).toEqual([])
  await expect(why.getByRole('list', { name: 'Waiting on you' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(why).toHaveCount(0)
  expect(await statusesSeen(page, id), 'still never "needs you"').not.toContain('needsYou')
  expect(await pointerEvents(page), 'no pointer event reached the window').toEqual([])
  await kea.assertUnfocused()
})

/**
 * Command Code asking whether the folder is trusted (no `--trust`): its mod loads, and its session starts, only once
 * the question is answered.
 */
const CMD_TRUST_PROMPT = `fireSessionStart: false
steps:
  - ${frame('Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit')}
  - wait: { answer: "1" }
  - hook: session_start
  - hook: run_start
  - ${frame('✶ Working…')}
  - wait: { answer: z }
  - hook: { event: run_end, fields: { result: { finalText: "Done." } } }
  - ${frame('⏺ Done.')}
`

test('E-AGT-4 · a Command Code session used in place is never started with --trust: Command Code asks its own trust question, and while it waits Kea says so ("Trust this folder? — answer in the terminal" on the row and in "Why this status?"); answered in the terminal, the mod’s first event clears it; the same in a project where a Claude Code session already ran', async ({ run, launch }) => {
  test.setTimeout(180_000)
  claudeByDefault(run)
  const claudeLog = fakeAgent(run, 'claude', 'e-agt-4-claude', `steps:\n  - hook: UserPromptSubmit\n  - ${frame('✶ Working…')}\n  - wait: { answer: z }\n`)
  const cmd = fakeAgent(run, 'commandcode', 'e-agt-4-cmd', CMD_TRUST_PROMPT)
  const kea = await launch()
  await kea.pretendFocused(true)
  const page = await kea.page()
  await recordPointer(page)
  const first = demoRepo(run, 'first')
  const second = demoRepo(run, 'second')

  /** Start a Command Code session in place in the project the composer is open on; resolves with its id and its agent's argv. */
  const inPlace = async (n: number): Promise<{ id: string; argv: string[]; cwd: string }> => {
    await chooseCommandCode(page)
    await toggleWorktree(page, false)
    await expect(composer(page).locator('.composer-inplace')).toContainText('In place')
    const id = await startSession(kea, 'look around', { open: false })
    await waitLive(kea, id)
    const starts = await agentStarts(cmd.log, n)
    return { id, argv: starts[n - 1]!.argv, cwd: starts[n - 1]!.cwd }
  }
  /** What the row and "Why this status?" say while Command Code's own question waits; then the answer, typed in the terminal. */
  const askedAndAnswered = async (id: string): Promise<void> => {
    await kea.waitScreen('Command Code’s trust question', (s) => s.includes('Do you trust the files in this folder?'))
    await waitRow(kea, id, 'the trust question', (r) => r.status === 'needsYou', L.trustWindowMs + STEP_MS)
    expect(await sessionRow(page, id).locator('.sb-label').textContent()).toBe('question')
    const why = await openWhy(kea)
    await expect(whyEntries(why).last()).toHaveText(/ reconcile · no hook in the trust window → blocked \(Trust this folder\? — answer in the terminal\)$/, { timeout: STEP_MS })
    await expect(why.getByRole('list', { name: 'Waiting on you' })).toHaveText(/question\s+Trust this folder\? — answer in the terminal/)
    await page.keyboard.press('Escape')
    await expect(why).toHaveCount(0)
    await until('the keyboard in the terminal', () => inTerminal(kea))
    await page.keyboard.press('1')
    await waitRow(kea, id, 'working: the mod’s first events', (r) => r.status === 'working')
    expect(await sessionRow(page, id).locator('.sb-label').count(), 'the question is gone').toBe(0)
  }

  // ── a project no agent ran in yet ──
  await addProject(kea, first.root, 'first')
  const a = await inPlace(1)
  expect(a.argv, 'the project’s own folder is the person’s to trust').not.toContain('--trust')
  expect(a.cwd).toBe(fs.realpathSync(first.root))
  expect(a.argv).toContain('--mod')
  await askedAndAnswered(a.id)

  // ── a project where Claude Code already ran: Command Code has its own question all the same ──
  await addProject(kea, second.root, 'second')
  const c = await startSession(kea, 'claude first', { open: false })
  await waitRow(kea, c, 'Claude Code working (its hook confirms the project)', (r) => r.status === 'working')
  await agentStarts(claudeLog.log, 1)
  // the hook's line in the journal: the engine has heard an exact event from this project, which is what confirms its trust
  await until('Claude Code’s hook in the journal', async () => (await whyLines(kea, c)).some((l) => l.startsWith('hook · ')) || undefined)
  await page.keyboard.press(sysKey('Meta+n'))
  const b = await inPlace(2)
  expect(b.argv).not.toContain('--trust')
  expect(b.cwd, 'in the second project’s own folder').toBe(fs.realpathSync(second.root))
  await askedAndAnswered(b.id)

  expect(await pointerEvents(page), 'no pointer event reached the window').toEqual([])
  await kea.assertUnfocused()
})

// ── settings with both agents ───────────────────────────────────────────────────────────────────────────────────────

/** The Settings sheet, opened with ⌘, on `section` (a click on its tab). */
async function openSettings(page: Page, section: string): Promise<Locator> {
  await page.keyboard.press(sysKey('Meta+,'))
  const sheet = page.getByRole('dialog', { name: /^Settings: / })
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  await sheet.getByRole('tab', { name: section, exact: true }).click()
  await expect(page.getByRole('dialog', { name: `Settings: ${section}`, exact: true })).toBeVisible()
  return sheet
}

/** What an agent's card in Settings › Agents says it detected: its state, the whole path (the tip of the cut one), its lines and the command it offers to copy. */
async function cardSays(card: Locator): Promise<{ state: string | null; path: string | null; lines: string[]; command: string | null }> {
  const row = card.locator('[data-agent-state]')
  return {
    state: await row.getAttribute('data-agent-state'),
    path: (await row.locator('.path-mid').count()) ? await row.locator('.path-mid').getAttribute('data-tip') : null,
    lines: await row.locator('.agent-detected > span:not(.agent-command)').allTextContents(),
    command: (await row.locator('.agent-command code').count()) ? await row.locator('.agent-command code').textContent() : null,
  }
}

const CMD_MODES = ['Ask before edits', 'Accept edits', 'Plan']
const CLAUDE_MODES = ['Ask before edits', 'Accept edits', 'Plan', 'Auto', "Don't ask (deny anything not pre-approved)"]
const YOLO = 'Bypass permissions (yolo)'

/** The composer's Permission mode menu as it lists now (⌘4, read, Esc). */
async function modesListed(page: Page): Promise<string[]> {
  const menu = await openSelector(page, 4, 'Permission mode')
  const listed = await menuLabels(menu)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  return listed
}

test('E-SET-3 · Settings › Agents with both agents: Command Code’s card says where its command is, its version and that it is signed out, with the sign-in command to copy; Claude Code, not on the PATH, says "Not installed" with its install command to copy; Look again finds what changed meanwhile; "Auto-trust Kea worktrees" is Command Code’s key alone, and turned off the next worktree session starts without --trust; "Allow bypass-permission modes" turned on for Command Code says what it means and offers yolo in the composer for Command Code and nothing more for Claude Code, and the mode reaches the command line', async ({ run, launch }) => {
  claudeByDefault(run)
  // Claude Code is not installed (as E-AGT-1 has it: the run's shim folder stays first on PATH without its `claude`);
  // Command Code is installed and signed out
  fs.rmSync(path.join(run.agentBin, 'claude'))
  expect(loginShellLookup(run.launchEnv()).agents.claude, 'no claude on the login shell’s PATH').toBeNull()
  const turn = `steps:\n  - hook: run_start\n  - ${frame('✶ Working…')}\n  - wait: key\n`
  fakeAgent(run, 'commandcode', 'e-set-3-out', turn, { FAKE_AGENT_LOGGED_IN: '0' })
  const kea = await launch()
  const page = await kea.page()
  await recordClipboard(page)
  await addProject(kea, demoRepo(run).root)
  await promptFocused(page)

  // ── what core detected ──
  let sheet = await openSettings(page, 'Agents')
  const claudeCard = sheet.getByRole('region', { name: 'Claude Code', exact: true })
  const cmdCard = sheet.getByRole('region', { name: 'Command Code', exact: true })
  await until('Command Code detected', async () => (await cardSays(cmdCard)).state === 'installed' || undefined)
  expect(await cardSays(cmdCard)).toEqual({ state: 'installed', path: path.join(run.agentBin, 'cmd'), lines: ['Version 1.79.2 · Signed out', 'Command Code is signed out: run cmd login in a terminal'], command: 'cmd login' })
  await cmdCard.getByRole('button', { name: 'Copy the sign-in command for Command Code' }).click()
  await until('the sign-in command copied', async () => (await clipboard(page)).at(-1) === 'cmd login' || undefined)
  await until('Claude Code looked for', async () => (await cardSays(claudeCard)).state === 'missing' || undefined)
  const missing = await cardSays(claudeCard)
  expect(missing).toMatchObject({ state: 'missing', path: null, lines: ['Not installed'] })
  expect(missing.command, 'the install command').toMatch(/install/)
  await claudeCard.getByRole('button', { name: 'Copy the install command for Claude Code' }).click()
  await until('the install command copied', async () => (await clipboard(page)).at(-1) === missing.command || undefined)

  // installed and signed in while Settings is open: "Look again" detects afresh
  const claude = fakeAgent(run, 'claude', 'e-set-3-claude', `steps:\n  - hook: UserPromptSubmit\n  - ${frame('✶ Working…')}\n  - wait: key\n`)
  const cmd = fakeAgent(run, 'commandcode', 'e-set-3-cmd', turn)
  // by key, as the rest of the sheet is used: the keyboard stays on the button while Kea looks, and after
  const look = sheet.getByRole('button', { name: 'Look again' })
  await look.focus()
  await page.keyboard.press('Enter')
  await until('both found, signed in', async () => ((await cardSays(claudeCard)).state === 'installed' && (await cardSays(cmdCard)).lines[0] === 'Version 1.79.2 · Signed in') || undefined)
  expect(await cardSays(cmdCard)).toEqual({ state: 'installed', path: path.join(run.agentBin, 'cmd'), lines: ['Version 1.79.2 · Signed in'], command: null })
  const found = await cardSays(claudeCard)
  expect(found).toMatchObject({ state: 'installed', path: path.join(run.agentBin, 'claude'), command: null })
  expect(found.lines[0]).toMatch(/^Version \d+\.\d+\.\d+ · Signed in$/)
  expect(await look.evaluate((e) => e === document.activeElement), 'the keyboard is still on "Look again": Esc, Tab and ↵ go on working in the sheet').toBe(true)

  // ── each card's keys: the ones every agent has, then its own (auto-trust is Command Code's alone) ──
  const trust = cmdCard.getByRole('switch', { name: 'Auto-trust Kea worktrees' })
  await expect(trust).toBeChecked()
  await expect(claudeCard.getByRole('switch', { name: 'Auto-trust Kea worktrees' })).toHaveCount(0)
  const bypass = cmdCard.getByRole('switch', { name: 'Allow bypass-permission modes' })
  await expect(bypass).not.toBeChecked()
  await expect(claudeCard.getByRole('switch', { name: 'Allow bypass-permission modes' })).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // "Allow bypass-permission modes" off: neither agent's composer lists a mode that skips permission prompts
  await promptFocused(page)
  expect(await modesListed(page), 'Claude Code').toEqual(CLAUDE_MODES)
  await chooseCommandCode(page)
  expect(await modesListed(page), 'Command Code').toEqual(CMD_MODES)

  // ── on for Command Code, and its trust key off ──
  sheet = await openSettings(page, 'Agents')
  await bypass.focus()
  await page.keyboard.press('Space')
  await expect(bypass).toBeChecked({ timeout: STEP_MS })
  await expect(cmdCard.locator('[data-setting="agents.commandcode.allowDangerousModes"]').getByRole('status')).toContainText('it can run any command and change any file your account can')
  await expect(claudeCard.getByRole('switch', { name: 'Allow bypass-permission modes' }), 'one agent’s key, not the other’s').not.toBeChecked()
  await trust.focus()
  await page.keyboard.press('Space')
  await expect(trust).not.toBeChecked({ timeout: STEP_MS })
  const written = JSON.parse(fs.readFileSync(path.join(run.home, 'settings.json'), 'utf8')) as { agents?: Record<string, unknown> }
  expect(written.agents).toEqual({ commandcode: { allowDangerousModes: true, autoTrustWorktrees: false } })
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // the composer follows at once, for Command Code alone
  await promptFocused(page)
  expect((await selectorsShown(page))[0]).toBe('Agent: Command Code')
  expect(await modesListed(page), 'Command Code now offers yolo').toEqual([...CMD_MODES, YOLO])
  let menu = await openSelector(page, 1, 'Agent')
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  expect(await modesListed(page), 'Claude Code offers nothing more').toEqual(CLAUDE_MODES)
  await chooseCommandCode(page)
  menu = await openSelector(page, 4, 'Permission mode')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await promptFocused(page)
  expect((await selectorsShown(page))[3]).toBe(`Permission mode: ${YOLO}`)

  // both keys reach the launch: the mode as Command Code's flag, and no `--trust` for the worktree Kea made
  const id = await startSession(kea, 'take it away', { open: false })
  await waitLive(kea, id)
  const argv = (await agentStarts(cmd.log, 1))[0]!.argv
  expect(argv.slice(0, 2)).toEqual(['--permission-mode', 'yolo'])
  expect(argv).not.toContain('--trust')
  expect(argv.slice(-2)).toEqual(['--', 'take it away'])
  expect(fs.existsSync(claude.log), 'Claude Code was never started').toBe(false)
  await kea.assertUnfocused()
})

/** What a program is told the background is under a bundled theme: OSC 11's answer, as xterm writes it. */
const backgroundOf = (theme: 'kea-dark' | 'kea-light'): string => toRgbString(parseXColor(THEMES[theme].background)!)

/** An agent that asks for the terminal's colours as it starts and again for every line it is given (the answers are in its log). */
const ASKS_COLOURS = `steps:
  - probe: [osc11, osc10]
  - ${frame('ready')}
onLine:
  - probe: [osc11, osc10]
  - print: "ASKED {{line}}\\r\\n"
`

/** The background each colour probe of the agents that log to `log` was answered with, in order (every agent of a flavour shares its log; `pid` tells them apart). */
function backgroundsTold(log: string, pid?: number): string[] {
  return (agentEvents(log) as unknown as { t: string; pid: number; results?: { id: string; value: string | null }[] }[])
    .filter((e) => e.t === 'probe' && (pid === undefined || e.pid === pid))
    .map((e) => e.results?.find((r) => r.id === 'osc11')?.value ?? '(no answer)')
}

test('E-SET-4 · Kea Light with both agents: a Claude Code and a Command Code session started under Kea Dark are each told the dark background when they ask; Kea Light chosen in Settings, both are told the light one the next time they ask, with nothing restarted, and so is a session started afterwards; after a quit and relaunch the sessions are back, drawn light, and each is still told the light background', async ({ run, launch }) => {
  test.setTimeout(120_000)
  claudeByDefault(run)
  const claude = fakeAgent(run, 'claude', 'e-set-4-claude', ASKS_COLOURS)
  const cmd = fakeAgent(run, 'commandcode', 'e-set-4-cmd', ASKS_COLOURS)
  const dark = backgroundOf('kea-dark')
  const light = backgroundOf('kea-light')
  expect(light).not.toBe(dark)
  let kea = await launch()
  let page = await kea.page()
  await addProject(kea, demoRepo(run).root)

  // ── under Kea Dark: each agent asks as it starts ──
  const a = await startSession(kea, 'claude in the dark', { open: false })
  await waitLive(kea, a)
  await until('Claude Code was answered', () => backgroundsTold(claude.log).length === 1 || undefined)
  expect(backgroundsTold(claude.log)).toEqual([dark])
  await page.keyboard.press(sysKey('Meta+n'))
  await chooseCommandCode(page)
  const b = await startSession(kea, 'command code in the dark', { open: false })
  await waitLive(kea, b)
  await until('Command Code was answered', () => backgroundsTold(cmd.log).length === 1 || undefined)
  expect(backgroundsTold(cmd.log)).toEqual([dark])
  const holders = run.holders().map((h) => ({ ptyId: h.ptyId, pid: h.pid, childPid: h.childPid })).sort((x, y) => x.ptyId.localeCompare(y.ptyId))

  // ── Kea Light, chosen in Settings › Terminal ──
  const sheet = await openSettings(page, 'Terminal')
  await sheet.getByRole('combobox', { name: 'Theme' }).selectOption({ label: 'Kea Light' })
  await expect(sheet.getByRole('img', { name: 'Preview' })).toHaveAttribute('data-theme', 'kea-light', { timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  /** Give the session on screen a line: its agent asks again; resolves with what it was told this time. */
  const askAgain = async (k: Kea, log: string, word: string): Promise<string> => {
    const before = backgroundsTold(log).length
    await until('the keyboard in the terminal', () => inTerminal(k))
    await k.type(word)
    await k.press('Enter')
    await k.waitScreen(`the agent asked (${word})`, (x) => x.includes(`ASKED ${word}`))
    return until('its answer logged', () => backgroundsTold(log)[before])
  }
  /** Show a session with a click on its row and give its terminal the keyboard. */
  const show = async (k: Kea, id: string): Promise<void> => {
    const p = await k.page()
    await sessionRow(p, id).click({ position: { x: 30, y: 10 } })
    await until(`session ${id} in the pane`, async () => (await paneSession(p)) === id || undefined)
    const host = p.locator('.terminal-host.shown')
    const box = await host.boundingBox()
    await host.click({ position: { x: 20, y: Math.max(20, (box?.height ?? 40) - 20) } })
  }
  // sessions started before the switch: the mirror that answers them has the new colours (no restart: the same agents)
  await show(kea, b)
  expect(await askAgain(kea, cmd.log, 'cmd-light'), 'Command Code, started under Kea Dark').toBe(light)
  await show(kea, a)
  expect(await askAgain(kea, claude.log, 'claude-light'), 'Claude Code, started under Kea Dark').toBe(light)
  expect(run.holders().map((h) => ({ ptyId: h.ptyId, pid: h.pid, childPid: h.childPid })).sort((x, y) => x.ptyId.localeCompare(y.ptyId)), 'nothing restarted').toEqual(holders)

  // a session started after the switch asks as it starts
  await page.keyboard.press(sysKey('Meta+n'))
  await chooseCommandCode(page)
  const c = await startSession(kea, 'command code in the light', { open: false })
  await waitLive(kea, c)
  await until('the new Command Code was answered', () => backgroundsTold(cmd.log).length === 3 || undefined)
  expect(backgroundsTold(cmd.log).at(-1), 'started under Kea Light').toBe(light)

  // ── quit and relaunch: the sessions ran on; their mirrors are rebuilt with the theme the settings name ──
  expect(await kea.quitFromMenu(), 'Kea quits cleanly').toEqual({ code: 0, signal: null })
  await kea.gone()
  kea = await launch({ ready: 'window' })
  page = await kea.page()
  await until('the sessions listed again', async () => {
    const listed = await sessionIds(page)
    return [a, b, c].every((id) => listed.includes(id)) || undefined
  })
  for (const id of [a, b, c]) await waitLive(kea, id)
  await show(kea, a)
  expect(await askAgain(kea, claude.log, 'claude-again'), 'Claude Code, after the relaunch').toBe(light)
  await show(kea, b)
  expect(await askAgain(kea, cmd.log, 'cmd-again'), 'Command Code, after the relaunch').toBe(light)
  // and the window draws them light
  const drawnBackground = await page.evaluate(() => {
    const probe = (window as unknown as { __keaProbe: { views(): { ptyId: string; shown: boolean }[]; terminal(id: string): unknown } }).__keaProbe
    const shown = probe.views().find((v) => v.shown)!
    return (probe.terminal(shown.ptyId) as { options: { theme: { background: string } } }).options.theme.background
  })
  expect(drawnBackground.toLowerCase()).toBe(THEMES['kea-light'].background.toLowerCase())
  expect(run.holders().map((h) => ({ ptyId: h.ptyId, pid: h.pid, childPid: h.childPid })).filter((h) => holders.some((x) => x.ptyId === h.ptyId)).sort((x, y) => x.ptyId.localeCompare(y.ptyId)), 'the same agents all along').toEqual(holders)
  await kea.assertUnfocused()
})
