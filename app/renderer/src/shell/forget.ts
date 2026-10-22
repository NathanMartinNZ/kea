// What the window keeps per session, project or PTY goes with it: the stores' list changes wired to every prune, once,
// by App.svelte. U-SB-5 drives this same wiring with stores of its own.
//
//   sessions list   the last active tab of each session, its file and diff tabs and the ⌃Tab order
//                   keep listed sessions only
//   projects list   the composer drafts and the open Archived groups keep existing projects only
//   terminals list  the scroll marks of released terminals keep existing PTYs only

import type { Project, PtyInfo, SessionView } from '@kea/protocol'
import type { Drafts } from '../features/composer/state.ts'
import { listed, type MruCycle } from '../features/sessions/model.ts'
import { forgetScrollMarks } from '../features/terminal/scrollMarks.ts'
import type { FrameStore } from '../lib/frameStore.ts'
import { forgetFileTabs } from './fileTabs.svelte.ts'
import { forgetTabs } from './terminalPane.ts'

export interface WindowStores {
  projects: FrameStore<Project>
  sessions: FrameStore<SessionView>
  terminals: FrameStore<PtyInfo>
}

/** What the window keeps that is not in a module of its own. */
export interface WindowKept {
  drafts: Drafts
  mru: MruCycle
  /** A session just created whose row may not be listed yet keeps its ⌃Tab place. */
  pending(): string | null
  /** The projects whose Archived group is open. */
  archivedOpen(): ReadonlySet<string>
  setArchivedOpen(next: ReadonlySet<string>): void
}

/** Wire the prunes; returns the unwiring. */
export function forgetWhatGoes(stores: WindowStores, kept: WindowKept): () => void {
  const isListed = (id: string) => {
    const s = stores.sessions.get(id)
    return !!s && listed(s)
  }
  const offs = [
    stores.sessions.subscribeList(() => {
      forgetTabs(isListed)
      forgetFileTabs(isListed)
      kept.mru.prune((id) => isListed(id) || id === kept.pending())
    }),
    stores.projects.subscribeList(() => {
      kept.drafts.prune((id) => !!stores.projects.get(id))
      const open = kept.archivedOpen()
      const still = [...open].filter((id) => !!stores.projects.get(id))
      if (still.length !== open.size) kept.setArchivedOpen(new Set(still))
    }),
    stores.terminals.subscribeList(() => forgetScrollMarks((id) => !!stores.terminals.get(id))),
  ]
  return () => {
    for (const off of offs) off()
  }
}
