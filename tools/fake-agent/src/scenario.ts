// Scenario files (YAML or JSON): the schema, its validator, and the default scenarios. A scenario is checked whole
// before anything runs; every problem is reported with its path (`steps[3].hook.event: …`). README.md documents it.

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import { parse as parseYaml, YAMLParseError } from 'yaml'
import type { Flavour } from './argv.ts'
import { normaliseKeyName, type Key } from './keys.ts'
import { isProbeId, PROBE_IDS, type ProbeId } from './probes.ts'

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export const CLAUDE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact',
  'PostCompact', 'SessionEnd',
] as const
/**
 * Command Code mod events (the names 1.79.2 delivers); fake-agent hands them to the `--mod` modules it loaded.
 * `session_start` and `session_shutdown` also call the mods' `onSessionStart` / `onSessionEnd` hooks.
 */
export const COMMANDCODE_EVENTS = [
  'session_start', 'run_start', 'turn_start', 'message_start', 'model_request_start', 'model_request_end', 'message_end',
  'tool_queued', 'tool_running', 'tool_completed', 'tool_errored', 'tool_denied', 'tool_hook_blocked', 'turn_end', 'run_end',
  'interrupted', 'run_error', 'session_titled', 'permission_mode_changed', 'compaction_start', 'compaction_done', 'session_shutdown',
] as const

export const RECORD_KINDS = {
  claude: ['user', 'assistant', 'interrupt', 'ai-title', 'custom-title', 'cost-state', 'raw'],
  commandcode: ['user', 'assistant', 'error', 'title', 'raw'],
} as const
export type RecordKind = (typeof RECORD_KINDS)['claude'][number] | (typeof RECORD_KINDS)['commandcode'][number]

export const FILE_OPS = ['write', 'append', 'modify', 'delete', 'rename', 'mkdir'] as const
export type FileOp = (typeof FILE_OPS)[number]

/** Names usable as `{{name}}` in any text a step writes. */
export const TEMPLATE_VARS = ['cols', 'rows', 'i', 'sessionId', 'cwd', 'model', 'prompt', 'line', 'key', 'argvHash', 'flavour', 'permissionMode', 'transcriptPath'] as const

interface At {
  /** Where the step is, for runtime errors: `steps[2].loop.steps[0]`. */
  at: string
}

export type Step = At &
  (
    | { kind: 'probe'; queries: ProbeId[]; timeoutMs: number }
    | { kind: 'altScreen'; enter: boolean }
    | { kind: 'frame'; lines: string[]; sync: boolean }
    | { kind: 'print'; text: string }
    | { kind: 'title'; text: string; osc: 0 | 2 }
    | { kind: 'bell' }
    | { kind: 'notify'; osc: 9 | 777; title: string; body: string }
    | { kind: 'wait'; mode: 'key' | 'line' | 'answer'; answer: string | null; timeoutMs: number | null; echo: boolean }
    | { kind: 'choose'; branches: { key: Key; steps: Step[] }[] }
    | { kind: 'hook'; event: string; tool: string | null; input: Json | null; fields: Record<string, Json> }
    | { kind: 'transcript'; record: RecordKind; text: string | null; title: string | null; costUsd: number | null; forToolUse: boolean; json: Json | null; fields: Record<string, Json> }
    | { kind: 'file'; op: FileOp; path: string; to: string | null; content: string | null; find: string | null; replace: string | null }
    | { kind: 'argvHash' }
    | { kind: 'cassette'; file: string; speed: number; maxIdleMs: number | null }
    | { kind: 'sleep'; ms: number }
    | { kind: 'exit'; code: number; reason: string }
    | { kind: 'loop'; times: number | 'forever'; steps: Step[] }
    | { kind: 'status'; op: 'set' | 'torn' | 'remove' | 'sessionId'; status: string | null; waitingFor: string | null; sessionId: string | null }
  )

