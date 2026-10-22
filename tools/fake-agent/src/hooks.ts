// Hooks, fired the way Claude Code fires them: the hook list comes from `--settings`; each matching `type: "command"`
// hook is exec'd as `command` + `args` (no shell), gets the JSON payload on stdin, and the agent waits for it to exit
// (synchronous delivery) within its `timeout` seconds. Payloads follow fixtures/hooks/claude/.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Json } from './scenario.ts'

/** Claude's default timeout for a command hook when the settings give none, in seconds. */
export const DEFAULT_HOOK_TIMEOUT_SEC = 60
/** Captured stdout/stderr per hook run (logged for tests, otherwise unused). */
const OUTPUT_CAP = 64 * 1024

export interface HookCommand {
  command: string
  /** Exec form when set; null means Claude would run `command` through a shell, which fake-agent does not do. */
  args: string[] | null
  timeoutSec: number
}

export interface HookGroup {
  matcher: string | null
  hooks: HookCommand[]
}

/** event → groups, as in the settings' `hooks` object. */
export type HookConfig = Record<string, HookGroup[]>

export class SettingsError extends Error {}

/** `--settings` takes inline JSON or a path to a JSON file, like Claude's. Only `hooks` is read. */
export function parseClaudeSettings(value: string, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): HookConfig {
  const text = value.trimStart().startsWith('{') ? value : readFile(value)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new SettingsError(`Invalid --settings: not JSON (${(e as Error).message})`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SettingsError('Invalid --settings: expected a JSON object')
  const hooks = (raw as Record<string, unknown>).hooks
  if (hooks === undefined) return {}
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) throw new SettingsError('Invalid --settings: hooks must be an object')
  const config: HookConfig = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new SettingsError(`Invalid --settings: hooks.${event} must be an array`)
    config[event] = groups.map((g, gi) => {
      const at = `hooks.${event}[${gi}]`
      if (typeof g !== 'object' || g === null || !Array.isArray((g as Record<string, unknown>).hooks)) throw new SettingsError(`Invalid --settings: ${at} needs a hooks array`)
      const group = g as { matcher?: unknown; hooks: unknown[] }
      if (group.matcher !== undefined && typeof group.matcher !== 'string') throw new SettingsError(`Invalid --settings: ${at}.matcher must be a string`)
      const cmds: HookCommand[] = []
      group.hooks.forEach((h, hi) => {
        const hat = `${at}.hooks[${hi}]`
        if (typeof h !== 'object' || h === null) throw new SettingsError(`Invalid --settings: ${hat} must be an object`)
        const o = h as Record<string, unknown>
        if (o.type !== 'command') return // prompt/agent hooks: not run by fake-agent
        if (typeof o.command !== 'string' || o.command === '') throw new SettingsError(`Invalid --settings: ${hat}.command must be a string`)
        if (o.args !== undefined && (!Array.isArray(o.args) || !o.args.every((a) => typeof a === 'string'))) throw new SettingsError(`Invalid --settings: ${hat}.args must be an array of strings`)
        if (o.timeout !== undefined && (typeof o.timeout !== 'number' || !(o.timeout > 0))) throw new SettingsError(`Invalid --settings: ${hat}.timeout must be a positive number`)
        cmds.push({ command: o.command, args: (o.args as string[] | undefined) ?? null, timeoutSec: (o.timeout as number | undefined) ?? DEFAULT_HOOK_TIMEOUT_SEC })
      })
      return { matcher: group.matcher ?? null, hooks: cmds }
    })
  }
  return config
}

/**
 * Claude's `disableAllHooks: true`: in the user's settings (`<config dir>/settings.json`, the config dir being
 * CLAUDE_CONFIG_DIR or `<home>/.claude`) or the project's (`<cwd>/.claude/settings.json`, `settings.local.json`), it
 * turns off every hook, the inline `--settings` ones included; an inline `disableAllHooks: false` would turn them back
 * on. Returns the file that disabled them, or null. Unreadable or non-JSON files count as not saying so; a null
 * `configDir` (the account's real one) is not read.
 */
