// Status in the window, with tools/fake-agent as Claude Code (tests/support/app-fake-agent.ts) in a Kea launched
// through tests/e2e/fixtures.ts (unfocused, temp KEA_HOME, hermetic git). The fake agent plays the agent's side: its
// hooks through real `kea-helper hook` processes, its live status file, its transcript, and for the second session of
// E-ST-4 only its terminal output. The window's side is checked: row, notification (read from main's recorder, never
// posted), badge, ⌘J, the popover, the footer, the composer's note.
//
// Only the usage-limit failure of E-ST-7 comes through the `status` test op (tests/support/app-status.ts `ingest`): the
// Claude adapter cannot read its reset time from Claude yet (U-AGT-14). Its agents are fake-agent sessions all the
// same, and take Continue all's `continue` through their real prompt hook.

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { clockTime, L } from '@kea/protocol'
import { STEP_MS, until, type Kea } from '../support/app.ts'
import { addProject, demoRepo, paneSession, rowState, selectSession, sessionRow, waitRow } from '../support/app-sessions.ts'
import { AGENT_MARK, agentEvents, agentHooks, claudeByDefault, fakeAgentTerminal, gate, startFakeSession } from '../support/app-fake-agent.ts'
import { menuBarState } from '../support/app-menubar.ts'
import { ingest, notifications, pretendFocused, shown, viewing, waitNotifications } from '../support/app-status.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

/** A fake agent's screen: its mark, the prompt, then `lines` (YAML flow sequence). */
const frame = (...lines: string[]) => `frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', ...lines])}`

/** The row's glyph and its colour, next to the colour of a design token. */
function glyphOf(page: Page, id: string, token: string): Promise<{ kind: string | null; color: string; token: string }> {
  return page.evaluate(
    ([sid, tok]) => {
      const g = document.querySelector(`[role=treeitem][data-session-id="${sid}"] .kea-glyph`)
      const probe = document.createElement('span')
      probe.style.color = `var(${tok})`
      document.body.append(probe)
      const want = getComputedStyle(probe).color
      probe.remove()
      return { kind: g?.getAttribute('data-glyph') ?? null, color: g ? getComputedStyle(g).color : '', token: want }
    },
    [id, token] as const,
  )
}

/** The trailing label of a session's row (`permission`, `limited`), or null. */
function labelOf(page: Page, id: string): Promise<string | null> {
  return sessionRow(page, id)
    .locator('.sb-label')
    .textContent({ timeout: 1000 })
    .catch(() => null)
}

/** A click in the shown terminal, as a person does before typing into it. */
async function clickTerminal(page: Page): Promise<void> {
  await page.locator('.terminal-host.shown').click({ position: { x: 20, y: 20 } })
}

function windowTitle(kea: Kea, want: string): Promise<true> {
  return until(`the window title "${want}"`, async () => ((await (await kea.page()).title()) === want ? true : undefined))
}

/** A project on the run's demo repo. */
async function demoProject(kea: Kea): Promise<void> {
  await addProject(kea, demoRepo(kea.run).root)
}

/** What the session kept in front does in these tests: it works on (a finished turn would count as unread). */
const FRONT = `steps:
  - hook: UserPromptSubmit
  - ${frame('✶ Working…')}
  - wait: { answer: z }
`

