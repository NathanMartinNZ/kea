// The file panel's rune state: what the views react to. The data itself (the tree's rows, the git facts) is the
// plain model's (model.ts; nothing heavy sits in rune state): `panel.version` moves once per frame in which the
// model changed, and a view that reads it reads the model again.
//
// The floating pieces the panel opens are requests here, drawn by the window: the `file ⌃`, `files ⌃` and `changes ⋯`
// menus (FilesLayers.svelte), the Discard Changes…, Move to Trash and copy sheets (in the main pane) and the tree's
// name field (NameField.svelte). The finder (`⌘P`) is the palette's file mode (features/palette). The file clipboard
// (Cut, Copy, Paste) is one entry here too: Kea's own, the system clipboard untouched.

import type { GitEntry } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { watch } from '../../lib/reactive.svelte.ts'
import { commands } from '../commands/registry.ts'
import { activeSessionId, sessions } from '../sessions/state.svelte.ts'
import type { DiscardPlan } from './changes.ts'
import { filesModel } from './model.ts'

/** What a `file ⌃` command acts on: a row of the tree or the Changes list (`''` with `dir`: the session's folder). */
export interface FileTarget {
  sessionId: string
  /** Relative to the session's working directory. */
  path: string
  /** The row is a folder. */
  dir: boolean
  /** The list the row is in; absent: the tree. The file operations act on the tree's rows only. */
  from?: 'tree' | 'changes'
}

/** The tree's name field: a new entry's name in the folder `dir`, or a new name for `path`. */
export type EditAsk = { sessionId: string; fromList: boolean } & ({ kind: 'new'; dir: string; entry: 'file' | 'dir' } | { kind: 'rename'; path: string; dir: boolean })

/** Move to Trash…, asked before anything is done: the entry, and whether the sheet names a folder. */
export interface TrashAsk {
  sessionId: string
  path: string
  dir: boolean
  fromList: boolean
}

/** A drop from another app, measured: what the sheet asks to copy where. */
export interface CopyInAsk {
  sessionId: string
  toDir: string
  sources: string[]
  entries: number
  bytes: number
}

/** The file clipboard's one entry: a row cut or copied in the tree (its session's). */
export interface FileClip {
  sessionId: string
  path: string
  dir: boolean
  cut: boolean
}

export interface FileMenu {
  /** `file ⌃` on a row, `files ⌃` for the session's folder (the Files bar, the space under the rows), `changes ⋯`. */
  kind: 'file' | 'files' | 'changes'
  /** `file`: the row. `files`: the session's folder (`''`). `changes`: the session whose Changes header it is. */
  target: FileTarget
  at: { x: number; y: number }
  /** The button it hangs from (`menuTrigger`), when a button opened it: a click there closes it. */
  trigger?: string
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
  /** The tree's name field (New File…, New Folder…, Rename…). */
  edit = $state.raw<EditAsk | null>(null)
  trash = $state.raw<TrashAsk | null>(null)
  copyIn = $state.raw<CopyInAsk | null>(null)
  /** A file operation's result git ignores while ignored files are hidden: the note line says it is there. */
  hidden = $state.raw<{ sessionId: string; path: string } | null>(null)
  /** A file operation is under way: the commands wait for it. */
  busy = $state(false)
  clip = $state.raw<FileClip | null>(null)
  /** The folder a row dragged in the tree would drop into (`''`: the root), drawn as the drop target. */
  dropDir = $state.raw<string | null>(null)
  /** The list the panel shows (Files for a folder that is not a repository): what a command with no row acts in. */
  mode = $state.raw<'files' | 'changes'>('files')
  /** The file or diff tab on screen in the main area, as the window tells the panel (`files.revealInTree` with no argument). */
  activeFile = $state.raw<{ sessionId: string; path: string } | null>(null)
}

export const panel = new PanelState()

/** The name field closes: its pending row goes with it. */
export function endEdit(): void {
  panel.edit = null
  filesModel.setPending(null)
}

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
    panel.edit = null
    panel.trash = null
    panel.copyIn = null
    panel.hidden = null
    panel.dropDir = null
    // the file clipboard keeps its entry across sessions (Paste says it is another session's), until that one is gone
    if (panel.clip && !sessions.get(panel.clip.sessionId)) panel.clip = null
    filesModel.follow(id)
  }
  // what the commands' availability reads of the model: the menus are told only when that changed
  let known = ''
  const offModel = filesModel.subscribe(() => {
    panel.version = filesModel.version
    filesModel.settle()
    const u = filesModel.ui
    const now = `${filesModel.sessionId}|${filesModel.isGit}|${filesModel.gitHead?.scope}|${filesModel.changes.length}|${u.files.sel}|${u.changes.sel}|${filesModel.trashTool}|${filesModel.undoKind}|${filesModel.opened}`
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
      panel.edit = null
      panel.trash = null
      panel.copyIn = null
      panel.hidden = null
      panel.clip = null
      panel.dropDir = null
    },
  }
}
