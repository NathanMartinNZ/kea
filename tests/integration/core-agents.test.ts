// Agent sessions in core: tools/fake-agent `--as claude` as the `claude` on PATH, real `kea-helper hook` processes
// delivering to core's socket or spooling, the status engine fed by the agent service.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spoolPath } from '@kea/core/src/agents/spool.ts'
import { coreSocketPath } from '@kea/core/src/agents/intake.ts'
import { checkInvariants } from '@kea/core/src/platform/db/invariants.ts'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { helperBinary, until } from '../support/holders.ts'
import { repo } from './core-sessions-support.ts'
import { startAgentSessions, type AgentSessionsUnderTest } from './core-agents-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function agents(o: Parameters<typeof startAgentSessions>[0] = {}): Promise<AgentSessionsUnderTest> {
  const s = await startAgentSessions(o)
  cleanup.push(() => s.dispose())
  return s
}

function fixture(name = 'demo') {
  const r = repo(name)
  cleanup.push(() => r.dispose())
  return r
}

/** One turn: a Bash permission answered with `y`, then Stop; later lines run a short turn. */
const PERMISSION_TURN = `version: 1
steps:
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test", description: "Run tests" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test", description: "Run tests" } }
  - print: "ASKING\\r\\n"
  - wait: { answer: y }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "npm test", description: "Run tests" }, fields: { tool_response: { stdout: "${'x'.repeat(5000)}" } } }
  - transcript: { record: assistant, text: "All tests pass." }
  - hook: { event: Stop, fields: { last_assistant_message: "All tests pass." } }
  - print: "TURN-DONE\\r\\n"
onLine:
  - hook: UserPromptSubmit
  - transcript: { record: assistant, text: "ok" }
  - hook: Stop
  - print: "LINE-DONE\\r\\n"
`

/** The top-level payload keys the hooks' `--project` argument can produce, read from the launched argv's inline settings. */
function projectedKeys(argv: readonly string[]): Set<string> {
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { hooks: Record<string, { hooks: { args: string[] }[] }[]> }
  const args = Object.values(settings.hooks)[0]![0]!.hooks[0]!.args
  const p = JSON.parse(args[args.indexOf('--project') + 1]!) as { keep: string[]; count: string[]; summarise: string[] }
  return new Set([...p.keep, ...p.count, ...p.summarise].map((k) => k.split('.')[0]!))
}

describe('the claude adapter end to end (fake agent, real hooks)', () => {
  it('I-AGT-1 · a full scenario through real synchronous kea-helper hooks: phases in order, journal from hooks, envelopes carry only projected fields', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('perm.yaml', PERMISSION_TURN) })
    const v = await s.create(p.id, 'run the tests')
    expect(v.agent).toBe('claude')
    await s.until(v.id, 'blocked on the permission', (x) => x.phase === 'blocked')
    expect(s.view(v.id)!.attention).toMatchObject([{ kind: 'permission', key: 'Bash: npm test' }])
    s.type(v.id, 'y')
    await s.until(v.id, 'the turn finished', (x) => x.phase === 'ready')
    // the store shows each committed phase (a store tick may fold two); the journal has every transition, in order
    expect(s.phases(v.id)[0]).toBe('starting')
    const journal = s.c.core.db.all<{ source: string; event: string; phase_after: string }>('SELECT source, event, phase_after FROM status_events WHERE session_id = ? ORDER BY id', v.id)
    const phases = journal.map((j) => j.phase_after).filter((ph, i, a) => i === 0 || a[i - 1] !== ph)
    expect(phases).toEqual(['starting', 'working', 'blocked', 'working', 'ready'])
    // the hook-driven transitions are journaled with source `hook`; the turn's start is the status file's `busy`
    // (written ≈ 22 ms before UserPromptSubmit; a full exact source) or the hook's, whichever core reads first
    expect(journal.filter((j) => j.source === 'hook').map((j) => `${j.event}→${j.phase_after}`)).toEqual(expect.arrayContaining(['attention.permission→blocked', 'turn.finished→ready']))
    const start = journal.find((j) => j.phase_after === 'working')!
    expect(`${start.source} ${start.event}`).toMatch(/^(hook turn\.started|status-file statusFile)$/)
    // the conversation id the launch pre-assigned is the one the agent reports; the trust is confirmed by the first hook
    expect(s.view(v.id)!.agentSessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.envelopes.every((e) => e.keaSessionId === v.id && e.adapter === 'claude')).toBe(true)
    expect(s.c.core.projects.get(p.id)!.trustConfirmed).toBe(true)
    // envelopes: only what the projection names; the 5 kB tool response never reached core
    const allowed = projectedKeys(s.c.core.terminals.sessionRecords(v.id).find((x) => x.kind === 'agent')!.argv)
    for (const e of s.envelopes) for (const k of Object.keys(e.payload)) expect(allowed, `payload key ${k}`).toContain(k)
    expect(JSON.stringify(s.envelopes)).not.toContain('x'.repeat(100))
    expect(Math.max(...s.envelopes.map((e) => Buffer.byteLength(JSON.stringify(e))))).toBeLessThan(4096)
    expect(fs.existsSync(spoolPath(s.h.home, v.id))).toBe(false) // nothing spooled: the socket took every hook
    expect(fs.existsSync(coreSocketPath(s.h.home))).toBe(true)
  })
})

