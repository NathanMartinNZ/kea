// Chaos for the agent side of core: corrupt spools, hostile hook input, the agent CLI removed or replaced under running
// sessions. tools/fake-agent `--as claude` is the `claude` on PATH (tests/integration/core-agents-support.ts); hooks
// are real `kea-helper hook` processes.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { spoolPath } from '@kea/core/src/agents/spool.ts'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { until } from '../support/holders.ts'
import { createArgs, repo } from '../integration/core-sessions-support.ts'
import { startAgentSessions, type AgentSessionsUnderTest } from '../integration/core-agents-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function agents(): Promise<AgentSessionsUnderTest> {
  const s = await startAgentSessions()
  cleanup.push(() => s.dispose())
  return s
}

function fixture(name = 'demo') {
  const r = repo(name)
  cleanup.push(() => r.dispose())
  return r
}

/** An idle agent: each typed line is a turn (UserPromptSubmit … Stop). */
const LINE_TURNS = `version: 1
steps:
  - print: "READY\\r\\n"
onLine:
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Read, input: { file_path: "a.txt" } }
  - hook: { event: PostToolUse, tool: Read, input: { file_path: "a.txt" } }
  - hook: Stop
  - print: "LINE-DONE {{line}}\\r\\n"
`

async function agentUp(s: AgentSessionsUnderTest, id: string): Promise<void> {
  await until(`session ${id}: SessionStart delivered`, () => s.envelopes.some((e) => e.keaSessionId === id && (e.payload as { hook_event_name?: string }).hook_event_name === 'SessionStart'))
}

/** The Stop hook's command line, from the launched argv's inline settings. */
function stopHook(s: AgentSessionsUnderTest, id: string): { command: string; args: string[] } {
  const argv = s.c.core.terminals.sessionRecords(id).find((x) => x.kind === 'agent')!.argv
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> }
  return settings.hooks.Stop![0]!.hooks[0]!
}

const warned = (s: AgentSessionsUnderTest, msg: string) => s.c.log.entries.filter((e) => e.level === 'warn' && e.msg === msg)

