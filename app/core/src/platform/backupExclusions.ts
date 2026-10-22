// Kea's own folders and Time Machine. Rings and checkpoints can hold secrets a terminal printed and change constantly;
// logs, reports, the helper copies and a trash being emptied are nothing a restore needs. So `run/`, `sessions/`,
// `bin/`, `logs/` and `reports/` of the home, and `.kea-trash/` of every folder worktrees are made in, carry Time
// Machine's sticky exclusion. Worktrees themselves stay in backups (uncommitted work), except their rebuildable folders
// (worktrees/backup.ts).
//
// The attribute is written as for the worktrees' rebuildable folders (worktrees/backup.ts: `/usr/bin/xattr`, never
// `tmutil`), once per folder: what was marked is recorded in `kv` with the folder's device and inode, so a later
// launch runs nothing, a folder that appears later (`sessions/` and `bin/` with the first terminal, `reports/` with the
// first report, a trash with the first delete, the trash of a root the setting was moved to) is marked when it is first
// seen, and one that was deleted and made again (a new inode: the attribute went with the old one) is marked again. A
// symlink or a file by one of these names is never marked: the attribute would land on whatever the user put there.
//
// Core looks at launch (once startup has settled), when the settings change, when a session is made or deleted
// (`SessionsSeen`: never for a row that only changed), when the terminals change for as long as `sessions/` or `bin/`
// is still to be marked (both appear with the first terminal), and when a folder's maker says it made it: a worktree
// root's trash made by any move into it (kit's `moveToTrash` `made`: a removal of rebuildable folders, the prune of an
// archived session's, an orphan's Remove, the auto-clean of archived sessions, a delete), `reports/` made by the first
// report. A look reads the record and runs one `lstat` per folder; only a folder not yet recorded costs a
// process (one `xattr` per parent folder). Nothing is kept in memory between looks. If the writer fails, nothing more
// is tried until the next launch.

import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@kea/kit'
import { kvGet, kvSet, type KeaDb } from './db/db.ts'

/** The folders of `<KEA_HOME>` that never go into a backup. */
export const HOME_EXCLUDED = ['run', 'sessions', 'bin', 'logs', 'reports'] as const
/** A worktree root's trash (the name is worktrees/ops.ts `WORKTREE_TRASH`). */
export const ROOT_EXCLUDED = '.kea-trash'
/** Where the record is kept (a `kv` row). */
export const BACKUP_EXCLUDED_KEY = 'backup.excluded'

/**
 * Sets Time Machine's sticky exclusion on `names` in `dir`; resolves with how many were marked (0: none could be).
 * The real one is worktrees/backup.ts `excludeFromBackup`.
 */
export type ExcludeWriter = (dir: string, names: readonly string[]) => Promise<number>

export interface BackupExclusionsOptions {
  home: string
  db: KeaDb
  log: Logger
  /** Every folder worktrees are made in: the setting's, and each one a session still records. */
  roots: () => readonly string[]
  write: ExcludeWriter
}

/** A folder as the record knows it: a directory (never a link) by device and inode; null for anything else. */
function identity(p: string): string | null {
  try {
    const st = fs.lstatSync(p)
    return st.isDirectory() ? `${st.dev}:${st.ino}` : null
  } catch {
    return null
  }
}

/**
 * Which changes of the sessions store are worth a look: a session that is new to the store (it may record a worktree
 * root no session recorded before) and one that leaves it (its delete made its root's trash). Whatever else a
 * session's row does makes no folder: its status changes with every hook, and a look reads the database and runs an
 * `lstat` per folder.
 */
export class SessionsSeen {
  // bounded: one id per session in the store (≤ sessions), dropped when it leaves the store
  private readonly ids: Set<string>

  /** `ids`: the sessions in the store now. */
  constructor(ids: Iterable<string> = []) {
    this.ids = new Set(ids)
  }

  get size(): number {
    return this.ids.size
  }

  /** Whether a change of the store added a session not seen before or took one away (and remembers it). */
  changed(d: { set?: Readonly<Record<string, unknown>>; del?: readonly string[] }): boolean {
    let changed = false
    for (const id of d.del ?? []) changed = this.ids.delete(id) || changed
    for (const id of Object.keys(d.set ?? {})) {
      if (this.ids.has(id)) continue
      this.ids.add(id)
      changed = true
    }
    return changed
  }
}

