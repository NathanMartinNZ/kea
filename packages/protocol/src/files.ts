// Files and git status: what the file panel (tree, git status, Changes, finder) and the viewer (file and diff tabs)
// share. Core's git scheduler produces a session's status; the Changes list, the header's diff stat, the tree's
// decorations and the viewer (`File · Diff`, the diff header, `]` / `[`) all read it through the readers below, so
// there is one definition of a path's status and of the Changes order.
//
//   zWorktreePath     a path inside a session's working directory, as it crosses a boundary
//   DIFF_SCOPES       Branch / Uncommitted
//   git:<sessionId>   the session's status as a store: the head row and one row per changed path, changed together in
//                     one delta. A subscriber's delta is the change signal.
//   tree:<sessionId>  the session's file tree as a store: the head row and one row per loaded directory.
//   filesApi          the file panel's calls: open the tree, expand, collapse, refresh, the scope, discard, the finder,
//                     and whether a project is offered git's fsmonitor.

import { z } from 'zod'
import { L } from './generated/limits.ts'
import { defineApi } from './rpc.ts'
import { zProjectId } from './sessions.ts'
import { sessionStoreName } from './store.ts'
import { zSessionId } from './terminal.ts'

/**
 * A path relative to a session's working directory: `/`-separated, no empty, `.` or `..` segment, never absolute. This
 * is syntax only: core still resolves it under the directory and checks that its real path stays inside before any
 * read.
 */
export function isWorktreePath(p: string): boolean {
  if (p === '' || p.includes('\0') || p.startsWith('/')) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}
export const zWorktreePath = z.string().min(1).refine(isWorktreePath, 'not a path inside the working directory')

/** What the file panel compares against: everything since the branch point, or what `git status` shows. */
export const DIFF_SCOPES = ['branch', 'uncommitted'] as const
export type DiffScope = (typeof DIFF_SCOPES)[number]
export const zDiffScope = z.enum(DIFF_SCOPES)

/** Status letters: modified, added, untracked, deleted, renamed, conflicted. */
export const GIT_CODES = ['M', 'A', 'U', 'D', 'R', '!'] as const
export type GitCode = (typeof GIT_CODES)[number]

/** One changed path in the active scope. A path with no entry is unchanged. */
export const zGitEntry = z.object({
  path: zWorktreePath,
  code: z.enum(GIT_CODES),
  /** Lines added and removed; null where git counts none (a binary file) or Kea skipped the count. */
  added: z.number().int().min(0).nullable(),
  removed: z.number().int().min(0).nullable(),
  /** A rename's old path. */
  origPath: zWorktreePath.nullable(),
  /** A submodule: one entry, shown with `S`, never recursed into. */
  submodule: z.boolean().optional(),
  /**
   * A deleted path (`D`) that the commit the scope compares against does not have either: it was added to git's index
   * and then deleted from disk, so the index holds its only copy. Discard puts it back from there.
   */
  indexOnly: z.boolean().optional(),
})
export type GitEntry = z.infer<typeof zGitEntry>

/**
 * What a session's status is as a whole. `ok`: the rows are the status. `loading`: the first status of this session is
 * still running, so there are no rows yet. `notGit`: no decorations, no Changes tab. `tooMany`: more entries
 * than Kea tracks; no rows, refreshed only when asked. `unavailable`: git timed out or failed; the rows are the
 * last status that worked, and the next trigger tries again.
 */
export const GIT_STATES = ['ok', 'loading', 'notGit', 'tooMany', 'unavailable'] as const
export type GitState = (typeof GIT_STATES)[number]

/** An operation under way in the worktree: the branch line shows `REBASING 2/5`, `MERGING`. */
export const GIT_OPERATIONS = ['rebase', 'merge', 'cherry-pick', 'revert', 'bisect'] as const
export const zGitOperation = z.object({
  kind: z.enum(GIT_OPERATIONS),
  /** A rebase's step and how many there are, where git says. */
  step: z.number().int().min(0).nullable(),
  total: z.number().int().min(0).nullable(),
})
export type GitOperation = z.infer<typeof zGitOperation>

