// What the sidebar, the header and the commands do: each one call to core (projectsApi, sessionsApi) and what the
// window shows afterwards. Failures with no place of their own in the UI become a toast.

import type { Project } from '@kea/protocol'
import { pickFolder, reveal } from '../../lib/bridge.ts'
import { call } from '../../lib/rpc.ts'
import { agentGrid } from '../../shell/agentGrid.ts'
import { listed, moveIndex, orderProjects, orderSessions } from './model.ts'
import { failed, openComposer, projects, selectSession, sessions, ui } from './state.svelte.ts'

/** Why a project was registered at a path other than the one picked. */
function registeredNote(registered: 'asGiven' | 'repoRoot' | 'mainWorktree', p: Project): string | undefined {
  // a bare repository has no main worktree; the project is the repository's own folder
  if (p.bare && registered !== 'asGiven') return `Added the bare repository, ${p.rootPath}, for the folder you picked: its sessions run in worktrees.`
  if (registered === 'repoRoot') return `Added the repository root, ${p.rootPath}, for the folder you picked.`
  if (registered === 'mainWorktree') return `Added the main worktree, ${p.rootPath}: the folder you picked is one of its linked worktrees.`
  return undefined
}

/** Focus a project's row in the sidebar (adding it again focuses it). */
export function focusProject(id: string): void {
  const p = projects.get(id)
  if (p?.collapsed) void call('projects.setCollapsed', { id, collapsed: false }).catch(() => undefined)
  ui.set({ sidebarFocus: ui.sidebarFocus + 1, focusRow: `p:${id}` })
}

/** Register a folder (from `⌘O`, a drop, or a test's queued pick). */
export async function addProjectAt(path: string): Promise<void> {
  try {
    const r = await call('projects.add', { path })
    if (r.existing) {
      focusProject(r.project.id)
      return
    }
    // a project with no sessions opens the composer, already focused
    const note = registeredNote(r.registered, r.project)
    openComposer(r.project.id, { seed: { projectId: r.project.id, ...(note ? { note } : {}) } })
  } catch (e) {
    failed("Couldn't add the project", e)
  }
}

/** `⌘O` (project.add): the native folder picker, then the project is added. */
export async function addProject(): Promise<void> {
  const path = await pickFolder('add')
  if (path) await addProjectAt(path)
}

/** Locate… a missing project; linked worktrees are repaired. */
export async function locateProject(id: string): Promise<void> {
  const path = await pickFolder('locate')
  if (!path) return
  try {
    await call('projects.locate', { id, path })
  } catch (e) {
    failed("Couldn't locate the project", e)
  }
}

/** Remove Project… opens its confirmation, which asks core what removing would do. */
export function askRemoveProject(id: string): void {
  ui.sheet = { kind: 'removeProject', projectId: id, removal: null }
}

/** Remove; refused while sessions keep the project, or run without `stopSessions`: the sheet shows core's answer. */
export async function removeProject(id: string, stopSessions: boolean): Promise<void> {
  try {
    const r = await call('projects.remove', { id, ...(stopSessions ? { stopSessions: true } : {}) })
    const { removed, ...removal } = r
    if (removed) ui.sheet = null
    else ui.sheet = { kind: 'removeProject', projectId: id, removal }
  } catch (e) {
    ui.sheet = null
    failed("Couldn't remove the project", e)
  }
}

/** A click on a project row folds or unfolds it; persisted. */
export function toggleProject(id: string): void {
  const p = projects.get(id)
  if (!p) return
  void call('projects.setCollapsed', { id, collapsed: !p.collapsed }).catch((e: unknown) => failed("Couldn't fold the project", e))
}

/** Move a project just past another (a drop on its row, or ⌥↑ / ⌥↓); persisted. False when nothing moves. */
export function moveProjectPast(id: string, target: string): boolean {
  const index = moveIndex(
    orderProjects(projects.values()).map((p) => p.id),
    id,
    target,
  )
  if (index === null) return false
  void call('projects.move', { id, index }).catch((e: unknown) => failed("Couldn't move the project", e))
  return true
}

/** Move a session just past another of its project (a drop, or ⌥↑ / ⌥↓); persisted. False when nothing moves. */
export function moveSessionPast(id: string, target: string): boolean {
  const s = sessions.get(id)
  const t = sessions.get(target)
  if (!s || !t || s.projectId !== t.projectId) return false
  // core's order: every listed session of the project, archived ones too
  const all = orderSessions(sessions.inGroup(s.projectId).filter(listed), 'stable').map((x) => x.id)
  const index = moveIndex(all, id, target)
  if (index === null) return false
  void call('sessions.move', { id, index }).catch((e: unknown) => failed("Couldn't move the session", e))
  return true
}

/** A user rename wins forever. */
export async function renameSession(id: string, title: string): Promise<void> {
  const t = title.trim()
  ui.renaming = null
  if (!t || t === sessions.get(id)?.title) return
  try {
    await call('sessions.rename', { id, title: t })
  } catch (e) {
    failed("Couldn't rename the session", e)
  }
}

/** Archive; asks first only when core gives reasons to (`reasons`). */
export async function archiveSession(id: string, confirmed = false): Promise<void> {
  try {
    const r = await call('sessions.archive', { id, ...(confirmed ? { confirmed: true } : {}) })
    if (!r.archived && r.reasons.length) ui.sheet = { kind: 'archive', sessionId: id, reasons: r.reasons }
    else ui.sheet = null
  } catch (e) {
    failed("Couldn't archive the session", e)
  }
}

/** Duplicate opens the composer pre-filled, base = this session's branch. */
export async function duplicateSession(id: string): Promise<void> {
  try {
    const { draft } = await call('sessions.duplicate', { id })
    openComposer(draft.projectId, { seed: { projectId: draft.projectId, draft } })
  } catch (e) {
    failed("Couldn't duplicate the session", e)
  }
}

/** A session call that only needs its id, with its failure toasted. One that starts an agent sends the agent's grid. */
export async function sessionCall(method: 'sessions.stop' | 'sessions.resume' | 'sessions.restart' | 'sessions.unarchive' | 'sessions.retry' | 'sessions.discard' | 'sessions.recreateWorktree' | 'sessions.retryTeardown', id: string, what: string): Promise<void> {
  try {
    const grid = method === 'sessions.resume' || method === 'sessions.restart' || method === 'sessions.retry' ? agentGrid() : undefined
    await call(method, { id, ...(grid ? { grid } : {}) })
  } catch (e) {
    failed(`Couldn't ${what}`, e)
  }
}

/** "Re-sync copied files": core copies them again from the main checkout; only a failure is toasted. */
export async function resyncFiles(id: string): Promise<void> {
  try {
    await call('sessions.resyncFiles', { id })
  } catch (e) {
    failed("Couldn't re-sync the copied files", e)
  }
}

export function revealPath(path: string): void {
  reveal(path)
}

/** Copy text; the clipboard write needs the window focused, which a click gives it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Show a session (all three columns follow). */
export function openSession(id: string): void {
  selectSession(id)
}
