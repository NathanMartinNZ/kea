// The finder's list as data: how a hit is shown and how the keyboard moves through the list. Pure: FinderResults.svelte
// lays it out, under the palette's input. The matching itself is core's (`files.find`).

import type { FinderHit } from '@kea/protocol'
import { midPath } from './changes.ts'

/** A run of characters, marked when the query matched them. */
export interface Part {
  text: string
  hit: boolean
}

export interface HitRow {
  path: string
  /** The file's name, then the folder it is in ('' at the top level), each as runs for the highlight. */
  name: Part[]
  dir: Part[]
  changed: boolean
}

function parts(text: string, offset: number, matched: ReadonlySet<number>): Part[] {
  const out: Part[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = matched.has(offset + i)
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else out.push({ text: text[i] as string, hit })
  }
  return out
}

/** A hit as its row: `matched` are indexes into the path (UTF-16 units, as core counts them). */
export function hitRow(h: FinderHit): HitRow {
  const cut = h.path.lastIndexOf('/')
  const m = new Set(h.matched)
  return { path: h.path, name: parts(h.path.slice(cut + 1), cut + 1, m), dir: cut < 0 ? [] : parts(h.path.slice(0, cut), 0, m), changed: h.changed }
}

/** A hit's folder cut where `midPath` cuts a path, its marked runs kept: a run across the cut is split there. */
export function midParts(dir: readonly Part[]): { head: Part[]; tail: Part[] } {
  const cut = midPath(dir.map((p) => p.text).join('')).head.length
  const head: Part[] = []
  const tail: Part[] = []
  let at = 0
  for (const p of dir) {
    const end = at + p.text.length
    if (end <= cut) head.push(p)
    else if (at >= cut) tail.push(p)
    else {
      head.push({ text: p.text.slice(0, cut - at), hit: p.hit })
      tail.push({ text: p.text.slice(cut - at), hit: p.hit })
    }
    at = end
  }
  return { head, tail }
}

/** ↑ ↓ in the list, wrapping; PageUp and PageDown go to its ends (Home and End stay the input's). Null: not a movement key. */
export function finderMove(count: number, index: number, key: string): number | null {
  if (count === 0) return key === 'ArrowDown' || key === 'ArrowUp' || key === 'PageDown' || key === 'PageUp' ? -1 : null
  switch (key) {
    case 'ArrowDown':
      return (index + 1) % count
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'PageDown':
      return count - 1
    case 'PageUp':
      return 0
    default:
      return null
  }
}

/** What the list's last line says, if anything. */
export function finderNote(a: { hits: number; total: number; truncated: boolean; query: string; loading: boolean }): string | null {
  if (a.loading) return null
  const cut = a.truncated ? `Showing the first ${a.total.toLocaleString('en-US').replaceAll(',', ' ')} files; the rest are not searched.` : null
  if (a.hits === 0) return [a.query === '' ? 'Type to find a file.' : 'No matching files.', cut].filter(Boolean).join(' ')
  return cut
}