/** What holds for the whole status: the scope and its base, and the Changes header's fields. */
export const zGitHead = z.object({
  /** The session's active scope: the Changes list, the decorations, the diff stat and every diff follow it. */
  scope: zDiffScope,
  /**
   * The commit the active scope compares against, as a full object id: the merge base (Branch) or `HEAD`'s commit
   * (Uncommitted). Null when there is none (no commit yet, not a git repository). It changes when the base moves, so
   * a diff of an unchanged entry still refreshes.
   */
  base: z.string().nullable(),
  /** Absent in a head that a test's stand-in for the scheduler writes: read as `ok`. */
  state: z.enum(GIT_STATES).optional(),
  /** The checked-out branch; null on a detached HEAD, where `detached` is the commit's short id. */
  branch: z.string().nullable().optional(),
  detached: z.string().nullable().optional(),
  /** What the Branch scope compares with: the session's base branch, or null when it has none (then `base_commit`). */
  baseBranch: z.string().nullable().optional(),
  /** Commits on this branch since the base, and on the base since the branch point (`↑3`, "behind 12"); null: unknown. */
  ahead: z.number().int().min(0).nullable().optional(),
  behind: z.number().int().min(0).nullable().optional(),
  upstream: z.string().nullable().optional(),
  operation: zGitOperation.nullable().optional(),
  /** The header's totals in the active scope: changed files, lines added and removed (counted files only). */
  totals: z.object({ files: z.number().int().min(0), added: z.number().int().min(0), removed: z.number().int().min(0) }).optional(),
  /** git's output passed its byte cap; the rows are what was read before it. */
  truncated: z.boolean().optional(),
  /** This session's status is refreshed only when asked (`files.refresh`). */
  manual: z.boolean().optional(),
  /** A status took longer than its hint threshold and the project does not use git's fsmonitor. */
  slow: z.boolean().optional(),
})
export type GitHead = z.infer<typeof zGitHead>

/** A row of `git:<sessionId>`: the head under `GIT_HEAD_KEY`, an entry under `gitKey(path)`. */
export type GitRow = GitHead | GitEntry

export const GIT_HEAD_KEY = 'head'

/** The store key of a path's entry. Prefixed, so no path is the head's key or a reserved name (`__proto__`). */
export function gitKey(path: string): string {
  return `/${path}`
}

/** `git:<sessionId>`: registered by core while the session is in a window's visible set, gone otherwise. */
export function gitStoreName(sessionId: string): string {
  return sessionStoreName('git', sessionId)
}

/** The status's head; null until the first status of the session has arrived. */
export function gitHead(data: ReadonlyMap<string, GitRow>): GitHead | null {
  return (data.get(GIT_HEAD_KEY) as GitHead | undefined) ?? null
}

/** A path's entry in the active scope; null for an unchanged (or unknown) path: no `File · Diff` switch. */
export function gitEntry(data: ReadonlyMap<string, GitRow>, path: string): GitEntry | null {
  return (data.get(gitKey(path)) as GitEntry | undefined) ?? null
}

/**
 * The Changes list's order: conflicts first, then by path, compared by UTF-16 code unit so core and
 * every window agree. The list renders in this order and `]` / `[` step through it, wrapping.
 */
