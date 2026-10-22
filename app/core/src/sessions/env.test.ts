import { L, OBSOLETE_SESSION_ENV_VARS, SESSION_ENV_VARS } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { sessionEnv, type EnvPurpose, type SessionEnvInput } from './env.ts'

const s: SessionEnvInput = {
  id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  slug: 'fix-auth',
  cwd: '/w/demo/fix-auth',
  branch: 'kea/fix-auth',
  baseBranch: 'origin/main',
  portBase: 20010,
  projectRoot: '/src/demo',
  projectSlug: 'demo',
  services: 'shared',
}

describe('the session environment', () => {
  it('U-WT-8 · every PTY gets the session variables with KEA_PORT_COUNT and both slugs; no socket or spool path; COMPOSE_PROJECT_NAME only per-session; the reasons only in setup and teardown; PORT only for the dev server', () => {
    const purposes: EnvPurpose[] = [{ kind: 'agent' }, { kind: 'shell' }, { kind: 'server' }, { kind: 'setup', reason: 'create' }, { kind: 'teardown', reason: 'delete' }]
    for (const p of purposes) {
      const env = sessionEnv(s, p)
      expect(env).toMatchObject({
        KEA_SESSION_ID: s.id,
        KEA_PROJECT_ROOT: '/src/demo',
        KEA_WORKTREE: '/w/demo/fix-auth',
        KEA_BRANCH: 'kea/fix-auth',
        KEA_BASE_BRANCH: 'origin/main',
        KEA_PROJECT_SLUG: 'demo',
        KEA_SESSION_SLUG: 'fix-auth',
        KEA_PORT: '20010',
        KEA_PORT_COUNT: String(L.portBlockSize),
      })
      for (const k of OBSOLETE_SESSION_ENV_VARS) expect(env).not.toHaveProperty(k)
      expect(env).not.toHaveProperty('COMPOSE_PROJECT_NAME')
      expect('KEA_SETUP_REASON' in env).toBe(p.kind === 'setup')
      expect('KEA_TEARDOWN_REASON' in env).toBe(p.kind === 'teardown')
      expect('PORT' in env).toBe(p.kind === 'server')
      // nothing outside the named session variables, except the dev server's PORT
      for (const k of Object.keys(env)) expect([...SESSION_ENV_VARS, 'PORT']).toContain(k)
    }
    expect(sessionEnv(s, { kind: 'server' }).PORT).toBe('20010')
    expect(sessionEnv(s, { kind: 'setup', reason: 'unarchive' }).KEA_SETUP_REASON).toBe('unarchive')
    expect(sessionEnv(s, { kind: 'teardown', reason: 'archive' }).KEA_TEARDOWN_REASON).toBe('archive')
    // per-session services get their own compose project
    expect(sessionEnv({ ...s, services: 'perSession' }, { kind: 'agent' }).COMPOSE_PROJECT_NAME).toBe('kea-demo-fix-auth')
    // in place: no branch variables; no block, no port variables
    const bare = sessionEnv({ ...s, branch: null, baseBranch: null, portBase: null }, { kind: 'server' })
    for (const k of ['KEA_BRANCH', 'KEA_BASE_BRANCH', 'KEA_PORT', 'KEA_PORT_COUNT', 'PORT']) expect(bare).not.toHaveProperty(k)
  })
})
