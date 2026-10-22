// Ended sessions, quitting and the session actions: Kea launched through tests/e2e/fixtures.ts (unfocused, temp
// KEA_HOME, hermetic git), sessions started from the composer, `⌘Q` and the menu-bar item driven through main
// (tests/support/app-menubar.ts). E-SES-5 and E-SES-6 run the `shell` pseudo-agent, a login shell that prints what the
// test writes to a FIFO while Kea is not running; E-SES-8…10 run tools/fake-agent as Claude Code (`fakeClaude`: a
// scenario per session and an event log the test reads), so the real CLI is never run.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { STEP_MS, until, writeFifo, type Kea, type KeaRun } from '../support/app.ts'
import { addProject, agentTerminal, demoRepo, paneSession, projectRow, promptBox, rowState, selectSession, sessionMenu, startSession, tabKinds, tabOf, waitLive, waitRow } from '../support/app-sessions.ts'
import { skipNote } from '../support/skip.ts'
import { sysLabel } from '../support/keys.ts'
import { clickMenuBarItem, DOCK_HIDDEN, DOCK_SHOWN, inMenuBar, menuBar, menuBarState, NO_MENU_BAR, pressQuit, quitSheet } from '../support/app-menubar.ts'
import { clickNotification, notifications, shown, waitNotifications } from '../support/app-status.ts'
import { expect, test } from './fixtures.ts'

/** Main's exit status, once it has exited. */
function exitOf(kea: Kea): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const proc = kea.app.process()
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve({ code: proc.exitCode, signal: proc.signalCode })
    else proc.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

/** "On quit" in the run's settings.json: `general.onQuit`, or null when absent (the default). */
function onQuitSetting(run: KeaRun): string | null {
  const settings = JSON.parse(fs.readFileSync(path.join(run.home, 'settings.json'), 'utf8')) as { general?: { onQuit?: string } }
  return settings.general?.onQuit ?? null
}

/** What every fake agent of this file draws first: how a test finds it on screen. */
const AGENT_MARK = '✻ fake-agent'
/** Electron's own interval: a Dock hide within it of a show does nothing (shell/browser/browser_mac.mm). */
const ELECTRON_DOCK_HIDE_IGNORED_MS = 1000
/** A gate's content: an asciicast with nothing to replay (fake-agent's `cassette` step reads it whole, then goes on). */
const CAST = '{"version": 2, "width": 80, "height": 24}\n'

/**
 * Make tools/fake-agent `claude` the default agent (tests/support/app.ts puts its shim first on PATH) for the sessions
 * started from now on, running `steps` (scenario lines, YAML) and logging to the returned file; a later call gives the
 * next sessions another scenario (the shim is read at each launch).
 */
function fakeClaude(run: KeaRun, name: string, steps: string[]): { log: string } {
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
  const file = path.join(run.home, `${name}.yaml`)
  fs.writeFileSync(file, ['version: 1', `name: ${name}`, 'steps:', ...steps, ''].join('\n'))
  const log = path.join(run.home, `${name}.log`)
  writeAgentShim(run.agentBin, 'claude', { env: { FAKE_AGENT_SCENARIO: file, FAKE_AGENT_LOG: log } })
  return { log }
}

/** Every event the fake agents logged to `log` so far (tools/fake-agent README "Event log"). */
function agentEvents(log: string): ({ t: string } & Record<string, unknown>)[] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { t: string } & Record<string, unknown>)
}

/** The fake agents' `start` records in `log`, once there are `n`. */
async function agentStarts(log: string, n: number): Promise<{ argv: string[]; sessionId: string; cwd: string }[]> {
  return until(`${n} fake agent start(s) in ${path.basename(log)}`, () => {
    const starts = agentEvents(log).filter((r) => r.t === 'start') as unknown as { argv: string[]; sessionId: string; cwd: string }[]
    return starts.length >= n ? starts : undefined
  })
}

/** Every file of a working tree (`.git` aside) with its content. */
function treeFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(dir, path.join(e.parentPath, e.name))
    if (rel === '.git' || rel.startsWith(`.git${path.sep}`) || !e.isFile()) continue
    out[rel] = fs.readFileSync(path.join(dir, rel), 'latin1')
  }
  return out
}

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