export type StepKind = Step['kind']
export const STEP_KINDS: readonly StepKind[] = ['probe', 'altScreen', 'frame', 'print', 'title', 'bell', 'notify', 'wait', 'choose', 'hook', 'transcript', 'file', 'argvHash', 'cassette', 'sleep', 'exit', 'loop', 'status']
/** Steps that may be written as a bare string (`- bell`). */
const BARE: readonly StepKind[] = ['bell', 'argvHash', 'exit']

export interface Scenario {
  name: string
  steps: Step[]
  /** Steps run for each line typed at the idle prompt (`{{line}}` and `{{prompt}}` hold it); null: lines are only echoed. */
  onLine: Step[] | null
  /** Steps run when Esc or Ctrl-C interrupts a turn; null: Ctrl-C ends the agent, Esc is an ordinary key. */
  onInterrupt: Step[] | null
  /** After the steps: wait at an idle prompt, or exit (code 0). */
  afterSteps: 'idle' | 'exit'
  /** Fire SessionStart (Command Code: session_start) at startup. Off: withhold it, as an agent awaiting trust does. */
  fireSessionStart: boolean
  /** Fire SessionEnd (session_shutdown) on every graceful end: exit step, SIGTERM/SIGHUP/SIGINT, Ctrl-C/Ctrl-D, EOF. */
  fireSessionEnd: boolean
  /** Claude: write a `cost-state` transcript record at every graceful end, as Claude does at exit. */
  exitCostUsd: number | null
  /**
   * Claude's live status file (status.ts): `auto` (default for claude) follows the hooks the way 2.1.296 does, `manual`
   * writes only what `status` steps say, `off` (Command Code's only choice) writes nothing.
   */
  statusFile: 'auto' | 'manual' | 'off'
  /** Cassette paths resolve against this (the scenario file's directory). */
  baseDir: string
}

export class ScenarioError extends Error {
  readonly problems: string[]
  constructor(source: string, problems: string[]) {
    super(`${source}: invalid scenario\n${problems.map((p) => `  ${p}`).join('\n')}`)
    this.problems = problems
  }
}

const TOP_KEYS = ['version', 'name', 'flavour', 'steps', 'onLine', 'onInterrupt', 'afterSteps', 'fireSessionStart', 'fireSessionEnd', 'exitCostUsd', 'statusFile']
const MAX_DEPTH = 16

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

class Checker {
  readonly problems: string[] = [] // bounded: one entry per problem in one scenario file
  readonly flavour: Flavour
  constructor(flavour: Flavour) {
    this.flavour = flavour
  }

  bad(at: string, msg: string): void {
    this.problems.push(`${at}: ${msg}`)
  }

  template(at: string, s: string): string {
    for (const m of s.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
      if (!(TEMPLATE_VARS as readonly string[]).includes(m[1] as string)) this.bad(at, `unknown template variable {{${m[1]}}} (known: ${TEMPLATE_VARS.join(', ')})`)
    }
    return s
  }

  str(at: string, v: unknown, opts: { template?: boolean; nonEmpty?: boolean } = {}): string {
    if (typeof v !== 'string') {
      this.bad(at, `expected a string, got ${describe(v)}`)
      return ''
    }
    if (opts.nonEmpty && v === '') this.bad(at, 'must not be empty')
    return opts.template === false ? v : this.template(at, v)
  }

  optStr(at: string, v: unknown, template = true): string | null {
    return v === undefined || v === null ? null : this.str(at, v, { template })
  }

