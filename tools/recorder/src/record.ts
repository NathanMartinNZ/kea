// Records one scenario: the real agent CLI runs in a real `kea-helper` holder, exactly as Kea hosts it, and the
// recorder attaches the way ptyhost does (HolderConnection, a headless Mirror that answers terminal queries, acks after
// parsing). Every output byte goes to the cassette with its time; the scenario's steps wait on the mirror's screen and
// type into the PTY. The model is always tools/mock-model, so a recording costs nothing and sends nothing anywhere; the
// CLI runs sandboxed in a throwaway world (world.ts).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { HolderConnection } from '../../../app/ptyhost/src/holder/connection.ts'
import { clientRequirement, launchHolder } from '../../../app/ptyhost/src/holder/launch.ts'
import { Mirror } from '../../../app/ptyhost/src/mirror/mirror.ts'
import { terminalEnv } from '../../../app/core/src/terminal/shellEnv.ts'
import { ptyId as newPtyId } from '../../../packages/kit/src/index.ts'
import { DEFAULT_TERMINAL_SETTINGS, L } from '../../../packages/protocol/src/index.ts'
import { colorThemeOf } from '../../../packages/terminal/src/index.ts'
import { type Reply, type ScriptedReply, startMockModel } from '../../mock-model/src/index.ts'
import { tinyRepo } from '../../repo-factory/src/index.ts'
import { assertRecordable } from '../../scrubber/src/guard.ts'
import { CastWriter } from './cast.ts'
import { agentEnv, forbiddenEnvKey, makeWorld, startSinkhole, sweep, WORLD_ENV_KEYS } from './world.ts'

export const RECORDER_VERSION = 'kea-recorder 0.1'

export type Step =
  /** Wait until the screen (whitespace collapsed to single spaces) matches this regex. */
  | { wait: string; timeoutMs?: number }
  /** Type the scenario's prompt, one key at a time. */
  | { type: 'prompt'; keyDelayMs?: number }
  /** A few keys (≤ 8 characters: Enter, digits, Esc, Ctrl+C …). Text goes through `type: prompt` only. */
  | { send: string }
  | { resize: [number, number] }
  /** Idle time on purpose (the agent keeps running: spinners, blinking). */
  | { pause: number }
  | { mark: string }
  /** Wait for the agent to exit. */
  | { exit: number }

export interface Scenario {
  name: string
  agent: 'claude'
  /** One of tools/recorder/demo-prompts.json (the guard refuses anything else). */
  prompt: string
  cols: number
  rows: number
  args?: string[]
  env?: Record<string, string>
  /** Seed the repo as trusted, so no trust dialog (default true). */
  trusted?: boolean
  /** Mock-model script (tools/mock-model README); `{{repo}}` is replaced by the demo repo's path. */
  mock: { default?: Reply | string; replies?: ScriptedReply[] }
  steps: Step[]
  notes?: string
}

export function validateScenario(v: unknown, file = 'scenario'): Scenario {
  const s = v as Scenario
  const bad = (m: string) => new Error(`${file}: ${m}`)
  if (!s || typeof s !== 'object') throw bad('not an object')
  if (typeof s.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.name)) throw bad('name must be kebab-case')
  if (s.agent !== 'claude') throw bad('agent must be "claude" (Command Code recordings need a stand-in for its backend)')
  if (typeof s.prompt !== 'string') throw bad('prompt missing')
  for (const k of ['cols', 'rows'] as const) if (!Number.isInteger(s[k]) || s[k] < 20 || s[k] > 400) throw bad(`${k} must be an integer in 20…400`)
  if (s.env !== undefined) {
    if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env)) throw bad('env must be an object of strings')
    for (const [k, v] of Object.entries(s.env)) {
      if (typeof v !== 'string') throw bad(`env.${k} must be a string`)
      const why = forbiddenEnvKey(k, WORLD_ENV_KEYS)
      if (why) throw bad(`env may not set ${k}: ${why}`)
    }
  }
  if (!Array.isArray(s.steps) || s.steps.length === 0) throw bad('steps missing')
  for (const [i, st] of s.steps.entries()) {
    const keys = Object.keys(st)
    const ok =
      ('wait' in st && typeof st.wait === 'string') ||
      ('type' in st && st.type === 'prompt') ||
      ('send' in st && typeof st.send === 'string' && st.send.length > 0 && st.send.length <= 8) ||
      ('resize' in st && Array.isArray(st.resize) && st.resize.length === 2 && st.resize.every((n) => Number.isInteger(n) && n >= 20 && n <= 400)) ||
      ('pause' in st && typeof st.pause === 'number') ||
      ('mark' in st && typeof st.mark === 'string') ||
      ('exit' in st && typeof st.exit === 'number')
    if (!ok) throw bad(`step ${i + 1} is not valid: ${JSON.stringify(st)} (keys ${keys.join(', ')})`)
  }
  return s
}

