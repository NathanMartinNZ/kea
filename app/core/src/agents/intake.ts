// Core's hook intake: the unix socket `kea-helper hook` delivers envelopes to, `<runDir(KEA_HOME)>/core.sock`, and the
// session spools it falls back to.
//
//   socket   created in the private run directory (a real 0700 directory of this user's, checked with lstat),
//            the socket file itself 0600. A stale socket file (core crashed) is replaced; anything else in its
//            place (a symlink, another user's file) is refused and the intake stays down: hooks then spool.
//   lines    one envelope per line, at most L.hookEnvelopeMaxBytes including its newline; a longer line is dropped up to
//            its newline. An unterminated line when its connection closes is discarded: after a short write the helper
//            spooled the same envelope, and that copy is the one that counts.
//   ack      each complete line is answered with HOOK_ACK_BYTE once it has been handed on. The helper counts a line as
//            delivered only then: a core that is hung (its socket still takes the connection and the line into its
//            backlog) or busy past L.hookBoundMs gets no say, and the helper spools the line. When such a core reads
//            the line later anyway, the envelope's id makes the second copy a duplicate (`EnvelopeIds`).
//   caps     at most L.hookSocketConnectionsMax connections at once (more are closed at once and counted as refused —
//            the server's `drop` event —: the helper spools), each closed after L.hookConnectionIdleMs without a
//            complete line (the timer restarts at each complete line, not at each byte).
//   checks   an envelope is validated (protocol's zHookEnvelope) before anything reads it; its session id and adapter must be what the
//            helper's own rules allow ([0-9A-Za-z_-]{1,64}); the receiver decides whether the session exists. The
//            environment is never consulted (I-AGT-7).
//
// The socket path and the spool path are never exported to the session: hooks get them as arguments.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { ensurePrivateDir, runDir, type Logger } from '@kea/kit'
import { HOOK_ACK_BYTE, L, zHookEnvelope, type HookEnvelope } from '@kea/protocol'

export type Envelope = HookEnvelope

/** One line → an envelope, or why not. */
export function parseEnvelope(line: string): { ok: true; env: Envelope } | { ok: false; why: string } {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return { ok: false, why: 'not JSON' }
  }
  const r = zHookEnvelope.safeParse(v)
  return r.success ? { ok: true, env: r.data } : { ok: false, why: r.error.issues[0]?.message ?? 'invalid' }
}

/** Splits a byte stream into lines of at most `max` bytes (newline included); a longer line is skipped to its newline. */
export class LineSplitter {
  private buf: Buffer[] = []
  private size = 0
  private skipping = false
  private readonly max: number
  /** Lines dropped for being too long. */
  dropped = 0

  constructor(max: number = L.hookEnvelopeMaxBytes) {
    this.max = max
  }

  /** Feed bytes; returns the complete lines (without the newline). */
  push(chunk: Buffer): string[] {
    const out: string[] = []
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(0x0a, start)
      if (nl < 0) break
      const piece = chunk.subarray(start, nl)
      if (this.skipping) {
        this.skipping = false
      } else if (this.size + piece.length + 1 > this.max) {
        this.dropped++
      } else {
        out.push(Buffer.concat([...this.buf, piece]).toString('utf8'))
      }
      this.buf = []
      this.size = 0
      start = nl + 1
    }
    const rest = chunk.subarray(start)
    if (rest.length > 0 && !this.skipping) {
      if (this.size + rest.length >= this.max) {
        // already too long to fit with its newline: drop it up to the newline
        this.buf = []
        this.size = 0
        this.skipping = true
        this.dropped++
      } else {
        this.buf.push(Buffer.from(rest)) // copied: never pin a pooled slab
        this.size += rest.length
      }
    }
    return out
  }

  /** Bytes of an unterminated line held. */
  get pending(): number {
    return this.size
  }
}

const ACK = Buffer.from([HOOK_ACK_BYTE])

/**
 * The ids of the envelopes a session's signals took: a copy of one that comes again — a line a busy or hung core read
 * after the helper had given up on its answer and spooled it too — is a duplicate. The last L.signalRingEntries ids per
 * session are kept: a late copy comes from the socket's backlog (a hung core is killed once it misses its heartbeats)
 * or from the spool, which is drained at the session's next envelope.
 */
export class EnvelopeIds {
  // bounded: one entry per session with an envelope taken since it last went live,
  // each ≤ L.signalRingEntries ids
  private readonly bySession = new Map<string, { set: Set<string>; order: string[] }>()

