// Which directories a subscription excludes in the kernel. FSEvents takes at most L.watchExclusionsMax exclusion paths,
// and one more silently switches every one of them off, so on macOS the list is cut here, once, for every
// stream Kea opens; inotify's ignore paths have no such limit, and on Linux nothing is cut. An exclusion is
// honoured for a directory created after the stream started, so candidates that do not exist yet fill the slots the
// existing ones leave: a fresh worktree's `node_modules` is excluded before `pnpm install` makes it.
//
// What is excluded in the kernel is never heard of again, so a name is not enough: a repository may track its `build/`
// or `dist/`. In a git work tree a candidate is excluded only when git ignores it whole (`gitExclusions`); the
// repository's own `.git` always is. A folder that is not a repository has nothing to say, and its candidates are
// excluded by name, all but a `.git` that is not there yet (`plainExclusions`).

import fs from 'node:fs'
import path from 'node:path'
import { isAvailable, L } from '@kea/protocol'
import { coreOs } from '../../os/index.ts'

/** A worktree's candidates, in priority order. */
export const WORKTREE_EXCLUSIONS = ['node_modules', '.git', 'dist', 'build', '.next', 'target', 'coverage', '.turbo', '.venv', 'out'] as const

/** A common dir's: the object store, the reflogs, submodules' git dirs, LFS objects, the fsmonitor daemon's cookies. */
export const COMMON_DIR_EXCLUSIONS = ['objects', 'logs', 'modules', 'lfs', 'fsmonitor--daemon'] as const

export type EntryKind = 'dir' | 'file' | 'none'

function kindOnDisk(p: string): EntryKind {
  try {
    return fs.lstatSync(p).isDirectory() ? 'dir' : 'file'
  } catch {
    return 'none'
  }
}

/** This system's cap on kernel exclusions per stream (the OS layer's `watcher.exclusionsMax`): null, none. */
function systemMax(): number | null {
  return isAvailable(coreOs.watcher) ? coreOs.watcher.exclusionsMax : L.watchExclusionsMax
}

/**
 * The exclusion paths for a stream on `root` (absolute): `candidates`, those that are directories now first, then
 * those that do not exist yet, each group in the candidates' order, cut to `max` (the system's: macOS's
 * L.watchExclusionsMax, none on Linux). A candidate that is a file is never excluded (a linked worktree's `.git`).
 */
export function pickExclusions(root: string, candidates: readonly string[], kindOf: (p: string) => EntryKind = kindOnDisk, max: number | null = systemMax()): string[] {
  const dirs: string[] = []
  const later: string[] = []
  for (const name of candidates) {
    const p = path.join(root, name)
    const kind = kindOf(p)
    if (kind === 'dir') dirs.push(p)
    else if (kind === 'none') later.push(p)
  }
  const picked = [...dirs, ...later]
  return max === null ? picked : picked.slice(0, max)
}

/** The candidate a git work tree always excludes: the repository's own data, which no status reports from. */
export const GIT_DIR_NAME = '.git'

/**
 * The exclusion paths for a stream on `root`, a folder that is not a repository: as `pickExclusions`, but a `.git` only
 * while it is a directory there. One that does not exist yet is heard when it is made (`git init`), so the folder can
 * be found to be a repository; the watch service then opens the stream again, leaving it out.
 */
export function plainExclusions(root: string, candidates: readonly string[], kindOf: (p: string) => EntryKind = kindOnDisk, max: number | null = systemMax()): string[] {
  return pickExclusions(root, candidates.filter((n) => n !== GIT_DIR_NAME || kindOf(path.join(root, n)) === 'dir'), kindOf, max)
}

/** The names git is asked about for a work tree: every candidate but its own `.git`. */
export function askedOfGit(candidates: readonly string[]): string[] {
  return candidates.filter((n) => n !== GIT_DIR_NAME)
}

/**
 * The exclusion paths for a stream on the git work tree `root`: as `pickExclusions`, from `.git` and those of
 * `candidates` that git ignores whole (`ignored`: their names; null when git did not say, and then `.git` alone).
 */
export function gitExclusions(root: string, candidates: readonly string[], ignored: readonly string[] | null, kindOf: (p: string) => EntryKind = kindOnDisk, max: number | null = systemMax()): string[] {
  const whole = new Set(ignored ?? [])
  return pickExclusions(root, candidates.filter((n) => n === GIT_DIR_NAME || whole.has(n)), kindOf, max)
}

/** `p` is one of `excluded` or lies below one. */
export function isExcluded(excluded: readonly string[], p: string): boolean {
  return excluded.some((e) => p === e || p.startsWith(e + path.sep))
}
