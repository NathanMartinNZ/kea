// Test-only: a fake holder that speaks wire protocol v1 on a unix socket and keeps a real ring file, so the
// ptyhost data path can be tested without the Rust binary. It records every client frame it receives.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { clientFrameSplitter, encodeHolderFrame, HOLDER_PROTO, L, type ClientFrame } from '@kea/protocol'

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kea-test-'))
}

export class FakeHolder {
  readonly ptyId: string
  readonly sock: string
  readonly ringPath: string
  readonly received: ClientFrame[] = []
  private readonly server: net.Server
  private client: net.Socket | null = null
  private readonly ringFd: number
  private readonly capacity: number
  private latest = 0
  private attachedFrom: number | null = null
  private sentTo = 0
  exited: { code: number; signal: number } | null = null
  /** Connections accepted so far. */
  connections = 0
  cols = 80
  rows = 24
  /** Frames sent per OUTPUT; tests may shrink it to force many frames. */
  maxOutput = L.holderReadBufferBytes
  /** The ptyId its HELLO names (a holder that is not who its socket says). */
  helloPtyId: string

  private constructor(dir: string, sock: string, ptyId: string, capacity: number, server: net.Server) {
    this.ptyId = ptyId
    this.helloPtyId = ptyId
    this.sock = sock
    this.capacity = capacity
    this.ringPath = path.join(dir, `${ptyId}.ring`)
    this.ringFd = fs.openSync(this.ringPath, 'w+', 0o600)
    fs.ftruncateSync(this.ringFd, L.ringHeaderBytes + capacity)
    this.writeHeader()
    this.server = server
    server.on('connection', (s) => this.onConnection(s))
  }

