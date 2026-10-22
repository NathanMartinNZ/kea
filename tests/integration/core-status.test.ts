// The status engine in core against real git, real holders and a real ptyhost: core assembled as main.ts assembles it,
// on a temp KEA_HOME. The report and account-condition tests run tools/fake-agent as Claude Code
// (core-agents-support.ts): its hooks through real `kea-helper hook` processes, its status file and transcript. The
// usage-limit failure with a reset time is injected at core's intake (`core.status.ingest`): the Claude adapter does
// not read one from Claude's `StopFailure` (U-AGT-14). The other tests run the `shell` pseudo-agent.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerCoreGauges } from '@kea/core/src/resources/gauges.ts'
import { loadFixture, replay } from '@kea/core/src/status/replay.ts'
import type { StatusNotice } from '@kea/core/src/status/notices.ts'
import { resources } from '@kea/kit'
import { badgeCount, expectedStateOf, L, readRing, type AgentEvent, type SessionView, type StatusSource } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { until } from '../support/holders.ts'
import { startAgentSessions, type AgentSessionsUnderTest } from './core-agents-support.ts'
import { createArgs, repo, startSessions, type SessionsUnderTest } from './core-sessions-support.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function sessions(o: Parameters<typeof startSessions>[0] = {}): Promise<SessionsUnderTest> {
  const s = await startSessions(o)
  cleanup.push(() => s.dispose())
  return s
}

async function agentSessions(): Promise<AgentSessionsUnderTest> {
  const s = await startAgentSessions()
  cleanup.push(() => s.dispose())
  return s
}

function fixture(name = 'demo') {
  const r = repo(name)
  cleanup.push(() => r.dispose())
  return r
}

function tmpDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

async function create(s: SessionsUnderTest, projectId: string, prompt: string, more: Record<string, unknown> = {}): Promise<SessionView> {
  const r = await s.call<{ sessionId: string }>('sessions.create', createArgs(projectId, prompt, more))
  const v = await s.until(r.sessionId, 'creation settles', (x) => x.lifecycle === 'live' || x.lifecycle === 'create_failed')
  if (v.lifecycle !== 'live') throw new Error(`creation failed: ${v.creation?.error}`)
  return v
}

function ingest(s: SessionsUnderTest, sessionId: string, source: StatusSource, ...events: AgentEvent[]): void {
  expect(s.c.core.status.ingest({ sessionId, source, events, at: Date.now() }), `${sessionId} is live`).toBe(true)
}

function journal(s: SessionsUnderTest, id: string): unknown[] {
  s.c.core.statusBatch.flush()
  return s.c.core.db.all('SELECT at, source, event, summary, phase_after FROM status_events WHERE session_id = ? ORDER BY id', id)
}

