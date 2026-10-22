// Holder wire protocol v1, mirrored from native/kea-helper/src/proto.rs.
// Frame = type:u8 | len:u32le | payload. Fixed little-endian structs; variable parts u16-length-prefixed.
// Both sides test against fixtures/protocol/holder-golden.json (U-HLD-1).
import { L } from './generated/limits.ts'

export const HOLDER_PROTO = L.holderProtocolVersion

export const T = {
  HELLO: 0x01,
  ATTACH: 0x02,
  INPUT: 0x03,
  RESIZE: 0x04,
  ACK: 0x05,
  SIGNAL: 0x06,
  TERMINATE: 0x07,
  STAT: 0x08,
  DETACH: 0x09,
  RELEASE: 0x0a,
  H_HELLO: 0x81,
  OUTPUT: 0x82,
  EXIT: 0x83,
  H_STAT: 0x84,
  ERROR: 0x85,
} as const

export const ATTACH_MODE = { fromSeq: 0, earliest: 1, latest: 2 } as const
export type AttachMode = keyof typeof ATTACH_MODE
export const SIGNAL_TARGET = { child: 0, fg: 1, session: 2 } as const
export type SignalTarget = keyof typeof SIGNAL_TARGET
export const HOLDER_ERROR = { unknownType: 1, badLength: 2, badProto: 3, notHello: 4, internal: 5, childAlive: 6, notAttached: 7 } as const

export type ClientFrame =
  | { t: 'hello'; proto: number }
  | { t: 'attach'; mode: AttachMode; seq: number }
  | { t: 'input'; data: Uint8Array }
  | { t: 'resize'; cols: number; rows: number; xpx: number; ypx: number }
  | { t: 'ack'; seq: number }
  | { t: 'signal'; signo: number; target: SignalTarget }
  | { t: 'terminate'; graceMs: number }
  | { t: 'stat' }
  | { t: 'detach' }
  | { t: 'release' }

export type HolderHello = {
  t: 'hello'
  proto: number
  childPid: number
  cols: number
  rows: number
  earliestSeq: number
  latestSeq: number
  exited: boolean
  code: number
  signal: number
  ptyId: string
}
export type HolderStat = { t: 'stat'; childPid: number; fgPid: number; fgName: string; cwd: string; descendants: number[] }
export type HolderFrame =
  | HolderHello
  | { t: 'output'; seq: number; data: Uint8Array }
  | { t: 'exit'; code: number; signal: number }
  | HolderStat
  | { t: 'error'; code: number; message: string }

export class HolderProtocolError extends Error {
  /** From `FrameSplitter.push`: the frames decoded before the bad one, so the outcome never depends on read sizes. */
  before: readonly unknown[] = []
  constructor(message: string) {
    super(message)
    this.name = 'HolderProtocolError'
  }
}

const HEADER = 5
const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: false })

// u64 seq values travel as JS numbers: exact below 2^53, i.e. 8 PiB of output per PTY.
function readU64(v: DataView, o: number): number {
  return v.getUint32(o, true) + v.getUint32(o + 4, true) * 0x1_0000_0000
}
function writeU64(v: DataView, o: number, n: number): void {
  v.setUint32(o, n >>> 0, true)
  v.setUint32(o + 4, Math.floor(n / 0x1_0000_0000) >>> 0, true)
}

function frame(type: number, payloadLen: number): { buf: Uint8Array; view: DataView } {
  const buf = new Uint8Array(HEADER + payloadLen)
  const view = new DataView(buf.buffer)
  view.setUint8(0, type)
  view.setUint32(1, payloadLen, true)
  return { buf, view }
}