  static async start(o: { dir: string; sockDir: string; ptyId: string; capacity?: number; json?: Record<string, unknown> }): Promise<FakeHolder> {
    fs.mkdirSync(o.dir, { recursive: true })
    fs.mkdirSync(o.sockDir, { recursive: true, mode: 0o700 })
    const sock = path.join(o.sockDir, `${o.ptyId}.sock`)
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(sock, () => resolve())
    })
    const h = new FakeHolder(o.dir, sock, o.ptyId, o.capacity ?? L.ringBytesMin, server)
    fs.writeFileSync(path.join(o.dir, `${o.ptyId}.json`), JSON.stringify({ protocol: 1, ptyId: o.ptyId, sessionId: path.basename(o.dir), kind: 'shell', cwd: '/', argv: ['/bin/sh'], pid: process.pid, socket: sock, ...o.json }))
    return h
  }

  get latestSeq(): number {
    return this.latest
  }
  get earliestSeq(): number {
    return Math.max(0, this.latest - this.capacity)
  }
  get connected(): boolean {
    return this.client !== null
  }

  /** PTY output: into the ring, then to the client if attached. */
  emit(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    let o = 0
    while (o < bytes.byteLength) {
      const pos = (this.latest + o) % this.capacity
      const n = Math.min(this.capacity - pos, bytes.byteLength - o)
      fs.writeSync(this.ringFd, bytes, o, n, L.ringHeaderBytes + pos)
      o += n
    }
    this.latest += bytes.byteLength
    this.writeHeader()
    this.pump()
  }

  /** Output the client never gets (a free-run past it): into the ring only, so the next OUTPUT jumps ahead. */
  skip(data: string): void {
    const client = this.client
    this.client = null
    this.emit(data)
    this.client = client
    this.sentTo = this.latest
  }

  /** Send a frame as is (tests of gaps and malformed input). */
  sendRaw(frame: Uint8Array): void {
    this.client?.write(frame)
  }

  exit(code: number, signal = 0): void {
    this.exited = { code, signal }
    this.pump()
    this.client?.write(encodeHolderFrame({ t: 'exit', code, signal }))
  }

  acks(): number[] {
    return this.received.filter((f) => f.t === 'ack').map((f) => (f as { seq: number }).seq)
  }
  inputs(): string {
    return this.received
      .filter((f) => f.t === 'input')
      .map((f) => new TextDecoder().decode((f as { data: Uint8Array }).data))
      .join('')
  }

  /** Wait until `pred` holds, polling. */
  async until(pred: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error('FakeHolder.until: timed out')
      await new Promise((r) => setTimeout(r, 2))
    }
  }

  dropClient(): void {
    this.client?.destroy()
    this.client = null
  }

  async close(): Promise<void> {
    this.dropClient()
    await new Promise<void>((r) => this.server.close(() => r()))
    fs.closeSync(this.ringFd)
    fs.rmSync(this.sock, { force: true })
  }

  private onConnection(s: net.Socket): void {
    this.connections++
    this.client?.destroy() // an admitted connection replaces the previous one
    this.client = s
    this.attachedFrom = null
    const split = clientFrameSplitter()
    s.on('data', (chunk: Buffer) => {
      for (const f of split.push(chunk)) this.onFrame(s, f)
    })
    s.on('close', () => {
      if (this.client === s) this.client = null
    })
    s.on('error', () => {})
  }

  private onFrame(s: net.Socket, f: ClientFrame): void {
    this.received.push(f)
    switch (f.t) {
      case 'hello':
        s.write(
          encodeHolderFrame({
            t: 'hello',
            proto: HOLDER_PROTO,
            childPid: 4242,
            cols: this.cols,
            rows: this.rows,
            earliestSeq: this.earliestSeq,
            latestSeq: this.latest,
            exited: this.exited !== null,
            code: this.exited?.code ?? 0,
            signal: this.exited?.signal ?? 0,
            ptyId: this.helloPtyId,
          }),
        )
        return
      case 'attach': {
        const from = f.mode === 'earliest' ? this.earliestSeq : f.mode === 'latest' ? this.latest : Math.max(f.seq, this.earliestSeq)
        this.attachedFrom = from
        this.sentTo = from
        this.pump()
        if (this.exited) s.write(encodeHolderFrame({ t: 'exit', code: this.exited.code, signal: this.exited.signal }))
        return
      }
      case 'resize':
        this.cols = f.cols
        this.rows = f.rows
        return
      default:
        return
    }
  }

  private pump(): void {
    if (!this.client || this.attachedFrom === null) return
    while (this.sentTo < this.latest) {
      const n = Math.min(this.latest - this.sentTo, this.maxOutput)
      const data = new Uint8Array(n)
      let o = 0
      while (o < n) {
        const pos = (this.sentTo + o) % this.capacity
        const k = Math.min(this.capacity - pos, n - o)
        fs.readSync(this.ringFd, data, o, k, L.ringHeaderBytes + pos)
        o += k
      }
      this.client.write(encodeHolderFrame({ t: 'output', seq: this.sentTo, data }))
      this.sentTo += n
    }
  }

  private writeHeader(): void {
    const h = new Uint8Array(L.ringHeaderBytes)
    const v = new DataView(h.buffer)
    h.set([0x4b, 0x45, 0x41, 0x52], 0)
    v.setUint16(4, 1, true)
    const u64 = (o: number, n: number) => {
      v.setUint32(o, n >>> 0, true)
      v.setUint32(o + 4, Math.floor(n / 0x1_0000_0000) >>> 0, true)
    }
    u64(8, this.capacity)
    u64(16, this.earliestSeq)
    u64(24, this.latest)
    fs.writeSync(this.ringFd, h, 0, h.byteLength, 0)
  }
}

/**
 * A clock that moves only when told to, for the parking and checkpoint timers. Socket I/O and xterm's own parsing stay
 * on real time, so tests wait for those with `FakeHolder.until` and move this clock explicitly.
 */
export class ManualClock {
  private t = 1_000_000
  private next = 1
  private readonly timers = new Map<number, { at: number; fn: () => void; every: number | null }>() // bounded: the timers a test arms

  now(): number {
    return this.t
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = this.next++
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn, every: null })
    return id
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number)
  }
  setInterval(fn: () => void, ms: number): number {
    const id = this.next++
    this.timers.set(id, { at: this.t + Math.max(1, ms), fn, every: Math.max(1, ms) })
    return id
  }
  clearInterval(h: unknown): void {
    this.timers.delete(h as number)
  }

  /** Move time forward by `ms`, running every timer that falls due, in time order. */
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let id = -1
      let at = Number.POSITIVE_INFINITY
      for (const [k, v] of this.timers) {
        if (v.at <= end && v.at < at) {
          id = k
          at = v.at
        }
      }
      if (id < 0) break
      const timer = this.timers.get(id)!
      this.t = Math.max(this.t, at)
      if (timer.every !== null) timer.at += timer.every
      else this.timers.delete(id)
      timer.fn()
    }
    this.t = end
  }

  /** Timers still armed (excluding intervals). */
  get pendingTimeouts(): number {
    return [...this.timers.values()].filter((v) => v.every === null).length
  }
}
