// The review of the windows' unsaved files before main closes them: the queue, the acknowledgement's deadline, windows
// that miss it or go, rebuilt windows, tickets, and every way Kea goes after the review (quit, Stop All and Quit, Keep in
// Menu Bar, a restart, the automatic restart into replaced files).
import { L, NO_UPDATE_MARKS } from '@kea/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Leaving, WindowReviews, type LeavingDeps, type ReviewMessage, type Ticket } from './review.ts'
import type { UpdaterDriver, UpdaterEvents } from './updates/driver.ts'
import { UpdateManager } from './updates/manager.ts'
import { UpgradeGuard } from './updates/upgrade.ts'

const ACK = L.windowReviewAckMs

/** Every continuation that is ready has run; no time passes. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** Main's side, with windows that answer as the test says. */
function world(o: { forward?: (id: number) => Promise<number | null>; going?: () => boolean } = {}) {
  const sent: [number, ReviewMessage][] = []
  const closed = new Set<number>()
  const log: string[] = []
  let going = false
  const r = new WindowReviews({
    post: (id, m) => {
      if (closed.has(id)) return false
      sent.push([id, m])
      return true
    },
    forward: o.forward ?? ((id) => Promise.resolve(id)),
    going: o.going ?? (() => going),
    log: { info: (m) => void log.push(m), warn: (m) => void log.push(m) },
  })
  return {
    r,
    log,
    setGoing: (v: boolean) => void (going = v),
    close: (id: number) => {
      closed.add(id)
      r.closed(id)
    },
    isClosed: (id: number) => closed.has(id),
    /** What window `id` was sent, of kind `k`. */
    to: <K extends ReviewMessage['k']>(id: number, k: K) => sent.filter(([w, m]) => w === id && m.k === k).map(([, m]) => m as Extract<ReviewMessage, { k: K }>),
    /** The request window `id` was last asked. */
    req: (id: number) => sent.filter(([w, m]) => w === id && m.k === 'review').map(([, m]) => m.reqId).at(-1) ?? -1,
    count: () => sent.length,
  }
}

/** Window `id` acknowledges the request it was last asked and answers it. */
async function reply(w: ReturnType<typeof world>, id: number, answer: 'proceed' | 'cancel'): Promise<void> {
  await flush()
  w.r.ack(id, w.req(id))
  w.r.answer(id, w.req(id), answer)
}

/** A request that window `id` answers. */
async function answered(w: ReturnType<typeof world>, id: number, answer: 'proceed' | 'cancel', p: Promise<Ticket>): Promise<Ticket> {
  await reply(w, id, answer)
  return p
}

