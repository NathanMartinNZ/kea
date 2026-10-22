// The `worktrees` feature's messages: what the renderer asks of worktrees beyond a session's own calls (those are in
// sessions.ts). Launch-time reconciliation lists worktrees under a Kea worktree root that no session owns:
// Project settings › "Orphaned worktrees", with Adopt and Remove.
import { z } from 'zod'
import { defineApi } from './rpc.ts'
import { zProjectId } from './sessions.ts'
import { zSessionId } from './terminal.ts'

/** A worktree under a Kea worktree root with no session. */
export const zOrphanWorktree = z.object({
  path: z.string(),
  /** The Kea worktree root it is under (the setting, or one recorded on a session). */
  root: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  locked: z.boolean(),
  prunable: z.boolean(),
})
export type OrphanWorktree = z.infer<typeof zOrphanWorktree>

export const worktreesApi = defineApi({
  /** A project's orphaned worktrees, as of the last reconciliation (`refresh`: run it again first). */
  'worktrees.orphans': { args: z.object({ projectId: zProjectId, refresh: z.boolean().optional() }), result: z.object({ orphans: z.array(zOrphanWorktree) }) },
  /** The project root has a `.worktreeinclude`, which replaces its "Files to copy" in Project settings. */
  'worktrees.includeFile': { args: z.object({ projectId: zProjectId }), result: z.object({ exists: z.boolean() }) },
  /** Adopt: the worktree becomes a `detached` session of the project, on its branch. */
  'worktrees.adopt': { args: z.object({ projectId: zProjectId, path: z.string().startsWith('/') }), result: z.object({ sessionId: zSessionId }) },
  /**
   * Remove: the orphan is moved to its root's `.kea-trash` and pruned. Refused while it has uncommitted changes
   * (`dirty`), or while `git status` fails there so they cannot be counted (`statusFailed`), unless `force` (the
   * UI listed them first).
   */
  'worktrees.remove': {
    args: z.object({ projectId: zProjectId, path: z.string().startsWith('/'), force: z.boolean().optional() }),
    result: z.object({ removed: z.boolean(), dirty: z.number().int().min(0), statusFailed: z.boolean() }),
  },
})
