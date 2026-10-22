// The file panel's selection: the file row the keyboard is on in the tree or the Changes list. The panel writes it;
// `viewer.open` run with no argument (the menu bar, the palette) opens it. A runes store: one small value,
// replaced, never mutated.

import type { ViewMode } from '@kea/protocol'

class PanelSelection {
  /** `mode`: `file` for a row of Files, `diff` for a row of Changes. Null: no file row is selected. */
  current = $state.raw<{ sessionId: string; path: string; mode: ViewMode } | null>(null)
}

export const panelSelection = new PanelSelection()