test('E-ST-1 · attention loop: a background session’s agent asks for permission: orange dot and "permission" on its row, a notification with the tool summary, badge and window title 1; ⌘J selects it; answered in its terminal, the agent continues: the spinner returns, the notification is withdrawn, the badge cleared', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await demoProject(kea)
  const front = await startFakeSession(kea, 'e-st-1-front', 'in front', FRONT, { background: true })
  const ask = gate(run, 'e-st-1-ask')
  const back = await startFakeSession(
    kea,
    'e-st-1-back',
    'asks for permission',
    `steps:
  - hook: UserPromptSubmit
  - ${frame('✶ Working…')}
  - ${ask.step}
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
  - ${frame('Bash(npm test)  Allow? (y/n)')}
  - wait: { answer: y }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "npm test" } }
  - ${frame('✶ Running npm test…')}
  - wait: { answer: z }
`,
    { background: true, open: false },
  )
  await fakeAgentTerminal(kea, front.id)
  await waitRow(kea, back.id, 'working', (r) => r.status === 'working')
  const title = (await rowState(page, back.id))!.title

  // the agent asks while another session is on screen (its PermissionRequest hook)
  await ask.open()
  await waitRow(kea, back.id, 'needs you', (r) => r.status === 'needsYou')
  expect(await labelOf(page, back.id)).toBe('permission')
  const dot = await glyphOf(page, back.id, '--accent')
  expect([dot.kind, dot.color], 'the orange dot').toEqual(['needsYou', dot.token])

  const posted = await waitNotifications(kea, 'the permission request posted, the badge 1', (p) => p.live.includes(`s:${back.id}`) && p.badge === '1')
  expect(shown(posted).filter((x) => x.id === `s:${back.id}`)).toEqual([{ k: 'show', id: `s:${back.id}`, title: `${title} · needs permission`, subtitle: 'demo', body: 'Bash: npm test', silent: true }])
  expect(shown(posted).filter((x) => x.id === `s:${front.id}`), 'nothing for the session in front').toEqual([])
  await windowTitle(kea, 'Kea — 1 needs you')

  // ⌘J: the session that needs you, its Agent tab on screen
  await page.keyboard.press(sysKey('Meta+j'))
  await until('⌘J selects it', async () => (await paneSession(page)) === back.id || undefined)
  const agent = await fakeAgentTerminal(kea, back.id)

  // answered in its terminal; the agent goes on (its PostToolUse hook clears the item)
  await clickTerminal(page)
  await kea.type('y')
  await waitRow(kea, back.id, 'the spinner again', (r) => r.status === 'working')
  const after = await waitNotifications(kea, 'withdrawn, the badge cleared', (p) => !p.live.includes(`s:${back.id}`) && p.badge === '')
  expect(after.log.some((x) => x.k === 'close' && x.id === `s:${back.id}`), 'closed').toBe(true)
  expect(agentHooks(back.log)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse'])
  await windowTitle(kea, 'Kea')
  expect(await kea.shown()).toBe(agent)
  await kea.assertUnfocused()
})

test('E-ST-2 · finish while away: a turn finishes in a session not on screen: the white unread dot and no notification for a turn under L.notifyMinTurnMs; selected while the window is not focused it stays unread; viewed with the window focused for L.viewedDwellMs, it is read', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await demoProject(kea)
  const front = await startFakeSession(kea, 'e-st-2-front', 'in front', FRONT, { background: true })
  const ask = gate(run, 'e-st-2-ask')
  const done = gate(run, 'e-st-2-done')
  const away = await startFakeSession(
    kea,
    'e-st-2-away',
    'finishes while away',
    `steps:
  - hook: UserPromptSubmit
  - ${frame('⏺ All tests pass.')}
  - hook: { event: Stop, fields: { last_assistant_message: "All tests pass." } }
  - ${ask.step}
  - hook: { event: UserPromptSubmit, fields: { prompt: "push it" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "git push" } }
  - ${frame('Bash(git push)  Allow? (y/n)')}
  - ${done.step}
  - hook: { event: PostToolUse, tool: Bash, input: { command: "git push" } }
  - hook: Stop
  - ${frame('⏺ Pushed.')}
`,
    { background: true, open: false },
  )
  await fakeAgentTerminal(kea, front.id)

  await waitRow(kea, away.id, 'unread', (r) => r.status === 'unread')
  const dot = await glyphOf(page, away.id, '--text-1')
  expect([dot.kind, dot.color], 'the white dot').toEqual(['unread', dot.token])
  // nothing for the short turn: a later post from the same session is its first (notices reach main in order)
  await ask.open()
  await waitRow(kea, away.id, 'blocked', (r) => r.status === 'needsYou')
  const p = await waitNotifications(kea, 'the later request posted', (x) => x.live.includes(`s:${away.id}`))
  expect(shown(p).filter((x) => x.id === `s:${away.id}`).map((x) => x.title)).toEqual([expect.stringMatching(/ · needs permission$/)])
  await done.open()
  await waitRow(kea, away.id, 'unread again', (r) => r.status === 'unread')

  // selected, but the window is not focused: not viewed
  await selectSession(kea, away.id)
  await fakeAgentTerminal(kea, away.id)
  expect(await viewing(kea), 'not viewed without focus').toBeNull()
  expect((await rowState(page, away.id))!.status).toBe('unread')

  // the window focused, the Agent tab visible: read after the dwell
  await pretendFocused(kea, true)
  await until('the session viewed', async () => (await viewing(kea)) === away.id || undefined)
  await waitRow(kea, away.id, 'read', (r) => r.status === 'idle')
  await waitNotifications(kea, 'nothing live for it', (x) => !x.live.includes(`s:${away.id}`))
  await pretendFocused(kea, false)
  await kea.assertUnfocused()
})

