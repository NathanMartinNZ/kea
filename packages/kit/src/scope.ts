// Scopes: a DisposableStore with helpers that register their own cleanup, so timers, listeners and child scopes cannot
// outlive their owner. Helpers remove themselves from the scope when they finish (a fired timeout, a disposed child),
// so a long-lived scope does not accumulate dead entries. Timers run on the injected Clock, which is monotonic.

import { systemClock } from './clock.ts'
import type { Clock, TimerHandle } from './clock.ts'
import { DisposableStore, noopDisposable, toDisposable } from './disposable.ts'
import type { Disposable } from './disposable.ts'
import type { Event } from './emitter.ts'
import { resources } from './resources.ts'

// Listener signatures are the target's business, hence `any` in the two target shapes below.

/** Node `EventEmitter`-like target (`on` + `off`/`removeListener`). */
export interface NodeStyleTarget {
  on(event: string | symbol, listener: (...args: any[]) => void): unknown
  off?(event: string | symbol, listener: (...args: any[]) => void): unknown
  removeListener?(event: string | symbol, listener: (...args: any[]) => void): unknown
}

/** DOM `EventTarget`-like target. */
export interface DomStyleTarget {
  addEventListener(type: string, listener: (ev: any) => void, options?: any): void
  removeEventListener(type: string, listener: (ev: any) => void, options?: any): void
}

export type ListenTarget = NodeStyleTarget | DomStyleTarget

/** DOM listener options (ignored for Node-style targets). */
export type ListenOptions = boolean | { capture?: boolean; passive?: boolean }

const timersAlive = resources.counter('kit.timers')
const targetListeners = resources.counter('kit.targetListeners')
const scopesAlive = resources.counter('kit.scopes')

function isNodeStyle(t: ListenTarget): t is NodeStyleTarget {
  const n = t as NodeStyleTarget
  return typeof n.on === 'function' && (typeof n.off === 'function' || typeof n.removeListener === 'function')
}

function warnDisposed(what: string, name: string | undefined): void {
  console.warn(new Error(`Scope${name ? ` "${name}"` : ''}: ${what} on a disposed scope — ignored`).stack)
}

export interface ScopeOptions {
  clock?: Clock
}

export class Scope extends DisposableStore {
  readonly name: string | undefined
  private readonly clock: Clock
  private parent: Scope | undefined
  private abort: AbortController | undefined

  constructor(name?: string, opts: ScopeOptions = {}) {
    super()
    this.name = name
    this.clock = opts.clock ?? systemClock
    scopesAlive.inc()
  }

  /** Run `fn` once after `ms` (monotonic). Disposing the result (or the scope) cancels it. */
  timeout(fn: () => void, ms: number): Disposable {
    if (this.isDisposed) {
      warnDisposed('timeout()', this.name)
      return noopDisposable
    }
    let handle: TimerHandle
    const d = toDisposable(() => {
      this.clock.clearTimeout(handle)
      timersAlive.dec()
      this.deleteAndLeak(d)
    })
    handle = this.clock.setTimeout(() => {
      d.dispose()
      fn()
    }, ms)
    timersAlive.inc()
    return this.add(d)
  }

  /** Run `fn` every `ms` (monotonic) until the result or the scope is disposed. */
  interval(fn: () => void, ms: number): Disposable {
    if (this.isDisposed) {
      warnDisposed('interval()', this.name)
      return noopDisposable
    }
    const handle = this.clock.setInterval(fn, ms)
    timersAlive.inc()
    const d = toDisposable(() => {
      this.clock.clearInterval(handle)
      timersAlive.dec()
      this.deleteAndLeak(d)
    })
    return this.add(d)
  }

  /**
   * Listen on a Node-style (`on`/`off`) or DOM-style (`addEventListener`) target until the result or
   * the scope is disposed. A target with both (Node's MessagePort) is used Node-style.
   */
  on(target: ListenTarget, event: string, listener: (...args: any[]) => void, options?: ListenOptions): Disposable {
    if (this.isDisposed) {
      warnDisposed(`on("${event}")`, this.name)
      return noopDisposable
    }
    let remove: () => void
    if (isNodeStyle(target)) {
      target.on(event, listener)
      remove = () => {
        if (typeof target.off === 'function') target.off(event, listener)
        else target.removeListener?.(event, listener)
      }
    } else if (typeof (target as DomStyleTarget).addEventListener === 'function') {
      const dom = target as DomStyleTarget
      dom.addEventListener(event, listener, options)
      remove = () => dom.removeEventListener(event, listener, options)
    } else {
      throw new TypeError('Scope.on: target has neither on/off nor addEventListener')
    }
    targetListeners.inc()
    const d = toDisposable(() => {
      remove()
      targetListeners.dec()
      this.deleteAndLeak(d)
    })
    return this.add(d)
  }

  /** Subscribe to a kit `Event` for the life of the scope. */
  listen<T>(event: Event<T>, listener: (value: T) => void): Disposable {
    if (this.isDisposed) {
      warnDisposed('listen()', this.name)
      return noopDisposable
    }
    const sub = event(listener)
    const d = toDisposable(() => {
      sub.dispose()
      this.deleteAndLeak(d)
    })
    return this.add(d)
  }

  /** A nested scope, disposed with this one (or earlier, on its own). */
  child(name?: string): Scope {
    const c = new Scope(name, { clock: this.clock })
    if (this.isDisposed) {
      warnDisposed('child()', this.name)
      c.dispose()
      return c
    }
    c.parent = this
    return this.add(c)
  }

  /** Aborted when the scope is disposed — hand it to `runProcess`, `fetch`, … */
  get signal(): AbortSignal {
    if (this.isDisposed) return AbortSignal.abort(new Error(`scope ${this.name ?? ''} disposed`))
    if (!this.abort) {
      const ctrl = new AbortController()
      this.abort = ctrl
      this.add(toDisposable(() => ctrl.abort(new Error(`scope ${this.name ?? ''} disposed`))))
    }
    return this.abort.signal
  }

  override dispose(): void {
    if (this.isDisposed) return
    scopesAlive.dec()
    const p = this.parent
    this.parent = undefined
    p?.deleteAndLeak(this)
    super.dispose()
  }
}
