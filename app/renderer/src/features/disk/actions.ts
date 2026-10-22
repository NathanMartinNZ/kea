// What the Disk view's buttons do: Remove build folders, Archive and Delete… for one row or a selection, and Restore
// for a deleted session. Remove build folders acts at once from the view, where the row shows what it is about; run
// from the palette, the menu bar or a key it asks first (RemoveBuildFoldersSheet.svelte): the folders are deleted for
// good, not moved to the Trash. Each is the same call the rest of the window makes; a session is asked about with its
// normal sheet, one session at a time, and since the window shows one sheet at a time that sheet stands in Settings'
// place: when the last one closes, Settings › Disk is shown again. Failures with no place of their own become a toast;
// success is never toasted.

import type { BuildFoldersRemoved } from '@kea/protocol'
import { call } from '../../lib/rpc.ts'
import { watch } from '../../lib/reactive.svelte.ts'
import { failed, sessions, ui, type Sheet } from '../sessions/state.svelte.ts'
import { openSettings } from '../settings/state.svelte.ts'
import { diskUi, setBusy, setSelected } from './state.svelte.ts'

const titleOf = (id: string): string => sessions.get(id)?.title ?? 'the session'

/** Show `sheet` and wait until it is gone. True when it closed and nothing else took its place. */
function ask(sheet: Sheet): Promise<boolean> {
  return new Promise((resolve) => {
    diskUi.away = true
    ui.sheet = sheet
    const stop = watch(
      () => ui.sheet,
      () => {
        if (ui.sheet === sheet) return
        stop()
        resolve(ui.sheet === null)
      },
    )
  })
}

/** Back to the view, with its selection, once the last sheet of an action has closed. */
function comeBack(): void {
  if (ui.sheet === null) openSettings('disk')
  diskUi.away = false
}

/** Something else took the sheet's place (another command): the view does not come back, and nothing stays selected. */
function leave(): void {
  diskUi.away = false
  setSelected([])
}

/**
 * Each session's rebuildable folders go; its size is measured again by core. What core answered, by session
 * (none for one that failed: its failure is a toast): the caller says what was kept.
 */
export async function removeBuildFolders(ids: readonly string[]): Promise<Map<string, BuildFoldersRemoved>> {
  const done = new Map<string, BuildFoldersRemoved>()
  for (const id of ids) {
    setBusy(id, true)
    try {
      done.set(id, await call('disk.removeBuildFolders', { id }))
    } catch (e) {
      failed(`Couldn't remove the build folders of ${titleOf(id)}`, e)
    } finally {
      setBusy(id, false)
    }
  }
  return done
}

/** Archive each; one that has something running is asked about with the archive sheet first. */
export async function archiveSessions(ids: readonly string[]): Promise<void> {
  let asked = false
  for (const id of ids) {
    const s = sessions.get(id)
    if (!s || (s.lifecycle !== 'live' && s.lifecycle !== 'detached')) continue
    setBusy(id, true)
    try {
      const r = await call('sessions.archive', { id })
      if (!r.archived && r.reasons.length) {
        asked = true
        // the sheet's own Archive button archives it (sessions/Sheets.svelte)
        if (!(await ask({ kind: 'archive', sessionId: id, reasons: r.reasons }))) return leave()
      }
    } catch (e) {
      failed(`Couldn't archive ${titleOf(id)}`, e)
    } finally {
      setBusy(id, false)
    }
  }
  if (asked) comeBack()
}

/** The normal confirmation for each, in turn; Cancel leaves that session as it is. */
export async function deleteSessions(ids: readonly string[]): Promise<void> {
  let asked = false
  for (const id of ids) {
    if (!sessions.get(id)) continue
    asked = true
    if (!(await ask({ kind: 'delete', sessionId: id }))) return leave()
  }
  if (asked) comeBack()
}

/** Restore a deleted session; true when it is back. */
export async function restoreSession(id: string): Promise<boolean> {
  try {
    await call('sessions.restore', { id })
    return true
  } catch (e) {
    failed("Couldn't restore the session", e)
    return false
  }
}
