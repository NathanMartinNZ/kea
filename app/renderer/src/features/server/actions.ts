// What the dev-server control and the Server commands do: each is one call to core, whose `server:<sessionId>` store
// then says what happened. A refusal with a place in the UI (the port-in-use hint under the control) says nothing here;
// one without gets the toast.

import type { ServerResult } from '@kea/protocol'
import { openExternal } from '../../lib/bridge.ts'
import { call } from '../../lib/rpc.ts'
import { copyText } from '../sessions/actions.ts'
import { failed, showToast } from '../sessions/state.svelte.ts'
import { wantTab } from '../status/viewing.svelte.ts'
import { activeView } from '../terminal/views.ts'
import { NO_START_SCRIPT, serverUp } from './model.ts'
import { serverOf } from './state.svelte.ts'

/** The server's terminal starts at the pane's size when a terminal is on screen (core has a default). */
function paneGrid(): { cols: number; rows: number } | undefined {
  return activeView()?.grid()
}

function refused(r: ServerResult): void {
  if (r.ok || r.reason === null || r.reason === 'portHeld') return // `portHeld`: the hint under the control says it
  const why = r.reason === 'nothingToRun' ? NO_START_SCRIPT : r.reason === 'notHeld' ? 'No dev server of Kea holds that port' : 'This session cannot run one now'
  showToast({ message: `Couldn't run the dev server: ${why}` })
}

/** Run. */
export async function runServer(sessionId: string): Promise<void> {
  try {
    refused(await call('server.run', { sessionId, grid: paneGrid() }))
  } catch (e) {
    failed("Couldn't run the dev server", e)
  }
}

/** Stop; on a server that is stopping, the second click: straight to `SIGKILL`. */
export async function stopServer(sessionId: string): Promise<void> {
  try {
    await call('server.stop', { sessionId })
  } catch (e) {
    failed("Couldn't stop the dev server", e)
  }
}

/** `⌘R`: stop the server that is there, else run one. */
export function toggleServer(sessionId: string): Promise<void> {
  return serverUp(serverOf(sessionId).state) ? stopServer(sessionId) : runServer(sessionId)
}

/** Stop, then Run. */
export async function restartServer(sessionId: string): Promise<void> {
  try {
    refused(await call('server.restart', { sessionId, grid: paneGrid() }))
  } catch (e) {
    failed("Couldn't restart the dev server", e)
  }
}

/** "Stop it and run here". */
export async function takeOverPort(sessionId: string): Promise<void> {
  try {
    refused(await call('server.takeOver', { sessionId, grid: paneGrid() }))
  } catch (e) {
    failed("Couldn't run the dev server", e)
  }
}

export function dismissHint(sessionId: string): void {
  void call('server.dismissHint', { sessionId }).catch(() => undefined)
}

/** The chip's click. Main opens it (http and https only; a test build records it instead). */
export function openInBrowser(url: string): void {
  openExternal(url)
}

/** The chip's Copy URL. */
export function copyUrl(url: string): void {
  void copyText(url)
}

/** The crashed chip and Show Server Log bring the Server tab on screen. */
export function showServerLog(sessionId: string): void {
  wantTab(sessionId, 'server')
}
