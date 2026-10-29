// The window's side of the file tree's operations: the calls to core, one at a time from this window (`panel.busy`,
// which the commands read), and what follows each answer (`edit.ts` `afterPlan`): the result selected, the open folders
// and the window's keys moved with a folder, file tabs following their file, the note for a result ignored files hide,
// and Undo's title. Refusals become toasts, but the name field's own (`name`, `exists`), which it shows in place.

import type { FileOpRefused, FileOpResult } from '@kea/protocol'
import { call } from '../../lib/rpc.ts'
import { moveFileTabs } from '../../shell/fileTabs.svelte.ts'
import { commands } from '../commands/registry.ts'
import { showToast } from '../sessions/state.svelte.ts'
import { afterPlan, nextAfter, opMessage, parentOf } from './edit.ts'
import { filesModel } from './model.ts'
import { panel } from './state.svelte.ts'

/** The keyboard is in the file panel now. */
export const keyboardInPanel = (): boolean => !!document.activeElement?.closest('.file-panel')

/** The tree's list, which takes the keyboard back after the field or a sheet. */
export function focusList(): void {
  document.querySelector<HTMLElement>('.file-panel .ft')?.focus({ preventScroll: true })
}

/** Run one operation's call; null when another of this window's is under way (its commands are unavailable then). */
async function once<R>(fn: () => Promise<R>): Promise<R | null> {
  if (panel.busy) return null
  panel.busy = true
  commands.changed()
  try {
    return await fn()
  } finally {
    panel.busy = false
    commands.changed()
  }
}

/** The file clipboard's entry goes when what it names (or a folder it is in) is moved or trashed. */
function clipGoes(sessionId: string, from: string): void {
  const c = panel.clip
  if (c && c.sessionId === sessionId && (c.path === from || c.path.startsWith(`${from}/`))) panel.clip = null
}

/** Carry out what follows a done operation. `began`: it began in the list. `open`: a new file, shown in the viewer. */
export function applyAnswer(sessionId: string, r: Extract<FileOpResult, { ok: true }>, o: { began: boolean; open?: boolean }): void {
  const plan = afterPlan(r, { sessionId, shown: filesModel.sessionId, showIgnored: filesModel.ui.showIgnored, began: o.began, inPanel: keyboardInPanel(), from: r.from })
  if (plan.tabs) {
    moveFileTabs(sessionId, plan.tabs.from, plan.tabs.to)
    clipGoes(sessionId, plan.tabs.from)
  }
  if (!plan.same) return
  if (plan.expanded) filesModel.replaceExpanded(plan.expanded)
  if (plan.rekey) filesModel.rekey(plan.rekey.from, plan.rekey.to)
  if (plan.showAll !== null) filesModel.showAll(plan.showAll)
  panel.hidden = plan.hidden !== null ? { sessionId, path: plan.hidden } : null
  if (plan.reveal) filesModel.reveal(plan.reveal.path, { focus: plan.reveal.focus })
  filesModel.setUndo(plan.undo)
  // a new file is shown in the viewer's preview tab, as a click shows it; the keyboard stays where it is
  if (o.open && plan.reveal) commands.run('viewer.open', { sessionId, path: r.path, mode: 'file', focus: false })
}

/** A refusal as a toast (`what`: the action, "Couldn't rename"). */
export function refused(what: string, r: FileOpRefused): void {
  showToast({ message: opMessage(what, r) })
}

const failedCall = (what: string, e: unknown): void => showToast({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` })

/** New File… / New Folder… committed: the answer, or null when not sent (another operation runs, or the call failed). */
export async function create(sessionId: string, dir: string, name: string, kind: 'file' | 'dir', began: boolean): Promise<FileOpResult | null> {
  const r = await once(() => call('files.create', { sessionId, dir, name, kind })).catch((e: unknown) => (failedCall(kind === 'file' ? "Couldn't make the file" : "Couldn't make the folder", e), null))
  if (r?.ok) applyAnswer(sessionId, r, { began, open: kind === 'file' })
  return r
}

/** Rename… committed. */
export async function rename(sessionId: string, path: string, name: string, began: boolean): Promise<FileOpResult | null> {
  const r = await once(() => call('files.rename', { sessionId, path, name })).catch((e: unknown) => (failedCall("Couldn't rename", e), null))
  if (r?.ok) applyAnswer(sessionId, r, { began })
  return r
}

/** A move or a copy in the tree (a drag, Paste). */
export async function move(sessionId: string, path: string, toDir: string, copy: boolean, began: boolean): Promise<FileOpResult | null> {
  const what = copy ? "Couldn't copy" : "Couldn't move"
  const r = await once(() => call('files.move', { sessionId, path, toDir, copy })).catch((e: unknown) => (failedCall(what, e), null))
  if (!r) return null
  if (!r.ok) refused(what, r)
  else applyAnswer(sessionId, r, { began })
  return r
}

/** Undo Move / Undo Rename. */
export async function undo(sessionId: string, began: boolean): Promise<void> {
  const what = filesModel.undoKind === 'rename' ? "Couldn't undo the rename" : "Couldn't undo the move"
  const r = await once(() => call('files.undo', { sessionId })).catch((e: unknown) => (failedCall(what, e), null))
  if (!r) return
  if (!r.ok) {
    refused(what, r)
    // a refusal that cannot change forgets what was to be undone, in core and here
    if ((r.refused === 'changed' || r.refused === 'missing') && filesModel.sessionId === sessionId) filesModel.setUndo(null)
    return
  }
  applyAnswer(sessionId, r, { began })
}

/** Move to Trash, confirmed: the next row is selected once it is gone. */
export async function trash(sessionId: string, path: string, dir: boolean, began: boolean): Promise<void> {
  const index = filesModel.sessionId === sessionId ? filesModel.rowIndex(path) : -1
  const r = await once(() => call('files.trash', { sessionId, path, dir })).catch((e: unknown) => (failedCall("Couldn't move it to the Trash", e), null))
  if (!r) return
  if (!r.ok) return refused("Couldn't move it to the Trash", r)
  clipGoes(sessionId, path)
  if (filesModel.sessionId !== sessionId) return
  filesModel.setUndo(r.undo)
  const next = index >= 0 ? nextAfter(filesModel.rows, index, path) : null
  if (next !== null) filesModel.select('files', next)
  else if (filesModel.ui.files.sel === path || filesModel.ui.files.sel?.startsWith(`${path}/`)) filesModel.select('files', parentOf(path) || null)
  if (began && keyboardInPanel()) focusList()
}

/** A drop from another app, confirmed: the copies made, the first selected. */
export async function copyIn(sessionId: string, sources: string[], toDir: string): Promise<void> {
  const what = "Couldn't copy what was dropped"
  const r = await once(() => call('files.copyIn', { sessionId, sources, toDir })).catch((e: unknown) => (failedCall(what, e), null))
  if (!r) return
  const first = r.paths?.[0]
  if (!r.ok) refused(what, r)
  if (first === undefined) return
  applyAnswer(sessionId, { ok: true, path: first, ignored: false, paged: false, undo: r.ok ? r.undo : null }, { began: false })
}
