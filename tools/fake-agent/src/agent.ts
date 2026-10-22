// The fake agent's lifecycle: SessionStart, the scenario's steps as the first turn, then an idle prompt that runs
// `onLine` per typed line; Esc/Ctrl-C interrupts (with `onInterrupt`); every graceful end — exit step, SIGTERM,
// SIGHUP, SIGINT, Ctrl-C, Ctrl-D, EOF — fires SessionEnd before the process exits (E-SES-9).

import type { Flavour } from './argv.ts'
import type { HookSink } from './hooks.ts'
import type { Key } from './keys.ts'
import type { EventLog } from './log.ts'
import { ExitRequest, InputClosedError, Runner, StepError, summariseRun, type Vars } from './runner.ts'
import type { Scenario, Step } from './scenario.ts'
import type { StatusFileWriter } from './status.ts'
import { AbortedError, type Io } from './term.ts'
import type { TranscriptWriter } from './transcript.ts'

export const LIFECYCLE_EVENTS: Record<Flavour, { start: string; end: string }> = {
  claude: { start: 'SessionStart', end: 'SessionEnd' },
  commandcode: { start: 'session_start', end: 'session_shutdown' },
}

export interface AgentDeps {
  io: Io
  scenario: Scenario
  flavour: Flavour
  vars: Vars
  hooks: HookSink | null
  transcript: TranscriptWriter | null
  transcriptRefusal: string | null
  log: EventLog
  /** Put the terminal back (leave the alternate screen, cooked mode). */
  restore(): void
  /** Called once, last. The process entry point exits with the code. */
  exit(code: number): void
  /** Errors for the user (a failed step), e.g. stderr. */
  warn(msg: string): void
  readFile?: (path: string) => string
  /** Claude's live status file (status.ts), or null. */
  status?: StatusFileWriter | null
}

export class FakeAgent {
  readonly runner: Runner
  private readonly d: AgentDeps
  private readonly session = new AbortController()
  private turn: AbortController | null = null
  private interrupted = false
  private ending: Promise<void> | null = null

  constructor(deps: AgentDeps) {
    this.d = deps
    this.runner = new Runner({
      io: deps.io,
      scenario: deps.scenario,
      vars: deps.vars,
      hooks: deps.hooks,
      transcript: deps.transcript,
      transcriptRefusal: deps.transcriptRefusal,
      log: deps.log,
      ...(deps.readFile ? { readFile: deps.readFile } : {}),
      status: deps.status ?? null,
    })
    deps.io.keys.global = (k) => this.globalKey(k)
  }

  get isEnding(): boolean {
    return this.ending !== null
  }

  /** Run to the end. Resolves when the agent has ended (exit already called). */
  async run(): Promise<void> {
    const { scenario, flavour, log } = this.d
    // Claude Code 2.1.296 registers its status file, then marks it idle, before SessionStart; an agent awaiting trust
    // (SessionStart withheld) writes none until its SessionStart step: the trust dialog writes no file
    if (this.d.status && scenario.statusFile !== 'off' && scenario.fireSessionStart) {
      this.d.status.register()
      if (scenario.statusFile === 'auto') this.d.status.set({ status: 'idle' })
    }
    if (scenario.fireSessionStart && this.d.hooks) {
      const { payload, runs } = await this.d.hooks.fire(LIFECYCLE_EVENTS[flavour].start, { tool: null, input: null, fields: {} })
      log.event('hook', { event: LIFECYCLE_EVENTS[flavour].start, payload, runs: runs.map(summariseRun) })
    }
    if (!(await this.runTurn(scenario.steps))) return this.ending ?? undefined
    if (scenario.afterSteps === 'exit') return this.end('prompt_input_exit', 0)
    while (!this.ending) {
      let line: string | null
      try {
        line = await this.runner.readLine(this.session.signal, { echo: true, timeoutMs: null, eofOnCtrlD: true })
      } catch (e) {
        if (e instanceof InputClosedError) return this.end('other', 0)
        return this.ending ?? undefined // aborted: end() is running
      }
      if (line === null) return this.end('prompt_input_exit', 0) // Ctrl-D on an empty line
      log.event('line', { line })
      if (!scenario.onLine || line.trim() === '') continue // an empty submission starts no turn
      this.d.vars.line = line
      this.d.vars.prompt = line
      if (!(await this.runTurn(scenario.onLine))) return this.ending ?? undefined
    }
    return this.ending ?? undefined
  }

