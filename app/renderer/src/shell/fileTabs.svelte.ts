// The window's file and diff tabs, per session: what `shell/tabs.ts` computes, kept beyond one mount of the terminal
// pane so a session's tabs are there when it is selected again, and dropped with the session (`shell/forget.ts`). A
// runes store: plain data only — paths, modes and each tab's small view state, never a document or an editor. The pane
// (`TerminalPane.svelte`) is the only writer.

import type { ViewMode } from '@kea/protocol'
import { watch } from '../lib/reactive.svelte.ts'
import { NO_FILE_TABS, type FileTabs } from './tabs.ts'

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

/** File tabs the window holds, over all sessions (the resource report's `renderer.fileTabs`). */
export function fileTabMemory(): number {
  let n = 0
  for (const t of fileTabsState.bySession.values()) n += t.tabs.length
  return n
}

export function forgetFileTabs(exists: (sessionId: string) => boolean): void {
  const cur = fileTabsState.bySession
  if ([...cur.keys()].every(exists)) return
  fileTabsState.bySession = new Map([...cur].filter(([id]) => exists(id)))
}
