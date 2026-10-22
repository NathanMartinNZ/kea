// The git operations of the worktree pipeline: creating, removing and restoring a session's worktree. Each takes a
// `Repo`: the main checkout, the common git dir (the key of the repository's mutex) and the environment git runs with
// (the login shell's, so the user's hooks find their tools). Every call goes through kit's `git()`; mutations of
// the worktree list run under the repository's mutex. Kea never touches the main checkout's working tree:
// every command that writes runs in the session's worktree or only writes refs and objects.

import fs from 'node:fs'
import path from 'node:path'
import { git, GitCommandError, gitText, type ProcessResult } from '@kea/kit'
import { L } from '@kea/protocol'
import type { RepoMutex } from './mutex.ts'
import { INITIALIZING_LOCK, parseWorktreeList, type WorktreeEntry } from './porcelain.ts'

export type GitEnv = Record<string, string | undefined>

export interface Repo {
  /** The main checkout (the project root). */
  root: string
  /** The common git directory (`git rev-parse --git-common-dir`): the key of the repository's mutex. */
  commonDir: string
  env: GitEnv
  mutex: RepoMutex
}

/**
 * A worktree root's trash directory, where a removed worktree goes before it is deleted: a name of Kea's own;
 * only ULID-named entries in it are Kea's.
 */
export const WORKTREE_TRASH = '.kea-trash'

/** The identity of Kea's snapshot commits: internal refs, never pushed, never signed. */
const SNAPSHOT_IDENTITY = { GIT_AUTHOR_NAME: 'Kea', GIT_AUTHOR_EMAIL: 'kea@localhost', GIT_COMMITTER_NAME: 'Kea', GIT_COMMITTER_EMAIL: 'kea@localhost' }

const out = (r: ProcessResult) => (r.stdout ?? Buffer.alloc(0)).toString('utf8')
const ok = (r: ProcessResult) => r.code === 0 && !r.timedOut && !r.cancelled && !r.truncated

async function read(repo: Pick<Repo, 'env'>, cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  return gitText(args, { cwd, readOnly: true, env: repo.env, ...(timeoutMs ? { timeoutMs } : {}) })
}

async function tryRead(repo: Pick<Repo, 'env'>, cwd: string, args: string[]): Promise<string | null> {
  const r = await git(args, { cwd, readOnly: true, env: repo.env, collect: true })
  return ok(r) ? out(r).trim() : null
}

/** A ref or rev resolves to a commit: its SHA, or null. */
export function resolveCommit(repo: Pick<Repo, 'env'>, cwd: string, rev: string): Promise<string | null> {
  return tryRead(repo, cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])
}

export async function branchExists(repo: Pick<Repo, 'env'>, cwd: string, branch: string): Promise<boolean> {
  return (await resolveCommit(repo, cwd, `refs/heads/${branch}`)) !== null
}

/** `git check-ref-format --branch`. */
export async function validBranchName(repo: Pick<Repo, 'env'>, cwd: string, branch: string): Promise<boolean> {
  if (branch.startsWith('-')) return false
  const r = await git(['check-ref-format', '--branch', branch], { cwd, readOnly: true, env: repo.env, collect: true })
  return ok(r)
}

export async function listWorktrees(repo: Pick<Repo, 'env' | 'root'>): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await read(repo, repo.root, ['worktree', 'list', '--porcelain', '-z']))
}

/** Local branches checked out in a worktree: branch → path. */
export async function checkedOutBranches(repo: Pick<Repo, 'env' | 'root'>): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  for (const w of await listWorktrees(repo)) if (w.branch && !w.bare) m.set(w.branch, w.path)
  return m
}

export async function hasRemote(repo: Pick<Repo, 'env' | 'root'>, name: string): Promise<boolean> {
  const r = await tryRead(repo, repo.root, ['remote'])
  return (r ?? '').split('\n').includes(name)
}

/**
 * Default-branch detection: `origin/HEAD` → if missing or stale, `git remote set-head origin --auto` (network, capped
 * by L.fetchTimeoutMs) → `init.defaultBranch` → `main` → `master` → the current HEAD.
 */
