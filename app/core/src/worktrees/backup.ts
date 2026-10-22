// Rebuildable folders and backups. A rebuildable folder is a directory that matches the project's patterns (default
// DEFAULT_REBUILDABLE_DIRS) and is git-ignored: never a tracked path, never an untracked file that is not ignored,
// never a symlink. After setup completes and again on archive, those present at the worktree root and one level below
// are kept out of the system's backups, unless `general.excludeBuildDirsFromBackup` is off: on macOS with Time
// Machine's sticky exclusion (the attribute `tmutil addexclusion` sets; no admin rights), while Linux has no backup to
// keep them out of. Source files and uncommitted work stay in backups.
//
// "Git-ignored" is asked of git twice, because neither answer is enough alone:
//   1. `git ls-files --others --ignored --exclude-standard --directory` lists a directory whole (`dir/`) only when
//      nothing in it is tracked and everything in it is ignored. So a listed directory holds no tracked path and no
//      untracked file that is not ignored. But it also lists a directory no rule names, when all it holds happens to be
//      ignored (`out/` with nothing but `*.log` files in it).
//   2. `git check-ignore` says whether a rule ignores the directory itself, and never for a path with tracked content.
// A rebuildable folder passes both.

import fs from 'node:fs'
import path from 'node:path'
import { git, gitText, type Logger } from '@kea/kit'
import { DEFAULT_REBUILDABLE_DIRS, isAvailable } from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import { compileRules, matches } from './ignore.ts'

type GitEnv = Record<string, string | undefined>

/**
 * Pure selection (U-WT-1): `ignoredDirs` are git's ignored entries with whole directories collapsed (`ls-files
 * --others --ignored --directory`: directories end with `/`), so a tracked or not-ignored path is never among them.
 * `maxDepth` 2 = the root and one level below (the backup targets).
 */
export function selectRebuildable(o: { ignoredDirs: readonly string[]; patterns?: readonly string[]; isSymlink: (rel: string) => boolean; maxDepth?: number }): string[] {
  const rules = compileRules((o.patterns ?? DEFAULT_REBUILDABLE_DIRS).map((p) => (p.endsWith('/') ? p : `${p}/`)))
  const out: string[] = []
  for (const e of o.ignoredDirs) {
    if (!e.endsWith('/')) continue
    const rel = e.replace(/\/+$/, '')
    const depth = rel.split('/').length
    if (o.maxDepth !== undefined && depth > o.maxDepth) continue
    if (o.isSymlink(rel)) continue
    if (!matches(rules, rel, true)) continue
    out.push(rel)
  }
  return out.sort()
}

/** Of `dirs` (paths in the worktree), those a rule of git's ignores as directories (`git check-ignore`). Throws when git cannot say. */
export async function ignoredByRule(wt: string, dirs: readonly string[], env?: GitEnv): Promise<string[]> {
  if (!dirs.length) return []
  const r = await git(['check-ignore', '-z', '--stdin'], { cwd: wt, readOnly: true, collect: true, stdin: dirs.map((d) => `${d}/\0`).join(''), ...(env ? { env } : {}) })
  // 0: some are ignored · 1: none is · anything else: git could not say
  if ((r.code !== 0 && r.code !== 1) || r.truncated || r.timedOut || r.cancelled) throw new Error(`git check-ignore: ${r.timedOut ? 'timed out' : `exit ${r.code}`} ${r.stderr.trim().split('\n').at(-1) ?? ''}`.trim())
  const ignored = new Set(
    (r.stdout ?? Buffer.alloc(0))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((p) => p.replace(/\/+$/, '')),
  )
  return dirs.filter((d) => ignored.has(d))
}

/**
 * The rebuildable folders of a worktree, as paths in it, sorted. `maxDepth` 2: only those at the root and one
 * level below. Throws when git cannot be asked: the caller then removes, counts or marks nothing.
 */
export async function rebuildableDirs(wt: string, patterns: readonly string[] | undefined, env?: GitEnv, o: { maxDepth?: number } = {}): Promise<string[]> {
  const listed = (await gitText(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: wt, readOnly: true, ...(env ? { env } : {}) }))
    .split('\0')
    .filter(Boolean)
  const isSymlink = (rel: string) => {
    try {
      return fs.lstatSync(path.join(wt, rel)).isSymbolicLink()
    } catch {
      return true
    }
  }
  const candidates = selectRebuildable({ ignoredDirs: listed, ...(patterns ? { patterns } : {}), isSymlink, ...(o.maxDepth !== undefined ? { maxDepth: o.maxDepth } : {}) })
  return ignoredByRule(wt, candidates, env)
}

/** The rebuildable folders of a worktree at the root and one level below. */
export function backupTargets(wt: string, patterns: readonly string[] | undefined, env?: GitEnv): Promise<string[]> {
  return rebuildableDirs(wt, patterns, env, { maxDepth: 2 })
}

/** Whether this system has a backup to keep folders out of (macOS's Time Machine; Linux none). */
export function backupsExcludable(): boolean {
  return isAvailable(coreOs.backupExclude)
}

/**
 * The writer that keeps Kea's own folders out of backups, as core's entry gives it to core; null where the system has
 * no backup to keep them out of, so nothing is looked at and `backup.excluded` is never written.
 */
export function backupWriter(log: Logger): ((dir: string, names: readonly string[]) => Promise<number>) | null {
  return backupsExcludable() ? (dir, names) => excludeFromBackup(dir, names, log) : null
}

/**
 * The system's backup exclusion on each target (the OS layer's `backupExclude`; on macOS Time Machine's sticky
 * exclusion). Failures are logged; backups are never a reason to fail a step. A system with no backup to keep the
 * folders out of marks nothing.
 */
export async function excludeFromBackup(wt: string, targets: readonly string[], log: Logger): Promise<number> {
  const backup = coreOs.backupExclude
  if (!targets.length || !isAvailable(backup)) return 0
  const paths = targets.map((t) => path.join(wt, t))
  const r = await backup.mark(paths)
  if (r.code !== 0) {
    log.warn('Time Machine exclusion not set', { worktree: wt, stderr: String(r.stderr).slice(0, 300) })
    return 0
  }
  return paths.length
}
