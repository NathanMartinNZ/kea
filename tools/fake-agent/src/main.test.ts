// main.ts as a process, over pipes: the signal wiring, exit codes and files a test sees from outside. A PTY run is not
// tested here (README "Limitations"). Never run with HOME = the real home: transcript.test.ts covers that refusal
// without risking a write into the real ~/.claude (U-FAKE-16).

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { argvHash, argvHashLine } from './argv.ts'
import { FAKE_AGENT_MAIN, fakeAgentCommand, writeAgentShim } from './index.ts'
import { claudeProjectDirName, commandCodeSlug } from './transcript.ts'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fake-agent-main-')))
const children = new Set<ChildProcessWithoutNullStreams>() // bounded: the few processes these tests start
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

// A stub hook: appends {argv, stdin} as one JSON line to the file named by its first argument.
const STUB = join(dir, 'stub-hook.mjs')
writeFileSync(
  STUB,
  `import { appendFileSync } from 'node:fs'
let input = ''
process.stdin.setEncoding('utf8').on('data', (d) => (input += d)).on('end', () => {
  appendFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), stdin: input }) + '\\n')
})
`,
)

const UUID = '6f1d1c9e-3b2a-4c5d-8e7f-0a1b2c3d4e5f'

/** The env a test gives fake-agent: no FAKE_AGENT_* leaking in from the developer's shell, HOME = a temp dir. */
function env(home: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const k of Object.keys(e)) if (k.startsWith('FAKE_AGENT_')) delete e[k]
  return e
}

interface Run {
  child: ChildProcessWithoutNullStreams
  out(): string
  err(): string
  /** Resolves once `text` has appeared on stdout. */
  waitOut(text: string): Promise<void>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function start(args: readonly string[], o: { cwd: string; home: string }): Run {
  const child = spawn(process.execPath, [FAKE_AGENT_MAIN, ...args], { cwd: o.cwd, env: env(o.home), stdio: 'pipe' })
  children.add(child)
  let out = ''
  let err = ''
  const waiters: { text: string; resolve: () => void }[] = []
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    out += d
    for (const w of [...waiters]) {
      if (out.includes(w.text)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve()
      }
    }
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
  return {
    child,
    out: () => out,
    err: () => err,
    waitOut: (text) =>
      new Promise<void>((resolve, reject) => {
        if (out.includes(text)) return resolve()
        waiters.push({ text, resolve })
        void exited.then(() => reject(new Error(`exited before "${text}" appeared; stdout: ${JSON.stringify(out)}; stderr: ${err}`)))
      }),
    exited,
  }
}

const jsonl = <T,>(file: string): T[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as T)

function settings(out: string, events: readonly string[]): string {
  const hook = { type: 'command', command: process.execPath, args: [STUB, out, 'hook', 'claude', '--session', 'k1'], timeout: 5 }
  return JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [hook] }]])) })
}

function workspace(name: string): { cwd: string; home: string; fakeHome: string; file(n: string, text?: string): string } {
  const root = join(dir, name)
  const cwd = join(root, 'repo')
  const home = join(root, 'home')
  const fakeHome = join(root, 'fake-home')
  for (const d of [cwd, home]) mkdirSync(d, { recursive: true })
  return {
    cwd,
    home,
    fakeHome,
    file: (n, text) => {
      const p = join(root, n)
      if (text !== undefined) writeFileSync(p, text)
      return p
    },
  }
}

