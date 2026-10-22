// The dev server: Kea launched through tests/e2e/fixtures.ts and driven as a person drives it: `⌘R`, the header
// control, the URL chip, the Server tab, the session and project menus. The server is the process zoo's stand-in
// (tools/process-zoo/src/server.ts): loopback only, on the session's own `$PORT` or on a port inside a block of this
// run's sessions, and stopped before a test ends. A click on the chip reaches main, which under `--kea-perf` records
// the link instead of opening a browser (tests/support/app-server.ts).

import fs from 'node:fs'
import path from 'node:path'
import { STEP_MS, until } from '../support/app.ts'
import { addProject, agentTerminal, demoRepo, projectRow, rowState, selectSession, sessionMenu, startSession, tabKinds, tabOf, waitLive, waitRow } from '../support/app-sessions.ts'
import { commandReason, commitFiles, listening, opened, recordServerStates, serverAddress, serverAnswer, serverChip, serverCommand, serverControl, serverScript, serverState, serverStatesSeen, waitServer, worktreesOf } from '../support/app-server.ts'
import { expect, test } from './fixtures.ts'
import { sysKey, textKey } from '../support/keys.ts'

/** The JSON lines the stand-in servers of a test appended to their `--log`. */
function serverLog(file: string): { server: string; pid?: number; port?: number; signal?: string }[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { server: string; pid?: number; port?: number; signal?: string })
}

/** `ok <pid> <port> PORT=<$PORT> FORCE_COLOR=<$FORCE_COLOR>`, taken apart. */
function answerParts(answer: string): { pid: number; port: number; envPort: string; color: string } {
  const m = /^ok (\d+) (\d+) PORT=(\S*) FORCE_COLOR=(\S*)$/.exec(answer)
  if (!m) throw new Error(`not the stand-in server's answer: ${JSON.stringify(answer)}`)
  return { pid: Number(m[1]), port: Number(m[2]), envPort: m[3] as string, color: m[4] as string }
}

test('E-SRV-1 · a worktree with start.sh: ⌘R shows Starting, then Stop with the `:PORT ↗` chip; the Server tab shows its output; the chip opens its URL (recorded, no browser); ⌘R again stops it and the port is free', async ({ run, launch }) => {
  const repo = demoRepo(run)
  const log = path.join(run.home, 'servers.ndjson')
  commitFiles(repo.root, { 'start.sh': serverScript(['--log', log]) }, { executable: true })
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'serve')
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)

  // Start.sh is there, so the control offers Run; nothing runs yet and there is no Server tab
  await waitServer(kea, 'stopped')
  const control = serverControl(page)
  await expect(control.getByRole('button', { name: 'Run' })).toBeVisible()
  await expect(serverChip(page)).toHaveCount(0)
  expect(await tabKinds(page)).toEqual(['agent'])
  expect(await commandReason(kea, 'server.toggle'), 'Run is available').toBeNull()

  // ⌘R: Starting, then Stop and the chip
  await recordServerStates(page)
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'running')
  const at = await serverAddress(kea)
  // Starting lasts while the server's terminal is being started: the window shows it unless both changes came in one store tick
  const up = await serverStatesSeen(page)
  expect(up.at(0)).toEqual({ state: 'stopped', label: 'Run' })
  expect(up.at(-1)).toEqual({ state: 'running', label: 'Stop' })
  expect(up.slice(1, -1).filter((x) => x.state !== 'starting' || x.label !== 'Starting'), 'nothing but Starting in between').toEqual([])
  await expect(control.getByRole('button', { name: 'Stop' })).toBeVisible()
  expect(at).toMatchObject({ url: `http://localhost:${at.port}/`, label: `:${at.port} ↗` })
  // It is the session's own server: on its `$PORT`, colours on
  const answer = answerParts(await until('the server answers', async () => (await serverAnswer(at.port)) || undefined))
  expect(answer).toMatchObject({ port: at.port, envPort: String(at.port), color: '1' })
  expect(serverLog(log).filter((l) => l.server === 'ready')).toEqual([{ server: 'ready', pid: answer.pid, port: at.port }])

  // Its output is the Server tab, listed after the Agent tab; running it did not take the screen
  expect(await tabKinds(page)).toEqual(['agent', 'server'])
  expect(await kea.shown(), 'the Agent terminal is still on screen').toBe(agent)
  const server = await tabOf(kea, 'server')
  await expect(page.locator(`[role=tab][data-pty="${server}"]`)).toHaveText('Server')
  await kea.clickTab(server)
  await kea.waitScreen('the server’s own output', (s) => s.includes(`http://localhost:${at.port}/`) && s.includes(`PORT=${at.port}`))

  // A click on the chip opens the URL — main records it under the harness, and no browser opens
  expect(await opened(kea)).toEqual([])
  await serverChip(page).click()
  await until('the link to reach main', async () => (await opened(kea)).length > 0 || undefined)
  expect(await opened(kea)).toEqual([at.url])
  expect(kea.logLines('main').filter((l) => l.msg === 'link not opened'), 'no link was refused').toEqual([])

  // ⌘R again: Stop, from the Server tab; the control is Run again, the chip is gone, the port is free
  await recordServerStates(page)
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'stopped')
  const down = await serverStatesSeen(page)
  expect(down.at(0)).toEqual({ state: 'running', label: 'Stop' })
  expect(down.at(-1)).toEqual({ state: 'stopped', label: 'Run' })
  expect(down.slice(1, -1).filter((x) => x.state !== 'stopping' || x.label !== 'Stopping…'), 'nothing but Stopping… in between').toEqual([])
  await expect(control.getByRole('button', { name: 'Run' })).toBeVisible()
  await expect(serverChip(page)).toHaveCount(0)
  expect(await listening(at.port), `port ${at.port} free`).toBe(false)
  expect(serverLog(log).filter((l) => l.server === 'signal'), 'it was asked to stop as ⌃C would').toEqual([{ server: 'signal', signal: 'SIGINT' }])
  // the Server tab stays, with what the run printed
  expect(await tabKinds(page)).toEqual(['agent', 'server'])
  expect(await kea.terminalText(server)).toContain(`http://localhost:${at.port}/`)
  await kea.assertUnfocused()
})

