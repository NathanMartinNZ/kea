// Typed fakes of core's `projects`, `sessions` and `terminals` store rows, for unit tests of the renderer's sessions
// feature. They are the protocol's own types (`Project`, `SessionView`), filled with plain defaults, so a change to the
// contract breaks the tests that build them; core's real store is not involved.

import { sessionGlyph, type Project, type PtyInfo, type SessionView } from '@kea/protocol'

let seq = 0
/** A ULID-shaped id (26 Crockford base-32 characters), unique per call. */
export function fakeId(prefix = '01J'): string {
  const n = String(++seq).padStart(26 - prefix.length, '0')
  return (prefix + n).slice(0, 26)
}

export function fakeProject(over: Partial<Project> = {}): Project {
  return {
    id: fakeId('01P'),
    name: 'demo',
    rootPath: '/tmp/demo',
    isGit: true,
    defaultBranch: 'main',
    sortOrder: 1,
    collapsed: false,
    settings: {},
    missing: false,
    trustConfirmed: false,
    createdAt: 1,
    restorable: 0,
    ...over,
  }
}

export function fakeSession(over: Partial<SessionView> = {}): SessionView {
  const base: SessionView = {
    id: fakeId('01S'),
    projectId: fakeId('01P'),
    slug: 'fix-auth-redirect',
    title: 'Fix auth redirect',
    titleSource: 'auto',
    isolation: 'worktree',
    cwd: '/tmp/wt/demo/fix-auth-redirect',
    branch: 'kea/fix-auth-redirect',
    baseBranch: 'main',
    baseCommit: null,
    portBase: null,
    agent: 'shell',
    agentSessionId: null,
    launch: {},
    lifecycle: 'live',
    endReason: null,
    sortOrder: 1,
    pinnedOrder: 0,
    createdAt: 1,
    archivedAt: null,
    diskBytes: null,
    diskAt: null,
    phase: 'idle',
    attention: [],
    background: false,
    failureKind: null,
    unread: false,
    lastActivityAt: 1,
    model: null,
    effort: null,
    permissionMode: null,
    costUsd: null,
    contextPct: null,
    glyph: 'idle',
    label: null,
    creation: null,
    setup: null,
    teardownFailed: false,
    worktreeMissing: false,
    serverRunning: false,
  }
  const s = { ...base, ...over }
  // the glyph is core's derivation unless a test sets it
  return over.glyph ? s : { ...s, glyph: sessionGlyph(s) }
}

/** `s` with runtime fields changed, its glyph derived again as core would. */
export function restatus(s: SessionView, over: Partial<SessionView>): SessionView {
  const n = { ...s, ...over }
  return { ...n, glyph: sessionGlyph(n) }
}

export function fakePty(over: Partial<PtyInfo> = {}): PtyInfo {
  return {
    ptyId: fakeId('p').slice(0, 10).toLowerCase(),
    sessionId: fakeId('01S'),
    kind: 'shell',
    state: 'running',
    holderPid: null,
    holderStartedAt: null,
    childPid: null,
    cwd: '/tmp/demo',
    argv: ['/bin/zsh'],
    cols: 80,
    rows: 24,
    exitCode: null,
    exitSignal: null,
    detached: false,
    title: null,
    ...over,
  }
}
