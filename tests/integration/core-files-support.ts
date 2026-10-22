// The files service under test: `FilesService` with the real watch service, a real database for the per-session panel
// state, real git (hermetic: no user or system config) and repositories from tools/repo-factory in temp directories.
// Sessions are rows of a `sessions` store set by hand: what the service reads of a session is its directory and its
// base. Used by the core-files and core-git suites in tests/integration, tests/chaos, tests/memory and tests/perf. The
// wiring into core (core.ts) is tested through the whole core (core-files-wiring.test.ts).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger, setGitBinary, type MemoryLogger } from '@kea/kit'
import { gitStoreName, KeyedStore, SimpleStoreRegistry, treeStoreName, type GitHead, type GitEntry, type GitRow, type Project, type SessionView, type TreeDir, type TreeHead, type TreeRow } from '@kea/protocol'
import { FilesService, type FilesOptions } from '@kea/core/src/files/service.ts'
import type { SessionFiles } from '@kea/core/src/files/session.ts'
import { openDatabase } from '@kea/core/src/platform/db/db.ts'
import { VisibleSet } from '@kea/core/src/platform/visible.ts'
import { Watcher, type WatcherOptions } from '@kea/core/src/platform/watch/watcher.ts'
import { fixtureGitEnv, tinyRepo, type FixtureRepo } from '@kea-tools/repo-factory/src/index.ts'
import { until } from '../support/holders.ts'

export interface FilesUnderTest {
  files: FilesService
  watcher: Watcher | null
  visible: VisibleSet
  stores: SimpleStoreRegistry
  sessions: KeyedStore<SessionView>
  projects: KeyedStore<Project>
  log: MemoryLogger
  /** Windows: each shows one session at a time. */
  windows: object[]
  /** A session whose working directory is `cwd` (a row in the stores and in the database). */
  session(id: string, cwd: string, o?: { baseBranch?: string | null; baseCommit?: string | null; projectId?: string }): void
  /** Window `w` shows the session (null: nothing). */
  show(id: string | null, w?: number): void
  s(id: string): SessionFiles
  tree(id: string): KeyedStore<TreeRow>
  git(id: string): KeyedStore<GitRow>
  dir(id: string, rel?: string): TreeDir | undefined
  names(id: string, rel?: string): string[]
  treeHead(id: string): TreeHead | undefined
  head(id: string): GitHead | undefined
  entries(id: string): Record<string, GitEntry>
  /** Letters by path, sorted: `{ 'src/a.ts': 'M' }`. */
  codes(id: string): Record<string, string>
  call<T = unknown>(method: string, args: object): Promise<T>
  /** The session has been read after being shown: the root is listed and (in a repository) a status has arrived. */
  ready(id: string): Promise<void>
  /** No refresh is running or waiting for the session. */
  idle(id: string): Promise<void>
  /** Status pipelines run for the session so far. */
  statusRuns(id: string): number
  dispose(): Promise<void>
}

const cleanups: (() => void)[] = []

export function tempDir(prefix = 'kea-files-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The tiny repo, removed at `cleanup()`. */
export function repo(name = 'demo'): FixtureRepo {
  const r = tinyRepo({ name })
  cleanups.push(() => r.dispose())
  return r
}

export function later(fn: () => void): void {
  cleanups.push(fn)
}

/** After each test: what `tempDir`, `repo` and `later` registered, last first. */
export function cleanup(): void {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c()
    } catch {
      // the next one still runs
    }
  }
  setGitBinary('git')
}

export const gitEnv = (): Record<string, string | undefined> => ({ ...fixtureGitEnv() })

/** git in a fixture repo or worktree, hermetic. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: fixtureGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}

/** A linked worktree of `root` on a new branch, beside it. */
export function linkedWorktree(root: string, name: string, base = 'HEAD'): string {
  const dir = path.join(path.dirname(root), name)
  gitIn(root, 'worktree', 'add', '-q', '-b', `kea/${name}`, dir, base)
  return dir
}