export function hooksDisabledBy(o: { configDir: string | null; cwd: string; inline: string | null }, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  const says = (text: string): boolean | undefined => {
    try {
      const v = JSON.parse(text) as unknown
      return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Record<string, unknown>).disableAllHooks === 'boolean' ? ((v as Record<string, unknown>).disableAllHooks as boolean) : undefined
    } catch {
      return undefined
    }
  }
  if (o.inline !== null && o.inline.trimStart().startsWith('{') && says(o.inline) === false) return null
  for (const f of [...(o.configDir ? [`${o.configDir}/settings.json`] : []), `${o.cwd}/.claude/settings.json`, `${o.cwd}/.claude/settings.local.json`]) {
    let text: string
    try {
      text = readFile(f)
    } catch {
      continue
    }
    if (says(text) === true) return f
  }
  return null
}

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])

/** The payload field a group's `matcher` is tested against, per event; null: the matcher is ignored. */
function matchField(event: string): string | null {
  if (TOOL_EVENTS.has(event)) return 'tool_name'
  switch (event) {
    case 'SessionStart':
      return 'source'
    case 'Notification':
      return 'notification_type'
    case 'PreCompact':
    case 'PostCompact':
      return 'trigger'
    case 'SessionEnd':
      return 'reason'
    case 'SubagentStart':
    case 'SubagentStop':
      return 'agent_type'
    default:
      return null
  }
}

/** The hooks to run for an event, in settings order. A matcher is a regex over the whole field (`Edit|Write`). */
export function selectHooks(config: HookConfig, event: string, payload: Record<string, unknown>): HookCommand[] {
  const field = matchField(event)
  const out: HookCommand[] = []
  for (const g of config[event] ?? []) {
    if (field !== null && g.matcher !== null && g.matcher !== '' && g.matcher !== '*') {
      let re: RegExp
      try {
        re = new RegExp(`^(?:${g.matcher})$`)
      } catch {
        continue
      }
      if (!re.test(String(payload[field] ?? ''))) continue
    }
    out.push(...g.hooks)
  }
  return out
}

export interface RunResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  ms: number
  timedOut: boolean
  /** Spawn failure (ENOENT, EACCES, …). */
  error: string | null
}

/** Run a program without a shell, feed `input` on stdin, wait for it (killing it after `timeoutMs`). */
export function runCommand(file: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<RunResult> {
  const t0 = performance.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (r: Omit<RunResult, 'stdout' | 'stderr' | 'ms' | 'timedOut'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...r, stdout, stderr, ms: performance.now() - t0, timedOut })
    }
    const child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.slice(0, OUTPUT_CAP - stdout.length)
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.slice(0, OUTPUT_CAP - stderr.length)
    })
    child.stdin.on('error', () => {}) // a hook that does not read its stdin: EPIPE is fine
    child.on('error', (e) => finish({ exitCode: null, signal: null, error: e.message }))
    child.on('close', (code, signal) => finish({ exitCode: code, signal, error: null }))
    child.stdin.end(opts.input)
  })
}

export interface HookFireOptions {
  tool: string | null
  input: Json | null
  fields: Record<string, Json>
}

export interface HookRun extends RunResult {
  command: string
  args: string[]
}

/** Where the runner sends `hook` steps: Claude settings hooks or Command Code mods. */
export interface HookSink {
  fire(event: string, opts: HookFireOptions): Promise<{ payload: Record<string, unknown>; runs: HookRun[] }>
}

export interface ClaudeSessionInfo {
  sessionId: string
  transcriptPath: string
  cwd: string
  permissionMode: string
  model: string
  /** The effort level tool events and Stop report (`effort.level`, 2.1.296); Claude's default is `medium`. */
  effort?: string
  /** SessionStart's source: `resume` when started with --resume. */
  source: string
}

/** Events whose 2.1.296 payloads carry `effort: { level }` (fixtures/hooks/claude/2.1.296). */
const EFFORT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'SubagentStop'])

/** Merge step fields over a payload; a field set to null removes it. */
export function mergeFields(payload: Record<string, unknown>, fields: Record<string, Json>): Record<string, unknown> {
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) delete payload[k]
    else payload[k] = v
  }
  return payload
}

/** Builds Claude-shaped payloads and runs the configured hooks for them. */
export class ClaudeHooks implements HookSink {
  private toolSeq = 0
  private lastTool: { name: string; input: Json; id: string } | null = null
  private readonly config: HookConfig
  private readonly info: ClaudeSessionInfo
  private readonly env: NodeJS.ProcessEnv
  /** A SessionStart that reported another session id (/clear): later payloads carry it, and so does the status file. */
  onSessionId: ((id: string) => void) | null = null