export interface RecordOptions {
  /** The agent binary (`claude`). */
  agentBin: string
  helper: string
  outDir: string
  /** Record in this repo instead of a fresh repo-factory `tiny` repo (it must pass the recorder guard). */
  repo?: string
  log?: (msg: string) => void
}

export interface RecordResult {
  file: string
  bytes: number
  seconds: number
  agentVersion: string
  altScreen: boolean
  modelRequests: number
  refusedNetwork: string[]
  leftovers: string[]
}

/** `{{repo}}` in the mock's replies becomes the demo repo's absolute path (file tools take absolute paths). */
export function withRepo(mock: Scenario['mock'], repo: string): Scenario['mock'] {
  return JSON.parse(JSON.stringify(mock).replaceAll('{{repo}}', repo.replaceAll('\\', '\\\\').replaceAll('"', '\\"'))) as Scenario['mock']
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const ALT_SCREEN = /\x1b\[\?(?:1049|1047|47)h/

export async function record(s: Scenario, o: RecordOptions): Promise<RecordResult> {
  const log = o.log ?? (() => {})
  // a short neutral path: it appears on screen, so it ends up in the cassette
  const fresh = o.repo ? null : tinyRepo({ parent: '/tmp' })
  const cwd = o.repo ?? (fresh as { root: string }).root
  const { root: repo } = assertRecordable({ cwd, prompt: s.prompt })
  const m = withRepo(s.mock, repo)
  const mock = await startMockModel({
    replies: m.replies ?? [],
    ...(m.default !== undefined ? { defaultReply: typeof m.default === 'string' ? { content: [{ type: 'text', text: m.default }] } : m.default } : {}),
  })
  const sink = await startSinkhole()
  const claudeTmp = claudeTmpTracker(repo)
  const port = (url: string) => Number(new URL(url).port)
  const world = makeWorld({ repo, trusted: s.trusted ?? true, ports: [port(mock.url), port(sink.url)] })
  let pids: number[] = []
  let leftovers: string[] = []
  try {
    const env = terminalEnv(agentEnv(world, { mockUrl: mock.url, proxyUrl: sink.url, ...(s.env ? { extra: s.env } : {}) }), RECORDER_VERSION)
    // os-ok: contract capture stays macOS-only
    const agentVersion = execFileSync('/usr/bin/sandbox-exec', ['-f', world.profile, o.agentBin, '--version'], { env, cwd: repo, encoding: 'utf8', timeout: 30_000 })
      .trim()
      .split(/\s/)[0] as string
    const sock = join(world.run, 'h.sock')
    const launched = await launchHolder({
      helper: o.helper,
      ptyId: newPtyId(),
      sessionId: 'recorder',
      kind: 'agent',
      stateDir: world.run,
      sock,
      cols: s.cols,
      rows: s.rows,
      client: await clientRequirement(),
      ringBytes: L.ringBytesDefault,
      keaVersion: RECORDER_VERSION,
      spec: { file: '/usr/bin/sandbox-exec', args: ['-f', world.profile, o.agentBin, ...(s.args ?? [])], env, cwd: repo }, // os-ok: contract capture stays macOS-only
    })
    pids = [launched.childPid, launched.pid]
    log(`${s.name}: ${o.agentBin} ${agentVersion} in a holder (pid ${launched.pid}), ${s.cols}×${s.rows}`)
    const { conn } = await HolderConnection.open(sock)
    const run = new Run(conn, s, log)
    const seconds = await run.go()
    const altScreen = run.altScreen
    const text = run.writer.finish({
      version: 2,
      width: s.cols,
      height: s.rows,
      env: { TERM: env.TERM ?? 'xterm-256color' },
      title: s.name,
      kea: { scenario: s.name, agent: s.agent, agentVersion, prompt: s.prompt, model: 'mock-model', altScreen, recorder: RECORDER_VERSION },
    })
    mkdirSync(o.outDir, { recursive: true })
    const file = join(o.outDir, `${s.name}.cast`)
    writeFileSync(file, text)
    return { file, bytes: run.writer.bytes, seconds, agentVersion, altScreen, modelRequests: mock.requests.length, refusedNetwork: [...sink.hits], leftovers }
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone, as it should be
      }
    }
    leftovers = sweep(world.root)
    if (leftovers.length) log(`killed leftover processes: ${leftovers.join('; ')}`)
    await mock.close()
    await sink.close()
    world.dispose()
    claudeTmp.cleanup()
    fresh?.dispose()
  }
}

/**
 * Claude keeps per-project task files in /tmp/claude-<uid>/<cwd with / → -> whatever TMPDIR says. Remove what this
 * recording added there, and nothing that was there before (a `--repo` demo repo may have its own).
 */
function claudeTmpTracker(repo: string): { cleanup(): void } {
  const dir = join('/private/tmp', `claude-${process.getuid?.() ?? 0}`, repo.replaceAll('/', '-'))
  const before = existsSync(dir) ? new Set(readdirSync(dir)) : null
  return {
    cleanup() {
      if (!existsSync(dir)) return
      if (!before) return rmSync(dir, { recursive: true, force: true })
      for (const e of readdirSync(dir)) if (!before.has(e)) rmSync(join(dir, e), { recursive: true, force: true })
    },
  }
}

