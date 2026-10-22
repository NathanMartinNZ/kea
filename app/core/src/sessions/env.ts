// The session environment: what core adds to every PTY of a session (agent, shells, setup, teardown, dev server).
// Core's hook socket and the session's spool path are deliberately not here, so a program in the session is not handed
// a way to forge status events: Kea's own hooks get them as arguments.

import { L, type SERVICES_MODES } from '@kea/protocol'
import type { Env } from '../terminal/shellEnv.ts'

export interface SessionEnvInput {
  id: string
  slug: string
  /** The session's working directory (its worktree, or the project root in place). */
  cwd: string
  branch: string | null
  baseBranch: string | null
  portBase: number | null
  projectRoot: string
  projectSlug: string
  services: (typeof SERVICES_MODES)[number]
}

/** What the PTY is for: the reason variables go to setup and teardown only, `PORT` to the dev server only. */
export type EnvPurpose = { kind: 'agent' | 'shell' } | { kind: 'server' } | { kind: 'setup'; reason: 'create' | 'unarchive' | 'restore' } | { kind: 'teardown'; reason: 'archive' | 'delete' }

export function sessionEnv(s: SessionEnvInput, purpose: EnvPurpose): Env {
  const env: Env = {
    KEA_SESSION_ID: s.id,
    KEA_PROJECT_ROOT: s.projectRoot,
    KEA_WORKTREE: s.cwd,
    KEA_PROJECT_SLUG: s.projectSlug,
    KEA_SESSION_SLUG: s.slug,
  }
  if (s.branch) env.KEA_BRANCH = s.branch
  if (s.baseBranch) env.KEA_BASE_BRANCH = s.baseBranch
  if (s.portBase !== null) {
    env.KEA_PORT = String(s.portBase)
    env.KEA_PORT_COUNT = String(L.portBlockSize)
  }
  // only per-session services get their own compose project
  if (s.services === 'perSession') env.COMPOSE_PROJECT_NAME = `kea-${s.projectSlug}-${s.slug}`
  if (purpose.kind === 'setup') env.KEA_SETUP_REASON = purpose.reason
  if (purpose.kind === 'teardown') env.KEA_TEARDOWN_REASON = purpose.reason
  // the dev server's PORT is the block's first port
  if (purpose.kind === 'server' && s.portBase !== null) env.PORT = String(s.portBase)
  return env
}