/** Show a session and wait until its Agent tab is on screen with the fake agent drawn; resolves with its ptyId. */
async function fakeAgentTerminal(kea: Kea, id: string): Promise<string> {
  if ((await paneSession(await kea.page())) !== id) await selectSession(kea, id)
  const pty = await tabOf(kea, 'agent')
  await until('the Agent terminal on screen', async () => (await kea.shown()) === pty || undefined)
  await kea.waitScreen('the fake agent', (s) => s.includes(AGENT_MARK))
  return pty
}

/** A FIFO in the run's home: the agent reads lines from it while Kea is not running. */
function fifoIn(dir: string, name: string): string {
  const f = path.join(dir, name)
  execFileSync('mkfifo', [f])
  return f
}

test('E-SES-5 · first ⌘Q with a live session: the sheet (Keep in Menu Bar the default) → Quit Completely, which becomes "On quit"; relaunch; later ⌥⌘Q and relaunch; then ⌘Q quits completely without asking: the sheet comes only that first time; after each relaunch the session is live and reattached with what it printed meanwhile, its status as before', async ({ run, launch }) => {
  test.skip(NO_MENU_BAR !== null, skipNote(NO_MENU_BAR ?? ''))
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'quit around me')
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)
  const fifo = fifoIn(run.home, 'meanwhile')
  // the agent prints each line that reaches the FIFO, whether Kea runs or not
  await kea.enter(`while read l < ${fifo}; do echo "got-$l"; done`)
  const before = (await rowState(page, id))!
  await menuBarState(kea, 'one session kept running', (s) => s.live === 1)

  // the first ⌘Q: the sheet
  await pressQuit(kea)
  const sheet = quitSheet(page)
  await expect(sheet, 'the first-quit sheet').toBeVisible({ timeout: STEP_MS })
  await expect(sheet).toContainText('1 session keeps running')
  await expect(sheet.getByRole('button', { name: 'Keep in Menu Bar' }), 'the default').toHaveAttribute('data-default', 'true')
  await expect(sheet.getByRole('button', { name: 'Stop All and Quit' })).toBeVisible()
  const exited = exitOf(kea)
  await sheet.getByRole('button', { name: 'Quit Completely' }).click()
  expect(await exited, 'Kea quits cleanly').toEqual({ code: 0, signal: null })
  await kea.gone()
  expect(onQuitSetting(run), 'Quit Completely became "On quit", written before Kea quit').toBe('quit')
  expect(run.holderAlive(run.holder(agent)), 'the agent runs on').toBe(true)
  await writeFifo(fifo, 'one\n')
  await until('the agent printed while Kea was not running', () => run.ring(agent).text.includes('got-one') || undefined)

  const reattached = async (k: Kea, line: string) => {
    await waitRow(k, id, 'live after the relaunch, its status as before', (r) => r.lifecycle === 'live' && r.status === before.status)
    expect(await agentTerminal(k, id), 'the same agent, reattached').toBe(agent)
    await k.waitScreen(`what it printed meanwhile (${line})`, (s) => s.includes(line))
  }
  const second = await launch()
  await reattached(second, 'got-one')

  // later: ⌥⌘Q (Quit Kea Completely) asks nothing
  expect(await second.quitFromMenu(), 'Kea quits cleanly').toEqual({ code: 0, signal: null })
  await second.gone()
  await writeFifo(fifo, 'two\n')
  await until('the agent printed while Kea was not running', () => run.ring(agent).text.includes('got-two') || undefined)
  const third = await launch()
  await reattached(third, 'got-two')

  // and ⌘Q no longer asks: the sheet was answered once, and its answer is "On quit" now, so ⌘Q quits completely
  const m = await menuBarState(third, 'one session kept running, "On quit" as answered', (s) => s.live === 1 && s.onQuit === 'quit')
  expect(m.sheetSeen, 'the sheet’s answer is remembered').toBe(true)
  await third.assertUnfocused()
  const exited3 = exitOf(third)
  await pressQuit(third)
  expect(await exited3, 'Kea quits cleanly, asking nothing').toEqual({ code: 0, signal: null })
  await third.gone()
  expect(run.holderAlive(run.holder(agent)), 'the agent runs on').toBe(true)
})

