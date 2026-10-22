// A live reload as the smallest set of changes: the lines the old and the new text share stay as they
// are, and only the lines that differ are replaced. Unchanged lines therefore keep their place, the folds around
// them, their tokens (tokens.ts `edit`) and the scroll anchor, and the worker is asked to tokenise again only from
// the first changed line.
//
// The lines both texts start with and end with are found first (cheap, and usually all there is to find: an agent
// edits one place). What lies between is compared line by line with `@codemirror/merge`'s diff, each distinct line
// standing for one character, when it is at most L.viewerReloadDiffLines lines on each side; a larger middle is
// replaced as one change.

import { diff } from '@codemirror/merge'
import { Text } from '@codemirror/state'
import { L } from '@kea/protocol/limits'

export interface ReloadChange {
  from: number
  to: number
  insert: Text
}

export interface Reload {
  /** In document order, never overlapping; positions are the old document's. */
  changes: ReloadChange[]
  /** The first line that differs (0-based): where tokenising resumes. */
  firstLine: number
}

/** The change that replaces old lines `[from, to)` (0-based) of `doc` with `lines`; one of the two may be empty, not both. */
function replaceLines(doc: Text, from: number, to: number, lines: readonly string[]): ReloadChange {
  const n = doc.lines
  if (to > from && lines.length > 0) return { from: doc.line(from + 1).from, to: doc.line(to).to, insert: Text.of([...lines]) }
  if (to === from) {
    // lines put in: before the old line that follows them, or after the last line
    if (from < n) return { from: doc.line(from + 1).from, to: doc.line(from + 1).from, insert: Text.of([...lines, '']) }
    return { from: doc.length, to: doc.length, insert: Text.of(['', ...lines]) }
  }
  // lines taken out: with the break before the line that follows them, or the break after the line before them
  if (to < n) return { from: doc.line(from + 1).from, to: doc.line(to + 1).from, insert: Text.empty }
  return { from: from > 0 ? doc.line(from).to : 0, to: doc.length, insert: Text.empty }
}

/** Code units a line may stand for: everything but 0 and the surrogates. */
const CODES = 0xffff - 0x800

/** `a` and `b` as strings with one character per line, equal lines the same character; null with more distinct lines than characters. */
function asCharacters(a: readonly string[], b: readonly string[]): [string, string] | null {
  const code = new Map<string, number>() // bounded: a local of one reload; at most L.viewerReloadDiffLines × 2 entries
  const encode = (lines: readonly string[]): string | null => {
    const out = new Uint16Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
      let c = code.get(lines[i] as string)
      if (c === undefined) {
        if (code.size >= CODES) return null
        // 1 … 0xD7FF, then 0xE000 … 0xFFFF
        c = code.size + 1 < 0xd800 ? code.size + 1 : code.size + 1 + 0x800
        code.set(lines[i] as string, c)
      }
      out[i] = c
    }
    let s = ''
    for (let i = 0; i < out.length; i += 8192) s += String.fromCharCode(...out.subarray(i, i + 8192))
    return s
  }
  const x = encode(a)
  const y = x === null ? null : encode(b)
  return x === null || y === null ? null : [x, y]
}

/** The changes that turn `doc` into `lines`, or null when they are the same text. */
export function reloadChanges(doc: Text, lines: readonly string[]): Reload | null {
  const n = doc.lines
  const m = lines.length
  const min = Math.min(n, m)
  let p = 0
  for (const line of doc.iterLines()) {
    if (p >= min || line !== lines[p]) break
    p++
  }
  if (p === n && p === m) return null
  let s = 0
  while (s < min - p && doc.line(n - s).text === lines[m - 1 - s]) s++
  const oldCount = n - s - p
  const newCount = m - s - p
  // a middle with nothing on one side is one insertion or one removal; a large one is replaced whole
  if (oldCount > 0 && newCount > 0 && oldCount <= L.viewerReloadDiffLines && newCount <= L.viewerReloadDiffLines) {
    const oldLines: string[] = []
    for (let i = p + 1; i <= n - s; i++) oldLines.push(doc.line(i).text)
    const chars = asCharacters(oldLines, lines.slice(p, m - s))
    if (chars) {
      const changes = diff(chars[0], chars[1]).map((c) => replaceLines(doc, p + c.fromA, p + c.toA, lines.slice(p + c.fromB, p + c.toB)))
      // two changes that meet (a removal to the end after a replacement) would overlap: then one change does it
      if (changes.every((c, i) => i === 0 || c.from > (changes[i - 1] as ReloadChange).to)) return { changes, firstLine: p }
    }
  }
  return { changes: [replaceLines(doc, p, n - s, lines.slice(p, m - s))], firstLine: p }
}
