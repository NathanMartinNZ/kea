// Which session the window is viewing, from what it shows (status's `isBeingViewed`), as a pure function: the window
// focused, the session selected, and its Agent terminal on screen. In the split that is its agent pane drawn, whatever
// the work pane shows; in one column its Agent tab is the tab on screen. A detached session with no Agent tab left
// counts while it is shown.

import type { PtyKind, ViewMode } from '@kea/protocol'

export interface ViewedInput {
  /** What the main pane shows: a session (its id), the composer or the plain shells. */
  pane: { kind: 'session'; id: string } | { kind: 'composer' | 'shells' }
  focused: boolean
  /** The session whose agent pane is drawn beside the work pane, else null. */
  agentPane: string | null
  /** The tab the terminal pane shows (the work pane's in the split): its session and kind, null for none. */
  shown: { context: string; kind: PtyKind | ViewMode | null } | null
  /** The session's agent is running (its lifecycle is `live`). */
  live: (id: string) => boolean
}

export function viewed(i: ViewedInput): string | null {
  const p = i.pane
  if (p.kind !== 'session' || !i.focused) return null
  if (i.agentPane === p.id) return p.id
  if (i.shown?.context !== p.id) return null
  if (i.shown.kind === 'agent') return p.id
  return i.shown.kind === null && !i.live(p.id) ? p.id : null
}
