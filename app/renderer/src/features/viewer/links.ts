// Web addresses in the viewer's text, found as VS Code's editor finds them: one line at a time, from an `http://`,
// `https://` or `mailto:` to the next whitespace, `<`, `>`, `"`, `'` or backquote, less a trailing `. , ; : ! ?` and a
// closing bracket the address does not open. Only a slice of the line around the pointer or the cursor is read. Pure:
// what is under the pointer and how it is drawn is `linkView.ts`'s.

import { L, type System } from '@kea/protocol'
import { linkAction, linkHoverText, type LinkAction } from '../../lib/linkPolicy.ts'

/** Part of one line: its text, and whether it starts or ends inside the line (the scan cut it there). */
export interface LineSlice {
  text: string
  cutStart: boolean
  cutEnd: boolean
}

/** A web address in a slice: where it is (UTF-16 offsets in the slice, `to` exclusive), its text as written, and what a click does with it. */
export interface FoundUrl {
  from: number
  to: number
  text: string
  action: LinkAction
}

/** What ends an address. */
const STOP = /[\s<>"'`]/
const SCHEME = /https?:\/\/|mailto:/i
/** Left off an address's end. */
const TRAILING = '.,;:!?'
/** A closing bracket and its opener: left off the end while the address has more closers than openers. */
const OPENER: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

const stops = (c: string | undefined): boolean => c === undefined || STOP.test(c)

/** How much of `s` is left once its trailing punctuation and unmatched closing brackets are taken off. */
function trimmedLength(s: string): number {
  const count: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 }
  for (const c of s) if (c in count) count[c] = (count[c] as number) + 1
  let end = s.length
  while (end > 0) {
    const c = s[end - 1] as string
    const open = OPENER[c]
    if (TRAILING.includes(c)) end--
    else if (open !== undefined && (count[c] as number) > (count[open] as number)) {
      count[c] = (count[c] as number) - 1
      end--
    } else break
  }
  return end
}

/**
 * The web address at `offset` in `slice`, or null. The address starts at the first scheme in its run of text (the
 * characters between two stops), so a scheme later in the run is part of it, as VS Code reads `?u=https://…`. A run
 * the slice cut is no link (what was cut is not known), nor is an address longer than `L.viewerLinkMaxChars`. An
 * address the link policy will not open is still found: its `action` says why.
 */
export function urlAt(slice: LineSlice, offset: number): FoundUrl | null {
  const text = slice.text
  if (offset < 0 || offset >= text.length || stops(text[offset])) return null
  let start = offset
  while (start > 0 && !stops(text[start - 1])) start--
  let end = offset + 1
  while (end < text.length && !stops(text[end])) end++
  if ((start === 0 && slice.cutStart) || (end === text.length && slice.cutEnd)) return null
  const run = text.slice(start, end)
  const m = SCHEME.exec(run)
  if (!m) return null
  const from = start + m.index
  const to = from + trimmedLength(run.slice(m.index))
  if (to - from <= m[0].length || to - from > L.viewerLinkMaxChars || offset < from || offset >= to) return null
  const found = text.slice(from, to)
  return { from, to, text: found, action: linkAction(found) }
}

/**
 * The part of a line `[lineFrom, lineTo)` read around the character at `pos`: half of `L.viewerLinkScanChars` on each
 * side of it. That is at least `L.viewerLinkMaxChars`, so the character just past the longest address is read on
 * either side, and an address under the pointer is known to end where it does.
 */
export function scanWindow(lineFrom: number, lineTo: number, pos: number): { from: number; to: number } {
  const half = Math.floor(L.viewerLinkScanChars / 2)
  return { from: Math.max(lineFrom, pos - half), to: Math.min(lineTo, pos + 1 + half) }
}

/** The link tip's two lines: the whole address with its hidden characters written out, and what a click does. */
export interface LinkTipWords {
  target: string
  action: string
}

/** How a link opens, with this system's modifier: "⌘-click to open", "Ctrl-click to open". */
export function clickWords(system: System): string {
  return `${system === 'darwin' ? '⌘' : 'Ctrl'}-click to open`
}

/** What the tip says of an address: how to open it, with this system's modifier, or why it is only copied. */
export function linkTipWords(found: Pick<FoundUrl, 'text' | 'action'>, system: System): LinkTipWords {
  const a = found.action
  const action = a.open ? clickWords(system) : a.reason === 'long' ? 'Too long to open: copy it instead' : 'This address cannot be opened: copy it instead'
  return { target: linkHoverText(found.text), action }
}

/** Follow Link's reason when nothing at the cursor is a link. */
export const NO_LINK = 'No link at the cursor'
