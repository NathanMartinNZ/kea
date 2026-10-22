// Renderer back-pressure for one terminal stream, as a pure policy so it can be tested without ports.
//
// · Credit window: at most L.streamCreditBytes outstanding. The renderer returns credit as `term.write`
//   finishes each chunk (or snapshot).
// · No buffering for a renderer without credit: a batch that does not fit is not kept. The stream is marked
//   behind at the seq it has reached.
// · When credit returns to a stream that is behind: if the backlog (`flushedSeq − sentSeq`) is more than
//   L.streamSkipAheadBytes, send a fresh snapshot (skip-ahead); otherwise catch up from the holder's ring.
//
// Seqs: `sentSeq` is the first byte this renderer has not been given (data chunks or a snapshot cover
// everything below it).

import { L } from '@kea/protocol/limits'

export type FlowAction =
  /** Send this batch now. */
  | { do: 'send' }
  /** Out of credit: drop the batch; the stream is now behind. */
  | { do: 'drop' }
  /** Nothing to do (waiting for a snapshot, or already behind). */
  | { do: 'skip' }

export type ResumeAction =
  | { do: 'none' }
  /** Read `[from, to)` from the ring and send it, up to `budget` bytes of it. */
  | { do: 'catchUp'; from: number; to: number; budget: number }
  | { do: 'snapshot' }

export class StreamFlow {
  readonly window: number
  readonly skipAhead: number
  private outstanding = 0
  private sent = 0
  private behind = false
  private awaitingSnapshot = true

  constructor(window: number = L.streamCreditBytes, skipAhead: number = L.streamSkipAheadBytes) {
    this.window = window
    this.skipAhead = skipAhead
  }

  get sentSeq(): number {
    return this.sent
  }
  get outstandingBytes(): number {
    return this.outstanding
  }
  get isBehind(): boolean {
    return this.behind
  }
  /** True from attach (or a skip-ahead decision) until the snapshot has been sent. */
  get needsSnapshot(): boolean {
    return this.awaitingSnapshot
  }
  get hasCredit(): boolean {
    return this.outstanding < this.window
  }

  /** A live batch `[seq, seq + n)` from the coalescer. */
  onBatch(seq: number, n: number): FlowAction {
    if (this.awaitingSnapshot || this.behind) return { do: 'skip' }
    if (seq !== this.sent) {
      // Not contiguous with what this renderer has (a rebuild restarted the stream): resnapshot.
      this.awaitingSnapshot = true
      return { do: 'skip' }
    }
    // An empty window always admits one batch, so a batch larger than the window can never wedge the stream.
    if (this.outstanding > 0 && this.outstanding + n > this.window) {
      this.behind = true
      return { do: 'drop' }
    }
    this.outstanding += n
    this.sent = seq + n
    return { do: 'send' }
  }

  /**
   * A snapshot covering everything below `seq` was sent; it costs `cost` credit (its string length). A snapshot is
   * cut where the mirror has parsed to, which can be behind `flushedSeq`: the gap is then caught up from the ring.
   */
  onSnapshotSent(seq: number, cost: number, flushedSeq: number): void {
    this.awaitingSnapshot = false
    this.behind = seq < flushedSeq
    this.sent = seq
    this.outstanding += cost
  }

  /** Catch-up bytes `[sentSeq, sentSeq + n)` were sent from the ring. */
  onCatchUpSent(n: number): void {
    this.sent += n
    this.outstanding += n
  }

  /** The ring no longer holds `sentSeq` (overwritten, or no ring on disk): only a snapshot can help. */
  onCatchUpImpossible(): void {
    this.behind = false
    this.awaitingSnapshot = true
  }

  /** The renderer has written `n` more bytes. */
  credit(n: number): void {
    this.outstanding = Math.max(0, this.outstanding - n)
  }

  /**
   * What to do now that credit may be available. `flushedSeq` is where the coalescer's next batch will start:
   * catching up to it makes this stream contiguous with live output again.
   */
  resume(flushedSeq: number): ResumeAction {
    if (this.awaitingSnapshot) return this.hasCredit ? { do: 'snapshot' } : { do: 'none' }
    if (!this.behind) return { do: 'none' }
    if (!this.hasCredit) return { do: 'none' }
    const backlog = flushedSeq - this.sent
    if (backlog <= 0) {
      this.behind = false
      return { do: 'none' }
    }
    if (backlog > this.skipAhead) {
      this.behind = false
      this.awaitingSnapshot = true
      return { do: 'snapshot' }
    }
    return { do: 'catchUp', from: this.sent, to: flushedSeq, budget: this.window - this.outstanding }
  }

  /** Called after a catch-up send: if it reached `flushedSeq`, the stream is live again. */
  caughtUpTo(flushedSeq: number): void {
    if (this.sent >= flushedSeq) this.behind = false
  }
}