describe('report wrong status', () => {
  it('I-ST-1 · a report mid-turn: the bundle is complete (the platform report main sent among it, scrubbed), within its size caps and L.reportCaptureMs, and changes nothing; fixture:from-report scrubs it clean and it replays to the expected state; the folder keeps the newest L.reportsKept; the resource report counts it by expected state', async () => {
    const s = await agentSessions()
    const r = fixture()
    const p = await s.project(r.root)
    // mid-turn: a tool is running; the transcript holds more than L.reportTranscriptBytes (records the adapter reads
    // nothing from: each assistant record's usage would be a signal of its own, and 200 of them fill the ring)
    s.shim({
      FAKE_AGENT_SCENARIO: s.scenario(
        'mid-turn.yaml',
        `version: 1
steps:
  - hook: UserPromptSubmit
  - transcript: { record: user, text: "{{prompt}}" }
  - loop: { times: 200, steps: [{ transcript: { record: raw, json: { type: "progress", pad: "${'x'.repeat(400)}" } } }] }
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }
  - print: "RUNNING\\r\\n"
  - wait: { answer: y }
`,
      ),
    })
    const v = await s.create(p.id, 'make the tests pass', { isolation: 'inplace' })
    const gauges = registerCoreGauges({ connections: new Map(), terminals: s.c.core.terminals, status: s.c.core.status })
    cleanup.push(() => gauges.dispose())

    // the folder already holds L.reportsKept older bundles, as many as it keeps
    const reports = path.join(s.h.home, 'reports')
    for (let i = 0; i < L.reportsKept; i++) {
      const old = path.join(reports, `20000101-000000-${String(i).padStart(3, '0')}-${v.id}`)
      fs.mkdirSync(old, { recursive: true })
      fs.writeFileSync(path.join(old, 'report.json'), JSON.stringify({ format: 1, expected: 'idle' }))
    }

    const ring = () => s.c.core.status.machine(v.id)!.ring
    await until('the tool started (its hook) and the status file read', () => ring().some((x) => x.events.some((e) => e.t === 'tool.started')) && ring().some((x) => x.source === 'status-file'))
    // and its output in the agent PTY's ring, which the bundle's ring.bin is the tail of: the agent prints only once its
    // PreToolUse hook has returned, after core took the hook, so under load the report could come before the print
    const ptyRing = path.join(s.h.home, 'sessions', v.id, `${s.agentPty(v.id)}.ring`)
    await until('the agent’s output in its PTY ring', () => new TextDecoder().decode(readRing(fs.readFileSync(ptyRing))?.data ?? new Uint8Array(0)).includes('RUNNING'))
    expect(s.c.core.status.state(v.id)?.phase).toBe('working')
    const before = { state: structuredClone(s.c.core.status.state(v.id)), journal: journal(s, v.id), ring: s.c.core.status.machine(v.id)!.ring.length }

    // The platform report main sent this core; one fix names a path in the user's home folder
    const helper = path.join(os.homedir(), 'kea-src', 'node_modules', 'electron', 'dist', 'chrome-sandbox')
    s.c.core.diagnostics.setPlatform({
      system: 'linux',
      version: 'Linux 6.8.0',
      arch: 'arm64',
      lines: [
        { id: 'holderDetach', label: 'Terminals', value: 'each in a systemd scope of its own, which outlives Kea', fix: null },
        { id: 'rendererSandbox', label: 'Window sandbox', value: 'off', fix: `Run sudo chmod 4755 ${helper}.` },
      ],
    })
    const { dir, ms } = await s.call<{ dir: string; ms: number }>('status.report', { id: v.id, expected: 'working', note: 'the spinner looked stuck' })
    expect(ms).toBeLessThan(L.reportCaptureMs)
    expect(path.dirname(dir)).toBe(reports)
    expect(fs.readdirSync(dir).sort()).toEqual(['report.json', 'resources.json', 'ring.bin', 'screen.txt', 'signals.ndjson', 'status-events.ndjson', 'status-file.json', 'transcript.jsonl'])
    const rep = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'))
    expect(rep).toMatchObject({ format: 1, sessionId: v.id, agent: 'claude', lifecycle: 'live', phase: 'working', expected: 'working', note: 'the spinner looked stuck', missing: [] })
    // the platform report, scrubbed as Copy Diagnostics' text is
    expect(rep.platform).toMatchObject({ system: 'linux', lines: [{ id: 'holderDetach', fix: null }, { id: 'rendererSandbox', fix: 'Run sudo chmod 4755 <path>' }] })
    expect(JSON.stringify(rep.platform)).not.toContain(os.homedir())
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'status-file.json'), 'utf8'))).toMatchObject({ status: 'busy' })
    const bytes = (f: string) => fs.statSync(path.join(dir, f)).size
    const lines = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)
    expect(bytes('transcript.jsonl')).toBe(L.reportTranscriptBytes)
    expect(bytes('ring.bin')).toBeLessThanOrEqual(L.reportRingBytes)
    expect(bytes('ring.bin')).toBeGreaterThan(0)
    expect(lines('status-events.ndjson').length).toBe(Math.min(L.reportEvents, before.journal.length))
    expect(lines('signals.ndjson').length).toBe(before.ring)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'resources.json'), 'utf8'))).toHaveProperty('core.status')
    // the capture changed nothing about the session
    expect(s.c.core.status.state(v.id)).toEqual(before.state)
    expect(journal(s, v.id)).toEqual(before.journal)
    expect(s.c.core.status.machine(v.id)!.ring.length).toBe(before.ring)
    expect(s.view(v.id)?.lifecycle).toBe('live')

    // The newest L.reportsKept stay, this one among them
    const kept = fs.readdirSync(reports)
    expect(kept.length).toBe(L.reportsKept)
    expect(kept).toContain(path.basename(dir))
    // The resource report (the hourly line's core part) counts the bundles present by expected state
    expect(resources.report()['core.statusReports']).toEqual({ total: L.reportsKept, working: 1, needsMe: 0, finished: 0, idle: L.reportsKept - 1, ended: 0 })

    // `pnpm fixture:from-report`: scrubbed, scanned clean (exit 0), and the replay reaches the expected state
    const out = tmpDir('kea-ist1-fixtures-')
    const said = execFileSync(process.execPath, [path.join(ROOT, 'tools/scrubber/src/from-report.ts'), dir, '--out', out], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    expect(said).not.toContain('Private data left')
    const f = loadFixture(path.join(out, path.basename(dir)))
    expect(fs.readFileSync(path.join(f.dir, 'signals.ndjson'), 'utf8')).not.toContain(os.userInfo().username === 'root' ? '\0' : `/Users/${os.userInfo().username}/`)
    expect(f.fixture).toMatchObject({ expected: 'working', note: 'the spinner looked stuck', reported: { lifecycle: 'live', phase: 'working' } })
    const replayed = replay(f)
    expect(replayed.expected).toBe('working')
    expect(replayed.state.phase).toBe(before.state!.phase)
    expect(expectedStateOf({ lifecycle: 'live', phase: replayed.state.phase })).toBe('working')
  })
})

