import { describe, expect, it } from 'vitest'
import { OBSOLETE_SESSION_ENV_VARS, SESSION_ENV_VARS, scrubSessionEnv } from './env.ts'

/** The session variables, written out by hand: a variable added to env.ts must be added here too. */
const LISTED = [
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
]

describe('scrubSessionEnv', () => {
  it('U-FAIL-8 · removes every session variable Kea sets and the obsolete KEA_SOCK/KEA_SPOOL, in place, empty ones too, and names what it removed; everything else stays', () => {
    expect([...SESSION_ENV_VARS].sort()).toEqual([...LISTED].sort())
    expect([...OBSOLETE_SESSION_ENV_VARS].sort()).toEqual(['KEA_SOCK', 'KEA_SPOOL'])
    const session = Object.fromEntries([...LISTED, 'KEA_SOCK', 'KEA_SPOOL'].map((k, i) => [k, i === 0 ? '' : `v${i}`]))
    const keep = { PATH: '/usr/bin:/bin', HOME: '/Users/someone', SHELL: '/bin/zsh', KEA_TEST_APP_RUN: 'abc', KEA_SESSION: 'not a session variable', kea_session_id: 'case matters' }
    const env: Record<string, string | undefined> = { ...keep, ...session }
    const removed = scrubSessionEnv(env)
    expect(removed.sort()).toEqual(Object.keys(session).sort())
    expect(env, 'the same object, now without them').toEqual(keep)
  })

  it('U-FAIL-8 · an environment with no session variable is left as it is and nothing is reported', () => {
    const env = { PATH: '/usr/bin', HOME: '/Users/someone' }
    expect(scrubSessionEnv(env)).toEqual([])
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/someone' })
    expect(scrubSessionEnv({})).toEqual([])
  })
})
