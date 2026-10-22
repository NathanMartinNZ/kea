// Notifications under volume: core's notification policy and main's notifier in-process, joined as core.ts and
// main.ts join them (the policy's ops are what main applies), main showing through its recorder (no test posts a real
// notification). Both clocks are the test's: fake timers, and a monotonic clock that moves with them.

import { CONDITIONS_STORE, KeyedStore, L, type AccountCondition, type NotificationOp, type SessionView } from '@kea/protocol'
import { NotificationPolicy } from '@kea/core/src/status/policy.ts'
import type { StatusNotice } from '@kea/core/src/status/notices.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notifier, RecordingSurfaces } from '../../app/main/src/notifier.ts'

afterEach(() => vi.useRealTimers())

const POSTS = 1_000
const SESSIONS = 20
/** One live notification per session, plus the burst's: one per tag. */
const CAP = SESSIONS + 1

describe('notifications under volume', () => {
  it(`L-MEM-7 · ${POSTS} notifications across ${SESSIONS} sessions: the live ones on both sides (policy, notifier, what main shows) within one per session and the burst throughout; all gone L.notificationTtlMs after the last, with no timer left`, () => {
    vi.useFakeTimers()
    let mono = 0
    const tick = (ms: number) => {
      mono += ms
      vi.advanceTimersByTime(ms)
    }
    const ids = Array.from({ length: SESSIONS }, (_, i) => `s${i}`)
    const sessions = new KeyedStore<SessionView>('sessions')
    for (const id of ids) sessions.set(id, { id, projectId: 'p', title: `Task ${id}`, lifecycle: 'live', endReason: null, phase: 'working', attention: [], unread: false, failureKind: null, lastActivityAt: 0, agent: 'fake' } as unknown as SessionView)
    const conditions = new KeyedStore<AccountCondition>(CONDITIONS_STORE)
    const subs = new Set<(n: StatusNotice) => void>() // bounded: the policy's one subscription
    const fire = (n: StatusNotice) => {
      for (const cb of subs) cb(n)
    }
    const rec = new RecordingSurfaces()
    const notifier = new Notifier({ native: rec, onClick: () => undefined, mono: () => mono })
    let posted = 0
    const policy = new NotificationPolicy({
      notices: (cb) => {
        subs.add(cb)
        return { dispose: () => subs.delete(cb) }
      },
      sessions,
      conditions,
      projectName: () => 'demo',
      agentName: () => 'Fake',
      settings: () => ({ needsYou: true, finished: true, failed: true, sound: false, onlyWhenUnfocused: true }),
      viewing: () => null,
      mono: () => mono,
      out: (op: NotificationOp) => {
        if (op.op === 'post') posted++
        notifier.apply(op)
      },
    })
    const live = () => ({ policy: policy.resourceCounts.live, notifier: notifier.size, shown: rec.liveIds().length })
    let peak = 0

    for (let i = 0; i < POSTS; i++) {
      const id = ids[i % SESSIONS]!
      // mostly one session at a time (each post replaces its session's last); every 50th post, a burst of sessions
      // changing at once (the policy collapses them into one)
      tick(i % 50 < 4 ? 1 : L.notifyBurstMs + 1)
      switch (i % 5) {
        case 0:
        case 1:
          fire({ k: 'N1', sessionId: id, item: { kind: 'permission', key: `Bash: step ${i}`, summary: `step ${i}`, source: 'hook', at: mono }, trust: false })
          break
        case 2:
          fire({ k: 'N2', sessionId: id, turnMs: L.notifyMinTurnMs, lastMessage: `done ${i}`, background: false })
          break
        case 3:
          fire({ k: 'N3', sessionId: id, reason: 'overloaded' })
          break
        default:
          // the reason goes now and then
          fire(i % 10 === 4 ? { k: 'withdraw', sessionId: id } : { k: 'N1', sessionId: id, item: { kind: 'question', key: `q ${i}`, summary: `Which one? ${i}`, source: 'hook', at: mono }, trust: false })
      }
      const n = live()
      peak = Math.max(peak, n.policy, n.notifier, n.shown)
      expect(n.notifier, `post ${i}: main holds what core holds`).toBe(n.policy)
      expect(n.shown).toBe(n.notifier)
    }
    expect(posted, 'posts that reached main (a short burst collapsed, a withdrawal posts nothing)').toBeGreaterThanOrEqual(POSTS * 0.6)
    expect(peak, `the most live at once (cap ${CAP})`).toBeLessThanOrEqual(CAP)
    expect(peak, 'one per session was reached').toBeGreaterThanOrEqual(SESSIONS - 1)
    expect(rec.log.length).toBeLessThanOrEqual(L.logMemoryEntries)

    // the time-to-live, after the last post: all gone on both sides, no timer left
    tick(L.notificationTtlMs)
    expect(live()).toEqual({ policy: 0, notifier: 0, shown: 0 })
    expect(policy.resourceCounts).toMatchObject({ live: 0, burst: 0, timers: 0 })
    expect(policy.resourceCounts.recent, 'the burst window’s sessions (pruned at the next post)').toBeLessThanOrEqual(SESSIONS)
    policy.dispose()
    notifier.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
