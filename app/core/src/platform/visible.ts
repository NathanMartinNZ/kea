// The visible set: which session each window shows, told by the window (`visible.set`, protocol visible.ts)
// and dropped with its connection. The one source of "is this session on screen" in core: the watch service's
// worktree policy, the session-scoped stores (`tree:`, `git:`, `server:<sessionId>`), the git scheduler's
// priority, the finder index, port scans, the viewer's watches and main's `kea-file://` handler (core main.ts
// sends it each window's working directories) all read it or follow `onChange`. The status engine's "viewed"
// (`status.setViewing`: selected, focused and on the Agent tab) is a different, narrower fact and stays there.
//
// `onChange` listeners run inside `set` / `drop`, before the call returns: a producer registers or removes a
// session's stores there, so a subscription that follows `visible.set` on the same port finds them.

import type { Disposable, Logger } from '@kea/kit'

/** A window's connection scope: its RPC peer (any object that is one per window). */
export type VisibleScope = object

/** One window changed what it shows. */
export interface VisibleChange {
  scope: VisibleScope
  /** What that window shows now. */
  sessionId: string | null
  /** Sessions no window showed before and one shows now. */
  shown: readonly string[]
  /** Sessions a window showed before and none shows now. */
  hidden: readonly string[]
}

export class VisibleSet {
  // bounded: one entry per window connection showing a session, dropped with the connection
  private readonly byScope = new Map<VisibleScope, string>()
  // bounded: one per consumer built in core.ts (watch policy, session stores, server, viewer) plus core main.ts's message to main
  private readonly listeners = new Set<(c: VisibleChange) => void>()
  private readonly log: Logger | undefined

  constructor(log?: Logger) {
    this.log = log
  }

  /** The window `scope` shows `sessionId` now; null: no session. */
  set(scope: VisibleScope, sessionId: string | null): void {
    const was = this.byScope.get(scope) ?? null
    if (was === sessionId) return
    if (sessionId === null) this.byScope.delete(scope)
    else this.byScope.set(scope, sessionId)
    const shown = sessionId !== null && this.count(sessionId) === 1 ? [sessionId] : []
    const hidden = was !== null && this.count(was) === 0 ? [was] : []
    for (const l of [...this.listeners]) {
      try {
        l({ scope, sessionId, shown, hidden })
      } catch (e) {
        this.log?.warn('visible-set listener failed', { error: String(e) })
      }
    }
  }

  /** The window went (closed, reloaded, crashed): it shows nothing. */
  drop(scope: VisibleScope): void {
    this.set(scope, null)
  }

  /** Some window shows the session. */
  has(sessionId: string): boolean {
    return this.count(sessionId) > 0
  }

  /** The session window `scope` shows, if any. */
  of(scope: VisibleScope): string | null {
    return this.byScope.get(scope) ?? null
  }

  /** Every session some window shows, each once. */
  sessions(): string[] {
    return [...new Set(this.byScope.values())]
  }

  /** Windows showing a session (the resource report's `core.visible`). */
  get size(): number {
    return this.byScope.size
  }

  /** `cb` after each window's change, before the call that made it returns. A listener that throws is logged, not fatal. */
  onChange(cb: (c: VisibleChange) => void): Disposable {
    this.listeners.add(cb)
    return { dispose: () => void this.listeners.delete(cb) }
  }

  private count(sessionId: string): number {
    let n = 0
    for (const id of this.byScope.values()) if (id === sessionId) n++
    return n
  }
}
