// What the file viewer is given and what a tab keeps of its view. The main area's tab strip (`shell/tabs.ts`,
// `shell/TerminalPane.svelte`) owns the tabs — which exist, which is the preview, which is pinned, which is active —
// and mounts `Viewer.svelte` with the active one; the viewer owns what a tab shows and hands back the little it must
// keep while hidden. Plain data only: no document, no tokens, no editor object.

import type { ViewMode } from '@kea/protocol'

/** 1-based line and column (in a diff: of the new side). */
export interface TabPosition {
  line: number
  col: number
}

/** All a hidden tab keeps of its view. */
export interface TabViewState {
  /** The first visible line, the pixels scrolled past its top (a reload anchors on it), and the horizontal scroll. */
  scroll: { line: number; offset: number; left: number } | null
  /** Anchor and head (equal: a cursor). */
  selection: { anchor: TabPosition; head: TabPosition } | null
  /** Folded line ranges, first and last line; the strip keeps at most L.viewerTabFoldsMax of them. */
  folds: readonly { from: number; to: number }[]
}

export const EMPTY_VIEW: TabViewState = { scroll: null, selection: null, folds: [] }

/** The tab the viewer shows. */
export interface ViewerTab {
  /** Relative to the session's working directory. */
  path: string
  mode: ViewMode
  /** False: the preview tab. */
  pinned: boolean
  /** What it kept from the last time it was shown; `EMPTY_VIEW` for a tab never shown, and after its mode changed. */
  view: TabViewState
  /**
   * A position to land on (an open with a line, the `File · Diff` switch keeping its line), which wins over
   * `view.scroll`. It stays until the viewer saves the tab's view (`onview`), so: go there, then save.
   */
  goto: TabPosition | null
}

/**
 * `Viewer.svelte`'s props. One component instance serves every tab of its pane: `tab` changes under it when the active
 * file tab changes; it is mounted while a file tab is the active tab, and again by the next session's pane. The one
 * editor per window therefore lives outside the component, in a plain registry of this feature, and is attached into
 * whichever mount exists, as terminal views are (`features/terminal/views.ts`).
 *
 * Keys: the mount handles what the viewer leaves alone — `Esc` closes the tab (back to the Agent terminal) and `↵`
 * pins a preview — so the viewer calls `preventDefault()` on an `Esc` or `↵` it uses itself (its find widget, Go to
 * Line). Everything else that changes tabs is a command: `viewer.open` (another file, or this one in the other mode),
 * `viewer.pinTab`, `terminal.closeTab`.
 */
export interface ViewerProps {
  sessionId: string
  tab: ViewerTab
  /** Save what the tab keeps while hidden (on scroll end, selection or fold changes; before the tab is hidden). */
  onview: (view: TabViewState) => void
}
