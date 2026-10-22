// The window handoff: what a minimized window rebuilt on Wayland gives the window made in its place.

import { L } from '@kea/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowHandoff } from './handoff.ts'

const draft = { prompt: 'fix the login redirect loop', isolation: 'worktree', base: { kind: 'default' }, branch: null, agent: 'claude', config: {} }
const PROJECT = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('the window handoff', () => {
  afterEach(() => vi.useRealTimers())

  it('U-PLT-52 · the old window is asked once and its answer, checked, goes to the window made in its place only, as often as its preload asks until its page has started (Electron may run a preload twice as a window loads), then it is let go; an answer that does not parse, comes for another question or comes late hands nothing over; with no answer in window_handoff_timeout_ms the rebuild goes on without one', async () => {
    vi.useFakeTimers()
    const h = new WindowHandoff()
    const asked: number[] = []
    const NEW = 7
    // answered
    let done = h.ask((reqId) => asked.push(reqId))
    expect(asked).toHaveLength(1)
    expect(h.answer(asked[0]! + 1, { drafts: [[PROJECT, draft]] }), 'another question').toBe(false)
    expect(h.answer(asked[0]!, { drafts: [[PROJECT, draft]] })).toBe(true)
    await done
    expect(h.held).toBe(1)
    expect(h.take(NEW), 'before the new window is named').toBeNull()
    h.giveTo(NEW)
    expect(h.take(NEW)).toEqual({ drafts: [[PROJECT, draft]] })
    expect(h.take(NEW), 'its preload again, before the page started').toEqual({ drafts: [[PROJECT, draft]] })
    expect(h.take(NEW + 1), 'another window').toBeNull()
    h.started(NEW + 1)
    expect(h.held, 'another window’s start lets nothing go').toBe(1)
    h.started(NEW)
    expect([h.take(NEW), h.held], 'let go once its page started (a reload later takes nothing)').toEqual([null, null])
    // an answer that does not parse
    done = h.ask((reqId) => asked.push(reqId))
    expect(h.answer(asked[1]!, { drafts: [[PROJECT, { ...draft, prompt: 3 }]] })).toBe(false)
    await done
    h.giveTo(NEW)
    expect(h.take(NEW)).toBeNull()
    // no answer: the rebuild goes on after the timeout, and a late answer is dropped
    let over = false
    done = h.ask((reqId) => asked.push(reqId)).then(() => void (over = true))
    await vi.advanceTimersByTimeAsync(L.windowHandoffTimeoutMs - 1)
    expect(over).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(over).toBe(true)
    expect(h.answer(asked[2]!, { drafts: [[PROJECT, draft]] }), 'too late').toBe(false)
    h.giveTo(NEW)
    expect(h.take(NEW)).toBeNull()
    // a window that is gone answers nothing: its send throws, and the rebuild goes on at once
    await h.ask(() => {
      throw new Error('Object has been destroyed')
    })
    h.giveTo(NEW)
    expect(h.take(NEW)).toBeNull()
  })
})
