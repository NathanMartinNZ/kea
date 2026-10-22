// The session part of a core crash: the real app with tools/fake-agent as its `claude`, a session on screen
// whose agent is mid-turn, core killed. The window follows the session's `tree:<sid>` and `git:<sid>` stores through
// the test probes (`__keaProbe.store`, the same subscription a view makes, app/renderer/src/lib/rpc.ts).

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitEntry, GitHead, SessionView, TreeDir, TreeHead } from '@kea/protocol'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { KeaRun, STEP_MS, until, type Kea } from '../support/app.ts'
import { holdersUnharmed } from '../support/app-chaos.ts'
import { addProject, demoRepo, startSession, tabOf, waitRow } from '../support/app-sessions.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

type StoreProbe = { rows: Record<string, unknown> | null; snapshots: number }
declare const __keaProbe: { store(name: string): StoreProbe }

/** A core store as the window holds it now (followed from the first call on, across core restarts). */
async function store(kea: Kea, name: string): Promise<StoreProbe> {
  return (await kea.page()).evaluate((n) => __keaProbe.store(n), name)
}

const spool = (run: KeaRun, id: string) => path.join(run.home, 'sessions', id, 'spool.ndjson')
const spooled = (run: KeaRun, id: string) => (fs.existsSync(spool(run, id)) ? fs.readFileSync(spool(run, id), 'utf8') : '')

/** A turn that waits for a key, then runs tools at once and stops. */
const TURN = `version: 1
name: mid-turn
steps:
  - altScreen: enter
  - hook: UserPromptSubmit
  - frame: ["✻ fake-agent", "", "✶ Working… press a key"]
  - wait: key
  - loop: { times: 5, steps: [ { hook: { event: PreToolUse, tool: Read, input: { file_path: "a.txt" } } }, { hook: { event: PostToolUse, tool: Read, input: { file_path: "a.txt" } } } ] }
  - hook: { event: Stop, fields: { last_assistant_message: "Done." } }
  - frame: ["✻ fake-agent", "", "⏺ Done.", "", "> "]
`

describe('files and git under the kill matrix', () => {
  it('C-KILL-18 · SIGKILL of core with an agent mid-turn: the next core applies the hooks spooled meanwhile, and the window’s tree and git stores come back with what changed while core was away and follow changes again', async () => {
    const run = KeaRun.create()
    runs.push(run)
    fs.writeFileSync(path.join(run.home, 'settings.json'), `${JSON.stringify({ general: { defaultAgent: 'claude' } }, null, 2)}\n`)
    const scenario = path.join(run.home, 'scenario.yaml')
    fs.writeFileSync(scenario, TURN)
    writeAgentShim(run.agentBin, 'claude', { env: { FAKE_AGENT_SCENARIO: scenario, FAKE_AGENT_LOG: path.join(run.home, 'fake-agent.log') } })
    const kea = await run.launch()
    const repo = demoRepo(run)
    await addProject(kea, repo.root)
    const id = await startSession(kea, 'work through the crash', { open: false })
    await waitRow(kea, id, 'working', (r) => r.lifecycle === 'live' && r.status === 'working')
    const page = await kea.page()
    const pty = await tabOf(kea, 'agent')
    await until('the Agent terminal on screen', async () => (await kea.shown()) === pty || undefined)
    await page.locator('.terminal-host.shown').click({ timeout: STEP_MS })
    await kea.waitScreen('the agent mid-turn', (sc) => sc.includes('press a key'))

    // the session's tree and git, as the window follows them
    const cwd = await until('the session’s worktree', async () => ((await store(kea, 'sessions')).rows?.[id] as SessionView | undefined)?.cwd || undefined)
    const tree = `tree:${id}`
    const git = `git:${id}`
    const rootNames = async (): Promise<string[]> => (((await store(kea, tree)).rows?.['/'] as TreeDir | undefined)?.entries ?? []).map((e) => e.name)
    const entry = async (rel: string): Promise<GitEntry | undefined> => (await store(kea, git)).rows?.[`/${rel}`] as GitEntry | undefined
    const gitState = async (): Promise<string | undefined> => ((await store(kea, git)).rows?.head as GitHead | undefined)?.state
    await until('the root listed and a status in the window', async () => (await rootNames()).includes('README.md') && (await gitState()) === 'ok')
    expect(((await store(kea, tree)).rows?.head as TreeHead).git).toBe(true)
    fs.writeFileSync(path.join(cwd, 'before.txt'), 'made before the crash\n')
    await until('a file made before the crash, in the tree and in the changes', async () => (await rootNames()).includes('before.txt') && (await entry('before.txt'))?.code === 'U')
    const snapshots = { tree: (await store(kea, tree)).snapshots, git: (await store(kea, git)).snapshots }

    // core dies; the key reaches the agent all the same (renderer → ptyhost → holder: core is not on that path), and
    // its hooks start before the supervisor's backoff lets the next core up
    const holders = run.holders()
    const killedAt = Date.now()
    const dead = await kea.signal('core', 'SIGKILL')
    await kea.press('x')
    fs.writeFileSync(path.join(cwd, 'meanwhile.txt'), 'made while core was away\n')
    fs.rmSync(path.join(cwd, 'before.txt'))
    const next = await kea.restarted('core', dead)
    expect(next.pid).not.toBe(dead.pid)

    // status: the turn finishes; whatever its hooks spooled while no core listened is applied by the next one
    await waitRow(kea, id, 'the turn finished and applied', (r) => r.lifecycle === 'live' && r.status !== 'working')
    await until('the spool drained and removed', () => !fs.existsSync(spool(run, id)) || undefined)
    expect(spooled(run, id)).toBe('')
    const drained = kea.logLines('core').filter((l) => l.msg === 'spool drained' && l.sessionId === id && Date.parse(l.t) >= killedAt)
    expect(drained.reduce((n, l) => n + Number(l.applied ?? 0), 0), 'hooks sent while core was away were spooled, and the next core applied them').toBeGreaterThan(0)
    expect(drained.reduce((n, l) => n + Number(l.duplicates ?? 0), 0), 'each once').toBe(0)

    // tree and git: the window's subscriptions get the next core's stores, with what happened meanwhile
    await until('the tree store again, with the change made meanwhile', async () => {
      const names = await rootNames()
      return (await store(kea, tree)).snapshots > snapshots.tree && names.includes('meanwhile.txt') && !names.includes('before.txt')
    })
    await until('the git store again, with the change made meanwhile', async () => (await store(kea, git)).snapshots > snapshots.git && (await gitState()) === 'ok' && (await entry('meanwhile.txt'))?.code === 'U' && (await entry('before.txt')) === undefined)
    // and both follow the worktree again: the next core watches it
    fs.writeFileSync(path.join(cwd, 'after.txt'), 'made after the restart\n')
    fs.appendFileSync(path.join(cwd, 'README.md'), '\nedited after the restart\n')
    await until('changes after the restart, in the tree and in the changes', async () => (await rootNames()).includes('after.txt') && (await entry('after.txt'))?.code === 'U' && (await entry('README.md'))?.code === 'M')
    expect(kea.logLines('core').filter((l) => Date.parse(l.t) >= killedAt && l.msg === 'watcher binding loaded').length, 'the next core loaded the watcher').toBe(1)

    holdersUnharmed(run, holders)
    await kea.assertUnfocused()
  })
})
