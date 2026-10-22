// What Settings › Disk shows, worked out from the window's copies of core's `sessions`, `projects` and `disk` stores.
// Pure: the page (DiskPage.svelte) draws what this returns, and the tests read the same thing.

import { formatBytes, isStale, L, type BuildFoldersFound, type DiskBranch, type DiskUsage, type KeptFolder, type Lifecycle, type SessionView } from '@kea/protocol'

export type DiskFilter = 'all' | 'stale'

/** One session with a worktree, as a row of the view. */
export interface DiskRow {
  id: string
  title: string
  projectId: string
  lifecycle: Lifecycle
  lastActivityAt: number
  /** Null: not measured yet. */
  bytes: number | null
  rebuildableBytes: number | null
  capped: boolean
  measuring: boolean
  /** Not viewed for `L.diskStaleDays` days. */
  stale: boolean
}

export interface DiskView {
  /** The rows to draw: largest first, at most `L.diskViewRowsMax`. */
  rows: DiskRow[]
  /** Rows the filter passes but the cap leaves out. */
  more: number
  /** Over every session with a worktree, whatever the filter. */
  total: { bytes: number; rebuildableBytes: number; sessions: number; unmeasured: number; capped: number; measuring: number; stale: number }
}

/** Largest first; a worktree not measured yet after every measured one; then by title, then id (a stable order). */
function bySize(a: DiskRow, b: DiskRow): number {
  if (a.bytes !== b.bytes) return a.bytes === null ? 1 : b.bytes === null ? -1 : b.bytes - a.bytes
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
}

export function diskView(sessions: Iterable<SessionView>, disk: ReadonlyMap<string, DiskUsage>, now: number, filter: DiskFilter, max: number = L.diskViewRowsMax): DiskView {
  const all: DiskRow[] = []
  const total: DiskView['total'] = { bytes: 0, rebuildableBytes: 0, sessions: 0, unmeasured: 0, capped: 0, measuring: 0, stale: 0 }
  for (const s of sessions) {
    const d = disk.get(s.id)
    // the `disk` store has a row for each session with a worktree of its own on disk, and for no other
    if (!d) continue
    const row: DiskRow = { id: s.id, title: s.title, projectId: s.projectId, lifecycle: s.lifecycle, lastActivityAt: s.lastActivityAt, bytes: d.bytes, rebuildableBytes: d.rebuildableBytes, capped: d.capped, measuring: d.measuring, stale: isStale(now, s, d) }
    all.push(row)
    total.sessions++
    total.bytes += d.bytes ?? 0
    total.rebuildableBytes += d.rebuildableBytes ?? 0
    if (d.bytes === null) total.unmeasured++
    if (d.capped) total.capped++
    if (d.measuring) total.measuring++
    if (row.stale) total.stale++
  }
  const passed = (filter === 'stale' ? all.filter((r) => r.stale) : all).sort(bySize)
  return { rows: passed.slice(0, Math.max(0, max)), more: Math.max(0, passed.length - Math.max(0, max)), total }
}

/** A row's size: `4.2 GB`; `at least 4.2 GB` when its walk was cancelled at the cap; `Measuring…` / `Not measured` before the first walk. */
export function sizeText(r: Pick<DiskRow, 'bytes' | 'capped' | 'measuring'>): string {
  if (r.bytes === null) return r.measuring ? 'Measuring…' : 'Not measured'
  return `${r.capped ? 'at least ' : ''}${formatBytes(r.bytes)}`
}

/** A row's rebuildable share: `1.1 GB rebuildable`, `nothing rebuildable`; empty when not known. */
export function shareText(r: Pick<DiskRow, 'rebuildableBytes'>): string {
  if (r.rebuildableBytes === null) return ''
  return r.rebuildableBytes === 0 ? 'nothing rebuildable' : `${formatBytes(r.rebuildableBytes)} rebuildable`
}

