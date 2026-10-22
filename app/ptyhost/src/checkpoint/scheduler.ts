// When ptyhost checkpoints. A dirty mirror is checkpointed once half a ring of output has been parsed since its
// last checkpoint or L.checkpointMaxAgeMs has passed; parking and exit ask for one outright. One that cannot be written
// (the disk is full) is skipped: tried again L.checkpointMaxAgeMs later unless asked for. Serialising is synchronous
// and ptyhost's largest transient allocation, so it never runs within L.checkpointQuietMs of a keystroke and at most
// once per L.checkpointMinIntervalMs, across all PTYs. One timer, armed only while something is due; a PTY that cannot
// be cut yet (not at a ground-state seq) is retried when it pokes.

import { L } from '@kea/protocol'
import type { Clock, TimerHandle } from '@kea/kit'

/** park and exit dispose the mirror afterwards; now only writes (⌘K). */
export type CheckpointReason = 'park' | 'exit' | 'now'

export interface CheckpointCandidate {
  readonly ptyId: string
  /** Bytes parsed since the last checkpoint; 0 when clean (or when there is no mirror). */
  dirtyBytes(): number
  /** Monotonic time of the last checkpoint (or of the mirror's start, before the first one). */
  lastCheckpointAt(): number
  ringCapacity(): number
  /**
   * Serialise now. `done`: written (or nothing to write). `wait`: not at a ground-state seq or still parsing; the
   * candidate pokes when that may have changed. `failed`: it could not be written; the ring still holds what
   * followed the last one.
   */
  checkpoint(reason: CheckpointReason | 'due' | 'shutdown'): 'done' | 'wait' | 'failed'
}

/** `retryAt`: after a write that failed, the thresholds wait until then (a forced request does not). */
type Entry = { c: CheckpointCandidate; forced: CheckpointReason | null; waiting: boolean; retryAt: number }

export class CheckpointScheduler {
  private readonly clock: Clock
  private readonly entries = new Map<string, Entry>() // bounded: one per live PTY
  private timer: TimerHandle | undefined
  private timerAt = Number.POSITIVE_INFINITY
  private lastRunAt = Number.NEGATIVE_INFINITY
  private lastKeystrokeAt = Number.NEGATIVE_INFINITY
  private disposed = false
  /** Serialisations run, for the resource report and tests. */
  runs = 0

  /** PTYs the scheduler watches (one per live PTY). */
  get size(): number {
    return this.entries.size
  }
  /** Checkpoints asked for outright or waiting for a ground-state seq. */
  get pending(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.forced !== null || e.waiting) n++
    return n
  }
  get armed(): boolean {
    return this.timer !== undefined
  }

  constructor(clock: Clock) {
    this.clock = clock
  }

  add(c: CheckpointCandidate): void {
    this.entries.set(c.ptyId, { c, forced: null, waiting: false, retryAt: Number.NEGATIVE_INFINITY })
  }

  /** `c` is gone: the timer goes too when nothing else is due. */
  remove(c: CheckpointCandidate): void {
    if (this.entries.get(c.ptyId)?.c !== c) return
    this.entries.delete(c.ptyId)
    this.arm()
  }

  /** A keystroke reached a visible terminal: no serialisation for L.checkpointQuietMs. */
  keystroke(): void {
    this.lastKeystrokeAt = this.clock.now()
  }

  /** Checkpoint `c` as soon as the rules allow, whatever its thresholds say. */
  request(c: CheckpointCandidate, reason: CheckpointReason): void {
    const e = this.entries.get(c.ptyId)
    if (!e || e.c !== c) return
    e.forced = reason
    e.waiting = false
    this.arm()
  }

  /** `c` parsed more output, or may have reached a ground-state seq. */
  poke(c: CheckpointCandidate): void {
    const e = this.entries.get(c.ptyId)
    if (!e || e.c !== c) return
    e.waiting = false
    this.arm()
  }

  /** Ptyhost is shutting down: checkpoint every dirty mirror now, ignoring the quiet and rate rules. */
  flushAll(): void {
    for (const e of this.entries.values()) {
      if (e.c.dirtyBytes() > 0 || e.forced) e.c.checkpoint('shutdown')
    }
  }

  dispose(): void {
    this.disposed = true
    this.clear()
    this.entries.clear()
  }

  // ── internals ─────────────────────────────────────────────────────────────────────

  /** When `e` becomes due; +∞ if it is clean and not asked for. */
  private dueAt(e: Entry): number {
    if (e.waiting) return Number.POSITIVE_INFINITY
    if (e.forced) return Number.NEGATIVE_INFINITY
    const dirty = e.c.dirtyBytes()
    if (dirty === 0) return Number.POSITIVE_INFINITY
    if (dirty >= e.c.ringCapacity() * L.checkpointRingFraction) return e.retryAt
    return Math.max(e.retryAt, e.c.lastCheckpointAt() + L.checkpointMaxAgeMs)
  }

  private gateAt(): number {
    return Math.max(this.lastRunAt + L.checkpointMinIntervalMs, this.lastKeystrokeAt + L.checkpointQuietMs)
  }

  private arm(): void {
    if (this.disposed) return
    let due = Number.POSITIVE_INFINITY
    for (const e of this.entries.values()) due = Math.min(due, this.dueAt(e))
    if (due === Number.POSITIVE_INFINITY) {
      this.clear()
      return
    }
    const at = Math.max(due, this.gateAt())
    if (this.timer !== undefined && this.timerAt <= at) return
    this.clear()
    this.timerAt = at
    this.timer = this.clock.setTimeout(() => this.run(), Math.max(0, at - this.clock.now()))
  }

  private clear(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.timerAt = Number.POSITIVE_INFINITY
  }

  private run(): void {
    this.timer = undefined
    this.timerAt = Number.POSITIVE_INFINITY
    if (this.disposed) return
    const now = this.clock.now()
    if (now < this.gateAt()) return this.arm()
    // the most overdue first; forced requests before threshold ones
    let pick: Entry | null = null
    let pickDue = Number.POSITIVE_INFINITY
    for (const e of this.entries.values()) {
      const d = this.dueAt(e)
      if (d <= now && d < pickDue) {
        pick = e
        pickDue = d
      }
    }
    if (pick) {
      const reason = pick.forced ?? 'due'
      const r = pick.c.checkpoint(reason)
      if (r === 'wait') pick.waiting = true
      else {
        pick.forced = null
        this.lastRunAt = this.clock.now()
        pick.retryAt = r === 'failed' ? this.lastRunAt + L.checkpointMaxAgeMs : Number.NEGATIVE_INFINITY
        this.runs++
      }
    }
    this.arm()
  }
}
