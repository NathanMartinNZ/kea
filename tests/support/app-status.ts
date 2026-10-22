// Status in the window, driven through the real app. Sessions run the fake agent (tests/support/app-fake-agent.ts),
// whose hooks, status file and transcript drive their status; where a test needs a state the fake agent cannot reach (a
// usage limit's reset time), the adapter's normalised events are injected at core's intake through the child hook's
// `status` op (`ingest`, `statusFile`: tests/support/app-child-hooks.cjs; core hands the hook its engine,
// app/core/src/status/seam.ts). What main would have posted to the system is read from its recorder
// (`__keaTest.notifications()`, app/main/src/notifier.ts `RecordingSurfaces`): no test posts a real notification. A
// test window never takes keyboard focus, so "the window is focused" is a stand-in on both sides (`Kea.pretendFocused`:
// main's app focus and the window's `isBeingViewed`), false from every launch.

import type { AgentEvent, StatusFileReading, StatusSource } from '@kea/protocol'
import { STEP_MS, until, type Kea } from './app.ts'

/** One thing main's recorder saw (app/main/src/notifier.ts `Recorded`). */
export type Recorded =
  | { k: 'show'; id: string; title: string; subtitle: string; body: string; silent: boolean }
  | { k: 'close'; id: string }
  | { k: 'badge'; text: string }

export interface NotificationsProbe {
  log: Recorded[]
  /** Tags of the notifications live now. */
  live: string[]
  /** The Dock badge's text ('' for none). */
  badge: string
  permissionDenied: boolean
}

type StatusTestApi = { notifications(): NotificationsProbe; clickNotification(tag: string): boolean; focus(v: boolean | null): void }

/** Apply one input to a session's status, as the adapter's intake would; resolves with whether it applied and the phase after. */
export function ingest(kea: Kea, sessionId: string, source: StatusSource, ...events: AgentEvent[]): Promise<{ applied: boolean; phase: string | null }> {
  return kea.debug('core', 'status', JSON.stringify({ ingest: { sessionId, source, events } }))
}

/** One reading of the agent's live status file. */
export function statusFile(kea: Kea, sessionId: string, reading: StatusFileReading): Promise<{ applied: boolean; phase: string | null }> {
  return kea.debug('core', 'status', JSON.stringify({ statusFile: { sessionId, reading } }))
}

/** A permission prompt, as the Claude adapter reports `PermissionRequest` (`Bash: npm test`). */
export function permission(summary = 'npm test', tool = 'Bash'): AgentEvent {
  return { t: 'attention.permission', key: `${tool}: ${summary}`, tool, summary }
}

export function notifications(kea: Kea): Promise<NotificationsProbe> {
  return kea.app.evaluate(() => (globalThis as unknown as { __keaTest: StatusTestApi }).__keaTest.notifications())
}

/** Click the live notification `tag`; false when none is live. */
export function clickNotification(kea: Kea, tag: string): Promise<boolean> {
  return kea.app.evaluate((_e, t) => (globalThis as unknown as { __keaTest: StatusTestApi }).__keaTest.clickNotification(t), tag)
}

/** Shown notifications so far (each post, in order). */
export function shown(p: NotificationsProbe): Extract<Recorded, { k: 'show' }>[] {
  return p.log.filter((x): x is Extract<Recorded, { k: 'show' }> => x.k === 'show')
}

/** Wait until main's recorder satisfies `pred`. */
export async function waitNotifications(kea: Kea, what: string, pred: (p: NotificationsProbe) => boolean, ms = STEP_MS): Promise<NotificationsProbe> {
  let last: NotificationsProbe | null = null
  return until(
    `notifications: ${what}`,
    async () => {
      last = await notifications(kea)
      return pred(last) ? last : undefined
    },
    ms,
  ).catch((e: Error) => {
    throw new Error(`${e.message} (last: ${JSON.stringify(last)})`)
  })
}

/**
 * Pretend the window has keyboard focus (true), has not (false), or follow the real window (null): `Kea.pretendFocused`
 * (every launch starts at false).
 */
export function pretendFocused(kea: Kea, v: boolean | null): Promise<void> {
  return kea.pretendFocused(v)
}

/** The session the window tells core it views, or null. */
export async function viewing(kea: Kea): Promise<string | null> {
  return (await kea.page()).evaluate(() => (window as unknown as { __keaProbe: { viewing(): string | null } }).__keaProbe.viewing())
}