/** The lifecycle as the view names it. */
export function lifecycleText(l: Lifecycle): string {
  return l === 'live' ? 'running' : l === 'detached' ? 'stopped' : l
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The branch state: `3 uncommitted files · 2 unpushed commits · not merged`. `undefined`: not asked yet;
 * `null`: there is none to read (git could not say).
 */
export function branchText(b: DiskBranch | null | undefined): string {
  if (b === undefined) return 'checking the branch…'
  if (b === null) return 'branch state not known'
  const merged = b.commits === 0 ? 'no commits of its own' : b.merged ? 'merged' : 'not merged'
  return [b.uncommittedFiles > 0 ? plural(b.uncommittedFiles, 'uncommitted file') : 'nothing uncommitted', b.unpushedCommits > 0 ? plural(b.unpushedCommits, 'unpushed commit') : 'nothing unpushed', merged].join(' · ')
}

/** The line above the list: `12.4 GB in 23 worktrees · 3.1 GB rebuildable`, and what is still missing from it. */
export function totalText(t: DiskView['total']): string {
  if (t.sessions === 0) return 'No session has a worktree of its own.'
  const parts = [`${t.capped > 0 ? 'At least ' : ''}${formatBytes(t.bytes)} in ${plural(t.sessions, 'worktree')}`]
  if (t.rebuildableBytes > 0) parts.push(`${formatBytes(t.rebuildableBytes)} rebuildable`)
  if (t.measuring > 0) parts.push(`measuring ${t.measuring}`)
  else if (t.unmeasured > 0) parts.push(`${t.unmeasured} not measured`)
  return parts.join(' · ')
}

/** Which of the three actions a row offers, by its lifecycle and what the walk found. */
export function rowActions(r: Pick<DiskRow, 'lifecycle' | 'rebuildableBytes'>): { removeBuildFolders: boolean; archive: boolean; delete: boolean } {
  return { removeBuildFolders: r.rebuildableBytes !== 0, archive: r.lifecycle === 'live' || r.lifecycle === 'detached', delete: true }
}

/** Folder names in a sentence: all of a few, the first `max` of many and how many more. */
function named(paths: readonly string[], max = 6): string {
  return paths.length <= max ? paths.join(', ') : `${paths.slice(0, max).join(', ')} and ${paths.length - max} more`
}

/**
 * What a removal left where it is, and why: `1 folder kept: it holds a git repository`. With `names`, which:
 * `… (tools/node_modules)`. Empty when nothing was kept.
 */
export function keptText(kept: readonly KeptFolder[], o: { names?: boolean } = {}): string {
  const say = (reason: KeptFolder['reason'], one: string, many: string): string | null => {
    const paths = kept.filter((k) => k.reason === reason).map((k) => k.path)
    if (paths.length === 0) return null
    return `${plural(paths.length, 'folder')} kept: ${paths.length === 1 ? one : many}${o.names ? ` (${named(paths)})` : ''}`
  }
  return [say('git', 'it holds a git repository', 'they hold git repositories'), say('unchecked', 'it could not be checked for a git repository', 'they could not be checked for a git repository')].filter((x) => x !== null).join(' · ')
}

/**
 * What a removal would take, as its confirmation says it: `3 folders (1.2 GB when last measured): node_modules, target,
 * web/node_modules`. The size is the last measurement's, so it is left out when there is none.
 */
export function foldersText(f: Pick<BuildFoldersFound, 'folders' | 'bytes'>): string {
  if (f.folders.length === 0) return 'Nothing to remove: no folder here is both ignored by git and one of the project’s rebuildable folders.'
  return `${plural(f.folders.length, 'folder')}${f.bytes ? ` (${formatBytes(f.bytes)} when last measured)` : ''}: ${named(f.folders)}`
}

/** A session deleted recently, as Recently deleted lists it. */
export interface DeletedRow {
  id: string
  title: string
  projectId: string
  branch: string | null
  isolation: 'worktree' | 'inplace'
  deletedAt: number
  snapshotFiles: number
}

/** Every project's deleted sessions as one list, newest first, at most `max`. */
export function deletedRows(lists: Iterable<{ projectId: string; sessions: readonly Omit<DeletedRow, 'projectId'>[] }>, max: number = L.diskViewRowsMax): { rows: DeletedRow[]; more: number } {
  const all: DeletedRow[] = []
  for (const l of lists) for (const s of l.sessions) all.push({ ...s, projectId: l.projectId })
  all.sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id))
  return { rows: all.slice(0, Math.max(0, max)), more: Math.max(0, all.length - Math.max(0, max)) }
}
