import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DisposableStore,
  DisposableTracker,
  MutableDisposable,
  disposeAll,
  markAsSingleton,
  setDisposableTracker,
  toDisposable,
} from './disposable.ts'
import { Scope } from './scope.ts'

afterEach(() => {
  setDisposableTracker(null)
  vi.restoreAllMocks()
})

describe('DisposableStore', () => {
  it('U-MEM-1 · nested scopes dispose children in reverse order of addition', () => {
    const order: string[] = []
    const outer = new DisposableStore()
    outer.add(toDisposable(() => order.push('a')))
    const inner = outer.add(new DisposableStore())
    inner.add(toDisposable(() => order.push('inner-1')))
    inner.add(toDisposable(() => order.push('inner-2')))
    outer.add(toDisposable(() => order.push('c')))
    outer.dispose()
    expect(order).toEqual(['c', 'inner-2', 'inner-1', 'a'])
    expect(outer.isDisposed).toBe(true)
    expect(inner.isDisposed).toBe(true)
  })

  it('U-MEM-1 · double dispose is a no-op', () => {
    const fn = vi.fn()
    const store = new DisposableStore()
    const d = store.add(toDisposable(fn))
    store.dispose()
    store.dispose()
    d.dispose()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('U-MEM-1 · adding to a disposed store disposes the item immediately and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new DisposableStore()
    store.dispose()
    const fn = vi.fn()
    store.add(toDisposable(fn))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.size).toBe(0)
  })

  it('U-MEM-1 · an error from one child does not stop the others; errors are rethrown after', () => {
    const order: string[] = []
    const store = new DisposableStore()
    store.add(toDisposable(() => order.push('first')))
    store.add(
      toDisposable(() => {
        throw new Error('boom-1')
      }),
    )
    store.add(toDisposable(() => order.push('middle')))
    store.add(
      toDisposable(() => {
        throw new Error('boom-2')
      }),
    )
    let caught: unknown
    try {
      store.dispose()
    } catch (e) {
      caught = e
    }
    expect(order).toEqual(['middle', 'first'])
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors.map((e: Error) => e.message)).toEqual(['boom-2', 'boom-1'])

    const single = new DisposableStore()
    single.add(
      toDisposable(() => {
        throw new Error('only')
      }),
    )
    expect(() => single.dispose()).toThrow('only')
  })

  it('U-MEM-1 · delete disposes, deleteAndLeak hands ownership back, clear keeps the store usable', () => {
    const store = new DisposableStore()
    const a = vi.fn()
    const b = vi.fn()
    const da = store.add(toDisposable(a))
    const db = store.add(toDisposable(b))
    store.delete(da)
    expect(a).toHaveBeenCalledTimes(1)
    store.deleteAndLeak(db)
    store.dispose()
    expect(b).not.toHaveBeenCalled()
    db.dispose()

    const s2 = new DisposableStore()
    const c = vi.fn()
    s2.add(toDisposable(c))
    s2.clear()
    expect(c).toHaveBeenCalledTimes(1)
    expect(s2.isDisposed).toBe(false)
    s2.add(toDisposable(c))
    expect(s2.size).toBe(1)
    s2.dispose()
    expect(() => s2.add(s2 as never)).toThrow()
  })

  it('U-MEM-1 · disposeAll aggregates errors and keeps going', () => {
    const fn = vi.fn()
    expect(() =>
      disposeAll([
        toDisposable(() => {
          throw new Error('x')
        }),
        toDisposable(fn),
      ]),
    ).toThrow('x')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('MutableDisposable', () => {
  it('U-MEM-1 · replacing or clearing the value disposes the previous one', () => {
    const m = new MutableDisposable()
    const a = vi.fn()
    const b = vi.fn()
    m.value = toDisposable(a)
    m.value = toDisposable(b)
    expect(a).toHaveBeenCalledTimes(1)
    m.clear()
    expect(b).toHaveBeenCalledTimes(1)
    const c = vi.fn()
    m.value = toDisposable(c)
    const leaked = m.clearAndLeak()
    m.dispose()
    expect(c).not.toHaveBeenCalled()
    leaked?.dispose()
    expect(c).toHaveBeenCalledTimes(1)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const late = vi.fn()
    m.value = toDisposable(late)
    expect(late).toHaveBeenCalledTimes(1)
    expect(m.value).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('DisposableTracker', () => {
  function makeLeak(): DisposableStore {
    return new DisposableStore() // this line is the creation site the tracker must report
  }

  it('U-MEM-1 · tracker lists undisposed objects with creation stacks', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    const disposed = new DisposableStore()
    disposed.add(toDisposable(() => {}))
    disposed.dispose()

    const leaked = makeLeak()
    const child = leaked.add(toDisposable(() => {}))
    const scope = new Scope('s')
    const timer = scope.timeout(() => {}, 1000)

    const all = tracker.undisposed()
    expect(all.map((e) => e.value)).toEqual([leaked, child, scope, timer])
    const leakEntry = all.find((e) => e.value === leaked)
    expect(leakEntry?.stack).toContain('makeLeak')
    expect(leakEntry?.stack).toContain('disposable.test.ts')
    expect(leakEntry?.stack).not.toContain('/kit/src/disposable.ts')
    expect(all.find((e) => e.value === child)?.parent).toBe(leaked)

    // Roots only: the leaked store and the scope, not what they own.
    expect(tracker.undisposed({ rootsOnly: true }).map((e) => e.value)).toEqual([leaked, scope])
    expect(tracker.report()).toContain('DisposableStore created at')

    scope.dispose()
    leaked.dispose()
    expect(tracker.undisposed()).toEqual([])
  })

  it('U-MEM-1 · singletons are exempt and objects made before the tracker are ignored', () => {
    const before = new DisposableStore()
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    const single = markAsSingleton(new DisposableStore())
    expect(tracker.undisposed()).toEqual([])
    before.dispose()
    single.dispose()
    expect(tracker.size).toBe(0)
  })
})
