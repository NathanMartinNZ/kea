// Dropping on a terminal: files from other apps and rows from the file tree become text at the prompt, typed
// for the person and never submitted. Pure: `TerminalArea.svelte` takes the drop and sends the text.
//
//   files from other apps  their absolute paths, shell-escaped, each followed by a space
//   a row of the file tree its path relative to the session's working directory, shell-escaped; dropped with `⌥` held
//                          on the agent's terminal, a file mention instead: `@path`, or the form the session's agent
//                          reads when the name has a space or would otherwise be cut short (`@"my file.ts"`). The form
//                          is the agent's, so core's adapter says it (`agents.mention`; nothing agent-specific lives
//                          here). On any other terminal (a shell, the dev server) `⌥` changes nothing: a mention
//                          means nothing to a shell, and unescaped it would be read as a command line
//
// A name is data from disk, and a repository or an agent chooses it. Nothing here returns a text with a raw control
// character: the shell's form writes one in ANSI-C quotes, and a mention, which has no such form, is refused
// with a reason for the person.

import { hasControlCharacter, isTypedText, protocolOs } from '@kea/protocol'
import { pathsForShell, shellEscape } from './shellEscape.ts'

/** The drag type a file-tree row carries: JSON `{ sessionId, path }`, the path relative to the working directory. */
export const PATH_DRAG_TYPE = 'application/x-kea-path'

export interface DraggedPath {
  sessionId: string
  path: string
}

export function parseDraggedPath(raw: string): DraggedPath | null {
  try {
    const o = JSON.parse(raw) as Partial<DraggedPath> | null
    return o && typeof o.sessionId === 'string' && typeof o.path === 'string' && o.path !== '' ? { sessionId: o.sessionId, path: o.path } : null
  } catch {
    return null
  }
}

/** Can this drag be dropped on a terminal? (Asked during the drag, when only the types can be read.) */
export function takesDrop(types: ArrayLike<string> & { includes(t: string): boolean }): boolean {
  return types.includes(PATH_DRAG_TYPE) || types.includes('Files')
}

/** What a drop types at the prompt. */
export interface Dropped {
  /** '' for a drop with nothing to type. */
  text: string
  /** Why nothing is typed for a drop that named a file (shown to the person); null otherwise. */
  refused: string | null
}

/** Why a file gets no mention: its name has no form the agent reads back as that file. */
export const MENTION_REFUSED = `This file’s name cannot be written as a mention the agent reads back (a control character, or a quote in a name that needs quotes). Drop it without ${protocolOs.keys.altName} for its path.`

/**
 * What a drop does. `files`: the dropped files' absolute paths. `agent`: the terminal dropped on is the session's
 * agent terminal, the only one a mention is for. A mention's text is the agent's to say: `mention` is the path core is
 * asked about (`agents.mention`), and `mentionText` makes the answer what is typed.
 */
export function dropText(d: { row: DraggedPath | null; files: readonly string[]; alt: boolean; agent: boolean }): Dropped | { mention: string } {
  if (d.row && d.alt && d.agent) return hasControlCharacter(d.row.path) ? { text: '', refused: MENTION_REFUSED } : { mention: d.row.path }
  return { text: pathsForShell(d.row ? [d.row.path] : d.files.filter((p) => p !== '')), refused: null }
}

/**
 * Core's answer for a mention (`agents.mention`: the text, or null when the agent has no form for this name) as what
 * the drop types: the mention and a space, ready for the next word. An answer that may not be typed is
 * refused like no answer.
 */
export function mentionText(answer: string | null): Dropped {
  return answer !== null && answer !== '' && isTypedText(answer) ? { text: `${answer} `, refused: null } : { text: '', refused: MENTION_REFUSED }
}

/**
 * What a dragged row of the file tree carries: the path for Kea's own terminals, and plain text for other apps. The
 * plain text is the path, except for a name with a control character, which another app's terminal would type as
 * keys: that one goes as the shell's quoted form.
 */
export function dragPayload(sessionId: string, path: string): Record<typeof PATH_DRAG_TYPE | 'text/plain', string> {
  return { [PATH_DRAG_TYPE]: JSON.stringify({ sessionId, path }), 'text/plain': hasControlCharacter(path) ? shellEscape(path) : path } as Record<typeof PATH_DRAG_TYPE | 'text/plain', string>
}