  int(at: string, v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.bad(at, `expected an integer ${min}…${max === Number.MAX_SAFE_INTEGER ? '' : max}, got ${describe(v)}`)
      return min
    }
    return v
  }

  num(at: string, v: unknown, min: number): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
      this.bad(at, `expected a number ≥ ${min}, got ${describe(v)}`)
      return min
    }
    return v
  }

  bool(at: string, v: unknown, dflt: boolean): boolean {
    if (v === undefined) return dflt
    if (typeof v !== 'boolean') {
      this.bad(at, `expected true or false, got ${describe(v)}`)
      return dflt
    }
    return v
  }

  oneOf<T extends string>(at: string, v: unknown, allowed: readonly T[]): T {
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.bad(at, `expected one of ${allowed.join(', ')}, got ${describe(v)}`)
      return allowed[0] as T
    }
    return v as T
  }

  keys(at: string, o: Obj, allowed: readonly string[]): void {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.bad(`${at}.${k}`, `unknown field (allowed: ${allowed.join(', ')})`)
  }

  json(at: string, v: unknown): Json {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return typeof v === 'string' ? this.template(at, v) : v
    if (typeof v === 'number') return v
    if (Array.isArray(v)) return v.map((x, i) => this.json(`${at}[${i}]`, x))
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.json(`${at}.${k}`, x)]))
    this.bad(at, `expected JSON data, got ${describe(v)}`)
    return null
  }

  fields(at: string, v: unknown): Record<string, Json> {
    if (v === undefined) return {}
    if (!isObj(v)) {
      this.bad(at, `expected a mapping, got ${describe(v)}`)
      return {}
    }
    return this.json(at, v) as Record<string, Json>
  }

  relPath(at: string, v: unknown): string {
    const p = this.str(at, v, { nonEmpty: true })
    if (isAbsolute(p)) this.bad(at, 'must be relative to the working directory')
    else if (normalize(p).split(/[\\/]/).includes('..')) this.bad(at, 'must stay inside the working directory (no ..)')
    return p
  }

  steps(at: string, v: unknown, depth: number): Step[] {
    if (!Array.isArray(v)) {
      this.bad(at, `expected a list of steps, got ${describe(v)}`)
      return []
    }
    if (depth > MAX_DEPTH) {
      this.bad(at, `steps nested deeper than ${MAX_DEPTH}`)
      return []
    }
    return v.flatMap((s, i) => {
      const step = this.step(`${at}[${i}]`, s, depth)
      return step ? [step] : []
    })
  }

  step(at: string, raw: unknown, depth: number): Step | null {
    let kind: string
    let v: unknown
    if (typeof raw === 'string') {
      kind = raw
      v = undefined
      if (!(BARE as readonly string[]).includes(raw)) {
        this.bad(at, (STEP_KINDS as readonly string[]).includes(raw) ? `"${raw}" needs a value: write { ${raw}: … }` : `unknown step "${raw}" (steps: ${STEP_KINDS.join(', ')})`)
        return null
      }
    } else if (isObj(raw)) {
      const ks = Object.keys(raw)
      if (ks.length !== 1) {
        this.bad(at, `a step has exactly one key (its kind), got ${ks.length ? ks.join(', ') : 'none'}`)
        return null
      }
      kind = ks[0] as string
      v = raw[kind]
      if (!(STEP_KINDS as readonly string[]).includes(kind)) {
        this.bad(at, `unknown step "${kind}" (steps: ${STEP_KINDS.join(', ')})`)
        return null
      }
    } else {
      this.bad(at, `expected a step, got ${describe(raw)}`)
      return null
    }
    const here = `${at}.${kind}`
    const k = kind as StepKind
    switch (k) {
      case 'probe': {
        const o = isObj(v) ? v : { queries: v }
        this.keys(here, o, ['queries', 'timeoutMs'])
        const list = Array.isArray(o.queries) ? o.queries : []
        if (!Array.isArray(o.queries) || list.length === 0) this.bad(here, 'expected a non-empty list of probes')
        const queries = list.flatMap((q, i) => {
          if (typeof q === 'string' && isProbeId(q)) return [q]
          this.bad(`${here}[${i}]`, `unknown probe ${describe(q)} (probes: ${PROBE_IDS.join(', ')})`)
          return []
        })
        return { at, kind: k, queries, timeoutMs: o.timeoutMs === undefined ? 1000 : this.int(`${here}.timeoutMs`, o.timeoutMs, 1) }
      }
      case 'altScreen':
        return { at, kind: k, enter: this.oneOf(here, v, ['enter', 'leave']) === 'enter' }
      case 'frame': {
        const o = isObj(v) ? v : { lines: v }
        this.keys(here, o, ['lines', 'sync'])
        const lines = Array.isArray(o.lines) ? o.lines.map((l, i) => this.str(`${here}.lines[${i}]`, l)) : [this.str(`${here}.lines`, o.lines)]
        return { at, kind: k, lines, sync: this.bool(`${here}.sync`, o.sync, true) }
      }
      case 'print':
        return { at, kind: k, text: this.str(here, v) }
      case 'title': {
        const o = isObj(v) ? v : { text: v }
        this.keys(here, o, ['text', 'osc'])
        return { at, kind: k, text: this.str(`${here}.text`, o.text), osc: o.osc === undefined ? 2 : (this.oneOf(`${here}.osc`, String(o.osc), ['0', '2']) === '0' ? 0 : 2) }
      }
      case 'bell':
        if (v !== undefined && v !== true) this.bad(here, 'write `- bell`')
        return { at, kind: k }
      case 'notify': {
        const o = isObj(v) ? v : { body: v }
        this.keys(here, o, ['body', 'title', 'osc'])
        const osc = o.osc === undefined ? '9' : this.oneOf(`${here}.osc`, String(o.osc), ['9', '777'])
        return { at, kind: k, osc: osc === '777' ? 777 : 9, title: o.title === undefined ? 'fake-agent' : this.str(`${here}.title`, o.title), body: this.str(`${here}.body`, o.body) }
      }
      case 'wait': {
        const o = isObj(v) ? v : { for: v }
        this.keys(here, o, ['for', 'answer', 'timeoutMs', 'echo'])
        const mode = o.answer !== undefined && o.for === undefined ? 'answer' : this.oneOf(`${here}.for`, o.for, ['key', 'line', 'answer'])
        let answer: string | null = null
        if (mode === 'answer') {
          const a = this.str(`${here}.answer`, o.answer, { template: false })
          const key = normaliseKeyName(a)
          if (key === null) this.bad(`${here}.answer`, `expected one character or a key name (${['space', 'esc', 'enter', 'tab'].join(', ')}, …), got "${a}"`)
          answer = key ?? a
        }
        return {
          at,
          kind: k,
          mode,
          answer,
          timeoutMs: o.timeoutMs === undefined ? null : this.int(`${here}.timeoutMs`, o.timeoutMs, 1),
          echo: this.bool(`${here}.echo`, o.echo, true),
        }
      }
      case 'choose': {
        if (!isObj(v) || Object.keys(v).length === 0) {
          this.bad(here, 'expected a mapping of key → steps, e.g. { y: [...], n: [...] }')
          return null
        }
        const branches = Object.entries(v).flatMap(([name, steps]) => {
          const key = normaliseKeyName(name)
          if (key === null) {
            this.bad(`${here}.${name}`, 'not a key: one character or a key name (enter, esc, tab, space, up, down, …)')
            return []
          }
          return [{ key, steps: this.steps(`${here}.${name}`, steps, depth + 1) }]
        })
        return { at, kind: k, branches }
      }
      case 'hook': {
        const o = isObj(v) ? v : { event: v }
        this.keys(here, o, ['event', 'tool', 'input', 'fields'])
        const events = this.flavour === 'claude' ? CLAUDE_EVENTS : COMMANDCODE_EVENTS
        const event = this.oneOf(`${here}.event`, o.event, events)
        return {
          at,
          kind: k,
          event,
          tool: this.optStr(`${here}.tool`, o.tool),
          input: o.input === undefined ? null : this.json(`${here}.input`, o.input),
          fields: this.fields(`${here}.fields`, o.fields),
        }
      }
      case 'transcript': {
        const o = isObj(v) ? v : { record: v }
        this.keys(here, o, ['record', 'text', 'title', 'costUsd', 'forToolUse', 'json', 'fields'])
        const kinds = RECORD_KINDS[this.flavour] as readonly RecordKind[]
        const record = this.oneOf(`${here}.record`, o.record, kinds)
        if (!kinds.includes(o.record as RecordKind)) return null
        if ((record === 'user' || record === 'assistant' || record === 'error') && o.text === undefined) this.bad(`${here}.text`, `a ${record} record needs text`)
        if ((record === 'ai-title' || record === 'custom-title' || record === 'title') && o.title === undefined) this.bad(`${here}.title`, `a ${record} record needs a title`)
        if (record === 'cost-state' && o.costUsd === undefined) this.bad(`${here}.costUsd`, 'a cost-state record needs costUsd')
        if (record === 'raw' && !isObj(o.json)) this.bad(`${here}.json`, 'a raw record needs a json mapping')
        return {
          at,
          kind: k,
          record,
          text: this.optStr(`${here}.text`, o.text),
          title: this.optStr(`${here}.title`, o.title),
          costUsd: o.costUsd === undefined ? null : this.num(`${here}.costUsd`, o.costUsd, 0),
          forToolUse: this.bool(`${here}.forToolUse`, o.forToolUse, false),
          json: o.json === undefined ? null : this.json(`${here}.json`, o.json),
          fields: this.fields(`${here}.fields`, o.fields),
        }
      }
      case 'file': {
        if (!isObj(v)) {
          this.bad(here, 'expected { op, path, … }')
          return null
        }
        this.keys(here, v, ['op', 'path', 'to', 'content', 'find', 'replace'])
        const op = this.oneOf(`${here}.op`, v.op, FILE_OPS)
        const step = {
          at,
          kind: k,
          op,
          path: this.relPath(`${here}.path`, v.path),
          to: v.to === undefined ? null : this.relPath(`${here}.to`, v.to),
          content: this.optStr(`${here}.content`, v.content),
          find: this.optStr(`${here}.find`, v.find),
          replace: this.optStr(`${here}.replace`, v.replace),
        }
        if ((op === 'write' || op === 'append') && step.content === null) this.bad(`${here}.content`, `${op} needs content`)
        if (op === 'modify' && (step.find === null || step.replace === null)) this.bad(here, 'modify needs find and replace')
        if (op === 'rename' && step.to === null) this.bad(`${here}.to`, 'rename needs to')
        return step
      }
      case 'argvHash':
        if (v !== undefined && v !== true) this.bad(here, 'write `- argvHash`')
        return { at, kind: k }
      case 'cassette': {
        const o = isObj(v) ? v : { file: v }
        this.keys(here, o, ['file', 'speed', 'maxIdleMs'])
        return {
          at,
          kind: k,
          file: this.str(`${here}.file`, o.file, { template: false, nonEmpty: true }),
          speed: o.speed === undefined ? 1 : this.num(`${here}.speed`, o.speed, 0),
          maxIdleMs: o.maxIdleMs === undefined ? null : this.int(`${here}.maxIdleMs`, o.maxIdleMs, 0),
        }
      }
      case 'sleep':
        return { at, kind: k, ms: this.int(here, v, 0) }
      case 'exit': {
        const o = isObj(v) ? v : { code: v ?? 0 }
        this.keys(here, o, ['code', 'reason'])
        return { at, kind: k, code: this.int(`${here}.code`, o.code ?? 0, 0, 255), reason: o.reason === undefined ? 'prompt_input_exit' : this.str(`${here}.reason`, o.reason, { template: false }) }
      }
      case 'loop': {
        if (!isObj(v)) {
          this.bad(here, 'expected { times: N, steps: [...] } or { forever: true, steps: [...] }')
          return null
        }
        this.keys(here, v, ['times', 'forever', 'steps'])
        let times: number | 'forever'
        if (v.forever === true && v.times === undefined) times = 'forever'
        else times = this.int(`${here}.times`, v.times, 1)
        return { at, kind: k, times, steps: this.steps(`${here}.steps`, v.steps, depth + 1) }
      }
      case 'status': {
        if (this.flavour !== 'claude') this.bad(here, 'only for --as claude (the live status file is Claude’s)')
        const none = { status: null, waitingFor: null, sessionId: null }
        if (typeof v === 'string') return { at, kind: k, op: 'set', ...none, status: this.str(here, v, { template: false, nonEmpty: true }) }
        if (!isObj(v)) {
          this.bad(here, 'expected a status (busy, waiting, idle, shell, …) or { status, waitingFor } · { torn: true } · { removed: true } · { sessionId }')
          return null
        }
        this.keys(here, v, ['status', 'waitingFor', 'torn', 'removed', 'sessionId'])
        if (v.torn === true) return { at, kind: k, op: 'torn', ...none }
        if (v.removed === true) return { at, kind: k, op: 'remove', ...none }
        if (v.sessionId !== undefined) return { at, kind: k, op: 'sessionId', ...none, sessionId: this.str(`${here}.sessionId`, v.sessionId, { nonEmpty: true }) }
        return {
          at,
          kind: k,
          op: 'set',
          ...none,
          status: this.str(`${here}.status`, v.status, { template: false, nonEmpty: true }),
          waitingFor: v.waitingFor === undefined ? null : this.str(`${here}.waitingFor`, v.waitingFor, { template: false }),
        }
      }
    }
  }
}