test('E-SES-6 · the agent exits while Kea is closed: on relaunch the session is detached, its last screen dimmed under the overlay (Session ended · Resume ↵ · Restart ⌘↵); ↵ in the terminal resumes it through the agent’s resume path and the new agent takes the one Agent tab', async ({ run, launch }) => {
  const kea = await launch()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'exit while closed')
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)
  const fifo = fifoIn(run.home, 'last-words')
  await kea.enter(`read l < ${fifo}; echo "last words: $l"; exit 0`)
  expect(await kea.quitFromMenu(), 'Kea quits cleanly').toEqual({ code: 0, signal: null })
  await kea.gone()
  await writeFifo(fifo, 'E-SES-6\n')
  await until('the agent exited while Kea was closed', () => run.holder(agent).exited || undefined)

  const again = await launch({ ready: 'window' })
  const page = await again.page()
  await waitRow(again, id, 'detached after the relaunch', (r) => r.lifecycle === 'detached')
  await selectSession(again, id)
  expect(await tabOf(again, 'agent'), 'the ended agent keeps its tab').toBe(agent)
  await until('the ended Agent tab on screen', async () => (await again.shown()) === agent || undefined)
  // Its last screen, from checkpoint and ring (its holder is gone), dimmed
  await again.waitScreen('the agent’s last screen', (s) => s.includes('last words: E-SES-6'))
  const opacity = await page.evaluate(() => {
    const host = document.querySelector('.terminal-frame.ended .terminal-host.shown')
    return host ? Number(getComputedStyle(host).opacity) : null
  })
  expect(opacity, 'dimmed').not.toBeNull()
  expect(opacity!).toBeLessThan(1)
  const overlay = page.getByRole('status', { name: 'Session ended' })
  await expect(overlay).toContainText('Session ended')
  await expect(overlay.getByRole('button', { name: 'Resume' })).toContainText(sysLabel('↵'))
  await expect(overlay.getByRole('button', { name: 'Restart' })).toContainText(sysLabel('⌘↵'))

  // ↵, the keyboard in the ended terminal: Resume (the default action)
  await page.locator('.terminal-host.shown').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('Enter')
  await waitRow(again, id, 'live after Resume', (r) => r.lifecycle === 'live')
  await until('the agent launched through the resume path', () => again.logLines('core').some((l) => l.msg === 'agent launched' && l.sessionId === id && l.how === 'resume') || undefined)
  await until('one Agent tab', async () => (await tabKinds(page)).join() === 'agent' || undefined)
  const next = await agentTerminal(again, id)
  expect(next, 'a new agent PTY').not.toBe(agent)
  await expect(overlay, 'no overlay over a running agent').toHaveCount(0)
  await again.echo('resumed')
  await again.assertUnfocused()
})

