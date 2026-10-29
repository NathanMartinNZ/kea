// Session colours over an in-memory database: the pick at insert, the re-pick when a session comes back to the main
// list, the start-up backfill, and the store reading what is stored. `Sessions` runs with no terminals and no git.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger, ulid } from '@kea/kit'
import { L, type Lifecycle } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type KeaDb } from '../platform/db/db.ts'
import { PortBlocks } from '../server/ports.ts'
import type { Terminals } from '../terminal/terminals.ts'
import { RepoMutex } from '../worktrees/mutex.ts'
import { backfillColors, colorOf, keepOrRepick, pickColor, writeColor } from './colors.ts'
import { Projects } from './projects.ts'
import { insertSession } from './rows.ts'
import { Sessions } from './sessions.ts'

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c()
})

const log = createMemoryLogger({ process: 'core' })

function memory(): KeaDb {
  const { db } = openDatabase({ file: ':memory:', log })
  cleanup.push(() => db.abandon())
  return db
}

let at = 0
function project(db: KeaDb, name: string): string {
  const id = ulid()
  db.run('INSERT INTO projects (id, name, root_path, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', id, name, `/tmp/kea-colors/${name}`, ++at, at)
  return id
}

/** A session row as `insertSession` writes it (and so with the colour it picks). */
function session(db: KeaDb, projectId: string, lifecycle: Lifecycle = 'live', id = ulid()): string {
  const n = ++at
  db.tx(() =>
    insertSession(db, {
      id, projectId, slug: `s${n}`, title: `S${n}`, titleSource: 'auto', isolation: 'worktree', cwd: `/tmp/kea-colors/wt/s${n}`, worktreeRoot: null, branch: `kea/s${n}`,
      baseBranch: 'main', baseCommit: null, portBase: null, agent: 'shell', agentSessionId: null, transcriptPath: null, launchConfig: '{"prompt":""}',
      lifecycle, endReason: lifecycle === 'detached' || lifecycle === 'archived' ? 'stopped' : null, deletedAt: lifecycle === 'deleted' ? n : null, snapshotRef: null,
      creationStep: null, diskBytes: null, diskAt: null, sortOrder: -n, pinnedOrder: 0, createdAt: n, archivedAt: lifecycle === 'archived' ? n : null,
    }),
  )
  return id
}

const setLifecycle = (db: KeaDb, id: string, l: Lifecycle) => db.run('UPDATE sessions SET lifecycle = ? WHERE id = ?', l, id)
const state = (db: KeaDb, id: string) => db.get<{ state: string }>('SELECT state FROM session_ui WHERE session_id = ?', id)!.state

/** No terminal runs in these tests: the sessions' records are empty and nothing exits. */
const noTerminals = { exits: { event: () => ({ dispose() {} }) }, sessionRecords: () => [] } as unknown as Terminals

function open(db: KeaDb): Sessions {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-colors-')))
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }))
  const projects = new Projects({ db, log, gitReady: Promise.resolve(false) })
  cleanup.push(() => projects.dispose())
  const settings = { values: { get: () => undefined } } as unknown as ConstructorParameters<typeof Sessions>[0]['settings']
  const s = new Sessions({ db, log, home, projects, terminals: noTerminals, settings, mutex: new RepoMutex(), ports: new PortBlocks({ db, log }), git: Promise.resolve({ usable: false, missing: null }), env: () => Promise.resolve({}) })
  cleanup.push(() => s.dispose())
  return s
}