/** Read a fake-agent event log (FAKE_AGENT_LOG). */
function agentLog(file: string): { t: string; [k: string]: unknown }[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string })
  } catch {
    return []
  }
}

/** The agent's SessionStart reached core: it is at its prompt (or past its first steps). */
async function agentUp(s: AgentSessionsUnderTest, id: string): Promise<void> {
  await until(`session ${id}: SessionStart delivered`, () => s.envelopes.some((e) => e.keaSessionId === id && (e.payload as { hook_event_name?: string }).hook_event_name === 'SessionStart'))
}

function spoolLines(home: string, id: string): string[] {
  try {
    return fs.readFileSync(spoolPath(home, id), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const toolPair = (n: number) => `  - loop: { times: ${n}, steps: [ { hook: { event: PreToolUse, tool: Read, input: { file_path: "a.txt" } } }, { hook: { event: PostToolUse, tool: Read, input: { file_path: "a.txt" } } } ] }`

describe('hook delivery: socket, spool, order', () => {
  it('I-AGT-2 · the socket down while the agent emits: envelopes spool; the next core drains them by rename-then-read while the agent keeps emitting; the final state is right', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({
      FAKE_AGENT_SCENARIO: s.scenario(
        'spool.yaml',
        `version: 1
steps:
  - print: "READY\\r\\n"
onLine:
  - hook: UserPromptSubmit
  - transcript: { record: user, text: "{{line}}" }
${toolPair(10)}
  - wait: { answer: c }
${toolPair(20)}
  - transcript: { record: assistant, text: "done" }
  - hook: Stop
`,
      ),
    })
    const v = await s.create(p.id, '')
    await agentUp(s, v.id)
    // core's agent side goes (its socket, its watches): the helper finds no socket and spools
    s.c.core.agents.dispose()
    s.type(v.id, 'go\r')
    await until('the first half spooled', () => spoolLines(s.h.home, v.id).length >= 21)
    expect(spoolLines(s.h.home, v.id).map((l) => (JSON.parse(l) as { payload: { hook_event_name: string } }).payload.hook_event_name).slice(0, 2)).toEqual(['UserPromptSubmit', 'PreToolUse'])
    // the agent goes on emitting while core restarts: some envelopes spool, the rest reach the new socket
    s.type(v.id, 'c')
    await s.relaunch()
    await s.until(v.id, 'the turn finished', (x) => x.phase === 'ready')
    const st = s.c.core.agents.stats
    expect(st.spoolApplied).toBeGreaterThanOrEqual(21)
    expect(st.spoolSkipped).toBe(0)
    expect(fs.existsSync(spoolPath(s.h.home, v.id))).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(spoolPath(s.h.home, v.id)), 'spool.draining.ndjson'))).toBe(false)
  })

  it('I-AGT-3 · 500 hook events: none lost, arrival order is emission order, every helper delivers within the hard bound L.hookBoundMs, core applies all', async () => {
    const s = await agents({ opts: { helperPath: await helperBinary('release') } })
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('burst.yaml', `version: 1\nsteps:\n  - print: "READY\\r\\n"\nonLine:\n  - hook: UserPromptSubmit\n${toolPair(249)}\n  - hook: Stop\n`) })
    const v = await s.create(p.id, '')
    await agentUp(s, v.id)
    const from = s.envelopes.length
    s.type(v.id, 'go\r')
    await s.until(v.id, 'the burst applied', (x) => x.phase === 'ready' && s.envelopes.length - from >= 500)
    const burst = s.envelopes.slice(from)
    const arrived = s.arrivals.slice(from)
    expect(burst).toHaveLength(500)
    expect(s.c.core.agents.stats.spoolDrains).toBe(0) // none spooled: none lost on the way
    // emission order = arrival order (synchronous hooks)
    for (let i = 1; i < burst.length; i++) expect(burst[i]!.mono).toBeGreaterThan(burst[i - 1]!.mono)
    // the helper's own run, from its stamp to core reading the envelope (wall clock: the helper's `mono` is another clock):
    // each within the hard bound L.hookBoundMs, which holds under any load (past it the helper spools). The per-event
    // target is a budget for the quiet reference machine, measured by P-AGT-1 (tests/perf/core-hooks.test.ts), not
    // here, where the suite's other files run alongside
    const lat = burst.map((e, i) => arrived[i]! - e.receivedAt).sort((a, b) => a - b)
    expect(lat.at(-1)).toBeLessThan(L.hookBoundMs)
    const events = (burst.at(-1)!.mono - burst[0]!.mono) / 1e6
    console.log(`I-AGT-3: 500 events in ${events.toFixed(0)} ms; helper p50 ${lat[250]!.toFixed(2)} ms, p99 ${lat[495]!.toFixed(2)} ms, max ${lat.at(-1)!.toFixed(2)} ms`)
  })

  it('I-AGT-4 · core stalled while the agent emits: every helper returns within L.hookBoundMs (core’s answer, or the spool when none comes); afterwards every event is applied once, in order, though the lines core read late were spooled too; the live copy wins, so the turn’s finish still notifies (N2)', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    const log = path.join(s.userHome, 'agent-log.jsonl')
    s.shim({ FAKE_AGENT_LOG: log, FAKE_AGENT_SCENARIO: s.scenario('stall.yaml', `version: 1\nsteps:\n  - print: "READY\\r\\n"\nonLine:\n  - hook: UserPromptSubmit\n${toolPair(40)}\n  - hook: Stop\n`) })
    const v = await s.create(p.id, '')
    await agentUp(s, v.id)
    let stalled = false
    let posts = 0
    const notices: { k: string; sessionId?: string }[] = []
    const sub = s.c.core.status.notices.event((n) => notices.push(n as { k: string; sessionId?: string }))
    cleanup.push(() => sub.dispose())
    s.onEnvelope = (e) => {
      const name = (e.payload as { hook_event_name?: string }).hook_event_name
      if (stalled || name !== 'PostToolUse' || ++posts < 39) return
      stalled = true
      // core's thread stops (as under SIGSTOP) while the agent fires its last hooks, its Stop among them
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, L.hookBoundMs * 20)
    }
    s.type(v.id, 'go\r')
    await s.until(v.id, 'every event applied', (x) => x.phase === 'ready')
    expect(stalled).toBe(true)
    const runs = agentLog(log).filter((e) => e.t === 'hook' && ((e.runs as unknown[]) ?? []).length > 0).flatMap((e) => e.runs as { ms: number; exitCode: number }[])
    expect(runs.length).toBeGreaterThanOrEqual(82)
    expect(runs.every((x) => x.exitCode === 0)).toBe(true)
    // each run includes the hook process's own spawn (outside Kea's control): within the bound plus that
    expect(Math.max(...runs.map((x) => x.ms))).toBeLessThan(L.hookBoundMs * 2)
    // all applied: the turn's start and end are journaled in order, nothing is left in a spool
    const journal = s.c.core.db.all<{ event: string }>(`SELECT event FROM status_events WHERE session_id = ? AND source = 'hook' ORDER BY id`, v.id).map((j) => j.event)
    expect(journal.indexOf('turn.started')).toBeLessThan(journal.lastIndexOf('turn.finished'))
    expect(fs.existsSync(spoolPath(s.h.home, v.id))).toBe(false)
    // the helpers that gave up on core's answer spooled their lines, which core then also read from its backlog: each
    // envelope id applied once, as the session's recent-signal ring shows
    const st = s.c.core.agents.stats
    expect(st.spoolApplied, 'some hooks spooled during the stall').toBeGreaterThan(0)
    expect(st.duplicates, 'their late socket copies dropped').toBeGreaterThan(0)
    const ring = s.c.core.status.machine(v.id)!.ring.filter((r) => r.source === 'hook').map((r) => (r.raw as { hook_event_name?: string }).hook_event_name)
    const count = (e: string) => ring.filter((x) => x === e).length
    expect([count('UserPromptSubmit'), count('PreToolUse'), count('PostToolUse'), count('Stop')], 'each hook applied once').toEqual([1, 40, 40, 1])
    // the Stop was spooled and read late, while this core ran: applied as live, so its N2 was due (the policy then judges it)
    expect(notices.filter((n) => n.k === 'N2' && n.sessionId === v.id), 'the finish notified once').toHaveLength(1)
  })
})