export async function detectDefaultBranch(repo: Pick<Repo, 'env' | 'root'>): Promise<string | null> {
  const remote = await hasRemote(repo, 'origin')
  const fromOriginHead = async () => {
    const h = await tryRead(repo, repo.root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (!h || !h.startsWith('origin/')) return null
    return (await resolveCommit(repo, repo.root, `refs/remotes/${h}`)) ? h.slice('origin/'.length) : null // stale: points at nothing
  }
  if (remote) {
    const b = await fromOriginHead()
    if (b) return b
    await git(['remote', 'set-head', 'origin', '--auto'], { cwd: repo.root, env: repo.env, timeoutMs: L.fetchTimeoutMs, collect: true })
    const again = await fromOriginHead()
    if (again) return again
  }
  const exists = async (b: string) => (await branchExists(repo, repo.root, b)) || (remote && (await resolveCommit(repo, repo.root, `refs/remotes/origin/${b}`)) !== null)
  const init = await tryRead(repo, repo.root, ['config', '--get', 'init.defaultBranch'])
  for (const b of [init, 'main', 'master']) if (b && (await exists(b))) return b
  return tryRead(repo, repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

export interface ResolvedBase {
  /** The SHA the worktree starts from (`base_commit`). */
  commit: string
  /** `base_branch`: what the Changes view diffs against; null for a tag or SHA. */
  baseBranch: string | null
  /** An existing branch checked out as-is (no new branch). */
  existing: string | null
  notices: string[]
}

export class BaseError extends Error {}

/** Resolve the composer's base choice. */
export async function resolveBase(
  repo: Repo,
  choice: { kind: 'default' | 'head' | 'ref' | 'existing'; ref?: string | undefined },
  defaultBranch: string | null,
  bare: boolean,
): Promise<ResolvedBase> {
  const notices: string[] = []
  switch (choice.kind) {
    case 'default': {
      const d = defaultBranch
      if (!d) throw new BaseError('the repository has no default branch to start from')
      if (await hasRemote(repo, 'origin')) {
        const fetched = await repo.mutex.run(repo.commonDir, () =>
          git(['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', d], { cwd: repo.root, env: repo.env, timeoutMs: L.fetchTimeoutMs, collect: true }),
        )
        const cached = await resolveCommit(repo, repo.root, `refs/remotes/origin/${d}`)
        if (cached) {
          if (!ok(fetched)) notices.push(`using cached origin/${d} (fetch ${fetched.timedOut ? 'timed out' : 'failed'})`)
          return { commit: cached, baseBranch: `origin/${d}`, existing: null, notices }
        }
        notices.push(`origin/${d} not available; using the local ${d}`)
      }
      const local = await resolveCommit(repo, repo.root, `refs/heads/${d}`)
      if (!local) throw new BaseError(`the default branch ${d} does not exist`)
      return { commit: local, baseBranch: d, existing: null, notices }
    }
    case 'head': {
      if (bare) throw new BaseError('a bare repository has no current HEAD to start from')
      const c = await resolveCommit(repo, repo.root, 'HEAD')
      if (!c) throw new BaseError('the main checkout has no commit yet')
      const b = await tryRead(repo, repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      return { commit: c, baseBranch: b, existing: null, notices }
    }
    case 'ref': {
      const ref = choice.ref ?? ''
      const c = ref ? await resolveCommit(repo, repo.root, ref) : null
      if (!c) throw new BaseError(`${ref || 'the base'} does not name a commit`)
      const isBranch = (await resolveCommit(repo, repo.root, `refs/heads/${ref}`)) !== null || (await resolveCommit(repo, repo.root, `refs/remotes/${ref}`)) !== null
      return { commit: c, baseBranch: isBranch ? ref : null, existing: null, notices }
    }
    case 'existing': {
      const b = choice.ref ?? ''
      const c = b ? await resolveCommit(repo, repo.root, `refs/heads/${b}`) : null
      if (!c) throw new BaseError(`there is no branch ${b}`)
      const at = (await checkedOutBranches(repo)).get(b)
      if (at) throw new BaseError(`${b} is already checked out at ${at}`)
      return { commit: c, baseBranch: defaultBranch && defaultBranch !== b ? defaultBranch : null, existing: b, notices }
    }
  }
}

export interface AddResult {
  /** Git itself succeeded but a hook of the user's failed: the output goes to the creation log. */
  hookFailed: boolean
  output: string
}

/**
 * Add the worktree: under the repo mutex, `git worktree prune`, then
 * `git worktree add --no-track -b <branch> <path> <commit>` (or `git worktree add <path> <branch>` for an existing
 * branch). A non-zero exit with the worktree in place, unlocked and on its branch is a failed `post-checkout` hook:
 * logged, not fatal.
 */
export async function addWorktree(repo: Repo, o: { path: string; branch: string; commit: string; existing: boolean; signal?: AbortSignal }): Promise<AddResult> {
  return repo.mutex.run(repo.commonDir, async () => {
    await git(['worktree', 'prune'], { cwd: repo.root, env: repo.env, collect: true })
    const args = o.existing ? ['worktree', 'add', '--', o.path, o.branch] : ['worktree', 'add', '--no-track', '-b', o.branch, '--', o.path, o.commit]
    const r = await git(args, { cwd: repo.root, env: repo.env, timeoutMs: L.gitCheckoutTimeoutMs, collect: true, ...(o.signal ? { signal: o.signal } : {}) })
    const output = `${out(r)}${r.stderr}`.trim()
    if (ok(r)) return { hookFailed: false, output }
    if (r.code !== null && !r.timedOut && !r.cancelled) {
      const entry = (await listWorktrees(repo).catch(() => [])).find((w) => samePath(w.path, o.path))
      if (entry && entry.locked === null && entry.branch === o.branch && fs.existsSync(path.join(o.path, '.git'))) return { hookFailed: true, output }
    }
    throw new GitCommandError(args, r)
  })
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

/**
 * The rollback of a failed creation, touching only what this creation made: `git worktree unlock` (an add killed
 * midway leaves a locked "initializing" entry `prune` skips), `git worktree remove --force` of that Kea-created path
 * (or prune when its directory is gone), then `git branch -D` only if the branch was created here and its tip still
 * equals `baseCommit`.
 */
export async function rollbackAdd(repo: Repo, o: { path: string; branch: string | null; baseCommit: string | null; createdBranch: boolean }): Promise<{ branchDeleted: boolean }> {
  return repo.mutex.run(repo.commonDir, async () => {
    const entry = (await listWorktrees(repo).catch(() => [])).find((w) => samePath(w.path, o.path) || w.path === o.path)
    if (entry) {
      if (entry.locked !== null) await git(['worktree', 'unlock', '--', entry.path], { cwd: repo.root, env: repo.env, collect: true })
      const r = await git(['worktree', 'remove', '--force', '--', entry.path], { cwd: repo.root, env: repo.env, collect: true })
      if (!ok(r) && fs.existsSync(entry.path)) await fs.promises.rm(entry.path, { recursive: true, force: true })
    } else if (fs.existsSync(o.path) && !fs.existsSync(path.join(o.path, '.git'))) {
      // a directory the add made before it registered anything
      await fs.promises.rm(o.path, { recursive: true, force: true })
    }
    await git(['worktree', 'prune'], { cwd: repo.root, env: repo.env, collect: true })
    let branchDeleted = false
    if (o.createdBranch && o.branch && o.baseCommit) {
      const tip = await resolveCommit(repo, repo.root, `refs/heads/${o.branch}`)
      if (tip === o.baseCommit) {
        const d = await git(['branch', '-D', '--', o.branch], { cwd: repo.root, env: repo.env, collect: true })
        branchDeleted = ok(d)
      }
    }
    return { branchDeleted }
  })
}

/** Unlock `initializing` entries an interrupted add left and prune. */
export async function unlockInitializing(repo: Repo, keep: (p: string) => boolean): Promise<string[]> {
  return repo.mutex.run(repo.commonDir, async () => {
    const unlocked: string[] = []
    for (const w of await listWorktrees(repo).catch(() => [])) {
      if (w.locked !== INITIALIZING_LOCK || keep(w.path)) continue
      await git(['worktree', 'unlock', '--', w.path], { cwd: repo.root, env: repo.env, collect: true })
      unlocked.push(w.path)
    }
    if (unlocked.length) await git(['worktree', 'prune'], { cwd: repo.root, env: repo.env, collect: true })
    return unlocked
  })
}

export async function pruneWorktrees(repo: Repo): Promise<void> {
  await repo.mutex.run(repo.commonDir, () => git(['worktree', 'prune'], { cwd: repo.root, env: repo.env, collect: true }))
}

/**
 * The worktree's uncommitted files: `git status --porcelain` entries, tracked changes and untracked files not ignored,
 * one per path whatever the user's git config: rename detection off (a rename is its deletion and its new file) and
 * every untracked file listed on its own (`--untracked-files=all`, never a folder as one entry, and never hidden by
 * `status.showUntrackedFiles`). The restore sheet counts a snapshot the same way (`snapshotFiles`).
 */
export async function countUncommitted(repo: Pick<Repo, 'env'>, wt: string): Promise<number> {
  const s = await read(repo, wt, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'])
  return s.split('\0').filter(Boolean).length
}

/**
 * What of `wt`'s untracked, not-ignored entries a snapshot cannot keep ("not recoverable"): files larger than
 * the limit, and folders that are repositories of their own (git lists them as `<dir>/` and would store a gitlink — or
 * fail on one with no commit — so their files and history are not in the snapshot).
 */
export async function unsnapshottable(repo: Pick<Repo, 'env'>, wt: string): Promise<{ oversize: { path: string; bytes: number }[]; nested: string[] }> {
  const files = (await read(repo, wt, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
  const sized: { path: string; bytes: number | null }[] = []
  const nested: string[] = []
  for (const f of files) {
    if (f.endsWith('/')) {
      const dir = f.replace(/\/+$/, '')
      if (fs.existsSync(path.join(wt, dir, '.git'))) nested.push(dir)
      continue
    }
    try {
      const st = await fs.promises.lstat(path.join(wt, f))
      sized.push({ path: f, bytes: st.isFile() ? st.size : null })
    } catch {
      // gone meanwhile
    }
  }
  return { oversize: snapshotPlan(sized).oversize, nested: nested.sort() }
}

/**
 * Untracked, not-ignored files of `wt` larger than L.snapshotUntrackedMaxBytes: left out of the snapshot ("not
 * recoverable").
 */
export async function oversizeUntracked(repo: Pick<Repo, 'env'>, wt: string): Promise<{ path: string; bytes: number }[]> {
  return (await unsnapshottable(repo, wt)).oversize
}

/**
 * What a delete snapshot leaves out (U-WT-2), from the worktree's untracked, not-ignored files (`ls-files
 * --others --exclude-standard`; `bytes` null for anything but a regular file): files over the size limit, listed for the
 * confirmation and excluded by literal pathspec, as are `nested` repositories. Ignored files never go in: `add -A`
 * without `--force` skips them.
 */
export function snapshotPlan(untracked: readonly { path: string; bytes: number | null }[], limit: number = L.snapshotUntrackedMaxBytes, nested: readonly string[] = []): { oversize: { path: string; bytes: number }[]; addArgs: string[] } {
  const oversize = untracked.filter((f): f is { path: string; bytes: number } => f.bytes !== null && f.bytes > limit).map((f) => ({ path: f.path, bytes: f.bytes }))
  return { oversize, addArgs: ['add', '-A', '--', '.', ...[...oversize.map((f) => f.path), ...nested].map((p) => `:(exclude,literal)${p}`)] }
}

/**
 * The branch a restore checks out (U-WT-2): the session's own when it still points at the snapshot's parent
 * (checked out as it is) or was deleted (made again at the parent); when the name now points elsewhere (reused or moved
 * on), `<branch>-restored`, then `-restored-2`, `-restored-3`… — the first free one.
 */
export function restoreBranch(o: { branch: string; tip: string | null; parent: string; taken: ReadonlySet<string> }): { branch: string; existing: boolean } {
  if (o.tip === o.parent) return { branch: o.branch, existing: true }
  if (o.tip === null) return { branch: o.branch, existing: false }
  let branch = `${o.branch}-restored`
  for (let n = 2; o.taken.has(branch); n++) branch = `${o.branch}-restored-${n}`
  return { branch, existing: false }
}

export interface BranchFacts {
  uncommittedFiles: number
  /** Commits on HEAD that no remote-tracking ref holds (the "unpushed work" auto-clean looks for). */
  unpushedCommits: number
  /** Commits only the session's branch holds: no other local branch and no remote-tracking ref has them. */
  ownCommits: number
  /** Commits on HEAD that its base does not have (0 when the base does not resolve: see `baseResolved`). */
  uniqueCommits: number
  merged: boolean
  /** The base still names a commit; when it does not, nothing is known about what the branch adds (not merged). */
  baseResolved: boolean
}

/**
 * The numbers the delete dialog shows for a worktree. Uncommitted files: `git status --porcelain`. The commits
 * lost if `branch` goes: `git rev-list refs/heads/<branch> --not --exclude=<branch> --branches --remotes`, HEAD's
 * when the branch is gone. Unpushed: `HEAD --not --remotes`. Then `<base>..HEAD`, and whether the branch is
 * merged, a squash merge included.
 */
export async function branchFacts(repo: Pick<Repo, 'env'>, wt: string, base: string | null, branch: string | null = null): Promise<BranchFacts> {
  const uncommittedFiles = await countUncommitted(repo, wt)
  const unpushedCommits = Number((await tryRead(repo, wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])) ?? 0)
  const own = branch && (await branchExists(repo, wt, branch)) ? ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', '--remotes'] : ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes']
  const ownCommits = Number((await tryRead(repo, wt, own)) ?? 0)
  let uniqueCommits = 0
  let merged = false
  const baseResolved = !!base && (await resolveCommit(repo, wt, base)) !== null
  if (base && baseResolved) {
    uniqueCommits = Number((await tryRead(repo, wt, ['rev-list', '--count', `${base}..HEAD`])) ?? 0)
    merged = uniqueCommits === 0
    if (!merged) {
      // A squash-merged branch has no patch that the base lacks
      const cherry = await tryRead(repo, wt, ['cherry', base, 'HEAD'])
      merged = cherry !== null && !cherry.split('\n').some((l) => l.startsWith('+'))
    }
  }
  return { uncommittedFiles, unpushedCommits, ownCommits, uniqueCommits, merged, baseResolved }
}

/** `refs/kea/deleted/<sessionId>`. */
export const snapshotRef = (sessionId: string) => `refs/kea/deleted/${sessionId}`

/** The message of a snapshot commit. */
const snapshotMessage = (slug: string) => `kea: snapshot of ${slug} before delete`
const SNAPSHOT_MESSAGE_RE = /^kea: snapshot of .+ before delete$/

/**
 * What the worktree's uncommitted work is as a tree, without touching the worktree, its index or its branch (a copy of
 * the index, `git add -A` into it, `write-tree`), untracked files over the limit left out, ignored files never in: HEAD,
 * and the tree (null when nothing is uncommitted).
 */
async function uncommittedTree(repo: Repo, o: { wt: string; sessionId: string; tmpDir: string }): Promise<{ head: string; tree: string | null; oversize: { path: string; bytes: number }[]; nested: string[] }> {
  const head = await resolveCommit(repo, o.wt, 'HEAD')
  if (!head) throw new Error(`the worktree ${o.wt} has no HEAD`)
  if ((await countUncommitted(repo, o.wt)) === 0) return { head, tree: null, oversize: [], nested: [] }
  const { oversize, nested } = await unsnapshottable(repo, o.wt)
  const indexPath = path.resolve(o.wt, await read(repo, o.wt, ['rev-parse', '--git-path', 'index']).then((s) => s.trim()))
  await fs.promises.mkdir(o.tmpDir, { recursive: true, mode: 0o700 })
  const tmpIndex = path.join(o.tmpDir, `snapshot-${o.sessionId}-${process.pid}.index`)
  try {
    await fs.promises.copyFile(indexPath, tmpIndex).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
    const env = { ...repo.env, GIT_INDEX_FILE: tmpIndex }
    await gitText(snapshotPlan(oversize, undefined, nested).addArgs, { cwd: o.wt, env })
    return { head, tree: (await gitText(['write-tree'], { cwd: o.wt, env })).trim(), oversize, nested }
  } finally {
    await fs.promises.rm(tmpIndex, { force: true })
  }
}

/**
 * The delete snapshot: record the worktree's uncommitted work as a commit (`commit-tree -p HEAD`, Kea's
 * identity, never signed) without touching the worktree, its index or its branch, leaving out untracked files over the
 * limit; ignored files are never included. Then `update-ref` the snapshot ref (or HEAD itself when nothing was
 * uncommitted). Returns the ref, the commit, and what was left out.
 */
export async function writeSnapshot(repo: Repo, o: { wt: string; sessionId: string; slug: string; tmpDir: string }): Promise<{ ref: string; commit: string; oversize: { path: string; bytes: number }[]; nested: string[] }> {
  const { head, tree, oversize, nested } = await uncommittedTree(repo, o)
  const commit = tree ? (await gitText(['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', snapshotMessage(o.slug)], { cwd: o.wt, env: { ...repo.env, ...SNAPSHOT_IDENTITY } })).trim() : head
  const ref = snapshotRef(o.sessionId)
  await gitText(['update-ref', ref, commit], { cwd: repo.root, env: repo.env })
  return { ref, commit, oversize, nested }
}

/**
 * Whether `ref` is one of Kea's snapshot commits (by its identity and message) rather than a commit of the
 * session's own that the ref recorded as it was (nothing uncommitted, or the branch tip of a worktree already gone).
 */
export async function isSnapshotCommit(repo: Pick<Repo, 'env' | 'root'>, ref: string): Promise<boolean> {
  const s = await tryRead(repo, repo.root, ['log', '-1', '--format=%ae%x00%ce%x00%s', '--end-of-options', ref])
  if (!s) return false
  const [author, committer, subject] = s.split('\0')
  return author === SNAPSHOT_IDENTITY.GIT_AUTHOR_EMAIL && committer === SNAPSHOT_IDENTITY.GIT_COMMITTER_EMAIL && SNAPSHOT_MESSAGE_RE.test(subject ?? '')
}

/**
 * What a snapshot ref restores: the commit, the commit the worktree starts from, and whether uncommitted work
 * rides on it.
 */
export async function snapshotBase(repo: Pick<Repo, 'env' | 'root'>, ref: string): Promise<{ snap: string; base: string; isSnapshot: boolean } | null> {
  const snap = await resolveCommit(repo, repo.root, ref)
  if (!snap) return null
  const isSnapshot = await isSnapshotCommit(repo, ref)
  const parent = isSnapshot ? await resolveCommit(repo, repo.root, `${ref}^`) : null
  return { snap, base: parent ?? snap, isSnapshot: isSnapshot && parent !== null }
}

/**
 * The worktree is exactly as its snapshot ref recorded it (a delete Kea was killed in completes only then):
 * HEAD is the snapshot's parent and the uncommitted work makes the same tree, or, for a ref of HEAD itself, HEAD is
 * unchanged and nothing is uncommitted.
 */
export async function matchesSnapshot(repo: Repo, o: { wt: string; ref: string; sessionId: string; tmpDir: string }): Promise<boolean> {
  const b = await snapshotBase(repo, o.ref)
  if (!b) return false
  const now = await uncommittedTree(repo, o)
  if (now.head !== b.base) return false
  if (!b.isSnapshot) return now.tree === null
  return now.tree !== null && now.tree === (await resolveTree(repo, b.snap))
}

async function resolveTree(repo: Pick<Repo, 'env' | 'root'>, commit: string): Promise<string | null> {
  return tryRead(repo, repo.root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{tree}`])
}

/**
 * Files the snapshot holds beyond its parent (what the restore says it holds), counted as the delete sheet
 * counted them (`countUncommitted`): one per path, rename detection off whatever the user's git config. None when the
 * ref is not a snapshot commit.
 */
export async function snapshotFiles(repo: Pick<Repo, 'env' | 'root'>, ref: string): Promise<number> {
  const b = await snapshotBase(repo, ref)
  if (!b?.isSnapshot) return 0
  const names = await tryRead(repo, repo.root, ['diff', '--name-only', '-z', '--no-renames', b.base, b.snap])
  return names ? names.split('\0').filter(Boolean).length : 0
}

export async function deleteRef(repo: Pick<Repo, 'env' | 'root'>, ref: string): Promise<void> {
  await git(['update-ref', '-d', ref], { cwd: repo.root, env: repo.env, collect: true })
}

/** Every `refs/kea/deleted/*` ref of the repository: session id → ref. */
export async function deletedRefs(repo: Pick<Repo, 'env' | 'root'>): Promise<Map<string, string>> {
  const s = (await tryRead(repo, repo.root, ['for-each-ref', '--format=%(refname)', 'refs/kea/deleted/'])) ?? ''
  const m = new Map<string, string>()
  for (const ref of s.split('\n').filter(Boolean)) m.set(ref.slice('refs/kea/deleted/'.length), ref)
  return m
}

/**
 * Restore: put a deleted session's worktree back. The commit it starts from is the snapshot's parent, or the
 * ref itself when it is not a snapshot commit (nothing was uncommitted). If its branch still exists there, check it
 * out; otherwise create it there (`<branch>-restored` when the name was taken meanwhile). Then, for a snapshot commit,
 * `read-tree -u --reset <snapshot>` and `reset -q` give back modified, deleted and untracked files as uncommitted
 * changes.
 */
export async function restoreWorktree(repo: Repo, o: { path: string; branch: string; ref: string }): Promise<{ branch: string; createdBranch: boolean; base: string }> {
  const b = await snapshotBase(repo, o.ref)
  if (!b) throw new Error(`the snapshot ${o.ref} is gone`)
  const { snap, base: parent, isSnapshot } = b
  const tip = await resolveCommit(repo, repo.root, `refs/heads/${o.branch}`)
  const taken = new Set(((await tryRead(repo, repo.root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${o.branch}-restored*`])) ?? '').split('\n').filter(Boolean))
  const { branch, existing } = restoreBranch({ branch: o.branch, tip, parent, taken })
  await addWorktree(repo, { path: o.path, branch, commit: parent, existing })
  const createdBranch = !existing
  if (isSnapshot) {
    await gitText(['read-tree', '-u', '--reset', snap], { cwd: o.path, env: repo.env, timeoutMs: L.gitCheckoutTimeoutMs })
    await gitText(['reset', '-q'], { cwd: o.path, env: repo.env })
  }
  return { branch, createdBranch, base: parent }
}

/** `git -C <wt> fsmonitor--daemon stop` when the user enabled fsmonitor there. */
export async function stopFsmonitor(repo: Pick<Repo, 'env'>, wt: string): Promise<void> {
  const v = await tryRead(repo, wt, ['config', '--get', 'core.fsmonitor'])
  if (v === 'true') await git(['fsmonitor--daemon', 'stop'], { cwd: wt, env: repo.env, collect: true })
}

/** `git branch -d` (or `-D` after the "unmerged commits" confirmation). */
export async function deleteBranch(repo: Pick<Repo, 'env' | 'root'>, branch: string, force: boolean): Promise<boolean> {
  const r = await git(['branch', force ? '-D' : '-d', '--', branch], { cwd: repo.root, env: repo.env, collect: true })
  return ok(r)
}

/** Kea's temp directory for snapshot indexes: under KEA_HOME, never the repository. */
export function snapshotTmpDir(home: string): string {
  return path.join(home, 'tmp')
}