describe('account conditions', () => {
  it('I-ST-2 · three sessions hit the usage limit with a reset time: one condition in kv, N4 updated in place; after a core restart it is restored, and when the clock reaches the reset N5 is posted once; badge 1 throughout', async () => {
    const s = await agentSessions()
    const r = fixture()
    const p = await s.project(r.root)
    // each agent's turn starts (its prompt hook) and waits; the failure with a reset time is injected below. No status
    // file: a real agent's would say idle after its StopFailure, while this one's turn never ends, so after the restart a
    // fresh core's first reading (busy, an exact source) would rightly say the agent is working again
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('turn.yaml', 'version: 1\nstatusFile: off\nsteps:\n  - hook: UserPromptSubmit\n  - print: "WORKING\\r\\n"\n') })
    const ids: string[] = []
    for (const n of [1, 2, 3]) ids.push((await s.create(p.id, `task ${n}`)).id)
    for (const id of ids) await s.until(id, 'its turn started (the hook)', (x) => x.phase === 'working')
    const notices: StatusNotice[] = []
    const listen = () => s.c.core.status.notices.event((n) => notices.push(n))
    listen()

    // a real limit resets in hours; this one a few seconds after the restart below
    const resetsAt = Date.now() + 4_000
    for (const id of ids) ingest(s, id, 'hook', { t: 'turn.failed', error: 'usage limit reached', kind: 'rate_limit', resetsAt })
    const views = () => ids.map((id) => s.view(id)!)
    const conditions = () => [...s.c.core.status.conditions.store.values()]
    expect(conditions()).toEqual([{ agent: 'claude', kind: 'rate_limit', state: 'active', since: expect.any(Number), resetsAt, sessionIds: ids }])
    const kv = () => s.c.core.db.all<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'condition:%'")
    expect(kv().map((x) => [x.key, JSON.parse(x.value)])).toEqual([['condition:claude', conditions()[0]]])
    // N4: one notification (per agent), updated in place as each session joins; no session posts N3
    const n4 = notices.filter((n) => n.k === 'N4')
    expect(n4.map((n) => n.condition.sessionIds.length)).toEqual([1, 2, 3])
    expect(new Set(n4.map((n) => n.condition.agent))).toEqual(new Set(['claude']))
    expect(notices.filter((n) => n.k === 'N3' || n.k === 'N5')).toEqual([])
    await s.until(ids[2]!, 'the runtime row reaches the sessions store', (x) => x.phase === 'failed')
    expect(views().every((x) => x.phase === 'failed' && x.failureKind === 'rate_limit')).toBe(true)
    expect(badgeCount(views(), conditions())).toBe(1)

    // core restarts: the condition comes back from kv, re-evaluated against the sessions' restored state
    await s.relaunch()
    notices.length = 0
    listen()
    expect(conditions(), 'restored, and not yet reset (the restart took less than the margin)').toEqual([{ agent: 'claude', kind: 'rate_limit', state: 'active', since: expect.any(Number), resetsAt, sessionIds: ids }])
    expect(views().every((x) => x.lifecycle === 'live' && x.phase === 'failed' && x.failureKind === 'rate_limit')).toBe(true)
    expect(badgeCount(views(), conditions())).toBe(1)

    // the clock reaches the reset: N5 once, Continue all offered
    await until('the usage limit resets', () => conditions()[0]?.state === 'reset', resetsAt - Date.now() + L.conditionCheckMs)
    expect(notices.filter((n) => n.k === 'N5').map((n) => n.k === 'N5' && n.condition.sessionIds)).toEqual([ids])
    expect(notices.filter((n) => n.k !== 'N5')).toEqual([])
    expect(JSON.parse(kv()[0]!.value)).toMatchObject({ state: 'reset' })
    expect(badgeCount(views(), conditions())).toBe(1)
    // nothing more comes later (the next check finds nothing to move)
    await s.idle()
    expect(notices.filter((n) => n.k === 'N5')).toHaveLength(1)
  })
})

