// The window's part of the visible set: it tells core which session it shows (`visible.set`) — the session the
// main pane is on, whichever tab is active and whether or not the window has focus — so core follows that session's
// files, runs its git status first and registers its stores (`tree:`, `git:`, `server:<id>`).
//
// Order matters: core registers a session's stores inside `visible.set`, so the window says what it shows before it
// subscribes to them. `followSessionStore` does both in that order; on a new RPC port (a restarted core knows
// nothing) the set is sent before the stores are subscribed again (`onPortFirst`).

import { sessionStoreName } from '@kea/protocol'
import { watch } from '../../lib/reactive.svelte.ts'
import { callNow, onPortFirst, subscribe } from '../../lib/rpc.ts'
import { activeSessionId } from './state.svelte.ts'

let installed = false
/** What core was last told on the current port; undefined: nothing yet. */
let sent: string | null | undefined

function send(): void {
  const id = activeSessionId()
  if (id === sent) return
  // nothing is sent without a port: the port's arrival sends it (below)
  const r = callNow('visible.set', { sessionId: id })
  if (!r) return
  sent = id
  r.catch(() => undefined)
}

/** Tell core the session on screen, now and on every change; first thing on each new port. */
export function installVisible(): void {
  if (installed) return
  installed = true
  onPortFirst(() => {
    sent = undefined
    send()
  })
  watch(activeSessionId, send)
  send()
}

/**
 * Follow a session-scoped store of the session on screen (`tree:`, `git:`, `server:<sessionId>`). Core has the store
 * only while a window shows the session: this tells core first, then subscribes. The callback gets the store's copy and
 * the keys that changed (null after a snapshot), as `subscribe` gives them. Returns the function that stops following.
 */
export function followSessionStore<V>(kind: 'tree' | 'git' | 'server', sessionId: string, cb: (data: ReadonlyMap<string, V>, changed: readonly string[] | null) => void): () => void {
  send()
  return subscribe<V>(sessionStoreName(kind, sessionId), cb)
}