describe('session colours', () => {
  it('U-SB-7 · a fresh project\'s sessions take the colours in order, then start again; a freed colour is taken first; archived and deleted sessions do not count; projects count apart', () => {
    const db = memory()
    const a = project(db, 'a')
    const b = project(db, 'b')
    const ids = Array.from({ length: L.sessionColors + 2 }, () => session(db, a))
    expect(ids.map((id) => colorOf(db, id))).toEqual([...Array.from({ length: L.sessionColors }, (_, i) => i), 0, 1])
    // another project starts at the first colour, whatever the first one holds
    expect(colorOf(db, session(db, b))).toBe(0)
    // archiving the third session frees its colour: the next session takes it, the lowest of the least used
    setLifecycle(db, ids[2]!, 'archived')
    expect(colorOf(db, session(db, a))).toBe(2)
    // a deleted session's colour is free too; a failed creation's is not
    setLifecycle(db, ids[3]!, 'deleted')
    setLifecycle(db, ids[4]!, 'create_failed')
    expect(pickColor(db, a)).toBe(3)
    // every insert picks, whatever its lifecycle: an adopted worktree comes in detached, a rebuild's sessions as they were
    expect(colorOf(db, session(db, a, 'detached'))).toBe(3)
    const c = project(db, 'c')
    expect([session(db, c, 'archived'), session(db, c, 'live')].map((id) => colorOf(db, id))).toEqual([0, 0])
  })

  it('U-SB-7 · a session back in the main list keeps its colour while it is free, or while none is; otherwise it picks again, as one with no colour does', () => {
    const db = memory()
    const a = project(db, 'a')
    const [s0, s1] = [session(db, a), session(db, a)]
    setLifecycle(db, s1, 'archived')
    // its colour is free: kept
    keepOrRepick(db, s1, a)
    expect(colorOf(db, s1)).toBe(1)
    // another session took it meanwhile, and a colour is free: it picks the least used
    const s2 = session(db, a)
    expect(colorOf(db, s2)).toBe(1)
    setLifecycle(db, s1, 'detached')
    keepOrRepick(db, s1, a)
    expect(colorOf(db, s1)).toBe(2)
    // every colour taken: it keeps its own
    const full = project(db, 'full')
    const all = Array.from({ length: L.sessionColors }, () => session(db, full))
    const back = session(db, full, 'archived')
    expect(colorOf(db, back)).toBe(0)
    keepOrRepick(db, back, full)
    expect(colorOf(db, back)).toBe(0)
    expect(all).toHaveLength(L.sessionColors)
    // none stored: it picks
    db.run(`UPDATE session_ui SET state = '{}' WHERE session_id = ?`, s0)
    setLifecycle(db, s0, 'archived')
    keepOrRepick(db, s0, a)
    expect(colorOf(db, s0)).toBe(0)
  })

  it('U-SB-8 · sessions made before colours get theirs once at start, main list first in creation order, before the store is first read; setUi cannot write or drop the colour, nor count it in its cap', () => {
    const db = memory()
    const a = project(db, 'a')
    const ids = [session(db, a, 'archived'), session(db, a), session(db, a, 'detached'), session(db, a)]
    // as an older build left them: no colour, and one row with other panel state
    for (const id of ids) db.run(`UPDATE session_ui SET state = '{}' WHERE session_id = ?`, id)
    db.run(`UPDATE session_ui SET state = '{"files":{"expanded":["src"]},"tab":"agent"}' WHERE session_id = ?`, ids[3])
    const s = open(db)
    // the main list in the order it was made (1, 2, 3), then the archived one
    expect(ids.map((id) => colorOf(db, id))).toEqual([3, 0, 1, 2])
    expect(JSON.parse(state(db, ids[3]!))).toEqual({ files: { expanded: ['src'] }, tab: 'agent', color: 2 })
    // the store's first read already had them
    expect(ids.slice(1).map((id) => s.store.get(id)?.color)).toEqual([0, 1, 2])
    // once given, a colour is never picked again
    expect(backfillColors(db)).toBe(0)

    // setUi: the colour given is left out, a null does not remove it, and it does not count toward the cap
    s.setUi(ids[1]!, { color: 4, panel: 'x' })
    expect(colorOf(db, ids[1]!)).toBe(0)
    s.setUi(ids[1]!, { color: null })
    expect(colorOf(db, ids[1]!)).toBe(0)
    expect(JSON.parse(state(db, ids[1]!)).panel).toBe('x')
  })

  it('U-SB-8 · a stored colour that is not a whole number at least 0, or a state that is not JSON, reads as the first colour and never fails a read; a colour past the palette wraps', () => {
    const db = memory()
    const a = project(db, 'a')
    const [bad, text, broken, big] = [session(db, a), session(db, a), session(db, a), session(db, a)]
    db.run(`UPDATE session_ui SET state = '{"color":-1}' WHERE session_id = ?`, bad)
    db.run(`UPDATE session_ui SET state = '{"color":"blue"}' WHERE session_id = ?`, text)
    db.run(`UPDATE session_ui SET state = 'not json' WHERE session_id = ?`, broken)
    writeColor(db, big, L.sessionColors + 1)
    const s = open(db)
    expect([bad, text, big].map((id) => s.store.get(id)?.color)).toEqual([0, 0, 1])
    // a state that is not JSON has no colour: the start gives it one, and keeps nothing else of it
    expect(s.store.get(broken)?.color).toBe(colorOf(db, broken))
    expect(JSON.parse(state(db, broken))).toEqual({ color: colorOf(db, broken) })
    // a bad value counts for no colour when the next session picks: only the first two are taken
    expect(colorOf(db, broken)).toBe(0)
    expect(pickColor(db, a)).toBe(2)
  })
})
