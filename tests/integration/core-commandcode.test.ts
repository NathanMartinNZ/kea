// Command Code sessions in core: tools/fake-agent `--as commandcode` as the `cmd` on PATH, started with the argv the
// adapter builds, so it loads the copy of kea-mod.ts core wrote under KEA_HOME and the mod runs real
// `kea-helper hook commandcode` processes into core's intake. Reconcile reads transcripts recorded on the real CLI
// (fixtures/transcripts/commandcode/).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spoolPath } from '@kea/core/src/agents/spool.ts'
import { GATES, MOD_FILE } from '../../packages/adapters/src/commandcode/contract.ts'
import { projection } from '../../packages/adapters/src/commandcode/launch.ts'
import { L, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { writeAgentShim } from '../../tools/fake-agent/src/index.ts'
import { commandCodeSlug } from '../../tools/fake-agent/src/transcript.ts'
import { until } from '../support/holders.ts'
import { repo } from './core-sessions-support.ts'
import { startAgentSessions, type AgentSessionsUnderTest } from './core-agents-support.ts'

const TRANSCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/transcripts/commandcode', GATES.mods)

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

interface CommandCodeUnderTest extends AgentSessionsUnderTest {
  /** (Re)write the `cmd` stand-in: a scenario, a version. Its home is the session environment's sandboxed HOME. */
  cmd(env?: Record<string, string>): void
  start(projectId: string, prompt: string, more?: Record<string, unknown>): Promise<SessionView>
  /** The event names of the envelopes core received for a session, in order. */
  events(id: string): string[]
  /** The running agent's argv. */
  argv(id: string): string[]
}

async function commandCode(): Promise<CommandCodeUnderTest> {
  const base = await startAgentSessions()
  cleanup.push(() => base.dispose())
  const s: CommandCodeUnderTest = Object.assign(base, {
    cmd(env: Record<string, string> = {}) {
      writeAgentShim(base.binDir, 'commandcode', { env: { FAKE_AGENT_HOME: base.userHome, ...env } })
    },
    start: (projectId: string, prompt: string, more: Record<string, unknown> = {}) => base.create(projectId, prompt, { agent: 'commandcode', ...more }),
    events: (id: string) => base.envelopes.filter((e) => e.keaSessionId === id).map((e) => String((e.payload as { type?: unknown }).type)),
    argv: (id: string) => base.c.core.terminals.sessionRecords(id).filter((x) => x.kind === 'agent' && x.state === 'running').at(-1)!.argv,
  })
  s.cmd()
  return s
}

function fixture(name = 'demo') {
  const r = repo(name)
  cleanup.push(() => r.dispose())
  return r
}

/**
 * A turn in the order 1.79.2 emits it: a tool that needs no answer, then one the person is asked about (queued,
 * and nothing runs until `y`), which fails. A typed line runs another turn, chosen by the key that follows it:
 *   1   one call, refused with `n`
 *   3   a batch of three, as the CLI handles one (every call queued first, then asked about in order with no event for
 *       a prompt): the read needs no answer, the command is refused with `n` (told at once), the write is asked about
 *       next and allowed with `y` (no event); a refusal ends the batch, so nothing of it runs and the run ends
 */
const TURNS = `version: 1
steps:
  - hook: run_start
  - hook: turn_start
  - hook: message_start
  - hook: model_request_start
  - hook: model_request_end
  - hook: message_end
  - hook: { event: tool_queued, tool: read_file, input: { file_path: "{{cwd}}/README.md" } }
  - hook: { event: tool_running, tool: read_file }
  - hook: { event: tool_completed, tool: read_file, fields: { result: [ { type: text, text: "${'x'.repeat(5000)}" } ] } }
  - hook: { event: tool_queued, tool: shell_command, input: { command: "npm test", description: "Run the tests" } }
  - print: "ASKING\\r\\n"
  - wait: { answer: y }
  - hook: { event: tool_running, tool: shell_command }
  - hook: { event: tool_errored, tool: shell_command, fields: { error: "Command exited with code 1" } }
  - hook: turn_end
  - transcript: { record: user, text: "{{prompt}}" }
  - transcript: { record: assistant, text: "The tests fail." }
  - hook: { event: run_end, fields: { result: { finalText: "The tests fail." } } }
  - hook: { event: session_titled, fields: { title: "Run the tests" } }
  - transcript: { record: title, title: "Run the tests" }
  - print: "TURN-DONE\\r\\n"
onLine:
  - hook: run_start
  - choose:
      "1":
        - hook: { event: tool_queued, tool: write_file, input: { file_path: "{{cwd}}/out.txt", content: "secret-content" } }
        - print: "ASKING-AGAIN\\r\\n"
        - wait: { answer: n }
        - hook: { event: tool_denied, tool: write_file }
      "3":
        - hook: { event: tool_queued, tool: read_file, input: { file_path: "{{cwd}}/README.md" } }
        - hook: { event: tool_queued, tool: shell_command, input: { command: "npm run build", description: "Build it" } }
        - hook: { event: tool_queued, tool: write_file, input: { file_path: "{{cwd}}/notes.txt", content: "secret-content" } }
        - print: "ASKING-BATCH\\r\\n"
        - wait: { answer: n }
        - hook: { event: tool_denied, tool: shell_command }
        - print: "ASKING-NEXT\\r\\n"
        - wait: { answer: y }
  - hook: { event: run_end, fields: { result: { stopReason: permission_denied, finalText: "" } } }
  - print: "LINE-DONE\\r\\n"
`

describe('the commandcode adapter end to end (fake agent, the real kea-mod.ts and kea-helper)', () => {
  it('I-AGT-9 · fake-agent --as commandcode loads the kea-mod.ts core wrote under KEA_HOME: its events arrive through kea-helper in order and projected; a tool queued with nothing run for L.ccPermissionQueuedMs is the permission item, a tool run at once is not; the session id and transcript come from the mod; resume passes everything again; a session used in place is never started with --trust', async () => {
    const s = await commandCode()
    const r = fixture()
    const p = await s.project(r.root)
    s.cmd({ FAKE_AGENT_SCENARIO: s.scenario('turns.yaml', TURNS) })
    const v = await s.start(p.id, 'run the tests', { config: { model: 'acme/model-1', effort: 'high' } })
    expect(v.agent).toBe('commandcode')
    // the creation log's first line names the agent the session is for
    const logged = (await s.call<{ text: string }>('sessions.creationLog', { id: v.id })).text.split('\n')[0]!
    expect(logged).toMatch(/ create worktree \S+ on kea\/run-tests \(agent commandcode\)$/)

    // the launch: the mod from a folder of Kea's own, its one option, the prompt after `--`; no session id of Kea's
    const argv = s.argv(v.id)
    const mod = argv[argv.indexOf('--mod') + 1]!
    expect(mod.startsWith(path.join(s.h.home, 'bin', 'agents', 'commandcode-'))).toBe(true)
    expect(path.basename(mod)).toBe(MOD_FILE)
    expect(fs.readFileSync(mod, 'utf8')).toBe(fs.readFileSync(fileURLToPath(new URL('../../packages/adapters/src/commandcode/kea-mod.ts', import.meta.url)), 'utf8'))
    expect(argv.slice(1, 5)).toEqual(['--model', 'acme/model-1', '--effort', 'high'])
    expect(argv.slice(-3)).toEqual(['--trust', '--', 'run the tests'])
    expect(argv[argv.indexOf('--mod-option') + 1]).toMatch(/^kea=[A-Za-z0-9_-]+$/)

    // the read ran at once: no permission item for it. The command is queued and nothing runs: after
    // L.ccPermissionQueuedMs the mod says so, and the item names that call
    const asked = await s.until(v.id, 'blocked on the permission', (x) => x.phase === 'blocked', L.ccPermissionQueuedMs * 3)
    expect(asked.attention).toMatchObject([{ kind: 'permission', key: 'toolu_fake_0002', summary: 'npm test', source: 'hook' }])
    const journal = () => s.c.core.db.all<{ source: string; event: string; phase_after: string; summary: string | null }>('SELECT source, event, phase_after, summary FROM status_events WHERE session_id = ? ORDER BY id', v.id)
    const phases = () =>
      journal()
        .map((j) => j.phase_after)
        .filter((ph, i, a) => i === 0 || a[i - 1] !== ph)
    expect(phases()).toEqual(['starting', 'working', 'blocked'])
    // the conversation id is the agent's own, learned from the mod's first event (Kea passed none)
    const conversation = asked.agentSessionId!
    expect(conversation).toMatch(/^[0-9a-f-]{36}$/)
    expect(argv).not.toContain(conversation)
    // the repo's flag is Claude Code's answer (kept per repository): a Command Code event says nothing about it (U-ST-22)
    expect(s.c.core.projects.get(p.id)!.trustConfirmed).toBe(false)

    s.type(v.id, 'y')
    const done = await s.until(v.id, 'the turn finished', (x) => x.phase === 'ready' && x.title === 'Run the tests')
    expect(done.attention).toEqual([])
    expect(done.titleSource).toBe('agent')
    expect(done.model).toBe('acme/model-1')
    expect(phases()).toEqual(['starting', 'working', 'blocked', 'working', 'ready'])
    expect(journal().filter((j) => j.source === 'hook').map((j) => `${j.event}→${j.phase_after}`)).toEqual(expect.arrayContaining(['turn.started→working', 'attention.permission→blocked', 'attention.cleared→working', 'turn.finished→ready']))
    // what core received, in emission order: the mod keeps `tool_queued` and the events Kea has no use for to itself
    expect(s.events(v.id)).toEqual(['session_start', 'run_start', 'model_request_start', 'tool_running', 'tool_completed', 'kea_tool_waiting', 'tool_running', 'tool_errored', 'run_end', 'session_titled'])
    expect(s.envelopes.every((e) => e.keaSessionId === v.id && e.adapter === 'commandcode')).toBe(true)
    // envelopes: only what the projection names; neither the 5 kB tool result nor the conversation in `run_end` reached core
    const pr = projection()
    const allowed = new Set([...pr.keep, ...pr.summarise].map((k) => k.split('.')[0]!))
    for (const e of s.envelopes) for (const k of Object.keys(e.payload)) expect(allowed, `payload key ${k}`).toContain(k)
    expect(JSON.stringify(s.envelopes)).not.toContain('x'.repeat(100))
    expect(JSON.stringify(s.envelopes)).not.toContain('nextState')
    expect(Math.max(...s.envelopes.map((e) => Buffer.byteLength(JSON.stringify(e))))).toBeLessThan(4096)
    expect(fs.existsSync(spoolPath(s.h.home, v.id))).toBe(false) // nothing spooled: the socket took every event
    // the transcript the mod found once the turn was committed: the agent's own file, stored for reconcile
    const transcript = path.join(s.userHome, '.commandcode', 'projects', commandCodeSlug(done.cwd), `${conversation}.jsonl`)
    await until('the transcript path stored', () => s.c.core.db.get<{ t: string | null }>('SELECT transcript_path AS t FROM sessions WHERE id = ?', v.id)?.t === transcript)

    // a second turn whose tool is refused before the wait is over: never blocked, and the refusal ends the turn
    const before = journal().length
    s.type(v.id, 'write it\r')
    await until('the write is queued', () => s.c.core.terminals.sessionRecords(v.id).length > 0 && s.events(v.id).filter((e) => e === 'run_start').length === 2)
    s.type(v.id, '1n')
    await until('the refusal ended the turn', () => s.events(v.id).at(-1) === 'run_end' && s.events(v.id).at(-2) === 'tool_denied')
    await s.until(v.id, 'ready after the refusal', (x) => x.phase === 'ready')
    expect(journal().slice(before).map((j) => j.phase_after)).not.toContain('blocked')

    // a third turn, a batch of three: the command is asked about (the read before it needs no answer); refused, and the
    // write's prompt is up next, of which the CLI says nothing. The item moves to the write at once and the session
    // stays blocked as long as a prompt is on screen, never "working" before the write is answered
    s.type(v.id, 'build and note it\r')
    await until('the third run started', () => s.events(v.id).filter((e) => e === 'run_start').length === 3)
    s.type(v.id, '3')
    const first = await s.until(v.id, 'blocked on the command', (x) => x.phase === 'blocked', L.ccPermissionQueuedMs * 3)
    expect(first.attention).toMatchObject([{ kind: 'permission', summary: 'npm run build', source: 'hook' }])
    s.type(v.id, 'n')
    const moved = await s.until(v.id, 'the item is the write’s', (x) => x.attention.length === 1 && x.attention[0]!.summary === path.join(x.cwd, 'notes.txt'))
    expect(moved.phase).toBe('blocked')
    await until('the refusal arrived', () => s.events(v.id).at(-1) === 'tool_denied')
    expect(s.events(v.id).slice(-2)).toEqual(['kea_tool_waiting', 'tool_denied'])
    expect(s.view(v.id)).toMatchObject({ phase: 'blocked', attention: [{ kind: 'permission', key: moved.attention[0]!.key }] })
    // the write is allowed: no event for that, and the refusal ended the batch, so the run ends without a tool run
    s.type(v.id, 'y')
    await until('the batch ended the run', () => s.events(v.id).at(-1) === 'run_end')
    const ready = await s.until(v.id, 'ready after the batch', (x) => x.phase === 'ready')
    expect(ready.attention).toEqual([])
    // the journal of that turn: blocked from the first prompt until the run's end cleared the last item
    const turns = () => journal().map((j) => `${j.event}→${j.phase_after}`)
    await until('the third turn is in the journal (it is written in batches)', () => turns().filter((x) => x === 'turn.finished→ready').length === 3)
    const rows = turns()
    expect(rows.slice(rows.lastIndexOf('turn.started→working'))).toEqual(['turn.started→working', 'attention.permission→blocked', 'attention.permission→blocked', 'attention.cleared→blocked', 'attention.cleared→working', 'turn.finished→ready'])
    expect(s.events(v.id).slice(s.events(v.id).lastIndexOf('run_start'))).toEqual(['run_start', 'kea_tool_waiting', 'kea_tool_waiting', 'tool_denied', 'run_end'])
    expect(JSON.stringify(s.envelopes)).not.toContain('secret-content') // a tool's input is reduced to its path

    // resume: the same conversation by its id, the knobs, the mod and its option again; the mod reports the resume
    await s.call('sessions.stop', { id: v.id })
    await s.until(v.id, 'stopped', (x) => x.lifecycle === 'detached')
    await s.call('sessions.resume', { id: v.id })
    const resumed = await s.until(v.id, 'resumed', (x) => x.lifecycle === 'live')
    expect(resumed.agentSessionId).toBe(conversation)
    const again = s.argv(v.id)
    expect(again.slice(1, 7)).toEqual(['--resume', conversation, '--model', 'acme/model-1', '--effort', 'high'])
    expect(again[again.indexOf('--mod') + 1]).toBe(mod)
    expect(again).not.toContain('--')
    await until('the resumed agent’s start arrived', () => s.envelopes.filter((e) => (e.payload as { type?: string; source?: string }).type === 'session_start').at(-1)?.payload.source === 'resume')
    expect(s.view(v.id)!.agentSessionId).toBe(conversation)

    // a session used in place runs in the project's own folder, which is the person's to trust: no `--trust` there,
    // whatever the setting; the mod is passed as ever
    const inPlace = await s.start(p.id, 'in the checkout', { isolation: 'inplace' })
    expect(inPlace.cwd).toBe(r.root)
    expect(s.argv(inPlace.id)).not.toContain('--trust')
    expect(s.argv(inPlace.id).slice(-2)).toEqual(['--', 'in the checkout'])
    expect(s.argv(inPlace.id)).toContain('--mod')
  })

  it('I-AGT-10 · a relaunch reconciles each live Command Code session from its recorded transcript: an answered, allowed, refused or cleared turn is ready; a prompt still asking, an interrupt or a failure leaves the stored status; the title comes from the meta file (never Kea’s own name), the cost from the records when they carry one', async () => {
    const s = await commandCode()
    const r = fixture()
    const p = await s.project(r.root)
    // an agent at its prompt; `g` starts a run (the mod then finds the session's file, which is how core learns its path)
    s.cmd({ FAKE_AGENT_SCENARIO: s.scenario('idle.yaml', 'version: 1\nsteps:\n  - print: "READY\\r\\n"\n  - wait: { answer: g }\n  - hook: run_start\n  - wait: key\n') })
    const golden = JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS, 'reconcile.json'), 'utf8')) as Record<string, { phase: 'finished' | null; title?: { title: string; source: string } }>
    const states = Object.keys(golden).sort()
    expect(states).toEqual(['allowed', 'answered', 'asking', 'cleared', 'denied', 'failed', 'interrupted', 'named'])
    const PRICED = 'priced'
    let pricedAnswers = 0
    const ids = new Map<string, string>()
    const titles = new Map<string, string>()
    for (const state of [...states, PRICED]) {
      const v = await s.start(p.id, '', { isolation: 'worktree' })
      ids.set(state, v.id)
      const started = await s.until(v.id, 'the mod’s first event', (x) => x.agentSessionId !== null)
      titles.set(state, started.title)
      // the recorded files of that state, where 1.79.2 keeps a session's: beside each other, named by the session's id
      const dir = path.join(s.userHome, '.commandcode', 'projects', commandCodeSlug(started.cwd))
      fs.mkdirSync(dir, { recursive: true })
      const from = state === PRICED ? 'answered' : state
      for (const ext of ['.jsonl', '.meta.json', '.checkpoints.jsonl']) fs.copyFileSync(path.join(TRANSCRIPTS, `${from}${ext}`), path.join(dir, `${started.agentSessionId}${ext}`))
      if (state === PRICED) {
        // the recorder's model reports no cost: the same transcript with one on each answer (the field 1.79.2 writes)
        const file = path.join(dir, `${started.agentSessionId}.jsonl`)
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { message?: { role?: string }; usage?: Record<string, unknown> })
        for (const l of lines) if (l.message?.role === 'assistant') l.usage = { ...l.usage, costUsd: 0.0125 }
        fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
        pricedAnswers = lines.filter((l) => l.usage?.costUsd).length
      }
      s.type(v.id, 'g')
      await s.until(v.id, 'working', (x) => x.phase === 'working')
      await until(`${state}: the transcript path stored`, () => s.c.core.db.get<{ t: string | null }>('SELECT transcript_path AS t FROM sessions WHERE id = ?', v.id)?.t?.endsWith(`${started.agentSessionId}.jsonl`) === true)
    }

    await s.crashAndRelaunch()
    for (const state of states) {
      const id = ids.get(state)!
      const want = golden[state]!
      // the reconcile is done once its title (or, for a finished turn, its phase) shows
      const v = await s.until(id, `${state}: reconciled`, (x) => (want.title ? x.title === want.title.title : true) && (want.phase === 'finished' ? x.phase === 'ready' : true))
      expect(v.phase, state).toBe(want.phase === 'finished' ? 'ready' : 'working')
      if (want.title) expect(v.titleSource, state).toBe(want.title.source)
      else expect([v.title, v.title.startsWith('kea-')], state).toEqual([titles.get(state), false]) // `named`: Kea's own name is no title
      expect(v.costUsd, state).toBeNull()
      const last = s.c.core.db.all<{ source: string; event: string; phase_after: string }>(`SELECT source, event, phase_after FROM status_events WHERE session_id = ? AND event = 'reconcile' ORDER BY id`, id).at(-1)
      if (want.phase === 'finished') expect(last, state).toMatchObject({ phase_after: 'ready' })
    }
    const priced = await s.until(ids.get(PRICED)!, 'the cost of the priced transcript', (x) => x.costUsd !== null)
    expect(pricedAnswers).toBeGreaterThan(0)
    expect(priced.costUsd).toBeCloseTo(0.0125 * pricedAnswers, 6)
    expect(priced.phase).toBe('ready')
    // read through the adapter's readers only: no watcher is left on a Command Code session (the mod reports live)
    expect(s.c.core.agents.watches.size).toBe(0)
  })

  it('I-AGT-12 · a Command Code session reaches a permission prompt while core is down, in a project no Claude Code event ever came from: the next core applies what was spooled as it restores the session, so the row is blocked on that prompt, and the repo’s trust flag stays as it was', async () => {
    const s = await commandCode()
    const r = fixture()
    const p = await s.project(r.root)
    // `g` starts a run; `q` queues a command the person is asked about, of which the mod says nothing until
    // L.ccPermissionQueuedMs is over
    s.cmd({
      FAKE_AGENT_SCENARIO: s.scenario(
        'asked-while-down.yaml',
        'version: 1\nsteps:\n  - print: "READY\\r\\n"\n  - wait: { answer: g }\n  - hook: run_start\n  - wait: { answer: q }\n  - hook: { event: tool_queued, tool: shell_command, input: { command: "npm test", description: "Run the tests" } }\n  - wait: key\n',
      ),
    })
    const v = await s.start(p.id, '')
    await s.until(v.id, 'the mod’s first event', (x) => x.agentSessionId !== null)
    s.type(v.id, 'g')
    await s.until(v.id, 'working', (x) => x.phase === 'working')
    // the repo's flag is Claude Code's answer: this project has none, which is where the spooled events were lost
    expect(s.c.core.projects.get(p.id)!.trustConfirmed).toBe(false)

    // core's agent side goes (its socket): the helper spools what the mod reports from here on
    s.c.core.agents.dispose()
    s.type(v.id, 'q')
    const spooled = (): string[] => {
      try {
        return fs.readFileSync(spoolPath(s.h.home, v.id), 'utf8').split('\n').filter(Boolean).map((l) => String((JSON.parse(l) as { payload: { type?: unknown } }).payload.type))
      } catch {
        return []
      }
    }
    await until('the prompt’s wait spooled', () => spooled().includes('kea_tool_waiting'), L.ccPermissionQueuedMs * 3)

    await s.relaunch()
    const asked = await s.until(v.id, 'blocked on the prompt that came while core was down', (x) => x.phase === 'blocked')
    expect(asked.attention).toMatchObject([{ kind: 'permission', summary: 'npm test', source: 'hook' }])
    expect(s.c.core.agents.stats.spoolSkipped).toBe(0)
    expect(fs.existsSync(spoolPath(s.h.home, v.id))).toBe(false)
    expect(s.c.core.projects.get(p.id)!.trustConfirmed).toBe(false)
  })
})
