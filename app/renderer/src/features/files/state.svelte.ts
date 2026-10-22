// The file panel's rune state: what the views react to. The data itself (the tree's rows, the git facts) is the
// plain model's (model.ts; nothing heavy sits in rune state): `panel.version` moves once per frame in which the
// model changed, and a view that reads it reads the model again.
//
// The floating pieces the panel opens are requests here, drawn by the window: the `file ⌃` and `changes ⋯` menus
// (FilesLayers.svelte) and the Discard Changes… sheet (DiscardSheet.svelte, in the main pane). The finder (`⌘P`) is
// the palette's file mode (features/palette).

import type { GitEntry } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { watch } from '../../lib/reactive.svelte.ts'
import { commands } from '../commands/registry.ts'
import { activeSessionId } from '../sessions/state.svelte.ts'
import type { DiscardPlan } from './changes.ts'
import { filesModel } from './model.ts'

/** What a `file ⌃` command acts on: a row of the tree or the Changes list. */
export interface FileTarget {
  sessionId: string
  /** Relative to the session's working directory. */
  path: string
  /** The row is a folder. */
  dir: boolean
}

export interface FileMenu {
  kind: 'file' | 'changes'
  /** `file`: the row. `changes`: the session whose Changes header it is. */
  target: FileTarget
  at: { x: number; y: number }
}

export interface DiscardAsk {
  sessionId: string
  entry: GitEntry
  plan: DiscardPlan
}

class PanelState {
  /** The model's `version`: read it, then read the model. */
  version = $state(0)
  menu = $state.raw<FileMenu | null>(null)
  discard = $state.raw<DiscardAsk | null>(null)
  /** The list the panel shows (Files for a folder that is not a repository): what a command with no row acts in. */
  mode = $state.raw<'files' | 'changes'>('files')
  /** The file or diff tab on screen in the main area, as the window tells the panel (`files.revealInTree` with no argument). */
  activeFile = $state.raw<{ sessionId: string; path: string } | null>(null)
}

export const panel = new PanelState()

/** The session on screen is a git work tree, as far as core has said (reactive). */
export function panelIsGit(): boolean {
  void panel.version
  return filesModel.isGit
}

/** The model follows the session on screen and tells rune state when it changed. Once per window. */
export function installFilesState(): Disposable {
  const follow = (): void => {
    const id = activeSessionId()
    if (id === filesModel.sessionId) return
    // what was open for the session left behind closes with it
    panel.menu = null
    panel.discard = null
    filesModel.follow(id)
  }
  // what the commands' availability reads of the model: the menus are told only when that changed
  let known = ''
  const offModel = filesModel.subscribe(() => {
    panel.version = filesModel.version
    filesModel.settle()
    const u = filesModel.ui
    const now = `${filesModel.sessionId}|${filesModel.isGit}|${filesModel.gitHead?.scope}|${filesModel.changes.length}|${u.files.sel}|${u.changes.sel}`
    if (now === known) return
    known = now
    commands.changed()
  })
  const offWatch = watch(activeSessionId, follow)
  follow()
  return {
    dispose() {
      offWatch()
      filesModel.follow(null)
      offModel()
      panel.menu = null
      panel.discard = null
    },
  }
}