test('E-SRV-2 · a start.sh that exits 1: the control reads `Exited 1` with Restart beside it; one click opens the Server tab with the output; the session’s row shows no error', async ({ run, launch }) => {
  const repo = demoRepo(run)
  commitFiles(repo.root, { 'start.sh': '#!/bin/sh\necho "kea-test: cannot find the database"\nexit 1\n' }, { executable: true })
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, repo.root)
  const id = await startSession(kea, 'crash')
  await waitLive(kea, id)
  const agent = await agentTerminal(kea, id)
  const before = await rowState(page, id)
  await waitServer(kea, 'stopped')

  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'crashed')
  const control = serverControl(page)
  const exited = control.getByRole('button', { name: 'Exited 1' })
  await expect(exited).toBeVisible()
  await expect(control.getByRole('button', { name: 'Restart' })).toBeVisible()
  await expect(serverChip(page)).toHaveCount(0)
  // a crashed dev server is not an agent problem: the row is as it was, and the Agent terminal is still on screen
  expect(await rowState(page, id)).toEqual(before)
  expect(await kea.shown()).toBe(agent)

  // One click opens the log
  await exited.click()
  const server = await tabOf(kea, 'server')
  await until('the Server tab on screen', async () => (await kea.shown()) === server || undefined)
  await kea.waitScreen('the output that says why', (s) => s.includes('kea-test: cannot find the database'))
  await expect(page.locator(`[role=tab][data-pty="${server}"]`)).toHaveAttribute('aria-selected', 'true')

  // Restart runs it again: the Server tab is the new run's, still on screen, and still the only one
  await control.getByRole('button', { name: 'Restart' }).click()
  const again = await until('the new run’s Server tab', async () => {
    const pty = await tabOf(kea, 'server')
    return pty !== server && (await tabKinds(page)).filter((k) => k === 'server').length === 1 ? pty : undefined
  })
  await waitServer(kea, 'crashed')
  await until('the new run on screen', async () => (await kea.shown()) === again || undefined)
  await kea.waitScreen('the new run’s output', (s) => s.includes('kea-test: cannot find the database'))
  expect(await tabKinds(page)).toEqual(['agent', 'server'])
  await kea.assertUnfocused()
})

