// flood: writes N bytes of printable ASCII as fast as stdout takes them, then exits 0. The stream is periodic and a
// pure function of the options, so a test can check any slice of it (`floodExpected`).

import { once } from 'node:events'
import { intFlag, parseFlags, runMain, UsageError } from './cli.ts'

export type Eol = 'lf' | 'crlf' | 'none'

export interface FloodOptions {
  bytes: number
  /** Bytes per line, line ending included (ignored with eol `none`). */
  lineLength: number
  eol: Eol
  /** Bytes per write. */
  chunk: number
  /** Print `{bytes, ms, mbPerSec}` as JSON on stderr when done. */
  report: boolean
}

export const FLOOD_DEFAULTS: Omit<FloodOptions, 'bytes'> = { lineLength: 80, eol: 'lf', chunk: 64 * 1024, report: false }

export const FLOOD_USAGE = `flood: writes N bytes of printable ASCII as fast as possible (tools/process-zoo/README.md)

usage: node tools/process-zoo/src/flood.ts --bytes N [options]
  --bytes N          total bytes (required); suffixes K, M, G = 1024-based, KB, MB, GB = 1000-based (100M = 104857600)
  --line-length L    bytes per line including the line ending (default 80)
  --eol E            lf | crlf | none (default lf)
  --chunk C          bytes per write (default 64K; same suffixes)
  --report           when done, print {"bytes","ms","mbPerSec"} as JSON on stderr
  -h, --help         this text

Exactly N bytes reach stdout (a PTY's ONLCR may add a \\r per \\n on the way to the master). Exits 0 when done, 1 if
stdout fails.
`

const UNITS: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3 }

/** `100M` → 104857600, `1KB` → 1000, `512` → 512. Throws UsageError on anything else. */
export function parseSize(s: string, flag = '--bytes'): number {
  const m = /^\s*(\d+)\s*([KMG]B?|)\s*$/i.exec(s)
  const unit = m ? UNITS[(m[2] as string).toUpperCase()] : undefined
  const n = m && unit !== undefined ? Number(m[1]) * unit : NaN
  if (!Number.isSafeInteger(n)) throw new UsageError(`${flag} must be a byte count like 512, 64K, 100M or 1GB, got "${s}"`)
  return n
}

/** Printable characters `!`…`~`: the stream cycles through them. */
const ALPHABET = 94
const FIRST = 33

/**
 * One period of the stream. Line k holds the printable characters starting at offset k, so a period is 94 lines; with
 * eol `none` it is the 94 characters themselves.
 */
export function floodPeriod(o: Pick<FloodOptions, 'lineLength' | 'eol'>): string {
  if (o.eol === 'none') return Array.from({ length: ALPHABET }, (_, i) => String.fromCharCode(FIRST + i)).join('')
  const ending = o.eol === 'crlf' ? '\r\n' : '\n'
  const text = o.lineLength - ending.length
  let s = ''
  for (let k = 0; k < ALPHABET; k++) {
    for (let j = 0; j < text; j++) s += String.fromCharCode(FIRST + ((k + j) % ALPHABET))
    s += ending
  }
  return s
}

/** The `length` bytes of the stream starting at byte `offset` (for checking a slice: a ring's tail, say). */
export function floodExpected(offset: number, length: number, o: Pick<FloodOptions, 'lineLength' | 'eol'> = FLOOD_DEFAULTS): string {
  const period = floodPeriod(o)
  let s = ''
  let at = offset % period.length
  while (s.length < length) {
    const take = Math.min(period.length - at, length - s.length)
    s += period.slice(at, at + take)
    at = 0
  }
  return s
}

export function parseFloodArgs(argv: readonly string[]): FloodOptions {
  const p = parseFlags(argv, { '--bytes': 'value', '--line-length': 'value', '--eol': 'value', '--chunk': 'value', '--report': 'bool' })
  const bytes = p.values.get('--bytes')
  if (bytes === undefined) throw new UsageError('--bytes is required')
  const eol = (p.values.get('--eol') ?? FLOOD_DEFAULTS.eol) as Eol
  if (!['lf', 'crlf', 'none'].includes(eol)) throw new UsageError(`--eol must be lf, crlf or none, got "${eol}"`)
  const lineLength = intFlag(p, '--line-length', FLOOD_DEFAULTS.lineLength, eol === 'crlf' ? 2 : 1)
  const chunk = p.values.has('--chunk') ? parseSize(p.values.get('--chunk') as string, '--chunk') : FLOOD_DEFAULTS.chunk
  if (chunk < 1) throw new UsageError('--chunk must be at least 1 byte')
  return { bytes: parseSize(bytes), lineLength, eol, chunk, report: p.bools.has('--report') }
}

/** A write buffer: whole periods (so every write starts at period offset 0), about `chunk` bytes. */
export function floodBuffer(o: Pick<FloodOptions, 'lineLength' | 'eol' | 'chunk'>): Buffer {
  const period = Buffer.from(floodPeriod(o), 'latin1')
  const n = Math.max(1, Math.floor(o.chunk / period.length))
  return Buffer.concat(Array.from({ length: n }, () => period))
}

async function main(argv: readonly string[]): Promise<void> {
  const o = parseFloodArgs(argv)
  process.stdout.on('error', () => process.exit(1))
  const buf = floodBuffer(o)
  const t0 = performance.now()
  let left = o.bytes
  while (left > 0) {
    const piece = left >= buf.length ? buf : buf.subarray(0, left)
    left -= piece.length
    if (!process.stdout.write(piece)) await once(process.stdout, 'drain')
  }
  // resolves once everything is handed to the OS (pipes are asynchronous on macOS)
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
  if (o.report) {
    const ms = performance.now() - t0
    process.stderr.write(`${JSON.stringify({ bytes: o.bytes, ms: Math.round(ms * 10) / 10, mbPerSec: Math.round((o.bytes / 1e6 / (ms / 1000)) * 10) / 10 })}\n`)
  }
}

if (import.meta.main) runMain(FLOOD_USAGE, process.argv.slice(2), main)
