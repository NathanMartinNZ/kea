// The tree's rows: `tree:<sessionId>` holds one row per loaded directory; this turns it into the flat list the
// virtualised view renders, top to bottom. Pure: the same store and expansion always give the same rows.
//
// Compact folders (default on): a chain of expanded directories that each hold nothing but one directory is one row,
// `a/b/c`. The chain ends where a directory has a second visible entry, holds a file, is collapsed or is not loaded
// yet; when a second entry appears in one of them, the row splits there again by itself.
//
// Ignored entries are hidden unless the panel shows them (`files.toggleIgnored`); `.git` never arrives from core.

import { treeDir, type TreeEntry, type TreeKind, type TreeRow } from '@kea/protocol'

export interface FlatRow {
  /** The entry's path (for a compact row: the deepest directory of the chain); the row's key. */
  path: string
  /** What the row shows: the name, or `a/b/c` for a compact chain. */
  label: string
  /** For a compact row: every directory of the chain, outermost first (each can be collapsed on its own). */
  chain: string[]
  kind: TreeKind | 'more'
  depth: number
  ignored: boolean
  /** A directory whose entries are shown below it. */
  expanded: boolean
  /** Expanded, but core has not sent its entries yet (or dropped them): ask with `files.expand`. */
  loading: boolean
  /** A `more` row ("Show all (n)"): how many entries the directory has in all. */
  total?: number
}

export interface FlattenOptions {
  /** Compact folders. */
  compact: boolean
  /** Show ignored entries (dimmed by the view); false hides them. */
  showIgnored: boolean
}

export function childPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

function visible(entries: readonly TreeEntry[], o: FlattenOptions): readonly TreeEntry[] {
  return o.showIgnored ? entries : entries.filter((e) => !e.ignored)
}

/**
 * The directory `dir` continues into as one compact row: its only visible entry, when that is a directory and all of
 * `dir`'s entries are here. Null otherwise. The view expands it when the user expands `dir`, so the chain forms.
 */
export function compactChild(data: ReadonlyMap<string, TreeRow>, dir: string, o: FlattenOptions): string | null {
  const row = treeDir(data, dir)
  if (!row || row.paged || row.truncated) return null
  const shown = visible(row.entries, o)
  const only = shown.length === 1 ? shown[0] : undefined
  return only && only.kind === 'dir' ? childPath(dir, only.name) : null
}

/** The rows of the tree, in display order (core sorted each directory's entries). */
export function flattenTree(data: ReadonlyMap<string, TreeRow>, expanded: ReadonlySet<string>, o: FlattenOptions): FlatRow[] {
  const out: FlatRow[] = []
  const walk = (dir: string, depth: number): void => {
    const row = treeDir(data, dir)
    if (!row) return
    for (const e of visible(row.entries, o)) {
      let path = childPath(dir, e.name)
      if (e.kind !== 'dir') {
        out.push({ path, label: e.name, chain: [], kind: e.kind, depth, ignored: e.ignored, expanded: false, loading: false })
        continue
      }
      let label = e.name
      const chain = [path]
      if (o.compact) {
        for (let next = expanded.has(path) ? compactChild(data, path, o) : null; next !== null; next = expanded.has(path) ? compactChild(data, path, o) : null) {
          label += `/${next.slice(path.length + 1)}`
          path = next
          chain.push(path)
        }
      }
      const open = expanded.has(path)
      const loaded = treeDir(data, path) !== null
      out.push({ path, label, chain: chain.length > 1 ? chain : [], kind: 'dir', depth, ignored: e.ignored, expanded: open, loading: open && !loaded })
      if (open && loaded) walk(path, depth + 1)
    }
    if (row.paged) out.push({ path: childPath(dir, '…'), label: '', chain: [], kind: 'more', depth, ignored: false, expanded: false, loading: false, total: row.total })
  }
  walk('', 0)
  return out
}
