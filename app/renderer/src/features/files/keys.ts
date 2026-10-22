// The file panel's keyboard (standard tree navigation): what a key does on the row the keyboard is on, as data. The
// views (Tree.svelte, Changes.svelte) carry the action out. Pure.
//
// The tree:   ↑ ↓ Home End PageUp PageDown move; → expands a folder, then steps into it; ← collapses an open folder,
//             else goes to the folder the row is in; Enter opens a file (the keyboard goes with it) or toggles a
//             folder; Space previews a file and keeps the keyboard here; a printable key is type-ahead.
// A compact row `a/b/c` is one row: it collapses as a whole (its outermost folder) and expands at its innermost.
// The list:   the same without folders.

import type { FlatRow } from './rows.ts'

export type PanelAction =
  | { do: 'select'; index: number }
  /** Load and open a folder (the row's own path: a compact row's innermost folder). */
  | { do: 'expand'; path: string }
  /** Close a folder and everything under it (a compact row: its outermost folder). */
  | { do: 'collapse'; path: string }
  /** Show a file (or a diff, in Changes); `focus: false` leaves the keyboard in the panel (Space). */
  | { do: 'open'; index: number; focus: boolean }
  /** A long folder's "Show all (n)" row. */
  | { do: 'showAll'; dir: string }

/** The folder a `more` row belongs to (its path is `<dir>/…`). */
export function moreDir(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/** What clicking a folder row, or Enter on it, does. */
export function toggleAction(row: FlatRow): PanelAction {
  return row.expanded ? { do: 'collapse', path: row.chain[0] ?? row.path } : { do: 'expand', path: row.path }
}

const clamp = (i: number, n: number): number => Math.max(0, Math.min(n - 1, i))

/** Movement common to the tree and the list; null when `key` is not a movement key. */
function move(count: number, index: number, key: string, page: number): PanelAction | null {
  if (count === 0) return null
  // nothing selected yet: the first key lands on the first row (or the last, going up)
  const at = index < 0 ? (key === 'ArrowUp' || key === 'PageUp' ? count : -1) : index
  switch (key) {
    case 'ArrowDown':
      return { do: 'select', index: clamp(at + 1, count) }
    case 'ArrowUp':
      return { do: 'select', index: clamp(at - 1, count) }
    case 'PageDown':
      return { do: 'select', index: clamp(at + page, count) }
    case 'PageUp':
      return { do: 'select', index: clamp(at - page, count) }
    case 'Home':
      return { do: 'select', index: 0 }
    case 'End':
      return { do: 'select', index: count - 1 }
    default:
      return null
  }
}

/** A key on the tree with the keyboard on row `index` (-1: no row). Null: not the tree's key. */
export function treeKey(rows: readonly FlatRow[], index: number, key: string, page: number): PanelAction | null {
  const moved = move(rows.length, index, key, page)
  if (moved) return moved
  const row = rows[index]
  if (!row) return null
  switch (key) {
    case 'ArrowRight':
      if (row.kind !== 'dir') return null
      if (!row.expanded) return { do: 'expand', path: row.path }
      // open: into it, when it has rows
      return (rows[index + 1]?.depth ?? -1) > row.depth ? { do: 'select', index: index + 1 } : null
    case 'ArrowLeft': {
      if (row.kind === 'dir' && row.expanded) return { do: 'collapse', path: row.chain[0] ?? row.path }
      for (let i = index - 1; i >= 0; i--) if ((rows[i] as FlatRow).depth < row.depth) return { do: 'select', index: i }
      return null
    }
    case 'Enter':
      if (row.kind === 'dir') return toggleAction(row)
      if (row.kind === 'more') return { do: 'showAll', dir: moreDir(row.path) }
      return { do: 'open', index, focus: true }
    case ' ':
      if (row.kind === 'dir') return toggleAction(row)
      if (row.kind === 'more') return { do: 'showAll', dir: moreDir(row.path) }
      return { do: 'open', index, focus: false }
    default:
      return null
  }
}

/** A key on the Changes list of `count` rows. */
export function listKey(count: number, index: number, key: string, page: number): PanelAction | null {
  const moved = move(count, index, key, page)
  if (moved) return moved
  if (index < 0 || index >= count) return null
  if (key === 'Enter') return { do: 'open', index, focus: true }
  if (key === ' ') return { do: 'open', index, focus: false }
  return null
}

/** A key that types a character (type-ahead), as opposed to one that names an action. */
export function isTypeKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey
}

/**
 * Type-ahead: the row whose label starts with `prefix` (case-insensitive). A prefix of one character moves on from
 * the current row, so pressing the same letter again steps through the rows that start with it; a longer prefix stays
 * on the current row while it still matches. -1: none. `labels[i]` is what row `i` shows (a compact row matches at any
 * of its segments' starts: `a/b/c` is found by `b`).
 */
export function typeAhead(labels: readonly string[], index: number, prefix: string): number {
  const n = labels.length
  if (n === 0 || prefix === '') return -1
  const want = prefix.toLowerCase()
  const matches = (label: string): boolean => {
    const l = label.toLowerCase()
    if (l.startsWith(want)) return true
    for (let cut = l.indexOf('/'); cut >= 0; cut = l.indexOf('/', cut + 1)) if (l.startsWith(want, cut + 1)) return true
    return false
  }
  const from = prefix.length === 1 ? index + 1 : Math.max(0, index)
  for (let k = 0; k < n; k++) {
    const i = (((from + k) % n) + n) % n
    if (matches(labels[i] as string)) return i
  }
  return -1
}