export class BackupExclusions {
  private readonly o: BackupExclusionsOptions
  /** `sessions/` or `bin/` is still to be marked (they appear with the first terminal): the terminals are worth following. */
  private early = true
  /** The writer failed in this run: nothing more is tried until the next launch. */
  private gaveUp = false
  private running: Promise<void> | null = null
  private again = false
  private disposed = false

  constructor(o: BackupExclusionsOptions) {
    this.o = o
  }

  /** Whether a look could still mark `sessions/` or `bin/` in this run. */
  get awaitsFirstTerminal(): boolean {
    return this.early && !this.gaveUp && !this.disposed
  }

  /** The folders recorded as marked, with each one's device and inode (tests; nothing is kept in memory). */
  recorded(): Record<string, string> {
    return Object.fromEntries(this.read())
  }

  /** Look now; resolves when a look that began after this call has finished (looks never overlap). */
  look(): Promise<void> {
    if (this.disposed || this.gaveUp) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running.then(() => this.running ?? undefined)
    }
    this.running = this.run()
      .catch((e) => this.o.log.warn('Time Machine exclusions not checked', { error: String(e) }))
      .finally(() => {
        this.running = null
        if (this.again && !this.disposed) {
          this.again = false
          void this.look()
        }
      })
    return this.running
  }

  dispose(): void {
    this.disposed = true
  }

  private async run(): Promise<void> {
    // parent folder → the names in it to look at
    const wanted = new Map<string, string[]>([[this.o.home, [...HOME_EXCLUDED]]])
    for (const r of this.o.roots()) if (path.isAbsolute(r) && r !== this.o.home && !wanted.has(r)) wanted.set(r, [ROOT_EXCLUDED])
    // the record as it is now: one entry per folder marked, so at most HOME_EXCLUDED's five and one trash per root
    const marked = new Map(this.read())
    const seen = new Set<string>()
    let changed = false
    for (const [dir, names] of wanted) {
      const todo: { name: string; id: string }[] = []
      for (const name of names) {
        const p = path.join(dir, name)
        seen.add(p)
        const id = identity(p)
        // gone (or never a folder): if it comes back it is another folder, to be marked then
        if (id === null) changed = marked.delete(p) || changed
        else if (marked.get(p) !== id) todo.push({ name, id })
      }
      if (todo.length === 0 || this.gaveUp) continue
      const folders = todo.map((t) => t.name)
      const n = await this.o.write(dir, folders).catch((e: unknown) => {
        this.o.log.warn('Time Machine exclusion not set', { dir, error: String(e) })
        return 0
      })
      if (this.disposed) return
      if (n === todo.length) {
        for (const t of todo) marked.set(path.join(dir, t.name), t.id)
        changed = true
        this.o.log.info('excluded from Time Machine', { dir, folders })
      } else {
        this.gaveUp = true
        this.o.log.warn('Time Machine exclusion not set: tried again at the next launch', { dir, folders })
      }
    }
    // a root no session records any more and the setting no longer names: its entry goes
    for (const p of [...marked.keys()]) if (!seen.has(p)) changed = marked.delete(p) || changed
    this.early = !marked.has(path.join(this.o.home, 'sessions')) || !marked.has(path.join(this.o.home, 'bin'))
    if (changed) this.save(marked)
  }

  private read(): [string, string][] {
    try {
      const raw = kvGet(this.o.db, BACKUP_EXCLUDED_KEY)
      const v: unknown = raw ? JSON.parse(raw) : {}
      if (!v || typeof v !== 'object' || Array.isArray(v)) return []
      return Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')
    } catch {
      return [] // unreadable: everything is marked once more, which costs one `xattr` per parent folder
    }
  }

  private save(marked: ReadonlyMap<string, string>): void {
    try {
      kvSet(this.o.db, BACKUP_EXCLUDED_KEY, JSON.stringify(Object.fromEntries(marked)))
    } catch (e) {
      this.o.log.warn('Time Machine exclusions not recorded', { error: String(e) })
    }
  }
}
