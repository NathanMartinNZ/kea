// The window's file and diff tabs, per session: what `shell/tabs.ts` computes, kept beyond one mount of the terminal
// pane so a session's tabs are there when it is selected again, and dropped with the session (`shell/forget.ts`). A
// runes store: plain data only — paths, modes and each tab's small view state, never a document or an editor. The pane
// (`TerminalPane.svelte`) is the only writer.

import type { ViewMode } from '@kea/protocol'
import { movedPath } from '../features/files/edit.ts'
import { watch } from '../lib/reactive.svelte.ts'
import { fileTabId, NO_FILE_TABS, type FileTabs } from './tabs.ts'

class FileTabsState {
  // bounded: one entry per session that has file tabs, each at most 1 preview + L.viewerPinnedTabsMax pinned with their
  // small view state; pruned with the sessions list
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

// bounded: one entry per file tab moved since its pane last looked (at most the session's file tabs: pruned at each move)
const moved = new Map<string, string>()
const movedKey = (sessionId: string, id: string): string => `${sessionId}\0${id}`

/**
 * A file or folder of `sessionId` moved or was renamed in the file tree: its file tabs (a folder's: every one at or
 * under it) show the entry at its new path, with their place and view state. A diff tab stays on the old path, which
 * then reads as deleted. The pane that shows a moved tab finds it again with `takeMovedTab`.
 */
export function moveFileTabs(sessionId: string, from: string, to: string): void {
  const cur = fileTabsOf(sessionId)
  const taken = new Set(cur.tabs.map((t) => t.id))
  let changed = false
  const tabs = cur.tabs.map((t) => {
    if (t.mode !== 'file') return t
    const path = movedPath(t.path, from, to)
    const id = fileTabId(path)
    if (path === t.path || taken.has(id)) return t
    changed = true
    moved.set(movedKey(sessionId, t.id), id)
    return { ...t, id, path }
  })
  if (!changed) return
  setFileTabs(sessionId, { ...cur, tabs })
  const ids = new Set(tabs.map((t) => t.id))
  for (const [k, v] of moved) if (k.startsWith(`${sessionId}\0`) && !ids.has(v)) moved.delete(k)
  const shown = fileTabsState.shown
  if (shown?.sessionId === sessionId && shown.mode === 'file' && movedPath(shown.path, from, to) !== shown.path) fileTabsState.shown = { ...shown, path: movedPath(shown.path, from, to) }
}

/** The id a file tab of `sessionId` has after it moved (`moveFileTabs`), taken once; null: it did not move. */
export function takeMovedTab(sessionId: string, id: string): string | null {
  const k = movedKey(sessionId, id)
  const to = moved.get(k) ?? null
  moved.delete(k)
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