export function encodeClientFrame(f: ClientFrame): Uint8Array {
  switch (f.t) {
    case 'hello': {
      const { buf, view } = frame(T.HELLO, 2)
      view.setUint16(5, f.proto, true)
      return buf
    }
    case 'attach': {
      const { buf, view } = frame(T.ATTACH, 9)
      view.setUint8(5, ATTACH_MODE[f.mode])
      writeU64(view, 6, f.seq)
      return buf
    }
    case 'input': {
      const { buf } = frame(T.INPUT, f.data.byteLength)
      buf.set(f.data, HEADER)
      return buf
    }
    case 'resize': {
      const { buf, view } = frame(T.RESIZE, 8)
      view.setUint16(5, f.cols, true)
      view.setUint16(7, f.rows, true)
      view.setUint16(9, f.xpx, true)
      view.setUint16(11, f.ypx, true)
      return buf
    }
    case 'ack': {
      const { buf, view } = frame(T.ACK, 8)
      writeU64(view, 5, f.seq)
      return buf
    }
    case 'signal': {
      const { buf, view } = frame(T.SIGNAL, 2)
      view.setUint8(5, f.signo)
      view.setUint8(6, SIGNAL_TARGET[f.target])
      return buf
    }
    case 'terminate': {
      const { buf, view } = frame(T.TERMINATE, 4)
      view.setUint32(5, f.graceMs, true)
      return buf
    }
    case 'stat':
      return frame(T.STAT, 0).buf
    case 'detach':
      return frame(T.DETACH, 0).buf
    case 'release':
      return frame(T.RELEASE, 0).buf
  }
}

/** Encode text input; the common keystroke path. */
export function encodeInput(text: string | Uint8Array): Uint8Array {
  return encodeClientFrame({ t: 'input', data: typeof text === 'string' ? enc.encode(text) : text })
}

class Reader {
  o = 0
  readonly view: DataView
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  need(n: number): void {
    if (this.o + n > this.bytes.byteLength) throw new HolderProtocolError('truncated payload')
  }
  u8(): number {
    this.need(1)
    return this.view.getUint8(this.o++)
  }
  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.o, true)
    this.o += 2
    return v
  }
  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.o, true)
    this.o += 4
    return v
  }
  i32(): number {
    this.need(4)
    const v = this.view.getInt32(this.o, true)
    this.o += 4
    return v
  }
  u64(): number {
    this.need(8)
    const v = readU64(this.view, this.o)
    this.o += 8
    return v
  }
  str(): string {
    const n = this.u16()
    this.need(n)
    const s = dec.decode(this.bytes.subarray(this.o, this.o + n))
    this.o += n
    return s
  }
  end(): void {
    if (this.o !== this.bytes.byteLength) throw new HolderProtocolError('trailing bytes in payload')
  }
}

export function decodeHolderPayload(type: number, payload: Uint8Array): HolderFrame {
  const r = new Reader(payload)
  switch (type) {
    case T.H_HELLO: {
      const f: HolderHello = {
        t: 'hello',
        proto: r.u16(),
        childPid: r.u32(),
        cols: r.u16(),
        rows: r.u16(),
        earliestSeq: r.u64(),
        latestSeq: r.u64(),
        exited: r.u8() !== 0,
        code: r.i32(),
        signal: r.u8(),
        ptyId: r.str(),
      }
      r.end()
      return f
    }
    case T.OUTPUT: {
      const seq = r.u64()
      return { t: 'output', seq, data: payload.subarray(8) }
    }
    case T.EXIT: {
      const f = { t: 'exit' as const, code: r.i32(), signal: r.u8() }
      r.end()
      return f
    }
    case T.H_STAT: {
      const childPid = r.u32()
      const fgPid = r.u32()
      const fgName = r.str()
      const cwd = r.str()
      const n = r.u16()
      const descendants: number[] = []
      for (let i = 0; i < n; i++) descendants.push(r.u32())
      r.end()
      return { t: 'stat', childPid, fgPid, fgName, cwd, descendants }
    }
    case T.ERROR: {
      const f = { t: 'error' as const, code: r.u16(), message: r.str() }
      r.end()
      return f
    }
    default:
      throw new HolderProtocolError(`unknown holder frame type 0x${type.toString(16)}`)
  }
}