test('E-SRV-3 · dev server details: no start.sh hides the control and Run says why; PORT reaches the server but not a shell tab; Restart keeps the one Server tab on screen; the tab outlives Stop; auto-start runs it with a new session; archiving stops it; a second session on a hard-coded busy port gets the hint and "Stop it and run here"', async ({ run, launch }) => {
  test.setTimeout(240_000)
  const repo = demoRepo(run)
  const log = path.join(run.home, 'servers.ndjson')
  const own = serverScript(['--log', log])
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, repo.root)
  const control = serverControl(page)
  const worktree = (slug: string): string => {
    const w = worktreesOf(repo.root).find((x) => x.branch.includes(slug))
    if (!w) throw new Error(`no worktree on a branch with ${slug}: ${JSON.stringify(worktreesOf(repo.root))}`)
    return w.dir
  }
  const writeStart = (dir: string, text: string) => fs.writeFileSync(path.join(dir, 'start.sh'), text, { mode: 0o755 })
  const answerOn = async (port: number) => answerParts(await until(`the server on ${port} answers`, async () => (await serverAnswer(port)) || undefined))
  const title = async (id: string) => ((await rowState(page, id)) as { title: string }).title

  // ── Nothing to run. The control is hidden, ⌘R does nothing, and Run says why ───────────────────
  const a = await startSession(kea, 'alpha server')
  await waitLive(kea, a)
  const agentA = await agentTerminal(kea, a)
  expect(await serverState(page), 'no control without start.sh').toBeNull()
  expect(await commandReason(kea, 'server.toggle')).toBe('No start.sh in this worktree')
  expect(await commandReason(kea, 'server.restart')).toBe('No start.sh in this worktree')
  expect(await commandReason(kea, 'server.showLog')).toBe('The dev server has not run in this session')
  await page.keyboard.press(sysKey('Meta+r'))
  // a start.sh appears in the worktree: the control does too (the worktree is watched while the session is on screen)
  const dirA = worktree('alpha')
  writeStart(dirA, own)
  await waitServer(kea, 'stopped')
  expect(await tabKinds(page), 'the ⌘R with nothing to run started nothing').toEqual(['agent'])
  expect(await commandReason(kea, 'server.toggle')).toBeNull()

  // ── PORT is the server's alone; KEA_PORT is everywhere ──
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'running')
  const atA = await serverAddress(kea)
  const first = await answerOn(atA.port)
  expect(first).toMatchObject({ port: atA.port, envPort: String(atA.port), color: '1' })
  await kea.newTab()
  await kea.enter('echo "p=[${PORT-unset}] k=[$KEA_PORT]"')
  await kea.waitScreen('the shell tab’s PORT and KEA_PORT', (s) => s.includes(`p=[unset] k=[${atA.port}]`))
  await kea.clickTab(agentA)
  await kea.enter('echo "p=[${PORT-unset}] k=[$KEA_PORT]"')
  await kea.waitScreen('the agent terminal’s PORT and KEA_PORT', (s) => s.includes(`p=[unset] k=[${atA.port}]`))

  // ── Restart (⇧⌘R) from the Server tab: a new process on the same port, the one Server tab is the new
  // run's and stays on screen (a shell tab is open after it), with the old run's output gone ──
  const serverTab = await tabOf(kea, 'server')
  await kea.clickTab(serverTab)
  await kea.waitScreen('the first run’s output', (s) => s.includes(`"pid":${first.pid}`))
  await page.keyboard.press(sysKey('Meta+Shift+KeyR'))
  const second = await until('a new server process on the same port', async () => {
    const got = await serverAnswer(atA.port)
    return got && answerParts(got).pid !== first.pid ? answerParts(got) : undefined
  })
  await waitServer(kea, 'running')
  expect(await tabKinds(page)).toEqual(['agent', 'server', 'shell'])
  const restarted = await tabOf(kea, 'server')
  expect(restarted, 'a new terminal for the new run').not.toBe(serverTab)
  await until('the new run’s Server tab on screen', async () => (await kea.shown()) === restarted || undefined)
  await kea.waitScreen('the new run’s output', (s) => s.includes(`"pid":${second.pid}`))
  expect(await kea.terminalText(restarted), 'the scrollback is the new run’s alone').not.toContain(`"pid":${first.pid}`)
  expect((await serverAddress(kea)).port).toBe(atA.port)

  // ── The Server tab outlives Stop, with its output ──
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'stopped')
  expect(await listening(atA.port)).toBe(false)
  expect(await tabKinds(page)).toEqual(['agent', 'server', 'shell'])
  expect(await kea.terminalText(restarted)).toContain(`"pid":${second.pid}`)
  expect(await commandReason(kea, 'server.showLog')).toBeNull()

  // ── With the project's "Start the dev server with each session" on, a new session's server starts by itself ──
  commitFiles(repo.root, { 'start.sh': own }, { executable: true })
  await projectRow(page, 'demo').click({ button: 'right' })
  await page.getByRole('menu', { name: 'Project menu' }).locator('[role=menuitem][data-command="project.settings"]').click()
  const settings = page.getByRole('dialog', { name: 'Project settings' })
  const auto = settings.getByRole('switch', { name: 'Start the dev server with each session' })
  await auto.click()
  await expect(auto).toBeChecked({ timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  const b = await startSession(kea, 'bravo server')
  await waitLive(kea, b)
  await agentTerminal(kea, b)
  await waitServer(kea, 'running')
  const atB = await serverAddress(kea)
  expect(atB.port, 'its own block').not.toBe(atA.port)
  const autoStarted = await answerOn(atB.port)
  expect(autoStarted).toMatchObject({ port: atB.port, envPort: String(atB.port) })
  expect(await tabKinds(page)).toEqual(['agent', 'server'])
  // a third session, started the same way: it is the one that meets the busy port below
  const c = await startSession(kea, 'charlie server')
  await waitLive(kea, c)
  await agentTerminal(kea, c)
  await waitServer(kea, 'running')
  const atC = await serverAddress(kea)
  expect(new Set([atA.port, atB.port, atC.port]).size, 'three sessions, three ports').toBe(3)
  const dirC = worktree('charlie')

  // ── A start.sh that always listens on one port: a port of this run's own, in Bravo's block, which
  // is no block of the two sessions that fight over it. Alpha runs it; Run in Charlie is told who holds the port, and
  // one click moves it ──
  const fixed = atB.port + 4
  const hardCoded = serverScript(['--port', String(fixed), '--log', log])
  await selectSession(kea, c)
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'stopped')
  expect(await listening(atC.port)).toBe(false)
  writeStart(dirA, hardCoded)
  writeStart(dirC, hardCoded)
  await selectSession(kea, a)
  await waitServer(kea, 'stopped')
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'running')
  expect(await serverAddress(kea)).toMatchObject({ port: fixed, label: `:${fixed} ↗` })
  const held = await answerOn(fixed)
  expect(held.envPort, 'PORT is still its own; the script ignores it').toBe(String(atA.port))
  await selectSession(kea, c)
  await page.keyboard.press(sysKey('Meta+r'))
  const hint = control.getByRole('status')
  await expect(hint).toContainText(`Port ${fixed} is used by session ${await title(a)}`, { timeout: STEP_MS })
  expect((await answerOn(fixed)).pid, 'Alpha’s server still holds the port').toBe(held.pid)
  await hint.getByRole('button', { name: 'Stop it and run here' }).click()
  const moved = await until('Charlie’s server on the port', async () => {
    const got = await serverAnswer(fixed)
    return got && answerParts(got).pid !== held.pid ? answerParts(got) : undefined
  })
  await waitServer(kea, 'running')
  expect(await serverAddress(kea)).toMatchObject({ port: fixed })
  await expect(hint).toHaveCount(0)
  expect(moved.envPort, 'it is Charlie’s').toBe(String(atC.port))
  await selectSession(kea, a)
  await waitServer(kea, 'stopped')
  await expect(control.getByRole('button', { name: 'Run' })).toBeVisible()

  // ── Archiving a session stops its server ──
  const signals = () => serverLog(log).filter((l) => l.server === 'signal').length
  const stoppedBefore = signals()
  await sessionMenu(kea, b, 'session.archive')
  // A running dev server is one of the three things Archive asks about first
  const archive = page.getByRole('alertdialog', { name: 'Archive session' })
  await expect(archive.getByRole('listitem')).toHaveText(['A dev server is running'], { timeout: STEP_MS })
  expect(await listening(atB.port), 'nothing is stopped before the answer').toBe(true)
  await archive.getByRole('button', { name: 'Archive' }).click()
  await until('the archived session’s server gone', async () => !(await listening(atB.port)) || undefined)
  await until('it was asked to stop, not left behind or killed outright', () => signals() === stoppedBefore + 1 || undefined)
  expect((await answerOn(fixed)).pid, 'the other session’s server is untouched').toBe(moved.pid)
  const archivedGroup = page.getByRole('treeitem', { name: 'Archived (1)' })
  await expect(archivedGroup).toBeVisible({ timeout: STEP_MS })
  // an archived session runs none (core refuses it: `wrongState`): shown, its header offers no Run, and the command says why
  await archivedGroup.click()
  await waitRow(kea, b, 'archived, listed', (r) => r.lifecycle === 'archived')
  await selectSession(kea, b)
  await expect(page.getByRole('status').filter({ hasText: 'Archived.' })).toBeVisible({ timeout: STEP_MS })
  expect(await commandReason(kea, 'server.toggle')).toBe('This session cannot run a dev server now')
  await expect(control, 'no Run on a session that cannot run one').toHaveCount(0)

  // every stand-in server is stopped before the test ends
  await selectSession(kea, c)
  await waitServer(kea, 'running')
  await page.keyboard.press(sysKey('Meta+r'))
  await waitServer(kea, 'stopped')
  for (const port of [atA.port, atB.port, atC.port, fixed]) expect(await listening(port), `port ${port} free`).toBe(false)
  await waitRow(kea, a, 'still live', (r) => r.lifecycle === 'live')
  await kea.assertUnfocused()
})