describe('the review of unsaved files', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('U-FV-29 · requests queue and never share an answer; every window whose page is up is asked, one after another; an acknowledged request waits for its answer with no deadline; a cancel ends the request and gives back what the windows before it set aside', async () => {
    const w = world()
    w.r.hello(1)
    w.r.hello(2)
    w.r.hello(3)
    w.r.closed(3)
    w.r.setUnsaved(1, 2)
    const quit = w.r.prepare('quit')
    const close = w.r.prepare('close', { only: 2 })
    await flush()
    expect(w.to(1, 'review')).toEqual([{ k: 'review', reqId: w.req(1), reason: 'quit' }])
    expect(w.to(2, 'review'), 'one window at a time').toEqual([])
    w.r.ack(1, w.req(1))
    await vi.advanceTimersByTimeAsync(ACK * 100)
    expect(w.to(2, 'review'), 'no deadline on the answer').toEqual([])
    w.r.answer(1, w.req(1), 'proceed')
    await flush()
    expect(w.to(2, 'review')).toEqual([{ k: 'review', reqId: w.req(1), reason: 'quit' }])
    w.r.ack(2, w.req(2))
    w.r.answer(2, w.req(2), 'cancel')
    const t = await quit
    expect(t.proceed).toBe(false)
    expect(w.to(1, 'closeDone'), 'the first window gets back what it set aside').toEqual([{ k: 'closeDone', reqId: w.req(1), went: false }])
    expect(w.r.mayClose(1)).toBe(false)
    // the close was asked afresh: the quit's cancel is not its answer
    await flush()
    expect(w.to(2, 'review').map((m) => m.reason)).toEqual(['quit', 'close'])
    expect(w.to(1, 'review'), 'a request for one window asks it alone').toHaveLength(1)
    expect((await answered(w, 2, 'proceed', close)).proceed).toBe(true)
    // an answer for another request, or from a window not asked, changes nothing
    const again = w.r.prepare('reload', { only: 1 })
    await flush()
    w.r.answer(2, w.req(1), 'cancel')
    w.r.answer(1, w.req(1) + 1, 'cancel')
    expect((await answered(w, 1, 'proceed', again)).proceed).toBe(true)
    expect(w.r.counts()).toEqual({ windows: 2, requests: 0, tickets: 2 })
  })

  it('U-FV-29 · with no acknowledgement in window_review_ack_ms, or the window unresponsive while asked, a window with nothing unsaved counts as proceed and one with unsaved files as cancel; it is marked until it next acknowledges; a later explicit quit goes ahead without it only when it misses that request too (a busy window and a held ⌘Q lose nothing); a late acknowledgement is told what was decided', async () => {
    const w = world()
    w.r.hello(1)
    // nothing unsaved: proceed after the deadline, not before
    const restart = w.r.prepare('restart')
    let over = false
    void restart.then(() => void (over = true))
    await flush()
    await vi.advanceTimersByTimeAsync(ACK - 1)
    expect(over).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const t0 = await restart
    expect(t0.proceed).toBe(true)
    expect(w.r.hasMissed(1)).toBe(true)
    // its late acknowledgement: told proceed (it is held: read-only until the ticket settles), and the mark goes
    w.r.ack(1, w.req(1))
    expect(w.to(1, 'decided')).toEqual([{ k: 'decided', reqId: w.req(1), outcome: 'proceed' }])
    expect(w.r.hasMissed(1)).toBe(false)
    t0.settle(false)
    expect(w.to(1, 'closeDone')).toEqual([{ k: 'closeDone', reqId: w.req(1), went: false }])
    w.r.ack(1, w.req(1))
    expect(w.to(1, 'decided').at(-1), 'after the ticket settled the request is over: it does not review').toEqual({ k: 'decided', reqId: w.req(1), outcome: 'cancel' })

    // unsaved files: a busy window misses the first quit, which stops; a held ⌘Q's next quit waits for it
    w.r.setUnsaved(1, 3)
    const q1 = w.r.prepare('quit', { explicit: true })
    await flush()
    await vi.advanceTimersByTimeAsync(ACK)
    expect((await q1).proceed).toBe(false)
    expect(w.r.hasMissed(1)).toBe(true)
    const r1 = w.req(1)
    const q2 = w.r.prepare('quit', { explicit: true })
    await flush()
    w.r.ack(1, r1)
    expect(w.to(1, 'decided').at(-1), 'late: it does not review the first').toEqual({ k: 'decided', reqId: r1, outcome: 'cancel' })
    expect(w.r.hasMissed(1)).toBe(false)
    const r2 = w.req(1)
    w.r.ack(1, r2)
    await vi.advanceTimersByTimeAsync(ACK * 10)
    w.r.answer(1, r2, 'cancel')
    expect((await q2).proceed, 'the user’s own answer').toBe(false)

    // a hung window: misses one request (marked), then an explicit quit that it misses too goes ahead without it
    const q3 = w.r.prepare('close', { only: 1 })
    await flush()
    await vi.advanceTimersByTimeAsync(ACK)
    expect((await q3).proceed).toBe(false)
    const notExplicit = w.r.prepare('restart')
    await flush()
    await vi.advanceTimersByTimeAsync(ACK)
    expect((await notExplicit).proceed, 'only an explicit quit goes ahead').toBe(false)
    const q4 = w.r.prepare('quit', { explicit: true })
    await flush()
    await vi.advanceTimersByTimeAsync(ACK)
    const t4 = await q4
    expect(t4.proceed).toBe(true)
    expect(w.r.mayClose(1)).toBe(true)
    expect(w.log).toContain('review: going ahead without a window that did not answer again: its unsaved files are lost')
    t4.settle(false)

    // unresponsive while asked: decided at once; one that had acknowledged hears now
    const u = world()
    u.r.hello(1)
    u.r.setUnsaved(1, 1)
    const a = u.r.prepare('quit')
    await flush()
    u.r.ack(1, u.req(1))
    u.r.unresponsive(1)
    expect((await a).proceed).toBe(false)
    expect(u.to(1, 'decided')).toEqual([{ k: 'decided', reqId: u.req(1), outcome: 'cancel' }])
    u.r.answer(1, u.req(1), 'proceed')
    expect(u.r.mayClose(1), 'its answer after the decision is not taken').toBe(false)
    const b = u.r.prepare('quit', { explicit: true })
    await flush()
    u.r.unresponsive(1)
    expect((await b).proceed, 'marked, and unresponsive again for an explicit quit').toBe(true)
    u.r.setUnsaved(2, 0)
    u.r.hello(2)
    const c = u.r.prepare('close', { only: 2 })
    await flush()
    u.r.unresponsive(2)
    expect((await c).proceed, 'nothing unsaved').toBe(true)
  })

  it('U-FV-29 · a window closed, or whose page went away, while asked counts as proceed; one rebuilt in its place passes the request on, and the new window’s deadline starts once it has taken the documents; its count is the number handed over until it reports', async () => {
    const w = world()
    w.r.hello(1)
    w.r.setUnsaved(1, 1)
    const p = w.r.prepare('quit')
    await flush()
    const req = w.req(1)
    w.r.ack(1, req)
    await vi.advanceTimersByTimeAsync(ACK * 3)
    // rebuilt on Wayland while the user reviews: window 2 took two documents, then window 1 goes
    w.r.replaced(1, 2, 2)
    w.close(1)
    expect(w.r.unsaved(2)).toBe(2)
    expect(w.to(2, 'review')).toEqual([{ k: 'review', reqId: req, reason: 'quit' }])
    await vi.advanceTimersByTimeAsync(ACK - 1)
    w.r.ack(2, req)
    await vi.advanceTimersByTimeAsync(ACK * 3)
    w.r.answer(2, req, 'proceed')
    const t = await p
    expect(t.proceed).toBe(true)
    expect(w.r.mayClose(2)).toBe(true)
    w.r.setUnsaved(2, 1)
    expect(w.r.unsaved(2), 'its own report from then on').toBe(1)

    // closed while asked, or its renderer gone: proceed for it (its unsaved text went with it)
    for (const how of ['closed', 'gone'] as const) {
      const g = world()
      g.r.hello(1)
      g.r.setUnsaved(1, 4)
      const q = g.r.prepare('quit')
      await flush()
      if (how === 'closed') g.close(1)
      else g.r.gone(1)
      expect((await q).proceed, how).toBe(true)
      expect([g.r.unsaved(1), g.r.mayClose(1)]).toEqual([0, false])
      expect(g.to(1, 'closeDone')).toEqual([])
    }
    // a window that cannot be sent to counts as gone
    const s = world()
    s.r.hello(1)
    s.close(1)
    s.r.hello(1)
    expect((await s.r.prepare('quit')).proceed).toBe(true)
  })

  it('U-FV-29 · a window with unsaved files is brought forward before it is asked: a minimized Wayland window is rebuilt first and the new window is asked, its deadline starting then; a rebuild abandoned cancels a request that is not explicit and asks no other window', async () => {
    let finish: (made: number | null) => void = () => undefined
    const forward = vi.fn((_id: number) => new Promise<number | null>((resolve) => (finish = resolve)))
    const w = world({ forward: (id) => forward(id) })
    w.r.hello(1)
    w.r.hello(3)
    w.r.setUnsaved(1, 2)
    const p = w.r.prepare('quit')
    await flush()
    expect(forward.mock.calls).toEqual([[1]])
    await vi.advanceTimersByTimeAsync(ACK * 5)
    // the rebuild: window 9 took the documents, window 1 went
    w.r.replaced(1, 9, 2)
    w.close(1)
    finish(9)
    await flush()
    expect(w.to(1, 'review'), 'the old window is never asked').toEqual([])
    expect(w.to(9, 'review')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(ACK - 1)
    w.r.ack(9, w.req(9))
    w.r.answer(9, w.req(9), 'proceed')
    await flush()
    expect(forward.mock.calls, 'a window with nothing unsaved is not brought forward').toEqual([[1]])
    w.r.ack(3, w.req(3))
    w.r.answer(3, w.req(3), 'proceed')
    expect((await p).proceed).toBe(true)

    const a = world({ forward: () => Promise.resolve(null) })
    a.r.hello(1)
    a.r.hello(2)
    a.r.setUnsaved(1, 1)
    expect((await a.r.prepare('quit')).proceed).toBe(false)
    expect([a.to(1, 'review'), a.to(2, 'review')]).toEqual([[], []])
  })

  it('U-FV-29 · a window with unsaved files that cannot be brought forward (its rebuild failed, or the window made in its place did not take the documents in window_rebuild_take_ms) counts as a window that missed its answer: it is marked and the request cancelled, and an explicit quit (the tray’s Quit Kea Completely) or the close of the marked window then goes ahead without it when it cannot be shown again; a request that is not explicit (a restart, SIGTERM) never does', async () => {
    const forward = vi.fn((_id: number): Promise<number | null> => Promise.resolve(null))
    const w = world({ forward: (id) => forward(id) })
    const l = leavingWorld({ review: (reason, o) => w.r.prepare(reason, o) })
    w.r.hello(1)
    w.r.hello(2)
    w.r.setUnsaved(1, 2)
    // Quit Kea Completely: the window is marked, nothing is closed and no other window is asked
    await l.leaving.quit()
    expect(forward.mock.calls).toEqual([[1]])
    expect([l.calls, w.r.hasMissed(1), w.r.canAsk(1)]).toEqual([[], true, false])
    expect([w.to(1, 'review'), w.to(2, 'review')]).toEqual([[], []])
    expect(w.log).toContain('review: a window with unsaved files did not answer, so nothing is closed')
    // a restart and SIGTERM are not the user's own: never past it
    expect((await w.r.prepare('restart')).proceed).toBe(false)
    l.leaving.terminate()
    await flush()
    expect([l.calls, w.r.unsaved(1)]).toEqual([[], 2])
    // Quit Kea Completely again: without it, the other windows asked
    const again = l.leaving.quit()
    await reply(w, 2, 'proceed')
    await again
    expect(l.calls).toEqual(['quit', 'shut down'])
    expect(w.log).toContain('review: going ahead without a window that did not answer again: its unsaved files are lost')
    expect(w.r.mayClose(1), 'held by the quit: closed without another review').toBe(true)

    // a forward that fails outright counts the same
    const thrown = world({ forward: () => Promise.reject(new Error('Object has been destroyed')) })
    thrown.r.hello(1)
    thrown.r.setUnsaved(1, 1)
    expect((await thrown.r.prepare('quit', { explicit: true })).proceed).toBe(false)
    expect(thrown.r.hasMissed(1)).toBe(true)

    // the window's own × (GNOME's overview on the minimized window): kept open and marked, then closed by the next ×
    const c = world({ forward: () => Promise.resolve(null) })
    const cc = closer(c)
    c.r.hello(1)
    c.r.setUnsaved(1, 1)
    expect(c.r.close(1, cc.again)).toBe(false)
    await flush()
    expect([cc.closed, c.r.hasMissed(1)]).toEqual([[], true])
    expect(c.r.close(1, cc.again)).toBe(false)
    await flush()
    expect(cc.closed).toEqual([1])
    expect(c.r.counts()).toEqual({ windows: 0, requests: 0, tickets: 0 })

    // a window that acknowledges a request afterwards is unmarked, and a window whose files went meanwhile proceeds
    const r = world({ forward: () => Promise.resolve(null) })
    r.r.hello(1)
    r.r.setUnsaved(1, 1)
    expect((await r.r.prepare('quit', { explicit: true })).proceed).toBe(false)
    r.r.ack(1, 1)
    expect(r.r.hasMissed(1)).toBe(false)
    expect((await r.r.prepare('quit', { explicit: true })).proceed, 'unmarked: cancelled again').toBe(false)
    const late = world({ forward: () => (late.r.setUnsaved(1, 0), Promise.resolve(null)) })
    late.r.hello(1)
    late.r.setUnsaved(1, 1)
    expect((await late.r.prepare('restart')).proceed, 'nothing unsaved by the time it could not be shown').toBe(true)
  })

  it('U-FV-29 · a request that fails part way (a window that cannot be sent its request) closes nothing and settles its ticket: the windows that answered proceed before it get back what they set aside, none stays held, and no deadline is left running', async () => {
    const sent: [number, ReviewMessage][] = []
    const log: string[] = []
    const r = new WindowReviews({
      post: (id, m) => {
        if (id === 2 && m.k === 'review') throw new Error('Object has been destroyed')
        sent.push([id, m])
        return true
      },
      forward: (id) => Promise.resolve(id),
      going: () => false,
      log: { info: (m) => void log.push(m), warn: (m) => void log.push(m) },
    })
    r.hello(1)
    r.hello(2)
    const p = r.prepare('quit', { explicit: true })
    await flush()
    r.ack(1, 1)
    r.answer(1, 1, 'proceed')
    const t = await p
    expect(t.proceed).toBe(false)
    expect(log).toContain('review failed: nothing is closed')
    expect([r.counts(), r.mayClose(1)]).toEqual([{ windows: 2, requests: 0, tickets: 0 }, false])
    expect(sent.filter(([id, m]) => id === 1 && m.k === 'closeDone')).toEqual([[1, { k: 'closeDone', reqId: 1, went: false }]])
    expect(vi.getTimerCount(), 'no deadline left running').toBe(0)
    r.unresponsive(2)
    expect(r.hasMissed(2), 'nothing is out to it').toBe(false)
  })

  it('U-FV-29 · overlapping tickets: a window stays held until its last ticket settles, each ticket tells it once with its own request, and a settled ticket tells nothing more; once Kea is going, requests (those queued too) answer proceed without asking and tickets tell nothing', async () => {
    const w = world()
    w.r.hello(1)
    const restart = await answered(w, 1, 'proceed', w.r.prepare('restart'))
    const r1 = w.req(1)
    const close = await answered(w, 1, 'proceed', w.r.prepare('close', { only: 1 }))
    const r2 = w.req(1)
    expect(w.r.counts().tickets).toBe(2)
    restart.settle(false)
    expect(w.to(1, 'closeDone')).toEqual([{ k: 'closeDone', reqId: r1, went: false }])
    expect(w.r.mayClose(1), 'still held by the close').toBe(true)
    close.settle(false)
    close.settle(true)
    restart.settle(true)
    expect(w.to(1, 'closeDone')).toEqual([
      { k: 'closeDone', reqId: r1, went: false },
      { k: 'closeDone', reqId: r2, went: false },
    ])
    expect(w.r.mayClose(1)).toBe(false)
    expect(w.r.counts().tickets).toBe(0)

    // a request under way, another queued; Kea starts going: the queued one asks nothing
    const first = w.r.prepare('quit')
    const queued = w.r.prepare('close', { only: 1 })
    await flush()
    const asked = w.to(1, 'review').length
    w.setGoing(true)
    const t1 = await answered(w, 1, 'proceed', first)
    const t2 = await queued
    expect([t1.proceed, t2.proceed]).toEqual([true, true])
    expect(w.to(1, 'review'), 'the queued request asked nothing').toHaveLength(asked)
    const sent = w.count()
    t1.settle(true)
    t2.settle(false)
    expect((await w.r.prepare('reload', { only: 1 })).proceed).toBe(true)
    expect(w.count(), 'nothing told while Kea is going').toBe(sent)
  })

  it('U-FV-29 · a window’s close is held while it reviews its unsaved files and made again on proceed, on the window the user answered in: a minimized Wayland window rebuilt to be asked closes in the window made in its place; a close while its review is out asks nothing more; Cancel keeps it open; each ticket settles once', async () => {
    let finish: (made: number | null) => void = () => undefined
    const w = world({ forward: (id) => (id === 1 ? new Promise<number | null>((resolve) => (finish = resolve)) : Promise.resolve(id)) })
    const c = closer(w)
    w.r.hello(1)
    w.r.setUnsaved(1, 2)
    expect(w.r.close(1, c.again), 'held for its review').toBe(false)
    expect(w.r.close(1, c.again), 'its close button again while it reviews').toBe(false)
    await flush()
    // rebuilt to be asked (GNOME's overview: × on a minimized window): window 9 took the documents, window 1 went
    w.r.replaced(1, 9, 2)
    w.close(1)
    finish(9)
    await flush()
    expect(w.r.counts().requests, 'one review for both clicks').toBe(1)
    await reply(w, 9, 'proceed')
    await flush()
    expect(c.closed, 'the window the user answered in closes').toEqual([9])
    expect(w.to(9, 'closeDone'), 'gone with its window: nothing to tell').toEqual([])
    expect(w.r.counts()).toEqual({ windows: 0, requests: 0, tickets: 0 })

    // Cancel keeps the window open, and gives back what it set aside; the next click asks again
    const k = world()
    const kc = closer(k)
    k.r.hello(1)
    k.r.setUnsaved(1, 1)
    expect(k.r.close(1, kc.again)).toBe(false)
    await reply(k, 1, 'cancel')
    await flush()
    expect(kc.closed).toEqual([])
    expect(k.r.close(1, kc.again)).toBe(false)
    await reply(k, 1, 'proceed')
    await flush()
    expect(kc.closed).toEqual([1])
    expect(k.to(1, 'review').map((m) => m.reason)).toEqual(['close', 'close'])
    expect(k.r.counts()).toEqual({ windows: 0, requests: 0, tickets: 0 })

    // a window that closed while its review was out: nothing to close again, and its ticket settles
    const g = world()
    const gc = closer(g)
    g.r.hello(1)
    g.r.hello(2)
    g.r.setUnsaved(1, 1)
    g.r.close(1, gc.again)
    await flush()
    g.close(1)
    await flush()
    expect(gc.closed).toEqual([])
    expect(g.r.counts()).toEqual({ windows: 1, requests: 0, tickets: 0 })
  })

  it('U-FV-29 · a window that answered proceed for the action under way (Keep in Menu Bar, Squirrel’s install, the last window’s quit), and every window once Kea is going, closes at once; a window marked as having missed a request closes as an explicit quit goes, without it when it misses this request too; an unmarked one with unsaved files that misses it stays open', async () => {
    const p = world()
    const pc = closer(p)
    p.r.hello(1)
    p.r.hello(2)
    const menuBar = p.r.prepare('menuBar')
    await reply(p, 1, 'proceed')
    await reply(p, 2, 'proceed')
    const t = await menuBar
    expect([p.r.close(1, pc.again), p.r.close(2, pc.again)], 'answered proceed: closed unasked').toEqual([true, true])
    t.settle(true)
    expect(p.to(1, 'review'), 'no second review').toHaveLength(1)
    p.setGoing(true)
    p.r.hello(3)
    p.r.setUnsaved(3, 1)
    expect(p.r.close(3, pc.again), 'Kea is going').toBe(true)

    // marked: it missed a quit's acknowledgement; its close goes ahead when it misses that request too
    const m = world()
    const mc = closer(m)
    m.r.hello(1)
    m.r.setUnsaved(1, 3)
    const q = m.r.prepare('quit')
    await flush()
    await vi.advanceTimersByTimeAsync(ACK)
    expect((await q).proceed).toBe(false)
    expect(m.r.close(1, mc.again)).toBe(false)
    await flush()
    await vi.advanceTimersByTimeAsync(ACK)
    await flush()
    expect(mc.closed).toEqual([1])
    expect(m.log).toContain('review: going ahead without a window that did not answer again: its unsaved files are lost')

    // unmarked: its close does not go past it
    const u = world()
    const uc = closer(u)
    u.r.hello(1)
    u.r.setUnsaved(1, 3)
    expect(u.r.close(1, uc.again)).toBe(false)
    await flush()
    await vi.advanceTimersByTimeAsync(ACK * 3)
    await flush()
    expect(uc.closed).toEqual([])
    expect(u.r.hasMissed(1)).toBe(true)
  })

  it('U-FV-29 · Electron reports a window unresponsive: a request out to it is decided without it, and main ends its renderer only when it holds nothing unsaved (one with unsaved files is left to recover); the first-quit sheet is not sent to a window whose page is not up or that missed a request, until it acknowledges one', async () => {
    const w = world()
    w.r.hello(1)
    w.r.setUnsaved(1, 2)
    expect(w.r.canAsk(1)).toBe(true)
    const q = w.r.prepare('quit')
    await flush()
    expect(w.r.unresponsive(1), 'unsaved files: left to recover').toBe(false)
    expect((await q).proceed, 'decided without it').toBe(false)
    expect(w.r.canAsk(1), 'marked: no sheet').toBe(false)
    w.r.setUnsaved(1, 0)
    expect(w.r.unresponsive(1), 'nothing unsaved: its renderer is ended').toBe(true)
    w.r.ack(1, w.req(1))
    expect(w.r.canAsk(1), 'it acknowledged').toBe(true)
    expect(w.r.canAsk(2), 'a window whose page is not up').toBe(false)
    w.r.gone(1)
    expect(w.r.canAsk(1), 'its page went away').toBe(false)
  })

  it('U-FV-29 · Reload Window reviews its window first and reloads it on proceed; its ticket settles once, went only when it reloaded (not on Cancel, nor when the window went meanwhile)', async () => {
    const w = world()
    w.r.hello(1)
    const reloaded: number[] = []
    const reload = (id: number): boolean => {
      if (w.isClosed(id)) return false
      reloaded.push(id)
      return true
    }
    const ok = w.r.reload(1, reload)
    await reply(w, 1, 'proceed')
    await ok
    expect(reloaded).toEqual([1])
    expect(w.to(1, 'closeDone')).toEqual([{ k: 'closeDone', reqId: w.req(1), went: true }])
    const no = w.r.reload(1, reload)
    await reply(w, 1, 'cancel')
    await no
    expect(reloaded).toEqual([1])
    const gone = w.r.reload(1, reload)
    await reply(w, 1, 'proceed')
    w.close(1)
    await gone
    expect(reloaded).toEqual([1])
    expect(w.to(1, 'closeDone'), 'one per ticket').toHaveLength(1)
    expect(w.r.counts().tickets).toBe(0)
  })
})

