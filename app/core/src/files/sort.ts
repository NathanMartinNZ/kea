// The tree's order: directories first, then everything else; within each, case-insensitive and numeric-aware (`file2`
// before `file10`), the same on every machine. Core sorts once per listing; the window renders the rows in the order
// they arrive.

import type { TreeEntry } from '@kea/protocol'

// one fixed locale, so two machines (and a test) agree whatever the user's language is
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Names in display order. Names that differ only in case or accents fall back to code-unit order, so it is total. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

export function compareEntries(a: Pick<TreeEntry, 'name' | 'kind'>, b: Pick<TreeEntry, 'name' | 'kind'>): number {
  const ad = a.kind === 'dir' ? 0 : 1
  const bd = b.kind === 'dir' ? 0 : 1
  return ad - bd || compareNames(a.name, b.name)
}

export function sortEntries<T extends Pick<TreeEntry, 'name' | 'kind'>>(entries: T[]): T[] {
  return entries.sort(compareEntries)
}
