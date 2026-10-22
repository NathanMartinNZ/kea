// Projects, core side: the records in the database, the `projects` store the renderer subscribes to (snapshot +
// deltas) and the `projectsApi` calls.
//
//   add             realpath → git: a folder inside a repo registers the repo root, a linked worktree its main
//                   worktree, a bare repository its own folder (`is_git` 2, `Project.bare`), anything
//                   else is a non-git project; a root already registered returns that project
//   remove          refused while a session has a worktree on disk or a creation in progress or failed, and
//                   while sessions run unless "Stop and remove"; its sessions go through `releaseSessions` first (PTYs
//                   stopped, records and the snapshot refs of its deleted sessions dropped); nothing else in the
//                   repository is touched
//   rename, move, collapse · settings (JSON in `projects.settings`)
//   missing         roots are checked at launch and on `checkRoots`; "Locate…" re-registers the root, runs
//                   `git worktree repair` there (under the repo's mutex) and moves in-place sessions with it
//   initGit         "Initialise git…": `git init` in a non-git project's folder and one empty commit, then it is
//                   a git project
//
// Kea never writes into a project's repository except through the git operations the user triggers;
// `git worktree repair` only rewrites git's own worktree links.

import fs from 'node:fs'
import path from 'node:path'
import { git, ulid, type Logger } from '@kea/kit'
import {
  KeyedStore,
  PROJECTS_STORE,
  projectsApi,
  REGISTERED_AS,
  RpcError,
  zProjectSettings,
  type Handlers,
  type Project,
  type ProjectRemoval,
  type ProjectSettings,
} from '@kea/protocol'
import type { KeaDb } from '../platform/db/db.ts'
import { RepoMutex } from '../worktrees/mutex.ts'
import { bareRepository, canonicalAsync, inspectRepo, mainEntry } from '../worktrees/git.ts'
import { runningSessions, sessionIdsOf } from './rows.ts'

type Registered = (typeof REGISTERED_AS)[number]

type ProjectRow = {
  id: string
  name: string
  root_path: string
  is_git: number
  default_branch: string | null
  sort_order: number
  collapsed: number
  settings: string
  missing: number
  trust_confirmed: number
  created_at: number
}

const COLUMNS = 'id, name, root_path, is_git, default_branch, sort_order, collapsed, settings, missing, trust_confirmed, created_at'
const LIST = `SELECT ${COLUMNS} FROM projects ORDER BY sort_order, created_at`
const GET = `SELECT ${COLUMNS} FROM projects WHERE id = ?`
const BY_ROOT = `SELECT ${COLUMNS} FROM projects WHERE root_path = ?`
const INSERT = `INSERT INTO projects (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
const MAX_ORDER = 'SELECT max(sort_order) AS m FROM projects'

/** `projects.is_git`: 0 a plain folder, 1 a repository with a main worktree, 2 a bare repository. */
const isGitColumn = (r: Pick<ResolvedRoot, 'isGit' | 'bare'>): number => (r.bare ? 2 : r.isGit ? 1 : 0)

/**
 * The name a new project gets, its folder's. A bare repository's folder is named for git, not for people:
 * `demo.git` is `demo`, and a hidden one (`site/.bare`, `site/.git`) takes the name of the folder that holds it.
 */
export function defaultProjectName(r: Pick<ResolvedRoot, 'root' | 'bare'>): string {
  const own = path.basename(r.root)
  if (!r.bare) return own || r.root
  if (own.startsWith('.')) return path.basename(path.dirname(r.root)) || own || r.root
  return own.replace(/\.git$/, '') || own || r.root
}

/** What a folder registers as. */
export interface ResolvedRoot {
  root: string
  isGit: boolean
  /** A bare repository: `root` is the repository's own folder, and there is no main worktree. */
  bare: boolean
  registered: Registered
  /** The repository's git common directory (the `RepoMutex` key); null for a non-git folder. */
  commonDir: string | null
}

/**
 * Resolve a folder to the root it registers as. `gitUsable` false → a non-git folder. Throws `invalid_path` for
 * anything that is not an existing directory.
 */
export async function resolveRoot(p: string, gitUsable: boolean): Promise<ResolvedRoot> {
  let real: string
  try {
    real = await canonicalAsync(p)
    if (!(await fs.promises.stat(real)).isDirectory()) throw new Error('not a directory')
  } catch (e) {
    throw new RpcError('invalid_path', `${p}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such folder' : (e as Error).message}`)
  }
  const facts = gitUsable ? await inspectRepo(real).catch(() => null) : null
  if (!facts) {
    // no work tree here, yet a repository: a bare one (its folder, a folder inside it, or a folder whose `.git` file
    // names it)
    const bare = gitUsable ? await bareRepository(real).catch(() => null) : null
    if (bare) return { root: bare, isGit: true, bare: true, registered: bare === real ? 'asGiven' : 'repoRoot', commonDir: bare }
    return { root: real, isGit: false, bare: false, registered: 'asGiven', commonDir: null }
  }
  if (facts.linked) {
    // git lists the main worktree first; for a bare repository that entry is the repository itself
    const main = await mainEntry(real)
    if (main) return { root: main.path, isGit: true, bare: main.bare, registered: 'mainWorktree', commonDir: facts.commonDir }
  }
  return { root: facts.toplevel, isGit: true, bare: false, registered: facts.toplevel === real ? 'asGiven' : 'repoRoot', commonDir: facts.commonDir }
}

