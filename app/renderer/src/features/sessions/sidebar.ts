// What the sidebar's rows do (the components are Sidebar.svelte and its row components): drag types, the status a glyph
// says, folding the Archived group, choosing a row and opening its menu.

import type { SessionView } from '@kea/protocol'
import { toggleProject } from './actions.ts'
import { statusWords, type SidebarRow } from './model.ts'
import { selectSession, ui } from './state.svelte.ts'

export const DRAG_PROJECT = 'application/x-kea-project'
export const DRAG_SESSION = 'application/x-kea-session'

/** What the glyph says (status is never colour-only): the status in words (`statusWords`). */
export const statusLabel = (s: SessionView): string => statusWords(s)

/** Open or close a project's Archived group. */
export function toggleArchived(projectId: string): void {
  const next = new Set(ui.archivedOpen)
  if (next.has(projectId)) next.delete(projectId)
  else next.add(projectId)
  ui.archivedOpen = next
}

/** ↵ or Space on a row: fold a project or the Archived group, show a session. */
export function activate(row: SidebarRow): void {
  if (row.kind === 'project') toggleProject(row.projectId)
  else if (row.kind === 'archived') toggleArchived(row.projectId)
  else selectSession(row.sessionId)
}

/** The row's context menu: at the pointer, or under the row from the keyboard. */
export function openRowMenu(row: SidebarRow, el: HTMLElement | null, at?: { x: number; y: number }): void {
  if (row.kind === 'archived') return
  const r = el?.getBoundingClientRect()
  const pos = at ?? { x: r ? r.left + r.width / 2 : 0, y: r ? r.bottom : 0 }
  ui.menu = row.kind === 'project' ? { kind: 'project', id: row.projectId, at: pos } : { kind: 'session', id: row.sessionId, at: pos }
}