/** Main's close handler for the world's windows: a close made again runs Electron's `close` once more, then closes the window. */
function closer(w: ReturnType<typeof world>) {
  const closed: number[] = []
  const again = (id: number): boolean => {
    if (w.isClosed(id)) return false
    if (!w.r.close(id, again)) throw new Error(`the close of window ${id} was held again`)
    closed.push(id)
    w.close(id)
    return true
  }
  return { again, closed }
}

/** Leaving's world: a review that answers as the test says, and main's actions recorded. */
function leavingWorld(o: Partial<LeavingDeps> & { answers?: boolean[] } = {}) {
  const calls: string[] = []
  const tickets: { reason: string; settled: boolean[] }[] = []
  const answers = [...(o.answers ?? [])]
  let leaving: Leaving
  const deps: LeavingDeps = {
    review: (reason) => {
      calls.push(`review ${reason}`)
      const t = { reason, settled: [] as boolean[] }
      tickets.push(t)
      return Promise.resolve({ proceed: answers.length ? (answers.shift() as boolean) : true, settle: (went: boolean) => void t.settled.push(went) })
    },
    // Electron's `app.quit()`: `before-quit` runs at once
    quit: () => {
      calls.push('quit')
      if (leaving.beforeQuit()) calls.push('shut down')
    },
    relaunch: (target) => void calls.push(`relaunch ${target}`),
    stopAll: () => (calls.push('stop all'), Promise.resolve()),
    keepDrafts: () => (calls.push('drafts'), Promise.resolve()),
    enterMenuBar: () => void calls.push('menu bar'),
    running: () => 0,
    recordRelaunch: null,
    log: { info: () => undefined, warn: () => undefined },
    ...o,
  }
  leaving = new Leaving(deps)
  const flags = () => ({ quitting: leaving.quitting, relaunching: leaving.relaunching, stoppingAll: leaving.stoppingAll })
  return { leaving, calls, tickets, flags }
}

