import { L, zUsageReading, type UsageReading, type UsageWindow } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { Usage, usageKey } from './usage.ts'

const T0 = 1_790_000_000_000
const HOUR = 3600_000

const win = (
  id: string,
  usedPct: number,
  resetsAt: number,
  o: { shortLabel?: string; tipLabel?: string; spokenLabel?: string; priority?: number } = {},
): UsageWindow => ({
  id,
  shortLabel: o.shortLabel ?? id,
  tipLabel: o.tipLabel ?? `Limit ${id}`,
  spokenLabel: o.spokenLabel ?? id,
  ...(o.priority !== undefined ? { priority: o.priority } : {}),
  usedPct,
  resetsAt,
})

describe('adapter-driven usage store', () => {
  it('U-ST-26 · arbitrary adapter window IDs and labels are merged per account, ordered by priority (default 50) then id, and capped at L.usageWindowsMax', () => {
    let now = T0
    const changed: string[] = []
    const u = new Usage({ now: () => now, changed: (a) => changed.push(a) })

    const r1 = T0 + 2 * HOUR
    const r2 = T0 + 5 * HOUR
    const keyA = usageKey('agent-a', '/cfg/a')
    const keyB = usageKey('agent-b', '/cfg/b')

    u.report({
      agent: 'agent-a',
      account: '/cfg/a',
      windows: [
        win('flash', 20, r1, { shortLabel: 'Flash', tipLabel: 'Flash quota', spokenLabel: 'flash', priority: 2 }),
        win('pro', 65, r2, { shortLabel: 'Pro', tipLabel: 'Pro quota', spokenLabel: 'pro', priority: 0 }),
      ],
      at: T0,
    })
    expect(u.store.get(keyA)?.windows.map((w) => [w.id, w.shortLabel, w.usedPct, w.priority])).toEqual([
      ['pro', 'Pro', 65, 0],
      ['flash', 'Flash', 20, 2],
    ])
    expect(zUsageReading.safeParse(u.store.get(keyA)).success).toBe(true)

    // a partial update merges by id, keeps existing windows, sorts by (priority ?? 50) then id, and caps at L.usageWindowsMax
    u.report({
      agent: 'agent-a',
      account: '/cfg/a',
      windows: [
        win('zeta', 10, r1), // default priority 50
        win('alpha', 15, r1), // default priority 50, tie-broken before zeta
        win('pro', 70, r2, { shortLabel: 'Pro', tipLabel: 'Pro quota', spokenLabel: 'pro', priority: 0 }),
        win('low', 90, r1, { priority: 99 }),
        win('mid', 30, r1, { priority: 1 }),
      ],
      at: T0 + 1000,
    })
    const readingA = u.store.get(keyA)!
    expect(readingA.windows).toHaveLength(L.usageWindowsMax)
    expect(readingA.windows.map((w) => [w.id, w.usedPct])).toEqual([
      ['pro', 70],
      ['mid', 30],
      ['flash', 20],
      ['alpha', 15],
    ])
    expect(zUsageReading.safeParse(readingA).success).toBe(true)

    // another agent's account is isolated
    u.report({
      agent: 'agent-b',
      account: '/cfg/b',
      windows: [win('daily', 40, r1, { shortLabel: '24h', tipLabel: 'Daily limit', spokenLabel: 'daily', priority: 0 })],
      at: T0 + 2000,
    })
    expect(u.store.get(keyB)?.windows.map((w) => w.id)).toEqual(['daily'])
    expect(changed).toEqual(['agent-a', 'agent-a', 'agent-b'])
    u.dispose()
  })

  it('U-ST-26 · publish emits when a window’s label or priority changes within the same minute, and skips identical repeats', () => {
    const minute = new Date(T0).setSeconds(0, 0)
    let now = minute + 5000
    const u = new Usage({ now: () => now })
    const key = usageKey('agent-a', '/cfg/a')
    const published: UsageReading[] = []
    u.store.onDelta((d) => {
      const r = d.set?.[key]
      if (r) published.push(r)
    })

    const resetsAt = minute + 4 * HOUR
    u.report({
      agent: 'agent-a',
      account: '/cfg/a',
      windows: [win('primary', 50, resetsAt, { shortLabel: 'P1', tipLabel: 'Primary', spokenLabel: 'primary', priority: 1 })],
      at: minute + 5000,
    })
    expect(published).toHaveLength(1)

    // identical labels, priority, share and reset within the same minute: not republished
    u.report({
      agent: 'agent-a',
      account: '/cfg/a',
      windows: [win('primary', 50, resetsAt, { shortLabel: 'P1', tipLabel: 'Primary', spokenLabel: 'primary', priority: 1 })],
      at: minute + 10_000,
    })
    expect(published).toHaveLength(1)

    // shortLabel change within the same minute: republished
    u.report({
      agent: 'agent-a',
      account: '/cfg/a',
      windows: [win('primary', 50, resetsAt, { shortLabel: 'P1-new', tipLabel: 'Primary', spokenLabel: 'primary', priority: 1 })],
      at: minute + 15_000,
    })
    expect(published).toHaveLength(2)
    expect(published.at(-1)?.windows[0]?.shortLabel).toBe('P1-new')

    // priority change within the same minute: republished
    u.report({
      agent: 'agent-a',
      account: '/cfg/a',
      windows: [win('primary', 50, resetsAt, { shortLabel: 'P1-new', tipLabel: 'Primary', spokenLabel: 'primary', priority: 0 })],
      at: minute + 20_000,
    })
    expect(published).toHaveLength(3)
    expect(published.at(-1)?.windows[0]?.priority).toBe(0)
    u.dispose()
  })

  it('U-ST-26 · limitReset and expiration work across arbitrary window IDs', () => {
    let now = T0
    const u = new Usage({ now: () => now })
    const earlyReset = T0 + HOUR
    const lateReset = T0 + 3 * HOUR

    u.report({
      agent: 'agent-a',
      account: '/cfg/a',
      windows: [
        win('fast', 100, earlyReset, { priority: 0 }),
        win('deep', 100, lateReset, { priority: 1 }),
      ],
      at: T0,
    })
    expect(u.limitReset('agent-a')).toBe(lateReset)

    // advance past earlyReset: `fast` expires, `deep` remains
    now = earlyReset
    expect(u.check(now)).toBe(lateReset)
    expect(u.store.get(usageKey('agent-a', '/cfg/a'))?.windows.map((w) => w.id)).toEqual(['deep'])
    expect(u.limitReset('agent-a')).toBe(lateReset)

    // advance past lateReset: the reading is dropped
    now = lateReset
    expect(u.check(now)).toBeNull()
    expect(u.size).toBe(0)
    expect(u.limitReset('agent-a')).toBeNull()
    u.dispose()
  })
})