describe('typing into an agent', () => {
  it('I-ST-3 · sendText writes to the session’s agent PTY: as a paste inside bracketed-paste markers, any markers in the text removed; Enter in a write of its own, and the shell runs it; false with no running agent. Continue all types continue + Enter into each session the reset condition holds and no other, and the condition ends', async () => {
    const s = await sessions()
    const r = fixture()
    const p = await s.project(r.root)
    const ids: string[] = []
    for (const n of [1, 2, 3]) ids.push((await create(s, p.id, `task ${n}`)).id)
    const [typed, ...held] = ids as [string, string, string]
    const terminals = s.c.core.terminals
    const agentPty = (id: string) => terminals.sessionRecords(id).filter((x) => x.kind === 'agent').at(-1)!.ptyId
    const inputs = (from: number) => s.c.calls.slice(from).filter((x) => x.m === 'pty.input').map((x) => [x.a.ptyId, x.a.data])

    // Enter, in a write of its own: the shell runs the line
    let mark = s.c.calls.length
    expect(await terminals.sendText(typed, 'echo kea-$((6*7))', { submit: true })).toBe(true)
    expect(inputs(mark)).toEqual([
      [agentPty(typed), 'echo kea-$((6*7))'],
      [agentPty(typed), '\r'],
    ])
    await until('the shell ran it', async () => /^kea-42$/m.test((await terminals.captureScreen(agentPty(typed))) ?? ''))
    // a paste: inside the markers, the end marker in the text removed so it cannot end the paste early
    mark = s.c.calls.length
    expect(await terminals.sendText(typed, 'echo one\x1b[201~two\x1b[200~', { bracketed: true })).toBe(true)
    expect(inputs(mark)).toEqual([[agentPty(typed), '\x1b[200~echo onetwo\x1b[201~']])
    expect(await terminals.sendText('no-such-session', 'x', { submit: true }), 'no agent: nothing written').toBe(false)

    // Continue all, once the limit has reset: into the sessions it holds, and only those
    const resetsAt = Date.now() + 1_500
    for (const id of held) {
      ingest(s, id, 'hook', { t: 'turn.started' })
      ingest(s, id, 'hook', { t: 'turn.failed', error: 'usage limit reached', kind: 'rate_limit', resetsAt })
    }
    const conditions = () => [...s.c.core.status.conditions.store.values()]
    await until('the usage limit resets', () => conditions()[0]?.state === 'reset', resetsAt - Date.now() + L.conditionCheckMs)
    mark = s.c.calls.length
    expect(await s.call('status.continueAll', { agent: 'shell' })).toEqual({ sessionIds: held })
    expect(inputs(mark)).toEqual(held.flatMap((id) => [[agentPty(id), 'continue'], [agentPty(id), '\r']]))
    expect(conditions(), 'the condition ends on Continue all').toEqual([])
    for (const id of held) await until(`${id}'s shell got continue`, async () => /continue/.test((await terminals.captureScreen(agentPty(id))) ?? ''))
  })
})
