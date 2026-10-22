// Terminal I/O for fake-agent: the sequences a TUI writes, the input router (probe replies vs keystrokes) and the
// process terminal (raw mode, size, SIGWINCH, back-pressure, restore on exit, PTY close).

import { StringDecoder } from 'node:string_decoder'
import { KeyQueue, parseKeys } from './keys.ts'
import type { ProbeBatch, ProbeResult } from './probes.ts'

export const ALT_SCREEN_ENTER = '\x1b[?1049h'
export const ALT_SCREEN_LEAVE = '\x1b[?1049l'
export const SYNC_BEGIN = '\x1b[?2026h'
export const SYNC_END = '\x1b[?2026l'
export const CURSOR_SHOW = '\x1b[?25h'
export const BEL = '\x07'

/** Text inside an OSC string: control characters would end or corrupt the sequence. */
function oscText(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, ' ')
}

export function titleSeq(text: string, osc: 0 | 2): string {
  return `\x1b]${osc};${oscText(text)}\x07`
}

export function notifySeq(osc: 9 | 777, title: string, body: string): string {
  if (osc === 9) return `\x1b]9;${oscText(body)}\x07`
  return `\x1b]777;notify;${oscText(title).replace(/;/g, ',')};${oscText(body)}\x07`
}

/** Clip a line to `cols` characters (one cell per code point: the fake agent draws ASCII-ish text). */
function clip(line: string, cols: number): string {
  const cps = [...line]
  return cps.length <= cols ? line : cps.slice(0, cols).join('')
}

/** A full-screen frame: home, clear, the lines (clipped to the width, cut to the height), wrapped in DEC 2026. */
export function frameBytes(lines: readonly string[], size: { cols: number; rows: number }, sync: boolean): string {
  const body = lines.slice(0, Math.max(1, size.rows)).map((l) => clip(l, Math.max(1, size.cols)))
  const draw = `\x1b[H\x1b[2J${body.join('\r\n')}`
  return sync ? SYNC_BEGIN + draw + SYNC_END : draw
}

/** What the scenario runner needs from a terminal; the process terminal and the tests' fake both provide it. */
export interface Io {
  write(s: string): Promise<void>
  size(): { cols: number; rows: number }
  readonly keys: KeyQueue
  /** Send a probe batch and collect replies until its sentinel arrives or `timeoutMs` passes. */
  probe(batch: ProbeBatch, timeoutMs: number, signal: AbortSignal): Promise<ProbeResult[]>
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
}

export class AbortedError extends Error {
  constructor() {
    super('aborted')
  }
}

/** Abortable timer; rejects with AbortedError when the signal fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Routes terminal input: while a probe batch is active its replies are taken out, everything else becomes keys.
 * Shared by the process terminal and tests (feed `input` with reply bytes).
 */
export class InputRouter {
  readonly keys = new KeyQueue()
  private active: { batch: ProbeBatch; now: () => number; done: () => void } | null = null

  input(chunk: string): void {
    if (this.active) {
      const a = this.active
      const rest = a.batch.feed(chunk, a.now())
      if (rest) this.keys.push(parseKeys(rest))
      if (a.batch.done) a.done()
      return
    }
    this.keys.push(parseKeys(chunk))
  }

  /** Write the batch's queries with `write`, then wait for its sentinel, the timeout or the abort. */
  async probe(batch: ProbeBatch, timeoutMs: number, signal: AbortSignal, io: { write(s: string): Promise<void>; now(): number }): Promise<ProbeResult[]> {
    if (signal.aborted) throw new AbortedError()
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    const timer = setTimeout(finish, timeoutMs)
    const onAbort = () => finish()
    signal.addEventListener('abort', onAbort, { once: true })
    this.active = { batch, now: () => io.now(), done: finish }
    try {
      await io.write(batch.start(io.now()))
      await done
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      this.active = null
    }
    const { results, leftover } = batch.finish()
    if (leftover) this.keys.push(parseKeys(leftover))
    if (signal.aborted) throw new AbortedError()
    return results
  }
}

export interface ProcessTerminalHandlers {
  /** stdin hit EOF or EIO (the PTY closed). */
  onInputClosed(): void
  /** stdout failed (EIO/EPIPE): nothing more can be shown. */
  onOutputClosed(): void
  onResize(size: { cols: number; rows: number }): void
}

const DEFAULT_SIZE = { cols: 80, rows: 24 }

/** The real terminal: process.stdin/stdout, raw mode when stdin is a TTY. */
export class ProcessTerminal implements Io {
  private readonly router = new InputRouter()
  private readonly decoder = new StringDecoder('utf8')
  private readonly t0 = performance.now()
  private outputOpen = true
  private raw = false
  altScreen = false

  constructor(h: ProcessTerminalHandlers) {
    const { stdin, stdout } = process
    if (stdin.isTTY) {
      stdin.setRawMode(true)
      this.raw = true
    }
    stdin.on('data', (b: Buffer) => this.router.input(this.decoder.write(b)))
    const inputGone = () => {
      this.router.keys.close()
      h.onInputClosed()
    }
    stdin.on('end', inputGone)
    stdin.on('error', inputGone)
    stdout.on('error', () => {
      this.outputOpen = false
      h.onOutputClosed()
    })
    if (stdout.isTTY) stdout.on('resize', () => h.onResize(this.size()))
  }

  get keys(): KeyQueue {
    return this.router.keys
  }

  now(): number {
    return performance.now() - this.t0
  }

  size(): { cols: number; rows: number } {
    const { stdout, env } = process
    if (stdout.isTTY && stdout.columns > 0 && stdout.rows > 0) return { cols: stdout.columns, rows: stdout.rows }
    const cols = Number(env.COLUMNS)
    const rows = Number(env.LINES)
    return cols > 0 && rows > 0 ? { cols, rows } : DEFAULT_SIZE
  }

  write(s: string): Promise<void> {
    if (!this.outputOpen || s === '') return Promise.resolve()
    if (s.includes(ALT_SCREEN_ENTER)) this.altScreen = true
    if (s.includes(ALT_SCREEN_LEAVE)) this.altScreen = false
    // resolves once the bytes are handed to the PTY: a reader that stops reading holds the agent here, as it would
    // hold a real CLI
    return new Promise((resolve) => process.stdout.write(s, () => resolve()))
  }

  probe(batch: ProbeBatch, timeoutMs: number, signal: AbortSignal): Promise<ProbeResult[]> {
    return this.router.probe(batch, timeoutMs, signal, this)
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return sleep(ms, signal)
  }

  get canWrite(): boolean {
    return this.outputOpen
  }

  /** Leave the alternate screen, show the cursor, cooked mode again; stop reading so the process can exit. */
  restore(): string {
    const bytes = (this.altScreen ? ALT_SCREEN_LEAVE : '') + CURSOR_SHOW
    if (this.outputOpen) {
      try {
        process.stdout.write(bytes)
      } catch {
        // the PTY is gone
      }
    }
    this.altScreen = false
    if (this.raw) {
      try {
        process.stdin.setRawMode(false)
      } catch {
        // the PTY is gone
      }
      this.raw = false
    }
    process.stdin.pause()
    return bytes
  }
}