describe('trust, tier 1b and tier 2', () => {
  it('I-AGT-5 · trust pending: no SessionStart in an untrusted repo → the trust question after L.trustWindowMs; SessionStart clears it and confirms the repo; a second session there never shows it', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    expect(p.trustConfirmed).toBe(false)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('trust.yaml', `version: 1\nfireSessionStart: false\nsteps:\n  - print: "TRUST?\\r\\n"\n  - wait: { answer: t }\n  - hook: SessionStart\n  - print: "TRUSTED\\r\\n"\n`) })
    const v = await s.create(p.id, '')
    const asked = await s.until(v.id, 'the trust question', (x) => x.phase === 'blocked', L.trustWindowMs * 3)
    expect(asked.attention).toMatchObject([{ kind: 'question' }])
    expect(JSON.stringify(asked.attention)).toMatch(/[Tt]rust/)
    s.type(v.id, 't')
    await s.until(v.id, 'the question cleared', (x) => x.phase !== 'blocked')
    await until('the repo’s trust recorded', () => s.c.core.projects.get(p.id)?.trustConfirmed === true)
    // a second session in the trusted repo: no trust window is started at all
    expect(s.c.core.status.resourceCounts.timers).toBe(0)
    const w = await s.create(p.id, '')
    expect(s.view(w.id)!.phase).not.toBe('blocked')
    expect(s.c.core.status.resourceCounts.timers).toBe(0)
  })

  it('I-AGT-6 · the live status file in a temp CLAUDE_CONFIG_DIR, rewritten in place: waiting adds the permission item (source status-file), busy removes it, idle with no Stop interrupts; a torn write, another session id and another pid’s file change nothing; read-only', async () => {
    const r = fixture()
    const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt6-cfg-')))
    cleanup.push(() => fs.rmSync(cfg, { recursive: true, force: true }))
    const s = await agents({ settings: { agents: { claude: { env: { CLAUDE_CONFIG_DIR: cfg } } } } })
    const p = await s.project(r.root)
    const foreign = '00000000-0000-4000-8000-000000000000'
    s.shim({
      FAKE_AGENT_SCENARIO: s.scenario(
        'status.yaml',
        `version: 1
statusFile: manual
steps:
  - hook: UserPromptSubmit
  - status: busy
  - wait: { answer: "1" }
  - status: { status: waiting, waitingFor: "permission prompt" }
  - wait: { answer: "2" }
  - status: { torn: true }
  - wait: { answer: "3" }
  - status: { sessionId: "${foreign}" }
  - status: idle
  - wait: { answer: "4" }
  - status: { sessionId: "{{sessionId}}" }
  - status: busy
  - wait: { answer: "5" }
  - status: idle
  - wait: key
`,
      ),
    })
    const v = await s.create(p.id, '')
    const pid = s.c.core.terminals.store.get(s.agentPty(v.id))!.childPid!
    const own = path.join(cfg, 'sessions', `${pid}.json`)
    await until('the status file', () => fs.existsSync(own))
    const ino = fs.statSync(own).ino
    const journal = () => s.c.core.db.all<{ event: string; phase_after: string }>(`SELECT event, phase_after FROM status_events WHERE session_id = ? AND source = 'status-file' ORDER BY id`, v.id)
    s.type(v.id, '1')
    await s.until(v.id, 'the permission item from the file', (x) => x.attention.some((a) => a.kind === 'permission'))
    expect(journal().at(-1)).toMatchObject({ phase_after: 'blocked' })
    const ignored = () => s.c.core.agents.ignored
    s.type(v.id, '2')
    await until('the torn write read and dropped', () => (ignored().unparsable ?? 0) >= 1)
    s.type(v.id, '3')
    await until('the other session’s write read and dropped', () => (ignored().foreignSession ?? 0) >= 1)
    // another pid's file, with this session's id: not this agent's file, never read
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(cfg, 'sessions', '99999.json'), fs.readFileSync(own, 'utf8').replace(/"status":"[a-z]+"/, '"status":"busy"').replace(foreign, s.view(v.id)!.agentSessionId!))
    expect(s.view(v.id)!.attention.some((a) => a.kind === 'permission')).toBe(true)
    s.type(v.id, '4')
    await s.until(v.id, 'the item removed by busy', (x) => !x.attention.some((a) => a.kind === 'permission'))
    // busy → idle with no Stop since the prompt: an interrupted turn (Esc before any output), from the file
    s.type(v.id, '5')
    await s.until(v.id, 'the interrupt from the file', (x) => x.phase === 'ready')
    expect(journal().map((j) => j.event)).toEqual(['statusFile', 'statusFile', 'turn.interrupted'])
    expect(fs.statSync(own).ino).toBe(ino) // in place, by the agent; Kea only reads
    expect(fs.readdirSync(cfg)).toEqual(['sessions'])
    expect(fs.readdirSync(path.join(cfg, 'sessions')).sort()).toEqual([`${pid}.json`, '99999.json'].sort())
    expect(s.c.core.agents.resourceCounts.timers).toBe(0) // no polling: watches only
    expect(s.c.core.agents.watches.size).toBeGreaterThanOrEqual(1)
  })

  it('I-AGT-11 · hook delivery impossible (core’s socket path taken by a symlink): hooks spool and are applied at the agent’s status-file changes; the turn’s status follows the live status file (permission, then ready, not an interrupt) and its title the transcript; the prompt notifies once (N1) and the finish once (N2), drained by the interrupt timer; the next core, its intake still refused, works the same way', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({
      FAKE_AGENT_SCENARIO: s.scenario(
        'fail21.yaml',
        `version: 1
steps:
  - print: "READY\\r\\n"
onLine:
  - hook: UserPromptSubmit
  - hook: { event: PreToolUse, tool: Bash, input: { command: "npm test" } }
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
  - print: "ASKING\\r\\n"
  - wait: { answer: y }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "npm test" } }
  - transcript: { record: ai-title, title: "Run the tests {{line}}" }
  - hook: Stop
  - print: "LINE-DONE\\r\\n"
`,
      ),
    })
    const v = await s.create(p.id, '')
    // the repo trusted and the transcript known (SessionStart delivered), then delivery becomes impossible
    await agentUp(s, v.id)
    await s.until(v.id, 'idle', (x) => x.phase === 'idle')
    const sock = coreSocketPath(s.h.home)
    s.c.core.agents.intake!.dispose()
    const elsewhere = path.join(s.h.home, 'not-core.sock')
    fs.symlinkSync(elsewhere, sock)
    const journal = (source?: string) =>
      s.c.core.db.all<{ event: string; phase_after: string }>(`SELECT event, phase_after FROM status_events WHERE session_id = ? ${source ? 'AND source = ?' : ''} ORDER BY id`, ...(source ? [v.id, source] : [v.id]))
    const turn = async (line: string) => {
      const delivered = s.envelopes.length
      const applied = s.c.core.agents.stats.spoolApplied
      const fileRows = journal('status-file').length
      const notices: { k: string; sessionId?: string }[] = []
      const sub = s.c.core.status.notices.event((n) => notices.push(n as { k: string; sessionId?: string }))
      s.type(v.id, `${line}\r`)
      // tier 1b: the permission prompt
      await s.until(v.id, 'blocked from the status file', (x) => x.phase === 'blocked' && x.attention.some((a) => a.kind === 'permission'))
      s.type(v.id, 'y')
      await s.until(v.id, 'ready', (x) => x.phase === 'ready')
      // the hooks spooled (none reached a socket) and each status change applied what had spooled by then
      await until('the whole turn applied from the spool', () => s.c.core.agents.stats.spoolApplied - applied === 5)
      expect(s.envelopes.length).toBe(delivered)
      expect(fs.existsSync(spoolPath(s.h.home, v.id))).toBe(false)
      // the live status file was read during the turn (its readings journaled with their own source)
      expect(journal('status-file').length).toBeGreaterThan(fileRows)
      // the Stop came from the spool after the file went idle: still a finished turn, never an interrupt
      expect(journal().some((j) => j.event === 'turn.interrupted')).toBe(false)
      // tier 2: the title the agent wrote before Stop
      await s.until(v.id, 'the title from the transcript', (x) => x.title === `Run the tests ${line}`)
      // one prompt, one N1 (the file showed it, the spooled hook named it); the Stop, drained by the interrupt timer after
      // this core started, notifies like a live one
      sub.dispose()
      const mine = (k: string) => notices.filter((n) => n.k === k && n.sessionId === v.id)
      expect(mine('N1'), 'one prompt, one N1').toHaveLength(1)
      expect(mine('N2'), 'the finish notified').toHaveLength(1)
    }
    await turn('one')
    expect(fs.existsSync(elsewhere)).toBe(false) // the helper never followed the symlink
    // exact sources were seen: not the "estimated" note, which is for terminal-activity estimates alone
    expect(s.c.core.status.why(v.id).estimated).toBe(false)
    // the next core: its intake refuses the symlink and stays down; hooks spool and are applied the same way
    await s.relaunch()
    expect(s.c.log.entries.some((e) => e.level === 'warn' && e.msg === 'hook intake refused its socket path; hooks spool')).toBe(true)
    await s.until(v.id, 'live again', (x) => x.lifecycle === 'live' && x.phase === 'ready')
    await turn('two')
    expect(fs.lstatSync(sock).isSymbolicLink()).toBe(true) // never removed or replaced: not core's
  })

  it('I-AGT-8 · the transcript watcher sees an interrupt marker appended: turn.interrupted once (source transcript); the watcher goes with the working phase', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({
      FAKE_AGENT_SCENARIO: s.scenario(
        'marker.yaml',
        `version: 1
statusFile: off
steps:
  - hook: UserPromptSubmit
  - transcript: { record: user, text: "{{prompt}}" }
  - wait: { answer: i }
  - transcript: { record: interrupt }
  - wait: key
`,
      ),
    })
    const v = await s.create(p.id, 'do a long thing')
    await s.until(v.id, 'working', (x) => x.phase === 'working')
    // one watch is the status file's (armed from launch); the second is the transcript's, while working
    await until('the transcript watched', () => s.c.core.agents.watches.size >= 2)
    s.type(v.id, 'i')
    await s.until(v.id, 'interrupted', (x) => x.phase === 'ready')
    const rows = s.c.core.db.all<{ source: string }>(`SELECT source FROM status_events WHERE session_id = ? AND event = 'turn.interrupted'`, v.id)
    expect(rows).toEqual([{ source: 'transcript' }])
    await until('the watcher disposed with the phase', () => s.c.core.agents.watches.size === 1)
  })
})

