// counter: prints sequence numbers, one per line, to detect loss or duplication through the PTY stack. The output is a
// pure function of the options, so a test can rebuild it byte for byte (`counterText`) or check a captured stream
// (`verifyCounter`).

import { once } from 'node:events'
import { intFlag, numFlag, parseFlags, runMain, unescape, UsageError } from './cli.ts'

export interface CounterOptions {
  /** First number. */
  start: number
  /** How many numbers; null: until killed. */
  count: number | null
  /** Lines per second; 0: as fast as the reader takes them. */
  rate: number
  /** Line template; `{n}` is the number. Escapes are already applied. */
  format: string
  /** Zero-pad numbers to this many digits (0: no padding). */
  width: number
}

export const COUNTER_DEFAULTS: CounterOptions = { start: 1, count: 1000, rate: 0, format: '{n}\n', width: 0 }

export const COUNTER_USAGE = `counter: prints sequence numbers, one per line (tools/process-zoo/README.md)

usage: node tools/process-zoo/src/counter.ts [options]
  --count N        how many numbers (default 1000)
  --forever        no end: count until killed
  --start S        first number (default 1)
  --rate R         lines per second; 0 = as fast as the reader allows (default 0)
  --format F       line template, {n} is the number; \\n \\r \\t \\e escapes (default "{n}\\n")
  --width W        zero-pad numbers to W digits (default 0: no padding)
  -h, --help       this text

Exits 0 after the last line has been handed to stdout; 1 if stdout fails (the reader went away).
`

export function counterLine(n: number, o: Pick<CounterOptions, 'format' | 'width'>): string {
  return o.format.replaceAll('{n}', String(n).padStart(o.width, '0'))
}

/**
 * The exact bytes counter writes for a finite count. `crlf`: as read from a PTY master, where the terminal's output
 * processing (ONLCR) turns each `\n` into `\r\n`.
 */
export function counterText(o: Partial<CounterOptions> & { count: number }, crlf = false): string {
  const opts = { ...COUNTER_DEFAULTS, ...o }
  let s = ''
  for (let i = 0; i < opts.count; i++) s += counterLine(opts.start + i, opts)
  return crlf ? s.replaceAll('\n', '\r\n') : s
}

export interface CounterCheck {
  /** Lines that parsed as a number. */
  lines: number
  first: number | null
  last: number | null
  /** Numbers absent between start (or the first seen) and the last seen. Capped at 100. */
  missing: number[]
  /** Numbers seen more than once. Capped at 100. */
  duplicates: number[]
  /** Times a number was not greater than the one before it. */
  outOfOrder: number
  /** Lines that do not match the format. Capped at 20. */
  badLines: string[]
  /** Every number once, in order, nothing else; and, when `expect` gave them, starting at `start` with `count` lines. */
  ok: boolean
}

const CAP_NUMBERS = 100
const CAP_LINES = 20

/**
 * Check a captured counter stream (pipe or PTY bytes: `\r\n` and stray `\r` are accepted). A trailing partial line is
 * ignored unless `final` is set (the stream is complete).
 */
export function verifyCounter(text: string, expect: Partial<Pick<CounterOptions, 'start' | 'format' | 'width'>> & { count?: number; final?: boolean } = {}): CounterCheck {
  const format = expect.format ?? COUNTER_DEFAULTS.format
  if (!format.endsWith('\n') || format.indexOf('\n') !== format.length - 1) throw new Error('verifyCounter needs a format with exactly one \\n, at the end')
  const [before, after] = format.slice(0, -1).replace(/\r$/, '').split('{n}') as [string, string | undefined]
  if (after === undefined) throw new Error('verifyCounter needs {n} in the format')
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const digits = expect.width ? `\\d{${expect.width},}` : '\\d+'
  const line = new RegExp(`^${esc(before)}(${digits})${esc(after)}$`)
  const parts = text.split('\n')
  if (!expect.final || parts.at(-1) === '') parts.pop() // partial (or empty) last line
  const r: CounterCheck = { lines: 0, first: null, last: null, missing: [], duplicates: [], outOfOrder: 0, badLines: [], ok: false }
  const seen = new Set<number>() // bounded: one entry per line of the text being checked
  let prev: number | null = null
  for (const raw of parts) {
    const m = line.exec(raw.replace(/^\r+|\r+$/g, ''))
    if (!m) {
      if (r.badLines.length < CAP_LINES) r.badLines.push(raw)
      continue
    }
    const n = Number(m[1])
    r.lines++
    r.first ??= n
    if (seen.has(n)) {
      if (r.duplicates.length < CAP_NUMBERS) r.duplicates.push(n)
    } else seen.add(n)
    if (prev !== null && n <= prev) r.outOfOrder++
    prev = n
    r.last = n
  }
  if (r.first !== null && r.last !== null) {
    const from = Math.min(expect.start ?? r.first, r.first)
    for (let n = from; n <= r.last && r.missing.length < CAP_NUMBERS; n++) if (!seen.has(n)) r.missing.push(n)
  }
  const startOk = expect.start === undefined || r.first === expect.start || (r.first === null && expect.count === 0)
  const countOk = expect.count === undefined || r.lines === expect.count
  r.ok = r.badLines.length === 0 && r.missing.length === 0 && r.duplicates.length === 0 && r.outOfOrder === 0 && startOk && countOk
  return r
}

export function parseCounterArgs(argv: readonly string[]): CounterOptions {
  const p = parseFlags(argv, { '--count': 'value', '--forever': 'bool', '--start': 'value', '--rate': 'value', '--format': 'value', '--width': 'value' })
  if (p.bools.has('--forever') && p.values.has('--count')) throw new UsageError('--count and --forever are exclusive')
  const format = p.values.has('--format') ? unescape(p.values.get('--format') as string) : COUNTER_DEFAULTS.format
  if (!format.includes('{n}')) throw new UsageError('--format needs {n}')
  return {
    start: intFlag(p, '--start', COUNTER_DEFAULTS.start, 0),
    count: p.bools.has('--forever') ? null : intFlag(p, '--count', COUNTER_DEFAULTS.count as number, 0),
    rate: numFlag(p, '--rate', COUNTER_DEFAULTS.rate),
    format,
    width: intFlag(p, '--width', COUNTER_DEFAULTS.width, 0, 20),
  }
}

/** Chunk size for unpaced output: big enough to keep the PTY busy, small enough to stop promptly. */
const CHUNK_CHARS = 64 * 1024
/** Pacing tick, ms: paced output is written in batches at most this far apart. */
const MAX_TICK_MS = 20

async function write(s: string): Promise<void> {
  if (!process.stdout.write(s)) await once(process.stdout, 'drain')
}

async function main(argv: readonly string[]): Promise<void> {
  const o = parseCounterArgs(argv)
  process.stdout.on('error', () => process.exit(1))
  const end = o.count === null ? Infinity : o.start + o.count
  let n = o.start
  if (o.rate === 0) {
    while (n < end) {
      let s = ''
      while (n < end && s.length < CHUNK_CHARS) s += counterLine(n++, o)
      await write(s)
    }
    return
  }
  const t0 = performance.now()
  const tick = Math.max(1, Math.min(MAX_TICK_MS, 1000 / o.rate))
  while (n < end) {
    const due = Math.min(end, o.start + Math.floor(((performance.now() - t0) * o.rate) / 1000) + 1)
    let s = ''
    while (n < due) s += counterLine(n++, o)
    if (s) await write(s)
    if (n < end) await new Promise((r) => setTimeout(r, tick))
  }
}

if (import.meta.main) runMain(COUNTER_USAGE, process.argv.slice(2), main)
