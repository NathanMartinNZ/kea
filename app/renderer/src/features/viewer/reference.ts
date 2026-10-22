// A reference to lines of a file for the agent: `path:start-end`, or `path:line` for one line, with the
// path relative to the session's working directory. `⌘L` puts it at the agent's prompt (not submitted) and `⌘⇧C`
// copies it. Pure (U-FV-8).

import type { EditorState } from '@codemirror/state'
import { hasControlCharacter } from '@kea/protocol'

/** 1-based, inclusive. */
export interface LineSpan {
  from: number
  to: number
}

/**
 * The lines the main selection covers. A selection that ends at the very start of a line does not include that line
 * (selecting three whole lines by dragging to the start of the fourth is three lines, as in VS Code); a cursor is its
 * own line.
 */
export function selectedLines(state: EditorState): LineSpan {
  const sel = state.selection.main
  const from = state.doc.lineAt(sel.from)
  let to = state.doc.lineAt(sel.to)
  if (!sel.empty && to.from === sel.to && to.number > from.number) to = state.doc.line(to.number - 1)
  return { from: from.number, to: to.number }
}

/** Why a file whose name holds a control character has no reference. */
export const NOT_REFERABLE = 'This file’s name has control characters, so no reference to it can be sent or copied'

/**
 * Can `path` be written in a reference? Not with a control character in it: the reference is typed at the agent's
 * prompt as it is, where a CR would be Enter and an ESC the start of a control sequence, and it has no
 * escaped form an agent reads back as the path.
 */
export function referable(path: string): boolean {
  return !hasControlCharacter(path)
}

/** Null for a path that is not `referable`. */
export function reference(path: string, lines: LineSpan): string | null {
  if (!referable(path)) return null
  return lines.from === lines.to ? `${path}:${lines.from}` : `${path}:${Math.min(lines.from, lines.to)}-${Math.max(lines.from, lines.to)}`
}
