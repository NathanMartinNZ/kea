// When a worktree is measured and when an archived session's build folders go: the two rules, pure, so the service that
// keeps the one timer (disk.ts) and the tests read the same thing.

import { L, type Lifecycle } from '@kea/protocol'

const DAY_MS = 86_400_000

export interface Measurable {
  lifecycle: Lifecycle
  createdAt: number
  archivedAt: number | null
  /** When it was last measured (`disk_at`); null: never. */
  diskAt: number | null
  /** The agent's last activity. */
  lastActivityAt: number
}

export interface Viewed {
  /** A window shows it now. */
  visible: boolean
  /** When a window last showed it. */
  viewedAt: number | null
}

/**
 * The time from which the schedule measures the session again; Infinity: the schedule does not.
 *
 *   - A live session whose agent did something since it was measured, and any session a window shows or has shown
 *     since: L.diskMeasureIntervalMs after its last measurement (its creation, for one never measured). A session
 *     nothing touched and nobody looked at is not walked again: its size cannot have changed by Kea's doing.
 *   - An archived session: once per archive. The archive itself measures it at once (disk.ts); this rule is for the one
 *     that missed that (archived by an earlier version, or the walk failed).
 *   - Nothing within L.diskMeasureIntervalMs of core's start (`since`): a launch never starts a round of walks.
 *   - `retryAt`: not before this (a walk that failed is tried again L.diskMeasureIntervalMs later, not at once).
 */
export function measureDueAt(s: Measurable, d: Viewed | undefined, since: number, retryAt = 0): number {
  const first = Math.max(since + L.diskMeasureIntervalMs, retryAt)
  if (s.lifecycle === 'archived') return s.diskAt === null || (s.archivedAt !== null && s.diskAt < s.archivedAt) ? first : Infinity
  if (s.lifecycle !== 'live' && s.lifecycle !== 'detached') return Infinity
  const measured = s.diskAt
  const touched = s.lifecycle === 'live' && (measured === null || s.lastActivityAt > measured)
  const seen = d !== undefined && (d.visible || (d.viewedAt !== null && (measured === null || d.viewedAt > measured)))
  if (!touched && !seen) return Infinity
  return Math.max((measured ?? s.createdAt) + L.diskMeasureIntervalMs, first)
}

/**
 * The time from which an archived session's rebuildable folders are removed; Infinity: never. `days`:
 * `general.pruneArchivedBuildDirsDays` (0 = never). `prunedAt`: when they were last removed (by this rule or by hand):
 * once per archive, so a session whose folders are gone is not asked again at every check.
 */
export function pruneDueAt(s: Pick<Measurable, 'lifecycle' | 'archivedAt'>, prunedAt: number | null, days: number, retryAt = 0): number {
  if (s.lifecycle !== 'archived' || s.archivedAt === null || !(days > 0)) return Infinity
  if (prunedAt !== null && prunedAt >= s.archivedAt) return Infinity
  return Math.max(s.archivedAt + days * DAY_MS, retryAt)
}

/**
 * The one timer's delay: to the earliest due time, never longer than L.diskMeasureIntervalMs (so a far date needs no
 * long timer).
 */
export function tickDelay(next: number, now: number): number | null {
  if (next === Infinity) return null
  return Math.min(Math.max(next - now, 0), L.diskMeasureIntervalMs)
}
