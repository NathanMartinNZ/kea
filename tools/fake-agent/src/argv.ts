// fake-agent's command line: its own options, then the agent flags Kea passes, read per flavour the way the real CLI
// reads them. Pure: argv and env in, a parse out.

import { createHash } from 'node:crypto'

export type Flavour = 'claude' | 'commandcode'

/** The Claude Code version `--version` reports; `FAKE_AGENT_CLI_VERSION` overrides it (an outdated CLI). */
export const FAKE_CLAUDE_VERSION = '2.1.296'
/** The Command Code version `--as commandcode` stands in for (its recorded answers: fixtures/cli/commandcode/<version>/). */
export const FAKE_COMMANDCODE_VERSION = '1.79.2'
export const FLAVOURS: readonly Flavour[] = ['claude', 'commandcode']

/** fake-agent's own options. Each also has an env var, so a `claude`/`cmd` shim on PATH needs no extra flags. */
export interface FakeOptions {
  as: Flavour
  scenario: string | null
  /** Directory standing in for HOME when computing transcript paths (`--fake-home`, `FAKE_AGENT_HOME`). */
  fakeHome: string | null
  /** JSONL event log for tests (`--log`, `FAKE_AGENT_LOG`). */
  log: string | null
}

const FAKE_FLAGS: Record<string, { key: keyof FakeOptions; env: string }> = {
  '--as': { key: 'as', env: 'FAKE_AGENT_AS' },
  '--scenario': { key: 'scenario', env: 'FAKE_AGENT_SCENARIO' },
  '--fake-home': { key: 'fakeHome', env: 'FAKE_AGENT_HOME' },
  '--log': { key: 'log', env: 'FAKE_AGENT_LOG' },
}

interface CommonArgs {
  model: string | null
  effort: string | null
  permissionMode: string | null
  resume: string | null
  /** Flags this parser does not model, in order (they still count for the argv hash). */
  extra: string[]
  /** Text after `--` (or the positional prompt), '' when there is none. */
  prompt: string
  help: boolean
  version: boolean
}

export interface ClaudeArgs extends CommonArgs {
  flavour: 'claude'
  sessionId: string | null
  /** Raw `--settings` value: inline JSON or a file path. */
  settings: string | null
}

export interface CommandCodeArgs extends CommonArgs {
  flavour: 'commandcode'
  mods: string[]
  /** `--mod-option name=value`, by name (a later one of the same name wins). */
  modOptions: Record<string, string>
  trust: boolean
  name: string | null
  /** `--list-models`. */
  listModels: boolean
}

export type AgentArgs = ClaudeArgs | CommandCodeArgs

export interface ParsedArgv {
  fake: FakeOptions
  /** argv with fake-agent's own options removed: what Kea's adapter built. The argv hash is over this. */
  agentArgv: string[]
  agent: AgentArgs
}

/** A bad command line. `exitCode` is 2 for fake-agent's own options, 1 for agent flags (as the real CLI exits). */
export class ArgvError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

// Choices the real CLIs validate.
export const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'manual', 'plan']
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// every spelling Command Code 1.79.2 takes, and what it reports for each in `permission_mode_changed`
export const COMMANDCODE_PERMISSION_MODES = ['default', 'standard', 'plan', 'accept-edits', 'auto-accept', 'yolo', 'bypass', 'dont-ask']
const COMMANDCODE_REPORTED: Record<string, string> = { default: 'default', standard: 'default', plan: 'plan', 'accept-edits': 'auto-accept', 'auto-accept': 'auto-accept', yolo: 'bypass', bypass: 'bypass', 'dont-ask': 'dont-ask' }
export const COMMANDCODE_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** sha256 of the JSON of an argv array, hex, compared with the hash of the adapter's SpawnSpec args (E-SES-1). */
export function argvHash(argv: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex')
}

/** The line `argvHash` steps print, so a test can find it in terminal output. */
export function argvHashLine(hash: string): string {
  return `fake-agent argv sha256=${hash}`
}

