// Cassettes: asciicast v2 files (https://docs.asciinema.org/manual/asciicast/v2/), one JSON header line then one
// `[seconds, code, data]` line per event. Kea uses "o" (PTY output), "i" (bytes written to the PTY: keys and the
// mirror's query replies), "r" (resize, "COLSxROWS") and "m" (a marker naming a scenario step).
//
// Output is byte-exact. PTY bytes are decoded as one UTF-8 stream, so a code point split across reads moves whole into
// the next event, and output that is not valid UTF-8 is refused: concatenating the "o" data and encoding it as UTF-8
// gives back exactly the bytes the PTY produced. The header's `kea.bytes` is that length, checked on read.

export type CastCode = 'o' | 'i' | 'r' | 'm'
export type CastEvent = [number, CastCode, string]

export interface KeaCastMeta {
  scenario: string
  agent: string
  agentVersion: string
  /** The demo prompt typed (tools/recorder/demo-prompts.json). */
  prompt: string
  /** Where the model's answers came from: always the local mock (tools/mock-model), never a real model. */
  model: 'mock-model'
  /** Total output bytes (the "o" data, UTF-8 encoded). */
  bytes: number
  /** The agent switched to the alternate screen at some point (fullscreen renderer). */
  altScreen: boolean
  recorder: string
}

export interface CastHeader {
  version: 2
  width: number
  height: number
  env?: Record<string, string>
  title?: string
  kea?: KeaCastMeta
}

export class CastError extends Error {
  override name = 'CastError'
}

const round = (t: number) => Math.round(Math.max(0, t) * 1e6) / 1e6

export class CastWriter {
  private readonly lines: string[] = [] // bounded: one recording, finished once
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private outBytes = 0
  private lastT = 0

  /** Output bytes recorded so far. */
  get bytes(): number {
    return this.outBytes
  }

  output(t: number, data: Uint8Array): void {
    let s: string
    try {
      s = this.decoder.decode(data, { stream: true })
    } catch {
      throw new CastError(`output at ${t.toFixed(3)} s is not valid UTF-8: a cassette could not reproduce it byte for byte`)
    }
    this.outBytes += data.byteLength
    if (s) this.push(t, 'o', s)
  }

  input(t: number, data: string): void {
    this.push(t, 'i', data)
  }

  resize(t: number, cols: number, rows: number): void {
    this.push(t, 'r', `${cols}x${rows}`)
  }

  marker(t: number, label: string): void {
    this.push(t, 'm', label)
  }

  /** The finished file. Throws if the output ended inside a UTF-8 sequence. */
  finish(header: Omit<CastHeader, 'kea'> & { kea: Omit<KeaCastMeta, 'bytes'> }): string {
    try {
      const tail = this.decoder.decode()
      if (tail) throw new Error('trailing bytes')
    } catch {
      throw new CastError('output ended inside a UTF-8 sequence')
    }
    const h: CastHeader = { ...header, kea: { ...header.kea, bytes: this.outBytes } }
    return `${[JSON.stringify(h), ...this.lines].join('\n')}\n`
  }

  private push(t: number, code: CastCode, data: string): void {
    // events are ordered: a timestamp never goes backwards
    this.lastT = Math.max(this.lastT, round(t))
    this.lines.push(JSON.stringify([this.lastT, code, data]))
  }
}

export interface Cast {
  header: CastHeader
  events: CastEvent[]
}

export function parseCast(text: string): Cast {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) throw new CastError('empty cassette')
  const header = JSON.parse(lines[0] as string) as CastHeader
  if (header.version !== 2 || !Number.isInteger(header.width) || !Number.isInteger(header.height)) throw new CastError('not an asciicast v2 header')
  const events: CastEvent[] = []
  let last = 0
  for (let i = 1; i < lines.length; i++) {
    const e = JSON.parse(lines[i] as string) as unknown
    if (!Array.isArray(e) || e.length !== 3 || typeof e[0] !== 'number' || typeof e[2] !== 'string' || !['o', 'i', 'r', 'm'].includes(e[1] as string)) {
      throw new CastError(`line ${i + 1}: not an event`)
    }
    if (e[0] < last) throw new CastError(`line ${i + 1}: time goes backwards`)
    last = e[0]
    events.push(e as CastEvent)
  }
  const cast = { header, events }
  if (header.kea && outputBytes(cast).byteLength !== header.kea.bytes) throw new CastError('output length differs from kea.bytes')
  return cast
}

/** Every output byte, in order: what the PTY produced. */
export function outputBytes(cast: Cast): Uint8Array {
  return new TextEncoder().encode(cast.events.flatMap((e) => (e[1] === 'o' ? [e[2]] : [])).join(''))
}

/** Output events as byte chunks with their times (seconds), for replay through a mirror or renderer. */
export function outputChunks(cast: Cast): { t: number; data: Uint8Array }[] {
  const enc = new TextEncoder()
  return cast.events.flatMap((e) => (e[1] === 'o' ? [{ t: e[0], data: enc.encode(e[2]) }] : []))
}
