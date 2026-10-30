// The git facts other core code needs from the git scheduler, as an interface: the viewer and diff ask here for what to
// compare a file against and when to look again, instead of running their own status. The files service (service.ts
// `FilesService`) implements it; tests pass `StubGitFacts`, which knows nothing until told. The window reads the same
// facts from the `git:<sessionId>` store (protocol files.ts): the scheduler writes both from one status.

import type { Disposable } from '@kea/kit'
import type { DiffScope, GitEntry } from '@kea/protocol'

export interface GitFacts {
  /** The session's active scope; the `files.changesScope` setting until the session chose otherwise. */
  scope(sessionId: string): DiffScope
  /**
   * The commit a scope compares against, as a full object id: the merge base (`branch`), or `HEAD`'s commit
   * (`uncommitted`). Null when there is none: no commit yet, not a git repository, a session core does not know.
   */
  base(sessionId: string, scope: DiffScope): Promise<string | null>
  /** A path's entry in the active scope as of the last status; null when it is unchanged, or no status has run yet. */
  entry(sessionId: string, path: string): GitEntry | null
  /** `cb(sessionId)` after a session's status changed anything: an entry, the scope, a base. */
  onChange(cb: (sessionId: string) => void): Disposable
}

/** Knows nothing until told: every scope is `branch`, no base, no entry. Tests set what a session's status says. */
export class StubGitFacts implements GitFacts {
  private readonly scopes = new Map<string, DiffScope>() // bounded: what a test set (a stand-in for the files service)
  private readonly bases = new Map<string, string | null>() // bounded: as above; keyed `<sessionId> <scope>`
  private readonly entries = new Map<string, Map<string, GitEntry>>() // bounded: as above
  private readonly listeners = new Set<(sessionId: string) => void>() // bounded: one per consumer (the viewer service)

  scope(sessionId: string): DiffScope {
    return this.scopes.get(sessionId) ?? 'branch'
  }

  base(sessionId: string, scope: DiffScope): Promise<string | null> {
    return Promise.resolve(this.bases.get(`${sessionId} ${scope}`) ?? null)
  }

  entry(sessionId: string, path: string): GitEntry | null {
    return this.entries.get(sessionId)?.get(path) ?? null
  }

  onChange(cb: (sessionId: string) => void): Disposable {
    this.listeners.add(cb)
    return { dispose: () => void this.listeners.delete(cb) }
  }

  /** Tests: what the session's status says now; listeners are told once. */
  set(sessionId: string, facts: { scope?: DiffScope; bases?: Partial<Record<DiffScope, string | null>>; entries?: readonly GitEntry[] }): void {
    if (facts.scope) this.scopes.set(sessionId, facts.scope)
    for (const [scope, base] of Object.entries(facts.bases ?? {})) this.bases.set(`${sessionId} ${scope}`, base ?? null)
    if (facts.entries) this.entries.set(sessionId, new Map(facts.entries.map((e) => [e.path, e])))
    for (const l of [...this.listeners]) l(sessionId)
  }
}
