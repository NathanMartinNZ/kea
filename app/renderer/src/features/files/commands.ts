// The file panel's commands (the Files category): Go to File…, Open in Editor, Reveal (in the file manager), the copy
// commands, Discard Changes…, the Changes header's menu, Refresh, Toggle Ignored Files, Reveal in File Tree (run by
// the viewer's breadcrumb with `{ sessionId, path }`), and the tree's file operations: New File…, New Folder…,
// Rename…, Move to Trash, Collapse All, Undo, Cut, Copy and Paste. The layout's three — Toggle File Panel, Show Files,
// Show Changes — are the window's (`shell/layoutStore.svelte.ts`). `App.svelte` calls this once for the window; it also
// starts the panel's data following the session on screen (state.svelte.ts).
//
// What a command acts on: run from a row's menu it gets that row (`FileTarget`; `''` is the session's folder, from the
// `files ⌃` menu); from the menu bar, a shortcut or the palette it acts on the row the keyboard is on in the list the
// panel shows. The file operations act on the tree's rows only: New File…, New Folder… and Paste act in a folder
// (`edit.ts` `folderOf`: a folder row, the folder a file is in, the session's folder with no row), and show Files
// first; Rename…, Move to Trash, Cut and Copy need a row of Files.

import { L, protocolOs } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { commands } from '../commands/registry.ts'
import { openInEditor } from '../editor/open.ts'
import { copyText, revealPath } from '../sessions/actions.ts'
import { activeSessionId, sessions, showToast, ui } from '../sessions/state.svelte.ts'
import { call } from '../../lib/rpc.ts'
import { changedList, discardBlocked, discardPlan, firstChangedLine } from './changes.ts'
import { folderOf, parentOf } from './edit.ts'
import { filesModel } from './model.ts'
import { keyboardInPanel, move, undo } from './operations.ts'
import { installFilesState, panel, type FileTarget } from './state.svelte.ts'

function isTarget(a: unknown): a is FileTarget {
  const o = a as Partial<FileTarget> | null | undefined
  return typeof o === 'object' && o !== null && typeof o.sessionId === 'string' && typeof o.path === 'string'
}

/** The row a command acts on: the one given, else the one the keyboard is on. Null: none. */
function target(a: unknown): FileTarget | null {
  if (isTarget(a)) return a.path === '' ? null : { sessionId: a.sessionId, path: a.path, dir: a.dir === true, ...(a.from ? { from: a.from } : {}) }
  const id = filesModel.sessionId
  if (id === null) return null
  if (panel.mode === 'changes') {
    const sel = filesModel.ui.changes.sel
    return sel !== null && filesModel.changeIndex(sel) >= 0 ? { sessionId: id, path: sel, dir: false } : null
  }
  const sel = filesModel.ui.files.sel
  const row = filesModel.rows[filesModel.rowIndex(sel)]
  return row && row.kind !== 'more' && row.kind !== 'pending' ? { sessionId: id, path: sel ?? row.path, dir: row.kind === 'dir' } : null
}

/** As `target`, and the session's folder itself from the `files ⌃` menu (Reveal in Finder, Copy Path). */
function targetOrRoot(a: unknown): FileTarget | null {
  return isTarget(a) && a.path === '' ? { sessionId: a.sessionId, path: '', dir: true } : target(a)
}

/**
 * The tree's row a file operation acts on (Rename…, Move to Trash, Cut, Copy): the menu's, else the one selected in
 * Files (a compact row: its deepest folder). Null: none, a Changes row, the session's folder itself, another session's.
 */
function treeTarget(a: unknown): FileTarget | null {
  const id = filesModel.sessionId
  if (isTarget(a)) return a.from === 'changes' || a.path === '' || a.sessionId !== id ? null : { sessionId: a.sessionId, path: a.path, dir: a.dir === true, from: 'tree' }
  if (id === null || panel.mode !== 'files') return null
  const row = filesModel.rows[filesModel.rowIndex(filesModel.ui.files.sel)]
  return row && row.kind !== 'more' && row.kind !== 'pending' ? { sessionId: id, path: row.path, dir: row.kind === 'dir', from: 'tree' } : null
}

/** The folder New File…, New Folder… and Paste act in (`''`: the session's folder). Null: no session, a Changes row. */
function folderTarget(a: unknown): { sessionId: string; dir: string } | null {
  const id = filesModel.sessionId
  if (isTarget(a)) return a.from === 'changes' || a.sessionId !== id ? null : { sessionId: a.sessionId, dir: a.path === '' ? '' : a.dir ? a.path : parentOf(a.path) }
  if (id === null || !filesModel.opened) return null
  return { sessionId: id, dir: folderOf(filesModel.rows[filesModel.rowIndex(filesModel.ui.files.sel)]) }
}

