// Drags over the file tree: a row of the tree moved or copied into a folder (onto a folder row, a file row's folder, the
// Files bar or the space under the rows, the last two the session's folder), and files dropped from other apps,
// measured and then copied after the person says yes (the copy sheet). One drag at a time, so the state is the
// window's: the row being dragged (only the types can be read while a drag is over the tree), the timer that opens a
// collapsed folder held under the drag after L.treeDragOpenMs, and the animation-frame loop that scrolls the list near
// its edges until no drag movement has come for L.treeDragIdleMs. All of it ends on the drop, at `dragend` (heard on
// the document, as the row that started the drag may show another row by then) and when the panel follows another
// session.
//
// The copy modifier is the system's (`protocolOs.keys.dragCopy`: `⌥` on macOS, `Ctrl` on Linux). The drop effect is
// set at every movement, so the pointer says whether the drop moves, copies or does nothing: a folder never goes into
// itself, and a row dropped on the folder it is in stays unless it is copied there.

import { L, protocolOs } from '@kea/protocol'
import { SIZE_PX } from '@kea/ui/tokens'
import { pathForFile } from '../../lib/bridge.ts'
import { call } from '../../lib/rpc.ts'
import { showToast } from '../sessions/state.svelte.ts'
import { dropEffect } from './edit.ts'
import { filesModel } from './model.ts'
import { move, refused } from './operations.ts'
import { panel } from './state.svelte.ts'

const ROW = SIZE_PX['tree-row']

/** The row being dragged in the tree. */
export interface DraggedRow {
  sessionId: string
  path: string
  dir: boolean
}

// the drag under way: one row, one timer, one frame loop (the window's; ended with the drag)
let dragged: DraggedRow | null = null
let spring: { dir: string; timer: ReturnType<typeof setTimeout> } | null = null
let scroll: { el: HTMLElement; step: number; last: number; frame: number } | null = null

/** Drag state held now (the resource report): the row, the timer, the frame loop. */
export function dragCounts(): number {
  return (dragged ? 1 : 0) + (spring ? 1 : 0) + (scroll ? 1 : 0)
}

const onDocumentEnd = (): void => endDrag()

/** A row of the tree starts a drag. */
export function startRowDrag(row: DraggedRow): void {
  endDrag()
  dragged = row
  document.addEventListener('dragend', onDocumentEnd, true)
}

/** The drag is over (dropped, cancelled, or the panel follows another session): nothing of it is left. */
export function endDrag(): void {
  if (dragged) document.removeEventListener('dragend', onDocumentEnd, true)
  dragged = null
  if (spring) clearTimeout(spring.timer)
  spring = null
  stopScroll()
  if (panel.dropDir !== null) panel.dropDir = null
}

function springOpen(dir: string): void {
  if (spring?.dir === dir) return
  if (spring) clearTimeout(spring.timer)
  spring = null
  if (dir === '' || filesModel.isExpanded(dir)) return
  spring = {
    dir,
    timer: setTimeout(() => {
      spring = null
      filesModel.expand(dir)
    }, L.treeDragOpenMs),
  }
}

function stopScroll(): void {
  if (scroll) cancelAnimationFrame(scroll.frame)
  scroll = null
}

/** A drag over the list at `clientY`: within a row's height of an edge it scrolls that way, faster nearer the edge. */
export function edgeScroll(el: HTMLElement, clientY: number): void {
  const r = el.getBoundingClientRect()
  const step = clientY < r.top + ROW ? -(r.top + ROW - clientY) : clientY > r.bottom - ROW ? clientY - (r.bottom - ROW) : 0
  if (step === 0) return stopScroll()
  const now = performance.now()
  if (scroll) {
    scroll.el = el
    scroll.step = step
    scroll.last = now
    return
  }
  const tick = (): void => {
    const s = scroll
    if (!s) return
    if (performance.now() - s.last > L.treeDragIdleMs) return stopScroll()
    s.el.scrollTop += Math.sign(s.step) * Math.ceil(Math.min(ROW, Math.abs(s.step)))
    s.frame = requestAnimationFrame(tick)
  }
  scroll = { el, step, last: now, frame: requestAnimationFrame(tick) }
}

const isFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

/**
 * A drag over a place of the tree that stands for the folder `dir` (null: a place that takes nothing, such as the
 * row of a new entry). Taken here, so the window never adds the dragged folder as a project.
 */
export function dragOverFolder(e: DragEvent, sessionId: string, dir: string | null): void {
  const dt = e.dataTransfer
  if (!dt) return
  if (dragged) {
    e.preventDefault()
    e.stopPropagation()
    const fx = dir === null || dragged.sessionId !== sessionId || panel.busy ? 'none' : dropEffect(dragged, dir, protocolOs.keys.dragCopy(e))
    dt.dropEffect = fx
    panel.dropDir = fx === 'none' ? null : dir
    if (fx !== 'none' && dir !== null) springOpen(dir)
    return
  }
  if (!isFiles(e)) return
  e.preventDefault()
  e.stopPropagation()
  const ok = dir !== null && !panel.busy && filesModel.sessionId === sessionId && filesModel.opened
  dt.dropEffect = ok ? 'copy' : 'none'
  panel.dropDir = ok ? dir : null
}

/** The drag left a place (into another place of the tree, `relatedTarget`, it is that place's to say). */
export function leaveFolder(e: DragEvent): void {
  const to = e.relatedTarget
  if (to instanceof Node && e.currentTarget instanceof Node && e.currentTarget.contains(to)) return
  if (panel.dropDir !== null) panel.dropDir = null
  if (spring) clearTimeout(spring.timer)
  spring = null
}

/** A drop on a place of the tree that stands for the folder `dir`. */
export function dropOnFolder(e: DragEvent, sessionId: string, dir: string | null): void {
  const dt = e.dataTransfer
  if (!dt) return
  if (dragged) {
    e.preventDefault()
    e.stopPropagation()
    const d = dragged
    const copy = protocolOs.keys.dragCopy(e)
    endDrag()
    if (dir === null || d.sessionId !== sessionId || dropEffect(d, dir, copy) === 'none') return
    void move(sessionId, d.path, dir, copy, true)
    return
  }
  if (!isFiles(e)) return
  e.preventDefault()
  e.stopPropagation()
  panel.dropDir = null
  if (dir === null || panel.busy || filesModel.sessionId !== sessionId) return
  void askCopyIn(sessionId, [...dt.files].map(pathForFile), dir)
}

/**
 * A drag of files from another app over the file panel where no place of the tree takes it (Changes shown, no
 * session, the tree not open yet, an operation under way): refused there, so the window does not add the dragged
 * folder as a project from the file panel. The panel's header still does.
 */
export function refuseFiles(e: DragEvent): void {
  if (!isFiles(e) || e.defaultPrevented) return
  e.preventDefault()
  e.stopPropagation()
  if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none'
}

/** Paths that are not files on disk (a file Photos or Mail would make on the drop) are refused, said once. */
export const NO_PATH = 'Only files and folders on disk can be copied in; what came from another app with no place on disk was left out'

/**
 * Files dropped from another app into `dir`: measured first, then the sheet asks before anything is copied. `paths`:
 * each dropped item's path on disk, `''` for one with none.
 */
export async function askCopyIn(sessionId: string, paths: readonly string[], dir: string): Promise<void> {
  const sources = [...new Set(paths.filter((p) => p !== ''))]
  if (sources.length < paths.length) showToast({ message: NO_PATH })
  if (sources.length === 0) return
  if (sources.length > L.fileDropMax) return showToast({ message: `At most ${L.fileDropMax} items can be dropped at once` })
  const r = await call('files.measure', { sessionId, sources, toDir: dir }).catch((e: unknown) => {
    showToast({ message: `Couldn't copy what was dropped: ${e instanceof Error ? e.message : String(e)}` })
    return null
  })
  if (!r) return
  if (!r.ok) return refused("Couldn't copy what was dropped", r)
  if (filesModel.sessionId !== sessionId) return
  panel.copyIn = { sessionId, toDir: dir, sources, entries: r.entries, bytes: r.bytes }
}
