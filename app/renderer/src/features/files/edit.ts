// The file tree's operations as the window decides them, pure: which folder an action acts in, what a drop does, what
// the name field selects first and when it commits or cancels, what a refusal says, and what follows an answer. Core
// does the work and checks everything again (app/core/src/files/ops.ts); `operations.ts` carries these decisions out.
//
// The name field (New File…, New Folder…, Rename…) writes to disk, so it never commits by accident: `↵` commits; a
// press outside it, or the keyboard moving to another element of the window, commits a valid name and cancels any
// other; `Esc`, another session and the panel leaving Files cancel; the window losing the keyboard does nothing, nor
// does a menu or a sheet that opens over it. A name core refused as `name` or `exists` is not sent again unchanged.

import { checkName, type FileOpRefusal, type FileOpRefused, type UndoKind } from '@kea/protocol'
import { moreDir } from './keys.ts'
import type { FlatRow } from './rows.ts'

/** The folder a path is in (`''`: the root). */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/**
 * The folder a row stands for when something is made or pasted there: a folder row is that folder (a compact row
 * `a/b/c` its deepest one); a file, a link or "Show all" is the folder it is in; no row is the root.
 */
export function folderOf(row: FlatRow | undefined): string {
  if (!row) return ''
  if (row.kind === 'dir') return row.path
  if (row.kind === 'more') return moreDir(row.path)
  if (row.kind === 'pending') return row.path.slice(0, -1)
  return parentOf(row.path)
}

/** `p` once the entry at `from` moved to `to`: the same when it was not at or under `from`. */
export function movedPath(p: string, from: string, to: string): string {
  return p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p
}

/**
 * What dropping the entry at `path` (`dir`: a folder) into the folder `into` does: a move, a copy (`copy`: the
 * modifier is held), or nothing — a folder into itself or below itself, or a move into the folder it is in.
 */
export function dropEffect(d: { path: string; dir: boolean }, into: string, copy: boolean): 'move' | 'copy' | 'none' {
  if (d.dir && (into === d.path || into.startsWith(`${d.path}/`))) return 'none'
  if (!copy && into === parentOf(d.path)) return 'none'
  return copy ? 'copy' : 'move'
}

/** The part of a name the field selects first: a file's name up to its last `.` (a leading one is no extension); all of a folder's. */
export function stem(name: string, dir: boolean): [number, number] {
  const dot = dir ? -1 : name.lastIndexOf('.')
  return [0, dot > 0 ? dot : name.length]
}

/** The name the field starts with: empty for a new entry; a renamed row's last segment (a compact row's too). */
export function startName(path: string | null): string {
  return path === null ? '' : path.slice(path.lastIndexOf('/') + 1)
}

/** What happens to the name field. */
export type FieldEvent =
  /** `↵` (`composing`: an input method is still composing, so the key is its own). */
  | { kind: 'enter'; composing: boolean }
  | { kind: 'escape' }
  /** A press of the pointer, or the keyboard moving to another element: outside the field, or into a menu or sheet. */
  | { kind: 'press' | 'focus'; inside: boolean; layer: boolean }
  /** The window lost the keyboard (another app). */
  | { kind: 'blur' }
  /** Another session came on screen, the panel left Files, or the field's row went. */
  | { kind: 'away' }

export type FieldAction = 'commit' | 'cancel' | 'none'

/**
 * What the field does on `e` with `name` typed. `nested`: a new entry's name (`/` makes folders on the way).
 * `refused`: the last name core refused as `name` or `exists`, which a press outside does not send again.
 */
export function fieldAction(e: FieldEvent, name: string, o: { nested: boolean; dir: string; refused?: string | null }): FieldAction {
  switch (e.kind) {
    case 'enter':
      return e.composing ? 'none' : 'commit'
    case 'escape':
    case 'away':
      return 'cancel'
    case 'blur':
      return 'none'
    case 'press':
    case 'focus':
      if (e.inside || e.layer) return 'none'
      return checkName(name, o).ok && name !== o.refused ? 'commit' : 'cancel'
  }
}

