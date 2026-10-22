import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from './emitter.ts'
import { resources } from './resources.ts'
import { Scope } from './scope.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Scope', () => {
  it('U-MEM-12 · timeouts fire once, then leave the scope; disposing the scope cancels pending ones', () => {
    vi.useFakeTimers()
    const scope = new Scope('t')
    const fired = vi.fn()
    const never = vi.fn()
    scope.timeout(fired, 100)
    scope.timeout(never, 500)
    expect(scope.size).toBe(2)
    vi.advanceTimersByTime(100)
    expect(fired).toHaveBeenCalledTimes(1)
    expect(scope.size).toBe(1)
    scope.dispose()
    vi.advanceTimersByTime(1000)
    expect(never).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('U-MEM-12 · intervals repeat until disposed; the timers row returns to baseline', () => {
    vi.useFakeTimers()
    const base = resources.report()['kit.timers']
    const scope = new Scope('i')
    const tick = vi.fn()
    const handle = scope.interval(tick, 10)
    scope.timeout(() => {}, 1000)
    expect(resources.report()['kit.timers']).toBe((base as number) + 2)
    vi.advanceTimersByTime(35)
    expect(tick).toHaveBeenCalledTimes(3)
    handle.dispose()
    expect(scope.size).toBe(1)
    vi.advanceTimersByTime(100)
    expect(tick).toHaveBeenCalledTimes(3)
    scope.dispose()
    expect(resources.report()['kit.timers']).toBe(base)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('U-MEM-12 · on() works with Node-style and DOM-style targets and removes the listener on dispose', () => {
    const scope = new Scope()
    const ee = new EventEmitter()
    const nodeFn = vi.fn()
    scope.on(ee, 'data', nodeFn)
    ee.emit('data', 1)
    expect(ee.listenerCount('data')).toBe(1)

    const target = new EventTarget()
    const domFn = vi.fn()
    scope.on(target, 'ping', domFn)
    target.dispatchEvent(new Event('ping'))

    const ctrl = new AbortController()
    const abortFn = vi.fn()
    scope.on(ctrl.signal, 'abort', abortFn)

    scope.dispose()
    ee.emit('data', 2)
    target.dispatchEvent(new Event('ping'))
    ctrl.abort()
    expect(nodeFn).toHaveBeenCalledTimes(1)
    expect(nodeFn).toHaveBeenCalledWith(1)
    expect(domFn).toHaveBeenCalledTimes(1)
    expect(abortFn).not.toHaveBeenCalled()
    expect(ee.listenerCount('data')).toBe(0)
  })

  it('U-MEM-12 · child scopes are disposed with the parent, and leave it when disposed first', () => {
    vi.useFakeTimers()
    const parent = new Scope('parent')
    const a = parent.child('a')
    const b = parent.child('b')
    const fn = vi.fn()
    b.timeout(fn, 10)
    expect(parent.size).toBe(2)
    a.dispose()
    expect(parent.size).toBe(1)
    expect(a.isDisposed).toBe(true)
    parent.dispose()
    expect(b.isDisposed).toBe(true)
    vi.advanceTimersByTime(100)
    expect(fn).not.toHaveBeenCalled()
  })

  it('U-MEM-12 · listen() subscribes to a kit Event for the life of the scope; signal aborts on dispose', () => {
    const emitter = new Emitter<number>()
    const scope = new Scope('l')
    const seen: number[] = []
    scope.listen(emitter.event, (v) => seen.push(v))
    const signal = scope.signal
    emitter.fire(1)
    scope.dispose()
    emitter.fire(2)
    expect(seen).toEqual([1])
    expect(emitter.listenerCount).toBe(0)
    expect(signal.aborted).toBe(true)
    expect(scope.signal.aborted).toBe(true)
  })

  it('U-MEM-12 · helpers on a disposed scope schedule nothing and warn', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scope = new Scope('dead')
    scope.dispose()
    const fn = vi.fn()
    scope.timeout(fn, 1)
    scope.interval(fn, 1)
    const child = scope.child()
    vi.advanceTimersByTime(10)
    expect(fn).not.toHaveBeenCalled()
    expect(child.isDisposed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('U-MEM-12 · timers run on an injected clock', () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    const clock = {
      now: () => 0,
      setTimeout: (fn: () => void, ms: number) => {
        scheduled.push({ fn, ms })
        return scheduled.length
      },
      clearTimeout: vi.fn(),
      setInterval: () => 0,
      clearInterval: vi.fn(),
    }
    const scope = new Scope('c', { clock })
    const fn = vi.fn()
    scope.timeout(fn, 42)
    expect(scheduled[0]?.ms).toBe(42)
    scheduled[0]?.fn()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(scope.size).toBe(0)
  })
})