test('E-ST-3 · interrupt: Esc mid-turn returns the row to read ready, and nothing is posted for it', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await demoProject(kea)
  // Esc before any answer writes no Stop: the status file goes busy → idle and the transcript gets the marker
  const s = await startFakeSession(
    kea,
    'e-st-3',
    'interrupt me',
    `steps:
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }
  - ${frame('✶ Running npm test… (esc to interrupt)')}
  - wait: { answer: y }
onInterrupt:
  - transcript: { record: interrupt }
  - ${frame('⎿ Interrupted by user', '', '> ')}
onLine:
  - hook: UserPromptSubmit
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
  - ${frame('Bash(npm test)  Allow? (y/n)')}
  - wait: { answer: y }
`,
    { background: true },
  )
  await fakeAgentTerminal(kea, s.id)
  await waitRow(kea, s.id, 'working', (r) => r.status === 'working')

  await clickTerminal(page)
  await kea.press('Escape')
  await waitRow(kea, s.id, 'read ready', (r) => r.status === 'idle')
  expect(agentHooks(s.log), 'no Stop').toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse'])

  // nothing was posted for the interrupt: a later post is the session's first
  await kea.enter('again')
  await waitRow(kea, s.id, 'blocked', (r) => r.status === 'needsYou')
  const p = await waitNotifications(kea, 'the later request posted', (x) => x.live.includes(`s:${s.id}`))
  expect(shown(p).filter((x) => x.id === `s:${s.id}`).map((x) => x.title)).toEqual([expect.stringMatching(/ · needs permission$/)])
  await kea.assertUnfocused()
})

