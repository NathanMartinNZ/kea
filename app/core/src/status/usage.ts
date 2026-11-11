// Usage readings: an account's usage limits as its agent reported them (Claude's status line, on unless turned off). One reading per
// account, the agent and its config folder, held in memory only and shown to the window as the `status.usage` store.
//
//   report     an adapter's `account.usage` windows, stamped with when the agent reported them: the latest report wins
//                      per window, a window a report leaves out keeps its last value, and an older report (a spooled
//                      copy drained late) changes nothing
//   publish    the reading held here always has the latest report's time (staleness runs from it); the store gets it
//                      only when a window's share or reset time changes, a window comes or goes, or the time it was seen
//                      moves to another local minute (the window shows it to the minute). The agent can rerun its status
//                      line after every message, so a long turn repeats the same reading many times a minute
//   expire     on the account conditions' check (conditions.ts, at least every L.conditionCheckMs, no timer here): a
//                      window goes at its reset time, a reading no report refreshed for L.usageStaleMs goes whole (use
//                      outside Kea may have moved it), and so does a reading with no window left
//   clear      the agent's setting went off: its readings go
//   limit      a usage limit hit without a reset time takes the latest reset among the full windows, while the agent
//                      has one account with a reading (with two, which one the session used is not known)

import { KeyedStore, L, USAGE_STORE, USAGE_WINDOWS, type UsageReading, type UsageWindow } from '@kea/protocol'

/** A reading's key: the agent and the account's config folder (two logins are two readings). */
export function usageKey(agent: string, account: string): string {
  return `${agent}:${account}`
}

export interface UsageOptions {
  /** Wall clock (ms). */
  now: () => number
  /** `agent`'s published reading changed: the conditions look at it (a full window's reset) and check again. */
  changed?(agent: string): void
}

type HeldWindow = UsageReading['windows'][number]

export class Usage {
  /**
   * `status.usage`: UsageReading by account (bounded: one per account an agent reported from, each gone L.usageStaleMs
   * after its last report).
   */
  readonly store = new KeyedStore<UsageReading>(USAGE_STORE)
  /** The readings as last reported, by account; the store has each as last published. */
  private readonly held = new Map<string, UsageReading>() // bounded: one per account, as the store
  private readonly o: UsageOptions

  constructor(o: UsageOptions) {
    this.o = o
  }

  /** One report: `windows` as `agent` reported them for `account` (its config folder) at `at` (wall ms). */
  report(r: { agent: string; account: string; windows: readonly UsageWindow[]; at: number }): void {
    const now = this.o.now()
    const key = usageKey(r.agent, r.account)
    const byId = new Map<string, HeldWindow>()
    for (const w of this.held.get(key)?.windows ?? []) byId.set(w.id, w)
    let changed = false
    for (const w of r.windows) {
      if (w.resetsAt <= now) continue // reset already: the next report brings the new window
      const old = byId.get(w.id)
      if (old && old.seenAt > r.at) continue
      const next = { id: w.id, usedPct: w.usedPct, resetsAt: w.resetsAt, seenAt: r.at }
      if (old && old.usedPct === next.usedPct && old.resetsAt === next.resetsAt && old.seenAt === next.seenAt) continue
      byId.set(w.id, next)
      changed = true
    }
    if (!changed) return
    const windows = USAGE_WINDOWS.flatMap((id) => {
      const w = byId.get(id)
      return w ? [w] : []
    })
    this.held.set(key, { account: key, agent: r.agent, windows, seenAt: Math.max(...windows.map((w) => w.seenAt)) })
    if (this.publish(key)) this.o.changed?.(r.agent)
  }

  /** The setting went off: `agent`'s readings go. */
  clear(agent: string): void {
    for (const r of [...this.held.values()]) if (r.agent === agent) this.drop(r.account)
  }

  /**
   * Drop the windows past their reset and the readings past L.usageStaleMs; the wall time the next one is due, or
   * null when nothing is held.
   */
  check(now: number = this.o.now()): number | null {
    let next = Number.POSITIVE_INFINITY
    for (const r of [...this.held.values()]) {
      const stale = r.seenAt + L.usageStaleMs
      const windows = r.windows.filter((w) => w.resetsAt > now)
      if (stale <= now || windows.length === 0) {
        this.drop(r.account)
        continue
      }
      if (windows.length !== r.windows.length) {
        this.held.set(r.account, { ...r, windows })
        this.publish(r.account)
      }
      next = Math.min(next, stale, ...windows.map((w) => w.resetsAt))
    }
    return Number.isFinite(next) ? next : null
  }

  /**
   * The reset time a usage limit of `agent`'s takes: the latest among its full windows (at or above 100 %), so a full
   * week outlasts a full session window. Only while the agent has one account with a reading: with two logins, which
   * one the limited session used is not known.
   */
  limitReset(agent: string): number | null {
    let only: UsageReading | null = null
    for (const r of this.held.values()) {
      if (r.agent !== agent) continue
      if (only) return null
      only = r
    }
    let reset: number | null = null
    for (const w of only?.windows ?? []) if (w.usedPct >= 100 && (reset === null || w.resetsAt > reset)) reset = w.resetsAt
    return reset
  }

  get size(): number {
    return this.held.size
  }

  dispose(): void {
    this.held.clear()
    this.store.dispose()
  }

  /**
   * Publish the held reading of `key` when the window would show something else: a share or a reset time, a window
   * come or gone, or the minute it was seen. Whether it published.
   */
  private publish(key: string): boolean {
    const r = this.held.get(key)
    if (!r) return false
    const cur = this.store.get(key)
    const same =
      cur !== undefined &&
      minuteOf(cur.seenAt) === minuteOf(r.seenAt) &&
      cur.windows.length === r.windows.length &&
      cur.windows.every((w, i) => {
        const n = r.windows[i]!
        return w.id === n.id && w.usedPct === n.usedPct && w.resetsAt === n.resetsAt
      })
    if (same) return false
    this.store.set(key, r)
    return true
  }

  private drop(key: string): void {
    this.held.delete(key)
    this.store.delete(key)
  }
}

/** The start of the local clock minute `ms` falls in. */
function minuteOf(ms: number): number {
  return new Date(ms).setSeconds(0, 0)
}