function describe(v: unknown): string {
  if (v === undefined) return 'nothing'
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'a list'
  if (typeof v === 'object') return 'a mapping'
  return `${typeof v} ${JSON.stringify(v)}`
}

/** Check parsed scenario data. Throws ScenarioError listing every problem. */
export function validateScenario(raw: unknown, opts: { flavour: Flavour; baseDir: string; source?: string }): Scenario {
  const source = opts.source ?? 'scenario'
  const c = new Checker(opts.flavour)
  if (!isObj(raw)) throw new ScenarioError(source, [`expected a mapping with version and steps, got ${describe(raw)}`])
  c.keys('scenario', raw, TOP_KEYS)
  if (raw.version !== 1) c.bad('version', `must be 1, got ${describe(raw.version)}`)
  if (raw.flavour !== undefined && raw.flavour !== opts.flavour) c.bad('flavour', `scenario is for ${describe(raw.flavour)} but fake-agent runs --as ${opts.flavour}`)
  const scenario: Scenario = {
    name: raw.name === undefined ? source : c.str('name', raw.name, { template: false }),
    steps: c.steps('steps', raw.steps, 0),
    onLine: raw.onLine === undefined ? null : c.steps('onLine', raw.onLine, 0),
    onInterrupt: raw.onInterrupt === undefined ? null : c.steps('onInterrupt', raw.onInterrupt, 0),
    afterSteps: raw.afterSteps === undefined ? 'idle' : c.oneOf('afterSteps', raw.afterSteps, ['idle', 'exit']),
    fireSessionStart: c.bool('fireSessionStart', raw.fireSessionStart, true),
    fireSessionEnd: c.bool('fireSessionEnd', raw.fireSessionEnd, true),
    exitCostUsd: raw.exitCostUsd === undefined ? null : c.num('exitCostUsd', raw.exitCostUsd, 0),
    statusFile: raw.statusFile === undefined ? (opts.flavour === 'claude' ? 'auto' : 'off') : c.oneOf('statusFile', raw.statusFile, ['auto', 'manual', 'off']),
    baseDir: opts.baseDir,
  }
  if (scenario.statusFile !== 'off' && opts.flavour !== 'claude') c.bad('statusFile', 'only for --as claude (the live status file is Claude’s)')
  if (scenario.exitCostUsd !== null && opts.flavour !== 'claude') c.bad('exitCostUsd', 'only for --as claude (Command Code has no cost-state record)')
  if (c.problems.length > 0) throw new ScenarioError(source, c.problems)
  return scenario
}