describe('fake-agent main over pipes', () => {
  it('U-FAKE-25 · --as claude: SessionStart at startup, the argv hash line, transcript records under --fake-home, SIGTERM fires SessionEnd then exits 143', async () => {
    const w = workspace('u25')
    const hooksOut = w.file('hooks.jsonl')
    const log = w.file('log.jsonl')
    const scenario = w.file(
      's.yaml',
      `version: 1
exitCostUsd: 0.12
steps:
  - argvHash
  - hook: UserPromptSubmit
  - transcript: { record: user, text: "{{prompt}}" }
  - transcript: { record: ai-title, title: "Over pipes" }
  - file: { op: write, path: out.txt, content: "{{sessionId}}" }
  - print: "READY\\r\\n"
  - wait: line
  - print: never
`,
    )
    const agentArgs = ['--session-id', UUID, '--model', 'opus', '--permission-mode', 'acceptEdits', '--settings', settings(hooksOut, ['SessionStart', 'UserPromptSubmit', 'SessionEnd']), '--verbose', '--', 'hello pipes']
    const cmd = fakeAgentCommand('claude', agentArgs, { scenario, fakeHome: w.fakeHome, log })
    expect(cmd.args[0]).toBe(FAKE_AGENT_MAIN)
    const run = start(cmd.args.slice(1), w)
    await run.waitOut('READY')
    expect(run.out()).toContain(`${argvHashLine(argvHash(agentArgs))}\r\n`)
    // synchronous hooks: both records are on disk before the step after them ran
    const before = jsonl<{ argv: string[]; stdin: string }>(hooksOut)
    expect(before.map((r) => (JSON.parse(r.stdin) as { hook_event_name: string }).hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit'])
    expect(before[0]?.argv).toEqual(['hook', 'claude', '--session', 'k1'])
    expect(JSON.parse(before[1]?.stdin ?? '{}')).toMatchObject({ session_id: UUID, cwd: w.cwd, permission_mode: 'acceptEdits', prompt: 'hello pipes' })
    expect(readFileSync(join(w.cwd, 'out.txt'), 'utf8')).toBe(UUID)

    run.child.kill('SIGTERM')
    expect(await run.exited).toEqual({ code: 143, signal: null })
    expect(run.out()).not.toContain('never')
    const hooks = jsonl<{ stdin: string }>(hooksOut).map((r) => JSON.parse(r.stdin) as Record<string, unknown>)
    expect(hooks.map((p) => p.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'SessionEnd'])
    const transcriptPath = join(w.fakeHome, '.claude', 'projects', claudeProjectDirName(w.cwd), `${UUID}.jsonl`)
    expect(hooks[2]).toMatchObject({ reason: 'other', session_id: UUID, transcript_path: transcriptPath })
    expect(jsonl<Record<string, unknown>>(transcriptPath)).toMatchObject([
      { type: 'user', sessionId: UUID, message: { content: 'hello pipes' } },
      { type: 'ai-title', aiTitle: 'Over pipes' },
      { type: 'cost-state', totalCostUSD: 0.12 },
    ])
    // the event log: the end hook finished before the process exited
    const order = jsonl<{ t: string; event?: string }>(log).map((e) => (e.event ? `${e.t}:${e.event}` : e.t))
    expect(order.slice(-3)).toEqual(['ending', 'hook:SessionEnd', 'exit'])
  })

  it('U-FAKE-26 · exit codes: bad agent flag 1, bad fake-agent option or scenario 2, exit step N, stdin EOF 0, SIGHUP 129; --version', async () => {
    const w = workspace('u26')
    const scenario = (n: string, yaml: string) => w.file(n, yaml)
    const waitLine = scenario('wait.yaml', 'version: 1\nsteps:\n  - print: "READY\\r\\n"\n  - wait: line\n')
    const hooksOut = w.file('hooks.jsonl')
    const hookSettings = settings(hooksOut, ['SessionEnd'])

    const badFlag = start(['--as', 'claude', '--scenario', waitLine, '--permission-mode', 'yolo'], w)
    const noAs = start(['--model', 'opus'], w)
    const badScenario = start(['--as', 'claude', '--scenario', scenario('bad.yaml', 'version: 1\nsteps:\n  - sleep: -1\n  - frobnicate: 1\n')], w)
    const exitStep = start(['--as', 'claude', '--fake-home', w.fakeHome, '--scenario', scenario('exit.yaml', 'version: 1\nsteps:\n  - exit: { code: 7, reason: logout }\n'), '--settings', hookSettings], w)
    const eof = start(['--as', 'claude', '--fake-home', w.fakeHome, '--scenario', waitLine], w)
    const hup = start(['--as', 'claude', '--fake-home', w.fakeHome, '--scenario', waitLine], w)
    const version = start(['--as', 'claude', '--version'], w)

    expect((await badFlag.exited).code).toBe(1)
    expect(badFlag.err()).toMatch(/option '--permission-mode' argument 'yolo' is invalid/)
    expect((await noAs.exited).code).toBe(2)
    expect(noAs.err()).toMatch(/--as claude\|commandcode is required/)
    expect((await badScenario.exited).code).toBe(2)
    expect(badScenario.err()).toContain('steps[0].sleep: expected an integer 0…, got number -1')
    expect(badScenario.err()).toContain('steps[1]: unknown step "frobnicate"')
    expect((await exitStep.exited).code).toBe(7)
    expect(jsonl<{ stdin: string }>(hooksOut).map((r) => JSON.parse(r.stdin) as Record<string, unknown>)).toMatchObject([{ hook_event_name: 'SessionEnd', reason: 'logout' }])
    await eof.waitOut('READY')
    eof.child.stdin.end() // EOF while a step reads input: a graceful end
    expect((await eof.exited).code).toBe(0)
    await hup.waitOut('READY')
    hup.child.kill('SIGHUP')
    expect(await hup.exited).toEqual({ code: 129, signal: null })
    expect((await version.exited).code).toBe(0)
    expect(version.out()).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)\n$/) // Claude's own shape: detection reads it
  })

  it('U-FAKE-27 · --as commandcode: a --mod module gets its option, the session hooks and the scenario\'s events; SIGTERM ends it without an event; the session\'s files land under the fake home, which is the mod\'s HOME', async () => {
    const w = workspace('u27')
    const out = w.file('mod.jsonl')
    const mod = w.file(
      'kea-mod-stub.ts',
      `import { appendFileSync } from 'node:fs'
type Cmd = { addFlag: (n: string, o: object) => void; getFlag: (n: string) => unknown; on: (e: string, h: (p: Record<string, unknown>) => unknown) => void; hooks: (h: object) => void }
export default function (cmd: Cmd) {
  const note = (p: unknown) => appendFileSync(${JSON.stringify(out)}, JSON.stringify(p) + '\\n')
  cmd.addFlag('opt', { type: 'string', default: '' })
  for (const e of ['run_start', 'session_titled', 'run_end', 'session_shutdown']) cmd.on(e, note)
  cmd.hooks({
    onSessionStart: (a: object) => note({ hook: 'start', ...a, opt: cmd.getFlag('opt'), home: process.env.HOME }),
    onSessionEnd: (a: object) => note({ hook: 'end', ...a }),
  })
}
`,
    )
    const scenario = w.file(
      's.yaml',
      `version: 1
steps:
  - hook: run_start
  - transcript: { record: user, text: "{{prompt}}" }
  - transcript: { record: assistant, text: "Done." }
  - hook: { event: run_end, fields: { result: { finalText: "Done." } } }
  - hook: { event: session_titled, fields: { title: "T" } }
  - transcript: { record: title, title: "T" }
  - print: "READY\\r\\n"
  - wait: key
`,
    )
    const run = start(['--as', 'commandcode', '--scenario', scenario, '--fake-home', w.fakeHome, '-m', 'gpt-x', '--mod', mod, '--mod-option', 'opt=a=b c', '-t', 'do it'], w)
    await run.waitOut('READY')
    run.child.kill('SIGTERM')
    expect(await run.exited).toEqual({ code: 143, signal: null })
    const events = jsonl<Record<string, unknown>>(out)
    // Command Code 1.79.2 says nothing when a signal ends it: no session_shutdown, no onSessionEnd
    expect(events.map((e) => e.hook ?? e.type)).toEqual(['start', 'run_start', 'run_end', 'session_titled'])
    const sessionId = events[0]?.sessionId as string
    expect(events[0]).toEqual({ hook: 'start', source: 'startup', sessionId, opt: 'a=b c', home: w.fakeHome })
    expect(events[1]).toEqual({ type: 'run_start', sessionId })
    expect(events[2]).toMatchObject({ result: { finalText: 'Done.', stopReason: 'end_turn' } })
    expect(events[3]).toEqual({ type: 'session_titled', title: 'T' })
    // format version 3: a header, the two messages; the prompt's checkpoint and the title beside it
    const base = join(w.fakeHome, '.commandcode', 'projects', commandCodeSlug(w.cwd), sessionId)
    expect(jsonl<Record<string, unknown>>(`${base}.jsonl`)).toMatchObject([
      { type: 'session', version: 3, id: sessionId, cwd: w.cwd },
      { type: 'message', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'do it' }], meta: { source: 'user' } } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], meta: { source: 'model' } }, model: 'gpt-x' },
    ])
    expect(jsonl<Record<string, unknown>>(`${base}.checkpoints.jsonl`)).toMatchObject([{ turnNumber: 1, prompt: 'do it', messageCount: 0 }])
    expect(readFileSync(`${base}.checkpoints.jsonl`, 'utf8').endsWith('\n')).toBe(false) // as the real file: no newline after the last
    expect(JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))).toEqual({ title: 'T' })
  })

  it('U-FAKE-31 · --as commandcode answers detection as 1.79.2 does (--version, the recorded --help and --list-models, status --json), names a conversation with --name and resumes it by id or by name', async () => {
    const w = workspace('u31')
    const asked = (args: string[], extra: Record<string, string> = {}) => {
      const child = spawn(process.execPath, [FAKE_AGENT_MAIN, '--as', 'commandcode', ...args], { cwd: w.cwd, env: { ...env(w.home), ...extra }, stdio: 'pipe' })
      children.add(child)
      let out = ''
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
      return new Promise<{ code: number | null; out: string }>((resolve) => child.on('close', (code) => resolve({ code, out })))
    }
    const fixture = (f: string) => readFileSync(join(import.meta.dirname, '../../../fixtures/cli/commandcode/1.79.2', f), 'utf8')
    const [version, older, help, models, status, signedOut] = await Promise.all([asked(['--version']), asked(['--version'], { FAKE_AGENT_CLI_VERSION: '1.70.0' }), asked(['--help']), asked(['--list-models']), asked(['status', '--json']), asked(['status', '--json'], { FAKE_AGENT_LOGGED_IN: '0' })])
    expect(version).toEqual({ code: 0, out: '1.79.2\n' })
    expect(older.out).toBe('1.70.0\n')
    expect(help).toEqual({ code: 0, out: fixture('help.txt') })
    expect(models).toEqual({ code: 0, out: fixture('list-models.txt') })
    expect([status.code, JSON.parse(status.out)]).toEqual([0, { authenticated: true, version: '1.79.2' }])
    expect([signedOut.code, JSON.parse(signedOut.out)]).toEqual([1, { authenticated: false, version: '1.79.2' }])

    // a named conversation: the meta file says the person named it, and `session_titled` carries the name
    const out = w.file('mod.jsonl')
    const mod = w.file(
      'mod.ts',
      `import { appendFileSync } from 'node:fs'
export default function (cmd: { on: (e: string, h: (p: unknown) => unknown) => void; hooks: (h: object) => void }) {
  const note = (p: unknown) => appendFileSync(${JSON.stringify(out)}, JSON.stringify(p) + '\\n')
  cmd.on('session_titled', note)
  cmd.hooks({ onSessionStart: note })
}
`,
    )
    const scenario = w.file('s.yaml', 'version: 1\nsteps:\n  - transcript: { record: user, text: "{{prompt}}" }\n  - transcript: { record: assistant, text: "ok" }\n  - print: "READY\\r\\n"\n  - wait: key\n')
    const base = ['--scenario', scenario, '--fake-home', w.fakeHome, '--mod', mod]
    const named = start(['--as', 'commandcode', ...base, '--name', 'kea-one', '--', 'first'], w)
    await named.waitOut('READY')
    named.child.stdin.end()
    expect((await named.exited).code).toBe(0)
    const first = jsonl<Record<string, unknown>>(out)
    expect(first).toMatchObject([{ source: 'startup' }, { type: 'session_titled', title: 'kea-one' }])
    const id = first[0]?.sessionId as string
    const dirOf = join(w.fakeHome, '.commandcode', 'projects', commandCodeSlug(w.cwd))
    expect(JSON.parse(readFileSync(join(dirOf, `${id}.meta.json`), 'utf8'))).toEqual({ title: 'kea-one', userRenamed: true })

    // resumed by its name, then by its id: the same session, source resume, records appended to the one file (one header)
    for (const target of ['kea-one', id]) {
      const again = start(['--as', 'commandcode', ...base, '--resume', target, '--', 'again'], w)
      await again.waitOut('READY')
      again.child.stdin.end()
      expect((await again.exited).code).toBe(0)
    }
    expect(jsonl<Record<string, unknown>>(out).filter((e) => 'source' in e).slice(1)).toEqual([{ source: 'resume', sessionId: id }, { source: 'resume', sessionId: id }])
    const records = jsonl<Record<string, unknown>>(join(dirOf, `${id}.jsonl`))
    expect(records.map((r) => r.type)).toEqual(['session', 'message', 'message', 'message', 'message', 'message', 'message'])
    expect(jsonl<Record<string, unknown>>(join(dirOf, `${id}.checkpoints.jsonl`)).map((c) => c.prompt)).toEqual(['first', 'again', 'again'])
    // a name nobody has: the CLI's own refusal
    const missing = start(['--as', 'commandcode', ...base, '--resume', 'kea-none'], w)
    expect((await missing.exited).code).toBe(1)
    expect(missing.err()).toContain('No session found matching "kea-none"')
  })

  it('U-FAKE-34 · --as antigravity answers detection as 1.5.13 does (--version on stdout, --help on stderr with empty stdout, models on stdout and exit 1 when FAKE_AGENT_OFFLINE=1), writes the agy shim, runs statusLine through /bin/sh -c with stateful snapshots and quota, handles /clear conversation switching and --conversation resume', async () => {
    const w = workspace('u34')
    const asked = (args: string[], extra: Record<string, string> = {}) => {
      const child = spawn(process.execPath, [FAKE_AGENT_MAIN, '--as', 'antigravity', ...args], {
        cwd: w.cwd,
        env: { ...env(w.home), ...extra },
        stdio: 'pipe',
      })
      children.add(child)
      let out = ''
      let err = ''
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
      return new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
        child.on('close', (code) => resolve({ code, out, err })),
      )
    }
    const fixture = (f: string) => readFileSync(join(import.meta.dirname, '../../../fixtures/cli/antigravity/1.5.13', f), 'utf8')
    const [version, older, help, models, offline] = await Promise.all([
      asked(['--version']),
      asked(['--version'], { FAKE_AGENT_CLI_VERSION: '1.3.0' }),
      asked(['--help']),
      asked(['models']),
      asked(['models'], { FAKE_AGENT_OFFLINE: '1' }),
    ])
    expect(version).toEqual({ code: 0, out: '1.5.13\n', err: '' })
    expect(older).toEqual({ code: 0, out: '1.3.0\n', err: '' })
    // Go's flag package prints --help to stderr with empty stdout and exit code 0
    expect(help).toEqual({ code: 0, out: '', err: fixture('help.txt') })
    expect(models).toEqual({ code: 0, out: fixture('models.txt'), err: 'Fetching available models...\n' })
    expect(offline.code).toBe(1)
    expect(offline.out).toBe('')
    expect(offline.err).toContain('Error: Please sign in to view available models.')

    // writeAgentShim(..., 'antigravity') writes an executable `agy` shim
    const shimDir = join(dir, 'u34-shims')
    const agyShim = writeAgentShim(shimDir, 'antigravity')
    expect(agyShim).toBe(join(shimDir, 'agy'))
    expect(readFileSync(agyShim, 'utf8')).toContain('--as antigravity "$@"')

    // End-to-end statusLine feed over /bin/sh -c, step transcript writing, /clear conversation switch, and --conversation resume
    const feedOut = w.file('feed.jsonl')
    const agSettings = JSON.stringify({
      statusLine: {
        type: 'command',
        command: `'${process.execPath}' '${STUB}' '${feedOut}' 'feed' 'antigravity'`,
        stack_with_default: true,
      },
      clearScrollbackOnResize: false,
    })
    const quotaJson = JSON.stringify({
      'gemini-5h': { remaining_fraction: 0.75, reset_time: '2026-11-21T00:00:00Z', reset_in_seconds: 3600 },
    })
    const clearId = '77f055e0-77a0-4ec8-9f12-d184b3b76fed'
    const scenario = w.file(
      'ag.yaml',
      `version: 1
steps:
  - hook: working
  - transcript: { record: user, text: "{{prompt}}" }
  - transcript: { record: running }
  - hook: tool_confirmation
  - hook: tool_confirmation_clear
  - transcript: { record: assistant, text: "First reply." }
  - hook: { event: idle, fields: { conversation_title: "First Title", subagents: [ { name: "h1", role: "worker", status: "running" } ] } }
  - hook: { event: clear, fields: { conversation_id: "${clearId}" } }
  - transcript: { record: user, text: "after clear" }
  - transcript: { record: assistant, text: "Second reply." }
  - print: "READY\\r\\n"
  - wait: key
`,
    )
    const child = spawn(
      process.execPath,
      [
        FAKE_AGENT_MAIN,
        '--as',
        'antigravity',
        '--scenario',
        scenario,
        '--fake-home',
        w.fakeHome,
        `--conversation=${UUID}`,
        '--model=Gemini 3.8 Flash (Low)',
        '--effort=low',
        '--mode=auto',
        `--settings=${agSettings}`,
        '--prompt-interactive=explain repo',
      ],
      {
        cwd: w.cwd,
        env: { ...env(w.home), FAKE_AGENT_QUOTA: quotaJson },
        stdio: 'pipe',
      },
    )
    children.add(child)
    let stdout = ''
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        stdout += d
        if (stdout.includes('READY')) resolve()
      })
      child.on('close', () => {
        if (!stdout.includes('READY')) reject(new Error('closed before READY'))
      })
    })
    child.stdin.end()
    await new Promise<void>((resolve) => child.on('close', () => resolve()))

    const runs = jsonl<{ argv: string[]; stdin: string }>(feedOut)
    expect(runs.every((r) => r.argv[0] === 'feed' && r.argv[1] === 'antigravity')).toBe(true)
    const snapshots = runs.map((r) => JSON.parse(r.stdin) as Record<string, unknown>)
    expect(snapshots.map((s) => s.agent_state)).toEqual(['initializing', 'working', 'tool_use', 'working', 'idle', 'idle'])
    expect(snapshots[0]).toMatchObject({
      conversation_id: UUID,
      agent_state: 'initializing',
      cycle_mode: 'auto',
      model: { id: 'Gemini 3.8 Flash (Low)', display_name: 'Gemini 3.8 Flash (Low)', effort: 'low' },
      quota: { 'gemini-5h': { remaining_fraction: 0.75 } },
    })
    expect(snapshots[2]?.tool_confirmation_pending).toBe(true)
    expect(snapshots[3]?.tool_confirmation_pending).toBe(false)
    expect(snapshots[4]).toMatchObject({
      conversation_id: UUID,
      agent_state: 'idle',
      conversation_title: 'First Title',
      subagents: [{ name: 'h1', role: 'worker', status: 'running' }],
    })
    // /clear switched conversation_id, updated transcript_path to the new brain folder, and cleared conversation_title
    const tp1 = join(w.fakeHome, '.gemini', 'antigravity-cli', 'brain', UUID, '.system_generated', 'logs', 'transcript.jsonl')
    const tp2 = join(w.fakeHome, '.gemini', 'antigravity-cli', 'brain', clearId, '.system_generated', 'logs', 'transcript.jsonl')
    expect(snapshots[0]?.transcript_path).toBe(tp1)
    expect(snapshots[5]?.conversation_id).toBe(clearId)
    expect(snapshots[5]?.transcript_path).toBe(tp2)
    expect(snapshots[5]?.conversation_title).toBeUndefined()

    // Both transcripts exist in their respective brain/<id>/.system_generated/logs/ folders
    expect(jsonl<Record<string, unknown>>(tp1).map((r) => [r.step_index, r.type, r.status])).toEqual([
      [0, 'USER_INPUT', 'DONE'],
      [1, 'PLANNER_RESPONSE', 'RUNNING'],
      [2, 'PLANNER_RESPONSE', 'DONE'],
    ])
    expect(jsonl<Record<string, unknown>>(tp2).map((r) => [r.step_index, r.type, r.status])).toEqual([
      [0, 'USER_INPUT', 'DONE'],
      [1, 'PLANNER_RESPONSE', 'DONE'],
    ])
  })
})
