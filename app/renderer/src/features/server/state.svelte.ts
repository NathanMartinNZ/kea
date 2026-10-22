// The window's copy of the dev server of the session on screen. Core keeps a `server:<sessionId>` store only while a
// window shows the session, so one store is followed at a time: the active session's, through `followSessionStore` (it
// tells core first, then subscribes). Until core's first answer the copy is `NO_SERVER`, which already means "nothing
// to run": the control stays hidden and the commands say why.
//
// A runes store: one small plain value; nothing heavy.

import { NO_SERVER, SERVER_ROW, type ServerView } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { watch } from '../../lib/reactive.svelte.ts'
import { call } from '../../lib/rpc.ts'
import { commands } from '../commands/registry.ts'
import { activeSessionId } from '../sessions/state.svelte.ts'
import { followSessionStore } from '../sessions/visible.ts'
import { viewingState } from '../status/viewing.svelte.ts'

class ServerState {
  /** The session `view` describes: the one on screen, or null. */
  sessionId = $state.raw<string | null>(null)
  view = $state.raw<ServerView>(NO_SERVER)
}

export const serverState = new ServerState()

/** The dev server of `sessionId` as the window knows it: `NO_SERVER` for any session but the one on screen. */
export function serverOf(sessionId: string | null): ServerView {
  return sessionId !== null && serverState.sessionId === sessionId ? serverState.view : NO_SERVER
}

/** The stores followed now: 0 or 1 (the resource report's `serverStores`). */
export function serverStores(): number {
  return unfollow ? 1 : 0
}

let unfollow: (() => void) | null = null

function follow(): void {
  const id = activeSessionId()
  if (id === serverState.sessionId) return
  unfollow?.()
  unfollow = null
  serverState.sessionId = id
  serverState.view = NO_SERVER
  if (id !== null) {
    unfollow = followSessionStore<ServerView>('server', id, (data) => {
      if (serverState.sessionId !== id) return
      serverState.view = data.get(SERVER_ROW) ?? NO_SERVER
      commands.changed()
    })
  }
  commands.changed()
}

/** The Server tab came on screen, so the ports are looked at once now. */
function scanWhenShown(): void {
  const shown = viewingState.shown
  if (shown?.kind === 'server') scanPorts(shown.context)
}

/** Ask core for one scan now (the Server tab or the port menu was opened). */
export function scanPorts(sessionId: string): void {
  void call('server.scan', { sessionId }).catch(() => undefined)
}

/** Follow the dev server of whichever session the window shows. Once per window. */
export function installServerState(): Disposable {
  const offs = [watch(activeSessionId, follow), watch(() => viewingState.shown, scanWhenShown)]
  follow()
  return {
    dispose() {
      for (const off of offs) off()
      unfollow?.()
      unfollow = null
      serverState.sessionId = null
      serverState.view = NO_SERVER
    },
  }
}
