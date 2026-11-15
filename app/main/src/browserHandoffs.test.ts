// Main's hand-offs to the browser, with fake timers and routes that are promises the test settles; the macOS route
// with the process runner replaced by a recorder (no browser starts).
import { L } from '@kea/protocol/limits'
import type { RunProcessOptions } from '@kea/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_DID_NOT_ANSWER, BROWSER_NOT_YET, BrowserHandoffs, HANDOFFS_BUSY, type Handoff } from './browserHandoffs.ts'
import { darwin } from './os/darwin.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A route the test drives: each call records its hand-off and returns a promise the test settles. */
function route() {
  const calls: { h: Handoff; settle: (m: string | null) => void }[] = []
  const run = (h: Handoff) =>
    new Promise<string | null>((resolve) => {
      calls.push({ h, settle: resolve })
    })
  return { calls, run }
}

function answers() {
  const got: (string | null)[] = []
  return { got, answer: (m: string | null) => void got.push(m) }
}

describe('browserHandoffs', () => {
  it("U-FV-43 · main's deadline: did not answer before the start, handed over after, has not answered yet after a call it cannot take back; never signals a started hand-off; a replaced page is dropped unstarted, per window, freed with it; one past the cap is refused at once; the deadlines' order", async () => {
    // the order the answers rest on: macOS's own launch bound < main's deadline < the window's
    expect(L.editorLaunchTimeoutMs).toBeLessThan(L.browserHandoffDeadlineMs)
    expect(L.browserHandoffDeadlineMs).toBeLessThan(L.browserAnswerDeadlineMs)

    const late: (string | null)[] = []
    const handoffs = new BrowserHandoffs({ deadlineMs: L.browserHandoffDeadlineMs, max: L.browserHandoffsMax, onLate: (_k, m) => void late.push(m) })
    const r = route()

    // answered in time with the route's words; the timer goes with it
    const a1 = answers()
    handoffs.start(1, 'page', r.run, a1.answer)
    r.calls[0]?.settle('No application found')
    await vi.runAllTimersAsync()
    expect(a1.got).toEqual(['No application found'])
    expect(handoffs.gauge()).toEqual({ inFlight: 0, timers: 0, slots: 0 })

    // not started by the deadline: dropped, its queue signal aborted, never answered twice, nothing logged late
    const a2 = answers()
    handoffs.start(1, 'page', r.run, a2.answer)
    vi.advanceTimersByTime(L.browserHandoffDeadlineMs)
    expect(a2.got).toEqual([BROWSER_DID_NOT_ANSWER])
    expect(r.calls[1]?.h.queueSignal.aborted).toBe(true)
    r.calls[1]?.settle('cancelled')
    await Promise.resolve()
    expect(a2.got).toHaveLength(1)
    expect(late).toEqual([])

    // started: handed over at the deadline, never signalled; what it says later is logged, not answered
    const a3 = answers()
    handoffs.start(1, 'page', r.run, a3.answer)
    r.calls[2]?.h.started()
    vi.advanceTimersByTime(L.browserHandoffDeadlineMs)
    expect(a3.got).toEqual([null])
    expect(r.calls[2]?.h.queueSignal.aborted).toBe(false)
    r.calls[2]?.settle('LSOpenURLsWithRole() failed')
    await Promise.resolve()
    expect(late).toEqual(['LSOpenURLsWithRole() failed'])

    // Electron called and never settling: has not answered yet; the route ran once (Electron is never called again)
    const a4 = answers()
    handoffs.start(2, 'page', r.run, a4.answer)
    r.calls[3]?.h.called()
    vi.advanceTimersByTime(L.browserHandoffDeadlineMs)
    expect(a4.got).toEqual([BROWSER_NOT_YET])
    expect(r.calls).toHaveLength(4)
    expect(handoffs.gauge()).toEqual({ inFlight: 0, timers: 0, slots: 0 })

    // a newer page from the same window drops the older one if it has not started; another window's is untouched
    const older = answers()
    const other = answers()
    const newer = answers()
    handoffs.start(1, 'page', r.run, older.answer)
    handoffs.start(3, 'page', r.run, other.answer)
    handoffs.start(1, 'page', r.run, newer.answer)
    expect(r.calls[4]?.h.queueSignal.aborted).toBe(true)
    expect(r.calls[5]?.h.queueSignal.aborted).toBe(false)
    expect(handoffs.gauge()).toEqual({ inFlight: 2, timers: 2, slots: 2 })
    r.calls[4]?.settle(null)
    r.calls[6]?.settle(null)
    r.calls[5]?.settle(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(older.got).toEqual([])
    expect(newer.got).toEqual([null])
    expect(other.got).toEqual([null])

    // a started page is not dropped when the window asks again: both answer
    const first = answers()
    const second = answers()
    handoffs.start(1, 'page', r.run, first.answer)
    r.calls[7]?.h.started()
    handoffs.start(1, 'page', r.run, second.answer)
    expect(r.calls[7]?.h.queueSignal.aborted).toBe(false)
    r.calls[7]?.settle(null)
    r.calls[8]?.settle('No application found')
    await Promise.resolve()
    await Promise.resolve()
    expect(first.got).toEqual([null])
    expect(second.got).toEqual(['No application found'])

    // the window goes: its unstarted page is dropped and its slot freed; no answer
    const gone = answers()
    handoffs.start(4, 'page', r.run, gone.answer)
    handoffs.forget(4)
    expect(r.calls[9]?.h.queueSignal.aborted).toBe(true)
    expect(handoffs.gauge()).toEqual({ inFlight: 0, timers: 0, slots: 0 })
    vi.advanceTimersByTime(L.browserHandoffDeadlineMs)
    expect(gone.got).toEqual([])

    // at the cap, one more is refused at once and its route never runs; each window holds one slot
    const held = Array.from({ length: L.browserHandoffsMax }, (_, i) => {
      const a = answers()
      handoffs.start(100 + i, 'page', r.run, a.answer)
      return a
    })
    const ran = r.calls.length
    const refused = answers()
    handoffs.start(999, 'page', r.run, refused.answer)
    expect(refused.got).toEqual([HANDOFFS_BUSY])
    expect(r.calls).toHaveLength(ran)
    expect(handoffs.gauge()).toEqual({ inFlight: L.browserHandoffsMax, timers: L.browserHandoffsMax, slots: L.browserHandoffsMax })
    vi.advanceTimersByTime(L.browserHandoffDeadlineMs)
    expect(held.every((a) => a.got[0] === BROWSER_DID_NOT_ANSWER)).toBe(true)
    expect(handoffs.gauge()).toEqual({ inFlight: 0, timers: 0, slots: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("U-FV-43 · macOS's open is untouched by main's deadline: it gets the hand-off's queue signal, keeps its own timeout, and its start marks the hand-off started", async () => {
    const seen: RunProcessOptions[] = []
    let started = 0
    const ctrl = new AbortController()
    const message = await darwin.browser.openPage('/work tree/site/index.html', {
      app: { getApplicationInfoForProtocol: () => Promise.resolve({ path: '/test/Browser.app' }) as never },
      shell: { openPath: () => Promise.resolve('') },
      run: (_file, _args, o) => {
        seen.push(o)
        o.onStart?.(4242)
        return Promise.resolve({ code: 0, timedOut: false, cancelled: false, stderr: '' })
      },
      queueSignal: ctrl.signal,
      called: () => undefined,
      started: () => void started++,
    })
    expect(message).toBeNull()
    expect(started).toBe(1)
    expect(seen[0]).toMatchObject({ pool: 'other', timeoutMs: L.editorLaunchTimeoutMs, queueSignal: ctrl.signal })
    expect(seen[0]?.signal).toBeUndefined()
  })
})
