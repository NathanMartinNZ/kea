// The file panel's rows in the renderer's resource report: what the window holds of the session on screen's files, read
// when the report is taken. The leak suite reads the same rows: after a session is left, nothing of it is counted here
// (L-MEM-2).
//
//   fileStores       session stores followed for the panel: `tree:` and `git:` of the session on screen (0 or 2)
//   fileTreeDirs     loaded directories in the window's copy of the tree store
//   fileTreeRows     the tree's flat rows as last built (≤ L.dirCacheEntriesMax for one session)
//   fileGitEntries   changed paths in the window's copy of the git store (≤ L.gitStatusEntriesMax)
//   fileExpanded     folders open in the session on screen
//   fileRowsDrawn    row elements in the document, tree and Changes list together (the rows on screen and the
//                    overscan, whatever the lists hold)
//   filePanelTimers  the panel-state save waiting (0 or 1)
//   fileLayers       the panel's floating layers open: a menu, the Discard, Move to Trash and copy sheets, the name
//                    field (each 0 or 1; the finder is the palette's file mode: `paletteOpen`)
//   fileOps          what the file operations hold: the file clipboard's entry, and a drag under way (its row, the
//                    timer that opens a folder under it, the frame loop that scrolls the list)

import { primaryDown } from '../commands/keys.ts'
import { dragCounts } from './drag.ts'
import { filesModel } from './model.ts'
import { panel } from './state.svelte.ts'

export const FILES_ROWS = ['fileStores', 'fileTreeDirs', 'fileTreeRows', 'fileGitEntries', 'fileExpanded', 'fileRowsDrawn', 'filePanelTimers', 'fileLayers', 'fileOps'] as const

export function filesResources(): Record<(typeof FILES_ROWS)[number], number> {
  const c = filesModel.counts
  return {
    fileStores: c.stores,
    fileTreeDirs: c.treeDirs,
    fileTreeRows: c.rows,
    fileGitEntries: c.gitEntries,
    fileExpanded: c.expanded,
    fileRowsDrawn: document.querySelectorAll('.fp-list .fp-row').length,
    filePanelTimers: c.timers,
    fileLayers: (panel.menu ? 1 : 0) + (panel.discard ? 1 : 0) + (panel.trash ? 1 : 0) + (panel.copyIn ? 1 : 0) + (panel.edit ? 1 : 0),
    fileOps: (panel.clip ? 1 : 0) + dragCounts(),
  }
}

// ── perf timings (P-FT-1, and the window's half of a save → its decoration): installed with the test probes ──────

export interface RowMark {
  /** From the start (`from`) to the frame that draws the row, its paint excluded (as every one-frame budget). */
  drawn: number
  /** … to the start of the frame after it, by when its paint is done. */
  painted: number
  /** From the last `tree:` / `git:` snapshot or delta the panel got to the frame that draws the row: the window's half. */
  sinceDelta: number
  /** `Date.now()` at the frame that draws the row: a test that started the change in another process subtracts its own. */
  drawnAtEpoch: number
}

/**
 * Time the frame that draws a row matching `selector` (in the document: the tree's and the Changes list's rows carry
 * `data-path`, `data-git`, and their panel `data-session`). `from`: the next keydown with ⌘ held (a session switch by
 * `⌘1`…), or the call itself. A change made in a frame's animation callbacks — the panel's one update a frame — is
 * drawn by that frame; one made between frames, by the next. Arm it before the action.
 */
export function timeRow(o: { selector: string; from: 'key' | 'now'; timeoutMs?: number }): Promise<RowMark> {
  return new Promise((resolve, reject) => {
    let t0: number | null = o.from === 'now' ? performance.now() : null
    let seen = false
    // true from a frame's animation callbacks until its rendering is done: a task queued then runs after the paint
    let inFrame = false
    let ticking = true
    const tick = (): void => {
      if (!ticking) return
      inFrame = true
      setTimeout(() => {
        inFrame = false
      }, 0)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const onKey = (e: KeyboardEvent): void => {
      // the primary modifier's own keydown is no key yet (⌘; Linux's Ctrl+Shift is two of them)
      if (t0 === null && primaryDown(e) && !['Meta', 'Control', 'Shift'].includes(e.key)) t0 = e.timeStamp
    }
    const look = (): void => {
      if (seen || t0 === null || !document.querySelector(o.selector)) return
      seen = true
      const start = t0
      const now = performance.now()
      const mark = (drawnAt: number): void => {
        const epoch = Date.now() - (performance.now() - drawnAt)
        // the frame after the drawing one starts once that paint is done
        requestAnimationFrame((t) => finish(null, { drawn: drawnAt - start, painted: t - start, sinceDelta: drawnAt - filesModel.deltaAt, drawnAtEpoch: epoch }))
      }
      if (inFrame) mark(now)
      else requestAnimationFrame((t) => mark(t))
    }
    const watch = new MutationObserver(look)
    const timer = setTimeout(() => finish(new Error(`no row ${o.selector}`)), o.timeoutMs ?? 20_000)
    const finish = (err: Error | null, r?: RowMark): void => {
      ticking = false
      clearTimeout(timer)
      watch.disconnect()
      window.removeEventListener('keydown', onKey, true)
      if (err) reject(err)
      else resolve(r as RowMark)
    }
    window.addEventListener('keydown', onKey, true)
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-git', 'data-path', 'data-session'] })
    look()
  })
}
