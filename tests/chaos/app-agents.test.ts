// The kill tests' agent parts: the real app with tools/fake-agent as its `claude` (tests/support/app.ts),
// sessions started from the composer, Kea killed or hung while an agent is mid-turn. Hooks that cannot reach core are
// spooled by `kea-helper hook` and applied by the next core; a hook that reaches a core that does not answer (hung: its
// listening socket still takes the connection and the line into its backlog) is spooled once core's acknowledgement has
// not come within L.hookBoundMs.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@kea/core/src/platform/db/db.ts'
import { checkInvariants } from '@kea/core/src/platform/db/invariants.ts'
import { createMemoryLogger } from '@kea/kit'
import { L } from '@kea/protocol'
import { fixtureGitEnv } from '@kea-tools/repo-factory/src/index.ts'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { holdersUnharmed, isAlive, restartDelays } from '../support/app-chaos.ts'
import { agentEvents, claudeByDefault, fakeAgentTerminal, gate, startFakeSession } from '../support/app-fake-agent.ts'
import { addProject, demoRepo, startSession, tabOf, waitRow } from '../support/app-sessions.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

/** A run whose default agent is fake-agent `claude`, running `scenario` and logging to the returned file. */
function agentRun(scenario: string): { run: KeaRun; log: string } {
  const run = KeaRun.create()
  runs.push(run)
  fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
  const file = path.join(run.home, 'scenario.yaml')
  fs.writeFileSync(file, scenario)
  const log = path.join(run.home, 'fake-agent.log')
  writeAgentShim(run.agentBin, 'claude', { env: { FAKE_AGENT_SCENARIO: file, FAKE_AGENT_LOG: log } })
  return { run, log }
}

/** The fake agent's hook records: the event and how long its hook commands took. */
function hookRuns(log: string): { event: string; ms: number[] }[] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { t: string; event?: string; runs?: { ms: number }[] })
    .filter((r) => r.t === 'hook')
    .map((r) => ({ event: r.event ?? '', ms: (r.runs ?? []).map((x) => x.ms) }))
}

const spool = (run: KeaRun, id: string) => path.join(run.home, 'sessions', id, 'spool.ndjson')
const spooled = (run: KeaRun, id: string) => (fs.existsSync(spool(run, id)) ? fs.readFileSync(spool(run, id), 'utf8') : '')

/** The session's Agent terminal on screen holding the page's keyboard. */
async function agentFocused(kea: Kea): Promise<void> {
  const page = await kea.page()
  const pty = await tabOf(kea, 'agent')
  await until('the Agent terminal on screen', async () => (await kea.shown()) === pty || undefined)
  await page.locator('.terminal-host.shown').click({ timeout: STEP_MS })
  await until('the Agent terminal holding the keyboard', () => page.evaluate(() => !!document.activeElement && !!document.querySelector('.terminal-host.shown')?.contains(document.activeElement)) || undefined)
}

/** A turn that waits for a key, then (after `pause` ms of the agent's own pacing) runs tools and stops. */
const turn = (pause: number) => `version: 1
name: mid-turn
steps:
  - altScreen: enter
  - hook: UserPromptSubmit
  - frame: ["✻ fake-agent", "", "✶ Working… press a key"]
  - wait: key
${pause ? `  - sleep: ${pause}\n` : ''}  - loop: { times: 5, steps: [ { hook: { event: PreToolUse, tool: Read, input: { file_path: "a.txt" } } }, { hook: { event: PostToolUse, tool: Read, input: { file_path: "a.txt" } } } ] }
  - hook: { event: Stop, fields: { last_assistant_message: "Done." } }
  - frame: ["✻ fake-agent", "", "⏺ Done.", "", "> "]
`