/** An operation run from a list key or the tree's menus (the keyboard then goes back to the list). */
const beganInList = (a: unknown): boolean => (isTarget(a) ? a.from === 'tree' : keyboardInPanel())

const NO_TREE_ROW = 'Select a file or folder in Files first'
const BUSY = 'Another file operation is under way'
const NO_TRASH = `No tool on ${protocolOs.words.machine} moves files to the Trash`

/** Why a file operation cannot run now; undefined: it can. */
function opBlocked(t: unknown | null): string | undefined {
  if (filesModel.sessionId === null) return NO_SESSION
  if (t === null) return NO_TREE_ROW
  if (panel.busy) return BUSY
  return undefined
}

/** The file panel shows Files (shown first by an operation run from elsewhere). */
function showFilesFirst(): void {
  const hidden = document.querySelector<HTMLElement>('.file-panel')?.hidden !== false
  if (panel.mode !== 'files' || hidden) commands.run('files.showFiles')
}

function startNew(a: unknown, entry: 'file' | 'dir'): void {
  const t = folderTarget(a)
  if (!t) return
  const fromList = beganInList(a)
  showFilesFirst()
  if (t.dir !== '' && !filesModel.isExpanded(t.dir)) filesModel.expand(t.dir)
  panel.menu = null
  panel.hidden = null
  filesModel.setPending({ dir: t.dir, kind: entry })
  panel.edit = { kind: 'new', sessionId: t.sessionId, dir: t.dir, entry, fromList }
}

function startRename(a: unknown): void {
  const t = treeTarget(a)
  if (!t) return
  panel.menu = null
  filesModel.setPending(null)
  filesModel.select('files', t.path)
  panel.edit = { kind: 'rename', sessionId: t.sessionId, path: t.path, dir: t.dir, fromList: beganInList(a) }
}

function clip(a: unknown, cut: boolean): void {
  const t = treeTarget(a)
  if (t) panel.clip = { sessionId: t.sessionId, path: t.path, dir: t.dir, cut }
}

function askTrash(a: unknown): void {
  const t = treeTarget(a)
  if (!t) return
  // one sheet at a time at the top of the main pane
  ui.sheet = null
  panel.discard = null
  panel.trash = { sessionId: t.sessionId, path: t.path, dir: t.dir, fromList: beganInList(a) }
}

/** The row, when it is a file. */
const fileTarget = (a: unknown): FileTarget | null => {
  const t = target(a)
  return t && !t.dir ? t : null
}

/** The row's path on disk (`''`: the session's folder); null when the session's folder is not known. */
function absolute(t: FileTarget): string | null {
  const cwd = sessions.get(t.sessionId)?.cwd
  if (!cwd) return null
  const top = cwd.replace(/\/+$/, '')
  return t.path === '' ? top : `${top}/${t.path}`
}

/** The session a panel-wide command (the Changes header's, Refresh, Toggle Ignored) is for: the one on screen. */
const session = (a: unknown): string | null => (isTarget(a) && a.sessionId === filesModel.sessionId ? a.sessionId : filesModel.sessionId)

const NO_ROW = 'Select a file in the file panel first'
const NO_SESSION = 'No session is open'
const NOT_GIT = 'This folder is not a git repository'

/**
 * Open in Editor for a row of the Changes list (`⌘↵`, a double-click, the row's menu): the file at its first changed
 * line, which core is asked for (`viewer.changes`: the ranges the viewer's gutter marks, in the session's scope).
 * Without an answer the file opens with no position.
 */
export function openChangeInEditor(sessionId: string, path: string): void {
  const line = call('viewer.changes', { sessionId, path }).then((c) => {
    const n = firstChangedLine(c)
    return n === null ? null : { line: n }
  })
  void openInEditor({ target: 'session', id: sessionId, path }, line)
}

/** The changed files Open All in Editor would open: what is still on disk. */
const openable = (): string[] => filesModel.changes.filter((e) => e.code !== 'D' && !e.submodule).map((e) => e.path)

async function openAllChanged(sessionId: string): Promise<void> {
  // one path per call (`openInEditor` takes one), one after the other: the editor is asked for each file in turn, and
  // a failure ends it
  for (const path of openable()) {
    const r = await openInEditor({ target: 'session', id: sessionId, path })
    if (!r.ok) return
  }
}

