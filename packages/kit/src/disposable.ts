// Ownership of long-lived resources, modelled on VS Code's `lifecycle.ts`.
//
// Every long-lived resource is created inside a disposable scope and released when the scope is
// disposed. A `DisposableTracker` (tests and dev builds) records the creation stack of every
// tracked object and lists the ones still alive, so a leak points at the line that made it.

export interface Disposable {
  dispose(): void
}

export function isDisposable(x: unknown): x is Disposable {
  return typeof x === 'object' && x !== null && typeof (x as { dispose?: unknown }).dispose === 'function'
}

// ── tracker ─────────────────────────────────────────────────────────────────────

/** One live tracked object, as reported by `DisposableTracker.undisposed()`. */
export interface TrackedDisposable {
  readonly value: Disposable
  /** Creation stack, without the frames of this module. */
  readonly stack: string
  /** The store (or MutableDisposable) that owns it, if any. */
  readonly parent: Disposable | undefined
}

interface TrackerRecord {
  /** Captured at creation; V8 formats `.stack` lazily, so capture is cheap until it is read. */
  readonly origin: Error
  parent: Disposable | undefined
  singleton: boolean
}

/**
 * This module's path, matched against both `file://` URLs and plain paths in stack frames. Inside a bundle (dist/app,
 * CommonJS) there is no module URL and every frame shares the bundle's path, so nothing is filtered there.
 */
const MODULE_URL: unknown = import.meta.url
const THIS_MODULE = typeof MODULE_URL === 'string' ? new URL(MODULE_URL).pathname : null

function cleanStack(err: Error): string {
  const lines = (err.stack ?? '').split('\n').slice(1)
  return (THIS_MODULE ? lines.filter((l) => !l.includes(THIS_MODULE)) : lines).join('\n')
}

/**
 * Records every tracked disposable created while it is installed (`setDisposableTracker`) and
 * forgets it when it is disposed. `undisposed()` lists what is still alive with creation stacks.
 */
export class DisposableTracker {
  // bounded: live tracked objects only — an entry leaves when its object is disposed (tests and dev builds)
  private readonly live = new Map<Disposable, TrackerRecord>()

  track(x: Disposable): void {
    if (this.live.has(x)) return
    this.live.set(x, { origin: new Error('created here'), parent: undefined, singleton: false })
  }

  markAsDisposed(x: Disposable): void {
    this.live.delete(x)
  }

  setParent(child: Disposable, parent: Disposable | undefined): void {
    const rec = this.live.get(child)
    if (rec) rec.parent = parent
  }

  /** Process-lifetime objects (module singletons) that are never disposed by design. */
  markAsSingleton(x: Disposable): void {
    const rec = this.live.get(x)
    if (rec) rec.singleton = true
  }

  /** Number of live tracked objects (singletons included). */
  get size(): number {
    return this.live.size
  }

  /**
   * Live tracked objects (singletons excluded), oldest first. With `rootsOnly`, objects whose owner
   * (or an owner further up) is itself alive and tracked are left out, so a leaked store is
   * reported once rather than once per child.
   */
  undisposed(opts: { rootsOnly?: boolean } = {}): TrackedDisposable[] {
    const out: TrackedDisposable[] = []
    for (const [value, rec] of this.live) {
      if (rec.singleton) continue
      if (opts.rootsOnly && this.hasLiveAncestor(rec)) continue
      out.push({ value, stack: cleanStack(rec.origin), parent: rec.parent })
    }
    return out
  }

  /** A readable leak report (empty string when nothing leaked). */
  report(opts: { rootsOnly?: boolean } = { rootsOnly: true }): string {
    return this.undisposed(opts)
      .map((e, i) => `[${i + 1}] ${e.value.constructor?.name ?? 'Disposable'} created at:\n${e.stack}`)
      .join('\n\n')
  }

  clear(): void {
    this.live.clear()
  }

  /** A live owner is itself reported (or is a singleton), so its children are not roots. */
  private hasLiveAncestor(rec: TrackerRecord): boolean {
    return rec.parent !== undefined && this.live.has(rec.parent)
  }
}

let tracker: DisposableTracker | null = null

/** Install (or remove, with `null`) the process-wide tracker. Tests and dev builds only. */
export function setDisposableTracker(t: DisposableTracker | null): void {
  tracker = t
}

export function getDisposableTracker(): DisposableTracker | null {
  return tracker
}

/** Register `x` with the tracker, if one is installed. Classes that own resources call this in their constructor. */
export function trackDisposable<T extends Disposable>(x: T): T {
  tracker?.track(x)
  return x
}