  constructor(config: HookConfig, info: ClaudeSessionInfo, env: NodeJS.ProcessEnv) {
    this.config = config
    this.info = { ...info }
    this.env = env
  }

  /** The JSON Claude would send for this event. */
  payload(event: string, opts: HookFireOptions): Record<string, unknown> {
    const i = this.info
    const p: Record<string, unknown> = { session_id: i.sessionId, transcript_path: i.transcriptPath, cwd: i.cwd }
    if (event !== 'SessionStart' && event !== 'SessionEnd') p.permission_mode = i.permissionMode
    p.hook_event_name = event
    const tool = () => {
      if (event === 'PreToolUse') {
        this.lastTool = { name: opts.tool ?? 'Bash', input: opts.input ?? {}, id: `toolu_fake_${String(++this.toolSeq).padStart(4, '0')}` }
        return this.lastTool
      }
      const last = this.lastTool
      const name = opts.tool ?? last?.name ?? 'Bash'
      const input = opts.input ?? (last && last.name === name ? last.input : {})
      const id = last && last.name === name ? last.id : `toolu_fake_${String(++this.toolSeq).padStart(4, '0')}`
      return { name, input, id }
    }
    switch (event) {
      case 'SessionStart':
        p.source = i.source
        p.model = i.model
        break
      case 'UserPromptSubmit':
        break // `prompt` comes from the runner (fields)
      case 'PreToolUse': {
        const t = tool()
        Object.assign(p, { tool_name: t.name, tool_input: t.input, tool_use_id: t.id })
        break
      }
      case 'PostToolUse': {
        const t = tool()
        Object.assign(p, { tool_name: t.name, tool_input: t.input, tool_response: {}, tool_use_id: t.id })
        break
      }
      case 'PostToolUseFailure': {
        const t = tool()
        Object.assign(p, { tool_name: t.name, tool_input: t.input, tool_use_id: t.id, error: 'fake failure', is_interrupt: false })
        break
      }
      case 'PermissionRequest': {
        const t = tool()
        Object.assign(p, { tool_name: t.name, tool_input: t.input, permission_suggestions: [] }) // no tool_use_id here
        break
      }
      case 'PermissionDenied': {
        const t = tool()
        Object.assign(p, { tool_name: t.name, tool_input: t.input, tool_use_id: t.id, reason: 'denied by auto mode' })
        break
      }
      case 'Notification':
        Object.assign(p, { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
        break
      case 'Stop':
        Object.assign(p, { stop_hook_active: false, last_assistant_message: '', background_tasks: [], session_crons: [] })
        break
      case 'StopFailure':
        Object.assign(p, { error: 'rate_limit', last_assistant_message: '' })
        break
      case 'SubagentStart':
      case 'SubagentStop':
        Object.assign(p, { agent_id: 'agent_fake_1', agent_type: 'general-purpose' })
        break
      case 'PreCompact':
        Object.assign(p, { trigger: 'auto', custom_instructions: '' })
        break
      case 'PostCompact':
        Object.assign(p, { trigger: 'auto' })
        break
      case 'SessionEnd':
        p.reason = 'other'
        break
    }
    if (EFFORT_EVENTS.has(event)) p.effort = { level: i.effort ?? 'medium' }
    return mergeFields(p, opts.fields)
  }

  async fire(event: string, opts: HookFireOptions): Promise<{ payload: Record<string, unknown>; runs: HookRun[] }> {
    const payload = this.payload(event, opts)
    if (event === 'SessionStart' && typeof payload.session_id === 'string' && payload.session_id !== this.info.sessionId) {
      this.info.sessionId = payload.session_id
      if (typeof payload.transcript_path === 'string') this.info.transcriptPath = payload.transcript_path
      this.onSessionId?.(payload.session_id)
    }
    const input = JSON.stringify(payload)
    const env = { ...this.env, CLAUDE_PROJECT_DIR: this.info.cwd, CLAUDE_CODE_SESSION_ID: this.info.sessionId }
    const runs: HookRun[] = []
    for (const h of selectHooks(this.config, event, payload)) {
      const args = h.args ?? []
      const r = await runCommand(h.command, args, { cwd: this.info.cwd, env, input, timeoutMs: h.timeoutSec * 1000 })
      runs.push({ ...r, command: h.command, args })
    }
    return { payload, runs }
  }
}