export function write(root: string, rel: string, content = 'x\n'): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), content)
}

export async function startFiles(o: { watcher?: WatcherOptions | false; files?: Partial<FilesOptions> } = {}): Promise<FilesUnderTest> {
  const home = tempDir('kea-files-home-')
  const log = createMemoryLogger({ process: 'core' })
  const { db } = openDatabase({ file: path.join(home, 'kea.db'), log })
  db.pragma('foreign_keys = OFF') // a `session_ui` row without its session: all the service reads and writes
  const visible = new VisibleSet(log)
  const watcher = o.watcher === false ? null : new Watcher({ log, ...o.watcher })
  const files = new FilesService({ log, db, visible, watcher, env: async () => gitEnv(), ...o.files })
  const stores = new SimpleStoreRegistry()
  const sessions = new KeyedStore<SessionView>('sessions')
  const projects = new KeyedStore<Project>('projects')
  projects.set('p1', { id: 'p1', settings: {} } as Project)
  files.bind({ sessions, projects, stores, gitUsable: Promise.resolve(true) })
  const handlers = files.handlers() as Record<string, (a: object, ctx: never) => unknown>
  const windows: object[] = Array.from({ length: 8 }, (_, i) => ({ window: i }))
  const t: FilesUnderTest = {
    files,
    watcher,
    visible,
    stores,
    sessions,
    projects,
    log,
    windows,
    session(id, cwd, more = {}) {
      if (!db.get('SELECT 1 FROM session_ui WHERE session_id = ?', id)) db.run('INSERT INTO session_ui (session_id) VALUES (?)', id)
      sessions.set(id, { id, projectId: more.projectId ?? 'p1', cwd, baseBranch: more.baseBranch ?? null, baseCommit: more.baseCommit ?? null, lifecycle: 'live' } as SessionView)
    },
    show: (id, w = 0) => visible.set(windows[w] as object, id),
    s(id) {
      const s = files.session(id)
      if (!s) throw new Error(`no files state is held for session ${id}`)
      return s
    },
    tree(id) {
      const s = stores.get(treeStoreName(id))
      if (!s) throw new Error(`tree:${id} is not registered`)
      return s as KeyedStore<TreeRow>
    },
    git(id) {
      const s = stores.get(gitStoreName(id))
      if (!s) throw new Error(`git:${id} is not registered`)
      return s as KeyedStore<GitRow>
    },
    dir: (id, rel = '') => t.tree(id).get(`/${rel}`) as TreeDir | undefined,
    names: (id, rel = '') => (t.dir(id, rel)?.entries ?? []).map((e) => e.name),
    treeHead: (id) => t.tree(id).get('head') as TreeHead | undefined,
    head: (id) => t.git(id).get('head') as GitHead | undefined,
    entries(id) {
      const out: Record<string, GitEntry> = {}
      for (const [k, v] of t.git(id).entries()) if (k.startsWith('/')) out[k.slice(1)] = v as GitEntry
      return out
    },
    codes: (id) => Object.fromEntries(Object.entries(t.entries(id)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, e]) => [p, e.code])),
    call: async <T>(method: string, args: object) => (await (handlers[method] as (a: object, ctx: never) => unknown)(args, {} as never)) as T,
    async ready(id) {
      await until(`session ${id} to be read`, () => {
        const head = t.treeHead(id)
        if (!head) return false
        if (head.missing) return true
        const state = t.head(id)?.state
        return t.dir(id) !== undefined && state !== undefined && state !== 'loading' && t.s(id).scheduler.idle
      })
    },
    async idle(id) {
      await until(`session ${id} to be idle`, () => files.session(id)?.scheduler.idle !== false)
    },
    statusRuns: (id) => files.session(id)?.statusCounters?.status ?? 0,
    async dispose() {
      files.dispose()
      watcher?.dispose()
      if (watcher) await until('the watch service’s streams to close', () => watcher.streams === 0)
      db.close()
    },
  }
  return t
}
