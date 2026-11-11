import { describe, expect, it } from 'vitest'
import { clockTime, L, type UsageReading } from '@kea/protocol'
import { latestReading, usageLevel, usageView, type UsageView } from './usage.ts'

// local wall times, so the clock and the weekday read the same in any time zone: Wednesday 11 November 2026, 14:02
const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).getTime()
const NOW = at(11, 14, 2)
const SESSION_RESET = at(11, 15, 10)
const WEEK_RESET = at(16, 9, 0) // the Monday after

function reading(session: number | null, week: number | null, o: { seenAt?: number; agent?: string; account?: string; sessionReset?: number; weekReset?: number } = {}): UsageReading {
  const seenAt = o.seenAt ?? NOW
  const windows: UsageReading['windows'] = []
  if (session !== null) windows.push({ id: 'session', usedPct: session, resetsAt: o.sessionReset ?? SESSION_RESET, seenAt })
  if (week !== null) windows.push({ id: 'week', usedPct: week, resetsAt: o.weekReset ?? WEEK_RESET, seenAt })
  return { account: o.account ?? 'claude', agent: o.agent ?? 'claude', windows, seenAt }
}

/** What each part says, in the order they show (the meter puts ` · ` between them). */
const texts = (v: UsageView) => v.parts.map((p) => p.text)

describe('the usage meter', () => {
  it('U-LAYOUT-8 · both windows: each part, the tooltip with each reset and when it was seen, and the accessible name', () => {
    const v = usageView(reading(25, 67), NOW)!
    expect(v.parts).toEqual([
      { id: 'session', text: '5h 25%', level: 'plain' },
      { id: 'week', text: '7d 67%', level: 'plain' },
    ])
    expect(v.tip).toBe('Session limit: 25 % used, resets 15:10 · Weekly: 67 % used, resets Mon 09:00 · as of 14:02')
    expect(v.label).toBe('Usage: session 25 %, weekly 67 %')
  })

  it('U-LAYOUT-8 · a share is rounded down to a whole percent, in the parts, the tooltip and the name alike', () => {
    const v = usageView(reading(42.9, 17.999), NOW)!
    expect(texts(v)).toEqual(['5h 42%', '7d 17%'])
    expect(v.tip).toBe('Session limit: 42 % used, resets 15:10 · Weekly: 17 % used, resets Mon 09:00 · as of 14:02')
    expect(v.label).toBe('Usage: session 42 %, weekly 17 %')
    expect(texts(usageView(reading(0.4, null), NOW)!)).toEqual(['5h 0%'])
  })

  it('U-LAYOUT-8 · the warning colour from the warning ratio and the danger colour from the danger ratio, each part on its own', () => {
    const warn = L.usageWarnRatio * 100
    const danger = L.usageDangerRatio * 100
    expect(usageLevel(warn - 0.01)).toBe('plain')
    expect(usageLevel(warn)).toBe('warn')
    expect(usageLevel(danger - 0.01)).toBe('warn')
    expect(usageLevel(danger)).toBe('danger')
    expect(usageLevel(100)).toBe('danger')
    expect(usageView(reading(warn, danger), NOW)!.parts.map((p) => p.level)).toEqual(['warn', 'danger'])
    expect(usageView(reading(10, warn), NOW)!.parts.map((p) => p.level)).toEqual(['plain', 'warn'])
  })

  it('U-LAYOUT-8 · at 100 % a window says it is at its limit and when it resets: the clock time today, the weekday and time on a later day', () => {
    const v = usageView(reading(100, 67), NOW)!
    expect(texts(v)).toEqual([`5h limit · ${clockTime(SESSION_RESET)}`, '7d 67%'])
    expect(v.parts[0]).toEqual({ id: 'session', text: '5h limit · 15:10', level: 'danger' })
    expect(v.tip).toBe('Session limit: 100 % used, resets 15:10 · Weekly: 67 % used, resets Mon 09:00 · as of 14:02')
    expect(v.label).toBe('Usage: session limit reached until 15:10, weekly 67 %')
    const week = usageView(reading(30, 100), NOW)!
    expect(texts(week)).toEqual(['5h 30%', '7d limit · Mon 09:00'])
    expect(week.label).toBe('Usage: session 30 %, weekly limit reached until Mon 09:00')
    // a session window that resets after midnight names the day
    const late = at(11, 23, 30)
    expect(texts(usageView(reading(100, null, { seenAt: late, sessionReset: at(12, 2, 15) }), late)!)).toEqual(['5h limit · Thu 02:15'])
  })

  it('U-LAYOUT-8 · a window past its reset is left out; with none left the meter is hidden; one window alone is shown alone', () => {
    expect(texts(usageView(reading(25, 67, { sessionReset: NOW - 1 }), NOW)!)).toEqual(['7d 67%'])
    expect(usageView(reading(25, 67, { sessionReset: NOW }), NOW)!.label).toBe('Usage: weekly 67 %')
    expect(usageView(reading(25, 67, { weekReset: NOW - 1 }), NOW)!.tip).toBe('Session limit: 25 % used, resets 15:10 · as of 14:02')
    expect(usageView(reading(25, 67, { sessionReset: NOW - 1, weekReset: NOW - 1 }), NOW)).toBeNull()
    expect(usageView(reading(null, null), NOW)).toBeNull()
    expect(usageView(null, NOW)).toBeNull()
  })

  it('U-LAYOUT-8 · the parts come in the order they give way from the end where the row is narrow: the session part first, the weekly part last, whichever order the reading lists them in', () => {
    const r = reading(25, 67)
    const listed = { ...r, windows: [...r.windows].reverse() }
    expect(listed.windows.map((w) => w.id)).toEqual(['week', 'session'])
    expect(usageView(listed, NOW)!.parts.map((p) => p.id)).toEqual(['session', 'week'])
    expect(texts(usageView(listed, NOW)!)).toEqual(['5h 25%', '7d 67%'])
  })

  it('U-LAYOUT-8 · a session shows the latest reading of its own agent: none for an agent with no reading', () => {
    const older = reading(10, 20, { account: 'claude:/a', seenAt: NOW - 60_000 })
    const newer = reading(30, 40, { account: 'claude:/b', seenAt: NOW })
    const other = reading(90, 90, { account: 'other', agent: 'other', seenAt: NOW + 1 })
    expect(latestReading([older, newer, other], 'claude')).toBe(newer)
    expect(latestReading([newer, older], 'claude')).toBe(newer)
    expect(latestReading([older, newer, other], 'shell')).toBeNull()
    expect(latestReading([older], null)).toBeNull()
    expect(latestReading([], 'claude')).toBeNull()
  })
})
