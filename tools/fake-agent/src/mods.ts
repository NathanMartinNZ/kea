// Command Code's hook path is a mod: Kea passes `--mod <kea-mod.ts>` and `--mod-option kea=…`, and the mod subscribes
// with `cmd.on(event, …)` and registers session hooks with `cmd.hooks({…})`. fake-agent hosts mods with a `cmd` object
// of the shape Command Code 1.79.2 gives them, and events in its shapes as recorded in
// fixtures/hooks/commandcode/1.79.2/mod-events.*.jsonl:
//
//   cmd.addFlag(name, {type, default})   declares an option; `cmd.getFlag(name)` answers its default until the session
//                                        is bound (the first `session_start`), then the `--mod-option name=value` given
//   cmd.on(event, handler)               handlers run in registration order, synchronously: a handler that blocks
//                                        (kea-mod.ts runs kea-helper and waits) holds the agent, as in the real CLI
//   cmd.hooks({onSessionStart, onSessionEnd})   the only place the session id and the end's reason appear
//   cmd.exec({command, args})            runs a program without a shell
//
// A handler or hook that throws is recorded and never ends the agent.
//
// The host fires what the scenario says, in the scenario's order: it knows nothing of how the CLI orders a batch of
// tool calls. A scenario that has one writes it as 1.79.2 does (README.md, "Hooks"): every `tool_queued`, then a
// `wait` per prompt, `tool_denied` at each refusal, and after a refusal no `tool_running` but the run's end. A tool
// event names its call by tool name (the last one queued with that name), so a batch's calls have different tools.

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type HookFireOptions, type HookRun, type HookSink, runCommand, type RunResult } from './hooks.ts'
import type { Json } from './scenario.ts'

type Dict = Record<string, unknown>

/** What fake-agent passes to a mod's default export. */
export interface FakeCmd {
  readonly name: string
  readonly cwd: string
  addFlag(name: string, o?: { type?: string; default?: unknown; description?: string }): void
  getFlag(name: string): unknown
  on(event: string, handler: (event: Dict) => unknown): void
  hooks(h: Record<string, (arg: Dict) => unknown>): void
  exec(opts: { command: string; args?: string[]; cwd?: string; input?: string; timeoutMs?: number }): Promise<RunResult>
}

export interface CommandCodeSessionInfo {
  sessionId: string
  cwd: string
  /** As `permission_mode_changed` reports it (`default`, `auto-accept`, `plan`, `bypass`, `dont-ask`). */
  permissionMode: string
  model: string
  /** `onSessionStart`'s source: `resume` when started with --resume. */
  source: 'startup' | 'resume'
  /** `--mod-option name=value`. */
  modOptions: Readonly<Record<string, string>>
}

/** Default `cmd.exec` timeout, ms. */
const EXEC_TIMEOUT_MS = 5000
/** The session hooks, and the events that call them. */
const SESSION_START = 'session_start'
const SESSION_END = 'session_shutdown'
/** fake-agent's end reasons → Command Code's. `other` (a signal, the PTY gone): 1.79.2 says nothing at all. */
const END_REASONS: Record<string, string | null> = { prompt_input_exit: 'shutdown', shutdown: 'shutdown', replaced: 'replaced', other: null }
const USAGE = { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }

const isObj = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v)

export class ModHost implements HookSink {
  private readonly handlers = new Map<string, ((e: Dict) => unknown)[]>() // bounded: by the mods' subscriptions
  private readonly sessionHooks: Record<string, (arg: Dict) => unknown>[] = [] // bounded: one per mod
  private readonly flags = new Map<string, unknown>() // bounded: by the mods' declarations
  private readonly info: CommandCodeSessionInfo
  private readonly env: NodeJS.ProcessEnv
  /** The session is bound (its first `session_start` fired): options answer their given values. */
  private bound = false
  private toolSeq = 0
  // bounded: one per tool name the scenario used (the last call of each)
  private readonly lastTool = new Map<string, { id: string; input: Json }>()
  private lastToolName: string | null = null
  private turn = 0
  private hadTools = false
  /** exec calls the mods made while handling the current event (reported as the event's runs). */
  private runs: HookRun[] = []
  /** Those still running: an event's are waited for before the next step, so a scenario stays in order. */
  private pending: Promise<void>[] = []
  /** What a handler threw, by event (tests read it; the agent goes on). */
  readonly errors: { event: string; message: string }[] = [] // bounded: one scenario run
  /** Another conversation began in this process (`/clear`): the transcript follows it. */
  onSessionId: ((id: string) => void) | null = null