/** Parse YAML/JSON text and validate it. */
export function parseScenario(text: string, opts: { flavour: Flavour; baseDir: string; source?: string }): Scenario {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (e) {
    const msg = e instanceof YAMLParseError ? e.message : String(e)
    throw new ScenarioError(opts.source ?? 'scenario', [`not valid YAML: ${msg}`])
  }
  return validateScenario(raw, opts)
}

export function loadScenarioFile(file: string, flavour: Flavour, cwd: string): Scenario {
  const path = resolve(cwd, file)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new ScenarioError(file, [`cannot read: ${(e as Error).message}`])
  }
  return parseScenario(text, { flavour, baseDir: dirname(path), source: file })
}

// ── defaults: one short, realistic turn, then an idle prompt that runs another turn per typed line ────────────────

const CLAUDE_TURN = `
  - hook: UserPromptSubmit
  - transcript: { record: user, text: "{{prompt}}" }
  - frame: ["✻ fake-agent · {{model}}", "", "> {{prompt}}", "", "✶ Working…  (esc to interrupt)"]
  - sleep: 40
  - hook: { event: PreToolUse, tool: Bash, input: { command: "ls", description: "List files" } }
  - hook: { event: PostToolUse, tool: Bash, input: { command: "ls", description: "List files" } }
  - transcript: { record: assistant, text: "Done: listed the files." }
  - hook: { event: Stop, fields: { last_assistant_message: "Done: listed the files." } }
  - transcript: { record: ai-title, title: "Fake agent turn" }
  - title: "✳ Fake agent turn"
  - frame: ["✻ fake-agent · {{model}}", "", "> {{prompt}}", "", "⏺ Done: listed the files.", "", "> "]
`