/** Holder-side encoding — used by tests and by fake holders (C-FUZZ-2). */
export function encodeHolderFrame(f: HolderFrame): Uint8Array {
  switch (f.t) {
    case 'hello': {
      const id = enc.encode(f.ptyId)
      const { buf, view } = frame(T.H_HELLO, 32 + 2 + id.byteLength)
      let o = 5
      view.setUint16(o, f.proto, true); o += 2
      view.setUint32(o, f.childPid, true); o += 4
      view.setUint16(o, f.cols, true); o += 2
      view.setUint16(o, f.rows, true); o += 2
      writeU64(view, o, f.earliestSeq); o += 8
      writeU64(view, o, f.latestSeq); o += 8
      view.setUint8(o, f.exited ? 1 : 0); o += 1
      view.setInt32(o, f.code, true); o += 4
      view.setUint8(o, f.signal); o += 1
      view.setUint16(o, id.byteLength, true); o += 2
      buf.set(id, o)
      return buf
    }
    case 'output': {
      const { buf, view } = frame(T.OUTPUT, 8 + f.data.byteLength)
      writeU64(view, 5, f.seq)
      buf.set(f.data, 13)
      return buf
    }
    case 'exit': {
      const { buf, view } = frame(T.EXIT, 5)
      view.setInt32(5, f.code, true)
      view.setUint8(9, f.signal)
      return buf
    }
    case 'stat': {
      const name = enc.encode(f.fgName)
      const cwd = enc.encode(f.cwd)
      const { buf, view } = frame(T.H_STAT, 8 + 2 + name.byteLength + 2 + cwd.byteLength + 2 + 4 * f.descendants.length)
      let o = 5
      view.setUint32(o, f.childPid, true); o += 4
      view.setUint32(o, f.fgPid, true); o += 4
      view.setUint16(o, name.byteLength, true); o += 2
      buf.set(name, o); o += name.byteLength
      view.setUint16(o, cwd.byteLength, true); o += 2
      buf.set(cwd, o); o += cwd.byteLength
      view.setUint16(o, f.descendants.length, true); o += 2
      for (const p of f.descendants) { view.setUint32(o, p, true); o += 4 }
      return buf
    }
    case 'error': {
      const msg = enc.encode(f.message)
      const { buf, view } = frame(T.ERROR, 2 + 2 + msg.byteLength)
      view.setUint16(5, f.code, true)
      view.setUint16(7, msg.byteLength, true)
      buf.set(msg, 9)
      return buf
    }
  }
}

export function decodeClientPayload(type: number, payload: Uint8Array): ClientFrame {
  const r = new Reader(payload)
  const done = <F extends ClientFrame>(f: F): F => {
    r.end()
    return f
  }
  switch (type) {
    case T.HELLO:
      return done({ t: 'hello', proto: r.u16() })
    case T.ATTACH: {
      const m = r.u8()
      const mode = (['fromSeq', 'earliest', 'latest'] as const)[m]
      if (!mode) throw new HolderProtocolError(`bad attach mode ${m}`)
      return done({ t: 'attach', mode, seq: r.u64() })
    }
    case T.INPUT:
      return { t: 'input', data: payload }
    case T.RESIZE:
      return done({ t: 'resize', cols: r.u16(), rows: r.u16(), xpx: r.u16(), ypx: r.u16() })
    case T.ACK:
      return done({ t: 'ack', seq: r.u64() })
    case T.SIGNAL: {
      const signo = r.u8()
      const tgt = (['child', 'fg', 'session'] as const)[r.u8()]
      if (!tgt) throw new HolderProtocolError('bad signal target')
      return done({ t: 'signal', signo, target: tgt })
    }
    case T.TERMINATE:
      return done({ t: 'terminate', graceMs: r.u32() })
    case T.STAT:
      return done({ t: 'stat' })
    case T.DETACH:
      return done({ t: 'detach' })
    case T.RELEASE:
      return done({ t: 'release' })
    default:
      throw new HolderProtocolError(`unknown client frame type 0x${type.toString(16)}`)
  }
}

/**
 * Incremental frame splitter: feed socket chunks, get whole frames back. Handles split and merged reads.
 * Frames longer than `maxFrame` throw (the connection must then be closed).
 * bounded: holds at most one partial frame (≤ maxFrame + header).
 */
export class FrameSplitter<F> {
  private buf: Uint8Array = new Uint8Array(0)
  /** Set by the first bad frame: the stream is out of step, so every later push fails too. */
  private failed: HolderProtocolError | null = null
  private readonly decode: (type: number, payload: Uint8Array) => F
  private readonly maxFrame: number
  constructor(decode: (type: number, payload: Uint8Array) => F, maxFrame: number) {
    this.decode = decode
    this.maxFrame = maxFrame
  }