test('E-ST-4 · status transparency: "Why this status?" lists the last transitions with their time, source and summary, and what is waiting on you; a session known only from terminal activity (its agent’s hooks disabled) is working by tier 3 and says its status is estimated', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await demoProject(kea)
  // hooks only (no status file), so every transition below is a hook's
  const hooked = await startFakeSession(
    kea,
    'e-st-4-hooked',
    'with hooks',
    `statusFile: off
steps:
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
  - ${frame('Bash(npm test)  Allow? (y/n)')}
  - wait: { answer: y }
`,
    { background: true },
  )
  await fakeAgentTerminal(kea, hooked.id)
  await waitRow(kea, hooked.id, 'needs you', (r) => r.status === 'needsYou')

  const dialog = page.getByRole('dialog', { name: 'Session details' })
  await page.locator('[data-config-summary]').click()
  await expect(dialog).toBeVisible({ timeout: STEP_MS })
  const entries = dialog.getByRole('list', { name: 'Why this status?' }).locator('li')
  await expect(entries.last()).toHaveText(/^\d\d:\d\d:\d\d hook · permission asked → blocked \(Bash: npm test\)$/, { timeout: STEP_MS })
  const texts = await entries.allTextContents()
  expect(texts.slice(-2), 'the turn, then the request (a tool that changes nothing is not a transition)').toEqual([expect.stringMatching(/^\d\d:\d\d:\d\d hook · turn started → working$/), expect.stringMatching(/ hook · permission asked → blocked \(Bash: npm test\)$/)])
  await expect(dialog.getByRole('list', { name: 'Waiting on you' })).toHaveText(/permission\s+npm test/)
  await expect(dialog.getByText('Status is estimated from terminal activity.')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // hooks disabled in the agent's settings and no status file: its output flowing for over a second after the launch
  // prompt is all Kea sees (tier 3): working, estimated
  const unhooked = await startFakeSession(
    kea,
    'e-st-4-unhooked',
    'without hooks',
    `statusFile: off
steps:
  - ${frame('✶ Working…')}
  - loop:
      forever: true
      steps:
        - print: "."
        - sleep: 100
`,
    { background: true, hooksOff: true },
  )
  await waitRow(kea, unhooked.id, 'working', (r) => r.status === 'working')
  expect(agentHooks(unhooked.log), 'no hook ran').toEqual([])
  await fakeAgentTerminal(kea, unhooked.id)
  await page.locator('[data-config-summary]').click()
  await expect(dialog.getByRole('note').filter({ hasText: 'Status is estimated from terminal activity.' })).toBeVisible({ timeout: STEP_MS })
  await expect(dialog.getByRole('list', { name: 'Why this status?' }).locator('li').last()).toHaveText(/heuristic · turn started → working$/)
  await page.keyboard.press('Escape')
  await kea.assertUnfocused()
})

test('E-ST-5 · attention edge cases: (a) a prompt answered "No" with only the interrupt marker after it leaves blocked as read ready; (b) approved, a long tool with no hook shows the spinner at once; (c) a parallel tool and a subagent finishing while a prompt waits leave it blocked', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await demoProject(kea)
  // the status file is written only where these steps say (tier 1b's part in (b)); everything else is hooks and the
  // transcript
  const sub = 'agent_id: "a1b2c3", agent_type: "Explore"'
  const s = await startFakeSession(
    kea,
    'e-st-5',
    'edge cases',
    `statusFile: manual
steps:
  - hook: UserPromptSubmit
  - status: busy
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "rm -rf build" } }
  - ${frame('Bash(rm -rf build)  Allow? (y/n)')}
  - choose:
      n:
        - transcript: { record: interrupt, forToolUse: true }
        - ${frame('⎿ Interrupted · What should Claude do instead?', '', '> ')}
  - wait: line
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Bash, input: { command: "sleep 120" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "sleep 120" } }
  - status: { status: waiting, waitingFor: "permission prompt" }
  - ${frame('Bash(sleep 120)  Allow? (y/n)')}
  - choose:
      y:
        - status: busy
        - ${frame('✶ Running sleep 120…')}
  - wait: { answer: f }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "sleep 120" } }
  - hook: Stop
  - status: idle
  - ${frame('⏺ Done.', '', '> ')}
  - wait: line
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Read, input: { file_path: "src/a.ts" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
  - ${frame('Bash(npm test)  Allow? (y/n)')}
  - hook: { event: PostToolUse, tool: Read, input: { file_path: "src/a.ts" } }
  - hook: { event: PreToolUse, tool: Grep, input: { pattern: "TODO" }, fields: { ${sub} } }
  - hook: { event: PostToolUse, tool: Grep, input: { pattern: "TODO" }, fields: { ${sub} } }
  - hook: { event: SubagentStop, fields: { ${sub} } }
  - transcript: { record: ai-title, title: "Still waiting" }
  - wait: { answer: y }
`,
    { background: true },
  )
  await fakeAgentTerminal(kea, s.id)

  // (a) denied: the transcript's interrupt marker is all that follows
  await waitRow(kea, s.id, 'blocked', (r) => r.status === 'needsYou')
  await clickTerminal(page)
  await kea.type('n')
  await waitRow(kea, s.id, 'read ready after the denial', (r) => r.status === 'idle')

  // (b) approved: the status file shows the prompt answered; the tool then runs with no hook until it ends
  await kea.enter('next')
  await waitRow(kea, s.id, 'blocked', (r) => r.status === 'needsYou')
  await kea.type('y')
  await waitRow(kea, s.id, 'the spinner, while the tool still runs', (r) => r.status === 'working')
  await kea.type('f')
  await waitRow(kea, s.id, 'the tool and the turn done', (r) => r.status === 'idle' || r.status === 'unread')

  // (c) a parallel tool and a subagent finish while the prompt waits; the window has everything up to the title the
  // transcript gives after them
  await kea.enter('last')
  const row = await waitRow(kea, s.id, 'the later title', (x) => x.title === 'Still waiting')
  expect(row.status, 'still blocked').toBe('needsYou')
  expect(await labelOf(page, s.id)).toBe('permission')
  // (Kea asks for no SubagentStop hook: it maps to nothing)
  expect(agentHooks(s.log).slice(-6)).toEqual(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'PostToolUse'])
  await kea.assertUnfocused()
})