export function changesOrder(data: ReadonlyMap<string, GitRow>): GitEntry[] {
  const out: GitEntry[] = []
  for (const [k, v] of data) if (k.startsWith('/')) out.push(v as GitEntry)
  const rank = (e: GitEntry) => (e.code === '!' ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// ── tree:<sessionId> ─────────────────────────────────────────────────────────────────────────────────────

/** What a tree row is: a symlink is shown with a link glyph and never followed; `other` is a socket, a FIFO, a device. */
export const TREE_KINDS = ['dir', 'file', 'symlink', 'other'] as const
export type TreeKind = (typeof TREE_KINDS)[number]

export const zTreeEntry = z.object({
  /** The entry's name (NFC), never `.git`. */
  name: z.string().min(1),
  kind: z.enum(TREE_KINDS),
  /** Git ignores it (itself or a folder above it): hidden unless the panel shows ignored files, then dimmed. */
  ignored: z.boolean(),
})
export type TreeEntry = z.infer<typeof zTreeEntry>

/** One loaded directory: its entries in display order (directories first, then case-insensitive and numeric-aware). */
export const zTreeDir = z.object({
  /** The directory, relative to the working directory; `''` is the root. */
  path: z.string(),
  entries: z.array(zTreeEntry),
  /** How many entries the directory has (without `.git`); more than `entries` when only the first page is sent. */
  total: z.number().int().min(0),
  /** Only the first page is here; `files.showAll` loads the rest. */
  paged: z.boolean(),
  /** The directory has more entries than Kea lists at all; `entries` is a part of it. */
  truncated: z.boolean(),
})
export type TreeDir = z.infer<typeof zTreeDir>

export const zTreeHead = z.object({
  /** The working directory is a git work tree (without one, no decorations and no Changes tab). */
  git: z.boolean(),
  /** Changes on disk arrive by themselves. False in poll-only mode ("live updates unavailable"). */
  live: z.boolean(),
  /** The working directory is gone. */
  missing: z.boolean(),
})
export type TreeHead = z.infer<typeof zTreeHead>

/** A row of `tree:<sessionId>`: the head under `TREE_HEAD_KEY`, a loaded directory under `treeKey(path)`. */
export type TreeRow = TreeHead | TreeDir

export const TREE_HEAD_KEY = 'head'

/** The store key of a loaded directory (`''`: the root). Prefixed, so no path is the head's key or a reserved name. */
export function treeKey(dirPath: string): string {
  return `/${dirPath}`
}

/** `tree:<sessionId>`: registered by core while the session is in a window's visible set, gone otherwise. */
export function treeStoreName(sessionId: string): string {
  return sessionStoreName('tree', sessionId)
}

export function treeHead(data: ReadonlyMap<string, TreeRow>): TreeHead | null {
  return (data.get(TREE_HEAD_KEY) as TreeHead | undefined) ?? null
}

/** A loaded directory's row; null while it is not loaded (collapsed, or its listing has not arrived). */
export function treeDir(data: ReadonlyMap<string, TreeRow>, dirPath: string): TreeDir | null {
  return (data.get(treeKey(dirPath)) as TreeDir | undefined) ?? null
}

// ── the file panel's calls ───────────────────────────────────────────────────────────────────────────────

/** A directory inside the working directory; `''` is the root. */
export const zTreeDirPath = z.union([z.literal(''), zWorktreePath])

/**
 * What the panel keeps per session besides the expanded folders (scroll position, selection, the tab): the window's own
 * shape, stored by core as it is given and bounded in size. Core never reads it.
 */
export const zFilesUi = z.record(z.string(), z.unknown())
export type FilesUi = z.infer<typeof zFilesUi>

export const zFinderHit = z.object({
  path: zWorktreePath,
  /** Indexes into `path` of the characters the query matched (for the palette's highlight). */
  matched: z.array(z.number().int().min(0)),
  /** The path has an entry in the session's status. */
  changed: z.boolean(),
})
export type FinderHit = z.infer<typeof zFinderHit>

const ok = z.object({ ok: z.boolean() })

/**
 * What Discard Changes does to one path: `restore` puts back the file as it is in the commit the active scope compares
 * against (index and working tree); `trash` moves a file that commit does not have (an untracked or an added file) to
 * the Trash and takes it out of the index; `restoreStaged` puts back, in the working tree, a file that was added to git
 * and then deleted from disk, as the index has it (that commit has none: `GitEntry.indexOnly`).
 */
export const DISCARD_ACTIONS = ['restore', 'trash', 'restoreStaged'] as const
export type DiscardAction = (typeof DISCARD_ACTIONS)[number]

/**
 * Why a discard was not done; nothing was changed unless it says `failed`.
 *   unchanged    the path is not a change in the active scope (an ignored file, a file like its base)
 *   changed      it is no longer what was confirmed: the scope is another one, the commit it compares against has
 *                moved (`scope`, `base`), or what would be done to the file is something else (`expect`): ask again
 *   directory    a folder (Kea discards one file at a time)
 *   submodule    a submodule
 *   conflict     an unmerged path: resolve it first
 *   outside      the path does not lead into the working directory (a symlinked folder on the way)
 *   notGit       the working directory is not a git work tree
 *   noTrash      the system has no tool that moves a file to the Trash (`trash` from macOS 15, GLib's `gio` on Linux):
 *                the file is left alone, never deleted
 *   failed       git or the trash tool failed; `detail` is the last line it wrote
 */
export const DISCARD_REFUSALS = ['unchanged', 'changed', 'directory', 'submodule', 'conflict', 'outside', 'notGit', 'noTrash', 'failed'] as const
export type DiscardRefusal = (typeof DISCARD_REFUSALS)[number]

/** A commit as git names it in full: 40 hex digits, or 64 in a SHA-256 repository (what `GitHead.base` holds). */
const zGitObjectId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)

export const zDiscardResult = z.union([
  z.object({ ok: z.literal(true), did: z.enum(DISCARD_ACTIONS) }),
  z.object({ ok: z.literal(false), refused: z.enum(DISCARD_REFUSALS), detail: z.string().max(L.discardDetailMaxChars).optional() }),
])
export type DiscardResult = z.infer<typeof zDiscardResult>

export const filesApi = defineApi({
  /**
   * The panel shows this session's tree: core loads the root and the folders that were expanded when the session was
   * last shown (rows arrive in `tree:<sessionId>`), and answers with what it kept for the session. The session must be
   * the one this window shows (`visible.set` first).
   */
  'files.open': {
    args: z.object({ sessionId: zSessionId }),
    result: z.object({ ok: z.boolean(), expanded: z.array(zTreeDirPath), scope: zDiffScope, ui: zFilesUi }),
  },
  /** Load a folder's entries and keep it expanded. `ok: false`: it is not a directory inside the working directory. */
  'files.expand': { args: z.object({ sessionId: zSessionId, path: zTreeDirPath }), result: ok },
  /** Forget a folder's entries, and those of every folder below it. */
  'files.collapse': { args: z.object({ sessionId: zSessionId, path: zWorktreePath }), result: ok },
  /** Send all of a big folder's entries ("Show all (n)"). */
  'files.showAll': { args: z.object({ sessionId: zSessionId, path: zTreeDirPath }), result: ok },
  /**
   * Keep the panel's own state for the session (scroll, selection, tab). Also taken for a session the window has just
   * left; `ok: false` when core holds nothing for the session any more (the state is then not kept).
   */
  'files.saveUi': { args: z.object({ sessionId: zSessionId, ui: zFilesUi }), result: ok },
  /** Read the loaded folders and the status again, now (the Refresh command; the only refresh of a `manual` status). */
  'files.refresh': { args: z.object({ sessionId: zSessionId }), result: ok },
  /** Branch or Uncommitted; kept per session. */
  'files.setScope': { args: z.object({ sessionId: zSessionId, scope: zDiffScope }), result: ok },
  /**
   * Discard Changes (the tree's one mutating action; the window has asked first): undo this session's changes to one
   * file. The request carries what the confirmation said: what is done to the file (`expect`), in which scope, and the
   * commit that scope compared against when the sheet was written (`base`: the head of `git:<sessionId>`; null: no
   * commit yet). Core looks again and does only that: when the scope is another one, its base has moved, or the file
   * calls for something else, it refuses `changed` and nothing is touched.
   */
  'files.discard': { args: z.object({ sessionId: zSessionId, path: zWorktreePath, expect: z.enum(DISCARD_ACTIONS), scope: zDiffScope, base: zGitObjectId.nullable() }), result: zDiscardResult },
  /**
   * The finder: the best matches for `query` among the working directory's files, best first. The first call builds the
   * index. A call that a later one of the same window overtook answers `superseded` with no hits. `recent`: the paths
   * opened lately in this window, most recent first (the recency boost). An empty query answers the recent and the
   * changed files.
   */
  'files.find': {
    args: z.object({ sessionId: zSessionId, query: z.string().max(L.finderQueryMaxChars), recent: z.array(zWorktreePath).max(L.finderRecentMax).optional() }),
    result: z.object({
      hits: z.array(zFinderHit),
      /** Paths in the index. */
      total: z.number().int().min(0),
      /** The index holds only a part of the files (its cap, or git's output cap). */
      truncated: z.boolean(),
      superseded: z.boolean(),
    }),
  },
  /**
   * Whether the project's "Use git fsmonitor for this repo" setting is offered. False for a project whose folder
   * lies on a network volume (git's daemon does not run there): the settings form leaves the row out.
   */
  'files.fsmonitorOffered': { args: z.object({ projectId: zProjectId }), result: z.object({ offered: z.boolean() }) },
})