describe('what a hook may claim', () => {
  it('I-AGT-7 · a hook with a missing or garbage --session, a --home that is not a Kea home, or a stale KEA_SESSION_ID in its environment: ignored, never read from the environment, nothing breaks', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('idle.yaml', `version: 1\nsteps:\n  - print: "READY\\r\\n"\nonLine:\n  - hook: UserPromptSubmit\n  - hook: Stop\n`) })
    const v = await s.create(p.id, '')
    await agentUp(s, v.id)
    const argv = s.c.core.terminals.sessionRecords(v.id).find((x) => x.kind === 'agent')!.argv
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> }
    const hook = settings.hooks.Stop![0]!.hooks[0]!
    const project = hook.args[hook.args.indexOf('--project') + 1]!
    const notKea = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-agt7-')))
    cleanup.push(() => fs.rmSync(notKea, { recursive: true, force: true }))
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: v.agentSessionId, cwd: v.cwd, stop_hook_active: false })
    const run = (args: string[], env: Record<string, string> = {}) => {
      const res = spawnSync(hook.command, args, { input: payload, env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' })
      expect(res.status).toBe(0) // never fails the agent
      expect(res.stdout + res.stderr).toBe('') // never prints
    }
    const before = { ...s.c.core.agents.stats }
    // the bad hooks all carry a Stop: none may end a turn (the journal's other rows are flushed on the batch's own tick)
    const stops = () => s.c.core.db.get<{ n: number }>(`SELECT count(*) AS n FROM status_events WHERE session_id = ? AND event = 'turn.finished'`, v.id)!.n
    expect(stops()).toBe(0)
    run(['hook', 'claude', '--home', s.h.home, '--project', project]) // no --session
    run(['hook', 'claude', '--session', '../../etc', '--home', s.h.home, '--project', project]) // garbage
    run(['hook', 'claude', '--session', v.id, '--home', notKea, '--project', project]) // not a Kea home
    // a stale KEA_SESSION_ID naming the live session: the helper uses --session only, core gets an unknown session
    run(['hook', 'claude', '--session', '01ZZZZZZZZZZZZZZZZZZZZZZZZ', '--home', s.h.home, '--project', project], { KEA_SESSION_ID: v.id })
    await until('the unknown session’s envelope arrived', () => s.c.core.agents.stats.unknownSession > before.unknownSession)
    expect(s.c.core.agents.stats.envelopes - before.envelopes).toBe(1) // the others never reached core
    expect(fs.readdirSync(notKea)).toEqual([]) // nothing written into a directory that is not a Kea home
    expect(fs.existsSync(path.join(s.h.home, 'sessions', '01ZZZZZZZZZZZZZZZZZZZZZZZZ'))).toBe(false)
    expect(stops()).toBe(0)
    expect(s.c.core.sessions.store.get(v.id)?.phase, 'no state change').not.toBe('ready')
    // and the live session still works
    s.type(v.id, 'go\r')
    await s.until(v.id, 'a turn after the bad hooks', (x) => x.phase === 'ready')
  })
})

