// Runs scenario steps against an Io (the process terminal, or the tests' fake). Every wait is abortable: a turn's
// signal fires on interrupt (Esc / Ctrl-C with onInterrupt) and the session's on SIGTERM/SIGHUP, EOF or an exit step.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { argvHashLine } from './argv.ts'
import { castSchedule, parseCast } from './cassette.ts'
import { applyFileOp } from './files.ts'
import type { HookRun, HookSink } from './hooks.ts'
import type { Key } from './keys.ts'
import type { EventLog } from './log.ts'
import { ProbeBatch, type ProbeResult } from './probes.ts'
import type { Json, Scenario, Step } from './scenario.ts'
import type { StatusFileWriter } from './status.ts'
import { AbortedError, ALT_SCREEN_ENTER, ALT_SCREEN_LEAVE, BEL, frameBytes, type Io, notifySeq, titleSeq } from './term.ts'
import type { TranscriptWriter } from './transcript.ts'

/** Template variables that do not change while the agent runs (cols, rows and i are live). */
export interface Vars {
  sessionId: string
  cwd: string
  model: string
  prompt: string
  line: string
  key: string
  argvHash: string
  flavour: string
  permissionMode: string
  transcriptPath: string
}

/** An `exit` step: the agent ends with this code (SessionEnd first). */
export class ExitRequest extends Error {
  readonly code: number
  readonly reason: string
  constructor(code: number, reason: string) {
    super(`exit ${code}`)
    this.code = code
    this.reason = reason
  }
}

/** A step needed input but the terminal is gone. */
export class InputClosedError extends Error {
  constructor() {
    super('input closed')
  }
}