  /**
   * The complete frames in `chunk` plus what was buffered before it. On a bad frame, throws HolderProtocolError
   * carrying the frames decoded before it in `before`.
   */
  push(chunk: Uint8Array): F[] {
    if (this.failed) throw this.failed
    const out: F[] = []
    try {
      return this.split(chunk, out)
    } catch (e) {
      const err = e instanceof HolderProtocolError ? e : new HolderProtocolError(`undecodable frame: ${(e as Error).message}`)
      err.before = out
      this.failed = err
      this.buf = new Uint8Array(0)
      throw err
    }
  }

  private split(chunk: Uint8Array, out: F[]): F[] {
    let data: Uint8Array
    if (this.buf.byteLength === 0) {
      data = chunk
    } else {
      data = new Uint8Array(this.buf.byteLength + chunk.byteLength)
      data.set(this.buf, 0)
      data.set(chunk, this.buf.byteLength)
    }
    let o = 0
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    while (data.byteLength - o >= HEADER) {
      const type = view.getUint8(o)
      const len = view.getUint32(o + 1, true)
      if (len > this.maxFrame) throw new HolderProtocolError(`frame too long (${len} bytes)`)
      if (data.byteLength - o - HEADER < len) break
      out.push(this.decode(type, data.subarray(o + HEADER, o + HEADER + len)))
      o += HEADER + len
    }
    // Keep only the partial tail, copied so the caller's chunk is not pinned.
    this.buf = o === data.byteLength ? new Uint8Array(0) : data.slice(o)
    return out
  }

  get pendingBytes(): number {
    return this.buf.byteLength
  }
}

export function holderFrameSplitter(): FrameSplitter<HolderFrame> {
  // A holder never sends more than one read buffer of output plus the seq.
  return new FrameSplitter(decodeHolderPayload, L.holderReadBufferBytes + 64)
}

export function clientFrameSplitter(): FrameSplitter<ClientFrame> {
  return new FrameSplitter(decodeClientPayload, L.holderMaxFrameBytes)
}

// ── ring file ───────────────────────────────────────────────────────────────────

export type RingHeader = { version: number; capacity: number; earliestSeq: number; latestSeq: number }

export function parseRingHeader(bytes: Uint8Array): RingHeader | null {
  if (bytes.byteLength < L.ringHeaderBytes) return null
  if (bytes[0] !== 0x4b || bytes[1] !== 0x45 || bytes[2] !== 0x41 || bytes[3] !== 0x52) return null // "KEAR"
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const h = { version: v.getUint16(4, true), capacity: readU64(v, 8), earliestSeq: readU64(v, 16), latestSeq: readU64(v, 24) }
  if (h.version !== 1 || h.capacity <= 0 || h.capacity > L.ringBytesMax) return null
  // seqs past 2^53 cannot be counted exactly and no real ring gets there: corrupt (C-COR-3)
  if (!Number.isSafeInteger(h.earliestSeq) || !Number.isSafeInteger(h.latestSeq)) return null
  if (h.latestSeq < h.earliestSeq || h.latestSeq - h.earliestSeq > h.capacity) return null
  return h
}

/**
 * Bytes of a ring file from `fromSeq` (clamped to earliestSeq) to latestSeq, in order — for cold restore when the
 * holder is gone. Returns null if the header is corrupt (C-COR-3).
 */
export function readRing(file: Uint8Array, fromSeq = 0): { seq: number; data: Uint8Array } | null {
  const h = parseRingHeader(file)
  if (!h || file.byteLength < L.ringHeaderBytes + h.capacity) return null
  const start = Math.max(fromSeq, h.earliestSeq)
  if (start >= h.latestSeq) return { seq: h.latestSeq, data: new Uint8Array(0) }
  const out = new Uint8Array(h.latestSeq - start)
  const base = L.ringHeaderBytes
  let s = start
  let o = 0
  while (s < h.latestSeq) {
    const pos = s % h.capacity
    const n = Math.min(h.capacity - pos, h.latestSeq - s)
    out.set(file.subarray(base + pos, base + pos + n), o)
    o += n
    s += n
  }
  return { seq: start, data: out }
}