describe('sessions with an agent', () => {
  it('I-SES-1 · full lifecycle with fake-agent: create → live → stop → resume → archive → unarchive → delete; the database invariants hold after each step', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('life.yaml', `version: 1\nexitCostUsd: 0.25\nsteps:\n  - hook: UserPromptSubmit\n  - transcript: { record: user, text: "{{prompt}}" }\n  - transcript: { record: assistant, text: "ok" }\n  - transcript: { record: ai-title, title: "Lifecycle title" }\n  - hook: Stop\n`) })
    const ok = () => expect(checkInvariants(s.c.core.db)).toEqual([])
    const v = await s.create(p.id, 'walk the lifecycle')
    ok()
    await s.until(v.id, 'the first turn done', (x) => x.phase === 'ready')
    const conversation = s.view(v.id)!.agentSessionId
    expect(conversation).toMatch(/^[0-9a-f-]{36}$/)
    await s.call('sessions.stop', { id: v.id })
    const stopped = await s.until(v.id, 'stopped', (x) => x.lifecycle === 'detached')
    expect(stopped.endReason).toBe('stopped')
    // The cost Claude writes when it exits shows on the detached session; the title the agent gave too
    await s.until(v.id, 'cost and title after the exit', (x) => x.costUsd === 0.25 && x.title === 'Lifecycle title')
    ok()
    await s.call('sessions.resume', { id: v.id })
    const resumed = await s.until(v.id, 'resumed', (x) => x.lifecycle === 'live')
    expect(resumed.agentSessionId).toBe(conversation) // the same conversation
    const argv = s.c.core.terminals.sessionRecords(v.id).find((x) => x.kind === 'agent' && x.state === 'running')!.argv
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual(['--resume', conversation])
    expect(argv).not.toContain('--')
    ok()
    await s.call('sessions.stop', { id: v.id })
    await s.until(v.id, 'stopped again', (x) => x.lifecycle === 'detached')
    expect(await s.call('sessions.archive', { id: v.id, confirmed: true })).toMatchObject({ archived: true })
    ok()
    await s.call('sessions.unarchive', { id: v.id })
    await s.until(v.id, 'unarchived', (x) => x.lifecycle === 'detached')
    ok()
    expect(await s.call('sessions.delete', { id: v.id, deleteBranch: true })).toMatchObject({ deleted: true })
    ok()
  })

  it('I-PRJ-4 · a full lifecycle in a sandboxed $HOME: the main checkout stays clean with no new files, and the agent config dir holds only the agent’s own session files', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('prj4.yaml', `version: 1\nexitCostUsd: 0.01\nsteps:\n  - hook: UserPromptSubmit\n  - transcript: { record: user, text: "{{prompt}}" }\n  - transcript: { record: assistant, text: "ok" }\n  - hook: Stop\n`) })
    const worktree = await s.create(p.id, 'in a worktree')
    const inPlace = await s.create(p.id, 'in place', { isolation: 'inplace' })
    for (const v of [worktree, inPlace]) await s.until(v.id, 'turn done', (x) => x.phase === 'ready')
    for (const v of [worktree, inPlace]) {
      await s.call('sessions.stop', { id: v.id })
      await s.until(v.id, 'stopped', (x) => x.lifecycle === 'detached')
      await s.call('sessions.delete', { id: v.id, deleteBranch: true })
    }
    // Kea wrote nothing into the main checkout: no hooks file, no settings, no new files (the hooks are inline)
    const status = execFileSync('git', ['-C', r.root, 'status', '--porcelain', '--untracked-files=all', '--ignored'], { encoding: 'utf8' })
    expect(status.split('\n').filter(Boolean)).toEqual([])
    // the agent's config dir: its transcripts (and no live status file once it exited); Kea added nothing of its own
    const claudeDir = path.join(s.userHome, '.claude')
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (f: string) => files.push(path.relative(claudeDir, f)))(path.join(d, e.name))
    }
    walk(claudeDir)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(f).toMatch(/^projects\/[^/]+\/[0-9a-f-]{36}\.jsonl$/)
  })
})