/** One attached recording: holder output → cassette and mirror; steps → PTY input. */
class Run {
  readonly writer = new CastWriter()
  altScreen = false
  private readonly conn: HolderConnection
  private readonly s: Scenario
  private readonly log: (m: string) => void
  private readonly mirror: Mirror
  private readonly t0 = performance.now()
  private nextSeq = 0
  private exit: { code: number; signal: number } | null = null
  private closed: string | null = null
  private failure: Error | null = null
  private readonly wakers = new Set<() => void>() // bounded: at most one waiting step

  constructor(conn: HolderConnection, s: Scenario, log: (m: string) => void) {
    this.conn = conn
    this.s = s
    this.log = log
    const settings = DEFAULT_TERMINAL_SETTINGS
    this.mirror = new Mirror({
      cols: s.cols,
      rows: s.rows,
      scrollback: settings.scrollback,
      colors: colorThemeOf(settings.theme),
      startSeq: 0,
      reply: (d) => this.input(d),
      parsed: (seq) => {
        conn.ack(seq)
        this.wake()
      },
      now: () => performance.now(),
    })
  }

  private now(): number {
    return (performance.now() - this.t0) / 1000
  }

  private wake(): void {
    for (const w of [...this.wakers]) w()
  }

  private input(d: string): void {
    this.conn.input(d)
    this.writer.input(this.now(), d)
  }

  async go(): Promise<number> {
    this.conn.attach('fromSeq', 0, {
      output: (seq, data) => {
        if (seq !== this.nextSeq) {
          this.failure = new Error(`output gap: expected seq ${this.nextSeq}, got ${seq}`)
          this.wake()
          return
        }
        this.nextSeq = seq + data.byteLength
        try {
          this.writer.output(this.now(), data)
        } catch (e) {
          this.failure = e as Error
          this.wake()
          return
        }
        if (!this.altScreen && ALT_SCREEN.test(Buffer.from(data).toString('latin1'))) this.altScreen = true
        this.mirror.write(seq, data)
      },
      exit: (code, signal) => {
        this.exit = { code, signal }
        this.wake()
      },
      error: (code, message) => this.log(`holder error ${code}: ${message}`),
      close: (reason) => {
        this.closed = reason
        this.wake()
      },
    })
    try {
      for (const [i, st] of this.s.steps.entries()) await this.step(i, st)
      if (!this.exit) {
        this.log('agent still running after the last step: terminating it')
        this.conn.terminate(1000)
        await this.until(() => this.exit !== null, 5000, 'exit after TERMINATE')
      }
      // everything the holder sent is parsed before the cassette is closed
      await this.until(() => this.mirror.parsedSeq === this.nextSeq, 5000, 'final parse')
      const seconds = this.now()
      // the child has exited and everything is parsed: the holder may go; it closes the socket when it does
      this.conn.release()
      await this.until(() => this.closed !== null, 2000, 'holder exit after RELEASE').catch(() => this.log('holder did not close after RELEASE'))
      return seconds
    } finally {
      this.conn.destroy()
      this.mirror.dispose()
    }
  }

  private async step(i: number, st: Step): Promise<void> {
    const label = `step ${i + 1} ${JSON.stringify(st)}`
    this.log(label)
    if ('wait' in st) {
      const re = new RegExp(st.wait)
      await this.until(() => re.test(this.screen()), st.timeoutMs ?? 30_000, label)
    } else if ('type' in st) {
      for (const ch of this.s.prompt) {
        this.input(ch)
        await delay(st.keyDelayMs ?? 30)
      }
    } else if ('send' in st) {
      this.input(st.send)
    } else if ('resize' in st) {
      const [cols, rows] = st.resize
      this.conn.resize(cols, rows, 0, 0)
      this.mirror.resize(cols, rows)
      this.writer.resize(this.now(), cols, rows)
    } else if ('pause' in st) {
      await delay(st.pause)
    } else if ('mark' in st) {
      this.writer.marker(this.now(), st.mark)
    } else if ('exit' in st) {
      await this.until(() => this.exit !== null, st.exit, label)
    }
  }

  /** The visible screen, whitespace collapsed (what `wait` steps match). */
  private screen(): string {
    return this.mirror.screenText().replace(/\s+/g, ' ')
  }

  private until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.failure) return done(this.failure)
        if (cond()) return done(null)
        if (this.closed && !this.exit) return done(new Error(`${what}: the holder connection closed (${this.closed})`))
      }
      const timer = setTimeout(() => done(new Error(`${what}: timed out after ${timeoutMs} ms. Screen:\n${this.mirror.screenText()}`)), timeoutMs)
      const done = (err: Error | null) => {
        clearTimeout(timer)
        this.wakers.delete(check)
        if (err) reject(err)
        else resolve()
      }
      this.wakers.add(check)
      check()
    })
  }
}