test('E-ST-6 · report wrong status: the row shows working while the agent waits; ⌥⌘J opens the picker in the popover; "needs me" and a note → "Report saved" with where; the bundle on disk holds the expected state and the note; the session is unchanged', async ({ run, launch }) => {
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await demoProject(kea)
  // the agent waits on a prompt no hook reports: the row says working
  const s = await startFakeSession(
    kea,
    'e-st-6',
    'mis-signalled',
    `statusFile: off
steps:
  - hook: UserPromptSubmit
  - transcript: { record: user, text: "{{prompt}}" }
  - ${frame('Apply this edit? (y/n)')}
  - wait: { answer: y }
`,
    { background: true },
  )
  await fakeAgentTerminal(kea, s.id)
  await waitRow(kea, s.id, 'working', (r) => r.status === 'working')

  await page.keyboard.press(sysKey('Alt+Meta+j'))
  const dialog = page.getByRole('dialog', { name: 'Session details' })
  const picker = dialog.getByRole('radiogroup', { name: 'It should be' })
  await expect(picker).toBeVisible({ timeout: STEP_MS })
  expect(await picker.getByRole('radio').allTextContents()).toEqual(['working', 'needs me', 'finished', 'idle', 'ended'])
  await picker.getByRole('radio', { name: 'needs me' }).click()
  await dialog.getByRole('textbox', { name: 'Note' }).fill('it waits on a prompt')
  // pressed by key, and the first save cannot be written: the popover says why and the keyboard is still on the button
  // (a button that disabled itself while saving would drop it: ↵ would then do nothing and Esc would no longer close
  // the popover)
  const reports = path.join(run.home, 'reports')
  fs.mkdirSync(reports, { recursive: true })
  fs.chmodSync(reports, 0o500)
  const save = dialog.getByRole('button', { name: 'Save report' })
  try {
    await save.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.locator('.popover-actions .popover-note'), 'why the report was not saved').toContainText(/\S/, { timeout: STEP_MS })
    await expect(save, 'pressable again').not.toHaveAttribute('aria-disabled', 'true')
    expect(await save.evaluate((e) => e === document.activeElement), 'the keyboard is still on "Save report"').toBe(true)
  } finally {
    fs.chmodSync(reports, 0o700)
  }
  // ↵ again, now that the folder can be written
  await page.keyboard.press('Enter')
  const saved = dialog.getByRole('status', { name: 'Report saved' })
  await expect(saved).toBeVisible({ timeout: STEP_MS })
  const dir = (await saved.locator('.popover-value').textContent())!.trim()
  expect(fs.realpathSync(path.dirname(dir)), 'under <KEA_HOME>/reports').toBe(fs.realpathSync(path.join(run.home, 'reports')))
  expect(path.basename(dir).endsWith(s.id)).toBe(true)
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as Record<string, unknown>
  expect(report).toMatchObject({ agent: 'claude', expected: 'needsMe', note: 'it waits on a prompt', lifecycle: 'live', phase: 'working' })
  for (const f of ['status-events.ndjson', 'signals.ndjson', 'transcript.jsonl']) expect(fs.existsSync(path.join(dir, f)), f).toBe(true)
  expect(fs.readFileSync(path.join(dir, 'signals.ndjson'), 'utf8'), 'the agent’s hooks in the signal ring').toContain('UserPromptSubmit')

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect((await rowState(page, s.id))!.status, 'unchanged').toBe('working')
  await kea.assertUnfocused()
})