describe('agent signals under chaos', () => {
  it('C-COR-4 · a spool with garbage lines and a partial last line: the valid envelopes are applied in order, the rest skipped and logged', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('turns.yaml', LINE_TURNS) })
    const v = await s.create(p.id, '')
    await agentUp(s, v.id)
    // core's agent side away: a whole turn spools
    s.c.core.agents.dispose()
    s.type(v.id, 'one\r')
    const file = spoolPath(s.h.home, v.id)
    await until('the turn spooled', () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"Stop"'))
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(4)
    // corrupt it: garbage between the envelopes, an envelope of another session, and a torn last line
    const other = { ...(JSON.parse(lines[1]!) as Record<string, unknown>), keaSessionId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' }
    const corrupt = [lines[0], '{not json', lines[1], '\u0000\u0001garbage', JSON.stringify(other), lines[2], '[]', lines[3], lines[3]!.slice(0, 40)].join('\n')
    fs.writeFileSync(file, corrupt)
    await s.relaunch()
    await s.until(v.id, 'the spooled turn applied', (x) => x.phase === 'ready')
    const st = s.c.core.agents.stats
    expect(st.spoolApplied).toBe(4)
    expect(st.spoolSkipped).toBe(5) // two garbage lines, another session's envelope, `[]`, the torn tail
    expect(s.c.log.entries.find((e) => e.msg === 'spool drained' && e.sessionId === v.id)).toMatchObject({ applied: 4, skipped: 5 })
    expect(fs.existsSync(file)).toBe(false)
    // the journal has the turn once, in order
    const journal = s.c.core.db.all<{ event: string }>(`SELECT event FROM status_events WHERE session_id = ? AND source = 'hook' ORDER BY id`, v.id).map((j) => j.event)
    expect(journal.filter((e) => e === 'turn.started' || e === 'turn.finished')).toEqual(['turn.started', 'turn.finished'])
  })

  it('C-COR-7 · hook stdin that is not JSON, a 5 MB payload and a hook naming an unknown session: dropped (or projected within the cap) and logged; no state change; core and the session carry on', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('turns.yaml', LINE_TURNS) })
    const v = await s.create(p.id, '')
    await agentUp(s, v.id)
    await s.until(v.id, 'idle', (x) => x.phase === 'idle')
    const hook = stopHook(s, v.id)
    const run = (args: string[], input: string | Buffer) => {
      const res = spawnSync(hook.command, args, { input, env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1 << 20 })
      expect(res.status, String(res.stderr)).toBe(0) // never fails the agent
    }
    const before = { ...s.c.core.agents.stats }
    const journal = () => s.c.core.db.get<{ n: number }>(`SELECT count(*) AS n FROM status_events WHERE session_id = ? AND event != 'session.started'`, v.id)!.n
    const rows = journal()
    // not JSON
    run(hook.args, '{"hook_event_name": "Stop", oops')
    // 5 MB: a Stop whose last message is 5 MB (projected: cut to the summary length, the envelope within its cap)
    const big = JSON.stringify({ hook_event_name: 'Notification', session_id: v.agentSessionId, cwd: v.cwd, notification_type: 'idle_prompt', message: 'x'.repeat(5 * 1024 * 1024) })
    let bigEnvelope = 0
    s.onEnvelope = (e) => {
      if ((e.payload as { notification_type?: string }).notification_type === 'idle_prompt') bigEnvelope = Buffer.byteLength(JSON.stringify(e))
    }
    run(hook.args, big)
    // a session Kea does not have
    const args = [...hook.args]
    args[args.indexOf('--session') + 1] = '01ZZZZZZZZZZZZZZZZZZZZZZZZ'
    run(args, JSON.stringify({ hook_event_name: 'Stop', session_id: v.agentSessionId, cwd: v.cwd }))
    await until('three envelopes', () => s.c.core.agents.stats.envelopes - before.envelopes >= 3)
    const st = s.c.core.agents.stats
    expect(st.malformed - before.malformed).toBe(1)
    expect(st.unknownSession - before.unknownSession).toBe(1)
    expect(bigEnvelope).toBeGreaterThan(0)
    expect(bigEnvelope).toBeLessThanOrEqual(L.hookEnvelopeMaxBytes)
    // logged (the first of each kind; later ones at doubling counts)
    expect(warned(s, 'hook payload was not JSON: dropped').length).toBe(1)
    expect(warned(s, 'hook envelope for an unknown session: dropped').length).toBe(1)
    // no state change, nothing journaled from them
    expect(s.view(v.id)!.phase).toBe('idle')
    expect(journal()).toBe(rows)
    // core and the session carry on
    s.type(v.id, 'after\r')
    await s.until(v.id, 'a turn after the bad hooks', (x) => x.phase === 'ready')
  })

  it('C-RES-11 · the agent CLI removed while a session runs: that session is unaffected; a new launch reports it as not installed; put back, and replaced again in place, each next launch detects and shows the new version', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('turns.yaml', LINE_TURNS) })
    const a = await s.create(p.id, '')
    await agentUp(s, a.id)
    expect(s.c.core.agents.store.get('claude')).toMatchObject({ state: 'ready', version: '2.1.296' })
    fs.rmSync(path.join(s.binDir, 'claude'))
    // the running agent does not need its binary
    s.type(a.id, 'still here\r')
    await s.until(a.id, 'a turn in the running session', (x) => x.phase === 'ready')
    // a new launch looks again before using the cached detection, and says why it cannot start
    const res = await s.call<{ sessionId: string }>('sessions.create', createArgs(p.id, '', { agent: 'claude' }))
    const b = await s.until(res.sessionId, 'the creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
    expect(b.lifecycle).toBe('create_failed')
    expect(b.creation?.error ?? '').toMatch(/Claude Code is not installed\. Install it with: /)
    await until('the agents store says missing', () => s.c.core.agents.store.get('claude')?.state === 'missing')
    // replaced: a newer version at the same path is detected again at the next launch
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('turns.yaml', LINE_TURNS), FAKE_AGENT_CLI_VERSION: '2.1.300' })
    const c = await s.create(p.id, '')
    await agentUp(s, c.id)
    expect(s.c.core.agents.store.get('claude')).toMatchObject({ state: 'ready', version: '2.1.300' })
    // replaced in place while the cached detection says ready: the launch notices the binary changed and looks again
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('turns.yaml', LINE_TURNS), FAKE_AGENT_CLI_VERSION: '2.1.301' })
    const d = await s.create(p.id, '')
    await agentUp(s, d.id)
    expect(s.c.core.agents.store.get('claude')).toMatchObject({ state: 'ready', version: '2.1.301' })
    expect(s.view(a.id)!.lifecycle).toBe('live')
  })
})
