// What the sessions feature's menus and sheets say (the components are Menus.svelte, Sheets.svelte and the sheets they
// show): the contextual menus generated from the command table and the header's overflow menu, what a
// delete would lose, and the wording shared by the sheets.

import { systemTitle, type DeletePreview, type RemoveBlocker, type Surface } from '@kea/protocol'
import type { MenuItem } from '@kea/ui'
import { shortcut } from '../commands/bindings.svelte.ts'
import { surfaceItems } from '../commands/menuItems.ts'
import { commands } from '../commands/registry.ts'
import { relativeTime } from './model.ts'
import { ui } from './state.svelte.ts'

export const MENU_SURFACE: Record<'session' | 'project' | 'header', Surface> = { session: 'session ⌃', project: 'project ⌃', header: 'header ⋯' }
export const MENU_LABEL: Record<'session' | 'project' | 'header', string> = { session: 'Session menu', project: 'Project menu', header: 'Session actions' }

/**
 * A contextual menu's items (commands/menuItems.ts): the surface's commands in table order, only those available
 * for the row, plus the ones kept there disabled with their reason (`keepInMenus`), each with its key now.
 */
export function menuItems(surface: Surface, args: unknown): MenuItem[] {
  return surfaceItems(surface, args, { inMenus: (id, a) => commands.inMenus(id, a), reason: (id, a) => commands.reason(id, a), title: (c, a) => (c.titles ? commands.title(c.id, a) : systemTitle(c)), key: shortcut })
}

export const closeSheet = (): void => {
  ui.sheet = null
}

/** One line of the archive sheet's list (the wording is `archiveReason.ts`, pure and unit-tested). */
export { archiveReason } from './archiveReason.ts'

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Why a session keeps its project from being removed. */
export const REMOVE_BLOCKER: Record<RemoveBlocker, string> = { worktree: 'its worktree is on disk', creating: 'it is being created', createFailed: 'its creation failed' }

/** What will be lost and what stays recoverable, in exact numbers (commits only the branch holds). */
export function deleteSummary(p: DeletePreview): { lost: string; keeps: string | null } {
  if (p.isolation === 'inplace') return { lost: "Only Kea's record of the session is deleted; the project folder is not touched.", keeps: null }
  const lost: string[] = []
  if (p.uncommittedFiles > 0) lost.push(plural(p.uncommittedFiles, 'uncommitted file', 'uncommitted files'))
  if (p.ownCommits > 0) lost.push(plural(p.ownCommits, 'commit on no other branch or remote', 'commits on no other branch or remote'))
  // A commit another branch or a remote also holds is not lost, so a fresh session has nothing to lose
  const what = lost.length ? `Deleting removes the worktree with ${lost.join(' and ')}.` : p.merged ? 'Nothing is lost: the branch is merged.' : 'Nothing is lost: no uncommitted work, and every commit is on another branch or a remote.'
  const keeps = `Uncommitted changes and commits stay restorable for ${plural(p.retentionDays, 'day', 'days')} (Restore Deleted Session…).`
  return { lost: what, keeps }
}

/** "deleted 3h ago", "deleted just now". */
export function deletedAgo(at: number, now: number): string {
  const r = relativeTime(at, now)
  return r === 'now' ? 'deleted just now' : `deleted ${r} ago`
}
