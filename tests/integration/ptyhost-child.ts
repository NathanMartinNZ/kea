// Programs that run inside the test PTYs of the ptyhost suites (integration, chaos, memory), as
// `node tests/integration/ptyhost-child.ts <mode> …`. Each stays alive until its terminal ends it (TERMINATE), so a
// test decides when the PTY exits. Tests build the argv with `childArgv`; `castPlan` is shared with the tests, so the
// player stops exactly where the test expects it to.
//
//   play <cast> [--pauses a,b,…]  write a cassette's output (byte-exact; run it under `rawTty` so the tty adds
//                                 nothing). Where the cassette resizes the terminal, wait for SIGWINCH; at each
//                                 offset in --pauses, wait for SIGUSR2. So the test can act at an exact byte.
//   talk [--print T]… [--then T]… [--record FILE] [--lines N] [--width W] [--query T]
//                                 print each --print at once; on each SIGUSR2 print the next --then, or (when they
//                                 are used up, or none were given) a batch of N numbered lines of width W; on each
//                                 QUERY_SIGNAL print --query (I-PTY-18: a query from a PTY whose ring is full).
//                                 --record appends every byte read from the terminal to FILE (replies, keystrokes).
//   sizes FILE                    append "<cols>x<rows>\n" to FILE at start and on every size change (SIGWINCH).
//   echo                          write every byte read straight back (under `rawTty`: an echo round trip).
//   flood BYTES [--each]          write BYTES bytes of `floodBlock()` (coloured numbered lines) as fast as the tty takes
//                                 them, then wait; with --each, print FLOOD_READY, then BYTES on every SIGUSR2 instead.
//
// T accepts \e \r \n \a \xHH escapes.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseCast, type CastHeader } from '../../tools/recorder/src/cast.ts'

const SELF = fileURLToPath(import.meta.url)

/** The argv that runs this program in `mode` (a PTY's `file` + `args`). */
export function childArgv(mode: 'play' | 'talk' | 'sizes' | 'echo' | 'flood', args: string[] = []): string[] {
  return [process.execPath, SELF, mode, ...args]
}

export type CastStop = { at: number; kind: 'resize'; cols: number; rows: number } | { at: number; kind: 'pause' }

export interface CastPlan {
  header: CastHeader
  /** All output, as the PTY produced it. */
  bytes: Uint8Array
  /** Where the player waits, in order: resizes (size changes only) and the requested pauses. */
  stops: CastStop[]
}

/** What `play` does with `castFile` and `pauses`: the same computation on both sides of the PTY. */
export function castPlan(castFile: string, pauses: number[] = []): CastPlan {
  const cast = parseCast(fs.readFileSync(castFile, 'utf8'))
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const stops: CastStop[] = []
  let seq = 0
  let cols = cast.header.width
  let rows = cast.header.height
  for (const [, code, data] of cast.events) {
    if (code === 'o') {
      const b = enc.encode(data)
      parts.push(b)
      seq += b.byteLength
    } else if (code === 'r') {
      const [c, r] = data.split('x').map(Number) as [number, number]
      if (c === cols && r === rows) continue
      cols = c
      rows = r
      stops.push({ at: seq, kind: 'resize', cols, rows })
    }
  }
  const bytes = new Uint8Array(seq)
  let o = 0
  for (const p of parts) {
    bytes.set(p, o)
    o += p.byteLength
  }
  for (const at of new Set(pauses)) if (at > 0 && at < seq) stops.push({ at, kind: 'pause' })
  stops.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'pause' ? -1 : 1))
  return { header: cast.header, bytes, stops }
}

/** The bytes `talk --lines n --width w` prints for its batch starting at line `first` (so a test can rebuild them). */
export function talkLines(first: number, n: number, width: number): string {
  let out = ''
  for (let i = first; i < first + n; i++) {
    const head = `line ${String(i).padStart(8, '0')} `
    out += `${head}${'abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(width / 26)).slice(0, Math.max(0, width - head.length))}\r\n`
  }
  return out
}

function unescape(s: string): string {
  return s.replace(/\\(e|r|n|a|x[0-9a-fA-F]{2}|\\)/g, (_, c: string) =>
    c === 'e' ? '\x1b' : c === 'r' ? '\r' : c === 'n' ? '\n' : c === 'a' ? '\x07' : c === '\\' ? '\\' : String.fromCharCode(parseInt(c.slice(1), 16)),
  )
}

/** Signals counted as they arrive, consumed by waits: one that came before its wait is not lost. */
function signalCounter(sig: NodeJS.Signals) {
  let count = 0
  let wake: (() => void) | null = null
  process.on(sig, () => {
    count++
    wake?.()
  })
  return {
    async next(): Promise<void> {
      while (count === 0) await new Promise<void>((r) => (wake = r))
      wake = null
      count--
    },
  }
}

