// One renderer terminal attached to a PTY over its own stream port: a snapshot first, then live chunks, under
// a credit window; input, credit and resizes come back the same way.

import { resources } from '@kea/kit'
import { isStreamToPtyhost, L, type Channel, type StreamToRenderer } from '@kea/protocol'
import { StreamFlow } from './flow.ts'

export interface StreamSnapshot {
  seq: number
  cols: number
  rows: number
  data: string
  exited: { code: number | null; signal: number | null } | null
  title: string | null
}

/** What an attachment needs from its PTY. */
export interface AttachmentHost {
  readonly ptyId: string
  /** Where the coalescer's next batch starts. */
  flushedSeq(): number
  /** Call `cb` with a snapshot as soon as one may be cut. Returns a canceller. */
  requestSnapshot(cb: (s: StreamSnapshot) => void): () => void
  /** Ring bytes `[from, min(to, from + max))`, or null if the ring no longer has them. */
  readRing(from: number, to: number, max: number): Uint8Array | null
  input(data: string | Uint8Array): void
  resize(cols: number, rows: number, xpx: number, ypx: number): void
  detached(a: Attachment): void
}

/** Renderer stream ports attached in this process. */
const streamsOpen = resources.counter('ptyhost.streams')

/** A batch may be a view into a larger socket read; send only its bytes. */
function tight(b: Uint8Array): Uint8Array {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice()
}

export class Attachment {
  readonly flow: StreamFlow
  private readonly host: AttachmentHost
  private readonly ch: Channel
  private readonly offs: (() => void)[] = []
  private cancelSnapshot: (() => void) | null = null
  private disposed = false
  /** Counters for the resource report and tests. */
  readonly stats = { snapshots: 0, chunks: 0, catchUpBytes: 0, dropped: 0 }

  constructor(host: AttachmentHost, ch: Channel, flow: StreamFlow = new StreamFlow()) {
    this.host = host
    this.ch = ch
    this.flow = flow
    streamsOpen.inc()
    this.offs.push(
      ch.onMessage((m) => this.onMessage(m)),
      ch.onClose(() => this.dispose()),
    )
  }

  /** Send the first snapshot. */
  start(): void {
    this.resume()
  }

  /** A live batch from the coalescer (forwarded before the mirror parses it). */
  live(seq: number, data: Uint8Array): void {
    if (this.disposed) return
    const a = this.flow.onBatch(seq, data.byteLength)
    if (a.do === 'send') {
      this.post({ k: 'data', seq, b: tight(data) })
      this.stats.chunks++
    } else if (a.do === 'drop') {
      this.stats.dropped++
    } else if (this.flow.needsSnapshot && !this.cancelSnapshot) {
      this.resume()
    }
  }

  exit(code: number | null, signal: number | null): void {
    this.post({ k: 'exit', code, signal })
  }

  title(title: string): void {
    this.post({ k: 'title', title })
  }

  /** The PTY is gone: tell the renderer and close the port. */
  gone(reason: string): void {
    this.post({ k: 'gone', reason })
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    streamsOpen.dec()
    this.cancelSnapshot?.()
    this.cancelSnapshot = null
    for (const off of this.offs.splice(0)) off()
    this.ch.close()
    this.host.detached(this)
  }

  private post(m: StreamToRenderer): void {
    if (!this.disposed) this.ch.send(m)
  }

  private onMessage(m: unknown): void {
    if (this.disposed || !isStreamToPtyhost(m)) return
    switch (m.k) {
      case 'in':
      case 'inb':
        this.host.input(m.d)
        return
      case 'credit':
        this.flow.credit(m.n)
        this.resume()
        return
      case 'resize':
        this.host.resize(m.cols, m.rows, m.xpx, m.ypx)
        return
      case 'close':
        this.dispose()
        return
    }
  }

  /** Act on returned credit: send a snapshot, or catch up from the ring, as the flow policy says. */
  private resume(): void {
    for (let guard = 0; guard < 4 && !this.disposed; guard++) {
      const flushed = this.host.flushedSeq()
      const a = this.flow.resume(flushed)
      if (a.do === 'none') return
      if (a.do === 'snapshot') {
        if (this.cancelSnapshot) return
        // The callback may run inside requestSnapshot (a snapshot can be cut right away): only a request that is still
        // waiting keeps its canceller.
        let served = false
        const cancel = this.host.requestSnapshot((s) => {
          served = true
          this.cancelSnapshot = null
          if (this.disposed) return
          this.post({ k: 'snapshot', seq: s.seq, cols: s.cols, rows: s.rows, data: s.data, exited: s.exited, title: s.title })
          this.stats.snapshots++
          this.flow.onSnapshotSent(s.seq, s.data.length, this.host.flushedSeq())
          this.resume()
        })
        if (!served) this.cancelSnapshot = cancel
        return
      }
      // catch up from the ring, in chunks no larger than a live batch
      let from = a.from
      let budget = a.budget
      while (from < a.to && budget > 0) {
        const want = Math.min(a.to - from, budget, L.coalesceMaxBytes)
        const data = this.host.readRing(from, a.to, want)
        if (data === null) {
          this.flow.onCatchUpImpossible()
          break
        }
        if (data.byteLength === 0) break
        this.post({ k: 'data', seq: from, b: data })
        this.flow.onCatchUpSent(data.byteLength)
        this.stats.catchUpBytes += data.byteLength
        from += data.byteLength
        budget -= data.byteLength
      }
      this.flow.caughtUpTo(flushed)
      if (!this.flow.needsSnapshot) return
    }
  }
}
