// Typed event emitter. Subscriptions are disposables (tracked by the leak tracker) and the process-wide listener total
// is a resource-report row. In dev builds an emitter that exceeds L.listenerWarnCount listeners warns once, naming the
// most frequent listener's creation stack.

import { L } from '@kea/protocol/limits'
import { noopDisposable, toDisposable } from './disposable.ts'
import type { Disposable } from './disposable.ts'
import { resources } from './resources.ts'

export type Listener<T> = (value: T) => void
/** Subscribe; dispose the result to unsubscribe. */
export type Event<T> = (listener: Listener<T>) => Disposable

export interface EmitterOptions {
  /** Shown in the leak warning. */
  name?: string
  onWillAddFirstListener?: () => void
  onDidRemoveLastListener?: () => void
}

interface Entry<T> {
  readonly fn: Listener<T>
  sub: Disposable
  /** Dev builds only: where the listener was added (formatted lazily, only if the emitter warns). */
  readonly origin: Error | undefined
}

const listenerTotal = resources.counter('kit.listeners')

const DEV = typeof process === 'undefined' || process.env.NODE_ENV !== 'production'

function stackOf(err: Error): string {
  return (err.stack ?? '').split('\n').slice(1).join('\n')
}

export class Emitter<T> implements Disposable {
  // bounded: one emitter's listeners; dev builds warn above L.listenerWarnCount
  private readonly entries = new Set<Entry<T>>()
  private readonly opts: EmitterOptions
  private disposed = false
  private warned = false

  readonly event: Event<T>

  constructor(opts: EmitterOptions = {}) {
    this.opts = opts
    this.event = (fn) => this.subscribe(fn)
  }

  get listenerCount(): number {
    return this.entries.size
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Deliver `value` to every listener registered before this call. A listener removed during
   * delivery is skipped; one that throws does not stop the others — the error (or an
   * AggregateError) is rethrown after every listener has run.
   */
  fire(value: T): void {
    if (this.disposed || this.entries.size === 0) return
    const snapshot = [...this.entries]
    let errors: unknown[] | undefined
    for (const e of snapshot) {
      if (!this.entries.has(e)) continue
      try {
        e.fn(value)
      } catch (err) {
        ;(errors ??= []).push(err)
      }
    }
    if (errors?.length === 1) throw errors[0]
    if (errors) throw new AggregateError(errors, `${errors.length} listeners of ${this.opts.name ?? 'an emitter'} threw`)
  }

  /** Drop every listener; later `fire` calls do nothing and new subscriptions are no-ops. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const e of [...this.entries]) e.sub.dispose()
  }

  private subscribe(fn: Listener<T>): Disposable {
    if (this.disposed) return noopDisposable
    if (this.entries.size === 0) this.opts.onWillAddFirstListener?.()
    const entry: Entry<T> = { fn, sub: noopDisposable, origin: DEV ? new Error('listener added here') : undefined }
    entry.sub = toDisposable(() => this.remove(entry))
    this.entries.add(entry)
    listenerTotal.inc()
    if (DEV && !this.warned && this.entries.size > L.listenerWarnCount) this.warnLeak()
    return entry.sub
  }

  private remove(entry: Entry<T>): void {
    if (!this.entries.delete(entry)) return
    listenerTotal.dec()
    if (this.entries.size === 0) this.opts.onDidRemoveLastListener?.()
  }

  private warnLeak(): void {
    this.warned = true
    const byStack = new Map<string, number>()
    for (const e of this.entries) {
      if (!e.origin) continue
      const s = stackOf(e.origin)
      byStack.set(s, (byStack.get(s) ?? 0) + 1)
    }
    let top = ''
    let topCount = 0
    for (const [s, n] of byStack) {
      if (n > topCount) {
        top = s
        topCount = n
      }
    }
    console.warn(
      `[${this.opts.name ?? 'Emitter'}] potential listener leak: ${this.entries.size} listeners ` +
        `(warns above ${L.listenerWarnCount}). Most frequent listener (${topCount}×) added at:\n${top}`,
    )
  }
}

/** Subscribe for one delivery only. */
export function once<T>(event: Event<T>): Event<T> {
  return (listener) => {
    let fired = false
    const sub: Disposable = event((v) => {
      if (fired) return
      fired = true
      sub.dispose()
      listener(v)
    })
    if (fired) sub.dispose()
    return sub
  }
}
