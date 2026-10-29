// The session journeys: Kea launched through tests/e2e/fixtures.ts (unfocused, temp KEA_HOME, hermetic git), a demo
// repository added with ⌘O, sessions started from the composer and driven from the sidebar, the keyboard and the
// context menus (tests/support/app-sessions.ts). Sessions run the `shell` pseudo-agent, the harness's default
// (tests/support/app.ts), so an Agent tab is a login shell.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { SHELLS_SESSION } from '@kea/core/src/terminal/reconcile.ts'
import { COMMANDS, CREATION_STEPS, L, protocolOs } from '@kea/protocol'
import { counterCommand, counterNumbers, PROMPT, ringMax, STEP_MS, until, type Kea } from '../support/app.ts'
import { holdersUnharmed, lastOnScreen, ringContinuity, seamContinuous } from '../support/app-chaos.ts'
import { skipNote } from '../support/skip.ts'
import { loseWebglContext, startGlWatch, stopGlWatch } from '../support/app-render.ts'
import { addProject, agentTerminal, demoRepo, menuCommands, paneSession, projectRow, rowState, selectSession, sessionIds, sessionMenu, sessionRow, startSession, tabKinds, tabOf, waitForeground, waitLive, waitRow } from '../support/app-sessions.ts'
import { expect, test } from './fixtures.ts'
import { sysKey, TERMINAL_TEXT_KEYS } from '../support/keys.ts'

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString()

/** The main header's session title. */
const headerTitle = (page: Page) => page.getByRole('main', { name: 'Session' }).locator('h1.session-title').textContent()

/** Start `n` sessions in the background, wait until all are live; ids in sidebar order (newest first). */
async function sessionsLive(kea: Kea, prompts: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const [i, p] of prompts.entries()) ids.push(await startSession(kea, p, { background: true, open: i === 0 }))
  for (const id of ids) await waitLive(kea, id)
  const page = await kea.page()
  const order = await sessionIds(page)
  return order.filter((id) => ids.includes(id))
}

/** The text on the first visible row of the terminal on screen. */
async function topRow(kea: Kea): Promise<string> {
  return (await kea.screen()).split('\n')[0] ?? ''
}

test('E-SES-2 · five sessions: ⌘1…5 select the rows top to bottom and ⌃Tab cycles the most recently used; header and terminal always belong to the selected session; its last tab and its scroll position are back on return', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const ids = await sessionsLive(kea, ['first task', 'second task', 'third task', 'fourth task', 'fifth task'])
  expect(ids).toHaveLength(5)
  const titles = new Map<string, string>()
  const agents = new Map<string, string>()
  for (const [i, id] of ids.entries()) {
    titles.set(id, (await rowState(page, id))!.title)
    const pty = await agentTerminal(kea, id)
    agents.set(id, pty)
    await kea.enter(`echo E-SES-2 row-$((${i}+1))`)
    await kea.waitScreen(`row ${i + 1}’s marker`, (s) => s.includes(`E-SES-2 row-${i + 1}`))
  }

  /** The terminal each session shows on return: its Agent tab, or the tab it was left on. */
  const onReturn = new Map(agents)
  /** The window shows `id` in its pane, its header, its sidebar row and the terminal on screen. */
  const showing = async (id: string, what: string) => {
    await until(`${what}: the pane on ${titles.get(id)}`, async () => (await paneSession(page)) === id || undefined)
    expect(await headerTitle(page), `${what}: the header`).toBe(titles.get(id))
    expect((await rowState(page, id))?.selected, `${what}: its row selected`).toBe(true)
    await until(`${what}: its terminal on screen`, async () => (await kea.shown()) === onReturn.get(id) || undefined)
    if (onReturn.get(id) !== agents.get(id)) return
    const i = ids.indexOf(id) + 1
    await kea.waitScreen(`${what}: its own output`, (s) => s.includes(`E-SES-2 row-${i}`) && !Array.from({ length: 5 }, (_, k) => k + 1).some((k) => k !== i && s.includes(`E-SES-2 row-${k}\n`)))
  }

  // ⌘1…5: the first five rows, top to bottom
  for (let k = 1; k <= 5; k++) {
    await page.keyboard.press(sysKey(`Meta+${k}`))
    await showing(ids[k - 1]!, `⌘${k}`)
  }
  // ⌃Tab: the most recently used before this one (⌘4); again: back (⌘5); ⌃ held over two Tabs: two back (⌘3)
  await page.keyboard.press('Control+Tab')
  await showing(ids[3]!, '⌃Tab')
  await page.keyboard.press('Control+Tab')
  await showing(ids[4]!, '⌃Tab again')
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Control')
  await showing(ids[2]!, '⌃Tab Tab')

  // the last tab: a shell tab opened in row 1, then away and back
  await page.keyboard.press(sysKey('Meta+1'))
  await showing(ids[0]!, 'row 1')
  await page.keyboard.press(sysKey('Meta+t'))
  const shell = await until('the new shell tab on screen', async () => {
    const s = await kea.shown()
    return s && s !== agents.get(ids[0]!) ? s : undefined
  })
  await kea.waitScreen('the shell tab’s prompt', (s) => s.includes(PROMPT))
  onReturn.set(ids[0]!, shell)
  await page.keyboard.press(sysKey('Meta+2'))
  await showing(ids[1]!, 'row 2')
  await page.keyboard.press(sysKey('Meta+1'))
  await showing(ids[0]!, 'row 1 again, on its shell tab')
  expect(await page.locator(`[role=tab][data-pty="${shell}"]`).getAttribute('aria-selected')).toBe('true')

  // the scroll position: row 3's Agent terminal scrolled up into its history, then four other sessions visited, three of
  // them on their Agent terminals (more than the warm set holds, so row 3's is rebuilt from a snapshot), then back
  await page.keyboard.press(sysKey('Meta+3'))
  await showing(ids[2]!, 'row 3')
  await kea.enter('for i in $(seq 1 200); do echo "history line $i"; done')
  await kea.waitScreen('the history printed', (s) => s.includes('history line 200'))
  const area = page.locator('.terminal-host.shown .xterm-screen')
  await area.hover()
  await page.mouse.wheel(0, -1500)
  await until('the view scrolled up into the history', async () => /history line \d+$/.test((await topRow(kea)).trim()) && !(await kea.screen()).includes('history line 200') || undefined)
  const top = (await topRow(kea)).trim()
  for (const k of [4, 5, 2, 1]) {
    await page.keyboard.press(sysKey(`Meta+${k}`))
    await showing(ids[k - 1]!, `row ${k}`)
  }
  expect(L.warmTerminals, 'four other sessions visited are more than the warm set holds').toBeLessThan(4)
  expect((await kea.views()).some((v) => v.ptyId === agents.get(ids[2]!)), 'row 3’s terminal was released (not warm)').toBe(false)
  await page.keyboard.press(sysKey('Meta+3'))
  await until('row 3 again', async () => (await kea.shown()) === agents.get(ids[2]!) || undefined)
  await until(`row 3’s view back where it was ("${top}" on top)`, async () => (await topRow(kea)).trim() === top || undefined)
  await kea.assertUnfocused()
})

