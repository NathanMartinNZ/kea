// intruder: a same-user process that connects to a unix socket (a holder's) and writes input, then reports what the
// other side did (the holder must refuse it at once and write nothing to the PTY). With --holder it speaks the
// holder wire protocol — HELLO, ATTACH latest, INPUT — so the refusal is tested against a client that knows the
// protocol, not just against garbage.

import { createConnection } from 'node:net'
import { encodeClientFrame, HOLDER_PROTO, type HolderFrame, holderFrameSplitter } from '../../../packages/protocol/src/holder.ts'
import { intFlag, parseFlags, runMain, unescape, UsageError } from './cli.ts'

export const INTRUDER_USAGE = `intruder: connects to a unix socket and writes input, then reports what happened (tools/process-zoo/README.md)

usage: node tools/process-zoo/src/intruder.ts --socket PATH [options]
  --socket PATH      the unix socket (required)
  --data TEXT        bytes to write; \\r \\n \\e \\xHH escapes (default "y\\r")
  --hex HEX          bytes to write, as hex (instead of --data)
  --holder           wrap them as holder frames: HELLO, ATTACH latest, INPUT
  --wait-ms N        after writing, how long to wait for the other side to close (default 1000)
  -h, --help         this text

Prints one JSON line: {"connected","connectError","wrote","writeError","received","receivedHex","frames",
"closedBy":"peer"|"timeout"|"error","closeError","ms"}. Exits 0 when it connected, 1 when it could not, 2 for a usage
error.
`

export interface IntruderOptions {
  socket: string
  payload: Uint8Array
  holder: boolean
  waitMs: number
}

export interface IntruderReport {
  connected: boolean
  connectError: string | null
  /** Bytes handed to the socket (writeError says if the write then failed). */
  wrote: number
  writeError: string | null
  received: number
  /** The first bytes received, hex (capped). */
  receivedHex: string
  /** With --holder: the holder frames received (OUTPUT data reduced to its length). */
  frames: (Exclude<HolderFrame, { t: 'output' }> | { t: 'output'; seq: number; bytes: number })[] | null
  closedBy: 'peer' | 'timeout' | 'error' | null
  closeError: string | null
  /** From connecting to the close (or the timeout). */
  ms: number
}

const RECEIVED_HEX_CAP = 1024

export function parseIntruderArgs(argv: readonly string[]): IntruderOptions {
  const p = parseFlags(argv, { '--socket': 'value', '--data': 'value', '--hex': 'value', '--holder': 'bool', '--wait-ms': 'value' })
  const socket = p.values.get('--socket')
  if (!socket) throw new UsageError('--socket is required')
  if (p.values.has('--data') && p.values.has('--hex')) throw new UsageError('--data and --hex are exclusive')
  let payload: Uint8Array
  const hex = p.values.get('--hex')
  if (hex !== undefined) {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new UsageError(`--hex needs pairs of hex digits, got "${hex}"`)
    payload = Buffer.from(hex, 'hex')
  } else payload = Buffer.from(unescape(p.values.get('--data') ?? 'y\\r'), 'latin1')
  return { socket, payload, holder: p.bools.has('--holder'), waitMs: intFlag(p, '--wait-ms', 1000, 0) }
}

/** The bytes intruder writes: the payload as is, or as a holder client's HELLO + ATTACH(latest) + INPUT(payload). */
export function intruderBytes(o: Pick<IntruderOptions, 'payload' | 'holder'>): Buffer {
  if (!o.holder) return Buffer.from(o.payload)
  return Buffer.concat([
    encodeClientFrame({ t: 'hello', proto: HOLDER_PROTO }),
    encodeClientFrame({ t: 'attach', mode: 'latest', seq: 0 }),
    encodeClientFrame({ t: 'input', data: o.payload }),
  ])
}

/** Connect, write, wait for the close (or `waitMs`), report. Never throws. */
export function intrude(o: IntruderOptions): Promise<IntruderReport> {
  const r: IntruderReport = { connected: false, connectError: null, wrote: 0, writeError: null, received: 0, receivedHex: '', frames: o.holder ? [] : null, closedBy: null, closeError: null, ms: 0 }
  const splitter = o.holder ? holderFrameSplitter() : null
  const t0 = performance.now()
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const sock = createConnection({ path: o.socket })
    const finish = (closedBy: IntruderReport['closedBy']) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (r.connected) r.closedBy ??= closedBy
      r.ms = Math.round((performance.now() - t0) * 100) / 100
      sock.destroy()
      resolve(r)
    }
    sock.on('connect', () => {
      r.connected = true
      const bytes = intruderBytes(o)
      sock.write(bytes, (e) => {
        if (e && !settled) r.writeError ??= (e as NodeJS.ErrnoException).code ?? e.message
      })
      r.wrote = bytes.length
      timer = setTimeout(() => finish('timeout'), o.waitMs)
    })
    sock.on('data', (d: Buffer) => {
      r.receivedHex += d.subarray(0, Math.max(0, RECEIVED_HEX_CAP - r.received)).toString('hex')
      r.received += d.length
      if (splitter && r.frames) {
        try {
          for (const f of splitter.push(d)) r.frames.push(f.t === 'output' ? { t: 'output', seq: f.seq, bytes: f.data.byteLength } : f)
        } catch {
          // not holder frames: the hex shows what came
        }
      }
    })
    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (!r.connected) {
        r.connectError = e.code ?? e.message
        return finish(null)
      }
      r.closeError = e.code ?? e.message
      if (e.code === 'EPIPE') r.writeError ??= e.code
      finish(e.code === 'ECONNRESET' || e.code === 'EPIPE' ? 'peer' : 'error')
    })
    sock.on('end', () => finish('peer'))
    sock.on('close', () => finish(r.connected ? 'peer' : null))
  })
}

async function main(argv: readonly string[]): Promise<void> {
  const r = await intrude(parseIntruderArgs(argv))
  process.stdout.write(`${JSON.stringify(r)}\n`)
  process.exitCode = r.connected ? 0 : 1
}

if (import.meta.main) runMain(INTRUDER_USAGE, process.argv.slice(2), main)
