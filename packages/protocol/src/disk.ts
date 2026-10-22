// The `disk` feature's messages: what a worktree costs on disk, as core measures it and Settings › Disk shows it.
//
// What crosses the boundary: the `disk` store (one `DiskUsage` per session that has a worktree of its own, by session
// id) and `diskApi`. A size is the sum of the allocated blocks under the worktree: an upper bound, since cloned
// files and hard links are counted in full. The window follows the store only while the Disk view is open; the rows'
// other columns (title, lifecycle, last activity) are the `sessions` store's.
import { z } from 'zod'
import { L } from './generated/limits.ts'
import { defineApi } from './rpc.ts'
import { zSessionId } from './terminal.ts'

export const DISK_STORE = 'disk'

/**
 * The end of the reason given when an archived session's build folders are pruned, in the session's log and on
 * Settings › Disk's last line. The install tool also looks for it in the installed app's code: a build whose code has
 * these words already prunes, so the install can give its first-prune notice. The setting's name would not
 * say so, since earlier builds declared the setting without pruning.
 */
export const PRUNE_MARK = 'build folders removed'

/** One row of the `disk` store: a worktree's size as last measured, and when the session was last on screen. */
export const zDiskUsage = z.object({
  /**
   * Allocated bytes under the worktree (the sum of `st_blocks`, symlinks not followed). An upper bound; when
   * `capped`, what the walk had counted when it was cancelled instead. Null until measured.
   */
  bytes: z.number().int().min(0).nullable(),
  /** The part of `bytes` inside rebuildable folders, counted by the same walk. */
  rebuildableBytes: z.number().int().min(0).nullable(),
  /** The walk was cancelled at its time cap (`L.diskWalkTimeoutMs`): the worktree holds at least `bytes`. */
  capped: z.boolean(),
  /** When it was measured (wall ms); null until measured. */
  at: z.number().int().nullable(),
  /** A measurement of it is waiting or under way. */
  measuring: z.boolean(),
  /** A window shows the session now. */
  visible: z.boolean(),
  /** When a window last showed it (wall ms); null when none has since Kea began to note it. */
  viewedAt: z.number().int().nullable(),
})
export type DiskUsage = z.infer<typeof zDiskUsage>

/** A worktree's branch state, as the Disk view's row says it: uncommitted files · unpushed commits · merged. */
export const zDiskBranch = z.object({
  /** As the delete confirmation counts them: one per file, untracked files that are not ignored included. */
  uncommittedFiles: z.number().int().min(0),
  /**
   * The branch's own commits that no remote-tracking ref holds: those it adds to its base (all of HEAD's when the base
   * no longer resolves). A repository with no remote does not make its whole history "unpushed" on every row.
   */
  unpushedCommits: z.number().int().min(0),
  /** Commits the branch adds to its base (0: nothing to merge). */
  commits: z.number().int().min(0),
  /** Merged into its base, a squash merge included; false also when the base no longer resolves. */
  merged: z.boolean(),
})
export type DiskBranch = z.infer<typeof zDiskBranch>

/** A build folder that "Remove build folders" left where it is, and why. */
export const zKeptFolder = z.object({
  /** Its path in the worktree. */
  path: z.string(),
  /**
   * `git`: it holds a git repository of its own (a `.git` entry at any depth), whose work may exist nowhere else.
   * `unchecked`: it could not be looked through (the time cap, a folder that cannot be read, another volume in it), so
   * it may hold one.
   */
  reason: z.enum(['git', 'unchecked']),
})
export type KeptFolder = z.infer<typeof zKeptFolder>

/** What "Remove build folders" did. */
export const zBuildFoldersRemoved = z.object({
  /** The folders that went, as paths in the worktree. */
  removed: z.array(z.string()),
  /** The rebuildable-looking folders that stayed, each with its reason. */
  kept: z.array(zKeptFolder),
  /** What the last measurement counted in the rebuildable folders (null when never measured). */
  bytes: z.number().int().min(0).nullable(),
})
export type BuildFoldersRemoved = z.infer<typeof zBuildFoldersRemoved>

/** What "Remove build folders" would do to a session now: asked before it is confirmed; nothing is changed. */
export const zBuildFoldersFound = z.object({
  /** The folders that would go, as paths in the worktree. */
  folders: z.array(z.string()),
  /** Those that would stay, each with its reason. */
  kept: z.array(zKeptFolder),
  /** What the last measurement counted in the rebuildable folders (null when never measured). */
  bytes: z.number().int().min(0).nullable(),
})
export type BuildFoldersFound = z.infer<typeof zBuildFoldersFound>

export const diskApi = defineApi({
  /**
   * Measure now every session with a worktree that was never measured or whose measurement is older than
   * `L.diskMeasureIntervalMs` (the Disk view asks when it opens); `all`: each of them again (its Refresh). One
   * walk runs at a time; the `disk` store's rows say `measuring` meanwhile. `queued`: how many walks this call added.
   */
  'disk.measure': { args: z.object({ all: z.boolean().optional() }), result: z.object({ queued: z.number().int().min(0) }) },
  /** The branch state of one session's worktree, asked for the rows on screen; null when it has none to read. */
  'disk.branch': { args: z.object({ id: zSessionId }), result: z.object({ branch: zDiskBranch.nullable() }) },
  /**
   * "Remove build folders": the session's rebuildable folders (the project's patterns, and git-ignored) go
   * through its worktree root's trash (Kea's own holding folder, deleted in the background: not the Trash, and not
   * undoable); nothing tracked and no untracked file that is not ignored is touched, and a folder that holds a git
   * repository of its own stays (`kept`). The worktree is measured again afterwards.
   */
  'disk.removeBuildFolders': { args: z.object({ id: zSessionId }), result: zBuildFoldersRemoved },
  /**
   * What `disk.removeBuildFolders` would take from the session now and what it would keep, for the confirmation
   * shown before a removal asked for outside the Disk view. Refused for the same reasons as the removal (no worktree of
   * its own, setup running, git cannot say). The removal looks again itself: this answer is never what it acts on.
   */
  'disk.buildFolders': { args: z.object({ id: zSessionId }), result: zBuildFoldersFound },
})

const DAY_MS = 86_400_000

/**
 * "Stale", as the Disk view says it: not on screen now, and not shown for `L.diskStaleDays` days. A session no
 * window has shown since Kea began to note it counts from its creation.
 */
export function isStale(now: number, s: { createdAt: number }, d: Pick<DiskUsage, 'visible' | 'viewedAt'> | undefined): boolean {
  if (d?.visible) return false
  return now - (d?.viewedAt ?? s.createdAt) >= L.diskStaleDays * DAY_MS
}

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/**
 * A size in words, in decimal units as Finder shows them: `0 bytes`, `812 bytes`, `4.2 MB`, `13 GB` (one decimal below
 * 10 of a unit, none from there).
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n)} ${Math.round(n) === 1 ? 'byte' : 'bytes'}`
  let v = n
  let unit = -1
  while (v >= 1000 && unit < UNITS.length - 1) {
    v /= 1000
    unit++
  }
  // 9.96 would round to "10.0": it is "10"
  const text = v < 9.95 ? v.toFixed(1) : String(Math.round(v))
  return `${text} ${UNITS[unit]}`
}