test('E-SES-3 · archive a session whose shell tab runs a program (asks first) → Archived group → Unarchive → delete it with a dirty worktree: the sheet’s numbers match git exactly and say what stays restorable; after the delete no directory, no worktree entry, the snapshot ref there', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const [id] = await sessionsLive(kea, ['archive and delete me'])
  const title = (await rowState(page, id!))!.title
  await agentTerminal(kea, id!)
  // a shell tab with a foreground program: archiving asks
  const shell = await kea.newTab()
  await kea.enter('sleep 600')
  await waitForeground(run, shell, 'sleep')
  await sessionRow(page, id!).hover()
  await page.getByRole('button', { name: `Archive ${title}` }).click()
  const ask = page.getByRole('alertdialog', { name: 'Archive session' })
  await expect(ask, 'archive asks while a shell runs a program').toBeVisible({ timeout: STEP_MS })
  await expect(ask).toContainText('A shell tab is running a program')
  await ask.getByRole('button', { name: 'Archive' }).click()
  // the Archived group: "Archived (1)", collapsed; open it, the row is there, archived; Unarchive from its menu
  const group = page.getByRole('treeitem', { name: 'Archived (1)' })
  await expect(group).toBeVisible({ timeout: STEP_MS })
  await group.click()
  await waitRow(kea, id!, 'archived', (r) => r.lifecycle === 'archived')
  await sessionMenu(kea, id!, 'session.unarchive')
  await waitRow(kea, id!, 'detached after Unarchive', (r) => r.lifecycle === 'detached')
  await expect(page.getByRole('treeitem', { name: /^Archived/ }), 'no Archived group with nothing in it').toHaveCount(0)

  // work in the worktree: two commits (one also on another branch), edits and new files
  const cwd = gitIn(repo.root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((w) => w !== repo.root)!
  const branch = gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  for (const f of ['one.txt', 'two.txt']) {
    fs.writeFileSync(path.join(cwd, f), `${f}\n`)
    gitIn(cwd, 'add', f)
    gitIn(cwd, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', f)
  }
  gitIn(repo.root, 'branch', 'holds-one', `${branch}~1`)
  fs.appendFileSync(path.join(cwd, 'README.md'), 'edited\n')
  fs.writeFileSync(path.join(cwd, 'new-a.txt'), 'a\n')
  fs.writeFileSync(path.join(cwd, 'new-b.txt'), 'b\n')
  const uncommitted = gitIn(cwd, 'status', '--porcelain').split('\n').filter(Boolean).length
  const own = Number(gitIn(cwd, 'rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', '--remotes').trim())
  expect([uncommitted, own], 'the fixture: 3 uncommitted files, 1 commit only the branch holds').toEqual([3, 1])

  await sessionMenu(kea, id!, 'session.delete')
  const sheet = page.getByRole('alertdialog', { name: 'Delete session' })
  await expect(sheet).toContainText(`Deleting removes the worktree with ${uncommitted} uncommitted files and ${own} commit on no other branch or remote.`, { timeout: STEP_MS })
  await expect(sheet).toContainText(`Uncommitted changes and commits stay restorable for ${(await settingDays())} days`)
  const tick = sheet.getByRole('checkbox')
  await expect(tick, 'the branch has a commit of its own: not pre-ticked').not.toBeChecked()
  await sheet.getByRole('button', { name: 'Delete' }).click()
  await until('the row gone', async () => (await rowState(page, id!)) === null || undefined)
  await until('the worktree directory gone', () => !fs.existsSync(cwd) || undefined)
  expect(gitIn(repo.root, 'worktree', 'list', '--porcelain'), 'no worktree entry').not.toContain(cwd)
  expect(gitIn(repo.root, 'for-each-ref', '--format=%(refname)', `refs/kea/deleted/${id}`).trim(), 'the snapshot ref').toBe(`refs/kea/deleted/${id}`)
  expect(gitIn(repo.root, 'branch', '--list', branch).trim(), 'the branch kept, as the sheet promised').not.toBe('')
  await kea.assertUnfocused()
})

/** Counter lines per second in E-TERM-6: a reload and its recovery stay well inside the scrollback. */
const RATE = 4

/** Show a session and wait until its Agent terminal is on screen (whatever it shows). */
async function showAgent(kea: Kea, id: string): Promise<string> {
  const page = await kea.page()
  if ((await paneSession(page)) !== id) await selectSession(kea, id)
  const pty = await tabOf(kea, 'agent')
  await until(`the Agent terminal of ${id} on screen`, async () => (await kea.shown()) === pty || undefined)
  return pty
}

test('E-TERM-6 · counters running in the Agent tabs of two sessions, the second one’s terminal warm, reload the window: both Agent terminals continuous, no number missing or doubled', async ({ run, launch }) => {
  const kea = await launch()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const [a, b] = await sessionsLive(kea, ['counts on screen', 'counts warm'])
  const agentB = await agentTerminal(kea, b!)
  await kea.enter(counterCommand(RATE))
  await kea.waitScreen('the second session’s counter', (s) => counterNumbers(s).length >= 2)
  const agentA = await agentTerminal(kea, a!)
  await kea.enter(counterCommand(RATE))
  await kea.waitScreen('the first session’s counter', (s) => counterNumbers(s).length >= 2)
  expect((await kea.views()).map((v) => v.ptyId), 'the second session’s Agent terminal is warm (alive, hidden)').toContain(agentB)
  const holders = await until('both agents’ holders', () => {
    const live = run.holders().filter((h) => run.holderAlive(h) && (h.ptyId === agentA || h.ptyId === agentB))
    return live.length === 2 ? live : undefined
  })
  const seen = await lastOnScreen(kea)
  const warmSeen = ringMax(run, agentB)

  await kea.reloadWindow()

  expect(await showAgent(kea, a!), 'the first session’s Agent terminal').toBe(agentA)
  const visible = await seamContinuous(run, kea, agentA, { before: seen })
  expect(visible.first, 'the buffer holds the visible counter from its first line').toBe(1)
  expect(await showAgent(kea, b!), 'the second session’s Agent terminal').toBe(agentB)
  const warm = await seamContinuous(run, kea, agentB, { before: warmSeen })
  expect(warm.first, 'the buffer holds the warm counter from its first line').toBe(1)
  holdersUnharmed(run, holders)
  ringContinuity(run, agentA)
  ringContinuity(run, agentB)
  await kea.assertUnfocused()
})

test('E-TERM-7 · six sessions with two tabs each visited in turn, a WebGL context lost on an Agent tab: the active session’s other tab stays alive without WebGL; the warm terminals are the Agent terminals of the three most recently viewed other sessions, with WebGL; everything else is rebuilt from a snapshot; never more contexts than the cap allows', async ({ run, launch }) => {
  const kea = await launch()
  await kea.oneColumn()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const ids = await sessionsLive(kea, ['one', 'two', 'three', 'four', 'five', 'six'].map((n) => `renderer ${n}`))
  const agents = new Map<string, string>()
  const shells = new Map<string, string>()
  const marker = (i: number, tab: string) => `E-TERM-7 session ${i} ${tab}`
  // each session: a marker in its Agent tab, a shell tab with its own, then back on the Agent tab
  for (const [i, id] of ids.entries()) {
    agents.set(id, await agentTerminal(kea, id))
    await kea.enter(`echo "${marker(i, 'agent')}"`)
    await kea.waitScreen(`session ${i}’s agent marker`, (s) => s.includes(`${marker(i, 'agent')}\n`))
    await page.keyboard.press(sysKey('Meta+t'))
    const sh = await until(`session ${i}’s shell tab on screen`, async () => {
      const x = await kea.shown()
      return x && x !== agents.get(id) ? x : undefined
    })
    shells.set(id, sh)
    await kea.waitScreen('the shell tab’s prompt', (s) => s.includes(PROMPT))
    await kea.enter(`echo "${marker(i, 'shell')}"`)
    await kea.waitScreen(`session ${i}’s shell marker`, (s) => s.includes(`${marker(i, 'shell')}\n`))
    await kea.clickTab(agents.get(id)!)
  }
  const noGl = await kea.webglProblem()
  test.skip(noGl !== null, skipNote(noGl ?? ''))
  await startGlWatch(kea)

  // 1. the Agent tab on screen loses its context (as on a GPU reset): WebGL comes back on the same terminal
  const last = ids.at(-1)!
  const before = (await kea.views()).find((v) => v.ptyId === agents.get(last))!
  await loseWebglContext(kea, agents.get(last)!)
  await expect.poll(async () => (await kea.views()).find((v) => v.ptyId === agents.get(last))?.webgl, { message: 'WebGL back on the Agent tab' }).toBe(true)
  expect((await kea.views()).find((v) => v.ptyId === agents.get(last))?.instance, 'the same terminal').toBe(before.instance)

  // 2. every session in turn, then three back: the warm-terminal policy, by session
  let mru = [...ids].reverse() // most recently viewed first
  let alive = new Set((await kea.views()).map((v) => v.ptyId))
  const index = (id: string) => ids.indexOf(id)
  for (const id of [...ids, ...ids.slice(0, -1).reverse().slice(0, 3)]) {
    const i = index(id)
    const agent = agents.get(id)!
    const shell = shells.get(id)!
    const prev = (await kea.views()).find((v) => v.ptyId === agent)
    await kea.debug('ptyhost', 'streams', 'reset')
    await selectSession(kea, id)
    await until(`session ${i}’s Agent tab on screen`, async () => (await kea.shown()) === agent || undefined)
    await kea.waitScreen(`session ${i}’s Agent text`, (s) => s.includes(`${marker(i, 'agent')}\n`))
    const streams = await kea.debug<{ snapshots: number }>('ptyhost', 'streams')
    const now = (await kea.views()).find((v) => v.ptyId === agent)!
    if (alive.has(agent)) {
      expect(now.instance, `session ${i}’s warm Agent terminal kept, not rebuilt`).toBe(prev?.instance)
      expect(streams.snapshots, `no snapshot for session ${i}’s warm Agent terminal`).toBe(0)
    } else {
      expect(prev, `session ${i}’s Agent terminal was not alive`).toBeUndefined()
      expect(streams.snapshots, `session ${i}’s Agent terminal rebuilt from one snapshot`).toBe(1)
    }
    // its shell tab, then back: the shell stays alive, without WebGL, while the Agent tab is on screen
    await kea.clickTab(shell)
    await kea.waitScreen(`session ${i}’s shell text`, (s) => s.includes(`${marker(i, 'shell')}\n`))
    await kea.clickTab(agent)
    mru = [id, ...mru.filter((x) => x !== id)]
    const warm = mru
      .slice(1)
      .map((x) => agents.get(x)!)
      .filter((a) => alive.has(a))
      .slice(0, L.warmTerminals)
    alive = new Set([agent, shell, ...warm])
    await until(`session ${i}: its two tabs and the warm Agent terminals of ${warm.length} others alive`, async () => {
      const v = await kea.views()
      return (v.length === alive.size && v.every((x) => alive.has(x.ptyId))) || undefined
    }).catch(async (e) => {
      const name = (pty: string) => ids.map((x, k) => (agents.get(x) === pty ? `a${k}` : shells.get(x) === pty ? `s${k}` : '')).join('') || pty
      // the live views by session (a: Agent tab, s: shell tab; +gl: WebGL; *: on screen)
      throw new Error(`${(e as Error).message}: ${JSON.stringify((await kea.views()).map((v) => `${name(v.ptyId)}${v.webgl ? '+gl' : ''}${v.shown ? '*' : ''}`))} expected ${JSON.stringify([...alive].map(name))}`)
    })
    const views = await kea.views()
    expect(views.filter((v) => v.webgl).map((v) => v.ptyId).sort(), 'WebGL on the Agent tab on screen and the warm ones').toEqual([agent, ...warm].sort())
    expect(views.find((v) => v.ptyId === shell)?.webgl, 'the active session’s other tab: alive, no WebGL').toBe(false)
  }

  const g = await stopGlWatch(kea)
  expect(g.maxCounted, 'contexts counted by the views, at most the cap in every frame').toBeLessThanOrEqual(L.webglContextsMax)
  expect(g.maxAlive, 'contexts alive on the views’ canvases, at most the cap in every frame').toBeLessThanOrEqual(L.webglContextsMax)
  expect(g.maxAlive, 'the cap is reached: the terminal on screen + three warm').toBe(1 + L.warmTerminals)
  expect(g.releasedAlive, `every released WebGL canvas lost its context first (${g.released} released)`).toBe(0)
  expect(g.lostOnShown, 'one context loss on the terminal on screen: the forced one').toBe(1)
  await kea.assertUnfocused()
})

test('E-TERM-5 · terminal keys vs. app keys, in a session’s Agent tab and in a shell tab: ⌘← ⌘→ ⌘⌫ edit the line (start, end, delete to start) and never archive; ⌘K clears screen and scrollback; then ⌘⇧⌫ with a shell running sleep asks before archiving', async ({ run, launch }) => {
  // (the Agent tab runs the `shell` pseudo-agent, the harness's default, so both tabs edit a shell's command line)
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const [id] = await sessionsLive(kea, ['keys'])
  const agent = await agentTerminal(kea, id!)
  await page.keyboard.press(sysKey('Meta+t'))
  const shell = await until('the shell tab on screen', async () => {
    const x = await kea.shown()
    return x && x !== agent ? x : undefined
  })
  await kea.waitScreen('the shell tab’s prompt', (s) => s.includes(PROMPT))
  /** The line being edited: the last prompt line on screen. */
  const editLine = async () => ((await kea.screen()).split('\n').filter((l) => l.startsWith(PROMPT)).at(-1) ?? '').trimEnd()

  for (const [tab, pty] of [
    ['Agent tab', agent],
    ['shell tab', shell],
  ] as const) {
    await kea.clickTab(pty)
    await kea.type('echo hello world')
    await until(`${tab}: the line typed`, async () => (await editLine()) === `${PROMPT}echo hello world` || undefined)
    if (TERMINAL_TEXT_KEYS) {
      await page.keyboard.press('Meta+ArrowLeft')
      await kea.type('X')
      await until(`${tab}: ⌘← moved to the start of the line`, async () => (await editLine()) === `${PROMPT}Xecho hello world` || undefined)
      await page.keyboard.press('Meta+ArrowRight')
      await kea.type('Y')
      await until(`${tab}: ⌘→ moved to the end of the line`, async () => (await editLine()) === `${PROMPT}Xecho hello worldY` || undefined)
      await page.keyboard.press('Meta+Backspace')
      await until(`${tab}: ⌘⌫ deleted to the start of the line`, async () => (await editLine()) === PROMPT.trimEnd() || undefined)
      expect((await rowState(page, id!))?.lifecycle, `${tab}: ⌘⌫ never archives`).toBe('live')
    } else {
      // ⌘← ⌘→ ⌘⌫ are macOS's: on Linux the shell's own ⌃U clears the line (a Ctrl key without Shift is the
      // terminal's)
      await page.keyboard.press('Control+u')
      await until(`${tab}: ⌃U deleted the line`, async () => (await editLine()) === PROMPT.trimEnd() || undefined)
    }
    // ⌘K: screen and scrollback cleared (more than a screen of output first)
    await kea.enter('seq 1 200')
    await kea.waitScreen(`${tab}: the output`, (s) => s.includes('200\n'))
    await page.keyboard.press(sysKey('Meta+k'))
    await until(`${tab}: ⌘K cleared screen and scrollback`, async () => {
      const text = await kea.terminalText(pty)
      return !/^\d+$/m.test(text) || undefined
    })
    const rows = (await kea.views()).find((v) => v.ptyId === pty)!.rows
    expect((await kea.terminalText(pty)).split('\n').length, `${tab}: no scrollback left`).toBeLessThanOrEqual(rows)
    expect((await kea.shown()) === pty && (await rowState(page, id!))?.lifecycle, `${tab}: still on screen, the session live`).toBe('live')
  }

  // ⌘⇧⌫ with a shell running sleep: Kea asks before archiving; Cancel keeps the session live
  await kea.enter('sleep 600')
  await waitForeground(run, shell, 'sleep')
  await page.keyboard.press(sysKey('Meta+Shift+Backspace'))
  const ask = page.getByRole('alertdialog', { name: 'Archive session' })
  await expect(ask, '⌘⇧⌫ asks while a shell runs a program').toBeVisible({ timeout: STEP_MS })
  await expect(ask).toContainText('A shell tab is running a program')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  expect((await rowState(page, id!))?.lifecycle, 'Cancel: still live').toBe('live')
  await kea.assertUnfocused()
})

test('E-TERM-11 · find open with highlights in a session’s terminal, then ⌘N: while the composer shows, no terminal keeps a search (no search addon, no highlights); Esc back to the session: the find bar is closed', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const [id] = await sessionsLive(kea, ['find then compose'])
  const agent = await agentTerminal(kea, id!)
  await kea.enter('for i in 1 2 3; do echo eterm11-match; done')
  await kea.waitScreen('the matches printed', (s) => (s.match(/^eterm11-match$/gm) ?? []).length === 3)
  await page.keyboard.press(sysKey('Meta+f'))
  await page.locator('.find-bar').waitFor({ state: 'attached', timeout: STEP_MS })
  await page.keyboard.insertText('eterm11-match')
  await until('the matches highlighted', async () => ((await kea.views()).find((v) => v.ptyId === agent)?.decorations ?? 0) > 0 || undefined)

  // the composer replaces the terminal area, with no terminal on screen after it
  await page.keyboard.press(sysKey('Meta+n'))
  await expect(page.getByRole('region', { name: 'New session' })).toBeVisible({ timeout: STEP_MS })
  await until('no terminal keeps a search while the composer shows', async () => {
    const views = await kea.views()
    return views.every((v) => !v.findOpen && v.decorations === 0) || undefined
  }).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify((await kea.views()).map((v) => ({ pty: v.ptyId, findOpen: v.findOpen, decorations: v.decorations })))}`)
  })
  const searches = await page.evaluate(() => {
    const r = (window as unknown as { __keaPerf: { resources(): Record<string, number> } }).__keaPerf.resources()
    return r['renderer.searchAddons'] ?? r['searchAddons']
  })
  expect(searches, 'the resource report’s search addons').toBe(0)

  // back to the session: its terminal on screen, the find bar closed
  await page.keyboard.press('Escape')
  await until('the session’s terminal back on screen', async () => (await kea.shown()) === agent || undefined)
  await expect(page.locator('.find-bar')).toHaveCount(0)
  expect((await kea.views()).find((v) => v.ptyId === agent)?.findOpen, 'no search on the terminal shown').toBe(false)
  await kea.assertUnfocused()
})

/** Each worktree's path by its branch (`git worktree list --porcelain`), the main checkout included. */
function worktreesByBranch(root: string): Map<string, string> {
  const out = new Map<string, string>()
  let at = ''
  for (const l of gitIn(root, 'worktree', 'list', '--porcelain').split('\n')) {
    if (l.startsWith('worktree ')) at = l.slice('worktree '.length)
    else if (l.startsWith('branch refs/heads/')) out.set(l.slice('branch refs/heads/'.length), at)
  }
  return out
}

test('E-SES-7 · every holder killed while Kea is closed (a simulated reboot), relaunch: every session is detached with its worktree and branch intact, and shows its cold-restored last screen under the detached overlay; Resume starts its agent again in its worktree, the others stay detached', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const ids = await sessionsLive(kea, ['first before the reboot', 'second before the reboot', 'third before the reboot'])
  // what each agent last printed: its last screen after the reboot
  for (const [i, id] of ids.entries()) {
    await agentTerminal(kea, id)
    await kea.echo(`reboot${i}`)
  }
  await agentTerminal(kea, ids[0]!)
  await page.keyboard.press(sysKey('Meta+t'))
  await kea.waitScreen('a shell tab beside the agent', (s) => (s.match(/kea\$ /g) ?? []).length === 1)
  const worktrees = worktreesByBranch(repo.root)
  expect(worktrees.size, 'three worktrees and the main checkout').toBe(4)
  // the sessions' three agents and one shell tab (a state file being rewritten is read again); the reboot also takes the
  // first launch's shell, in the `shells` pseudo-session
  await until('four live holders of the sessions', () => run.holders().filter((h) => ids.includes(h.sessionId) && run.holderAlive(h)).length === 4 || undefined)
  const holders = run.holders().filter((h) => run.holderAlive(h))

  // the reboot: Kea quits (its holders run on), then every holder and its shell dies with the machine
  expect(await kea.quitFromMenu(), 'Kea quits cleanly').toEqual({ code: 0, signal: null })
  await kea.gone()
  for (const h of holders) run.killHolderTree(h)
  await until('every holder gone', () => holders.every((h) => !run.holderAlive(h)) || undefined)

  const again = await launch({ ready: 'window' })
  const page2 = await again.page()
  for (const id of ids) await waitRow(again, id, 'detached after the reboot', (r) => r.lifecycle === 'detached')
  expect(worktreesByBranch(repo.root), 'every worktree and branch where it was').toEqual(worktrees)
  // each shows its last screen, cold-restored from checkpoint and ring, dimmed under the overlay
  const overlay = page2.getByRole('status', { name: 'Session ended' })
  for (const [i, id] of ids.entries()) {
    await selectSession(again, id)
    await again.clickTab(await tabOf(again, 'agent'))
    await again.waitScreen(`session ${i}’s last screen`, (s) => s.includes(`reboot${i}-42`))
    await expect(page2.locator('.terminal-frame.ended'), 'dimmed').toHaveCount(1)
    await expect(overlay).toContainText('Agent lost with its terminal')
    await expect(overlay.getByRole('button', { name: 'Resume' })).toBeVisible()
  }

  // Resume one: its agent starts again in its own worktree
  const resumed = ids[1]!
  await sessionMenu(again, resumed, 'session.resume')
  await waitRow(again, resumed, 'live after Resume', (r) => r.lifecycle === 'live')
  // the new agent takes the agent pane: the lost one it replaces goes, and neither has a tab
  await selectSession(again, resumed)
  await until('the new agent in the agent pane', async () => ((await tabKinds(page2)).length === 0 && (await page2.locator('.agent-pane .terminal-frame.ended').count()) === 0) || undefined).catch(async (e) => {
    throw new Error(`${(e as Error).message}: tabs ${JSON.stringify(await tabKinds(page2))}`)
  })
  const agent = await agentTerminal(again, resumed)
  const chip = await page2.getByRole('main', { name: 'Session' }).getByRole('button', { name: /^Branch / }).textContent()
  const cwd = worktrees.get(chip!.replace(/^\W*/, '').trim())
  expect(cwd, `the session’s worktree (branch chip "${chip}")`).toBeDefined()
  await again.enter('pwd')
  await until('the resumed agent runs in its worktree', async () => (await again.terminalText(agent)).split('\n').some((l) => l.trim() === cwd) || undefined)
  for (const id of ids.filter((x) => x !== resumed)) expect((await rowState(page2, id))?.lifecycle, 'the others stay detached').toBe('detached')
  await again.assertUnfocused()
})

test('E-PTY-3 · the first launch’s shell closed, a session started, Kea quit and relaunched: the last session comes back and no hidden shell is opened in the `shells` pseudo-session (a first shell opens only when none survived and no session is listed)', async ({ run, launch }) => {
  const kea = await launch()
  const shells = () => run.holders().filter((h) => h.sessionId === SHELLS_SESSION && run.holderAlive(h))
  // the first launch lists no session, so the shells pane opens its one shell; it is closed (no shell survives the quit)
  await until('the first launch’s shell', () => shells().length === 1 || undefined)
  await kea.enter('exit')
  await until('the shells pane’s shell gone', () => shells().length === 0 || undefined)
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const [id] = await sessionsLive(kea, ['listed at the relaunch'])
  await agentTerminal(kea, id!)
  expect(await kea.quitFromMenu(), 'Kea quits cleanly').toEqual({ code: 0, signal: null })
  await kea.gone()

  const again = await launch({ ready: 'window' })
  const page = await again.page()
  await until('the last session back in the pane', async () => (await paneSession(page)) === id || undefined)
  await agentTerminal(again, id!)
  // the shells pane that showed until then decides once core has answered (no timing): it opened nothing
  const decision = await until('the shells pane’s first-shell decision', async () => (await page.evaluate(() => (window as unknown as { __keaProbe: { firstShell(): string | null } }).__keaProbe.firstShell())) ?? undefined)
  expect(decision, 'no first shell while a session is listed').not.toBe('opened')
  expect(shells().map((h) => h.ptyId), 'no holder in the shells pseudo-session').toEqual([])
  await again.assertUnfocused()
})

/** `general.deletedRetentionDays`'s default (the run's settings file is the defaults). */
async function settingDays(): Promise<number> {
  const { SETTINGS } = await import('@kea/protocol')
  return SETTINGS.find((k) => k.key === 'general.deletedRetentionDays')!.default as number
}

test('E-SB-1 · sidebar details: the session and project context menus list their table commands in order, only those available, and each works; typing in the sidebar filters by title or branch and Esc clears; "Archived (n)" only when n > 0', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const [b, a] = await sessionsLive(kea, ['alpha feature', 'bravo bugfix'])
  const expected = (surface: string, ids: string[]) => COMMANDS.filter((c) => c.surfaces?.includes(surface as never) && ids.includes(c.id)).map((c) => c.id)
  const LIVE = ['session.rename', 'session.openInEditor', 'session.reveal', 'session.copyBranch', 'session.copyWorktreePath', 'session.duplicate', 'session.stop', 'session.archive', 'session.delete', 'session.resyncFiles', 'session.reportStatus']
  const DETACHED = ['session.rename', 'session.openInEditor', 'session.reveal', 'session.copyBranch', 'session.copyWorktreePath', 'session.duplicate', 'session.resume', 'session.restart', 'session.archive', 'session.delete', 'session.resyncFiles', 'session.reportStatus']
  const ARCHIVED = ['session.rename', 'session.openInEditor', 'session.reveal', 'session.copyBranch', 'session.copyWorktreePath', 'session.duplicate', 'session.unarchive', 'session.delete']
  // Restore Deleted Session… stays listed while nothing is restorable, disabled with its reason
  const PROJECT = ['session.new', 'session.restoreDeleted', 'project.openInEditor', 'project.reveal', 'project.settings', 'project.remove']
  const menuOf = async (id: string) => {
    await sessionRow(page, id).click({ button: 'right' })
    const items = await menuCommands(page, 'Session menu')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    return items
  }

  // a live session's menu, in table order; its commands work
  expect(await menuOf(a!)).toEqual(expected('session ⌃', LIVE))
  // clipboard writes are recorded, never sent to the person's clipboard
  await page.evaluate(() => {
    const w = window as unknown as { __keaClipboard: string[] }
    w.__keaClipboard = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t: string) => void w.__keaClipboard.push(t) })
  })
  const clip = () => page.evaluate(() => (window as unknown as { __keaClipboard: string[] }).__keaClipboard)
  // the session's own branch and worktree, as git has them (the other session's differ)
  const worktrees = worktreesByBranch(repo.root)
  const own = [...worktrees].find(([br, at]) => at !== repo.root && br.includes('alpha'))
  expect(own, `session a’s worktree among ${JSON.stringify([...worktrees])}`).toBeDefined()
  const [branchA, cwdA] = own!
  await sessionMenu(kea, a!, 'session.copyBranch')
  await until('the branch copied', async () => (await clip()).at(-1) === branchA || undefined)
  await sessionMenu(kea, a!, 'session.copyWorktreePath')
  await until('the worktree path copied', async () => (await clip()).at(-1) === cwdA || undefined)
  await sessionMenu(kea, a!, 'session.reveal')
  await until('Reveal asked of main (no Finder under --kea-perf)', () => kea.logLines('main').some((l) => l.msg === 'reveal not opened (perf)') || undefined)
  await sessionMenu(kea, a!, 'session.rename')
  const rename = page.getByRole('textbox', { name: 'Session title' })
  await expect(rename).toBeFocused({ timeout: STEP_MS })
  await rename.fill('Renamed alpha')
  await page.keyboard.press('Enter')
  await waitRow(kea, a!, 'renamed', (r) => r.title === 'Renamed alpha')
  // Re-sync Copied Files: a `.env` added to the main checkout since the creation reaches the worktree
  fs.writeFileSync(path.join(repo.root, '.env'), 'E_SB_1=resynced\n')
  expect(fs.existsSync(path.join(cwdA, '.env')), 'no .env in the worktree before the re-sync').toBe(false)
  await sessionMenu(kea, a!, 'session.resyncFiles')
  await until('the .env re-synced into the worktree', () => fs.readFileSync(path.join(cwdA, '.env'), 'utf8') === 'E_SB_1=resynced\n' || undefined)
  // Report Wrong Status: the session's popover, with the picker
  await sessionMenu(kea, a!, 'session.reportStatus')
  const details = page.getByRole('dialog', { name: 'Session details' })
  await expect(details.getByRole('radiogroup', { name: 'It should be' })).toBeVisible({ timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await sessionMenu(kea, a!, 'session.duplicate')
  await expect(page.getByRole('region', { name: 'New session' }), 'Duplicate opens the composer').toBeVisible({ timeout: STEP_MS })
  await sessionMenu(kea, a!, 'session.stop')
  await waitRow(kea, a!, 'stopped: detached', (r) => r.lifecycle === 'detached')
  expect(await menuOf(a!), 'a detached session’s menu').toEqual(expected('session ⌃', DETACHED))
  await sessionMenu(kea, a!, 'session.resume')
  await waitRow(kea, a!, 'resumed: live', (r) => r.lifecycle === 'live')
  await sessionMenu(kea, a!, 'session.stop')
  await waitRow(kea, a!, 'stopped again', (r) => r.lifecycle === 'detached')
  await sessionMenu(kea, a!, 'session.restart')
  await waitRow(kea, a!, 'restarted: live', (r) => r.lifecycle === 'live')

  // "Archived (n)" only when n > 0
  await expect(page.getByRole('treeitem', { name: /^Archived/ })).toHaveCount(0)
  await sessionMenu(kea, b!, 'session.archive')
  const group = page.getByRole('treeitem', { name: 'Archived (1)' })
  await expect(group).toBeVisible({ timeout: STEP_MS })
  await group.click()
  await waitRow(kea, b!, 'archived', (r) => r.lifecycle === 'archived')
  expect(await menuOf(b!), 'an archived session’s menu').toEqual(expected('session ⌃', ARCHIVED))
  await sessionMenu(kea, b!, 'session.delete')
  await expect(page.getByRole('alertdialog', { name: 'Delete session' })).toBeVisible({ timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await sessionMenu(kea, b!, 'session.unarchive')
  await waitRow(kea, b!, 'unarchived', (r) => r.lifecycle === 'detached')
  await expect(page.getByRole('treeitem', { name: /^Archived/ })).toHaveCount(0)

  // the project menu
  await projectRow(page, 'demo').click({ button: 'right' })
  expect(await menuCommands(page, 'Project menu')).toEqual(expected('project ⌃', PROJECT))
  const restore = page.getByRole('menu', { name: 'Project menu' }).locator('[role=menuitem][data-command="session.restoreDeleted"]')
  await expect(restore, 'nothing deleted: Restore is disabled').toHaveAttribute('aria-disabled', 'true')
  await expect(restore).toHaveAttribute('aria-description', 'No session of demo was deleted recently')
  await page.keyboard.press('Escape')
  const projectMenu = async (command: string) => {
    await projectRow(page, 'demo').click({ button: 'right' })
    await page.getByRole('menu', { name: 'Project menu' }).locator(`[role=menuitem][data-command="${command}"]`).click()
  }
  await projectMenu('session.new')
  await expect(page.getByRole('region', { name: 'New session' }).getByRole('button', { name: 'Project: demo' })).toBeVisible({ timeout: STEP_MS })
  await projectMenu('project.settings')
  await expect(page.getByRole('dialog', { name: 'Project settings' })).toBeVisible({ timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await projectMenu('project.reveal')
  await until('a second reveal asked of main', () => kea.logLines('main').filter((l) => l.msg === 'reveal not opened (perf)').length >= 2 || undefined)
  await projectMenu('project.remove')
  const removeSheet = page.getByRole('alertdialog', { name: 'Remove project' })
  await expect(removeSheet).toBeVisible({ timeout: STEP_MS })
  // Both sessions have their worktrees on disk, so the sheet names them and offers no Remove
  const keeping = removeSheet.getByRole('list', { name: 'Sessions that keep the project' }).getByRole('listitem')
  await expect(keeping).toHaveCount(2, { timeout: STEP_MS })
  for (const title of ['Renamed alpha', 'Bravo bugfix']) await expect(keeping.filter({ hasText: `${title}: its worktree is on disk` })).toHaveCount(1)
  await expect(removeSheet.getByRole('button', { name: /Remove/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(removeSheet).toHaveCount(0)

  // type-to-filter: by title, then by branch; Esc clears
  const branchB = gitIn(repo.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/kea/').split('\n').find((x) => x.includes('bravo'))!
  await projectRow(page, 'demo').focus()
  await page.keyboard.type('renamed')
  const filter = page.getByRole('searchbox', { name: 'Filter sessions' })
  await expect(filter).toHaveValue('renamed')
  await until('only the renamed session listed', async () => JSON.stringify(await sessionIds(page)) === JSON.stringify([a]) || undefined)
  await filter.fill(branchB.slice('kea/'.length))
  await until('only the session on that branch listed', async () => JSON.stringify(await sessionIds(page)) === JSON.stringify([b]) || undefined)
  await page.keyboard.press('Escape')
  await expect(filter).toHaveCount(0)
  await until('both listed again', async () => (await sessionIds(page)).length === 2 || undefined)
  await kea.assertUnfocused()
})

/** Every file of a working tree (`.git` left out) with its contents, by path. */
function treeFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(e.parentPath, e.name)
    const rel = path.relative(dir, full)
    if (rel === '.git' || rel.startsWith(`.git${path.sep}`) || !e.isFile()) continue
    out[rel] = fs.readFileSync(full, 'utf8')
  }
  return out
}

test('E-LAYOUT-1 · the sidebar dragged to its minimum: the header keeps New Session whole beside the window buttons and it still opens the composer; nothing scrolls sideways; rows draw glyph and title only and their tooltips say the rest; a double-click brings the sidebar back to its width', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, demoRepo(run).root)
  const [id] = await sessionsLive(kea, ['a session whose title is long enough to be cut short in a narrow sidebar'])
  const aside = page.getByRole('complementary', { name: 'Sidebar' })
  const divider = page.getByRole('separator', { name: 'Resize sidebar' })
  const plus = aside.locator('.sidebar-header button[data-command="session.new"]')
  // the size tokens as the window has them
  const size = (name: string) => page.evaluate((n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--size-${n}`)), name)
  const [min, hairline, lights, wide] = await Promise.all(['sidebar-min', 'hairline', 'traffic-lights', 'sidebar'].map(size))

  // dragged far past the minimum, it stops there
  const box = (await divider.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 400, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  const { drawn, sidebarFloor, sidebarWidth } = await kea.layout()
  expect(sidebarFloor).toBeGreaterThanOrEqual(min!)
  expect(drawn.sidebar).toBe(sidebarFloor)
  expect(sidebarWidth).toBe(sidebarFloor)
  expect(Number(await divider.getAttribute('aria-valuemin'))).toBe(sidebarFloor)
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBe(sidebarFloor)

  // New Session is whole inside the column, right of where the window's buttons are, and still works
  const side = (await aside.boundingBox())!
  const button = (await plus.boundingBox())!
  expect(button.x + button.width).toBeLessThanOrEqual(side.x + side.width - hairline!)
  const buttonsEnd = protocolOs.window.menuButton ? await page.evaluate(() => navigator.windowControlsOverlay?.getTitlebarAreaRect().x ?? 0) : lights!
  expect(button.x).toBeGreaterThanOrEqual(buttonsEnd)
  const columns = await page.evaluate(() =>
    ['aside.sidebar-column', '.sidebar-header', '.sidebar-body', '.sidebar-footer'].map((sel) => {
      const el = document.querySelector<HTMLElement>(sel)!
      return { sel, scroll: el.scrollWidth, client: el.clientWidth }
    }),
  )
  for (const c of columns) expect(c.scroll, `${c.sel} scrolls sideways`).toBeLessThanOrEqual(c.client)

  // compact rows: the session's meta is gone, its tooltip leads with its full title; the project's name is its tooltip
  await expect(aside).toHaveClass(/sidebar-compact/)
  const row = sessionRow(page, id!)
  await expect(row.locator('.sb-meta-slot')).toBeHidden()
  const title = (await row.getAttribute('aria-label'))!
  expect(await row.locator('.sb-title').evaluate((t) => t.scrollWidth > t.clientWidth), 'the title is cut short').toBe(true)
  expect(await row.getAttribute('data-tip')).toContain(`${title} · `)
  expect((await row.getAttribute('data-tip'))!.startsWith(title)).toBe(true)
  expect(await projectRow(page, 'demo').getAttribute('data-tip')).toBe('demo')
  await row.hover()
  await expect(row.locator('.sb-actions')).toBeHidden()

  await plus.click()
  await expect(page.getByRole('region', { name: 'New session' })).toBeVisible()

  // a double-click resets the width, and the rows draw their meta again
  await divider.dblclick()
  await until('the sidebar at its width', async () => ((await kea.layout()).drawn.sidebar === wide ? true : undefined))
  await expect(aside).not.toHaveClass(/sidebar-compact/)
  await expect(row.locator('.sb-meta-slot')).toBeVisible()
  expect(await row.getAttribute('data-tip')).toBeNull()
  expect(await projectRow(page, 'demo').getAttribute('data-tip')).toBeNull()
})

