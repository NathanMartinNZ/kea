import { createMemoryLogger } from '@kea/kit'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type KeaDb } from '../platform/db/db.ts'
import { insertSession, type SessionRow } from '../sessions/rows.ts'
import { DbRecords, RoutedRecords } from './dbRecords.ts'
import { MemoryRecords, type TerminalRecord } from './records.ts'

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

function memory(): KeaDb {
  const { db } = openDatabase({ file: ':memory:', log: createMemoryLogger({ process: 'core' }) })
  cleanup.push(() => db.abandon())
  return db
}

let n = 0
function session(db: KeaDb, cwd: string): string {
  const id = `01K00000000000000000000S${String(++n).padStart(2, '0')}`
  if (!db.get('SELECT 1 AS x FROM projects')) db.tx(() => db.run("INSERT INTO projects (id, name, root_path, sort_order, created_at) VALUES ('01K00000000000000000000P01', 'p', '/repos/p', 1, 0)"))
  const row: SessionRow = {
    id, projectId: '01K00000000000000000000P01', slug: `s${n}`, title: 'S', titleSource: 'auto', isolation: 'inplace', cwd, worktreeRoot: null, branch: null,
    baseBranch: null, baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{}', lifecycle: 'live',
    endReason: null, deletedAt: null, snapshotRef: null, creationStep: null, diskBytes: null, diskAt: null, sortOrder: 0, pinnedOrder: 0, createdAt: 0, archivedAt: null,
  }
  db.tx(() => insertSession(db, row))
  return id
}

function rec(sessionId: string, over: Partial<TerminalRecord> = {}): TerminalRecord {
  n++
  return {
    ptyId: `r${String(n).padStart(9, '0')}`, sessionId, kind: 'agent', argv: ['/bin/cat', '--', 'a b'], cwd: '/ignored', title: null, holderPid: 10, holderStartedAt: 1,
    childPid: 11, cols: 80, rows: 24, state: 'running', exitCode: null, exitSignal: null, tabOrder: 0, createdAt: n, endedAt: null, ...over,
  }
}

describe('terminal records in the database', () => {
  it('U-PTY-56 · a session’s records round-trip through the ptys table with its cwd; a record of an unknown session is refused, all or nothing; deleting the session deletes them', () => {
    const db = memory()
    const r = new DbRecords(db)
    expect(r.loaded).toBe(true)
    const s = session(db, '/repos/p')
    const a = rec(s)
    const b = rec(s, { kind: 'shell', title: 'zsh', tabOrder: 1, state: 'exited', exitCode: 0, endedAt: 9 })
    r.putMany([a, b])
    expect(r.list()).toEqual([{ ...a, cwd: '/repos/p' }, { ...b, cwd: '/repos/p' }])
    r.put({ ...a, cols: 120, rows: 40, title: 'claude' })
    expect(r.get(a.ptyId)).toMatchObject({ cols: 120, rows: 40, title: 'claude', cwd: '/repos/p' })
    db.tx(() => db.run('UPDATE sessions SET cwd = ? WHERE id = ?', '/repos/q', s))
    expect(r.get(a.ptyId)?.cwd, 'the cwd is the session’s').toBe('/repos/q')

    const stray = rec('01K00000000000000000000S99')
    expect(() => r.putMany([rec(s), stray])).toThrow()
    expect(r.list(), 'nothing of the failed batch').toHaveLength(2)

    db.tx(() => db.run('DELETE FROM sessions WHERE id = ?', s))
    expect(r.list(), 'deleted with the session (invariant 5)').toEqual([])
  })

  it('U-PTY-56 · routed: the shells pseudo-session’s records live in the file, every session’s in the database; only the file’s part is rebuilt at reconciliation, and only when the file was lost', () => {
    const db = memory()
    const s = session(db, '/repos/p')
    const log = createMemoryLogger({ process: 'core' })
    const file = new MemoryRecords([])
    const routed = new RoutedRecords(file, new DbRecords(db), log)
    const shell = rec('shells', { kind: 'shell', cwd: '/tmp' })
    const agent = rec(s)
    routed.putMany([shell, agent])
    expect(file.list()).toEqual([shell])
    expect(db.all('SELECT id FROM ptys')).toEqual([{ id: agent.ptyId }])
    expect(routed.list().map((x) => x.ptyId).sort()).toEqual([shell.ptyId, agent.ptyId].sort())
    expect(routed.get(agent.ptyId)?.cwd).toBe('/repos/p')
    routed.delete(shell.ptyId)
    routed.delete(agent.ptyId)
    expect(routed.list()).toEqual([])

    expect(routed.loaded).toBe(true)
    expect([routed.rebuildsSession('shells'), routed.rebuildsSession(s)]).toEqual([false, false])
    const lost = new RoutedRecords(new MemoryRecords(), new DbRecords(db), log)
    expect([lost.loaded, lost.rebuildsSession('shells'), lost.rebuildsSession(s)], 'sessions are rebuilt from the holders before reconciling').toEqual([false, true, false])

    expect(() => routed.put(rec('01K00000000000000000000S99'))).toThrow()
    expect(log.entries.some((e) => e.msg.includes('were not written'))).toBe(true)
  })
})
