// Opening and closing the find bar from the commands and from the bar itself (`FindBar.svelte`).

import { NO_RESULTS, openFindBar } from './find.ts'
import { terminalUi, uiState } from './ui.svelte.ts'
import { activeView } from './views.ts'

export function openFind(): void {
  const v = activeView()
  if (!v) return
  openFindBar(v, uiState.find, terminalUi.find)
}

export function closeFind(): void {
  const v = activeView()
  v?.closeFind()
  terminalUi.find({ open: false, results: NO_RESULTS })
  v?.focus()
}