test('E-SES-11 · Restore Deleted Session… from the project menu: disabled with its reason while nothing is restorable; a session with a commit of its own and uncommitted work, deleted with its branch, comes back detached on the same branch at the same commit, its working tree as it was; disabled again once restored', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  const [id] = await sessionsLive(kea, ['restore me later'])
  const title = (await rowState(page, id!))!.title
  /** The project menu's Restore Deleted Session… item (the menu left open). */
  const restoreItem = async () => {
    await projectRow(page, 'demo').click({ button: 'right' })
    const item = page.getByRole('menu', { name: 'Project menu' }).locator('[role=menuitem][data-command="session.restoreDeleted"]')
    await item.waitFor({ timeout: STEP_MS })
    return item
  }
  const sheet = page.getByRole('alertdialog', { name: 'Restore deleted session' })

  // nothing deleted yet: listed, disabled, saying why; a click on it does nothing
  let item = await restoreItem()
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(item).toHaveAttribute('aria-description', 'No session of demo was deleted recently')
  await item.click({ force: true })
  await expect(page.getByRole('menu', { name: 'Project menu' }), 'a click on a disabled item keeps the menu open').toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(sheet, 'a disabled item opens nothing').toHaveCount(0)

  // work in the worktree: a commit only its branch holds, then an edit, a deletion and new files left uncommitted
  const [branch, cwd] = [...worktreesByBranch(repo.root)].find(([, at]) => at !== repo.root)!
  fs.writeFileSync(path.join(cwd, 'committed.txt'), 'kept in a commit\n')
  gitIn(cwd, 'add', 'committed.txt')
  gitIn(cwd, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', 'committed work')
  const tip = gitIn(cwd, 'rev-parse', 'HEAD').trim()
  fs.appendFileSync(path.join(cwd, 'README.md'), 'an uncommitted edit\n')
  fs.rmSync(path.join(cwd, 'src', 'counter.js'))
  fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'never committed\n')
  fs.mkdirSync(path.join(cwd, 'notes'))
  fs.writeFileSync(path.join(cwd, 'notes', 'todo.md'), '- restore me\n')
  const status = gitIn(cwd, 'status', '--porcelain', '--untracked-files=all')
  const files = treeFiles(cwd)
  expect(status.split('\n').filter(Boolean), 'the fixture: an edit, a deletion, two new files').toHaveLength(4)

  // delete it, its branch too (the sheet's tick: the branch has a commit no other holds)
  await sessionMenu(kea, id!, 'session.delete')
  const del = page.getByRole('alertdialog', { name: 'Delete session' })
  await expect(del).toContainText('4 uncommitted files and 1 commit on no other branch or remote', { timeout: STEP_MS })
  await del.getByRole('checkbox').check()
  await del.getByRole('button', { name: 'Delete' }).click()
  await until('the row gone', async () => (await rowState(page, id!)) === null || undefined)
  await until('the worktree directory gone', () => !fs.existsSync(cwd) || undefined)
  expect(gitIn(repo.root, 'branch', '--list', branch).trim(), 'the branch deleted').toBe('')

  // the item is enabled now; the sheet lists the session with its branch
  item = await restoreItem()
  await expect(item).not.toHaveAttribute('aria-disabled', 'true')
  await item.click()
  await expect(sheet).toBeVisible({ timeout: STEP_MS })
  const listed = sheet.getByRole('list', { name: 'Deleted sessions' }).getByRole('listitem')
  await expect(listed).toHaveCount(1, { timeout: STEP_MS })
  await expect(listed).toContainText(title)
  await expect(listed).toContainText(branch)
  await expect(listed).toContainText('deleted just now')
  await listed.getByRole('button', { name: 'Restore' }).click()

  // back: detached, selected, on the same branch at the same commit, the working tree as it was
  await waitRow(kea, id!, 'detached after Restore', (r) => r.lifecycle === 'detached' && r.selected)
  await until('the worktree back', () => fs.existsSync(cwd) || undefined)
  expect(gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'the same branch').toBe(branch)
  expect(gitIn(cwd, 'rev-parse', 'HEAD').trim(), 'at the same commit').toBe(tip)
  expect(gitIn(cwd, 'status', '--porcelain', '--untracked-files=all'), 'the same uncommitted changes').toBe(status)
  expect(treeFiles(cwd), 'every file as it was').toEqual(files)
  expect(gitIn(repo.root, 'for-each-ref', '--format=%(refname)', `refs/kea/deleted/${id}`).trim(), 'the snapshot ref dropped').toBe('')

  // nothing left to restore: disabled again
  item = await restoreItem()
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await kea.assertUnfocused()
})