export function markAsDisposed(x: Disposable): void {
  tracker?.markAsDisposed(x)
}

export function setParentOfDisposable(child: Disposable, parent: Disposable | undefined): void {
  tracker?.setParent(child, parent)
}

/** Exempt a process-lifetime object from leak reports. */
export function markAsSingleton<T extends Disposable>(x: T): T {
  tracker?.markAsSingleton(x)
  return x
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/** A disposable that does nothing (not tracked). */
export const noopDisposable: Disposable = Object.freeze({ dispose() {} })

/** Wrap a cleanup function. The function runs at most once. */
export function toDisposable(fn: () => void): Disposable {
  let done = false
  const d: Disposable = {
    dispose() {
      if (done) return
      done = true
      markAsDisposed(d)
      fn()
    },
  }
  return trackDisposable(d)
}

function throwCollected(errors: unknown[], what: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} errors while disposing ${what}`)
}

/**
 * Dispose every item in the given order. An error from one item does not stop the others; after
 * all have run, a single error is rethrown as is and several as an `AggregateError`.
 */
export function disposeAll(items: Iterable<Disposable | undefined | null>): void {
  const errors: unknown[] = []
  for (const d of items) {
    if (!d) continue
    try {
      d.dispose()
    } catch (e) {
      errors.push(e)
    }
  }
  throwCollected(errors, 'disposables')
}

/** One disposable that disposes all of `items` in reverse order. */
export function combinedDisposable(...items: Disposable[]): Disposable {
  return toDisposable(() => disposeAll(items.slice().reverse()))
}

// ── DisposableStore ─────────────────────────────────────────────────────────────

/**
 * Owns a set of disposables. `dispose()` disposes them in reverse order of addition (last created,
 * first released), once; errors from one child do not stop the others and are rethrown afterwards.
 * Adding to a disposed store disposes the item at once and warns.
 */
export class DisposableStore implements Disposable {
  // bounded: the resources one scope owns; items leave on delete/clear/dispose, and Scope helpers remove themselves when they finish
  private readonly items = new Set<Disposable>()
  private disposed = false

  constructor() {
    trackDisposable(this)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Number of items currently owned. */
  get size(): number {
    return this.items.size
  }

  add<T extends Disposable>(item: T): T {
    if ((item as unknown) === this) throw new Error('DisposableStore: cannot add a store to itself')
    if (this.disposed) {
      console.warn(
        new Error('DisposableStore: add() on a disposed store — the item was disposed immediately').stack,
      )
      item.dispose()
      return item
    }
    setParentOfDisposable(item, this)
    this.items.add(item)
    return item
  }

  has(item: Disposable): boolean {
    return this.items.has(item)
  }

  /** Remove `item` and dispose it (if this store owned it). */
  delete(item: Disposable): void {
    if (!this.items.delete(item)) return
    setParentOfDisposable(item, undefined)
    item.dispose()
  }

  /** Remove `item` without disposing it; the caller takes ownership. */
  deleteAndLeak(item: Disposable): void {
    if (this.items.delete(item)) setParentOfDisposable(item, undefined)
  }

  /** Dispose every item (reverse order) but keep the store usable. */
  clear(): void {
    if (this.items.size === 0) return
    const list = [...this.items].reverse()
    this.items.clear()
    const errors: unknown[] = []
    for (const d of list) {
      try {
        d.dispose()
      } catch (e) {
        errors.push(e)
      }
    }
    throwCollected(errors, 'a DisposableStore')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    markAsDisposed(this)
    this.clear()
  }
}

// ── MutableDisposable ───────────────────────────────────────────────────────────

/** Holds at most one disposable; replacing or clearing the value disposes the previous one. */
export class MutableDisposable<T extends Disposable> implements Disposable {
  private current: T | undefined
  private disposed = false

  constructor() {
    trackDisposable(this)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get value(): T | undefined {
    return this.disposed ? undefined : this.current
  }

  set value(next: T | undefined) {
    if (this.disposed) {
      if (next) {
        console.warn(new Error('MutableDisposable: value set after dispose — the value was disposed immediately').stack)
        next.dispose()
      }
      return
    }
    if (next === this.current) return
    const prev = this.current
    this.current = next
    if (next) setParentOfDisposable(next, this)
    prev?.dispose()
  }

  clear(): void {
    this.value = undefined
  }

  /** Forget the value without disposing it; the caller takes ownership. */
  clearAndLeak(): T | undefined {
    const v = this.current
    this.current = undefined
    if (v) setParentOfDisposable(v, undefined)
    return v
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    markAsDisposed(this)
    const v = this.current
    this.current = undefined
    v?.dispose()
  }
}
