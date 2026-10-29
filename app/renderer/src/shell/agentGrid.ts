// The grid a session's agent starts at, sent with every call that starts one (create, Skip, Retry, Start agent anyway,
// Resume, Restart, a creation's retry), so it starts at its pane's size and does not redraw at once. In the split it is
// the agent pane's: its width in columns at the saved font's cell, and the rows of a terminal on screen beside it (both
// panes are as tall), else the rows the window's height holds. In one column it is the terminal on screen's, as for a
// shell; with none (the composer), core keeps the last grid it was sent.

import { L } from '@kea/protocol'
import { SIZE_PX } from '@kea/ui/tokens'
import { prefs } from '../features/terminal/prefs.ts'
import { activeView, terminals } from '../features/terminal/views.ts'
import { paneCols } from './layout.ts'
import { cellWidth, layoutState } from './layoutStore.svelte.ts'

export function agentGrid(): { cols: number; rows: number } | undefined {
  const beside = (terminals.shown('agent') ?? terminals.shown('work') ?? activeView())?.grid()
  const s = layoutState.split
  if (!s) return beside
  const cols = Math.max(L.ptyMinCols, paneCols(s.agent, cellWidth(layoutState.layout), SIZE_PX.hairline))
  if (beside) return { cols, rows: beside.rows }
  const a = prefs.appearance()
  const tall = window.innerHeight - SIZE_PX.header - SIZE_PX['tab-strip'] - 2 * SIZE_PX['terminal-pad-y']
  return { cols, rows: Math.max(L.ptyMinRows, Math.floor(tall / Math.ceil(a.fontSize * a.lineHeight))) }
}