test('E-SES-8 · menu-bar mode with fake-agent sessions: ⌘Q with live sessions → Keep in Menu Bar (now "On quit"): window and renderer gone, Dock icon hidden, the menu-bar item there; one agent asks for permission meanwhile (its hook): posted and counted (1), another crashes after it: counted, listed in ⌘J’s order; picking the crashed one reopens the window, and ⌘Q at once goes back with the Dock icon hidden; picked again it shows its Agent tab; the permission request’s notification, clicked from the menu bar, reopens Kea on that session’s Agent tab', async ({ run, launch }) => {
  test.skip(NO_MENU_BAR !== null, skipNote(NO_MENU_BAR ?? ''))
  // (each agent waits at a gate, a FIFO its scenario reads as a cassette, until the test opens it: fake-agent has no
  // step that waits for the outside world, and no key can reach it while no window is open. The perf budget P-MEM-5
  // measures the footprint meanwhile.)
  const crashGate = fifoIn(run.home, 'crash.cast')
  const askGate = fifoIn(run.home, 'ask.cast')
  // the crashing agent: working, then (gate) it exits 3 (its end hook first, as every graceful end)
  const crashes = fakeClaude(run, 'crashes', [`  - frame: ["${AGENT_MARK}", "", "> {{prompt}}", "", "✶ Working…"]`, `  - cassette: { file: ${JSON.stringify(crashGate)}, speed: 0 }`, '  - exit: 3'])
  const kea = await launch()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const crashy = await startSession(kea, 'crashes later', { background: true })
  await waitLive(kea, crashy)
  await agentStarts(crashes.log, 1) // it has read its scenario: the shim can change
  // the asking agent: working, then (gate) it asks for permission to run Bash: npm test, and waits for the answer
  fakeClaude(run, 'asks', [
    `  - frame: ["${AGENT_MARK}", "", "> {{prompt}}", "", "✶ Working…"]`,
    `  - cassette: { file: ${JSON.stringify(askGate)}, speed: 0 }`,
    '  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }',
    `  - frame: ["${AGENT_MARK}", "", "> {{prompt}}", "", "Bash(npm test)  Allow? (y/n)"]`,
    '  - wait: key',
  ])
  const needy = await startSession(kea, 'asks for permission', { background: true, open: false })
  await waitLive(kea, needy)
  const page = await kea.page()
  const needyTitle = (await rowState(page, needy))!.title
  const agent = await fakeAgentTerminal(kea, crashy)
  const needyAgent = await fakeAgentTerminal(kea, needy)
  await menuBarState(kea, 'two sessions kept running, nobody needing you', (s) => s.live === 2 && s.count === 0)
  const renderer = (await kea.processes()).renderer!

  await pressQuit(kea)
  await quitSheet(page).getByRole('button', { name: 'Keep in Menu Bar' }).click({ timeout: STEP_MS })
  const m = await inMenuBar(kea)
  expect(m.title, 'nothing needs you yet').toBe('')
  await until('Keep in Menu Bar written as "On quit"', () => onQuitSetting(run) === 'menuBar' || undefined)
  await until('the renderer process to exit', () => !run.leftovers().some((p) => p.pid === renderer.pid) || undefined)
  expect((await kea.appMetrics()).filter((x) => x.type === 'Tab'), 'no renderer process').toEqual([])
  const procs = await kea.processes()
  expect(procs.core && procs.ptyhost, 'core and ptyhost run on').toBeTruthy()

  // the agent asks for permission while Kea runs from the menu bar (its PermissionRequest hook): posted, counted,
  // listed
  await writeFifo(askGate, CAST)
  const one = await menuBarState(kea, 'one session needs you', (s) => s.count === 1)
  expect(one.title, 'the count in the menu bar').toBe('1')
  expect(one.state!.sessions.map((s) => [s.id, s.reason, s.glyph])).toEqual([[needy, 'permission', 'needsYou']])
  const posted = await waitNotifications(kea, 'the permission request posted', (p) => p.live.includes(`s:${needy}`))
  expect(shown(posted).filter((x) => x.id === `s:${needy}`).map((x) => [x.title, x.subtitle, x.body])).toEqual([[`${needyTitle} · needs permission`, 'demo', 'Bash: npm test']])
  expect(posted.badge, 'no Dock badge while the Dock icon is hidden: the item’s title says it').toBe('')

  // the other agent crashes meanwhile: counted and listed after it, and posted
  await writeFifo(crashGate, CAST)
  const two = await menuBarState(kea, 'two sessions need you', (s) => s.count === 2)
  expect(two.title).toBe('2')
  expect(two.state!.sessions.map((s) => [s.id, s.reason])).toEqual([
    [needy, 'permission'],
    [crashy, 'crashed'],
  ])
  const crashed = await waitNotifications(kea, 'the crash posted', (p) => p.live.includes(`s:${crashy}`))
  expect(shown(crashed).find((x) => x.id === `s:${crashy}`)?.body).toBe('exited 3')
  expect(two.item && two.dock === DOCK_HIDDEN, 'still in the menu bar').toBe(true)

  // the crashed one picked from the menu-bar item reopens the window, and ⌘Q comes at once, within Electron's second of
  // the Dock icon coming back: Kea is back in the menu bar with the Dock icon hidden
  const reopened = kea.app.waitForEvent('window', { timeout: STEP_MS })
  const clickedAt = Date.now()
  expect(await clickMenuBarItem(kea, `session:${crashy}`)).toBe(true)
  await pressQuit(kea)
  expect(Date.now() - clickedAt, 'the second ⌘Q within Electron’s second of the Dock show').toBeLessThan(ELECTRON_DOCK_HIDE_IGNORED_MS)
  await reopened
  const again = await inMenuBar(kea)
  expect(again.title, 'still counting both').toBe('2')

  // picked again: the window reopens on it, its ended Agent tab on screen
  const opened = kea.app.waitForEvent('window', { timeout: STEP_MS })
  expect(await clickMenuBarItem(kea, `session:${crashy}`)).toBe(true)
  await opened
  await kea.whenDrawn()
  const page2 = await kea.page()
  await until('the crashed session in the main pane', async () => (await paneSession(page2)) === crashy || undefined)
  await until('its Agent tab on screen', async () => (await kea.shown()) === agent || undefined)
  const back = await menuBar(kea)
  expect([back.item, back.dock], 'out of the menu bar: no item, the Dock icon back').toEqual([false, DOCK_SHOWN])
  await waitNotifications(kea, 'the Dock badge with the count', (p) => p.badge === '2')

  // back to the menu bar; the permission request's notification, clicked: Kea reopens on that session's Agent tab
  await pressQuit(kea)
  await inMenuBar(kea)
  const viaNotification = kea.app.waitForEvent('window', { timeout: STEP_MS })
  expect(await clickNotification(kea, `s:${needy}`)).toBe(true)
  await viaNotification
  await kea.whenDrawn()
  const page3 = await kea.page()
  await until('the session in the main pane', async () => (await paneSession(page3)) === needy || undefined)
  await until('its Agent tab on screen', async () => (await kea.shown()) === needyAgent || undefined)
  await kea.waitScreen('the agent’s permission prompt', (s) => s.includes('Allow? (y/n)'))
  expect((await notifications(kea)).live, 'a clicked notification is gone').not.toContain(`s:${needy}`)
  expect(await menuBar(kea).then((x) => [x.item, x.dock]), 'out of the menu bar').toEqual([false, DOCK_SHOWN])
  await kea.assertUnfocused()
})

