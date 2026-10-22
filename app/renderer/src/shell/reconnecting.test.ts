import { afterEach, describe, expect, it, vi } from 'vitest'
import { L } from '@kea/protocol'
import { ReconnectingState } from './reconnecting.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** The bar's state with a record of every change it announced. */
function bar() {
  const s = new ReconnectingState(L.reconnectingBarDelayMs)
  const seen: boolean[] = []
  s.subscribe(() => seen.push(s.shown))
  return { s, seen }
}

describe('Reconnecting bar', () => {
  it('U-FAIL-4 · a core restart faster than L.reconnectingBarDelayMs never shows the bar, not even for a frame', () => {
    vi.useFakeTimers()
    const { s, seen } = bar()
    s.coreAway()
    vi.advanceTimersByTime(L.reconnectingBarDelayMs - 1)
    expect(s.shown).toBe(false)
    s.coreBack()
    vi.advanceTimersByTime(L.reconnectingBarDelayMs * 10)
    expect(s.shown).toBe(false)
    expect(seen, 'no change was ever announced').toEqual([])
    // a second fast restart: the same
    s.coreAway()
    vi.advanceTimersByTime(L.reconnectingBarDelayMs / 2)
    s.coreBack()
    vi.runAllTimers()
    expect(seen).toEqual([])
  })

  it('U-FAIL-4 · core away longer than the delay: the bar shows at the delay, stays while core is away, and goes the moment core is back', () => {
    vi.useFakeTimers()
    const { s, seen } = bar()
    s.coreAway()
    vi.advanceTimersByTime(L.reconnectingBarDelayMs)
    expect(s.shown).toBe(true)
    // core exits again while away (a crash loop): nothing re-arms and nothing flickers
    s.coreAway()
    vi.advanceTimersByTime(L.reconnectingBarDelayMs * 20)
    expect(s.shown).toBe(true)
    s.coreBack()
    expect(s.shown).toBe(false)
    expect(seen).toEqual([true, false])
    // the next outage counts from its own start
    s.coreAway()
    vi.advanceTimersByTime(L.reconnectingBarDelayMs - 1)
    expect(s.shown).toBe(false)
    vi.advanceTimersByTime(1)
    expect(s.shown).toBe(true)
    expect(seen).toEqual([true, false, true])
  })

  it('U-FAIL-4 · a new RPC port without an outage (the first one, or a reload) changes nothing; an unsubscribed bar hears nothing', () => {
    vi.useFakeTimers()
    const { s, seen } = bar()
    s.coreBack()
    expect(s.shown).toBe(false)
    const late: boolean[] = []
    const off = s.subscribe(() => late.push(s.shown))
    off()
    s.coreAway()
    vi.advanceTimersByTime(L.reconnectingBarDelayMs)
    expect(seen).toEqual([true])
    expect(late).toEqual([])
  })
})
