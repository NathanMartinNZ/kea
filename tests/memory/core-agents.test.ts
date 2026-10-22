// The agent side of core under volume: hook socket connections, the spool per session and transcript watchers. Core
// in-process (tests/integration/core-agents-support.ts) with tools/fake-agent as `claude`.
//
//   L-AGT-1  envelopes through the hook socket as the helper writes them (one connection each; the bulk built by the
//            test with the adapter's projection, the 5 MB payloads through the real `kea-helper hook`), the connection
//            cap crossed once: every envelope within its cap, the journal trimmed, the WAL within its limit, heap flat
//   L-AGT-2  core's socket gone while the fake agent emits through real hooks: the spool crosses both caps, keeps every
//            state-changing event to the hard cap, and the next core drains and removes it
//   L-AGT-3  300 MB transcripts (sparse files): reconcile reads at most L.transcriptTailBytes of each, and transcript
//            watchers exist only for the sessions that are working
//
// Counts are the smallest that cross every cap involved at least once.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { coreSocketPath } from '@kea/core/src/agents/intake.ts'
import { spoolPath } from '@kea/core/src/agents/spool.ts'
import { HOOK_ACK_BYTE, L, type SessionView } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { CRITICAL_EVENTS } from '../../packages/adapters/src/claude/contract.ts'
import { projection } from '../../packages/adapters/src/claude/launch.ts'
import { projectPayload } from '../../packages/adapters/src/kit/projection.ts'
import { until } from '../support/holders.ts'
import { repo } from '../integration/core-sessions-support.ts'
import { readStream } from '../integration/core-support.ts'
import { startAgentSessions, type AgentSessionsUnderTest } from '../integration/core-agents-support.ts'
import { heapUsed, leakCycles } from './ptyhost-leak.ts'

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

async function agentUp(s: AgentSessionsUnderTest, id: string): Promise<void> {
  await until(`session ${id}: SessionStart delivered`, () => s.envelopes.some((e) => e.keaSessionId === id && (e.payload as { hook_event_name?: string }).hook_event_name === 'SessionStart'))
}

/** A hook's command line, from the launched argv's inline settings. */
function hookCommand(s: AgentSessionsUnderTest, id: string): { command: string; args: string[] } {
  const argv = s.c.core.terminals.sessionRecords(id).find((x) => x.kind === 'agent')!.argv
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> }
  return settings.hooks.Stop![0]!.hooks[0]!
}

/**
 * Write one envelope line per connection, as kea-helper does, at most `parallel` at a time, and read core's answer as
 * the helper does (one HOOK_ACK_BYTE per line; an unread answer would also keep the connection from closing).
 */
async function sendEnvelopes(sock: string, lines: readonly string[], parallel = 32): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < lines.length) {
      const line = lines[next++]!
      await new Promise<void>((resolve, reject) => {
        const answer: Buffer[] = []
        const c = net.connect(sock, () => c.end(`${line}\n`))
        c.on('data', (b: Buffer) => answer.push(b))
        c.on('close', () => (Buffer.concat(answer).equals(Buffer.from([HOOK_ACK_BYTE])) ? resolve() : reject(new Error(`core answered ${JSON.stringify(Buffer.concat(answer).toString('hex'))}`))))
        c.on('error', reject)
      })
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
}

const IDLE = `version: 1
steps:
  - print: "READY\\r\\n"
`