describe('agents under the kill matrix', () => {
  it('C-KILL-19 · SIGKILL of main with an agent mid-turn: the agent runs on and its hooks spool; the relaunch reattaches the session and applies the spooled events (the turn is finished)', async () => {
    // the agent's own pacing after the key gives the kill time to land before its next hooks
    const { run, log } = agentRun(turn(2000))
    const kea = await run.launch()
    const repo = demoRepo(run)
    await addProject(kea, repo.root)
    const id = await startSession(kea, 'work through the kill', { open: false })
    await waitRow(kea, id, 'working', (r) => r.lifecycle === 'live' && r.status === 'working')
    await agentFocused(kea)
    // the glyph also spins while the agent starts: wait for the agent's own frame, drawn after its UserPromptSubmit
    await kea.waitScreen('the agent mid-turn', (sc) => sc.includes('press a key'))
    const holders = run.holders()
    await kea.press('x')
    await kea.signal('main', 'SIGKILL')
    await kea.gone()
    // Kea is gone; the agent goes on: its hooks find no core and spool
    await until('the turn spooled', () => spooled(run, id).includes('"Stop"') || undefined)
    expect(spooled(run, id).split('\n').filter(Boolean).length).toBe(11)
    const again = await run.launch()
    await waitRow(again, id, 'reattached, the spooled turn applied', (r) => r.lifecycle === 'live' && r.status !== 'working')
    await until('the spool drained and removed', () => !fs.existsSync(spool(run, id)) || undefined)
    holdersUnharmed(run, holders)
    expect(hookRuns(log).map((h) => h.event).at(-1)).toBe('Stop')
    await again.assertUnfocused()
  })

  it('C-KILL-25 · SIGSTOP of core (a hang) with an agent mid-turn: each hook gives up on core within L.hookBoundMs and spools, so the agent finishes its turn while core is still stopped; core is killed for its missed heartbeats and the next core applies the spooled turn, each envelope once', async () => {
    const { run, log } = agentRun(turn(0))
    const kea = await run.launch()
    const repo = demoRepo(run)
    await addProject(kea, repo.root)
    const id = await startSession(kea, 'work through the hang', { open: false })
    await waitRow(kea, id, 'working', (r) => r.lifecycle === 'live' && r.status === 'working')
    await agentFocused(kea)
    await kea.waitScreen('the agent mid-turn', (sc) => sc.includes('press a key'))
    const holders = run.holders()
    const hooksBefore = hookRuns(log).length
    const stoppedAt = Date.now()
    const hung = await kea.signal('core', 'SIGSTOP')
    // the key goes renderer → ptyhost → holder: core is not on that path
    await kea.press('x')
    // the whole turn, Stop included, is in the spool while the stopped core is still there: no hook waited on it
    await until('the turn spooled while core is stopped', () => spooled(run, id).includes('"Stop"') || undefined)
    expect(isAlive(hung.pid), 'core is still the stopped one').toBe(true)
    const runs = hookRuns(log).slice(hooksBefore)
    expect(runs.map((h) => h.event)).toEqual([...Array.from({ length: 5 }, () => ['PreToolUse', 'PostToolUse']).flat(), 'Stop'])
    const slowest = Math.max(...runs.flatMap((h) => h.ms))
    expect(slowest, 'every hook returned long before the agent’s own hook timeout').toBeLessThan(L.hookTimeoutS * 1000)
    const lines = spooled(run, id)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: string; payload: { hook_event_name?: string } })
    expect(lines).toHaveLength(11)
    expect(new Set(lines.map((l) => l.id)).size, 'each envelope carries its own id').toBe(11)
    // Missed heartbeats get the hung core killed and restarted; the new core drains the spool at its start
    const next = await kea.restarted('core', hung)
    expect(next.pid).not.toBe(hung.pid)
    expect(restartDelays(kea, 'core').map((d) => d.reason), 'killed for its missed heartbeats').toEqual(['heartbeat'])
    await waitRow(kea, id, 'the spooled turn applied', (r) => r.lifecycle === 'live' && r.status !== 'working')
    await until('the spool drained and removed', () => !fs.existsSync(spool(run, id)) || undefined)
    // (the next core drains the session's spool as it restores the session, before it logs that it started)
    const drains = kea.logLines('core').filter((l) => l.msg === 'spool drained' && l.sessionId === id && Date.parse(l.t) >= stoppedAt)
    expect(drains.map((l) => [l.applied, l.skipped, l.duplicates]), 'the next core applied the 11 envelopes, once').toEqual([[11, 0, 0]])
    holdersUnharmed(run, holders)
    await kea.assertUnfocused()
  })

  it('C-KILL-16 · SIGKILL of the renderer, then of ptyhost, with agent sessions running (one blocked on a permission, one mid-turn): the agents run on untouched; after each recovery every row shows its agent’s true status within L.unconfirmedStatusMs, and the agents’ next hooks reach the rows (one released by a gate, one answered by typing through the new ptyhost); the database invariants hold and the worktrees match the session records', async () => {
    const run = KeaRun.create()
    runs.push(run)
    claudeByDefault(run)
    const kea = await run.launch()
    const repo = demoRepo(run)
    await addProject(kea, repo.root)
    const asking = await startFakeSession(
      kea,
      'c-kill-16-asks',
      'asks for permission',
      `steps:
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
  - frame: ["✻ fake-agent", "", "Bash(npm test)  Allow? (y/n)"]
  - wait: { answer: y }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "npm test" } }
  - frame: ["✻ fake-agent", "", "✶ Running npm test…"]
  - wait: { answer: z }
`,
      { background: true },
    )
    const later = gate(run, 'c-kill-16-later')
    const working = await startFakeSession(
      kea,
      'c-kill-16-works',
      'works through it',
      `steps:
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Bash, input: { command: "make" } }
  - frame: ["✻ fake-agent", "", "✶ Running make…"]
  - ${later.step}
  - hook: { event: PostToolUse, tool: Bash, input: { command: "make" } }
  - hook: { event: Stop, fields: { last_assistant_message: "Built." } }
  - frame: ["✻ fake-agent", "", "⏺ Built.", "", "> "]
`,
      { background: true, open: false },
    )
    await waitRow(kea, asking.id, 'blocked', (r) => r.status === 'needsYou')
    await waitRow(kea, working.id, 'working', (r) => r.status === 'working')
    const holders = run.holders()
    const ended = () => [asking, working].flatMap((a) => agentEvents(a.log).filter((e) => e.t === 'ending' || e.t === 'exit'))
    const before = await kea.processes()

    // the renderer: the window reloads; core and ptyhost are untouched, and so are the statuses
    const renderer = await kea.signal('renderer', 'SIGKILL')
    await kea.whenReady()
    const afterRenderer = await kea.processes()
    expect(afterRenderer.renderer?.pid, 'a new renderer').not.toBe(renderer.pid)
    expect([afterRenderer.core?.pid, afterRenderer.ptyhost?.pid], 'core and ptyhost untouched').toEqual([before.core?.pid, before.ptyhost?.pid])
    await waitRow(kea, asking.id, 'blocked, after the renderer', (r) => r.lifecycle === 'live' && r.status === 'needsYou', L.unconfirmedStatusMs)
    await waitRow(kea, working.id, 'working, after the renderer', (r) => r.lifecycle === 'live' && r.status === 'working', L.unconfirmedStatusMs)
    // its next hooks (released now) reach the row: the turn finished, unread (the window has no focus)
    await later.open()
    await waitRow(kea, working.id, 'its turn finished', (r) => r.status === 'unread')

    // ptyhost: it restarts and re-adopts the holders; core and the renderer are untouched, and so are the statuses
    const old = await kea.signal('ptyhost', 'SIGKILL')
    await kea.restarted('ptyhost', old)
    const afterPtyhost = await kea.processes()
    expect([afterPtyhost.core?.pid, afterPtyhost.renderer?.pid], 'core and the renderer untouched').toEqual([before.core?.pid, afterRenderer.renderer?.pid])
    await waitRow(kea, asking.id, 'blocked, after ptyhost', (r) => r.lifecycle === 'live' && r.status === 'needsYou', L.unconfirmedStatusMs)
    await waitRow(kea, working.id, 'unread, after ptyhost', (r) => r.lifecycle === 'live' && r.status === 'unread', L.unconfirmedStatusMs)
    // answered by typing through the new ptyhost: its PostToolUse hook reaches the row
    await fakeAgentTerminal(kea, asking.id)
    await (await kea.page()).locator('.terminal-host.shown').click({ position: { x: 20, y: 20 } })
    await kea.type('y')
    await waitRow(kea, asking.id, 'answered: working', (r) => r.status === 'working')
    expect(ended(), 'neither agent ended').toEqual([])
    holdersUnharmed(run, holders)
    await kea.assertUnfocused()

    // consistency, read from a copy of the database once Kea has quit (the holders run on)
    const quit = await kea.quitFromMenu()
    expect(quit.code).toBe(0)
    const copy = path.join(run.home, 'c-kill-16-check.db')
    fs.copyFileSync(path.join(run.home, 'kea.db'), copy)
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(path.join(run.home, `kea.db${ext}`))) fs.copyFileSync(path.join(run.home, `kea.db${ext}`), `${copy}${ext}`)
    const { db } = openDatabase({ file: copy, log: createMemoryLogger({ process: 'core' }) })
    try {
      expect(checkInvariants(db)).toEqual([])
      const rows = db.all<{ id: string; lifecycle: string; cwd: string }>('SELECT id, lifecycle, cwd FROM sessions ORDER BY id')
      expect(rows.map((r) => [r.id, r.lifecycle]).sort()).toEqual([asking.id, working.id].sort().map((id) => [id, 'live']))
      const worktrees = execFileSync('git', ['-C', repo.root, 'worktree', 'list', '--porcelain'], { env: fixtureGitEnv() })
        .toString()
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => fs.realpathSync(l.slice('worktree '.length)))
        .filter((w) => w !== fs.realpathSync(repo.root))
      expect(worktrees.sort(), 'git worktree list = the session records').toEqual(rows.map((r) => fs.realpathSync(r.cwd)).sort())
    } finally {
      db.close()
    }
    holdersUnharmed(run, holders)
  })
})
