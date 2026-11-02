// The window's file and diff tabs, per session: what `shell/tabs.ts` computes, kept beyond one mount of the terminal
// pane so a session's tabs are there when it is selected again, and dropped with the session (`shell/forget.ts`). A
// runes store: plain data only — paths, modes and each tab's small view state, never a document or an editor. The pane
// (`TerminalPane.svelte`) is the only writer.

import type { ViewMode } from '@kea/protocol'
import { movedPath } from '../features/files/edit.ts'
import { watch } from '../lib/reactive.svelte.ts'
import { fileTabId, NO_FILE_TABS, type FileTabs } from './tabs.ts'

class FileTabsState {
  // bounded: one entry per session that has file tabs, each at most 1 preview + L.viewerPinnedTabsMax pinned, plus the
  // tabs the pinned cap keeps for their unsaved changes (at most L.viewerUnsavedMax + 1), with their small view state;
  // pruned with the sessions list
  bySession = $state.raw<ReadonlyMap<string, FileTabs>>(new Map())
  /** The file or diff tab the main area shows now; null while it shows a terminal, or no session. */
  shown = $state.raw<{ sessionId: string; path: string; mode: ViewMode } | null>(null)
}

export const fileTabsState = new FileTabsState()

export function fileTabsOf(sessionId: string): FileTabs {
  return fileTabsState.bySession.get(sessionId) ?? NO_FILE_TABS
}

export function setFileTabs(sessionId: string, next: FileTabs): void {
  const cur = fileTabsState.bySession
  if ((cur.get(sessionId) ?? NO_FILE_TABS) === next) return
  const m = new Map(cur)
  if (next.tabs.length === 0) m.delete(sessionId)
  else m.set(sessionId, next)
  fileTabsState.bySession = m
}

/** The strip as the viewer may know it (`features/viewer/commands.ts` `TabStrip`): it drops what a closed tab kept. */
export const fileTabStrip = {
  has: (sessionId: string, path: string): boolean => fileTabsOf(sessionId).tabs.some((t) => t.path === path),
  onChange: (fn: () => void): (() => void) => watch(() => fileTabsState.bySession, fn),
}

/** The pane of `sessionId` shows this file tab (null: a terminal, or the pane went). */
export function reportShownFile(sessionId: string, tab: { path: string; mode: ViewMode } | null): void {
  const cur = fileTabsState.shown
  if (!tab) {
    if (cur?.sessionId === sessionId) fileTabsState.shown = null
    return
  }
  if (cur?.sessionId === sessionId && cur.path === tab.path && cur.mode === tab.mode) return
  fileTabsState.shown = { sessionId, path: tab.path, mode: tab.mode }
}

// bounded: one entry per file tab moved since its session's pane last looked at its tabs (at most the session's file
// tabs: pruned at each move, and emptied for the session at each look)
const moved = new Map<string, string>()
const movedKey = (sessionId: string, id: string): string => `${sessionId}\0${id}`

/**
 * A file or folder of `sessionId` moved or was renamed in the file tree: its file tabs (a folder's: every one at or
 * under it) show the entry at its new path, with their place and view state. A tab left at a path a moved file takes
 * (its own file is not there) closes. A diff tab stays on the old path, which then reads as deleted. The pane that
 * shows a moved tab finds it again with `takeMovedTab`.
 */
export function moveFileTabs(sessionId: string, from: string, to: string): void {
  const cur = fileTabsOf(sessionId)
  const going = cur.tabs.filter((t) => t.mode === 'file' && movedPath(t.path, from, to) !== t.path)
  if (going.length === 0) return
  const takes = new Set(going.map((t) => fileTabId(movedPath(t.path, from, to))))
  const tabs = cur.tabs
    .filter((t) => !takes.has(t.id) || going.includes(t))
    .map((t) => {
      if (!going.includes(t)) return t
      const path = movedPath(t.path, from, to)
      const id = fileTabId(path)
      moved.set(movedKey(sessionId, t.id), id)
      return { ...t, id, path }
    })
  setFileTabs(sessionId, { ...cur, tabs })
  const ids = new Set(tabs.map((t) => t.id))
  for (const [k, v] of moved) if (k.startsWith(`${sessionId}\0`) && !ids.has(v)) moved.delete(k)
  const shown = fileTabsState.shown
  if (shown?.sessionId === sessionId && shown.mode === 'file' && movedPath(shown.path, from, to) !== shown.path) fileTabsState.shown = { ...shown, path: movedPath(shown.path, from, to) }
}

/**
 * The pane of `sessionId` looks at its tabs after they changed: the id its tab on screen, `id`, has after it moved
 * (`moveFileTabs`); null when it did not move, or the pane looks for none (its tab is still there). The session's other
 * moves go with the look: no other tab of the pane is looked for, and a tab opened later at a path one moved from is
 * not the moved one.
 */
export function takeMovedTab(sessionId: string, id: string | null): string | null {
  const to = id === null ? null : (moved.get(movedKey(sessionId, id)) ?? null)
  for (const k of [...moved.keys()]) if (k.startsWith(`${sessionId}\0`)) moved.delete(k)
  return to
}

/** File tabs the window holds, over all sessions (the resource report's `renderer.fileTabs`). */
export function fileTabMemory(): number {
  let n = 0
  for (const t of fileTabsState.bySession.values()) n += t.tabs.length
  return n
}

export function forgetFileTabs(exists: (sessionId: string) => boolean): void {
  for (const k of [...moved.keys()]) if (!exists(k.slice(0, k.indexOf('\0')))) moved.delete(k)
  const cur = fileTabsState.bySession
  if ([...cur.keys()].every(exists)) return
  fileTabsState.bySession = new Map([...cur].filter(([id]) => exists(id)))
}