  /** Record `env`'s id for its session: false when that id was taken before (a duplicate). Envelopes without one pass. */
  take(env: Envelope): boolean {
    if (!env.id) return true
    let s = this.bySession.get(env.keaSessionId)
    if (!s) this.bySession.set(env.keaSessionId, (s = { set: new Set(), order: [] }))
    if (s.set.has(env.id)) return false
    s.set.add(env.id)
    s.order.push(env.id)
    if (s.order.length > L.signalRingEntries) s.set.delete(s.order.shift()!)
    return true
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  get size(): number {
    let n = 0
    for (const s of this.bySession.values()) n += s.order.length
    return n
  }
}

/** The socket file core listens on for `home`. */
export function coreSocketPath(home: string): string {
  return path.join(runDir(home), 'core.sock')
}

export interface IntakeOptions {
  home: string
  log: Logger
  /** One valid envelope, in arrival order per connection. */
  onEnvelope(env: Envelope): void
  /** A connection closed (the agent service sweeps spools after refusals). */
  onClose?(): void
  /** How long a connection may go without a complete line (default L.hookConnectionIdleMs; tests shorten it). */
  idleMs?: number
}

/** The hook socket server. `start()` resolves once listening (or false when the socket path is refused). */
export class HookIntake {
  private readonly o: IntakeOptions
  private server: net.Server | null = null
  private readonly conns = new Set<net.Socket>() // bounded: L.hookSocketConnectionsMax
  private disposed = false
  /** Counters for the resource report and tests. */
  readonly stats = { accepted: 0, refused: 0, envelopes: 0, invalid: 0, tooLong: 0, cutOff: 0 }
  readonly socketPath: string

  constructor(o: IntakeOptions) {
    this.o = o
    this.socketPath = coreSocketPath(o.home)
  }

  get connections(): number {
    return this.conns.size
  }

  async start(): Promise<boolean> {
    if (this.disposed || this.server) return !!this.server
    try {
      ensurePrivateDir(path.dirname(this.socketPath))
      this.clearStale()
    } catch (e) {
      this.o.log.warn('hook intake refused its socket path; hooks spool', { path: this.socketPath, error: String(e) })
      return false
    }
    const server = net.createServer({ allowHalfOpen: false }, (s) => this.accept(s))
    server.maxConnections = L.hookSocketConnectionsMax
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', (e) => {
        this.o.log.warn('hook intake could not listen; hooks spool', { error: String(e) })
        resolve(false)
      })
      const old = process.umask(0o177)
      try {
        server.listen(this.socketPath, () => resolve(true))
      } finally {
        process.umask(old)
      }
    })
    if (!ok || this.disposed) {
      server.close()
      return false
    }
    server.on('error', (e) => this.o.log.warn('hook intake error', { error: String(e) }))
    // over the cap the server closes the connection itself and never calls `accept`: count it here (its helper spools)
    server.on('drop', () => {
      this.stats.refused++
    })
    this.server = server
    return true
  }

  /** A socket file left by an earlier core is removed; anything else is refused. */
  private clearStale(): void {
    let st: fs.Stats
    try {
      st = fs.lstatSync(this.socketPath)
    } catch {
      return
    }
    const uid = process.getuid?.() ?? 0
    if (!st.isSocket() || st.uid !== uid || st.nlink !== 1) throw new Error(`${this.socketPath} is not a socket of this user's`)
    fs.unlinkSync(this.socketPath)
  }

  private accept(s: net.Socket): void {
    if (this.disposed || this.conns.size >= L.hookSocketConnectionsMax) {
      this.stats.refused++
      s.destroy()
      return
    }
    this.stats.accepted++
    this.conns.add(s)
    const lines = new LineSplitter()
    // Closed after the idle limit without a complete envelope; restarted at each complete line, not at each byte
    // (a writer that drips a byte at a time is no envelope). One per connection, so bounded by the connection cap.
    const idleMs = this.o.idleMs ?? L.hookConnectionIdleMs
    let idle = setTimeout(() => s.destroy(), idleMs)
    s.on('data', (chunk: Buffer) => {
      const before = lines.dropped
      let complete = false
      for (const line of lines.push(chunk)) {
        if (this.line(line)) complete = true
        // handed on: the helper may stop waiting (a helper that already gave up has closed; the write then fails quietly)
        if (!s.destroyed) s.write(ACK)
      }
      this.stats.tooLong += lines.dropped - before
      if (complete && !s.destroyed) {
        clearTimeout(idle)
        idle = setTimeout(() => s.destroy(), idleMs)
      }
    })
    s.on('error', () => undefined)
    s.on('close', () => {
      clearTimeout(idle)
      if (lines.pending > 0) this.stats.cutOff++ // the spooled copy counts
      this.conns.delete(s)
      if (!this.disposed) this.o.onClose?.()
    })
  }

  /** One line: true when it was a valid envelope (handed on). */
  private line(line: string): boolean {
    if (line.trim() === '') return false
    const r = parseEnvelope(line)
    if (!r.ok) {
      this.stats.invalid++
      this.o.log.debug('hook envelope dropped', { why: r.why })
      return false
    }
    this.stats.envelopes++
    try {
      this.o.onEnvelope(r.env)
    } catch (e) {
      this.o.log.warn('hook envelope not applied', { error: String(e) })
    }
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const s of this.conns) s.destroy()
    this.conns.clear()
    const srv = this.server
    this.server = null
    if (srv) {
      srv.close()
      try {
        // only core's own socket file: the path is core's while it listens
        if (fs.lstatSync(this.socketPath).isSocket()) fs.unlinkSync(this.socketPath)
      } catch {
        // gone already
      }
    }
  }
}
