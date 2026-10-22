// Kea's own folders and Time Machine: which folders are marked, that each is marked once and the mark recorded, and
// what makes a folder be marked again. The writer here only records what it was asked: no attribute is written
// (I-HOME-1 writes and reads the real one, on a temp home).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger, moveToTrash } from '@kea/kit'
import { isAvailable, KeyedStore } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { coreOs } from '../os/index.ts'
import { Reports } from '../status/reports.ts'
import { BACKUP_EXCLUDED_KEY, BackupExclusions, SessionsSeen, type ExcludeWriter } from './backupExclusions.ts'
import { kvGet, kvSet, openDatabase, type KeaDb } from './db/db.ts'

const cleanups: (() => unknown)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function temp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function database(): KeaDb {
  const { db } = openDatabase({ file: ':memory:', log: createMemoryLogger() })
  cleanups.push(() => db.close())
  return db
}

/** A writer that marks nothing: what it was asked, in order, as `<dir>/<name>` paths per call. */
function recorder(result: (dir: string, names: readonly string[]) => number | Promise<number> = (_d, names) => names.length) {
  const calls: string[][] = []
  const write: ExcludeWriter = async (dir, names) => {
    calls.push(names.map((n) => path.join(dir, n)))
    return result(dir, names)
  }
  return { calls, write }
}

const mk = (...parts: string[]): string => {
  const p = path.join(...parts)
  fs.mkdirSync(p, { recursive: true })
  return p
}