export interface ProjectsOptions {
  db: KeaDb
  log: Logger
  now?: () => number
  /** Resolves once Kea knows whether git can be run; false → non-git projects. */
  gitReady?: Promise<boolean>
  mutex?: RepoMutex
  /** What keeps the project from being removed and what removing it ends (the sessions' side). */
  removal?(projectId: string): Promise<ProjectRemoval>
  /**
   * End a removed project's sessions before their rows go — what still runs stopped, their records, state
   * directories and snapshot refs dropped. Throws, leaving every row, when one now blocks or a PTY could not be
   * stopped. Without it a project with sessions cannot be removed.
   */
  releaseSessions?(projectId: string, sessionIds: string[]): Promise<void>
  /** How many of the project's sessions are restorable (the sessions' side; 0 without it). */
  restorable?(projectId: string): number
  /** The environment "Initialise git…" runs git with (the login shell's, tests pin an identity). */
  gitEnv?: () => Promise<Record<string, string | undefined>>
}

/** The message of the empty commit "Initialise git…" makes. */
export const INIT_COMMIT_MESSAGE = 'Initial commit'

const lastLine = (stderr: string, code: number | null) => stderr.trim().split('\n').pop() || `exit ${code}`

export class Projects {
  /** `projects`: Project by id. */
  readonly store = new KeyedStore<Project>(PROJECTS_STORE)
  private readonly opts: ProjectsOptions
  private readonly db: KeaDb
  private readonly now: () => number
  private readonly mutex: RepoMutex
  /** Calls that change projects run one at a time (an add racing a locate cannot register one root twice). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: ProjectsOptions) {
    this.opts = opts
    this.db = opts.db
    this.now = opts.now ?? Date.now
    this.mutex = opts.mutex ?? new RepoMutex()
    this.reload()
  }

  /** Read every project again (after the database was rebuilt from the holders). */
  reload(): void {
    const same = (a: Project, b: Project) => JSON.stringify(a) === JSON.stringify(b)
    this.store.replace(Object.fromEntries(this.db.all<ProjectRow>(LIST).map((r) => [r.id, this.fromRow(r)])), same)
  }