function stayAlive(): void {
  setInterval(() => {}, 1 << 30)
}

const write = (b: Uint8Array | string) => {
  const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b
  let o = 0
  while (o < buf.byteLength) o += fs.writeSync(1, buf, o, buf.byteLength - o)
}

function flag(args: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === name && i + 1 < args.length) out.push(args[++i]!)
  return out
}

async function play(args: string[]): Promise<void> {
  const pauses = (flag(args, '--pauses')[0] ?? '').split(',').filter(Boolean).map(Number)
  const plan = castPlan(args[0]!, pauses)
  const winch = signalCounter('SIGWINCH')
  const usr2 = signalCounter('SIGUSR2')
  stayAlive()
  let at = 0
  for (const s of plan.stops) {
    write(plan.bytes.subarray(at, s.at))
    at = s.at
    await (s.kind === 'resize' ? winch : usr2).next()
  }
  write(plan.bytes.subarray(at))
}

/**
 * What makes `talk` print its --query: SIGURG, which both systems have and nothing sends a process with no socket. Not
 * SIGUSR1 (Node's debugger signal) or SIGINFO (macOS only).
 */
export const QUERY_SIGNAL: NodeJS.Signals = 'SIGURG'

async function talk(args: string[]): Promise<void> {
  const record = flag(args, '--record')[0]
  const lines = Number(flag(args, '--lines')[0] ?? 0)
  const width = Number(flag(args, '--width')[0] ?? 40)
  const thens = flag(args, '--then').map(unescape)
  const query = flag(args, '--query').map(unescape)[0]
  if (query !== undefined) process.on(QUERY_SIGNAL, () => write(query))
  const usr2 = signalCounter('SIGUSR2')
  stayAlive()
  if (record) {
    const fd = fs.openSync(record, 'a', 0o600)
    process.stdin.on('data', (d: Buffer) => fs.writeSync(fd, d))
  } else {
    process.stdin.resume()
  }
  for (const p of flag(args, '--print')) write(unescape(p))
  let n = 0
  for (;;) {
    await usr2.next()
    const t = thens.shift()
    if (t !== undefined) {
      write(t)
      continue
    }
    write(talkLines(n, lines, width))
    n += lines
  }
}

function sizes(args: string[]): void {
  const file = args[0]!
  const note = () => fs.appendFileSync(file, `${process.stdout.columns}x${process.stdout.rows}\n`)
  // Node's 'resize', not a SIGWINCH listener of this script's: `columns`, `rows` and `getWindowSize()` are Node's copy,
  // which its own SIGWINCH listener re-reads, and that listener is added when `process.stdout` is first touched, after
  // this script's would have been, so this script's would note the size before the latest one (I-PTY-10 under load)
  process.stdout.on('resize', note)
  note()
  stayAlive()
}

/** The flood's repeating block, just under 1 MiB: numbered lines, each coloured (an SGR on, text, SGR off, CR LF). */
export function floodBlock(): Buffer {
  let s = ''
  for (let i = 0; s.length < (1 << 20) - 128; i++) {
    const text = `line ${String(i).padStart(8, '0')} `
    s += `\x1b[3${i % 8}m${text}${'abcdefghijklmnopqrstuvwxyz'.repeat(3).slice(0, 70 - text.length)}\x1b[0m\r\n`
  }
  return Buffer.from(s, 'latin1')
}

function flood(args: string[]): void {
  const block = floodBlock()
  const bytes = Number(args[0])
  const pour = () => {
    for (let left = bytes; left > 0; ) {
      const n = Math.min(left, block.byteLength)
      write(block.subarray(0, n))
      left -= n
    }
  }
  stayAlive()
  process.stdin.resume()
  if (!args.includes('--each')) return pour()
  process.on('SIGUSR2', pour)
  write(FLOOD_READY) // the handler is in place: signals are safe from here
}

/** What `flood --each` prints once it can take signals. */
export const FLOOD_READY = 'ready\r\n'

function echo(): void {
  process.stdin.on('data', (d: Buffer) => write(d))
}

if (process.argv[1] === SELF) {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === 'play') await play(rest)
  else if (mode === 'talk') await talk(rest)
  else if (mode === 'sizes') sizes(rest)
  else if (mode === 'echo') echo()
  else if (mode === 'flood') flood(rest)
  else {
    process.stderr.write(`ptyhost-child: unknown mode ${mode}\n`)
    process.exit(2)
  }
}
