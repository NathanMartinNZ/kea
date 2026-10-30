import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@kea/kit'
import { L, type MenuBarState, type NotificationOp } from '@kea/protocol'
import { Notifier, RecordingSurfaces } from './notifier.ts'

afterEach(() => vi.useRealTimers())

const post = (tag: string, o: Partial<Extract<NotificationOp, { op: 'post' }>> = {}): NotificationOp => ({ op: 'post', tag, sessionId: tag.slice(2), title: `t ${tag}`, subtitle: 'kea', body: 'b', sound: false, ...o })
const state = (count: number, badge = true): MenuBarState => ({ live: 1, running: 1, onQuit: 'menuBar', count, sessions: [], badge })

function harness() {
  vi.useFakeTimers()
  let mono = 0
  const rec = new RecordingSurfaces()
  const clicks: (string | null)[] = []
  const log = createMemoryLogger({ process: 'main' })
  const n = new Notifier({ native: rec, onClick: (id) => clicks.push(id), mono: () => mono, log })
  return {
    n,
    rec,
    clicks,
    log,
    tick(ms: number) {
      mono += ms
      vi.advanceTimersByTime(ms)
    },
    shows: () => [...rec.log].filter((x) => x.k === 'show'),
    closes: () => [...rec.log].filter((x) => x.k === 'close').map((x) => (x.k === 'close' ? x.id : '')),
  }
}

describe('main shows what core decides', () => {
  it('U-NT-7 · one live notification per tag (a post replaces it, closing the old), a withdrawal closes it, a click shows its session and forgets it, one the person closes is forgotten; a replaced one’s late click changes nothing', () => {
    const h = harness()
    h.n.apply(post('s:a'))
    h.n.apply(post('s:a', { title: 'second' }))
    expect(h.shows().map((x) => (x.k === 'show' ? [x.id, x.title] : null))).toEqual([
      ['s:a', 't s:a'],
      ['s:a', 'second'],
    ])
    expect(h.closes()).toEqual(['s:a'])
    expect(h.n.liveTags()).toEqual(['s:a'])
    h.n.apply({ op: 'withdraw', tag: 's:a' })
    expect(h.closes()).toEqual(['s:a', 's:a'])
    expect(h.n.size).toBe(0)
    h.n.apply({ op: 'withdraw', tag: 's:zz' })
    expect(h.closes(), 'nothing live: nothing closed').toHaveLength(2)

    // A click shows its session (null: Kea as it is) and forgets it
    h.n.apply(post('s:b'))
    h.n.apply(post('burst', { sessionId: null }))
    expect(h.rec.click('s:b')).toBe(true)
    expect(h.rec.click('burst')).toBe(true)
    expect(h.clicks).toEqual(['b', null])
    expect(h.n.size).toBe(0)
    expect(h.rec.click('s:b'), 'gone').toBe(false)

    // a late event from a replaced notification is not the live one's
    const late: (() => void)[] = []
    const n2 = new Notifier({
      native: {
        create: () => ({ show() {}, close() {}, on: (e: string, cb: () => void) => void (e === 'click' && late.push(cb)) }) as never,
        setBadge() {},
      },
      onClick: (id) => h.clicks.push(id),
    })
    n2.apply(post('s:c'))
    n2.apply(post('s:c'))
    late[0]!()
    expect(h.clicks, 'the replaced one’s click').toEqual(['b', null])
    late[1]!()
    expect(h.clicks).toEqual(['b', null, 'c'])
    n2.dispose()
  })

  it('U-NT-4 · main: silent unless the policy asked for the sound; a notification that fails to show (permission denied) is forgotten and marks the permission denied until one shows, and the badge goes on; the Dock badge shows core’s count while the Dock icon is shown, nothing at zero, switched off or in the menu bar', () => {
    const h = harness()
    h.n.apply(post('s:a', { sound: true }))
    h.n.apply(post('s:b'))
    expect(h.shows().map((x) => (x.k === 'show' ? x.silent : null))).toEqual([false, true])

    // denied: the native notification reports a failure
    const failing = new Notifier({
      native: {
        create: () => {
          const on: Record<string, ((...a: unknown[]) => void)[]> = {}
          return {
            show: () => {
              for (const cb of on.failed ?? []) cb({}, 'Notifications are not allowed')
            },
            close() {},
            on: (e: string, cb: (...a: unknown[]) => void) => void (on[e] ??= []).push(cb),
          } as never
        },
        setBadge: (t) => h.rec.setBadge(t),
      },
      onClick: () => undefined,
      log: h.log,
    })
    failing.apply(post('s:x'))
    expect(failing.permissionDenied).toBe(true)
    expect(failing.size).toBe(0)
    failing.badge(state(2), true)
    expect(h.rec.badge, 'the badge does not depend on the permission').toBe('2')
    expect(h.log.entries.filter((e) => /permission denied/.test(e.msg))).toHaveLength(1)
    failing.apply(post('s:y'))
    expect(h.log.entries.filter((e) => /permission denied/.test(e.msg)), 'logged once').toHaveLength(1)
    failing.dispose()
    expect(h.n.permissionDenied, 'the recorder shows them').toBe(false)

    // the Dock badge
    h.n.badge(state(3), true)
    expect(h.rec.badge).toBe('3')
    h.n.badge(state(0), true)
    expect(h.rec.badge).toBe('')
    h.n.badge(state(2, false), true)
    expect(h.rec.badge, 'notifications.dockBadge off').toBe('')
    h.n.badge(state(2), false)
    expect(h.rec.badge, 'in the menu bar: the item’s title carries it').toBe('')
    h.n.badge(null, true)
    expect(h.rec.badge).toBe('')
    const sets = [...h.rec.log].filter((x) => x.k === 'badge').length
    h.n.badge(state(0), true)
    expect([...h.rec.log].filter((x) => x.k === 'badge').length, 'unchanged: not set again').toBe(sets)
  })

  it('U-NT-8 · a notification is closed and forgotten L.notificationTtlMs after it was shown, on the monotonic clock: one timer while any is live, none after', () => {
    const h = harness()
    h.n.apply(post('s:a'))
    h.tick(1000)
    h.n.apply(post('s:b'))
    expect(vi.getTimerCount()).toBe(1)
    h.tick(L.notificationTtlMs - 1000)
    expect(h.n.liveTags()).toEqual(['s:b'])
    expect(h.closes()).toEqual(['s:a'])
    h.tick(1000)
    expect(h.n.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
