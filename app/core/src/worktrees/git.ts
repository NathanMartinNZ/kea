// Which git Kea runs, and what a directory is to git. Every call goes through kit's `git()`.
//
// `findGit`: the first `git` on the login-shell PATH (the resolved environment). macOS ships `/usr/bin/git` as
// a stub that opens the Command Line Tools installer when they are missing, so that one is used only once
// `xcode-select -p` answers: Kea never triggers the install dialog implicitly. Linux has no stub: its first `git` is
// the real one. No git → projects open as non-git, and the OS layer's words say how to install it.

import fs from 'node:fs'
import path from 'node:path'
import { fileName, git, gitText, runProcess } from '@kea/kit'
import { L, need } from '@kea/protocol'
import { coreOs } from '../os/index.ts'

export type GitFound = { binary: string; missing: null } | { binary: null; missing: string }

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Where the stub and `xcode-select` are (the OS layer's `gitProbe`; I-WT-19 points them at stand-ins). */
export interface GitProbePaths {
  stub: string
  xcodeSelect: string
}

/**
 * The git to use, from a PATH: the first `git` that is not the Xcode stub; the stub only when `xcode-select -p`
 * answers (the Command Line Tools are installed), so Kea never makes it open the install dialog.
 * `paths` null: the system has no stub (Linux), and the first `git` on the PATH is the one.
 */
export async function findGit(pathVar: string | undefined, paths: GitProbePaths | null = need(coreOs.gitProbe).paths): Promise<GitFound> {
  const dirs = (pathVar ?? '').split(':').filter((d) => d.startsWith('/'))
  if (paths && !dirs.includes(path.dirname(paths.stub))) dirs.push(path.dirname(paths.stub))
  for (const dir of dirs) {
    const file = path.join(dir, 'git')
    if (!executable(file)) continue
    if (!paths || (fs.realpathSync(file) !== paths.stub && file !== paths.stub)) return { binary: file, missing: null }
    const r = await runProcess(paths.xcodeSelect, ['-p'], { pool: 'other', timeoutMs: L.gitDefaultTimeoutMs, env: { PATH: '/usr/bin:/bin' } }).catch(() => null)
    if (r?.code === 0) return { binary: file, missing: null }
    return { binary: null, missing: need(coreOs.gitProbe).installHint }
  }
  return { binary: null, missing: need(coreOs.gitProbe).notFound }
}

/**
 * realpath, as file names are taken (NFC on macOS, as stored on Linux): how every root is stored and compared.
 */
export function canonical(p: string): string {
  return fileName(fs.realpathSync.native(p))
}

/**
 * canonical() for a path that may not exist (yet, or any more): its nearest existing ancestor made canonical, the rest
 * joined on. How Kea compares a session's directory with what git lists (git records real paths) and roots with each
 * other (a root reached through a symlink, `/tmp`).
 */
export function canonicalPath(p: string): string {
  const rest: string[] = []
  let cur = path.resolve(p)
  for (;;) {
    try {
      return fileName(path.join(canonical(cur), ...rest))
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return fileName(path.resolve(p))
      rest.unshift(path.basename(cur))
      cur = parent
    }
  }
}

/** `child` lies strictly below `dir` (both canonical). */
export function isBelow(dir: string, child: string): boolean {
  return child.startsWith(dir.endsWith('/') ? dir : `${dir}/`) && child !== dir
}

export async function canonicalAsync(p: string): Promise<string> {
  return fileName(await fs.promises.realpath(p))
}

/** What git says about a directory: its working tree, its git dir and the common dir (shared by linked worktrees). */
export interface RepoFacts {
  toplevel: string
  gitDir: string
  commonDir: string
  /** A linked worktree (its git dir is not the common dir). */
  linked: boolean
}

/**
 * `<dir>/.git` as it is on disk (its inode and times), or null when there is none. Compared with the one taken when git
 * last said `dir` is no repository, it tells whether git need be asked again, without running it.
 */
export async function gitStamp(dir: string): Promise<string | null> {
  try {
    const st = await fs.promises.stat(path.join(dir, '.git'), { bigint: true })
    return `${st.ino}:${st.mtimeNs}:${st.ctimeNs}`
  } catch {
    return null
  }
}

/** Null when `dir` is not inside a git working tree (or git cannot tell). */
export async function inspectRepo(dir: string): Promise<RepoFacts | null> {
  const r = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd: dir, readOnly: true, collect: true })
  if (r.code !== 0 || r.truncated || r.timedOut) return null
  const [toplevel, gitDir, commonDir] = (r.stdout ?? Buffer.alloc(0)).toString('utf8').split('\n')
  if (!toplevel || !gitDir || !commonDir) return null
  const real = (p: string) => {
    try {
      return canonical(p)
    } catch {
      return fileName(p)
    }
  }
  const facts = { toplevel: real(toplevel), gitDir: real(gitDir), commonDir: real(commonDir) }
  return { ...facts, linked: facts.gitDir !== facts.commonDir }
}

/**
 * The first entry of `git worktree list` for the repository `dir` belongs to: its main worktree, or the repository's
 * own folder when it is bare, which git marks `bare`.
 */
export async function mainEntry(dir: string): Promise<{ path: string; bare: boolean } | null> {
  try {
    const out = await gitText(['worktree', 'list', '--porcelain'], { cwd: dir, readOnly: true })
    const first = out.split('\n\n', 1)[0] ?? ''
    const main = /^worktree (.+)$/m.exec(first)?.[1]
    return main ? { path: canonical(main), bare: /^bare$/m.test(first) } : null
  } catch {
    return null
  }
}

/** The main worktree of the repository `dir` belongs to (the folder of a bare repository, which has none). */
export async function mainWorktree(dir: string): Promise<string | null> {
  return (await mainEntry(dir))?.path ?? null
}

/**
 * The bare repository that `dir` is, lies inside, or names with a `.git` file of its own: its folder,
 * which is git's common dir. Null for anything else: a folder that is no repository, a work tree, and the `.git`
 * folder of a repository that has one. Git decides (its discovery, and with it the user's `safe.bareRepository`).
 */
export async function bareRepository(dir: string): Promise<string | null> {
  const r = await git(['rev-parse', '--path-format=absolute', '--is-bare-repository', '--git-common-dir'], { cwd: dir, readOnly: true, collect: true })
  if (r.code !== 0 || r.truncated || r.timedOut) return null
  const [bare, commonDir] = (r.stdout ?? Buffer.alloc(0)).toString('utf8').split('\n')
  if (bare !== 'true' || !commonDir) return null
  try {
    return canonical(commonDir)
  } catch {
    return null
  }
}

/** The branch checked out in `dir`, or null (detached HEAD, unborn, not a repo). */
export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir, readOnly: true, collect: true })
  const b = r.code === 0 ? (r.stdout ?? Buffer.alloc(0)).toString('utf8').trim() : ''
  return b || null
}
