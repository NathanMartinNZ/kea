import { createMemoryLogger } from '@kea/kit'
import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusBatch } from '../platform/db/batch.ts'
import { openDatabase, type KeaDb } from '../platform/db/db.ts'
import { titleFromSlug } from './rows.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

function memory(): KeaDb {
  const { db } = openDatabase({ file: ':memory:', log: createMemoryLogger({ process: 'core' }) })
  cleanup.push(() => db.abandon())
  return db
}

describe('session titles', () => {
  it('U-SES-1 · slug → title: words split on hyphens, first letter capitalised ("fix-auth-redirect" → "Fix auth redirect")', () => {
    expect(titleFromSlug('fix-auth-redirect')).toBe('Fix auth redirect')
    expect(titleFromSlug('add-2fa')).toBe('Add 2fa')
    expect(titleFromSlug('refactor')).toBe('Refactor')
    expect(titleFromSlug('fix--double-hyphen-')).toBe('Fix double hyphen')
    expect(titleFromSlug('')).toBe('')
  })

  it('U-SES-2 · title_source moves auto → agent → user and never back: an agent title replaces auto and agent titles, never a user’s; the trigger refuses a backwards move', () => {
    const db = memory()
    db.tx(() => db.run(`INSERT INTO projects (id, name, root_path, sort_order, created_at) VALUES ('01K00000000000000000000P01', 'p', '/repos/p', 0, 0)`))
    const id = '01K00000000000000000000S01'
    db.tx(() =>
      db.run(
        `INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, worktree_root, agent, launch_config, lifecycle, end_reason, port_base, deleted_at, sort_order, created_at)
         VALUES (?, '01K00000000000000000000P01', 'fix-auth-redirect', 'Fix auth redirect', 'auto', 'worktree', '/wt/s', '/wt', 'claude', '{}', 'live', NULL, NULL, NULL, 0, 0)`,
        id,
      ),
    )
    const batch = new StatusBatch(db, { tickMs: L.storeTickMs })
    cleanup.push(() => batch.dispose())
    const title = () => db.get<{ title: string; title_source: string }>('SELECT title, title_source FROM sessions WHERE id = ?', id)!
    batch.queue({ sessionId: id, session: { title: { title: 'Agent named it', source: 'agent' } } })
    batch.flush()
    expect(title()).toEqual({ title: 'Agent named it', title_source: 'agent' })
    batch.queue({ sessionId: id, session: { title: { title: 'Agent renamed it', source: 'agent' } } })
    batch.flush()
    expect(title()).toEqual({ title: 'Agent renamed it', title_source: 'agent' })
    batch.queue({ sessionId: id, session: { title: { title: 'Mine', source: 'user' } } })
    batch.flush()
    expect(title()).toEqual({ title: 'Mine', title_source: 'user' })
    // an agent title after the user's is not written (and does not fail the batch)
    batch.queue({ sessionId: id, session: { title: { title: 'Agent again', source: 'agent' } } })
    batch.flush()
    expect(title()).toEqual({ title: 'Mine', title_source: 'user' })
    expect(() => db.tx(() => db.run(`UPDATE sessions SET title_source = 'auto' WHERE id = ?`, id))).toThrow(/title_source only moves/)
    expect(() => db.tx(() => db.run(`UPDATE sessions SET title_source = 'agent' WHERE id = ?`, id))).toThrow(/title_source only moves/)
  })
})
