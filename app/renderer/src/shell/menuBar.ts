// The window's side of menu-bar mode: main asks for the first-quit sheet on the first `⌘Q` while sessions run
// (`ui.sheet` `quit`, QuitSheet.svelte, which answers main), and asks the window to show a session on its Agent tab (a
// session picked in the menu-bar item's menu; a notification's click). A session asked for before the window lists it
// (a window just made) is shown once it is listed.

import { onQuitSheet, onShowSession } from '../lib/bridge.ts'
import { selectSession, sessions, ui } from '../features/sessions/state.svelte.ts'
import { wantAgentTab } from '../features/status/viewing.svelte.ts'

let wanted: string | null = null // bounded: the one session asked for and not listed yet
let installed = false

export function installMenuBar(): void {
  if (installed) return
  installed = true
  onQuitSheet((live, background) => {
    ui.sheet = { kind: 'quit', live, background }
  })
  onShowSession((id) => {
    wanted = null
    wantAgentTab(id)
    if (sessions.get(id)) selectSession(id)
    else wanted = id
  })
  sessions.subscribeList(() => {
    if (!wanted || !sessions.get(wanted)) return
    const id = wanted
    wanted = null
    selectSession(id)
  })
}
