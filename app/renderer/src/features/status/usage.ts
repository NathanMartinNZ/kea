// What the usage meter says for a session: the latest reading of its agent's usage limits (core's `status.usage`), as
// `5h 25% · 7d 67%`. Each window's share is rounded down to a whole percent and coloured by how full it is; a window at
// its limit says so with its reset (`5h limit · 15:10`); a window past its reset is left out, and with none left the
// meter is hidden. The tooltip spells each window out with its reset and when it was seen, and the accessible name says
// the same in words. The parts come in `compareUsageWindows` order (lowest priority first), so where the row is narrow
// the meter's stylesheet wraps later parts out of sight first.

import { clockTime, compareUsageWindows, L, type UsageReading } from '@kea/protocol'

export type UsageLevel = 'plain' | 'warn' | 'danger'

/** One window as the meter shows it. */
export interface UsagePart {
  id: string
  /** `5h 25%`, or `5h limit · 15:10` at the limit. */
  text: string
  level: UsageLevel
}

/** The meter for one reading: its parts in the order they show (the last gives way first), and its words. */
export interface UsageView {
  parts: UsagePart[]
  tip: string
  label: string
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const SEP = ' · '

/** How full a window is, from its share used (0–100): the warning colour from one ratio, the danger colour from the other. */
export function usageLevel(usedPct: number): UsageLevel {
  const ratio = usedPct / 100
  return ratio >= L.usageDangerRatio ? 'danger' : ratio >= L.usageWarnRatio ? 'warn' : 'plain'
}

/** When a window resets: the clock time on the day of `now`, else the weekday and the time (`Mon 09:00`). */
export function resetText(ms: number, now: number): string {
  const d = new Date(ms)
  const n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? clockTime(ms) : `${DAYS[d.getDay()]} ${clockTime(ms)}`
}

/** The meter for `r` at `now`; null when there is nothing to show (no reading, or every window past its reset). */
export function usageView(r: UsageReading | null, now: number): UsageView | null {
  if (!r) return null
  const windows = r.windows.filter((w) => w.resetsAt > now).sort(compareUsageWindows)
  if (windows.length === 0) return null
  const parts: UsagePart[] = []
  const tips: string[] = []
  const spoken: string[] = []
  for (const w of windows) {
    const pct = Math.floor(w.usedPct)
    const reset = resetText(w.resetsAt, now)
    const full = w.usedPct >= 100
    parts.push({ id: w.id, text: full ? `${w.shortLabel} limit${SEP}${reset}` : `${w.shortLabel} ${pct}%`, level: usageLevel(w.usedPct) })
    tips.push(`${w.tipLabel}: ${pct}% used, resets ${reset}`)
    spoken.push(full ? `${w.spokenLabel} limit reached until ${reset}` : `${w.spokenLabel} ${pct}%`)
  }
  return {
    parts,
    tip: [...tips, `as of ${clockTime(r.seenAt)}`].join(SEP),
    label: `Usage: ${spoken.join(', ')}`,
  }
}

/** The reading a session of `agent` shows: that agent's with the latest `seenAt` (another login of it may be newer). */
export function latestReading(readings: Iterable<UsageReading>, agent: string | null): UsageReading | null {
  if (agent === null) return null
  let best: UsageReading | null = null
  for (const r of readings) if (r.agent === agent && (best === null || r.seenAt > best.seenAt)) best = r
  return best
}
