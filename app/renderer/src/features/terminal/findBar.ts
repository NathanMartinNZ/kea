// Opening and closing the find bar from the commands and from the bar itself (`FindBar.svelte`). The window has one
// bar and one query; the bar is docked on the terminal it searches, and opening it on another terminal moves it there
// with its query.

import { NO_RESULTS, openFindBar } from './find.ts'
import { terminalUi, uiState } from './ui.svelte.ts'
import { activeView, terminals } from './views.ts'

export function openFind(): void {
  const v = activeView()
  if (!v) return
  const was = uiState.find.ptyId
  if (was !== null && was !== v.ptyId) terminals.get(was)?.closeFind()
  terminalUi.find({ ptyId: v.ptyId })
  openFindBar(v, uiState.find, terminalUi.find)
}

/** The terminal the bar searches, while it is open. */
export function findView(): ReturnType<typeof activeView> {
  const id = uiState.find.open ? uiState.find.ptyId : null
  return id !== null ? terminals.get(id) : undefined
}

export function closeFind(): void {
  const v = findView() ?? activeView()
  v?.closeFind()
  terminalUi.find({ open: false, results: NO_RESULTS })
  v?.focus()
}
