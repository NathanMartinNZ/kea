// A test build never stays the frontmost app. Under `--kea-perf` the window cannot become key (main.ts:
// `focusable: false`, shown with `showInactive()`), so no key typed for another app reaches a test's terminal. macOS
// can still make Kea the frontmost *app*: `showInactive()` orders the window to the front, and when the display wakes,
// the screen is unlocked or the app in front quits, the front can go to the app whose window is on top (seen right
// after the display came on, in a bare Electron probe opened the same way). Kea then has no key window, but the keys
// the person types for their own app are lost and its menu bar takes their shortcuts.
//
// So a test build gives the front back the moment it gets it, whatever gave it (`app.hide()`: the app that was in
// front before has it again), and says so at error level with what came before (the display waking, an unlock, a
// resume, and how long ago). The harness fails the run for that line (`frontSteps` in tests/support/app.ts), as it
// does for a Kea it finds in front at a launch, a reload or a test's end (`Kea.assertUnfocused`): a hidden window
// stops drawing, so what the run measured after it counts for nothing. The display waking is also checked by itself,
// in case the app was made active without the event.
//
// Pure (no Electron import), so the decision is unit-tested (U-HARN-1); main.ts hands it Electron's `app`,
// `powerMonitor` and the workspace's display-wake notification. Never installed without `--kea-perf`: the real app is
// meant to come to the front.

import type { Logger } from '@kea/kit'

/** main.log's line for a test build that was made the frontmost app (read by the harness: tests/support/app.ts). */
export const FRONT_LOG = 'perf: Kea became the frontmost app and stepped back'

/** What brought the display back to the person. */
export type WakeSource = 'display' | 'unlock' | 'resume'

/** What reached the guard: Kea became the active app, or the display came back while Kea was or was not active. */
export type FrontEvent = { kind: 'active' } | { kind: 'wake'; source: WakeSource; active: boolean }

/**
 * Whether Kea gives the front back now. A test build (`perf`) does whenever it is the active app: when it becomes
 * active, and when the display comes back and finds it active. Any other build never does.
 */
export function stepsBack(perf: boolean, e: FrontEvent): boolean {
  if (!perf) return false
  return e.kind === 'active' || e.active
}

/** What the guard needs of Electron (main.ts), or of a test. */
export interface FrontSurfaces {
  /** Kea became the active app (`app.on('did-become-active')`). */
  onActive(cb: () => void): void
  /** The display woke, the screen was unlocked, or the Mac resumed from sleep. */
  onWake(cb: (source: WakeSource) => void): void
  /** Whether Kea is the active app now (`app.isActive()`). */
  isActive(): boolean
  /** Give the front back to the app that had it (`app.hide()`). */
  hide(): void
  /** A monotonic clock, in ms. */
  now(): number
}

/**
 * Install the guard: a fixed set of listeners for the life of the process, in a test build only (`perf`; otherwise
 * nothing is installed). Each step back is one error line saying what woke last and how long ago.
 */
export function installFrontGuard(perf: boolean, s: FrontSurfaces, log: Logger): void {
  if (!perf) return
  let lastWake: { source: WakeSource; at: number } | null = null
  const on = (e: FrontEvent): void => {
    if (e.kind === 'wake') lastWake = { source: e.source, at: s.now() }
    if (!stepsBack(perf, e)) return
    log.error(FRONT_LOG, { on: e.kind === 'wake' ? `wake (${e.source})` : 'active', lastWake: lastWake?.source ?? null, sinceWakeMs: lastWake ? Math.round(s.now() - lastWake.at) : null })
    s.hide()
  }
  s.onActive(() => on({ kind: 'active' }))
  s.onWake((source) => on({ kind: 'wake', source, active: s.isActive() }))
}
