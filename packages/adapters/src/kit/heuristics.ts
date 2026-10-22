// Tier-3 heuristics, shared by every adapter and fed by ptyhost's activity notes (output started / stopped, at most one
// note per PTY per L.activityReportMs), keystrokes, bells and OSC 9/777 notifications:
//
//   turn.started      output has flowed for L.tier3WorkingAfterMs after the last user keystroke (or the launch prompt)
//   turn.finished     no output for L.tier3ReadyAfterMs while working, and the session has no tier-1 source (with one,
//                     tier 3 holds no turn of its own: each keystroke followed by output can start one again, so that
//                     output after the user answers a blocked session shows it working, and the exact source ends it)
//   attention.question  a bell or an OSC 9/777 notification, with its text
//
// Pure: times are passed in, and `deadline()` says when `tick` should next be called (the owner arms one timer).
// Precedence against the other tiers is the status engine's.

import { L, type AgentEvent } from '@kea/protocol'

/** The attention keys tier 3 uses (one item per kind, refreshed by the next bell or notification). */
export const TIER3_KEYS = { bell: 'terminal:bell', notify: 'terminal:notify' } as const

export class Tier3 {
  private flowing = false
  private flowSince = 0
  private quietSince = 0
  /** The last keystroke (or the launch prompt) not yet answered by a turn. */
  private prompted: number | null
  private working = false
  /** A tier-1 source has been seen for this session: tier 3 never finishes a turn then. */
  tier1 = false

  constructor(o: { prompted?: number | null } = {}) {
    this.prompted = o.prompted ?? null
  }

  get isWorking(): boolean {
    return this.working
  }

  keystroke(at: number): AgentEvent[] {
    this.prompted = at
    return this.tick(at)
  }

  activity(active: boolean, at: number): AgentEvent[] {
    if (active && !this.flowing) {
      this.flowing = true
      this.flowSince = at
    } else if (!active && this.flowing) {
      this.flowing = false
      this.quietSince = at
    }
    return this.tick(at)
  }

  bell(at: number): AgentEvent[] {
    return [...this.tick(at), { t: 'attention.question', key: TIER3_KEYS.bell, summary: 'The terminal rang the bell' }]
  }

  notify(text: string, at: number): AgentEvent[] {
    return [...this.tick(at), { t: 'attention.question', key: TIER3_KEYS.notify, summary: text }]
  }

  /** Apply the passage of time: the events due at `at`. */
  tick(at: number): AgentEvent[] {
    if (!this.working && this.flowing && this.prompted !== null && at - Math.max(this.flowSince, this.prompted) >= L.tier3WorkingAfterMs) {
      this.working = !this.tier1
      this.prompted = null
      return [{ t: 'turn.started' }]
    }
    if (this.working && !this.flowing && at - this.quietSince >= L.tier3ReadyAfterMs && !this.tier1) {
      this.working = false
      return [{ t: 'turn.finished', backgroundWork: false }]
    }
    return []
  }

  /** When `tick` next has something to decide, or null (no timer needed). */
  deadline(): number | null {
    if (!this.working && this.flowing && this.prompted !== null) return Math.max(this.flowSince, this.prompted) + L.tier3WorkingAfterMs
    if (this.working && !this.flowing && !this.tier1) return this.quietSince + L.tier3ReadyAfterMs
    return null
  }
}

/**
 * Activity notes from raw output times, the way ptyhost derives them: `active` at the first output
 * after a quiet spell, `inactive` once no output came for L.activityReportMs; at most one note per L.activityReportMs.
 * Used to turn a cassette into the trace tier 3 sees (U-AGT-16, K-FX-6).
 */
export function activityNotes(outputTimes: readonly number[]): { at: number; active: boolean }[] {
  const out: { at: number; active: boolean }[] = []
  let active = false
  let last = Number.NEGATIVE_INFINITY
  let lastNote = Number.NEGATIVE_INFINITY
  for (const t of outputTimes) {
    if (active && t - last >= L.activityReportMs) {
      const at = last + L.activityReportMs
      out.push({ at, active: false })
      lastNote = at
      active = false
    }
    if (!active) {
      const at = Math.max(t, lastNote + L.activityReportMs)
      out.push({ at, active: true })
      lastNote = at
      active = true
    }
    last = t
  }
  if (active) out.push({ at: Math.max(last + L.activityReportMs, lastNote + L.activityReportMs), active: false })
  return out
}