describe('how Kea goes after the review', () => {
  it('U-FV-29 · after a cancel nothing is set and nothing is done; on proceed a quit is made once and shuts down; a quit that reached before-quit unasked is held for the review and made again; every ticket settles once, went only when Kea went', async () => {
    for (const run of ['quit', 'menuBar', 'stopAll', 'beforeQuit', 'relaunch'] as const) {
      const w = leavingWorld({ answers: [false] })
      if (run === 'quit') await w.leaving.quit()
      else if (run === 'beforeQuit') {
        expect(w.leaving.beforeQuit(), 'held').toBe(false)
        await flush()
      } else if (run === 'relaunch') await w.leaving.relaunch('1.0.3')
      else await w.leaving.choose(run)
      expect(w.flags(), run).toEqual({ quitting: false, relaunching: false, stoppingAll: false })
      expect(w.calls, run).toEqual([`review ${run === 'menuBar' ? 'menuBar' : run === 'relaunch' ? 'restart' : 'quit'}`])
      expect(w.tickets.map((t) => t.settled), run).toEqual([[false]])
    }
    const q = leavingWorld()
    expect(q.leaving.beforeQuit()).toBe(false)
    await flush()
    expect(q.calls).toEqual(['review quit', 'quit', 'shut down'])
    expect(q.tickets.map((t) => t.settled)).toEqual([[true]])
    expect(q.leaving.beforeQuit(), 'Kea is going: no second review').toBe(true)

    const m = leavingWorld()
    await m.leaving.choose('menuBar')
    expect(m.calls).toEqual(['review menuBar', 'menu bar'])
    expect([m.flags(), m.tickets.map((t) => t.settled)]).toEqual([{ quitting: false, relaunching: false, stoppingAll: false }, [[true]]])

    // Stop All and Quit takes its caller's review; a second request while it waits quits at once, the first then not again
    let stopped: () => void = () => undefined
    const s = leavingWorld({ running: () => 2, stopAll: () => (s.calls.push('stop all'), new Promise((resolve) => (stopped = resolve))) })
    const first = s.leaving.quit()
    await flush()
    expect(s.calls).toEqual(['review quit', 'stop all'])
    expect(s.flags().stoppingAll).toBe(true)
    await s.leaving.stopAllAndQuit()
    expect(s.calls).toEqual(['review quit', 'stop all', 'review quit', 'quit', 'shut down'])
    stopped()
    await first
    expect(s.calls.filter((c) => c === 'quit')).toHaveLength(1)
    expect(s.tickets.map((t) => t.settled)).toEqual([[true], [true]])
  })

  it('U-FV-29 · Restart Kea reviews once and keeps the drafts once; a review that says no arms nothing; the early returns (Kea gone meanwhile, nothing ready to install, a test build’s restart) settle their ticket with went false and leave nothing set', async () => {
    const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined }
    const manager = (w: ReturnType<typeof leavingWorld>, o: { install?: () => boolean } = {}) => {
      let on: UpdaterEvents | null = null
      const events = (): UpdaterEvents => on as unknown as UpdaterEvents
      const driver: UpdaterDriver = { check: () => undefined, download: () => undefined, install: o.install ?? (() => true), dispose: () => undefined }
      const m = new UpdateManager({
        version: '1.0.2',
        how: { mode: o.install ? 'updater' : 'command', auto: false, command: null, why: null },
        autoAllowed: false,
        clock,
        marks: { load: () => NO_UPDATE_MARKS, save: () => undefined },
        feed: () => Promise.resolve(null),
        makeDriver: o.install ? (events) => w.leaving.updater((e) => ((on = e), driver), events) : null,
        changed: () => undefined,
        beforeRestart: () => w.leaving.beforeRestart(),
        afterRestart: (started) => w.leaving.afterRestart(started),
        relaunch: () => void w.leaving.relaunch('1.0.3', { reviewed: true }),
        log: { info: () => undefined, warn: () => undefined },
      })
      if (o.install) {
        m.checkNow()
        events().available('1.0.3')
        events().ready('1.0.3')
      } else m.upgraded('1.0.3')
      return m
    }

    // Restart Kea: one review, the drafts once, the restart made
    const k = leavingWorld()
    manager(k).restart()
    await flush()
    expect(k.calls).toEqual(['review restart', 'drafts', 'relaunch 1.0.3'])
    expect([k.tickets.map((t) => t.settled), k.flags().relaunching]).toEqual([[[true]], true])

    // the review says no: nothing armed, nothing set
    const no = leavingWorld({ answers: [false] })
    const nm = manager(no)
    nm.restart()
    await flush()
    no.leaving.afterRestart(true)
    expect(no.calls).toEqual(['review restart'])
    expect([no.tickets.map((t) => t.settled), no.flags()]).toEqual([[[false]], { quitting: false, relaunching: false, stoppingAll: false }])

    // Restart to Update with nothing ready to install
    const notReady = leavingWorld()
    manager(notReady, { install: () => false }).restart()
    await flush()
    expect([notReady.tickets.map((t) => t.settled), notReady.flags().relaunching]).toEqual([[[false]], false])
    // ready: Kea is going while Squirrel quits it
    const ready = leavingWorld()
    manager(ready, { install: () => true }).restart()
    await flush()
    expect([ready.tickets.map((t) => t.settled), ready.flags().relaunching]).toEqual([[[true]], true])

    // Kea gone while the drafts were kept: nothing done
    let kept: () => void = () => undefined
    const late = leavingWorld({ keepDrafts: () => new Promise((resolve) => (kept = resolve)) })
    const lm = manager(late)
    lm.restart()
    await flush()
    lm.dispose()
    kept()
    await flush()
    expect(late.calls).toEqual(['review restart'])
    expect(late.tickets.map((t) => t.settled)).toEqual([[false]])

    // a test build records the restart instead: the ticket settles went false and nothing stays set
    const recorded: string[] = []
    const perf = leavingWorld({ recordRelaunch: (t) => void recorded.push(t) })
    await perf.leaving.relaunch('1.0.4')
    expect([recorded, perf.calls, perf.tickets.map((t) => t.settled), perf.flags().relaunching]).toEqual([['1.0.4'], ['review restart', 'drafts'], [[false]], false])

    // a restart while Kea quits: the reviewed ticket settles, nothing else
    const quitting = leavingWorld()
    await quitting.leaving.quit()
    await quitting.leaving.beforeRestart()
    await quitting.leaving.relaunch('1.0.5', { reviewed: true })
    expect(quitting.tickets.map((t) => t.settled)).toEqual([[true], [false]])
  })

  it('U-FV-29 · a window that answered proceed is closed by the action without a second review (Keep in Menu Bar closing every window), while a close of another window during a review is reviewed and waits its turn', async () => {
    vi.useFakeTimers()
    try {
      const w = world()
      const closes: number[] = []
      const l = leavingWorld({
        review: (reason, o) => w.r.prepare(reason, o),
        // main's `enterMenuBar`: every window closes; one that did not answer proceed would be reviewed first
        enterMenuBar: () => {
          for (const id of [1, 2]) if (!w.r.mayClose(id)) closes.push(id)
        },
      })
      w.r.hello(1)
      w.r.hello(2)
      const menuBar = l.leaving.choose('menuBar')
      await reply(w, 1, 'proceed')
      // window 2's close button while window 1's answer is in: it has not answered proceed, so it is reviewed, after
      expect(w.r.mayClose(2)).toBe(false)
      const close2 = w.r.prepare('close', { only: 2, explicit: w.r.hasMissed(2) })
      await reply(w, 2, 'proceed')
      await menuBar
      expect(closes, 'Keep in Menu Bar’s closes ask nothing').toEqual([])
      expect(w.to(2, 'review').map((m) => m.reason)).toEqual(['menuBar', 'close'])
      await answered(w, 2, 'proceed', close2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('U-FV-29 · Kea does not restart by itself into files that replaced it while a window has unsaved files (Restart Kea is offered and reviews them); with none it restarts', () => {
    const w = world()
    w.r.hello(1)
    const relaunched: string[] = []
    const guard = () =>
      new UpgradeGuard({
        running: '1.0.2',
        relaunchedFor: null,
        identity: () => '1:100',
        treeVersion: () => '1.0.3',
        upgraded: () => undefined,
        removed: () => undefined,
        relaunch: (t) => void relaunched.push(t),
        unsaved: () => w.r.anyUnsaved(),
        log: { info: () => undefined, warn: () => undefined },
      })
    w.r.setUnsaved(1, 1)
    guard().respawnRefused()
    expect(relaunched).toEqual([])
    w.r.setUnsaved(1, 0)
    guard().respawnRefused()
    expect(relaunched).toEqual(['1.0.3'])
  })

  it('U-FV-29 · a quit made by a signal (SIGTERM: an install replacing Kea, a service manager; SIGINT and SIGHUP: ⌃C in, or the close of, the terminal Kea was started from) is reviewed as any quit but is not the user’s own: a window that misses its request is never quit past, while Dock › Quit, reaching before-quit unasked, goes ahead without a marked window that misses it too', async () => {
    const explicit: (boolean | undefined)[] = []
    const signals = new Map<string, () => void>()
    const o = leavingWorld({ review: (_reason, opts) => (explicit.push(opts?.explicit), Promise.resolve({ proceed: false, settle: () => undefined })) })
    o.leaving.listen((signal, handler) => void signals.set(signal, handler))
    expect([...signals.keys()], 'each one main handles itself').toEqual(['SIGTERM', 'SIGINT', 'SIGHUP'])
    for (const handler of signals.values()) {
      handler()
      await flush()
    }
    expect(o.leaving.beforeQuit()).toBe(false)
    await flush()
    expect(explicit, 'SIGTERM, SIGINT and SIGHUP, then Dock › Quit').toEqual([false, false, false, true])

    vi.useFakeTimers()
    try {
      const w = world()
      const l = leavingWorld({ review: (reason, opts) => w.r.prepare(reason, opts) })
      const signal = new Map<string, () => void>()
      l.leaving.listen((s, handler) => void signal.set(s, handler))
      w.r.hello(1)
      w.r.setUnsaved(1, 2)
      // a hung window: it missed a request already
      const first = w.r.prepare('close', { only: 1 })
      await flush()
      await vi.advanceTimersByTimeAsync(ACK)
      expect((await first).proceed).toBe(false)
      for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        signal.get(s)?.()
        await flush()
        await vi.advanceTimersByTimeAsync(ACK)
        await flush()
        expect(l.calls, `${s}: its unsaved files are not quit past`).toEqual([])
      }
      expect([w.r.hasMissed(1), w.r.unsaved(1)]).toEqual([true, 2])
      expect(l.leaving.beforeQuit()).toBe(false)
      await flush()
      await vi.advanceTimersByTimeAsync(ACK)
      await flush()
      expect(l.calls, 'Dock › Quit: the user’s own').toEqual(['quit', 'shut down'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('U-FV-29 · Squirrel accepting Restart to Update makes Kea going until it quits Kea; when it reports instead that the install failed, Kea is going no more and the failure is passed on: a window opened after that is reviewed on its close, and a quit asks again; a failure while nothing installs changes nothing', async () => {
    let leaving: Leaving | null = null
    const w = world({ going: () => leaving?.going ?? false })
    const l = leavingWorld({ review: (reason, o) => w.r.prepare(reason, o) })
    leaving = l.leaving
    const failures: string[] = []
    const events: UpdaterEvents = { checking: () => undefined, current: () => undefined, available: () => undefined, progress: () => undefined, ready: () => undefined, failed: (reason) => void failures.push(reason), inactive: () => undefined }
    let on: UpdaterEvents | null = null
    const driver = l.leaving.updater((e) => ((on = e), { check: () => undefined, download: () => undefined, install: () => true, dispose: () => undefined }), events)
    const squirrel = (): UpdaterEvents => on as unknown as UpdaterEvents
    squirrel().failed('net::ERR_INTERNET_DISCONNECTED', 'check')
    expect(driver.install()).toBe(true)
    expect(l.flags().relaunching, 'going while Squirrel quits Kea').toBe(true)
    // Squirrel closed every window first; Kea opened again from the Dock: while it is going, a close asks nothing
    w.r.hello(2)
    w.r.setUnsaved(2, 1)
    expect((await w.r.prepare('close', { only: 2 })).proceed).toBe(true)
    expect(w.to(2, 'review')).toEqual([])
    squirrel().failed('ShipIt could not be launched', 'squirrel')
    expect(failures, 'passed on, so About says why').toEqual(['net::ERR_INTERNET_DISCONNECTED', 'ShipIt could not be launched'])
    expect(l.flags()).toEqual({ quitting: false, relaunching: false, stoppingAll: false })
    expect((await answered(w, 2, 'cancel', w.r.prepare('close', { only: 2 }))).proceed, 'its close is reviewed').toBe(false)
    const quit = l.leaving.quit()
    await reply(w, 2, 'cancel')
    await quit
    expect(w.to(2, 'review').map((m) => m.reason)).toEqual(['close', 'quit'])
    expect(l.calls).toEqual([])
  })

  it('U-FV-29 · a failure Squirrel reports before its install call returns (ShipIt not started) is not lost: Kea is not going, the install counts as not started, so the windows’ review settles went false and gives back what they set aside, and a close or a quit reviews again', async () => {
    vi.useFakeTimers()
    try {
      let leaving: Leaving | null = null
      const w = world({ going: () => leaving?.going ?? false })
      const l = leavingWorld({ review: (reason, o) => w.r.prepare(reason, o) })
      leaving = l.leaving
      let on: UpdaterEvents | null = null
      const squirrel = (): UpdaterEvents => on as unknown as UpdaterEvents
      const install = vi.fn(() => {
        squirrel().failed('ShipIt could not be launched', 'squirrel')
        return true
      })
      const failures: string[] = []
      const m = new UpdateManager({
        version: '1.0.2',
        how: { mode: 'updater', auto: false, command: null, why: null },
        autoAllowed: false,
        clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined },
        marks: { load: () => NO_UPDATE_MARKS, save: () => undefined },
        feed: () => Promise.resolve(null),
        makeDriver: (events) => l.leaving.updater((e) => ((on = e), { check: () => undefined, download: () => undefined, install, dispose: () => undefined }), { ...events, failed: (reason, step) => (failures.push(reason), events.failed(reason, step)) }),
        changed: () => undefined,
        beforeRestart: () => l.leaving.beforeRestart(),
        afterRestart: (started) => l.leaving.afterRestart(started),
        relaunch: () => undefined,
        log: { info: () => undefined, warn: () => undefined },
      })
      m.checkNow()
      squirrel().available('1.0.3')
      squirrel().ready('1.0.3')
      w.r.hello(1)
      w.r.setUnsaved(1, 1)
      m.restart()
      await reply(w, 1, 'proceed')
      await flush()
      expect(install).toHaveBeenCalledTimes(1)
      expect(failures, 'passed on, so About says why').toEqual(['ShipIt could not be launched'])
      expect(l.flags()).toEqual({ quitting: false, relaunching: false, stoppingAll: false })
      expect(w.to(1, 'closeDone'), 'the restart did not happen').toEqual([{ k: 'closeDone', reqId: w.req(1), went: false }])
      expect(w.r.mayClose(1)).toBe(false)
      expect((await answered(w, 1, 'cancel', w.r.prepare('close', { only: 1 }))).proceed, 'its close is reviewed').toBe(false)
      const quit = l.leaving.quit()
      await reply(w, 1, 'cancel')
      await quit
      expect(w.to(1, 'review').map((x) => x.reason)).toEqual(['restart', 'close', 'quit'])
      expect(l.calls, 'the drafts kept for the restart; no quit').toEqual(['drafts'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('U-FV-29 · the same quit asked again while one waits its turn joins it (a held ⌘Q, Dock › Quit or SIGTERM again): after a Cancel the review runs once more, not once per press; one asked while the first is asking waits as a request of its own, and another kind of quit is not joined', async () => {
    const w = world()
    const l = leavingWorld({ review: (reason, o) => w.r.prepare(reason, o) })
    w.r.hello(1)
    w.r.setUnsaved(1, 1)
    const presses = { dockQuit: () => void l.leaving.beforeQuit(), sigterm: () => l.leaving.terminate(), commandQ: () => void l.leaving.choose('quit'), quitCompletely: () => void l.leaving.quit() }
    for (const [name, press] of Object.entries(presses)) {
      press()
      await flush()
      expect(w.r.counts().requests, `${name}: asking`).toBe(1)
      press()
      press()
      press()
      await flush()
      expect(w.r.counts().requests, `${name}: one more waits`).toBe(2)
      await reply(w, 1, 'cancel')
      await flush()
      expect(w.r.counts().requests, `${name}: the second asks`).toBe(1)
      await reply(w, 1, 'cancel')
      await flush()
      expect(w.r.counts().requests, name).toBe(0)
    }
    expect(w.to(1, 'review')).toHaveLength(8)
    // Dock › Quit waiting does not take in a SIGTERM
    presses.dockQuit()
    await flush()
    presses.dockQuit()
    presses.sigterm()
    await flush()
    expect(w.r.counts().requests).toBe(3)
    for (let i = 0; i < 3; i++) await reply(w, 1, 'cancel')
    await flush()
    expect([w.r.counts().requests, l.calls]).toEqual([0, []])
  })
})