test('E-SRV-4 · a project’s run command typed into Project Settings: the Run control comes up for its sessions with no start.sh in their worktrees, in the one on screen at once and in one started afterwards; a click on Run starts that command on the session’s own port; the field emptied, the control goes again', async ({ run, launch }) => {
  const repo = demoRepo(run)
  const log = path.join(run.home, 'servers.ndjson')
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, repo.root)
  const control = serverControl(page)
  const settings = page.getByRole('dialog', { name: 'Project settings' })
  const field = settings.locator('label.settings-row', { hasText: 'Run command' }).locator('input')
  /** Project Settings from the project's menu in the sidebar, the keyboard in the "Run command" field. */
  const openRunCommand = async () => {
    await projectRow(page, 'demo').click({ button: 'right' })
    await page.getByRole('menu', { name: 'Project menu' }).locator('[role=menuitem][data-command="project.settings"]').click()
    await field.click()
  }
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
  }

  const a = await startSession(kea, 'alpha command')
  await waitLive(kea, a)
  await agentTerminal(kea, a)
  expect(await serverState(page), 'no control: no start.sh, no run command').toBeNull()
  expect(await commandReason(kea, 'server.toggle')).toBe('No start.sh in this worktree')

  // the command, typed as a person types `pnpm dev`, and Enter: the session on screen gets the control at once
  await openRunCommand()
  const command = serverCommand(['--log', log])
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect(field).toHaveValue(command)
  await closeSettings()
  await waitServer(kea, 'stopped')
  await expect(control.getByRole('button', { name: 'Run' })).toBeVisible()
  expect(await commandReason(kea, 'server.toggle')).toBeNull()

  // a session started afterwards has it too, and neither worktree has a start.sh
  const b = await startSession(kea, 'bravo command')
  await waitLive(kea, b)
  await agentTerminal(kea, b)
  await waitServer(kea, 'stopped')
  expect(worktreesOf(repo.root).map((w) => fs.existsSync(path.join(w.dir, 'start.sh')))).toEqual([false, false])

  // Run, by a click: the command is what runs, with this session's PORT
  await control.getByRole('button', { name: 'Run' }).click()
  await waitServer(kea, 'running')
  const at = await serverAddress(kea)
  const answer = answerParts(await until(`the server on ${at.port} answers`, async () => (await serverAnswer(at.port)) || undefined))
  expect(answer).toMatchObject({ port: at.port, envPort: String(at.port) })
  expect(serverLog(log).filter((l) => l.server === 'ready'), 'one server, the one the command names').toEqual([{ server: 'ready', pid: answer.pid, port: at.port }])
  await control.getByRole('button', { name: 'Stop' }).click()
  await waitServer(kea, 'stopped')
  expect(await listening(at.port)).toBe(false)

  // the field emptied: nothing to run again, in this session and in the other
  await openRunCommand()
  await page.keyboard.press(textKey('Meta+a'))
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  await expect(field).toHaveValue('')
  await closeSettings()
  await waitServer(kea, null)
  expect(await commandReason(kea, 'server.toggle')).toBe('No start.sh in this worktree')
  await selectSession(kea, a)
  await agentTerminal(kea, a)
  await waitServer(kea, null)
})