  list(): Project[] {
    return [...this.store.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  }

  get(id: string): Project | undefined {
    return this.store.get(id)
  }

  handlers(): Handlers<typeof projectsApi> {
    return {
      'projects.add': ({ path: p }) => this.add(p),
      'projects.removePreview': ({ id }) => this.removal(id),
      'projects.remove': ({ id, stopSessions }) => this.remove(id, stopSessions === true),
      'projects.rename': ({ id, name }) => this.rename(id, name),
      'projects.move': async ({ id, index }) => {
        await this.move(id, index)
        return { ok: true }
      },
      'projects.setCollapsed': async ({ id, collapsed }) => {
        await this.setCollapsed(id, collapsed)
        return { ok: true }
      },
      'projects.locate': ({ id, path: p }) => this.locate(id, p),
      'projects.updateSettings': async ({ id, set, unset }) => ({ settings: await this.updateSettings(id, set ?? {}, unset ?? []) }),
      'projects.checkRoots': async () => ({ missing: await this.checkRoots() }),
      'projects.initGit': ({ id }) => this.initGit(id),
    }
  }

  /** Register a folder as a project, or return the one already registered at its root. */
  add(p: string): Promise<{ project: Project; existing: boolean; registered: Registered }> {
    return this.serially(async () => {
      const r = await resolveRoot(p, await this.gitUsable())
      const known = this.db.get<ProjectRow>(BY_ROOT, r.root)
      if (known) return { project: this.refresh(known.id), existing: true, registered: r.registered }
      const id = ulid(this.now())
      const order = (this.db.get<{ m: number | null }>(MAX_ORDER)?.m ?? 0) + 1
      this.db.tx(() => this.db.run(INSERT, id, defaultProjectName(r), r.root, isGitColumn(r), null, order, 0, '{}', 0, 0, this.now()))
      this.opts.log.info('project added', { id, root: r.root, registered: r.registered, isGit: r.isGit, bare: r.bare })
      return { project: this.refresh(id), existing: false, registered: r.registered }
    })
  }

  /** What removing the project would do. */
  async removal(id: string): Promise<ProjectRemoval> {
    this.require(id)
    return this.opts.removal ? this.opts.removal(id) : { blocking: [], running: runningSessions(this.db, id), restorable: 0 }
  }

  /** Remove the project, unless a session blocks it or runs without `stopSessions`. */
  remove(id: string, stopSessions: boolean): Promise<ProjectRemoval & { removed: boolean }> {
    return this.serially(async () => {
      const facts = await this.removal(id)
      if (facts.blocking.length || (facts.running.length && !stopSessions)) return { removed: false, ...facts }
      const sessions = sessionIdsOf(this.db, id)
      if (sessions.length) {
        if (!this.opts.releaseSessions) throw new RpcError('unavailable', 'sessions cannot be stopped yet')
        await this.opts.releaseSessions(id, sessions)
      }
      this.db.tx(() => this.db.run('DELETE FROM projects WHERE id = ?', id)) // cascades to its sessions (invariant 5)
      this.store.delete(id)
      this.opts.log.info('project removed', { id, sessions: sessions.length, restorableEnded: facts.restorable })
      return { removed: true, ...facts }
    })
  }

  /** Display only. */
  rename(id: string, name: string): Promise<{ project: Project }> {
    return this.serially(async () => {
      this.require(id)
      const n = name.trim()
      if (!n) throw new RpcError('invalid_args', 'a project name cannot be empty')
      this.db.tx(() => this.db.run('UPDATE projects SET name = ? WHERE id = ?', n, id))
      return { project: this.refresh(id) }
    })
  }

  /** To `index` of the current order (clamped). */
  move(id: string, index: number): Promise<void> {
    return this.serially(async () => {
      this.require(id)
      const others = this.list().filter((p) => p.id !== id)
      const at = Math.max(0, Math.min(index, others.length))
      const before = others[at - 1]?.sortOrder
      const after = others[at]?.sortOrder
      let order = before === undefined ? (after === undefined ? 1 : after - 1) : after === undefined ? before + 1 : (before + after) / 2
      const renumber = order === before || order === after || !Number.isFinite(order)
      this.db.tx(() => {
        if (renumber) {
          // out of room between two neighbours (floating point): renumber everything 1…n in the new order
          const ids = [...others.slice(0, at).map((p) => p.id), id, ...others.slice(at).map((p) => p.id)]
          ids.forEach((pid, i) => this.db.run('UPDATE projects SET sort_order = ? WHERE id = ?', i + 1, pid))
          order = at + 1
        } else this.db.run('UPDATE projects SET sort_order = ? WHERE id = ?', order, id)
      })
      if (renumber) for (const p of this.db.all<ProjectRow>(LIST)) this.refresh(p.id)
      else this.refresh(id)
    })
  }

  /** Collapse or expand the project in the sidebar, persisted. */
  setCollapsed(id: string, collapsed: boolean): Promise<void> {
    return this.serially(async () => {
      this.require(id)
      this.db.tx(() => this.db.run('UPDATE projects SET collapsed = ? WHERE id = ?', collapsed ? 1 : 0, id))
      this.refresh(id)
    })
  }

  /** Merge `set`, drop `unset`. */
  updateSettings(id: string, set: ProjectSettings, unset: readonly (keyof ProjectSettings)[]): Promise<ProjectSettings> {
    return this.serially(async () => {
      const cur = this.require(id).settings
      const next: Record<string, unknown> = { ...cur, ...set }
      for (const k of unset) delete next[k]
      const r = zProjectSettings.safeParse(next)
      if (!r.success) throw new RpcError('invalid_args', r.error.issues[0]?.message ?? 'invalid project settings')
      this.db.tx(() => this.db.run('UPDATE projects SET settings = ? WHERE id = ?', JSON.stringify(r.data), id))
      return this.refresh(id).settings
    })
  }

  /** Flag every project whose root is not a directory now (and clear the flag of those that are back). */
  checkRoots(): Promise<string[]> {
    return this.serially(async () => {
      const missing: string[] = []
      for (const p of this.list()) {
        const gone = await fs.promises.stat(p.rootPath).then(
          (s) => !s.isDirectory(),
          (e: NodeJS.ErrnoException) => e.code === 'ENOENT' || e.code === 'ENOTDIR',
        )
        if (gone) missing.push(p.id)
        if (gone !== p.missing) {
          this.db.tx(() => this.db.run('UPDATE projects SET missing = ? WHERE id = ?', gone ? 1 : 0, p.id))
          this.refresh(p.id)
          this.opts.log.info(gone ? 'project root missing' : 'project root back', { id: p.id, root: p.rootPath })
        }
      }
      return missing
    })
  }

  /** "Locate…": register a missing project's root at a new path. */
  locate(id: string, p: string): Promise<{ project: Project; registered: Registered; repaired: boolean }> {
    return this.serially(async () => {
      const cur = this.require(id)
      const r = await resolveRoot(p, await this.gitUsable())
      const other = this.db.get<ProjectRow>(BY_ROOT, r.root)
      if (other && other.id !== id) throw new RpcError('already_registered', `${r.root} is already the project ${other.name}`)
      let repaired = false
      if (r.isGit && r.commonDir) {
        // a worktree mutation, serialised per repository; linked worktrees point at the new location again
        const res = await this.mutex.run(r.commonDir, () => git(['worktree', 'repair'], { cwd: r.root, collect: true }))
        repaired = res.code === 0
        if (!repaired) this.opts.log.warn('git worktree repair failed', { id, root: r.root, code: res.code, stderr: res.stderr.slice(0, 500) })
      }
      this.db.tx(() => {
        this.db.run('UPDATE projects SET root_path = ?, is_git = ?, missing = 0 WHERE id = ?', r.root, isGitColumn(r), id)
        this.db.run(`UPDATE sessions SET cwd = ? WHERE project_id = ? AND isolation = 'inplace'`, r.root, id)
      })
      this.opts.log.info('project located', { id, from: cur.rootPath, to: r.root, repaired })
      return { project: this.refresh(id), registered: r.registered, repaired }
    })
  }

  /**
   * "Initialise git…": the user asked for `git init` in the project's folder and one empty commit
   * (`INIT_COMMIT_MESSAGE`), made with their own git identity and no hooks, so a worktree session can start at once. A
   * repository that appeared there meanwhile gets no commit. Without a configured identity the `git init` stays, the
   * project is a git project, and the call fails `git_failed` saying so (the composer's "no commit yet" takes over).
   */
  initGit(id: string): Promise<{ project: Project }> {
    return this.serially(async () => {
      const cur = this.require(id)
      if (cur.isGit) return { project: cur }
      if (!(await this.gitUsable())) throw new RpcError('git_failed', 'git is not available (install the Xcode command line tools)')
      // a folder already in a repository (added while git was missing) is never given a nested one
      const before = await resolveRoot(cur.rootPath, true)
      if (before.isGit && before.root !== cur.rootPath) throw new RpcError('git_failed', `${cur.rootPath} is inside the repository ${before.root}: add that folder instead`)
      const env = await this.gitEnv()
      if (!before.isGit) {
        const res = await git(['init'], { cwd: cur.rootPath, env, collect: true })
        if (res.code !== 0) throw new RpcError('git_failed', `git init failed: ${lastLine(res.stderr, res.code)}`)
      }
      const after = await resolveRoot(cur.rootPath, true)
      if (!after.isGit || after.root !== cur.rootPath) throw new RpcError('git_failed', `${cur.rootPath} is not a repository root after git init`)
      // a bare repository registered as a plain folder (by a build without bare repositories) is a git project from
      // here on
      this.db.tx(() => this.db.run('UPDATE projects SET is_git = ? WHERE id = ?', isGitColumn(after), id))
      this.opts.log.info('git initialised', { id, root: cur.rootPath, created: !before.isGit, bare: after.bare })
      const project = this.refresh(id)
      if (!before.isGit) await this.initialCommit(cur.rootPath, env)
      return { project }
    })
  }

  /**
   * The empty first commit after "Initialise git…". The identity must be configured (`user.useConfigOnly`: git's
   * guess from the user and host names is not the user's identity); no hook runs and nothing is signed (a signing
   * prompt would block an empty commit Kea makes).
   */
  private async initialCommit(root: string, env: Record<string, string | undefined>): Promise<void> {
    const strict = ['-c', 'user.useConfigOnly=true']
    for (const who of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      const id = await git([...strict, 'var', who], { cwd: root, env, readOnly: true, collect: true })
      if (id.code !== 0) {
        this.opts.log.warn('no git identity: the first commit was not made', { root })
        throw new RpcError('git_failed', 'the repository was created, but git has no user name and email to make its first commit with: set them (git config --global user.name and user.email), then commit once to start worktree sessions')
      }
    }
    const res = await git([...strict, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '--no-verify', '-q', '-m', INIT_COMMIT_MESSAGE], { cwd: root, env, collect: true })
    if (res.code !== 0) throw new RpcError('git_failed', `the repository was created, but its first commit failed: ${lastLine(res.stderr, res.code)}`)
    this.opts.log.info('first commit made', { root })
  }

  /** Cache the detected default branch, per project; `settings.baseBranch` overrides it. */
  setDefaultBranch(id: string, branch: string): void {
    if (!this.store.has(id)) return
    this.db.tx(() => this.db.run('UPDATE projects SET default_branch = ? WHERE id = ?', branch, id))
    this.refresh(id)
  }

  /** A project's restorable sessions changed (a delete, a restore, the purge): its row is read again. */
  refreshRestorable(id: string): void {
    if (this.store.has(id)) this.refresh(id)
  }

  /** The `core.projects` gauge. */
  get resourceCounts(): { projects: number; repoLocks: number } {
    return { projects: this.store.size, repoLocks: this.mutex.size }
  }

  dispose(): void {
    this.store.dispose()
  }

  private async gitUsable(): Promise<boolean> {
    return (await this.opts.gitReady) ?? true
  }

  /** The environment the user's own git commands run with: the login shell's, as for sessions. */
  private async gitEnv(): Promise<Record<string, string | undefined>> {
    return this.opts.gitEnv ? await this.opts.gitEnv() : process.env
  }

  private require(id: string): Project {
    const p = this.store.get(id)
    if (!p) throw new RpcError('not_found', `no project ${id}`)
    return p
  }

  /** Re-read one row into the store; returns it. */
  private refresh(id: string): Project {
    const row = this.db.get<ProjectRow>(GET, id)
    if (!row) {
      this.store.delete(id)
      throw new RpcError('not_found', `no project ${id}`)
    }
    const p = this.fromRow(row)
    const cur = this.store.get(id)
    if (!cur || JSON.stringify(cur) !== JSON.stringify(p)) this.store.set(id, p)
    return p
  }

  private fromRow(r: ProjectRow): Project {
    let settings: ProjectSettings = {}
    try {
      const parsed = zProjectSettings.safeParse(JSON.parse(r.settings))
      if (parsed.success) settings = parsed.data
      else this.opts.log.warn('project settings invalid; defaults used', { id: r.id, error: parsed.error.issues[0]?.message })
    } catch {
      this.opts.log.warn('project settings unreadable; defaults used', { id: r.id })
    }
    return {
      id: r.id,
      name: r.name,
      rootPath: r.root_path,
      isGit: r.is_git !== 0,
      ...(r.is_git === 2 ? { bare: true } : {}),
      defaultBranch: r.default_branch,
      sortOrder: r.sort_order,
      collapsed: r.collapsed !== 0,
      settings,
      missing: r.missing !== 0,
      trustConfirmed: r.trust_confirmed !== 0,
      createdAt: r.created_at,
      restorable: this.opts.restorable?.(r.id) ?? 0,
    }
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }
}
