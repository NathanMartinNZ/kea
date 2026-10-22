// One client connection to a holder: framing, HELLO, and the requests ptyhost sends. Ptyhost is a holder's only client;
// everything else about a PTY (mirror, streams) lives in `Pty`.

import net from 'node:net'
import { resources } from '@kea/kit'
import {
  encodeClientFrame,
  encodeInput,
  holderFrameSplitter,
  HOLDER_PROTO,
  HolderProtocolError,
  L,
  type AttachMode,
  type HolderFrame,
  type HolderHello,
  type HolderStat,
  type SignalTarget,
} from '@kea/protocol'

/** Holder sockets open in this process. */
const socketsOpen = resources.counter('ptyhost.holderSockets')

export interface HolderHandlers {
  /**
   * The next OUTPUT starts past the byte expected (free-run overwrote bytes never sent, or the attach seq was
   * no longer in the ring). Called once per jump, just before that OUTPUT's `output` (the mirror rebuilds from there).
   */
  gap?(expected: number, got: number): void
  output(seq: number, data: Uint8Array): void
  exit(code: number, signal: number): void
  /** A protocol error from the holder (ERROR frame). The connection stays open unless the holder closes it. */
  error(code: number, message: string): void
  /** The connection is gone (holder exited, replaced us, or the socket broke). Called once. */
  close(reason: string): void
}

export class HolderConnectError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'HolderConnectError'
    this.code = code
  }
}

const CONNECT_TIMEOUT_MS = L.holderConnectTimeoutMs

export class HolderConnection {
  private readonly socket: net.Socket
  private readonly split = holderFrameSplitter()
  private handlers: HolderHandlers | null = null
  private helloWaiter: { resolve(h: HolderHello): void; reject(e: Error): void } | null = null
  private readonly statWaiters: ((s: HolderStat | null) => void)[] = [] // bounded: one per in-flight STAT; callers serialise
  private closed = false
  private closeReason = ''
  /** Where the next OUTPUT must start; null after an ATTACH that names no seq, until its first OUTPUT. */
  private nextSeq: number | null = null
  /** Input frames dropped because the socket's write queue was over the cap (back-pressure). */
  droppedInputBytes = 0

