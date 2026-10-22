import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FakeAgent } from './agent.ts'
import type { HookFireOptions, HookSink } from './hooks.ts'
import { EventLog, type LogEvent } from './log.ts'
import type { ProbeBatch, ProbeResult } from './probes.ts'
import { parseScenario } from './scenario.ts'
import { StatusFileWriter } from './status.ts'
import { AbortedError, ALT_SCREEN_ENTER, BEL, InputRouter, type Io, SYNC_BEGIN, SYNC_END } from './term.ts'
import { TranscriptWriter } from './transcript.ts'

const dir = mkdtempSync(join(tmpdir(), 'fake-agent-agent-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A terminal in memory: records output, answers probes like xterm.js would, resolves waits on output text. */
class FakeTerm implements Io {
  out = ''
  cols = 80
  rows = 24
  readonly router = new InputRouter()
  private readonly watchers: { from: number; text: string; resolve: () => void }[] = []
  /** Replies to queries in written output (null: a terminal that answers nothing). */
  answers: Record<string, string> | null = { '\x1b[?2026$p': '\x1b[?2026;2$y', '\x1b[?u': '\x1b[?0u', '\x1b]11;?\x1b\\': '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', '\x1b[c': '\x1b[?1;2c' }

  get keys() {
    return this.router.keys
  }

  write(s: string): Promise<void> {
    this.out += s
    if (this.answers) {
      let reply = ''
      for (const [q, r] of Object.entries(this.answers)) if (s.includes(q)) reply += r
      if (reply) queueMicrotask(() => this.router.input(reply))
    }
    for (const w of [...this.watchers]) {
      if (this.out.slice(w.from).includes(w.text)) {
        this.watchers.splice(this.watchers.indexOf(w), 1)
        w.resolve()
      }
    }
    return Promise.resolve()
  }

  /** Resolves when `text` appears in output written from now on. */
  waitFor(text: string): Promise<void> {
    return new Promise((resolve) => this.watchers.push({ from: this.out.length, text, resolve }))
  }

  size() {
    return { cols: this.cols, rows: this.rows }
  }

  probe(batch: ProbeBatch, timeoutMs: number, signal: AbortSignal): Promise<ProbeResult[]> {
    return this.router.probe(batch, timeoutMs, signal, this)
  }

  sleep(_ms: number, signal: AbortSignal): Promise<void> {
    return signal.aborted ? Promise.reject(new AbortedError()) : Promise.resolve()
  }

  now() {
    return 0
  }
}

/** Records every event with the order it happened in, alongside restore/exit. */
class Recorder implements HookSink {
  readonly seq: string[] = []
  readonly fired: { event: string; opts: HookFireOptions }[] = []
  async fire(event: string, opts: HookFireOptions) {
    this.fired.push({ event, opts })
    this.seq.push(`hook:${event}`)
    return { payload: { hook_event_name: event, ...opts.fields }, runs: [] }
  }
}

function setup(yaml: string, o: { cwd?: string; transcript?: string; status?: StatusFileWriter } = {}) {
  const term = new FakeTerm()
  const hooks = new Recorder()
  const events: LogEvent[] = []
  const warnings: string[] = []
  let exitCode: number | null = null
  const cwd = o.cwd ?? dir
  const agent = new FakeAgent({
    io: term,
    scenario: parseScenario(yaml, { flavour: 'claude', baseDir: dir }),
    flavour: 'claude',
    vars: { sessionId: 'sid', cwd, model: 'opus', prompt: 'the prompt', line: '', key: '', argvHash: 'abc123', flavour: 'claude', permissionMode: 'default', transcriptPath: '/t.jsonl' },
    hooks,
    transcript: o.transcript ? new TranscriptWriter(o.transcript, { sessionId: 'sid', cwd, model: 'opus', version: 'test' }) : null,
    transcriptRefusal: o.transcript ? null : 'no transcript in this test',
    ...(o.status ? { status: o.status } : {}),
    log: new EventLog((e) => events.push(e), () => 0),
    restore: () => hooks.seq.push('restore'),
    exit: (code) => {
      hooks.seq.push(`exit:${code}`)
      exitCode = code
    },
    warn: (m) => warnings.push(m),
  })
  return { term, hooks, events, warnings, agent, exitCode: () => exitCode }
}

const records = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('fake-agent runner and lifecycle', () => {
  it('U-FAKE-21 · a scenario plays against the terminal: probes, alt screen, synchronized frames, title, bell, notifications, argv hash, answers, branches, loops, files, hooks', async () => {
    const cwd = join(dir, 'u21')
    mkdirSync(cwd)
    const { term, hooks, events, agent, exitCode, warnings } = setup(
      `
version: 1
afterSteps: exit
steps:
  - probe: [decrqm-2026, kitty, osc11]
  - altScreen: enter
  - frame: ["{{model}} {{cols}}x{{rows}}", "> {{prompt}}", "a very long line that is clipped"]
  - title: "✳ {{prompt}}"
  - bell
  - notify: { body: "needs you", osc: 9 }
  - notify: { title: "Kea;x", body: "done", osc: 777 }
  - argvHash
  - hook: { event: PermissionRequest, tool: Bash, input: { command: "rm -rf build" } }
  - wait: { answer: y }
  - choose: { "1": [ { print: "ONE" } ], "2": [ { print: "TWO" } ] }
  - hook: UserPromptSubmit
  - loop: { times: 3, steps: [ { file: { op: write, path: "f{{i}}.txt", content: "n={{i}}" } } ] }
  - file: { op: delete, path: f1.txt }
`,
      { cwd },
    )
    term.cols = 20
    // type-ahead: the answers arrive before the steps read them; other keys are ignored by an answer wait
    term.keys.push(['x', 'y', '2'])
    await agent.run()
    expect(warnings).toEqual([])
    expect(exitCode()).toBe(0)
    const probe = events.find((e) => e.t === 'probe') as unknown as { results: ProbeResult[] }
    expect(probe.results.map((r) => r.value)).toEqual(['2', '0', 'rgb:1e1e/1e1e/1e1e'])
    const o = term.out
    const after = (a: string, b: string) => o.indexOf(b, o.indexOf(a)) > o.indexOf(a)
    expect(o.startsWith('\x1b[?2026$p\x1b[?u\x1b]11;?\x1b\\\x1b[c')).toBe(true)
    expect(o).toContain(`${ALT_SCREEN_ENTER}${SYNC_BEGIN}\x1b[H\x1b[2Jopus 20x24\r\n> the prompt\r\na very long line tha${SYNC_END}`)
    expect(o).toContain('\x1b]2;✳ the prompt\x07')
    expect(o).toContain(BEL + '\x1b]9;needs you\x07\x1b]777;notify;Kea,x;done\x07')
    expect(o).toContain('fake-agent argv sha256=abc123\r\n')
    expect(after('sha256', 'TWO')).toBe(true)
    expect(o).not.toContain('ONE')
    expect(hooks.seq).toEqual(['hook:SessionStart', 'hook:PermissionRequest', 'hook:UserPromptSubmit', 'hook:SessionEnd', 'restore', 'exit:0'])
    expect(hooks.fired[1]?.opts).toEqual({ tool: 'Bash', input: { command: 'rm -rf build' }, fields: {} })
    expect(hooks.fired[2]?.opts.fields).toEqual({ prompt: 'the prompt' })
    expect(hooks.fired[3]?.opts.fields).toEqual({ reason: 'prompt_input_exit' })
    expect(events.filter((e) => e.t === 'input').map((e) => e.key)).toEqual(['y', '2'])
    expect(readFileSync(join(cwd, 'f0.txt'), 'utf8')).toBe('n=0')
    expect(readFileSync(join(cwd, 'f2.txt'), 'utf8')).toBe('n=2')
    expect(() => readFileSync(join(cwd, 'f1.txt'))).toThrow(/ENOENT/)
  })

  it('U-FAKE-22 · Esc interrupts a turn (onInterrupt writes the interrupt marker), a typed line runs onLine, Ctrl-D at the idle prompt ends with SessionEnd', async () => {
    const transcript = join(dir, 'u22', 't.jsonl')
    const { term, hooks, agent, exitCode } = setup(
      `
version: 1
steps:
  - print: TURN1
  - wait: line
  - print: never
onInterrupt:
  - transcript: { record: interrupt }
  - print: INTERRUPTED
onLine:
  - hook: UserPromptSubmit
  - print: "LINE {{line}}"
`,
      { transcript },
    )
    const turn1 = term.waitFor('TURN1')
    const done = agent.run()
    await turn1
    const interrupted = term.waitFor('INTERRUPTED')
    term.keys.push(['esc'])
    await interrupted
    expect(records(transcript)).toMatchObject([{ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }])
    const line = term.waitFor('LINE hi')
    term.keys.push(['h', 'x', 'backspace', 'i', 'enter'])
    await line
    expect(term.out).toContain('hx\b \bi\r\nLINE hi') // echoed as typed
    expect(hooks.fired.at(-1)?.opts.fields).toEqual({ prompt: 'hi' })
    term.keys.push(['ctrl-d'])
    await done
    expect(exitCode()).toBe(0)
    expect(term.out).not.toContain('never')
    expect(hooks.seq).toEqual(['hook:SessionStart', 'hook:UserPromptSubmit', 'hook:SessionEnd', 'restore', 'exit:0'])
  })

  it('U-FAKE-23 · ending (as on SIGTERM) aborts the step, fires SessionEnd, writes cost-state, restores the terminal, then exits — once', async () => {
    const transcript = join(dir, 'u23', 't.jsonl')
    const { term, hooks, events, agent } = setup('version: 1\nexitCostUsd: 0.42\nsteps:\n  - print: READY\n  - wait: key\n', { transcript })
    const ready = term.waitFor('READY')
    const done = agent.run()
    await ready
    const a = agent.end('other', 143)
    const b = agent.end('other', 129) // a second signal changes nothing
    expect(b).toBe(a)
    await done
    expect(hooks.seq).toEqual(['hook:SessionStart', 'hook:SessionEnd', 'restore', 'exit:143'])
    expect(hooks.fired[1]?.opts.fields).toEqual({ reason: 'other' })
    expect(records(transcript)).toMatchObject([{ type: 'cost-state', totalCostUSD: 0.42 }])
    const order = events.map((e) => e.t)
    expect(order.indexOf('ending')).toBeLessThan(order.lastIndexOf('hook'))
    expect(order.at(-1)).toBe('exit')
  })

  it('U-FAKE-24 · exit steps, failed steps, Ctrl-C without onInterrupt, a closed input, a withheld SessionStart and a resize all behave', async () => {
    // exit step with a code
    const e1 = setup('version: 1\nsteps:\n  - exit: { code: 7, reason: logout }\n  - print: never\n')
    await e1.agent.run()
    expect(e1.hooks.seq).toEqual(['hook:SessionStart', 'hook:SessionEnd', 'restore', 'exit:7'])
    expect(e1.hooks.fired[1]?.opts.fields).toEqual({ reason: 'logout' })

    // a failed step: reported with its path, exit 1, SessionEnd still fires
    const e2 = setup('version: 1\nsteps:\n  - file: { op: delete, path: no-such-file }\n')
    await e2.agent.run()
    expect(e2.warnings).toEqual([expect.stringMatching(/^fake-agent: steps\[0\] \(file\): ENOENT/)])
    expect(e2.hooks.seq.slice(-3)).toEqual(['hook:SessionEnd', 'restore', 'exit:1'])

    // Ctrl-C with no onInterrupt ends the agent, even mid-step; SessionStart withheld (trust pending) and SessionEnd off
    const e3 = setup('version: 1\nfireSessionStart: false\nfireSessionEnd: false\nsteps:\n  - print: READY\n  - wait: { answer: y }\n')
    const ready = e3.term.waitFor('READY')
    const done = e3.agent.run()
    await ready
    e3.term.keys.push(['n', 'ctrl-c'])
    await done
    expect(e3.hooks.seq).toEqual(['restore', 'exit:0'])

    // the input goes away while a step waits for it (the PTY closed): end
    const e4 = setup('version: 1\nsteps:\n  - wait: line\n')
    const d4 = e4.agent.run()
    e4.term.keys.close()
    await d4
    expect(e4.hooks.seq).toEqual(['hook:SessionStart', 'hook:SessionEnd', 'restore', 'exit:0'])

    // SIGWINCH: the last frame is redrawn at the new size; a terminal that answers no probes times out
    const e5 = setup('version: 1\nafterSteps: exit\nsteps:\n  - probe: { queries: [kitty], timeoutMs: 1 }\n  - frame: ["{{cols}}x{{rows}}"]\n  - print: DRAWN\n  - wait: key\n')
    e5.term.answers = null
    const drawn = e5.term.waitFor('DRAWN')
    const d5 = e5.agent.run()
    await drawn
    e5.term.cols = 132
    e5.term.rows = 40
    await e5.agent.resize()
    expect(e5.term.out).toContain(`${SYNC_BEGIN}\x1b[H\x1b[2J132x40${SYNC_END}`)
    expect(e5.events.find((e) => e.t === 'probe')).toMatchObject({ results: [{ id: 'kitty', reply: null }] })
    e5.term.keys.push(['q'])
    await d5
    expect(e5.exitCode()).toBe(0)
  })
  it('U-FAKE-30 · an agent awaiting trust (SessionStart withheld) writes no status file until its SessionStart step: then it registers the file and marks it idle before the hook, as 2.1.296 does after “Yes”', async () => {
    const file = join(dir, 'u30', 'sessions', '4242.json')
    const status = new StatusFileWriter(file, { pid: 4242, sessionId: 'sid', cwd: dir, version: '2.1.296' })
    const { term, agent } = setup('version: 1\nfireSessionStart: false\nafterSteps: exit\nsteps:\n  - print: "TRUST?"\n  - wait: { answer: t }\n  - hook: SessionStart\n  - print: TRUSTED\n  - wait: key\n', { status })
    const asked = term.waitFor('TRUST?')
    const done = agent.run()
    await asked
    expect(existsSync(file), 'no file while the trust dialog is up').toBe(false)
    const trusted = term.waitFor('TRUSTED')
    term.keys.push(['t'])
    await trusted
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: 4242, sessionId: 'sid', status: 'idle' })
    term.keys.push(['x'])
    await done
  })
})
