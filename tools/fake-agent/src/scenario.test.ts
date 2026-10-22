import { describe, expect, it } from 'vitest'
import { DEFAULT_SCENARIOS, defaultScenario, parseScenario, ScenarioError, type Step, validateScenario } from './scenario.ts'

const opts = { flavour: 'claude' as const, baseDir: '/base', source: 'test.yaml' }
const OUTSIDE = '/etc/hosts' // os-ok: test data

function problems(yaml: string, o: { flavour: 'claude' | 'commandcode' } = opts): string[] {
  try {
    parseScenario(yaml, { ...opts, ...o })
  } catch (e) {
    if (e instanceof ScenarioError) return e.problems
    throw e
  }
  return []
}

describe('fake-agent scenarios', () => {
  it('U-FAKE-4 · every step kind validates, shorthand forms normalise, and the top-level defaults apply', () => {
    const s = parseScenario(
      `
version: 1
name: all steps
steps:
  - probe: [da1, decrqm-2026, kitty, osc11]
  - probe: { queries: [cpr], timeoutMs: 50 }
  - altScreen: enter
  - frame: ["{{model}} {{cols}}x{{rows}}", "> {{prompt}}"]
  - frame: { lines: one line, sync: false }
  - print: "\\e[1mbold\\e[0m"
  - title: "t"
  - title: { text: "t0", osc: 0 }
  - bell
  - notify: "needs you"
  - notify: { title: T, body: B, osc: 777 }
  - wait: key
  - wait: { answer: y }
  - wait: { for: line, timeoutMs: 100, echo: false }
  - choose: { y: [ { print: yes } ], esc: [ { print: no } ], space: [] }
  - hook: SessionStart
  - hook: { event: PreToolUse, tool: Write, input: { file_path: "a.txt" }, fields: { extra: 1 } }
  - transcript: { record: ai-title, title: "T" }
  - transcript: { record: interrupt, forToolUse: true }
  - file: { op: write, path: src/a.txt, content: "hi {{i}}" }
  - file: { op: rename, path: src/a.txt, to: src/b.txt }
  - argvHash
  - cassette: { file: x.cast, speed: 2 }
  - sleep: 10
  - loop: { times: 2, steps: [ { sleep: 1 } ] }
  - loop: { forever: true, steps: [ { exit: { code: 3, reason: logout } } ] }
  - exit
`,
      opts,
    )
    expect(s.name).toBe('all steps')
    expect(s.afterSteps).toBe('idle')
    expect(s.fireSessionStart && s.fireSessionEnd).toBe(true)
    expect(s.onLine).toBeNull()
    const k = (i: number) => s.steps[i] as Step
    expect(s.steps.map((x) => x.kind)).toEqual([
      'probe', 'probe', 'altScreen', 'frame', 'frame', 'print', 'title', 'title', 'bell', 'notify', 'notify', 'wait', 'wait', 'wait',
      'choose', 'hook', 'hook', 'transcript', 'transcript', 'file', 'file', 'argvHash', 'cassette', 'sleep', 'loop', 'loop', 'exit',
    ])
    expect(k(0)).toMatchObject({ queries: ['da1', 'decrqm-2026', 'kitty', 'osc11'], timeoutMs: 1000, at: 'steps[0]' })
    expect(k(4)).toMatchObject({ lines: ['one line'], sync: false })
    expect(k(5)).toMatchObject({ text: '\x1b[1mbold\x1b[0m' })
    expect(k(6)).toMatchObject({ osc: 2 })
    expect(k(7)).toMatchObject({ osc: 0 })
    expect(k(9)).toMatchObject({ osc: 9, body: 'needs you' })
    expect(k(12)).toMatchObject({ mode: 'answer', answer: 'y' })
    expect(k(13)).toMatchObject({ mode: 'line', timeoutMs: 100, echo: false })
    expect(k(14)).toMatchObject({ branches: [{ key: 'y' }, { key: 'esc' }, { key: ' ' }] })
    expect(k(16)).toMatchObject({ event: 'PreToolUse', tool: 'Write', input: { file_path: 'a.txt' }, fields: { extra: 1 } })
    expect(k(25)).toMatchObject({ times: 'forever', steps: [{ kind: 'exit', code: 3, reason: 'logout', at: 'steps[25].loop.steps[0]' }] })
    expect(k(26)).toMatchObject({ code: 0, reason: 'prompt_input_exit' })
    expect(s.baseDir).toBe('/base')
  })

  it('U-FAKE-5 · problems are reported all at once, each with its path', () => {
    const p = problems(`
version: 2
colour: red
steps:
  - frobnicate: 1
  - { print: a, sleep: 1 }
  - probe: [da1, nonsense]
  - hook: { event: NotAnEvent }
  - frame: ["{{nope}}"]
  - file: { op: write, path: ../escape.txt, content: x }
  - file: { op: delete, path: ${OUTSIDE} }
  - file: { op: modify, path: a }
  - transcript: { record: user }
  - wait: { answer: yes }
  - choose: { ctrl-x: [] }
  - loop: { times: 0, steps: [] }
  - sleep: -1
  - exit: { code: 300 }
  - title
`)
    expect(p).toEqual([
      'scenario.colour: unknown field (allowed: version, name, flavour, steps, onLine, onInterrupt, afterSteps, fireSessionStart, fireSessionEnd, exitCostUsd, statusFile)',
      'version: must be 1, got number 2',
      'steps[0]: unknown step "frobnicate" (steps: probe, altScreen, frame, print, title, bell, notify, wait, choose, hook, transcript, file, argvHash, cassette, sleep, exit, loop, status)',
      'steps[1]: a step has exactly one key (its kind), got print, sleep',
      'steps[2].probe[1]: unknown probe string "nonsense" (probes: da1, da2, cpr, kitty, osc10, osc11, xtversion, decrqm-<mode>)',
      expect.stringMatching(/^steps\[3\]\.hook\.event: expected one of SessionStart, .*SessionEnd, got string "NotAnEvent"$/),
      expect.stringMatching(/^steps\[4\]\.frame\.lines\[0\]: unknown template variable \{\{nope\}\}/),
      'steps[5].file.path: must stay inside the working directory (no ..)',
      'steps[6].file.path: must be relative to the working directory',
      'steps[7].file: modify needs find and replace',
      'steps[8].transcript.text: a user record needs text',
      expect.stringMatching(/^steps\[9\]\.wait\.answer: expected one character or a key name/),
      expect.stringMatching(/^steps\[10\]\.choose\.ctrl-x: not a key/),
      'steps[11].loop.times: expected an integer 1…, got number 0',
      'steps[12].sleep: expected an integer 0…, got number -1',
      'steps[13].exit.code: expected an integer 0…255, got number 300',
      'steps[14]: "title" needs a value: write { title: … }',
    ])
    expect(problems('steps: [')).toEqual([expect.stringMatching(/^not valid YAML/)])
    expect(problems('- just a list')).toEqual(['expected a mapping with version and steps, got a list'])
  })

  it('U-FAKE-6 · hook events and transcript records are checked against the flavour; the default scenarios are valid', () => {
    expect(problems('version: 1\nsteps: [ { hook: session_start } ]')).toEqual([expect.stringMatching(/^steps\[0\]\.hook\.event: expected one of SessionStart/)])
    expect(problems('version: 1\nsteps: [ { hook: SessionStart } ]', { flavour: 'commandcode' })).toEqual([expect.stringMatching(/^steps\[0\]\.hook\.event: expected one of session_start/)])
    expect(problems('version: 1\nsteps: [ { transcript: { record: ai-title, title: x } } ]', { flavour: 'commandcode' })).toEqual([expect.stringMatching(/record: expected one of user, assistant, error, title, raw/)])
    expect(problems('version: 1\nsteps: [ { transcript: { record: title } }, { transcript: { record: error } } ]', { flavour: 'commandcode' })).toEqual(['steps[0].transcript.title: a title record needs a title', 'steps[1].transcript.text: a error record needs text'])
    expect(problems('version: 1\nsteps: [ { transcript: { record: title, title: x } } ]')).toEqual([expect.stringMatching(/record: expected one of user, assistant, interrupt/)])
    // every event Command Code 1.79.2 emits is a hook step
    expect(problems(`version: 1\nsteps: [ ${['message_start', 'model_request_start', 'model_request_end', 'message_end', 'tool_hook_blocked', 'tool_denied', 'interrupted', 'run_error'].map((e) => `{ hook: ${e} }`).join(', ')} ]`, { flavour: 'commandcode' })).toEqual([])
    expect(problems('version: 1\nflavour: commandcode\nsteps: []')).toEqual(['flavour: scenario is for string "commandcode" but fake-agent runs --as claude'])
    expect(problems('version: 1\nexitCostUsd: 0.5\nsteps: []', { flavour: 'commandcode' })).toEqual(['exitCostUsd: only for --as claude (Command Code has no cost-state record)'])
    for (const flavour of ['claude', 'commandcode'] as const) {
      const s = defaultScenario(flavour, '/cwd')
      expect(s.steps.length).toBeGreaterThan(5)
      expect(s.onLine).not.toBeNull()
      expect(s.onInterrupt).not.toBeNull()
      expect(DEFAULT_SCENARIOS[flavour]).toContain('argvHash')
    }
    // JSON is YAML too
    expect(validateScenario(JSON.parse('{"version":1,"steps":[{"sleep":5}],"afterSteps":"exit"}'), opts).afterSteps).toBe('exit')
  })
})
