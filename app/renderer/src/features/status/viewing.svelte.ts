// What the window is viewing, for status (`isBeingViewed`: the session selected, the window focused, its Agent tab the
// visible tab). Core starts the dwell (L.viewedDwellMs) when told, marks the session read, and keeps notifications off
// it; the window tells it on every change, and null when nothing is viewed (another tab, the composer, the
// window unfocused). A runes store: ids and small values only.
//
//   shown      the tab the terminal pane shows: its session and kind — a terminal's, or `file` / `diff` for a viewer
//              tab, which is never the Agent tab (`TerminalPane.svelte` reports it)
//   agentTab   a request to show a session's Agent tab (a notification's click or a menu-bar pick; a reference
//              sent from the viewer) or its Server tab (Show Server Log); the pane of that session follows it
//   focus      `document.hasFocus()`, or the test probes' stand-in (a test window can never take keyboard focus)

import type { PtyKind, ViewMode } from '@kea/protocol'
import { onCoreConnection } from '../../lib/bridge.ts'
import { watch } from '../../lib/reactive.svelte.ts'
import { call } from '../../lib/rpc.ts'
import { sessions, ui } from '../sessions/state.svelte.ts'

class ViewingState {
  focused = $state(false)
  shown = $state.raw<{ context: string; kind: PtyKind | ViewMode | null } | null>(null)
  agentTab = $state.raw<{ sessionId: string; seq: number; kind: 'agent' | 'server' } | null>(null)
}

export const viewingState = new ViewingState()

let focusOverride: boolean | null = null

/** The test probes' stand-in for keyboard focus (`__keaProbe.focus`); null follows the window. */
export function setFocusOverride(v: boolean | null): void {
  focusOverride = v
  viewingState.focused = v ?? document.hasFocus()
}

/** The terminal pane of `context` shows a tab of `kind` (null: none). */
export function reportShownTab(context: string, kind: PtyKind | ViewMode | null): void {
  const cur = viewingState.shown
  if (cur?.context === context && cur.kind === kind) return
  viewingState.shown = { context, kind }
}

/** The terminal pane of `context` went. */
export function clearShownTab(context: string): void {
  if (viewingState.shown?.context === context) viewingState.shown = null
}

/** Show this session's Agent tab (its pane follows the request). */
export function wantAgentTab(sessionId: string): void {
  wantTab(sessionId, 'agent')
}

/** Show the session's Agent or Server tab, once its pane lists it (the one way a feature brings a terminal tab on screen). */
export function wantTab(sessionId: string, kind: 'agent' | 'server'): void {
  viewingState.agentTab = { sessionId, kind, seq: (viewingState.agentTab?.seq ?? 0) + 1 }
}

/** The pane of `sessionId` takes a pending tab request for it: true once (the request is used up). */
export function takeAgentTab(sessionId: string): boolean {
  if (viewingState.agentTab?.sessionId !== sessionId) return false
  viewingState.agentTab = null
  return true
}

/** The session being viewed now, or null. A detached session with no Agent tab left counts when shown. */
export function viewedSession(): string | null {
  const p = ui.pane
  if (p.kind !== 'session' || !viewingState.focused) return null
  const shown = viewingState.shown
  if (shown?.context !== p.id) return null
  if (shown.kind === 'agent') return p.id
  return shown.kind === null && sessions.get(p.id)?.lifecycle !== 'live' ? p.id : null
}

let installed = false
let sent: string | null | undefined

function send(force = false): void {
  const id = viewedSession()
  if (!force && id === sent) return
  sent = id
  void call('status.setViewing', { id }).catch(() => undefined)
}

/** Follow the window's focus and what it shows; tell core (again after a core restart: its new engine knows nothing). */
export function installViewing(): void {
  if (installed) return
  installed = true
  const onFocus = () => {
    viewingState.focused = focusOverride ?? document.hasFocus()
  }
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onFocus)
  onFocus()
  watch(viewedSession, () => send())
  onCoreConnection((up) => {
    if (up) send(true)
  })
}