  private constructor(socket: net.Socket) {
    this.socket = socket
    socketsOpen.inc()
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (e) => this.onClose(`socket error: ${(e as NodeJS.ErrnoException).code ?? e.message}`))
    socket.on('close', () => this.onClose('closed'))
  }

  /** Connect and exchange HELLO. Rejects if the holder refuses us (closes at once) or does not answer in time. */
  static async open(sockPath: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<{ conn: HolderConnection; hello: HolderHello }> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ path: sockPath })
      const fail = (e: Error) => {
        clearTimeout(timer)
        s.destroy()
        reject(new HolderConnectError(`connect ${sockPath}: ${e.message}`, (e as NodeJS.ErrnoException).code))
      }
      const timer = setTimeout(() => fail(new Error('timed out')), timeoutMs)
      s.once('error', fail)
      s.once('connect', () => {
        clearTimeout(timer)
        s.off('error', fail)
        resolve(s)
      })
    })
    const conn = new HolderConnection(socket)
    const hello = await new Promise<HolderHello>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.helloWaiter = null
        conn.destroy()
        reject(new HolderConnectError(`HELLO from ${sockPath}: timed out`))
      }, timeoutMs)
      conn.helloWaiter = {
        resolve: (h) => {
          clearTimeout(timer)
          resolve(h)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      conn.write(encodeClientFrame({ t: 'hello', proto: HOLDER_PROTO }))
    })
    return { conn, hello }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Bytes queued in the socket that the holder has not read yet. */
  get queuedBytes(): number {
    return this.socket.writableLength
  }

  /** Start receiving output. Handlers are set once, before the first ATTACH. */
  attach(mode: AttachMode, seq: number, handlers: HolderHandlers): void {
    this.handlers = handlers
    this.nextSeq = mode === 'fromSeq' ? seq : null
    if (this.closed) {
      queueMicrotask(() => handlers.close(this.closeReason))
      return
    }
    this.write(encodeClientFrame({ t: 'attach', mode, seq }))
  }

  /** Keystrokes and pastes. Never queued beyond L.holderInputCapBytes in this client's own socket buffer. */
  input(data: string | Uint8Array): boolean {
    const frame = encodeInput(data)
    if (this.socket.writableLength + frame.byteLength > L.holderInputCapBytes) {
      this.droppedInputBytes += frame.byteLength
      return false
    }
    this.write(frame)
    return true
  }

  resize(cols: number, rows: number, xpx: number, ypx: number): void {
    this.write(encodeClientFrame({ t: 'resize', cols, rows, xpx, ypx }))
  }

  ack(seq: number): void {
    this.write(encodeClientFrame({ t: 'ack', seq }))
  }

  signal(signo: number, target: SignalTarget): void {
    this.write(encodeClientFrame({ t: 'signal', signo, target }))
  }

  terminate(graceMs: number): void {
    this.write(encodeClientFrame({ t: 'terminate', graceMs }))
  }

  /** STAT round trip; null if the connection closes first. */
  stat(): Promise<HolderStat | null> {
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.statWaiters.push(resolve)
      this.write(encodeClientFrame({ t: 'stat' }))
    })
  }

  /** Stop streaming; the holder keeps reading into its ring. */
  detach(): void {
    this.write(encodeClientFrame({ t: 'detach' }))
  }

  /** The child has exited and this client has everything: the holder may remove its socket and exit. */
  release(): void {
    this.write(encodeClientFrame({ t: 'release' }))
  }

  destroy(): void {
    this.socket.destroy()
    this.onClose('destroyed')
  }

  private write(frame: Uint8Array): void {
    if (!this.closed) this.socket.write(frame)
  }

  private onData(chunk: Buffer): void {
    let frames: readonly HolderFrame[]
    let bad: HolderProtocolError | null = null
    try {
      frames = this.split.push(chunk)
    } catch (e) {
      bad = e as HolderProtocolError
      frames = bad.before as HolderFrame[]
    }
    // Frames before a bad one are handled first, so the outcome does not depend on how the bytes were read.
    for (const f of frames) {
      if (this.closed) return
      this.onFrame(f)
    }
    if (bad) {
      this.socket.destroy()
      this.onClose(`protocol error: ${bad.message}`)
    }
  }

  private onFrame(f: HolderFrame): void {
    switch (f.t) {
      case 'hello': {
        const w = this.helloWaiter
        this.helloWaiter = null
        w?.resolve(f)
        return
      }
      case 'output': {
        // OUTPUT frames are contiguous except across a jump forward; going back is a broken holder
        const want = this.nextSeq
        if (want !== null && f.seq < want) {
          this.socket.destroy()
          this.onClose(`protocol error: OUTPUT at ${f.seq}, expected ${want}`)
          return
        }
        this.nextSeq = f.seq + f.data.byteLength
        if (want !== null && f.seq > want) this.handlers?.gap?.(want, f.seq)
        this.handlers?.output(f.seq, f.data)
        return
      }
      case 'exit':
        this.handlers?.exit(f.code, f.signal)
        return
      case 'stat':
        this.statWaiters.shift()?.(f)
        return
      case 'error':
        if (this.helloWaiter) {
          const w = this.helloWaiter
          this.helloWaiter = null
          w.reject(new HolderConnectError(`holder refused HELLO: ${f.message} (code ${f.code})`))
          return
        }
        this.handlers?.error(f.code, f.message)
        return
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return
    this.closed = true
    socketsOpen.dec()
    this.closeReason = reason
    const w = this.helloWaiter
    this.helloWaiter = null
    w?.reject(new HolderConnectError(`holder connection ${reason} before HELLO`))
    for (const s of this.statWaiters.splice(0)) s(null)
    this.handlers?.close(reason)
  }
}
