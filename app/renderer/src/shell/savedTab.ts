// What a session remembers of its tabs, between the window and core. A session's active tab is kept with its saved
// panel state (`session_ui`, the `tabs` key, through `sessions.getUi` / `sessions.setUi`), so a window that was closed
// and reopened, a reload and a restart of Kea all find it; the window's own memory (`lastActive`) is gone by then. The
// window asks a session once, when it first shows it (and, as it opens, the session it is about to show again, so that
// one starts on its tab with nothing else drawn first), and from then on knows what core holds (`savedTab`,
// `terminalPane.ts`) and writes only a change. The model is `tabs.ts` (`TabMemory`).

import { call } from '../lib/rpc.ts'
import { parseTabMemory, savedTabs, type TabMemory } from './tabs.ts'
import { savedTab } from './terminalPane.ts'

const asking = new Map<string, Promise<boolean>>() // bounded: one per session whose answer is on its way, removed when it has come or failed

/**
 * Learn what the session remembers, unless the window knows it or is asking already. True once `savedTab` holds it;
 * false when core could not say (the session is gone, core went away): it is asked again when the session is shown next.
 */
export function askSavedTab(sessionId: string): Promise<boolean> {
  if (savedTab.has(sessionId)) return Promise.resolve(true)
  let p = asking.get(sessionId)
  if (!p) {
    p = call('sessions.getUi', { id: sessionId })
      .then(
        (r) => {
          savedTab.set(sessionId, parseTabMemory(r.state.tabs))
          return true
        },
        () => false,
      )
      .finally(() => asking.delete(sessionId))
    asking.set(sessionId, p)
  }
  return p
}

/** The session remembers `m` from now on (null: nothing, its Agent terminal). A save that fails leaves it unknown again. */
export function saveTab(sessionId: string, m: TabMemory | null): void {
  savedTab.set(sessionId, m)
  void call('sessions.setUi', { id: sessionId, state: { tabs: savedTabs(m) } }).catch(() => {
    if (savedTab.get(sessionId) === m) savedTab.delete(sessionId)
  })
}