test('E-ST-7 · usage limit: three background sessions fail with rate_limit and a reset time: one notification updated to "3 sessions waiting", one footer line, rows limited in --text-3, badge 1, the composer’s note, ⌘J skips them; at the reset one N5; Continue all types continue into all three, which go working; then a signed-out agent: the footer and the composer name the login command', async ({ run, launch }) => {
  test.setTimeout(180_000)
  claudeByDefault(run)
  const kea = await launch()
  const page = await kea.page()
  await demoProject(kea)
  // the one in front crashes later (a turn finishing would end the condition)
  const front = await startFakeSession(
    kea,
    'e-st-7-front',
    'in front',
    `steps:
  - hook: UserPromptSubmit
  - ${frame('✶ Working…')}
  - wait: { answer: x }
  - exit: 3
`,
    { background: true },
  )
  // each held agent: a turn, then its prompt (where Continue all's `continue` goes, a new turn)
  const HELD = `steps:
  - hook: UserPromptSubmit
  - ${frame('✶ Working…')}
onLine:
  - hook: UserPromptSubmit
  - frame: ["${AGENT_MARK}", "", "> {{line}}", "", "✶ Working…"]
`
  const held: string[] = []
  for (const n of ['one', 'two', 'three']) held.push((await startFakeSession(kea, `e-st-7-${n}`, `limited ${n}`, HELD, { background: true, open: false })).id)
  const ptys = new Map<string, string>() // bounded: the three sessions of this test
  for (const id of held) ptys.set(id, await fakeAgentTerminal(kea, id))
  await fakeAgentTerminal(kea, front.id)
  for (const id of held) await waitRow(kea, id, 'working', (r) => r.status === 'working')

  // the failure, with a reset time the adapter cannot read from Claude yet (U-AGT-14): the test op; the reset comes
  // once the window's side is checked (the app's clock cannot be moved)
  const resetsAt = Date.now() + 20_000
  for (const id of held) expect((await ingest(kea, id, 'hook', { t: 'turn.failed', error: 'usage limit reached', kind: 'rate_limit', resetsAt })).phase).toBe('failed')
  const footer = page.locator('.condition-line')
  await expect(footer).toHaveCount(1, { timeout: STEP_MS })
  await expect(footer).toHaveText(`Claude Code · limited until ${clockTime(resetsAt)}`)
  for (const id of held) {
    await waitRow(kea, id, 'limited', (r) => r.status === 'limited')
    expect(await labelOf(page, id)).toBe('limited')
    const g = await glyphOf(page, id, '--text-3')
    expect([g.kind, g.color], 'the slash in --text-3').toEqual(['limited', g.token])
  }
  const n4 = await waitNotifications(kea, 'N4 for three sessions, badge 1', (p) => shown(p).some((x) => x.id === 'c:claude' && x.body.startsWith('3 sessions waiting')) && p.badge === '1')
  expect(n4.live.filter((t) => t === 'c:claude'), 'one notification, updated in place').toHaveLength(1)
  expect(shown(n4).filter((x) => x.id === 'c:claude').at(-1)).toMatchObject({ title: 'Claude Code · usage limit reached', body: `3 sessions waiting · resets ${clockTime(resetsAt)}` })
  expect(shown(n4).filter((x) => held.some((id) => x.id === `s:${id}`)), 'no N3 for them').toEqual([])
  await windowTitle(kea, 'Kea — 1 needs you')
  const m = await menuBarState(kea, 'one line for the condition', (s) => s.count === 1)
  expect(m.state!.sessions.map((s) => [s.title, s.reason, s.glyph])).toEqual([['Claude Code', 'limited', 'limited']])
  // the composer, starting another Claude Code session, says so; it blocks nothing
  await page.keyboard.press(sysKey('Meta+n'))
  const note = page.getByRole('region', { name: 'New session' }).getByRole('note')
  await expect(note).toHaveText(`Claude Code is limited until ${clockTime(resetsAt)}. A new session may fail until then.`, { timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: 'New session' })).toHaveCount(0)

  // ⌘J skips them: from one of them it goes to a session that needs you, past the other two, which come first in ⌘J's
  // order (failed before it). The one in front crashes
  await fakeAgentTerminal(kea, front.id)
  await clickTerminal(page)
  await kea.type('x')
  await waitRow(kea, front.id, 'crashed', (r) => r.lifecycle === 'detached' && r.status === 'failed')
  await selectSession(kea, held[0]!)
  await page.keyboard.press(sysKey('Meta+j'))
  await until('⌘J goes past the limited sessions', async () => (await paneSession(page)) === front.id || undefined)

  // the reset: one "limit reset" notification; the footer offers Continue all
  await expect(footer).toHaveText(/^\s*Claude Code · limit reset\s+Continue all\s*$/, { timeout: resetsAt - Date.now() + STEP_MS })
  const n5 = await waitNotifications(kea, 'N5', (p) => shown(p).some((x) => x.id === 'c:claude' && x.title === 'Claude Code · limit reset'))
  expect(shown(n5).filter((x) => x.title === 'Claude Code · limit reset').map((x) => x.body)).toEqual(['3 sessions waiting'])
  await footer.getByRole('button', { name: 'Continue all' }).click()
  for (const [id, pty] of ptys) await until(`continue typed into ${id}`, () => /> continue/.test(run.ring(pty).text) || undefined)
  await expect(footer, 'the condition ends on Continue all').toHaveCount(0, { timeout: STEP_MS })
  // each agent takes the prompt: its UserPromptSubmit hook
  for (const id of held) await waitRow(kea, id, 'working', (r) => r.status === 'working')
  expect((await notifications(kea)).badge, 'the badge: the crashed session only').toBe('1')

  // an agent signed out (its StopFailure hook, authentication_failed): the footer line and the composer name the
  // adapter's login command
  await startFakeSession(
    kea,
    'e-st-7-auth',
    'signed out',
    `steps:
  - hook: UserPromptSubmit
  - hook: { event: StopFailure, fields: { error: authentication_failed } }
  - ${frame('Please run /login')}
`,
    { background: true },
  )
  await expect(footer).toHaveText('Claude Code · signed out — run claude auth login', { timeout: STEP_MS })
  await page.keyboard.press(sysKey('Meta+n'))
  await expect(note).toHaveText('Claude Code is signed out — run claude auth login. A new session may fail until then.', { timeout: STEP_MS })
  await page.keyboard.press('Escape')
  await waitNotifications(kea, 'the badge: the crash and the condition', (p) => p.badge === '2')
  await kea.assertUnfocused()
})

