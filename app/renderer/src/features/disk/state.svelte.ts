// The Disk view's own state (Settings › Disk). The view is a page of the Settings sheet and is mounted only while that
// page shows; what is kept here is what must outlive one mounting: the filter, and the selection while an action's own
// sheet (the delete confirmation, the archive reasons) stands in Settings' place. Ids and small values only; core's
// `disk` store is followed by the page itself, only while it is mounted.

import type { DiskFilter } from './model.ts'

class DiskUi {
  filter = $state.raw<DiskFilter>('all')
  // bounded: ⊆ the rows the view lists (≤ L.diskViewRowsMax), emptied when the page closes for good (it outlives
  // one mounting while an action's sheet stands in Settings' place)
  selected = $state.raw<ReadonlySet<string>>(new Set<string>())
  // bounded: the sessions an action is running on (≤ the selection), each leaving when its call ends
  busy = $state.raw<ReadonlySet<string>>(new Set<string>())
  /** An action's sheet stands in Settings' place: the view comes back, with its selection. */
  away = $state(false)
}

export const diskUi = new DiskUi()

/** What the page holds while it is mounted, for the resource report: 0 everywhere while it is not. */
export const diskHolds = { rows: 0, branches: 0, deleted: 0, observers: 0, kept: 0 }

export const DISK_ROWS = ['diskRows', 'diskBranches', 'diskDeleted', 'diskSelected', 'diskObservers'] as const

/**
 * The Disk view's rows of the renderer's report: the `disk` store's rows held, branch states held, deleted sessions
 * listed, rows selected, busy or saying what a removal kept, its one observer.
 */
export function diskResources(): Record<(typeof DISK_ROWS)[number], number> {
  return { diskRows: diskHolds.rows, diskBranches: diskHolds.branches, diskDeleted: diskHolds.deleted, diskSelected: diskUi.selected.size + diskUi.busy.size + diskHolds.kept, diskObservers: diskHolds.observers }
}

export function setBusy(id: string, on: boolean): void {
  const next = new Set(diskUi.busy)
  if (on) next.add(id)
  else next.delete(id)
  diskUi.busy = next
}

export function setSelected(ids: Iterable<string>): void {
  diskUi.selected = new Set(ids)
}

export function toggleSelected(id: string, on: boolean): void {
  const next = new Set(diskUi.selected)
  if (on) next.add(id)
  else next.delete(id)
  diskUi.selected = next
}