describe('the agent side of core under volume', () => {
  it('L-AGT-1 · hook envelopes in volume, some from 5 MB payloads, the connection cap crossed: every envelope within its cap, the journal trimmed per session, the WAL within its limit, core heap within budget', async () => {
    const SESSIONS = 4
    const CYCLES = 40
    /** Envelopes per cycle: whole turns of ten (prompt, four tool pairs, stop) per session. */
    const TURNS = 8
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({ FAKE_AGENT_SCENARIO: s.scenario('idle.yaml', IDLE) })
    const views: SessionView[] = []
    for (let i = 0; i < SESSIONS; i++) views.push(await s.create(p.id, ''))
    for (const v of views) await agentUp(s, v.id)
    const sock = coreSocketPath(s.h.home)
    const proj = projection()
    const envelope = (v: SessionView, payload: Record<string, unknown>) =>
      JSON.stringify({ keaSessionId: v.id, adapter: 'claude', mono: Number(process.hrtime.bigint()), receivedAt: Date.now(), payload: projectPayload({ session_id: v.agentSessionId, cwd: v.cwd, transcript_path: '', permission_mode: 'default', ...payload }, proj) })
    const turn = (v: SessionView, n: number): string[] => [
      envelope(v, { hook_event_name: 'UserPromptSubmit', prompt: `prompt ${n} ${'p'.repeat(n % 400)}` }),
      ...Array.from({ length: 4 }, (_, k) => [
        envelope(v, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_${n}_${k}`, tool_input: { command: `npm test -- ${n}.${k}` } }),
        envelope(v, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: `toolu_${n}_${k}`, tool_input: { command: `npm test -- ${n}.${k}` }, tool_response: { stdout: 'ok' } }),
      ]).flat(),
      envelope(v, { hook_event_name: 'Stop', last_assistant_message: `done ${n}`, background_tasks: [], session_crons: [] }),
    ]
    const hook = hookCommand(s, views[0]!.id)
    const big = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: views[0]!.agentSessionId, cwd: views[0]!.cwd, tool_name: 'Write', tool_use_id: 'toolu_big', tool_input: { file_path: 'big.txt', content: 'x'.repeat(5 * 1024 * 1024) }, tool_response: { ok: true } })
    let envMax = 0
    s.onEnvelope = (e) => {
      envMax = Math.max(envMax, Buffer.byteLength(JSON.stringify(e)))
    }
    let sent = 0
    let walMax = 0
    let n = 0
    const growth = await leakCycles({
      total: CYCLES,
      async cycle(i) {
        const lines = views.flatMap((v) => Array.from({ length: TURNS }, () => turn(v, n++)).flat())
        const before = s.c.core.agents.stats.envelopes
        await sendEnvelopes(sock, lines)
        // one 5 MB payload per cycle, through the real helper: projected within the envelope cap
        const res = spawnSync(hook.command, hook.args, { input: big, env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1 << 20 })
        expect(res.status).toBe(0)
        sent += lines.length + 1
        await until(`cycle ${i}: every envelope applied`, () => s.c.core.agents.stats.envelopes - before === lines.length + 1)
        walMax = Math.max(walMax, s.c.core.db.walBytes())
        // the harness's own record of envelopes is test memory, not core's
        s.envelopes.length = 0
        s.arrivals.length = 0
      },
      measure: heapUsed,
    })
    expect(sent).toBe(CYCLES * (SESSIONS * TURNS * 10 + 1))
    expect(envMax, 'every envelope within L.hookEnvelopeMaxBytes').toBeLessThanOrEqual(L.hookEnvelopeMaxBytes)
    expect(s.c.core.agents.stats.unknownSession + s.c.core.agents.stats.malformed).toBe(0)
    // the journal is trimmed to its cap per session on each write batch; every session went past it
    let rows: number[] = []
    await until(`the last batch written (rows per session: ${rows.join(', ')})`, () => {
      rows = s.c.core.db.all<{ n: number }>('SELECT count(*) AS n FROM status_events GROUP BY session_id').map((x) => x.n)
      return rows.length === SESSIONS && rows.every((x) => x === L.statusEventsPerSession)
    })
    expect(walMax, 'the WAL within its checkpoint limit').toBeLessThanOrEqual(L.dbWalTruncateBytes)
    expect(growth.ok, `core heap growth ${JSON.stringify({ slope: growth.slope, absolute: growth.absolute })}`).toBe(true)

    // the connection cap, crossed once: connections that write nothing are held to the cap, the rest refused
    const intake = s.c.core.agents.intake!
    const idle: net.Socket[] = []
    let closedByCore = 0
    cleanup.push(() => idle.forEach((c) => c.destroy()))
    for (let i = 0; i < L.hookSocketConnectionsMax + 8; i++) idle.push(net.connect(sock).on('error', () => undefined).on('close', () => closedByCore++))
    // the server closes what is over the cap at once (a real helper would then spool)
    await until(`the cap reached and the rest closed (${intake.connections} held, ${closedByCore} closed)`, () => intake.connections === L.hookSocketConnectionsMax && closedByCore === 8)
    for (const c of idle) c.destroy()
    await until('the connections gone', () => intake.connections === 0)
    expect(s.c.core.agents.resourceCounts.connections).toBe(0)
  })

  it('L-AGT-2 · core’s socket gone while the fake agent emits through real hooks: the spool crosses its soft cap (then only state-changing events) and stops at its hard cap; the next core drains it (rename, then read) and removes it', async () => {
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    // each envelope near 3 KB (four summarised fields of 300 two-byte characters): the caps arrive in a few thousand hooks
    const wide = (k: string) => `{ command: "${k}${'é'.repeat(400)}", file_path: "${'é'.repeat(400)}", url: "${'é'.repeat(400)}", pattern: "${'é'.repeat(400)}" }`
    const TURNS = 1600
    s.shim({
      FAKE_AGENT_SCENARIO: s.scenario(
        'flood.yaml',
        `version: 1
steps:
  - print: "READY\\r\\n"
onLine:
  - loop:
      times: ${TURNS}
      steps:
        - hook: UserPromptSubmit
        - hook: { event: PreToolUse, tool: Bash, input: ${wide('a')} }
        - hook: { event: PermissionRequest, tool: Bash, input: ${wide('b')} }
        - hook: { event: PostToolUse, tool: Bash, input: ${wide('c')} }
        - hook: { event: Stop, fields: { last_assistant_message: "${'é'.repeat(400)}" } }
  - transcript: { record: assistant, text: "flood done" }
  - print: "FLOOD-DONE\\r\\n"
`,
      ),
    })
    const v = await s.create(p.id, '')
    await agentUp(s, v.id)
    // Kea's agent side gone (its socket with it): every hook spools
    s.c.core.agents.dispose()
    const out = readStream(s.h, s.agentPty(v.id))
    cleanup.push(() => out.close())
    s.type(v.id, 'go\r')
    await until('the agent finished its flood', () => out.text().includes('FLOOD-DONE'), 600_000)
    const file = spoolPath(s.h.home, v.id)
    const size = fs.statSync(file).size
    expect(size, 'never past the hard cap (plus the envelope that crossed it)').toBeLessThanOrEqual(L.spoolHardBytes + L.hookEnvelopeMaxBytes)
    expect(size, 'the hard cap was reached').toBeGreaterThan(L.spoolHardBytes - L.hookEnvelopeMaxBytes)
    // past the soft cap only state-changing events were appended
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    let bytes = 0
    let pastSoft = 0
    for (const l of lines) {
      const event = (JSON.parse(l) as { payload: { hook_event_name: string } }).payload.hook_event_name
      if (bytes >= L.spoolSoftBytes) {
        pastSoft++
        expect(CRITICAL_EVENTS, `${event} appended past the soft cap`).toContain(event)
      }
      bytes += Buffer.byteLength(l) + 1
    }
    expect(pastSoft).toBeGreaterThan(0)
    expect(lines.length, 'some events were not appended (past the hard cap, or non-critical past the soft cap)').toBeLessThan(TURNS * 5)
    // the next core drains it at launch, applies every line, removes it; the transcript reconcile covers the rest
    await s.relaunch()
    await until('the spool drained', () => !fs.existsSync(file))
    expect(fs.existsSync(path.join(path.dirname(file), 'spool.draining.ndjson'))).toBe(false)
    expect(s.c.core.agents.stats.spoolApplied).toBe(lines.length)
    expect(s.c.core.agents.stats.spoolSkipped).toBe(0)
    await s.until(v.id, 'ready after the drain and the reconcile', (x) => x.phase === 'ready')
  })

  it('L-AGT-3 · sessions with 300 MB transcripts: reconcile reads at most L.transcriptTailBytes of each; transcript watchers exist only for working sessions, none when all are idle', async () => {
    const SESSIONS = 3
    const s = await agents()
    const r = fixture()
    const p = await s.project(r.root)
    s.shim({
      FAKE_AGENT_SCENARIO: s.scenario(
        'turns.yaml',
        `version: 1
steps:
  - transcript: { record: user, text: "hello" }
  - print: "READY\\r\\n"
onLine:
  - hook: UserPromptSubmit
  - transcript: { record: user, text: "{{line}}" }
  - print: "WORKING\\r\\n"
  - wait: key
  - transcript: { record: assistant, text: "done" }
  - hook: Stop
  - print: "TURN-DONE\\r\\n"
`,
      ),
    })
    const views: SessionView[] = []
    for (let i = 0; i < SESSIONS; i++) views.push(await s.create(p.id, ''))
    for (const v of views) await agentUp(s, v.id)
    const transcripts = views.map((v) => {
      const start = s.envelopes.find((e) => e.keaSessionId === v.id && (e.payload as { hook_event_name?: string }).hook_event_name === 'SessionStart')!
      return (start.payload as { transcript_path: string }).transcript_path
    })
    for (const t of transcripts) await until(`${t} written`, () => fs.existsSync(t))
    // 300 MB each, sparse: what reconcile needs is in the last lines
    for (const t of transcripts) {
      fs.truncateSync(t, 300 * 1024 * 1024)
      fs.appendFileSync(t, `\n${JSON.stringify({ type: 'ai-title', aiTitle: 'From the tail', sessionId: 's' })}\n${JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}\n`)
    }
    const counts = () => s.c.core.agents.resourceCounts
    await until('all idle: no transcript watcher', () => views.every((v) => s.view(v.id)!.phase === 'idle') && counts().transcriptWatches === 0)
    // two sessions working: two watchers, each following from the end of its 300 MB file
    for (const v of views.slice(0, 2)) s.type(v.id, 'work\r')
    for (const v of views.slice(0, 2)) await s.until(v.id, 'working', (x) => x.phase === 'working')
    expect(counts().transcriptWatches).toBe(2)
    for (const v of views.slice(0, 2)) s.type(v.id, 'k')
    for (const v of views.slice(0, 2)) await s.until(v.id, 'ready', (x) => x.phase === 'ready')
    expect(counts().transcriptWatches).toBe(0)

    // a relaunch reconciles each restored session from its transcript's tail: never more than the cap is read
    const read = new Map<string, number>()
    const fdPath = new Map<number, string>()
    const { openSync, readSync, closeSync } = fs
    fs.openSync = ((f: fs.PathLike, ...rest: unknown[]) => {
      const fd = (openSync as (...a: unknown[]) => number)(f, ...rest)
      if (transcripts.includes(String(f))) fdPath.set(fd, String(f))
      return fd
    }) as typeof fs.openSync
    fs.readSync = ((fd: number, ...rest: unknown[]) => {
      const n = (readSync as (...a: unknown[]) => number)(fd, ...rest)
      const f = fdPath.get(fd)
      if (f) read.set(f, (read.get(f) ?? 0) + n)
      return n
    }) as typeof fs.readSync
    fs.closeSync = ((fd: number) => {
      fdPath.delete(fd)
      closeSync(fd)
    }) as typeof fs.closeSync
    cleanup.push(() => {
      fs.openSync = openSync
      fs.readSync = readSync
      fs.closeSync = closeSync
    })
    const heap0 = await heapUsed()
    await s.relaunch()
    for (const v of views) await s.until(v.id, 'reconciled: the title from the tail', (x) => x.title === 'From the tail')
    for (const t of transcripts) expect(read.get(t) ?? 0, `bytes read of ${path.basename(t)}`).toBeLessThanOrEqual(L.transcriptTailBytes)
    expect([...read.values()].every((n) => n > 0), 'each transcript was reconciled').toBe(true)
    expect((await heapUsed()) - heap0, 'no transcript held in memory').toBeLessThan(3 * L.transcriptTailBytes * 8)
    expect(counts().transcriptWatches).toBe(0)
  })
})