/** A step failed (a missing file, a bad cassette, …); `at` says which. */
export class StepError extends Error {
  constructor(at: string, kind: string, cause: unknown) {
    super(`${at} (${kind}): ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export interface RunnerDeps {
  io: Io
  scenario: Scenario
  vars: Vars
  hooks: HookSink | null
  transcript: TranscriptWriter | null
  /** Why transcripts are not written (logged once per transcript step), when `transcript` is null. */
  transcriptRefusal: string | null
  log: EventLog
  readFile?: (path: string) => string
  /** Claude's live status file (status.ts); null when the scenario turns it off or it may not be written. */
  status?: StatusFileWriter | null
}

export class Runner {
  private readonly d: RunnerDeps
  private readonly loopIndex: number[] = [] // bounded: one entry per nested loop (scenario depth ≤ 16)
  private lastFrame: { lines: string[]; sync: boolean } | null = null
  /** Set while a step reads a key that may be Esc: Esc then goes to the step, not to the interrupt handler. */
  wantsEsc = false
  probeResults: ProbeResult[] = []

  constructor(deps: RunnerDeps) {
    this.d = deps
  }

  render(s: string): string {
    const size = this.d.io.size()
    return s.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, name: string) => {
      if (name === 'cols') return String(size.cols)
      if (name === 'rows') return String(size.rows)
      if (name === 'i') return String(this.loopIndex[this.loopIndex.length - 1] ?? 0)
      return (this.d.vars as unknown as Record<string, string>)[name] ?? ''
    })
  }

  renderJson(v: Json): Json {
    if (typeof v === 'string') return this.render(v)
    if (Array.isArray(v)) return v.map((x) => this.renderJson(x))
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.renderJson(x)]))
    return v
  }

  async run(steps: readonly Step[], signal: AbortSignal): Promise<void> {
    for (const s of steps) {
      if (signal.aborted) throw new AbortedError()
      try {
        await this.step(s, signal)
      } catch (e) {
        if (e instanceof AbortedError || e instanceof ExitRequest || e instanceof InputClosedError || e instanceof StepError) throw e
        throw new StepError(s.at, s.kind, e)
      }
    }
  }

  /** Redraw the last frame at the current size (SIGWINCH). */
  async redraw(): Promise<void> {
    if (this.lastFrame) await this.d.io.write(frameBytes(this.lastFrame.lines.map((l) => this.render(l)), this.d.io.size(), this.lastFrame.sync))
  }

  private async step(s: Step, signal: AbortSignal): Promise<void> {
    const { io, log, vars } = this.d
    switch (s.kind) {
      case 'probe': {
        const results = await io.probe(new ProbeBatch(s.queries), s.timeoutMs, signal)
        this.probeResults = results
        log.event('probe', { results })
        return
      }
      case 'altScreen':
        await io.write(s.enter ? ALT_SCREEN_ENTER : ALT_SCREEN_LEAVE)
        return
      case 'frame':
        this.lastFrame = { lines: s.lines, sync: s.sync }
        await io.write(frameBytes(s.lines.map((l) => this.render(l)), io.size(), s.sync))
        return
      case 'print':
        await io.write(this.render(s.text))
        return
      case 'title':
        await io.write(titleSeq(this.render(s.text), s.osc))
        return
      case 'bell':
        await io.write(BEL)
        return
      case 'notify':
        await io.write(notifySeq(s.osc, this.render(s.title), this.render(s.body)))
        return
      case 'wait': {
        if (s.mode === 'line') {
          const line = await this.readLine(signal, { echo: s.echo, timeoutMs: s.timeoutMs, eofOnCtrlD: false })
          if (line === null) log.event('wait-timeout', { at: s.at })
          else {
            vars.line = line
            log.event('input', { at: s.at, line })
          }
          return
        }
        const want = s.mode === 'answer' ? s.answer : null
        const key = await this.readKey(signal, (k) => want === null || k === want, s.timeoutMs, want === null || want === 'esc')
        if (key === null) log.event('wait-timeout', { at: s.at })
        else {
          vars.key = key
          log.event('input', { at: s.at, key })
        }
        return
      }
      case 'choose': {
        const keys = s.branches.map((b) => b.key)
        const key = (await this.readKey(signal, (k) => keys.includes(k), null, keys.includes('esc'))) as Key
        vars.key = key
        log.event('input', { at: s.at, key })
        const branch = s.branches.find((b) => b.key === key)
        if (branch) await this.run(branch.steps, signal)
        return
      }
      case 'hook': {
        if (!this.d.hooks) return
        const fields = this.renderJson(s.fields) as Record<string, Json>
        if (s.event === 'UserPromptSubmit' && !('prompt' in fields)) fields.prompt = vars.prompt
        const input = s.input === null ? null : this.renderJson(s.input)
        const tool = s.tool === null ? null : this.render(s.tool)
        const auto = this.d.scenario.statusFile === 'auto' ? (this.d.status ?? null) : null
        auto?.beforeHook(s.event, tool)
        const { payload, runs } = await this.d.hooks.fire(s.event, { tool, input, fields })
        log.event('hook', { event: s.event, payload, runs: runs.map(summariseRun) })
        auto?.afterHook(s.event, tool)
        return
      }
      case 'status': {
        const st = this.d.status
        if (!st) return
        if (s.op === 'torn') st.torn()
        else if (s.op === 'remove') st.remove()
        else if (s.op === 'sessionId') st.setSessionId(this.render(s.sessionId ?? ''))
        else st.set({ status: s.status ?? '', ...(s.waitingFor !== null ? { waitingFor: s.waitingFor } : {}) })
        log.event('status', { op: s.op, status: s.status, waitingFor: s.waitingFor })
        return
      }
      case 'transcript': {
        if (!this.d.transcript) {
          log.event('transcript-skipped', { record: s.record, reason: this.d.transcriptRefusal })
          return
        }
        const r = this.d.transcript.write(s.record, {
          text: s.text === null ? null : this.render(s.text),
          title: s.title === null ? null : this.render(s.title),
          costUsd: s.costUsd,
          forToolUse: s.forToolUse,
          json: s.json === null ? null : this.renderJson(s.json),
          fields: this.renderJson(s.fields) as Record<string, Json>,
        })
        log.event('transcript', { record: s.record, type: r.type })
        return
      }
      case 'file': {
        const r = (v: string | null) => (v === null ? null : this.render(v))
        const step = { op: s.op, path: this.render(s.path), to: r(s.to), content: r(s.content), find: r(s.find), replace: r(s.replace) }
        applyFileOp(vars.cwd, step) // checks the rendered paths stay inside the cwd
        log.event('file', { op: step.op, path: step.path, to: step.to })
        return
      }
      case 'argvHash':
        await io.write(`${argvHashLine(vars.argvHash)}\r\n`)
        log.event('argv-hash', { hash: vars.argvHash })
        return
      case 'cassette': {
        const file = resolve(this.d.scenario.baseDir, s.file)
        const { header, events } = parseCast((this.d.readFile ?? ((p) => readFileSync(p, 'utf8')))(file), s.file)
        const schedule = castSchedule(events, { speed: s.speed, maxIdleMs: s.maxIdleMs, header })
        const t0 = io.now()
        let bytes = 0
        for (const e of schedule) {
          const due = t0 + e.atMs - io.now()
          if (due > 0) await io.sleep(due, signal)
          else if (signal.aborted) throw new AbortedError()
          await io.write(e.data)
          bytes += e.data.length
        }
        log.event('cassette', { file: s.file, events: schedule.length, chars: bytes })
        return
      }
      case 'sleep':
        await io.sleep(s.ms, signal)
        return
      case 'exit':
        throw new ExitRequest(s.code, s.reason)
      case 'loop':
        for (let i = 0; s.times === 'forever' || i < s.times; i++) {
          this.loopIndex.push(i)
          try {
            await this.run(s.steps, signal)
          } finally {
            this.loopIndex.pop()
          }
        }
        return
    }
  }

  /**
   * The next key `accept` takes (others are ignored); null on timeout. `esc`: the step wants Esc itself (otherwise an
   * interruptible turn treats Esc as an interrupt).
   */
  readKey(signal: AbortSignal, accept: (k: Key) => boolean, timeoutMs: number | null, esc: boolean): Promise<Key | null> {
    return new Promise((resolve, reject) => {
      let stop = () => {}
      const timer = timeoutMs === null ? null : setTimeout(() => done(() => resolve(null)), timeoutMs)
      const onAbort = () => done(() => reject(new AbortedError()))
      const done = (settle: () => void) => {
        stop()
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.wantsEsc = false
        settle()
      }
      if (signal.aborted) return reject(new AbortedError())
      signal.addEventListener('abort', onAbort, { once: true })
      this.wantsEsc = esc
      stop = this.d.io.keys.read(
        (k) => {
          if (!accept(k)) return false
          done(() => resolve(k))
          return true
        },
        () => done(() => reject(new InputClosedError())),
      )
    })
  }

  /**
   * A line typed at the prompt, echoed as typed; null on timeout, or on Ctrl-D with an empty line when `eofOnCtrlD`.
   */
  readLine(signal: AbortSignal, o: { echo: boolean; timeoutMs: number | null; eofOnCtrlD: boolean }): Promise<string | null> {
    const io = this.d.io
    let line = ''
    return new Promise((resolve, reject) => {
      let stop = () => {}
      const timer = o.timeoutMs === null ? null : setTimeout(() => done(() => resolve(null)), o.timeoutMs)
      const onAbort = () => done(() => reject(new AbortedError()))
      const done = (settle: () => void) => {
        stop()
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        settle()
      }
      if (signal.aborted) return reject(new AbortedError())
      signal.addEventListener('abort', onAbort, { once: true })
      stop = io.keys.read(
        (k) => {
          if (k === 'enter') {
            if (o.echo) void io.write('\r\n')
            done(() => resolve(line))
          } else if (k === 'ctrl-d' && line === '' && o.eofOnCtrlD) done(() => resolve(null))
          else if (k === 'backspace') {
            if (line) {
              line = [...line].slice(0, -1).join('')
              if (o.echo) void io.write('\b \b')
            }
          } else if ([...k].length === 1 && k >= ' ') {
            line += k
            if (o.echo) void io.write(k)
          } else return false
          return true
        },
        () => done(() => reject(new InputClosedError())),
      )
    })
  }
}

/** A hook run as the event log records it. */
export function summariseRun(r: HookRun) {
  return { command: r.command, args: r.args, exitCode: r.exitCode, signal: r.signal, ms: Math.round(r.ms * 10) / 10, timedOut: r.timedOut, error: r.error, stdout: r.stdout, stderr: r.stderr }
}
