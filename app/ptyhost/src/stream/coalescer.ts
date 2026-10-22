// Output coalescer. Holder output for one PTY is batched for at most L.coalesceWindowMs or
// L.coalesceMaxBytes, but the first chunk after at least L.coalesceQuietMs of quiet is flushed at once,
// so keystroke echo is never delayed. A flush goes to every attached renderer first and to the mirror
// second, so the coalescer sits in front of both.
//
// bounded: holds at most L.coalesceMaxBytes plus one holder read (L.holderReadBufferBytes).

import { L } from '@kea/protocol/limits'
import type { Clock, TimerHandle } from '@kea/kit'

export interface CoalescerOptions {
  clock: Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'>
  /** One batch: bytes from `seq` (inclusive), contiguous with the previous batch. */
  flush(seq: number, data: Uint8Array): void
  windowMs?: number
  maxBytes?: number
  quietMs?: number
}

export class Coalescer {
  private readonly opts: CoalescerOptions
  private readonly windowMs: number
  private readonly maxBytes: number
  private readonly quietMs: number
  private parts: Uint8Array[] = [] // bounded: ≤ maxBytes in total (see push)
  private bytes = 0
  private startSeq = 0
  private timer: TimerHandle | undefined
  private lastChunkAt = Number.NEGATIVE_INFINITY
  private disposed = false

  constructor(opts: CoalescerOptions) {
    this.opts = opts
    this.windowMs = opts.windowMs ?? L.coalesceWindowMs
    this.maxBytes = opts.maxBytes ?? L.coalesceMaxBytes
    this.quietMs = opts.quietMs ?? L.coalesceQuietMs
  }

  /** Seq of the first byte not yet flushed. */
  get flushedSeq(): number {
    return this.startSeq
  }

  get pendingBytes(): number {
    return this.bytes
  }

  /** A chunk from the holder; `seq` must equal `flushedSeq + pendingBytes` (the caller handles gaps). */
  push(seq: number, data: Uint8Array): void {
    if (this.disposed || data.byteLength === 0) return
    const now = this.opts.clock.now()
    const quiet = now - this.lastChunkAt >= this.quietMs
    this.lastChunkAt = now
    if (this.bytes === 0) {
      this.startSeq = seq
      if (quiet || data.byteLength >= this.maxBytes) {
        this.emit(seq, data)
        return
      }
    } else if (this.bytes + data.byteLength > this.maxBytes) {
      this.flushNow()
      this.startSeq = seq
    }
    this.parts.push(data)
    this.bytes += data.byteLength
    if (this.bytes >= this.maxBytes) this.flushNow()
    else if (this.timer === undefined) this.timer = this.opts.clock.setTimeout(() => this.onTimer(), this.windowMs)
  }

  /** Flush whatever is pending now (exit, detach, a snapshot request). */
  flushNow(): void {
    if (this.timer !== undefined) {
      this.opts.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.bytes === 0) return
    const data = this.parts.length === 1 ? (this.parts[0] as Uint8Array) : concat(this.parts, this.bytes)
    const seq = this.startSeq
    this.parts = []
    this.bytes = 0
    this.emit(seq, data)
  }

  /** Restart at `seq` with nothing pending (after a gap or a rebuild); pending bytes are dropped. */
  reset(seq: number): void {
    if (this.timer !== undefined) this.opts.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.parts = []
    this.bytes = 0
    this.startSeq = seq
  }

  dispose(): void {
    this.disposed = true
    this.reset(this.startSeq)
  }

  private onTimer(): void {
    this.timer = undefined
    this.flushNow()
  }

  private emit(seq: number, data: Uint8Array): void {
    this.startSeq = seq + data.byteLength
    this.opts.flush(seq, data)
  }
}

export function concat(parts: readonly Uint8Array[], total = parts.reduce((n, p) => n + p.byteLength, 0)): Uint8Array {
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}