test('E-SES-9 · session actions on a fake-agent session: Stop Agent on a working agent: it gets SIGTERM, its end hook (Kea’s hook command) runs before it exits, and the session is detached with the dashed ring, not the failure glyph, its overlay saying "Session stopped"; Duplicate opens the composer pre-filled with the same prompt and agent and base = that session’s branch', async ({ run, launch }) => {
  const { log } = fakeClaude(run, 'works', [
    `  - frame: ["${AGENT_MARK}", "", "> {{prompt}}", "", "✶ Working…"]`,
    '  - hook: UserPromptSubmit',
    '  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }',
    '  - wait: key',
  ])
  const kea = await launch()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'stop me while I work')
  await waitLive(kea, id)
  const [start] = await agentStarts(log, 1)
  const branch = gitIn(start!.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  await fakeAgentTerminal(kea, id)
  await waitRow(kea, id, 'working (its hooks reached Kea)', (r) => r.status === 'working')

  // Stop Agent (the session menu): SIGTERM to its process group, its SessionEnd hook first, then the exit
  await sessionMenu(kea, id, 'session.stop')
  const stopped = await waitRow(kea, id, 'detached after Stop', (r) => r.lifecycle === 'detached')
  expect(stopped.status, 'the dashed ring (detached), not the failure glyph').toBe('detached')
  const events = agentEvents(log)
  const ending = events.findIndex((e) => e.t === 'ending')
  const endHook = events.findIndex((e) => e.t === 'hook' && e.event === 'SessionEnd')
  const exit = events.findIndex((e) => e.t === 'exit')
  // fake-agent's SIGTERM path: SessionEnd with reason `other` (what Claude 2.1.296 sends then), then exit 128 + 15
  expect(events[ending], 'the agent got SIGTERM').toMatchObject({ reason: 'other', code: 143 })
  expect(endHook, 'its end hook ran after that').toBeGreaterThan(ending)
  expect(exit, 'and then it exited').toBeGreaterThan(endHook)
  expect(events[exit]!.code, 'by itself, not killed').toBe(143)
  const runs = (events[endHook]!.runs as { exitCode: number | null; timedOut: boolean }[] | undefined) ?? []
  expect(runs.length > 0 && runs.every((r) => r.exitCode === 0 && !r.timedOut), 'Kea’s hook command for it ran and returned').toBe(true)
  const page = await kea.page()
  const overlay = page.getByRole('status', { name: 'Session ended' })
  await expect(overlay).toContainText('Session stopped', { timeout: STEP_MS })

  // Duplicate (the session menu): the composer, pre-filled, its base this session's branch
  await sessionMenu(kea, id, 'session.duplicate')
  const composer = page.getByRole('region', { name: 'New session' })
  await expect(composer).toBeVisible({ timeout: STEP_MS })
  await expect(promptBox(page)).toHaveValue('stop me while I work')
  await expect(composer.getByRole('button', { name: `Base branch: ${branch}` }), 'base = the session’s branch').toBeVisible()
  await expect(composer.getByRole('button', { name: 'Agent: Claude Code' })).toBeVisible()
  expect((await agentStarts(log, 1)).length, 'Duplicate starts nothing by itself').toBe(1)
  await kea.assertUnfocused()
})