/** One Command Code turn, its events in the order 1.79.2 emits them; the records are written when the step commits. */
const COMMANDCODE_TURN = `
  - hook: run_start
  - hook: turn_start
  - hook: message_start
  - hook: model_request_start
  - frame: ["fake-agent · {{model}}", "", "> {{prompt}}", "", "Working…"]
  - sleep: 40
  - hook: model_request_end
  - hook: message_end
  - hook: { event: tool_queued, tool: shell_command, input: { command: "ls", description: "List files" } }
  - hook: { event: tool_running, tool: shell_command }
  - hook: { event: tool_completed, tool: shell_command }
  - hook: turn_end
  - transcript: { record: user, text: "{{prompt}}" }
  - transcript: { record: assistant, text: "Done: listed the files." }
  - hook: { event: run_end, fields: { result: { finalText: "Done: listed the files." } } }
  - frame: ["fake-agent · {{model}}", "", "> {{prompt}}", "", "Done: listed the files.", "", "> "]
`

export const DEFAULT_SCENARIOS: Record<Flavour, string> = {
  claude: `
version: 1
name: default (claude)
steps:
  - probe: [decrqm-2026, kitty, osc11]
  - altScreen: enter
  - title: "✳ fake-agent"
  - argvHash
${CLAUDE_TURN}
onLine:
${CLAUDE_TURN}
onInterrupt:
  - transcript: { record: interrupt }
  - frame: ["✻ fake-agent · {{model}}", "", "  ⎿  Interrupted by user", "", "> "]
`,
  commandcode: `
version: 1
name: default (commandcode)
steps:
  - probe: [decrqm-2026, kitty, osc11]
  - altScreen: enter
  - title: "fake-agent (commandcode)"
  - argvHash
${COMMANDCODE_TURN}
  - hook: { event: session_titled, fields: { title: "Fake agent turn" } }
  - transcript: { record: title, title: "Fake agent turn" }
onLine:
${COMMANDCODE_TURN}
onInterrupt:
  - hook: interrupted
  - hook: { event: run_end, fields: { result: { stopReason: interrupted, finalText: "" } } }
  - frame: ["fake-agent · {{model}}", "", "Interrupted.", "", "> "]
`,
}

export function defaultScenario(flavour: Flavour, cwd: string): Scenario {
  return parseScenario(DEFAULT_SCENARIOS[flavour], { flavour, baseDir: cwd, source: `default scenario (${flavour})` })
}