  /** Run steps as an interruptible turn. False when the agent is ending. */
  private async runTurn(steps: readonly Step[]): Promise<boolean> {
    this.turn = new AbortController()
    this.interrupted = false
    const signal = AbortSignal.any([this.session.signal, this.turn.signal])
    try {
      await this.runner.run(steps, signal)
    } catch (e) {
      if (e instanceof AbortedError) {
        if (this.ending || !this.interrupted) return false
        this.d.log.event('interrupted', {})
        // Esc: the file goes idle with no Stop (a prompt that was waiting goes busy first)
        if (this.d.scenario.statusFile === 'auto') this.d.status?.interrupted()
        this.turn = null
        return this.runSteps(this.d.scenario.onInterrupt ?? [])
      }
      if (e instanceof ExitRequest) {
        await this.end(e.reason, e.code)
        return false
      }
      if (e instanceof InputClosedError) {
        await this.end('other', 0)
        return false
      }
      const msg = e instanceof StepError ? e.message : `unexpected error: ${(e as Error)?.stack ?? String(e)}`
      this.d.warn(`fake-agent: ${msg}`)
      this.d.log.event('error', { message: msg })
      await this.end('other', 1)
      return false
    } finally {
      this.turn = null
    }
    return !this.ending
  }

  /** Non-interruptible steps (onInterrupt). */
  private async runSteps(steps: readonly Step[]): Promise<boolean> {
    try {
      await this.runner.run(steps, this.session.signal)
    } catch (e) {
      if (e instanceof ExitRequest) await this.end(e.reason, e.code)
      else if (!(e instanceof AbortedError)) {
        this.d.warn(`fake-agent: ${e instanceof Error ? e.message : String(e)}`)
        await this.end('other', 1)
      }
      return false
    }
    return !this.ending
  }

  private globalKey(k: Key): boolean {
    if (this.ending) return true
    const canInterrupt = this.turn !== null && this.d.scenario.onInterrupt !== null
    if (k === 'ctrl-c') {
      if (canInterrupt) this.interrupt()
      else void this.end('prompt_input_exit', 0)
      return true
    }
    if (k === 'esc' && canInterrupt && !this.runner.wantsEsc) {
      this.interrupt()
      return true
    }
    return false
  }

  private interrupt(): void {
    this.interrupted = true
    this.d.log.event('interrupt', {})
    this.turn?.abort()
  }

  /** The terminal changed size: redraw the last frame. */
  async resize(): Promise<void> {
    const size = this.d.io.size()
    this.d.log.event('resize', size)
    if (!this.ending) await this.runner.redraw()
  }

  /**
   * End gracefully (idempotent): stop the steps, fire SessionEnd and wait for its hooks, write cost-state, restore the
   * terminal, then exit with `code`.
   */
  end(reason: string, code: number): Promise<void> {
    if (this.ending) return this.ending
    this.ending = (async () => {
      const { scenario, flavour, log } = this.d
      this.session.abort()
      log.event('ending', { reason, code })
      // a graceful end removes the status file before SessionEnd fires; SIGKILL leaves it
      this.d.status?.remove()
      if (scenario.fireSessionEnd && this.d.hooks) {
        try {
          const { payload, runs } = await this.d.hooks.fire(LIFECYCLE_EVENTS[flavour].end, { tool: null, input: null, fields: { reason } })
          log.event('hook', { event: LIFECYCLE_EVENTS[flavour].end, payload, runs: runs.map(summariseRun) })
        } catch (e) {
          log.event('error', { message: `end hook: ${(e as Error).message}` })
        }
      }
      if (scenario.exitCostUsd !== null && this.d.transcript) {
        this.d.transcript.write('cost-state', { text: null, title: null, costUsd: scenario.exitCostUsd, forToolUse: false, json: null, fields: {} })
      }
      this.d.restore()
      log.event('exit', { code })
      this.d.exit(code)
    })()
    return this.ending
  }
}
