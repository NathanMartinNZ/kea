// When a session's status runs. One pipeline at a time per worktree; whatever asks for a refresh while one runs gets
// exactly one more after it. Watcher bursts are debounced: a trigger after L.gitDebounceMs of quiet with nothing in
// flight runs at once (a single save is on screen within P-GS-1); each later one waits until that long has passed
// without another, and never longer than L.gitDebounceMaxMs. Activation, focus and the Refresh command do not wait at
// all.

import type { Disposable } from '@kea/kit'
import { L } from '@kea/protocol'

export interface SchedulerOptions {
  /** Run one status pipeline. Must not reject. */
  run(): Promise<void>
  /** Run `fn` once after `ms`; disposing cancels it (the owner's scope). */
  schedule(fn: () => void, ms: number): Disposable
  /** Monotonic milliseconds. */
  now(): number
  debounceMs?: number
  maxWaitMs?: number
}

export class StatusScheduler implements Disposable {
  private readonly o: SchedulerOptions
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private timer: Disposable | null = null
  /** When the oldest trigger still waiting arrived. */
  private pendingSince: number | null = null
  private lastTrigger = Number.NEGATIVE_INFINITY
  private again = false
  private stopped = false
  running = false
  /** Pipelines started (the resource report; I-GS-4). */
  runs = 0
  /** Triggers received. */
  triggers = 0

  constructor(o: SchedulerOptions) {
    this.o = o
    this.debounceMs = o.debounceMs ?? L.gitDebounceMs
    this.maxWaitMs = o.maxWaitMs ?? L.gitDebounceMaxMs
  }

  /** A run is waiting for its debounce or for the one in flight. */
  get pending(): boolean {
    return this.pendingSince !== null || this.again
  }

  get idle(): boolean {
    return !this.running && !this.pending
  }

  /** A trigger now would run at once: nothing in flight or waiting, and the debounce's quiet has passed. */
  get quiet(): boolean {
    return this.idle && this.o.now() - this.lastTrigger >= this.debounceMs
  }

  /** Something may have changed (a watcher event, a finished tool): debounced. */
  trigger(): void {
    if (this.stopped) return
    this.triggers++
    const now = this.o.now()
    const quiet = now - this.lastTrigger >= this.debounceMs
    this.lastTrigger = now
    if (!this.running && this.pendingSince === null && quiet) return this.start()
    this.pendingSince ??= now
    this.arm(now)
  }

  /** Refresh now (activation, focus, the Refresh command): at once, or right after the run in flight. */
  now(): void {
    if (this.stopped) return
    this.triggers++
    this.lastTrigger = this.o.now()
    if (this.running) {
      this.again = true
      return
    }
    this.start()
  }

  /** Nobody looks any more: nothing waits, nothing more starts (the owner ends the run in flight). */
  stop(): void {
    this.stopped = true
    this.timer?.dispose()
    this.timer = null
    this.pendingSince = null
    this.again = false
  }

  resume(): void {
    this.stopped = false
  }

  dispose(): void {
    this.stop()
  }

  private arm(now: number): void {
    this.timer?.dispose()
    const latest = (this.pendingSince as number) + this.maxWaitMs
    const due = Math.min(now + this.debounceMs, latest)
    this.timer = this.o.schedule(() => {
      this.timer = null
      if (this.running) this.again = true
      else this.start()
    }, Math.max(0, due - now))
  }

  private start(): void {
    this.timer?.dispose()
    this.timer = null
    this.pendingSince = null
    this.again = false
    this.running = true
    this.runs++
    void this.o.run().finally(() => {
      this.running = false
      if (this.stopped) return
      // Whatever arrived meanwhile is one trailing run; a trigger still inside its debounce keeps waiting for it
      if (this.again) this.start()
    })
  }
}
