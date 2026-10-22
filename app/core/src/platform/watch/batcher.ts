// The change batcher: raw watcher events are collected for one window, coalesced by path, handed on in chunks
// with a yield between them, and collapsed into a single "rescan" when too many are pending, so `pnpm install` in a
// worktree cannot stall core or grow a queue without bound. Pure: its one timer comes from `schedule` (the owner's
// scope; a plain timeout by default, which fake timers drive in tests).
//
// Coalescing by path, in arrival order (the watcher's event types are hints: an atomic save is a `create`):
//   create then delete   delete  (the two came in different batches of the watcher's, and whoever read the tree between
//                                 them, as a worktree shown does, holds the path: told it is gone, a reader that
//                                 never saw it has nothing to drop. The watcher reports one made and removed within its
//                                 own batch the same way, where upstream's leaves it out)
//   delete then create   update  (the file was replaced)
//   update then delete   delete
//   create then update   create
//   anything else        the later one, except that a pending `create` stays a create

import type { Disposable } from '@kea/kit'
import { L } from '@kea/protocol'
import type { NativeEventType } from './native.ts'

export type ChangeKind = NativeEventType
/** One chunk of coalesced changes: path → what happened to it. */
export type Changes = ReadonlyMap<string, ChangeKind>

export interface BatcherOptions {
  /** The window's timer: run `fn` once after `ms`; disposing the result cancels it. Default: `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => Disposable
  /** A chunk of at most `chunk` changes. */
  onChanges(changes: Changes): void
  /** More than `rescanThreshold` were pending, or the source said events were lost: everything may have changed. */
  onRescan(): void
  /** Run `fn` after the current turn of the event loop (between chunks). Default `setImmediate`. */
  defer?: (fn: () => void) => void
  windowMs?: number
  chunk?: number
  rescanThreshold?: number
}

export function coalesce(prev: ChangeKind | undefined, next: ChangeKind): ChangeKind {
  if (prev === undefined) return next
  if (prev === 'create') return next === 'delete' ? 'delete' : 'create'
  if (prev === 'delete') return next === 'delete' ? 'delete' : 'update'
  return next === 'create' ? 'update' : next
}

export class ChangeBatcher implements Disposable {
  // bounded: L.watchRescanThreshold paths; one more clears it and marks a rescan
  private pending = new Map<string, ChangeKind>()
  private rescanPending = false
  private timer: Disposable | null = null
  /** Chunks of a flush still to hand on. */
  private draining: Map<string, ChangeKind> | null = null
  private disposed = false
  private readonly o: BatcherOptions
  private readonly windowMs: number
  private readonly chunk: number
  private readonly threshold: number
  /** The most paths ever pending at once (the leak suite holds it to the threshold). */
  peak = 0

  constructor(o: BatcherOptions) {
    this.o = o
    this.windowMs = o.windowMs ?? L.watchBatchMs
    this.chunk = o.chunk ?? L.watchChunk
    this.threshold = o.rescanThreshold ?? L.watchRescanThreshold
  }

  /** Paths waiting for the window to end or for their chunk. */
  get size(): number {
    return this.pending.size + (this.draining?.size ?? 0)
  }

  get armed(): boolean {
    return this.timer !== null
  }

  add(path: string, kind: ChangeKind): void {
    if (this.disposed) return
    if (!this.rescanPending) {
      this.pending.set(path, coalesce(this.pending.get(path), kind))
      if (this.size > this.threshold) {
        // Too many to track one by one
        this.pending.clear()
        this.draining = null
        this.rescanPending = true
      } else if (this.size > this.peak) this.peak = this.size
    }
    this.arm()
  }

  /** The source lost events, or the caller wants one full refresh: delivered once, at the window's end. */
  rescan(): void {
    if (this.disposed) return
    this.pending.clear()
    this.draining = null
    this.rescanPending = true
    this.arm()
  }

  /** Drop what is pending (the consumer stopped looking: a worktree no longer visible). */
  clear(): void {
    this.pending.clear()
    this.draining = null
    this.rescanPending = false
    this.timer?.dispose()
    this.timer = null
  }

  dispose(): void {
    this.clear()
    this.disposed = true
  }

  private arm(): void {
    if (this.timer !== null) return
    const run = (): void => {
      this.timer = null
      this.flush()
    }
    this.timer = this.o.schedule ? this.o.schedule(run, this.windowMs) : plainTimeout(run, this.windowMs)
  }

  private flush(): void {
    if (this.disposed) return
    if (this.rescanPending) {
      this.rescanPending = false
      this.o.onRescan()
      return
    }
    if (this.pending.size === 0) return
    if (this.draining) {
      // the previous flush is still being handed on: its paths and these are one set
      for (const [p, k] of this.pending) this.draining.set(p, coalesce(this.draining.get(p), k))
      this.pending = new Map()
      return
    }
    this.draining = this.pending
    this.pending = new Map()
    this.drain()
  }

  private drain(): void {
    const from = this.draining
    if (this.disposed || !from) return
    const out = new Map<string, ChangeKind>()
    for (const [p, k] of from) {
      out.set(p, k)
      from.delete(p)
      if (out.size >= this.chunk) break
    }
    if (from.size === 0) this.draining = null
    else (this.o.defer ?? setImmediate)(() => this.drain())
    if (out.size) this.o.onChanges(out)
  }
}

function plainTimeout(fn: () => void, ms: number): Disposable {
  const t = setTimeout(fn, ms)
  return { dispose: () => clearTimeout(t) }
}