/** Split fake-agent's own options out of argv (they may appear anywhere before `--`); env fills what flags leave unset. */
export function splitFakeOptions(argv: readonly string[], env: Record<string, string | undefined>): { fake: FakeOptions; rest: string[] } {
  const got: Partial<Record<keyof FakeOptions, string>> = {}
  const rest: string[] = []
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') break
    const eq = a.indexOf('=')
    const flag = eq > 0 ? a.slice(0, eq) : a
    const spec = FAKE_FLAGS[flag]
    if (!spec) {
      rest.push(a)
      continue
    }
    let value: string | undefined
    if (eq > 0) value = a.slice(eq + 1)
    else {
      value = argv[i + 1]
      i++
    }
    if (value === undefined || value === '') throw new ArgvError(`fake-agent: ${flag} needs a value`, 2)
    got[spec.key] = value
  }
  rest.push(...argv.slice(i))
  const pick = (k: keyof FakeOptions) => {
    const spec = Object.values(FAKE_FLAGS).find((s) => s.key === k) as { env: string }
    return got[k] ?? (env[spec.env] || null)
  }
  const as = pick('as')
  if (as === null) throw new ArgvError('fake-agent: --as claude|commandcode is required (or FAKE_AGENT_AS)', 2)
  if (!(FLAVOURS as readonly string[]).includes(as)) throw new ArgvError(`fake-agent: --as must be one of ${FLAVOURS.join(', ')}, got "${as}"`, 2)
  return { fake: { as: as as Flavour, scenario: pick('scenario'), fakeHome: pick('fakeHome'), log: pick('log') }, rest }
}

/** How a flag consumes argv: one value, values up to the next flag (commander's variadic), or none. */
type Arity = 'value' | 'variadic' | 'bool'

interface FlagTable {
  /** flag → [arity, field it fills, or null when it only goes to `extra`] */
  [flag: string]: [Arity, string | null]
}

const CLAUDE_FLAGS: FlagTable = {
  '--session-id': ['value', 'sessionId'],
  '--model': ['value', 'model'],
  '--effort': ['value', 'effort'],
  '--permission-mode': ['value', 'permissionMode'],
  '--settings': ['value', 'settings'],
  '--resume': ['value', 'resume'],
  '-r': ['value', 'resume'],
  '--help': ['bool', 'help'],
  '-h': ['bool', 'help'],
  '--version': ['bool', 'version'],
  '-v': ['bool', 'version'],
  // modelled only so their values are not mistaken for the prompt (the real CLI reads a word after `--allowedTools`
  // as a tool name)
  '--add-dir': ['variadic', null],
  '--allowedTools': ['variadic', null],
  '--allowed-tools': ['variadic', null],
  '--disallowedTools': ['variadic', null],
  '--disallowed-tools': ['variadic', null],
  '--mcp-config': ['variadic', null],
  '--plugin-dir': ['value', null],
  '--fallback-model': ['value', null],
  '--append-system-prompt': ['value', null],
  '--system-prompt': ['value', null],
  '--agent': ['value', null],
  '--agents': ['value', null],
  '--setting-sources': ['value', null],
  '--name': ['value', null],
  '-n': ['value', null],
  '--continue': ['bool', null],
  '-c': ['bool', null],
  '--fork-session': ['bool', null],
  '--verbose': ['bool', null],
  '--dangerously-skip-permissions': ['bool', null],
}

const COMMANDCODE_FLAGS: FlagTable = {
  '--model': ['value', 'model'],
  '-m': ['value', 'model'],
  '--effort': ['value', 'effort'],
  '--permission-mode': ['value', 'permissionMode'],
  '--mod': ['value', 'mods'],
  '--mod-option': ['value', 'modOptions'],
  '--list-models': ['bool', 'listModels'],
  '--trust': ['bool', 'trust'],
  '-t': ['bool', 'trust'],
  '--name': ['value', 'name'],
  '-n': ['value', 'name'],
  '--resume': ['value', 'resume'],
  '-r': ['value', 'resume'],
  '--help': ['bool', 'help'],
  '-h': ['bool', 'help'],
  '--version': ['bool', 'version'],
  '-v': ['bool', 'version'],
  '--session': ['value', null],
  '--fork-session': ['bool', null],
}