test('E-ST-8 · hooks disabled, the status file on (tier 1b alone): in a fresh, untrusted project the trust question shows; answered in the terminal, the agent’s first status-file reading clears it; then the turn works, a permission prompt needs you with one notification, answered it works again, and idle finishes it unread — none of it estimated', async ({ run, launch }) => {
  const name = 'e-st-8'
  // the agent's own config dir, whose settings disable every hook (fakeClaude's hooksOff); Kea is told it is the
  // agent's CLAUDE_CONFIG_DIR, so it looks there for the status file
  const config = path.join(run.home, `${name}-config`)
  fs.mkdirSync(config, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' }, agents: { claude: { env: { CLAUDE_CONFIG_DIR: config } } } }, null, 2)}\n`)
  const kea = await launch()
  const page = await kea.page()
  await demoProject(kea)
  const ask = gate(run, `${name}-ask`)
  const done = gate(run, `${name}-done`)
  // Claude awaiting workspace trust: no SessionStart and no status file until the dialog is answered; then the
  // file is registered and every change is the file's (fake-agent's `auto` mode writes it around each hook step, whose
  // hooks themselves never run)
  const s = await startFakeSession(
    kea,
    name,
    'fix the tests',
    `fireSessionStart: false
steps:
  - ${frame('Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit')}
  - wait: { answer: "1" }
  - hook: SessionStart
  - hook: UserPromptSubmit
  - ${frame('✶ Working…')}
  - ${ask.step}
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
  - ${frame('Bash(npm test)  Allow? (y/n)')}
  - wait: { answer: y }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "npm test" } }
  - ${frame('✶ Running npm test…')}
  - ${done.step}
  - hook: Stop
  - ${frame('⏺ All tests pass.')}
`,
    { background: true, open: false, hooksOff: true },
  )
  const statusFile = path.join(config, 'sessions', `${String(agentEvents(s.log).find((e) => e.t === 'start')!.pid)}.json`)
  expect(fs.existsSync(statusFile), 'no file while the trust dialog waits').toBe(false)

  // no hook and no file within L.trustWindowMs: the trust question
  await waitRow(kea, s.id, 'the trust question', (r) => r.status === 'needsYou', L.trustWindowMs + STEP_MS)
  expect(await labelOf(page, s.id)).toBe('question')

  // answered in its terminal: the file is registered, the question goes, and its busy starts the turn
  await fakeAgentTerminal(kea, s.id)
  await clickTerminal(page)
  await kea.type('1')
  await waitRow(kea, s.id, 'working', (r) => r.status === 'working')
  expect(fs.existsSync(statusFile)).toBe(true)
  expect(await labelOf(page, s.id), 'the trust question gone').toBeNull()

  // the permission prompt: the file says waiting
  await ask.open()
  await waitRow(kea, s.id, 'needs you', (r) => r.status === 'needsYou')
  expect(await labelOf(page, s.id)).toBe('permission')
  const posted = await waitNotifications(kea, 'the permission prompt posted', (p) => p.live.includes(`s:${s.id}`) && shown(p).some((x) => x.id === `s:${s.id}` && / · needs permission$/.test(x.title)))
  expect(shown(posted).filter((x) => x.id === `s:${s.id}` && / · needs permission$/.test(x.title)).length, 'one notification for the prompt').toBe(1)

  // answered: the file says busy again, the notification goes
  await clickTerminal(page)
  await kea.type('y')
  await waitRow(kea, s.id, 'working again', (r) => r.status === 'working')
  await waitNotifications(kea, 'withdrawn', (p) => !p.live.includes(`s:${s.id}`))

  // idle: the turn is finished (the window has no focus, so it is unread)
  await done.open()
  await waitRow(kea, s.id, 'finished, unread', (r) => r.status === 'unread')
  expect(agentHooks(s.log), 'no hook ran').toEqual([])
  const dialog = page.getByRole('dialog', { name: 'Session details' })
  await page.locator('[data-config-summary]').click()
  await expect(dialog.getByRole('list', { name: 'Why this status?' }).locator('li').last()).toHaveText(/ status-file · status file → ready \(idle\)$/, { timeout: STEP_MS })
  await expect(dialog.getByText('Status is estimated from terminal activity.')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await kea.assertUnfocused()
})