function askDiscard(t: FileTarget): void {
  const entry = filesModel.sessionId === t.sessionId ? filesModel.entry(t.path) : null
  // the status the entry is a row of: its scope and base are what the sheet's sentence is written for
  const head = filesModel.gitHead
  if (!entry || !head) return
  // one sheet at a time at the top of the main pane
  ui.sheet = null
  panel.discard = { sessionId: t.sessionId, entry, plan: discardPlan(entry, head) }
}

/** The way back from the viewer (`viewer.open` reversed): show the panel's Files and put the keyboard on the row. */
function revealInTree(a: unknown): void {
  const t = isTarget(a) && a.path !== '' ? a : panel.activeFile
  if (!t || t.sessionId !== filesModel.sessionId) return
  filesModel.reveal(t.path)
  // Show Files shows the panel and takes the keyboard there; pressed in the panel itself it would hide it
  if (panel.mode !== 'files' || !document.activeElement?.closest('.file-panel')) commands.run('files.showFiles')
}

export function registerFilesCommands(): Disposable {
  const state = installFilesState()
  const ds = [
    commands.register('files.goToFile', {
      // the finder is the palette's file mode: one floating layer
      run: () => {
        commands.run('view.palette', { mode: 'files' })
      },
      when: () => activeSessionId() !== null,
      unavailableReason: () => NO_SESSION,
    }),
    commands.register('files.openInEditor', {
      run: (a) => {
        const t = fileTarget(a)
        if (!t) return
        // from the Changes list a changed file opens at its first changed line; from the tree, the file
        if (panel.mode === 'changes' && t.sessionId === filesModel.sessionId && filesModel.entry(t.path)) openChangeInEditor(t.sessionId, t.path)
        else void openInEditor({ target: 'session', id: t.sessionId, path: t.path })
      },
      // a deleted file has nothing to open
      when: (a) => {
        const t = fileTarget(a)
        return t !== null && filesModel.entry(t.path)?.code !== 'D'
      },
      unavailableReason: () => NO_ROW,
    }),
    commands.register('files.reveal', {
      run: (a) => {
        const t = targetOrRoot(a)
        const abs = t ? absolute(t) : null
        if (abs) revealPath(abs)
      },
      when: (a) => {
        const t = targetOrRoot(a)
        return t !== null && absolute(t) !== null && filesModel.entry(t.path)?.code !== 'D'
      },
      unavailableReason: () => NO_ROW,
    }),
    commands.register('files.copyPath', {
      run: (a) => {
        const t = targetOrRoot(a)
        const abs = t ? absolute(t) : null
        if (abs) void copyText(abs)
      },
      when: (a) => {
        const t = targetOrRoot(a)
        return t !== null && absolute(t) !== null
      },
      unavailableReason: () => NO_ROW,
    }),
    // ── the tree's file operations ──
    commands.register('files.newFile', {
      run: (a) => startNew(a, 'file'),
      when: (a) => folderTarget(a) !== null && !panel.busy,
      unavailableReason: (a) => opBlocked(folderTarget(a)),
    }),
    commands.register('files.newFolder', {
      run: (a) => startNew(a, 'dir'),
      when: (a) => folderTarget(a) !== null && !panel.busy,
      unavailableReason: (a) => opBlocked(folderTarget(a)),
    }),
    commands.register('files.collapseAll', {
      run: () => {
        showFilesFirst()
        filesModel.collapseAll()
      },
      when: () => filesModel.sessionId !== null,
      unavailableReason: () => NO_SESSION,
    }),
    commands.register('files.rename', {
      run: startRename,
      when: (a) => treeTarget(a) !== null && !panel.busy,
      unavailableReason: (a) => opBlocked(treeTarget(a)),
    }),
    commands.register('files.trash', {
      run: askTrash,
      when: (a) => treeTarget(a) !== null && !panel.busy && filesModel.trashTool,
      unavailableReason: (a) => opBlocked(treeTarget(a)) ?? NO_TRASH,
    }),
    commands.register('files.undo', {
      run: (a) => {
        const id = filesModel.sessionId
        if (id !== null) void undo(id, beganInList(a))
      },
      when: () => filesModel.sessionId !== null && filesModel.undoKind !== null && !panel.busy,
      unavailableReason: () => (filesModel.sessionId === null ? NO_SESSION : panel.busy ? BUSY : 'Nothing to undo in the file tree'),
      title: () => (filesModel.undoKind === 'rename' ? 'Undo Rename' : 'Undo Move'),
    }),
    // Kea's own file clipboard: one entry, the system's clipboard untouched
    commands.register('files.cut', {
      run: (a) => clip(a, true),
      when: (a) => treeTarget(a) !== null,
      unavailableReason: (a) => opBlocked(treeTarget(a)),
      title: (a) => (treeTarget(a)?.dir ? 'Cut Folder' : 'Cut File'),
    }),
    commands.register('files.copy', {
      run: (a) => clip(a, false),
      when: (a) => treeTarget(a) !== null,
      unavailableReason: (a) => opBlocked(treeTarget(a)),
      title: (a) => (treeTarget(a)?.dir ? 'Copy Folder' : 'Copy File'),
    }),
    commands.register('files.paste', {
      run: (a) => {
        const t = folderTarget(a)
        const c = panel.clip
        if (!t || !c || c.sessionId !== t.sessionId) return
        showFilesFirst()
        void move(t.sessionId, c.path, t.dir, !c.cut, beganInList(a)).then((r) => {
          // a cut is pasted once; a copy as often as asked
          if (r?.ok && c.cut && panel.clip === c) panel.clip = null
        })
      },
      when: (a) => {
        const t = folderTarget(a)
        return t !== null && !panel.busy && panel.clip?.sessionId === t.sessionId
      },
      unavailableReason: (a) => {
        const t = folderTarget(a)
        if (t === null) return opBlocked(null)
        if (!panel.clip) return 'Cut or copy a file or folder in Files first'
        if (panel.clip.sessionId !== t.sessionId) return 'What was cut or copied is another session’s; Kea pastes within one session'
        return panel.busy ? BUSY : undefined
      },
      // in a Files row's menu while it cannot run, never in a Changes row's
      keepInMenus: (a) => !isTarget(a) || a.from !== 'changes',
    }),
    commands.register('files.copyRelativePath', {
      run: (a) => {
        const t = target(a)
        if (t) void copyText(t.path)
      },
      when: (a) => target(a) !== null,
      unavailableReason: () => NO_ROW,
    }),
    commands.register('files.discard', {
      run: (a) => {
        const t = fileTarget(a)
        if (t) askDiscard(t)
      },
      // in the row menu (`file ⌃`) for changed files only
      when: (a) => {
        const t = fileTarget(a)
        const e = t && t.sessionId === filesModel.sessionId ? filesModel.entry(t.path) : null
        return !!e && discardBlocked(e) === null
      },
      unavailableReason: (a) => {
        const t = fileTarget(a)
        const e = t && t.sessionId === filesModel.sessionId ? filesModel.entry(t.path) : null
        return e ? (discardBlocked(e) ?? undefined) : t ? 'The file has no changes' : NO_ROW
      },
    }),
    commands.register('files.toggleScope', {
      run: () => filesModel.setScope(filesModel.gitHead?.scope === 'branch' ? 'uncommitted' : 'branch'),
      when: (a) => session(a) !== null && filesModel.isGit && filesModel.gitHead !== null,
      unavailableReason: (a) => (session(a) === null ? NO_SESSION : NOT_GIT),
    }),
    commands.register('files.copyChangedList', {
      run: () => void copyText(changedList(filesModel.changes)),
      when: (a) => session(a) !== null && filesModel.changes.length > 0,
      unavailableReason: (a) => (session(a) === null ? NO_SESSION : 'No changed files'),
      keepInMenus: true,
    }),
    commands.register('files.openAllChanged', {
      run: (a) => {
        const id = session(a)
        if (id === null) return
        void openAllChanged(id).catch((e: unknown) => showToast({ message: `Couldn't open the changed files: ${e instanceof Error ? e.message : String(e)}` }))
      },
      when: (a) => {
        const n = openable().length
        return session(a) !== null && n > 0 && n <= L.openAllChangedMax
      },
      unavailableReason: (a) => {
        if (session(a) === null) return NO_SESSION
        const n = openable().length
        return n === 0 ? 'No changed files to open' : `Opens at most ${L.openAllChangedMax} files at once; ${n} are changed`
      },
      keepInMenus: true,
    }),
    commands.register('files.refresh', { run: () => filesModel.refresh(), when: (a) => session(a) !== null, unavailableReason: () => NO_SESSION }),
    commands.register('files.toggleIgnored', { run: () => filesModel.toggleIgnored(), when: () => filesModel.sessionId !== null, unavailableReason: () => NO_SESSION }),
    commands.register('files.revealInTree', {
      run: revealInTree,
      when: (a) => {
        const t = isTarget(a) && a.path !== '' ? a : panel.activeFile
        return !!t && t.sessionId === filesModel.sessionId
      },
      unavailableReason: () => 'No file is open in the viewer',
    }),
  ]
  return {
    dispose() {
      disposeAll(ds)
      state.dispose()
    },
  }
}
