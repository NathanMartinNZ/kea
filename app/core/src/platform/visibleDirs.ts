// Main's `kea-file://` handler serves a window only what lies in the working directory of the session that window
// shows. Core tells main that directory (`{ k: 'visible' }`, protocol process.ts):
//
//   when the window shows another session, or none      the visible set's change
//   when the directory of the session it shows changes   the `sessions` store: a session being created gets its
//                                                        worktree's path, one whose branch name was taken is moved
//
// Without the second, main would go on serving the folder the session had when it came on screen and refuse the one
// it has now, until the person switched away and back.

import path from 'node:path'
import type { Disposable } from '@kea/kit'
import type { KeyedStore, SessionView } from '@kea/protocol'
import type { VisibleScope, VisibleSet } from './visible.ts'

export interface VisibleDirsOptions {
  visible: VisibleSet
  sessions: Pick<KeyedStore<SessionView>, 'get' | 'onDelta'>
  /** The window connections: main's id for each, and its scope in the visible set (its RPC peer). */
  connections: ReadonlyMap<number, VisibleScope>
  /** Tell main the directories window `connId` may be served from (none: it shows no session). */
  send(connId: number, dirs: string[]): void
}

/** Keep main told. `windows`: the windows something is remembered for (the resource report). */
export function followVisibleDirs(o: VisibleDirsOptions): Disposable & { readonly windows: number } {
  // bounded: one entry per window connection that shows a session (what main was last told), dropped when it shows none
  const told = new Map<VisibleScope, string>()
  const dirsOf = (sessionId: string | null): string[] => {
    const dir = sessionId === null ? undefined : o.sessions.get(sessionId)?.cwd
    return dir && path.isAbsolute(dir) ? [dir] : []
  }
  const tell = (scope: VisibleScope, sessionId: string | null, always: boolean): void => {
    const dirs = dirsOf(sessionId)
    const key = dirs.join('\0')
    if (!always && told.get(scope) === key) return
    if (sessionId === null) told.delete(scope)
    else told.set(scope, key)
    for (const [connId, peer] of o.connections) if (peer === scope) o.send(connId, dirs)
  }
  const onVisible = o.visible.onChange(({ scope, sessionId }) => tell(scope, sessionId, true))
  const offSessions = o.sessions.onDelta((d) => {
    if (told.size === 0) return
    const changed = new Set([...Object.keys(d.set ?? {}), ...(d.del ?? [])])
    // only when the directory is another one than main was told: most changes of a session leave it alone
    for (const scope of [...told.keys()]) {
      const id = o.visible.of(scope)
      if (id !== null && changed.has(id)) tell(scope, id, false)
    }
  })
  return {
    get windows() {
      return told.size
    },
    dispose() {
      onVisible.dispose()
      offSessions()
      told.clear()
    },
  }
}
