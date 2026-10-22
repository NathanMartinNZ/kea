import { L } from '@kea/protocol/limits'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DisposableTracker, setDisposableTracker } from './disposable.ts'
import { Emitter, once } from './emitter.ts'
import { resources } from './resources.ts'

afterEach(() => {
  setDisposableTracker(null)
  vi.restoreAllMocks()
})

describe('Emitter', () => {
  it('U-MEM-13 · delivers to listeners, unsubscribes on dispose, counts listeners', () => {
    const base = resources.report()['kit.listeners'] as number
    const e = new Emitter<string>()
    const a = vi.fn()
    const b = vi.fn()
    const subA = e.event(a)
    e.event(b)
    expect(e.listenerCount).toBe(2)
    expect(resources.report()['kit.listeners']).toBe(base + 2)
    e.fire('x')
    subA.dispose()
    subA.dispose()
    e.fire('y')
    expect(a.mock.calls).toEqual([['x']])
    expect(b.mock.calls).toEqual([['x'], ['y']])
    e.dispose()
    e.fire('z')
    expect(b).toHaveBeenCalledTimes(2)
    expect(e.listenerCount).toBe(0)
    expect(resources.report()['kit.listeners']).toBe(base)
    e.event(a).dispose() // no-op after dispose
  })

  it('U-MEM-13 · a throwing listener does not stop the others; the error is rethrown after', () => {
    const e = new Emitter<number>()
    const after = vi.fn()
    e.event(() => {
      throw new Error('bad listener')
    })
    e.event(after)
    expect(() => e.fire(1)).toThrow('bad listener')
    expect(after).toHaveBeenCalledWith(1)
  })

  it('U-MEM-13 · a listener removed during delivery is skipped; one added during delivery waits for the next fire', () => {
    const e = new Emitter<number>()
    const late = vi.fn()
    const second = vi.fn()
    let subSecond = { dispose() {} }
    e.event(() => {
      subSecond.dispose()
      e.event(late)
    })
    subSecond = e.event(second)
    e.fire(1)
    expect(second).not.toHaveBeenCalled()
    expect(late).not.toHaveBeenCalled()
    e.fire(2)
    expect(late).toHaveBeenCalledWith(2)
  })

  it('U-MEM-13 · warns once above L.listenerWarnCount listeners, naming the most frequent listener stack', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = new Emitter<void>({ name: 'leaky' })
    function leakySubscriber(): void {
      e.event(() => {})
    }
    for (let i = 0; i < L.listenerWarnCount; i++) leakySubscriber()
    expect(warn).not.toHaveBeenCalled()
    e.event(() => {}) // one more, from elsewhere → over the threshold
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]?.[0])
    expect(msg).toContain('[leaky] potential listener leak')
    expect(msg).toContain(`${L.listenerWarnCount + 1} listeners`)
    expect(msg).toContain(`(${L.listenerWarnCount}×)`)
    expect(msg).toContain('leakySubscriber')
    leakySubscriber()
    expect(warn).toHaveBeenCalledTimes(1)
    e.dispose()
  })

  it('U-MEM-13 · subscriptions are tracked; disposing the emitter releases them', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    const e = new Emitter<number>()
    e.event(() => {})
    e.event(() => {})
    expect(tracker.undisposed()).toHaveLength(2)
    e.dispose()
    expect(tracker.undisposed()).toHaveLength(0)
  })

  it('U-MEM-13 · first/last listener hooks and once()', () => {
    const first = vi.fn()
    const last = vi.fn()
    const e = new Emitter<number>({ onWillAddFirstListener: first, onDidRemoveLastListener: last })
    const seen: number[] = []
    once(e.event)((v) => seen.push(v))
    expect(first).toHaveBeenCalledTimes(1)
    e.fire(1)
    e.fire(2)
    expect(seen).toEqual([1])
    expect(last).toHaveBeenCalledTimes(1)
    expect(e.listenerCount).toBe(0)
  })
})
