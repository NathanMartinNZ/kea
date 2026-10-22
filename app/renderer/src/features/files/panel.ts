// What the file panel is given. The window (`shell/App.svelte`) owns the column, its header toggle
// `Files` / `Changes n`, the mode (`⌘⇧E` / `⌘⇧G`, persisted with the layout) and the panel as a focus region (F6);
// `FilePanel.svelte` fills the body under the header.
//
// Focus: the window focuses the first `[data-panel-focus]` element inside the body when the panel takes the keyboard
// (`⌘⇧E`, `⌘⇧G`, F6), and the header's mode button when the body has none. Mark the tree or the list (or its current
// row) with that attribute. While the keyboard is in the panel the key scope `file panel` applies.

import type { ViewMode } from '@kea/protocol'

export interface FilePanelProps {
  /** The session on screen; null while the main pane shows no session (the composer, the shells). */
  sessionId: string | null
  /** The header toggle's mode. */
  mode: 'files' | 'changes'
  /** The file or diff tab the main area shows for this session (to mark its row), if any. */
  activeFile: { path: string; mode: ViewMode } | null
  /** The count the header shows as `Changes n`: the changed files in the active scope; null for none. */
  onchanges: (n: number | null) => void
  /**
   * The session on screen was last looked at in this mode, which differs from the header's: the window takes it
   * (the mode is one value for the window; each session's own is kept with its panel state, `files.saveUi`).
   */
  onmode?: (mode: 'files' | 'changes') => void
}