test('E-SES-12 · a creation held at its last step (the test hook’s hold): the main pane reports its progress in place — every earlier step done, the step running current — and shows the creation log as core wrote it, line for line', async ({ run, launch }) => {
  const kea = await launch()
  const page = await kea.page()
  const repo = demoRepo(run)
  await addProject(kea, repo.root)
  // core stops for good when the creation reaches its last step (tests/support/app-child-hooks.cjs `hold`)
  const held = path.join(run.home, 'held-create-launch')
  await kea.debug('core', 'hold', `create:launch|${held}`)
  const id = await startSession(kea, 'report my progress')
  await until('core held at create:launch', () => (fs.existsSync(held) && fs.readFileSync(held, 'utf8') === id) || undefined)
  const view = page.getByRole('status', { name: 'Creating the session' })
  await expect(view, 'the creation view').toBeVisible({ timeout: STEP_MS })
  const last = CREATION_STEPS.length - 1
  await until('every earlier step done, the last one current', async () => {
    const marks = await view.locator('.creation-steps li').evaluateAll((els) => els.map((e) => e.className))
    return (marks.length === CREATION_STEPS.length && marks.every((c, i) => c === (i < last ? 'done' : 'current'))) || undefined
  }).catch(async (e: Error) => {
    throw new Error(`${e.message}: current step "${await view.locator('.creation-steps .current').textContent()}"`)
  })
  const file = path.join(run.home, 'sessions', id, 'creation.log')
  await until('the creation log as core wrote it', async () => (await view.locator('.creation-log').textContent()) === fs.readFileSync(file, 'utf8') || undefined).catch(async (e: Error) => {
    throw new Error(`${e.message}: shown ${JSON.stringify(await view.locator('.creation-log').textContent())}, written ${JSON.stringify(fs.readFileSync(file, 'utf8'))}`)
  })
  expect(fs.readFileSync(file, 'utf8'), 'the log has every step').toContain(`step ${CREATION_STEPS[last]}`)
  await kea.assertUnfocused()
})