describe('Kea’s own folders stay out of Time Machine', () => {
  it('U-HOME-1 · the first launch of a home marks run/, sessions/, bin/, logs/, reports/ and the worktree trash that exist, one write per parent folder, and records it; later looks and later launches write nothing', async () => {
    const home = temp('kea-home-')
    const db = database()
    for (const d of ['run', 'sessions', 'bin', 'logs']) mk(home, d)
    mk(home, 'worktrees', '.kea-trash')
    mk(home, 'worktrees', 'project-0123', 'a-session') // a worktree: stays in backups
    fs.writeFileSync(path.join(home, 'kea.db'), '') // and so does the database
    const rec = recorder()
    const roots = () => [path.join(home, 'worktrees')]
    const first = new BackupExclusions({ home, db, log: createMemoryLogger(), roots, write: rec.write })
    expect(first.awaitsFirstTerminal).toBe(true)
    await first.look()
    expect(rec.calls).toEqual([['run', 'sessions', 'bin', 'logs'].map((d) => path.join(home, d)), [path.join(home, 'worktrees', '.kea-trash')]])
    expect(first.awaitsFirstTerminal, 'sessions/ and bin/ are marked').toBe(false)
    expect(Object.keys(first.recorded()).sort()).toEqual([...rec.calls.flat()].sort())
    for (const [p, id] of Object.entries(first.recorded())) expect(id, p).toBe(`${fs.statSync(p).dev}:${fs.statSync(p).ino}`)
    // the same run looks again (a session changed, the settings changed): nothing to do
    await first.look()
    await first.look()
    expect(rec.calls).toHaveLength(2)
    // the next launch: the record is read from the database, nothing is written
    const second = new BackupExclusions({ home, db, log: createMemoryLogger(), roots, write: rec.write })
    await second.look()
    expect(rec.calls).toHaveLength(2)
    expect(second.awaitsFirstTerminal).toBe(false)
  })

  // macOS only: it leans on APFS never handing an inode out twice, and Linux marks nothing for backups
  it.runIf(isAvailable(coreOs.backupExclude))('U-HOME-2 · a folder that appears later is marked when it is first seen, one made again is marked again, a link or a file by that name never; a moved worktree root’s trash is marked and a root no longer used leaves the record', async () => {
    const home = temp('kea-home-')
    const db = database()
    mk(home, 'run')
    mk(home, 'logs')
    let roots = [path.join(home, 'worktrees')]
    const rec = recorder()
    const x = new BackupExclusions({ home, db, log: createMemoryLogger(), roots: () => roots, write: rec.write })
    await x.look()
    expect(rec.calls).toEqual([[path.join(home, 'run'), path.join(home, 'logs')]])
    expect(x.awaitsFirstTerminal, 'sessions/ and bin/ come with the first terminal').toBe(true)

    // the first terminal: sessions/ and bin/; the first report; the first delete's trash
    mk(home, 'sessions')
    mk(home, 'bin')
    await x.look()
    expect(rec.calls[1]).toEqual([path.join(home, 'sessions'), path.join(home, 'bin')])
    expect(x.awaitsFirstTerminal).toBe(false)
    mk(home, 'reports')
    mk(home, 'worktrees', '.kea-trash')
    await x.look()
    expect(rec.calls.slice(2)).toEqual([[path.join(home, 'reports')], [path.join(home, 'worktrees', '.kea-trash')]])
    const baseline = Object.keys(x.recorded()).length
    expect(baseline).toBe(6)

    // logs/ deleted and made again: another folder (the attribute went with the old one), marked again
    const was = rec.calls.length
    fs.rmSync(path.join(home, 'logs'), { recursive: true })
    mk(home, 'logs')
    await x.look()
    expect(rec.calls.slice(was), 'between two looks: APFS never hands an inode out twice').toEqual([[path.join(home, 'logs')]])
    // and one that is gone leaves the record, so whatever comes back under its name is marked
    fs.rmSync(path.join(home, 'logs'), { recursive: true })
    await x.look()
    expect(Object.keys(x.recorded())).not.toContain(path.join(home, 'logs'))
    mk(home, 'logs')
    await x.look()
    expect(rec.calls.slice(was)).toEqual([[path.join(home, 'logs')], [path.join(home, 'logs')]])

    // a link or a file by one of the names: the attribute would land on something that is not Kea's
    const elsewhere = temp('kea-elsewhere-')
    fs.rmSync(path.join(home, 'reports'), { recursive: true })
    fs.symlinkSync(elsewhere, path.join(home, 'reports'))
    fs.rmSync(path.join(home, 'run'), { recursive: true })
    fs.writeFileSync(path.join(home, 'run'), 'a file')
    const before = rec.calls.length
    await x.look()
    expect(rec.calls).toHaveLength(before)
    expect(Object.keys(x.recorded()).sort()).toEqual(['bin', 'logs', 'sessions'].map((d) => path.join(home, d)).concat(path.join(home, 'worktrees', '.kea-trash')).sort())

    // the setting moves the worktree root; sessions made under the old one still record it: both trashes are looked at
    const moved = temp('kea-root-')
    roots = [moved, path.join(home, 'worktrees'), moved, 'relative/never', home]
    await x.look()
    expect(rec.calls, 'no trash under the new root yet').toHaveLength(before)
    mk(moved, '.kea-trash')
    await x.look()
    expect(rec.calls.slice(before)).toEqual([[path.join(moved, '.kea-trash')]])
    expect(Object.keys(x.recorded())).toContain(path.join(home, 'worktrees', '.kea-trash'))
    // the last session under the old root is gone: its entry leaves the record (the record does not grow with roots tried)
    for (let i = 0; i < 5; i++) {
      const r = temp('kea-root-')
      mk(r, '.kea-trash')
      roots = [r]
      await x.look()
      expect(Object.keys(x.recorded()).sort()).toEqual(['bin', 'logs', 'sessions'].map((d) => path.join(home, d)).concat(path.join(r, '.kea-trash')).sort())
    }
    expect(JSON.parse(kvGet(db, BACKUP_EXCLUDED_KEY)!)).toEqual(x.recorded())
  })

  it('U-HOME-3 · a write that fails is not recorded and nothing more is tried in that run; the next launch tries again; a record that cannot be read marks everything once more', async () => {
    const home = temp('kea-home-')
    const db = database()
    for (const d of ['run', 'sessions', 'bin', 'logs']) mk(home, d)
    mk(home, 'worktrees', '.kea-trash')
    const roots = () => [path.join(home, 'worktrees')]
    const log = createMemoryLogger()
    let fail = true
    const rec = recorder((_d, names) => (fail ? 0 : names.length))
    const x = new BackupExclusions({ home, db, log, roots, write: rec.write })
    await x.look()
    expect(rec.calls, 'the home’s folders failed: the trash is not tried either').toHaveLength(1)
    expect(x.recorded()).toEqual({})
    expect(kvGet(db, BACKUP_EXCLUDED_KEY)).toBeUndefined()
    expect(log.entries.filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual(['Time Machine exclusion not set: tried again at the next launch'])
    fail = false
    await x.look()
    mk(home, 'reports')
    await x.look()
    expect(rec.calls, 'not again in this run').toHaveLength(1)
    expect(x.awaitsFirstTerminal, 'the terminals are not followed for it either').toBe(false)

    // a writer that throws is a failure like any other
    const thrown = new BackupExclusions({ home, db, log: createMemoryLogger(), roots, write: () => Promise.reject(new Error('spawn EAGAIN')) })
    await thrown.look()
    expect(thrown.recorded()).toEqual({})

    // the next launch
    const next = new BackupExclusions({ home, db, log: createMemoryLogger(), roots, write: rec.write })
    await next.look()
    expect(rec.calls.slice(1)).toEqual([['run', 'sessions', 'bin', 'logs', 'reports'].map((d) => path.join(home, d)), [path.join(home, 'worktrees', '.kea-trash')]])
    expect(Object.keys(next.recorded())).toHaveLength(6)

    // a record nothing can be made of (another build's, a damaged row): everything is marked once more, then recorded
    for (const junk of ['not json', '[1,2]', '{"a":1}', 'null']) {
      kvSet(db, BACKUP_EXCLUDED_KEY, junk)
      const n = rec.calls.length
      const again = new BackupExclusions({ home, db, log: createMemoryLogger(), roots, write: rec.write })
      await again.look()
      expect(rec.calls.slice(n).flat(), junk).toHaveLength(6)
      expect(Object.keys(again.recorded()), junk).toHaveLength(6)
    }
  })

  it('U-HOME-4 · looks never overlap: asked while one runs, one more follows it and sees what appeared meanwhile; after dispose nothing is looked at or recorded', async () => {
    const home = temp('kea-home-')
    const db = database()
    mk(home, 'run')
    const gates: (() => void)[] = []
    const calls: string[][] = []
    const write: ExcludeWriter = (dir, names) => {
      calls.push(names.map((n) => path.join(dir, n)))
      return new Promise((r) => gates.push(() => r(names.length)))
    }
    const x = new BackupExclusions({ home, db, log: createMemoryLogger(), roots: () => [], write })
    const a = x.look()
    mk(home, 'logs') // appears while the first write is under way
    const b = x.look()
    const c = x.look()
    expect(calls).toEqual([[path.join(home, 'run')]])
    gates.shift()!()
    await a
    await expect.poll(() => calls.length).toBe(2)
    expect(calls[1]).toEqual([path.join(home, 'logs')])
    gates.shift()!()
    await Promise.all([b, c])
    expect(Object.keys(x.recorded()).sort()).toEqual([path.join(home, 'logs'), path.join(home, 'run')])
    expect(calls, 'two asks while one ran: one more look, not two').toHaveLength(2)

    // core is going while a write is under way: its answer is not recorded, and no look follows
    mk(home, 'bin')
    const d = x.look()
    await expect.poll(() => calls.length).toBe(3)
    x.dispose()
    gates.shift()!()
    await d
    expect(Object.keys(x.recorded())).toHaveLength(2)
    mk(home, 'sessions')
    await x.look()
    expect(calls).toHaveLength(3)
    expect(x.awaitsFirstTerminal).toBe(false)
  })

  // A look after every change of the sessions store would read the database and run half a dozen `lstat`s at every
  // status change of every session (a hook, a title), for folders that could not have appeared.
  it('U-HOME-5 · of the sessions store’s changes only a session that is new to it or that leaves it is worth a look: a row that changes (its status, its title) is not; 1 000 sessions coming and going leave nothing remembered', () => {
    const store = new KeyedStore<{ phase: string }>('sessions')
    store.set('A', { phase: 'idle' })
    const seen = new SessionsSeen(store.keys())
    const worth: boolean[] = []
    const off = store.onDelta((d) => worth.push(seen.changed(d)))
    store.set('A', { phase: 'working' }) // a status change
    store.set('A', { phase: 'ready' })
    expect(worth, 'a row that changes').toEqual([false, false])
    store.set('B', { phase: 'starting' }) // a session is made: a worktree root no session recorded before
    store.set('B', { phase: 'working' })
    expect(worth.slice(2)).toEqual([true, false])
    store.delete('A') // a session is deleted: its root's trash appeared with it
    expect(worth.slice(4)).toEqual([true])
    store.setMany([['B', { phase: 'ready' }], ['C', { phase: 'starting' }]]) // one of several is new
    store.replace({ C: { phase: 'idle' } }) // B left in a replace (a reload after a rebuild)
    store.replace({ C: { phase: 'working' } })
    expect(worth.slice(5)).toEqual([true, true, false])
    expect(seen.changed({ del: ['never-seen'] }), 'a session it never saw').toBe(false)
    expect(seen.changed({}), 'an empty change').toBe(false)
    expect(seen.size).toBe(1)
    for (let i = 0; i < 1000; i++) {
      store.set(`S${i}`, { phase: 'starting' })
      store.set(`S${i}`, { phase: 'working' })
      store.delete(`S${i}`)
    }
    store.delete('C')
    expect(seen.size, 'one id per session in the store, none left').toBe(0)
    expect(worth.filter(Boolean), 'B made, A gone, C made, B gone; each of the 1 000 made and gone; C gone').toHaveLength(4 + 2000 + 1)
    off()
  })

  // Core looks only when a session is made or deleted (`SessionsSeen`). A worktree root's trash first made by anything
  // else (Remove build folders, the prune of an archived session's, an orphan's Remove, the auto-clean) and the
  // `reports/` the first status report makes would otherwise stay in Time Machine until the next session was made or
  // deleted, a setting changed or Kea was launched again.
  it('U-HOME-6 · a worktree root’s .kea-trash and reports/ made mid-run are marked as they are made, with nothing else asking for a look: the move that makes the trash and the report that makes reports/ ask for one, and only when they made the folder', async () => {
    const home = temp('kea-home-')
    const root = temp('kea-root-')
    const db = database()
    const rec = recorder()
    const x = new BackupExclusions({ home, db, log: createMemoryLogger(), roots: () => [root], write: rec.write })
    await x.look() // the launch's look: none of these folders yet
    expect(rec.calls).toEqual([])
    // what core hands each maker of these folders (core.ts): a look
    const made: string[] = []
    const looks: Promise<void>[] = []
    const folderMade = (dir: string): void => {
      made.push(dir)
      looks.push(x.look())
    }

    // a build folder (or a worktree) moved into the root's trash: the first move makes the trash
    const trash = path.join(root, '.kea-trash')
    await moveToTrash(mk(root, 'wt', 'node_modules'), trash, { made: folderMade })
    await Promise.all(looks)
    expect(made).toEqual([trash])
    expect(rec.calls).toEqual([[trash]])
    // the next move finds it there: nothing is asked
    await moveToTrash(mk(root, 'wt', 'dist'), trash, { made: folderMade })
    expect(made).toEqual([trash])

    // the first status report makes reports/; the next finds it there
    const T = 1_790_000_000_000
    const id = '01K00000000000000000000S01'
    db.tx(() => {
      db.run('INSERT INTO projects (id, name, root_path, sort_order, created_at, trust_confirmed) VALUES (?, ?, ?, ?, ?, ?)', '01K00000000000000000000P01', 'p', '/repos/p', 0, T, 1)
      db.run(`INSERT INTO sessions (id, project_id, slug, title, title_source, isolation, cwd, agent, launch_config, lifecycle, sort_order, created_at) VALUES (?, ?, 's', 'T', 'auto', 'inplace', '/r', 'fake', '{}', 'live', 0, ?)`, id, '01K00000000000000000000P01', T)
    })
    const reports = new Reports({ home, db, log: createMemoryLogger(), version: '0.0.0-test', now: () => T, mono: () => 1n, flush: () => undefined, folderMade })
    const report = () => reports.write({ sessionId: id, expected: 'working', note: null, machine: null, unconfirmed: false })
    await report()
    await Promise.all(looks)
    expect(made).toEqual([trash, path.join(home, 'reports')])
    expect(rec.calls).toEqual([[trash], [path.join(home, 'reports')]])
    await report()
    expect(made).toHaveLength(2)
    await Promise.all(looks)
    expect(rec.calls).toHaveLength(2)
    expect(Object.keys(x.recorded()).sort()).toEqual([trash, path.join(home, 'reports')].sort())
  })
})
