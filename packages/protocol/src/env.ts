// The session environment, named once: core injects these into every PTY of a session, and every Kea process removes
// them from its own environment at startup, so a Kea build started inside a session does not inherit that session's
// identity.

export const SESSION_ENV_VARS = [
  'KEA_SESSION_ID',
  'KEA_PROJECT_ROOT',
  'KEA_WORKTREE',
  'KEA_BRANCH',
  'KEA_BASE_BRANCH',
  'KEA_PROJECT_SLUG',
  'KEA_SESSION_SLUG',
  'KEA_PORT',
  'KEA_PORT_COUNT',
  'COMPOSE_PROJECT_NAME',
  'KEA_SETUP_REASON',
  'KEA_TEARDOWN_REASON',
] as const

/** Earlier designs exported these; they are still removed so an old session cannot leak them. */
export const OBSOLETE_SESSION_ENV_VARS = ['KEA_SOCK', 'KEA_SPOOL'] as const

/** Remove every session variable from `env` in place; returns the names that were present. */
export function scrubSessionEnv(env: Record<string, string | undefined>): string[] {
  const removed: string[] = []
  for (const k of [...SESSION_ENV_VARS, ...OBSOLETE_SESSION_ENV_VARS]) {
    if (k in env) {
      delete env[k]
      removed.push(k)
    }
  }
  return removed
}