  constructor(info: CommandCodeSessionInfo, env: NodeJS.ProcessEnv) {
    this.info = { ...info }
    this.env = env
  }

  get sessionId(): string {
    return this.info.sessionId
  }

  cmd(name: string): FakeCmd {
    return {
      name,
      cwd: this.info.cwd,
      addFlag: (flag, o) => {
        if (!this.flags.has(flag)) this.flags.set(flag, o?.default)
      },
      getFlag: (flag) => (this.bound && Object.hasOwn(this.info.modOptions, flag) && this.flags.has(flag) ? this.info.modOptions[flag] : this.flags.get(flag)),
      on: (event, handler) => {
        const list = this.handlers.get(event) ?? []
        list.push(handler)
        this.handlers.set(event, list)
      },
      hooks: (h) => {
        this.sessionHooks.push(h)
      },
      exec: (o) => {
        const args = o.args ?? []
        const run = runCommand(o.command, args, { cwd: o.cwd ?? this.info.cwd, env: this.env, input: o.input ?? '', timeoutMs: o.timeoutMs ?? EXEC_TIMEOUT_MS }).then((r) => {
          this.runs.push({ ...r, command: o.command, args })
          return r
        })
        this.pending.push(run.then(() => undefined, () => undefined))
        return run
      },
    }
  }