/** The refusals as the person reads them (the toast's sentence, or the line under the field). */
export const OP_REFUSED: Readonly<Record<FileOpRefusal, string>> = {
  exists: 'That name is taken in this folder',
  name: 'That is not a name Kea gives',
  outside: 'The path leads outside the session’s folder',
  gitDir: 'Kea does not change git’s own folder',
  root: 'Not the session’s folder itself',
  intoItself: 'A folder cannot go into itself',
  submodule: 'A submodule is changed inside it, not from here',
  missing: 'It is not there any more',
  changed: 'It changed since you were asked; nothing was done',
  busy: 'Another change to these files is under way; try again',
  noTrash: 'This Mac has no `trash` tool (macOS 15 or later); nothing was moved',
  crossDevice: 'Kea moves files within one volume only',
  unsupported: 'Kea copies files, folders and links only',
  tooLarge: 'That is too much to copy at once',
  failed: 'It could not be done',
}

/** A refusal's toast: what was tried, then why. A missing trash tool that core names itself is that sentence alone. */
export function opMessage(what: string, r: Pick<FileOpRefused, 'refused' | 'detail'>): string {
  if (r.refused === 'noTrash' && r.detail) return `${what}: ${r.detail}`
  return `${what}: ${OP_REFUSED[r.refused]}${r.detail ? ` (${r.detail})` : ''}`
}

/** A refusal the name field shows under itself, keeping it open for another try; any other closes it with a toast. */
export function refusedInline(r: Pick<FileOpRefused, 'refused' | 'detail'>): string | null {
  if (r.refused === 'name') return r.detail ?? OP_REFUSED.name
  if (r.refused === 'exists') return r.detail ? `${OP_REFUSED.exists} (${r.detail})` : OP_REFUSED.exists
  return null
}

/** An operation's answer, as `afterPlan` reads it. */
export interface Answer {
  path: string
  ignored: boolean
  paged: boolean
  expanded?: readonly string[] | undefined
  undo: UndoKind | null
}

export interface AfterContext {
  /** The session the request was for. */
  sessionId: string
  /** The session the panel follows now. */
  shown: string | null
  /** The panel shows ignored entries. */
  showIgnored: boolean
  /** The operation began in the list: a list key, `↵` in the field, the row's or the Files bar's menu. */
  began: boolean
  /** The keyboard is in the file panel now. */
  inPanel: boolean
  /** Where the entry was, for a move, a rename or an undo. */
  from?: string | undefined
}

/** What follows an answer, step by step (`operations.ts` carries it out). */
export interface AfterPlan {
  /** The panel still follows the request's session: every step below; otherwise only `tabs`. */
  same: boolean
  /** File tabs at or under `from` now show the path under `to` (keyed by session, so also for another one). */
  tabs: { from: string; to: string } | null
  /** The open folders, replaced (a folder moved or was renamed). */
  expanded: readonly string[] | null
  /** What the window keeps under the old path follows the folder. */
  rekey: { from: string; to: string } | null
  /** The result's folder shows all its entries first (the result is past its first page). */
  showAll: string | null
  /** The result is selected (and its folders opened); the keyboard goes with it when `focus`. */
  reveal: { path: string; focus: boolean } | null
  /** The result is ignored while ignored entries are hidden: the note line says it is there. */
  hidden: string | null
  undo: UndoKind | null
}

export function afterPlan(r: Answer, c: AfterContext): AfterPlan {
  const moved = c.from !== undefined && c.from !== r.path ? { from: c.from, to: r.path } : null
  if (c.shown !== c.sessionId) return { same: false, tabs: moved, expanded: null, rekey: null, showAll: null, reveal: null, hidden: null, undo: null }
  const hidden = r.ignored && !c.showIgnored
  return {
    same: true,
    tabs: moved,
    expanded: r.expanded ?? null,
    rekey: r.expanded && moved ? moved : null,
    showAll: !hidden && r.paged ? parentOf(r.path) : null,
    reveal: hidden ? null : { path: r.path, focus: c.began && c.inPanel },
    hidden: hidden ? r.path : null,
    undo: r.undo,
  }
}

/**
 * The row to select once `path` is moved to the Trash: the next row that is not inside it, else the one before it.
 * Null: none is left.
 */
export function nextAfter(rows: readonly FlatRow[], index: number, path: string): string | null {
  for (let i = index + 1; i < rows.length; i++) {
    const r = rows[i] as FlatRow
    if (r.kind !== 'more' && r.kind !== 'pending' && !r.path.startsWith(`${path}/`)) return r.path
  }
  for (let i = index - 1; i >= 0; i--) {
    const r = rows[i] as FlatRow
    if (r.kind !== 'more' && r.kind !== 'pending') return r.path
  }
  return null
}