test('E-SES-10 · restore: a fake-agent session with uncommitted work (modified, deleted, renamed, untracked) deleted, its branch kept; Restore Deleted Session… lists it with its title, branch and deletion time; it comes back detached, its working tree byte for byte as it was; Resume relaunches the agent with its resume argv, the same conversation', async ({ run, launch }) => {
  const { log } = fakeClaude(run, 'restored', [
    `  - frame: ["${AGENT_MARK}", "", "> {{prompt}}", "", "⏺ Done."]`,
    '  - hook: UserPromptSubmit',
    '  - hook: { event: Stop, fields: { last_assistant_message: "Done." } }',
  ])
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'delete and restore me')
  await waitLive(kea, id)
  const [first] = await agentStarts(log, 1)
  const cwd = first!.cwd
  const conversation = first!.sessionId
  expect(first!.argv, 'a creation starts the conversation with its id').toEqual(expect.arrayContaining(['--session-id', conversation]))
  const branch = gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const title = (await rowState(page, id))!.title
  // uncommitted work: a modified, a deleted, a renamed and an untracked file
  fs.appendFileSync(path.join(cwd, 'README.md'), 'an uncommitted edit\n')
  fs.rmSync(path.join(cwd, 'src', 'counter.js'))
  fs.renameSync(path.join(cwd, 'src', 'hello.js'), path.join(cwd, 'src', 'greet.js'))
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'never committed\n')
  const status = gitIn(cwd, 'status', '--porcelain', '--untracked-files=all')
  const files = treeFiles(cwd)
  expect(status.split('\n').filter(Boolean), 'the fixture: edited, deleted, renamed (deleted + new), new').toHaveLength(5)

  // delete it, keeping its branch
  await sessionMenu(kea, id, 'session.delete')
  const del = page.getByRole('alertdialog', { name: 'Delete session' })
  await expect(del).toContainText('5 uncommitted files', { timeout: STEP_MS })
  // "delete branch too" is ticked for a branch with no commits of its own; this one is kept
  await del.getByRole('checkbox').uncheck()
  await del.getByRole('button', { name: 'Delete' }).click()
  await until('the row gone', async () => (await rowState(page, id)) === null || undefined)
  await until('the worktree directory gone', () => !fs.existsSync(cwd) || undefined)

  // Restore Deleted Session… (the project menu): listed with title, branch and time
  await projectRow(page, 'demo').click({ button: 'right' })
  await page.getByRole('menu', { name: 'Project menu' }).locator('[role=menuitem][data-command="session.restoreDeleted"]').click({ timeout: STEP_MS })
  const sheet = page.getByRole('alertdialog', { name: 'Restore deleted session' })
  const listed = sheet.getByRole('list', { name: 'Deleted sessions' }).getByRole('listitem')
  await expect(listed).toHaveCount(1, { timeout: STEP_MS })
  await expect(listed).toContainText(title)
  await expect(listed).toContainText(branch)
  await expect(listed).toContainText('deleted just now')
  // the same count as the delete sheet's (counted the same way, rename detection off, whatever the git config)
  await expect(listed, 'what the snapshot holds').toContainText('5 changed files')
  await listed.getByRole('button', { name: 'Restore' }).click()

  // back detached, its files as they were
  await waitRow(kea, id, 'detached after Restore', (r) => r.lifecycle === 'detached' && r.status === 'detached' && r.selected)
  await until('the worktree back', () => fs.existsSync(cwd) || undefined)
  expect(gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'the same branch').toBe(branch)
  expect(gitIn(cwd, 'status', '--porcelain', '--untracked-files=all'), 'the same uncommitted changes').toBe(status)
  expect(treeFiles(cwd), 'the working tree byte for byte as it was').toEqual(files)

  // Resume: the agent again, through its resume command, in the same conversation
  const overlay = page.getByRole('status', { name: 'Session ended' })
  await overlay.getByRole('button', { name: 'Resume' }).click({ timeout: STEP_MS })
  await waitRow(kea, id, 'live after Resume', (r) => r.lifecycle === 'live')
  const [, resumed] = await agentStarts(log, 2)
  expect(resumed!.argv, 'the adapter’s resume argv').toEqual(expect.arrayContaining(['--resume', conversation]))
  expect(resumed!.argv, 'not a new conversation').not.toContain('--session-id')
  expect(resumed!.sessionId, 'the same conversation').toBe(conversation)
  expect(resumed!.cwd, 'in the restored worktree').toBe(cwd)
  await until('the agent launched through the resume path', () => kea.logLines('core').some((l) => l.msg === 'agent launched' && l.sessionId === id && l.how === 'resume') || undefined)
  await fakeAgentTerminal(kea, id)
  await kea.assertUnfocused()
})