/** Parse the agent part of argv (fake-agent's options already removed). */
export function parseAgentArgv(flavour: Flavour, argv: readonly string[]): AgentArgs {
  const table = flavour === 'claude' ? CLAUDE_FLAGS : COMMANDCODE_FLAGS
  const fields: Record<string, string | boolean | string[]> = {}
  const extra: string[] = []
  const positionals: string[] = []
  let afterDashDash: string[] | null = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') {
      afterDashDash = argv.slice(i + 1)
      break
    }
    if (!a.startsWith('-') || a === '-') {
      positionals.push(a)
      continue
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const flag = eq > 0 ? a.slice(0, eq) : a
    const spec = table[flag]
    if (!spec) {
      extra.push(a) // unknown: a boolean, or `--flag=value` in one token
      continue
    }
    const [arity, field] = spec
    if (arity === 'bool') {
      if (field) fields[field] = true
      else extra.push(a)
      continue
    }
    const values: string[] = []
    if (eq > 0) values.push(a.slice(eq + 1))
    else {
      const v = argv[i + 1]
      if (v === undefined || (v.startsWith('-') && v !== '-')) throw new ArgvError(`error: option '${flag}' argument missing`)
      values.push(v)
      i++
      if (arity === 'variadic') {
        while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith('-')) values.push(argv[++i] as string)
      }
    }
    if (field === 'mods' || field === 'modOptions') fields[field] = [...((fields[field] as string[] | undefined) ?? []), ...values]
    else if (field) fields[field] = values[values.length - 1] as string
    else extra.push(...(eq > 0 ? [a] : [flag, ...values]))
  }

  const prompt = (afterDashDash ?? positionals).join(' ')
  if (afterDashDash && positionals.length > 0) extra.push(...positionals)
  const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : null)
  const common: CommonArgs = {
    model: str('model'),
    effort: str('effort'),
    permissionMode: str('permissionMode'),
    resume: str('resume'),
    extra,
    prompt,
    help: fields.help === true,
    version: fields.version === true,
  }

  if (flavour === 'claude') {
    const sessionId = str('sessionId')
    if (sessionId !== null && !UUID.test(sessionId)) throw new ArgvError('Error: Invalid session ID. Must be a valid UUID.')
    choice('--permission-mode', common.permissionMode, CLAUDE_PERMISSION_MODES)
    choice('--effort', common.effort, CLAUDE_EFFORTS)
    return { flavour, ...common, sessionId, settings: str('settings') }
  }
  choice('--permission-mode', common.permissionMode, COMMANDCODE_PERMISSION_MODES)
  choice('--effort', common.effort, COMMANDCODE_EFFORTS)
  const modOptions: Record<string, string> = {}
  for (const o of (fields.modOptions as string[] | undefined) ?? []) {
    const eq = o.indexOf('=')
    if (eq <= 0) throw new ArgvError(`error: --mod-option expects name=value, got '${o}'`)
    modOptions[o.slice(0, eq)] = o.slice(eq + 1)
  }
  return { flavour, ...common, mods: (fields.mods as string[] | undefined) ?? [], modOptions, trust: fields.trust === true, name: str('name'), listModels: fields.listModels === true }
}

function choice(flag: string, value: string | null, allowed: readonly string[]): void {
  if (value !== null && !allowed.includes(value)) {
    throw new ArgvError(`error: option '${flag}' argument '${value}' is invalid. Allowed choices are ${allowed.join(', ')}.`)
  }
}

export function parseArgv(argv: readonly string[], env: Record<string, string | undefined>): ParsedArgv {
  const { fake, rest } = splitFakeOptions(argv, env)
  return { fake, agentArgv: rest, agent: parseAgentArgv(fake.as, rest) }
}

/** The permission mode hook payloads report: `manual` is an alias of `default` and payloads say `"default"`. */
export function reportedPermissionMode(args: AgentArgs): string {
  const m = args.permissionMode
  if (args.flavour === 'claude') return m === null || m === 'manual' ? 'default' : m
  return m === null ? 'default' : (COMMANDCODE_REPORTED[m] ?? m)
}
