// What a relaunch shows of turns that ended while Kea was closed: Kea launched through tests/e2e/fixtures.ts
// (unfocused, temp KEA_HOME, hermetic git) with tools/fake-agent as Claude Code and as Command Code's `cmd` (the real
// CLIs are never run). Each agent waits mid-turn at a gate (a FIFO in the run's home) that the test opens once Kea has
// quit completely, so the turn ends with no Kea to tell and `kea-helper hook` spools its events. Notifications and the
// badge are read from main's recorder (tests/support/app-status.ts): no test posts a real notification.

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { harnessUserHome } from '../../tools/perf/src/launch.ts'
import { STEP_MS, until, type KeaRun } from '../support/app.ts'
import { AGENT_MARK, agentEvents, claudeByDefault, fakeClaude, gate } from '../support/app-fake-agent.ts'
import { menuBarState } from '../support/app-menubar.ts'
import { addProject, demoRepo, promptBox, rowState, startSession, waitLive, waitRow } from '../support/app-sessions.ts'
import { notifications, shown, viewing, waitNotifications } from '../support/app-status.ts'
import { expect, test } from './fixtures.ts'
import { sysKey } from '../support/keys.ts'

/** What a session's spool holds: the event name of each envelope (Claude Code's hook, Command Code's mod event). */
function spooled(run: KeaRun, id: string): string[] {
  const file = path.join(run.home, 'sessions', id, 'spool.ndjson')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = (JSON.parse(l) as { payload: { hook_event_name?: unknown; type?: unknown } }).payload
      return String(p.hook_event_name ?? p.type)
    })
}

/** The session row's status glyph. */
function glyphKind(page: Page, id: string): Promise<string | null> {
  return page.evaluate((sid) => document.querySelector(`[role=treeitem][data-session-id="${sid}"] .kea-glyph`)?.getAttribute('data-glyph') ?? null, id)
}

test('E-ST-9 · Quit Kea completely during a long turn of a Claude Code session and of a Command Code session, and both turns end while it is closed: relaunched, each row is unread ready (the spooled end of its turn applied), the badge counts both, and one summary notification says two sessions changed, with none per session', async ({ run, launch }) => {
  claudeByDefault(run)
  const claudeGate = gate(run, 'e-st-9-claude')
  const cmdGate = gate(run, 'e-st-9-cmd')
  // Claude Code: a turn that works until the gate opens, then stops
  const claude = fakeClaude(
    run,
    'e-st-9-claude',
    `steps:
  - hook: UserPromptSubmit
  - frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', '✶ Working…'])}
  - ${claudeGate.step}
  - hook: { event: Stop, fields: { last_assistant_message: "The migration is written." } }
  - frame: ${JSON.stringify([AGENT_MARK, '', '> {{prompt}}', '', '⏺ The migration is written.'])}
  - wait: { answer: z }
`,
  )
  // Command Code: a run that goes on until the gate opens, then ends
  const cmdScenario = path.join(run.home, 'e-st-9-cmd.yaml')
  fs.writeFileSync(
    cmdScenario,
    `version: 1
name: e-st-9-cmd
steps:
  - print: "${AGENT_MARK} (cmd)\\r\\n"
  - hook: run_start
  - ${cmdGate.step}
  - hook: { event: run_end, fields: { result: { finalText: "The tests pass." } } }
  - wait: { answer: z }
`,
  )
  const cmdLog = path.join(run.home, 'e-st-9-cmd.log')
  writeAgentShim(run.agentBin, 'commandcode', { name: 'cmd', env: { FAKE_AGENT_HOME: harnessUserHome(run.home), FAKE_AGENT_LOG: cmdLog, FAKE_AGENT_SCENARIO: cmdScenario } })

  const kea = await launch()
  const page = await kea.page()
  await addProject(kea, demoRepo(run).root)
  const one = await startSession(kea, 'write the migration')
  await waitLive(kea, one)
  await until('Claude Code started', () => agentEvents(claude.log).some((e) => e.t === 'start') || undefined)
  await waitRow(kea, one, 'working', (r) => r.status === 'working')
  // the second session with the other agent (⌘1 opens the Agent menu from the prompt)
  const two = await startSession(kea, 'run the tests', {
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
  await waitLive(kea, two)
  await until('Command Code started', () => agentEvents(cmdLog).some((e) => e.t === 'start') || undefined)
  await waitRow(kea, two, 'working', (r) => r.status === 'working')
  const titles = [(await rowState(page, one))!.title, (await rowState(page, two))!.title]
  const before = await notifications(kea)
  expect(shown(before), 'nothing posted while both work').toEqual([])
  expect(before.badge).toBe('')

  // Quit Kea completely (⌥⌘Q), both turns under way: the agents run on in their holders, with nobody to tell
  expect(await kea.quitFromMenu(), 'Kea quits cleanly').toEqual({ code: 0, signal: null })
  await kea.gone()
  expect(spooled(run, one)).toEqual([])
  expect(spooled(run, two)).toEqual([])
  await claudeGate.open()
  await cmdGate.open()
  await until('Claude Code’s Stop spooled', () => spooled(run, one).includes('Stop') || undefined)
  await until('Command Code’s run_end spooled', () => spooled(run, two).includes('run_end') || undefined)

  // relaunched after both ended: each row unread ready, from its spool
  const again = await launch({ ready: 'window' })
  const page2 = await again.page()
  for (const id of [one, two]) {
    await waitRow(again, id, 'unread ready after the relaunch', (r) => r.lifecycle === 'live' && r.status === 'unread')
    expect(await glyphKind(page2, id), 'the unread dot').toBe('unread')
    await until('its spool applied and removed', () => !fs.existsSync(path.join(run.home, 'sessions', id, 'spool.ndjson')) || undefined)
  }
  expect(await viewing(again), 'the window has no keyboard focus: neither is being viewed').toBeNull()
  // the badge counts both, in the Dock and in what the menu bar would show
  const counted = await menuBarState(again, 'two sessions need you', (s) => s.count === 2)
  expect(counted.state!.sessions.map((s) => s.id).sort()).toEqual([one, two].sort())
  // one summary, once the restored statuses are confirmed: never one notification per session
  const p = await waitNotifications(again, 'the summary of what changed while Kea was closed', (x) => x.live.includes('summary'))
  expect(p.badge).toBe('2')
  expect(shown(p).map((x) => [x.id, x.title, x.subtitle, x.silent])).toEqual([['summary', '2 sessions changed while Kea was closed', '', true]])
  for (const t of titles) expect(shown(p)[0]!.body, 'the summary names both').toContain(t)
  // (the spools were applied as the sessions were restored, before the summary's wait began: a notification per
  // session would have been posted by now)
  expect(p.live).toEqual(['summary'])
  expect(again.logLines('core').filter((l) => l.msg === 'spool drained').map((l) => l.sessionId).sort()).toEqual([one, two].sort())
  for (const id of [one, two]) expect((await rowState(page2, id))!.status).toBe('unread')
  await again.assertUnfocused()
})