  /** Import each mod and call its default export with its `cmd` (awaited). */
  async load(paths: readonly string[], cwd: string): Promise<void> {
    for (const p of paths) {
      const file = resolve(cwd, p)
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown }
      if (typeof mod.default !== 'function') throw new Error(`--mod ${p}: the module has no default export function`)
      const base = file.slice(file.lastIndexOf('/') + 1)
      await (mod.default as (cmd: FakeCmd) => unknown)(this.cmd(base.replace(/\.[cm]?[jt]s$/, '')))
    }
    // what a mod ran as it loaded is finished before the session starts
    while (this.pending.length) await Promise.all(this.pending.splice(0))
    this.runs = []
  }

  private tool(event: string, opts: HookFireOptions): { toolCallId: string; toolName: string; input: Json } {
    const name = opts.tool ?? this.lastToolName ?? 'shell_command'
    let t = this.lastTool.get(name)
    if (event === 'tool_queued' || !t) {
      t = { id: `toolu_fake_${String(++this.toolSeq).padStart(4, '0')}`, input: opts.input ?? {} }
      this.lastTool.set(name, t)
    }
    this.lastToolName = name
    return { toolCallId: t.id, toolName: name, input: opts.input ?? t.input }
  }

  /** The event as 1.79.2 delivers it, the scenario's `fields` laid over it (one level into objects; `null` removes). */
  payload(event: string, opts: HookFireOptions): Dict {
    const i = this.info
    let p: Dict = { type: event }
    switch (event) {
      case 'run_start':
        this.turn = 0
        p.sessionId = i.sessionId
        break
      case 'turn_start':
        this.hadTools = false
        p.turnNumber = ++this.turn
        break
      case 'model_request_start':
        p.model = i.model
        break
      case 'model_request_end':
        p = { ...p, model: i.model, usage: { ...USAGE }, stopReason: 'end_turn' }
        break
      case 'message_end':
        p.content = []
        break
      case 'tool_queued': {
        const t = this.tool(event, opts)
        this.hadTools = true
        p = { ...p, toolCallId: t.toolCallId, toolName: t.toolName, input: t.input }
        break
      }
      case 'tool_running': {
        const t = this.tool(event, opts)
        p = { ...p, toolCallId: t.toolCallId, toolName: t.toolName, description: null }
        break
      }
      case 'tool_completed': {
        const t = this.tool(event, opts)
        p = { ...p, toolCallId: t.toolCallId, toolName: t.toolName, result: [{ type: 'text', text: '' }], deferred: false }
        break
      }
      case 'tool_errored': {
        const t = this.tool(event, opts)
        p = { ...p, toolCallId: t.toolCallId, toolName: t.toolName, error: 'the tool failed', deferred: false }
        break
      }
      case 'tool_denied':
      case 'tool_hook_blocked': {
        const t = this.tool(event, opts)
        p = { ...p, toolCallId: t.toolCallId, toolName: t.toolName }
        break
      }
      case 'turn_end':
        p = { ...p, turnNumber: Math.max(1, this.turn), hadToolCalls: this.hadTools, usage: { ...USAGE } }
        break
      case 'run_end':
        // the real one carries the whole conversation in `nextState.messages`: a mod must not forward it
        p.result = { finalText: '', stopReason: 'end_turn', turnCount: Math.max(1, this.turn), usage: { ...USAGE }, systemPromptTokens: null, nextState: { sessionId: i.sessionId, messages: [] } }
        break
      case 'run_error':
        p.error = { name: 'TransportError', message: 'the run failed', status: 500, retryable: false }
        break
      case 'session_titled':
        p.title = ''
        break
      case 'permission_mode_changed':
        p.mode = i.permissionMode
        break
    }
    for (const [k, v] of Object.entries(opts.fields)) {
      if (v === null) delete p[k]
      else p[k] = isObj(p[k]) && isObj(v) ? { ...(p[k] as Dict), ...v } : v
    }
    if (event === 'permission_mode_changed' && typeof p.mode === 'string') this.info.permissionMode = p.mode
    if (event === 'model_request_start' && typeof p.model === 'string') this.info.model = p.model
    return p
  }

  private safely(event: string, f: () => unknown): void {
    try {
      const r = f()
      // a handler's promise is not waited for (the real loop does not either), but its failure is still recorded
      if (r instanceof Promise) r.catch((e: unknown) => this.errors.push({ event, message: String((e as Error)?.message ?? e) }))
    } catch (e) {
      this.errors.push({ event, message: String((e as Error)?.message ?? e) })
    }
  }

  private emit(event: string, payload: Dict): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) this.safely(event, () => h(payload))
  }

  async fire(event: string, opts: HookFireOptions): Promise<{ payload: Dict; runs: HookRun[] }> {
    this.runs = []
    let payload: Dict
    if (event === SESSION_START) {
      const id = typeof opts.fields.sessionId === 'string' ? opts.fields.sessionId : this.info.sessionId
      const source = typeof opts.fields.source === 'string' ? opts.fields.source : this.info.source
      if (id !== this.info.sessionId) {
        this.info.sessionId = id
        this.onSessionId?.(id)
      }
      this.bound = true
      // the plain event carries nothing; the hook has the id and the source
      this.emit(event, { type: event })
      payload = { source, sessionId: id }
      for (const h of this.sessionHooks) if (h.onSessionStart) this.safely('onSessionStart', () => h.onSessionStart!({ ...payload }))
      payload = { type: event, ...payload }
    } else if (event === SESSION_END) {
      const given = typeof opts.fields.reason === 'string' ? opts.fields.reason : 'shutdown'
      const reason = Object.hasOwn(END_REASONS, given) ? END_REASONS[given] : given
      if (reason === null || reason === undefined) return { payload: { type: event, silent: true }, runs: [] }
      for (const h of this.sessionHooks) if (h.onSessionEnd) this.safely('onSessionEnd', () => h.onSessionEnd!({ reason }))
      this.emit(event, { type: event })
      payload = { type: event, reason }
    } else {
      payload = this.payload(event, opts)
      this.emit(event, payload)
    }
    // exec calls started by handlers finish before the next step
    while (this.pending.length) await Promise.all(this.pending.splice(0))
    const runs = this.runs
    this.runs = []
    return { payload, runs }
  }
}
