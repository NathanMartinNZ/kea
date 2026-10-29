// File references in a session's terminal, wired: `links.ts` finds them in the line under the pointer and maps them
// onto cells; core says which are files inside the session's worktree (`editor.resolvePaths`); those are links —
// underlined on hover, with the target shown — and a `⌘`-click opens the editor at the position through `openInEditor`
// (never the viewer). An OSC 8 link to a `file:` target takes the same road: inside the worktree it opens in the
// editor, anywhere else it is not opened.
//
// The `shells` pseudo-session has no worktree, so its terminals have no file links. Terminal output is untrusted: a
// reference is only ever a path handed to core's check, never run, and never opened outside the worktree.

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import type { Disposable } from '@kea/terminal'
import { call } from '../../lib/rpc.ts'
import { modClick } from '../commands/keys.ts'
import { openInEditor } from '../editor/open.ts'
import { sessions, terminalsList } from '../sessions/state.svelte.ts'
import { fileLinks, fileRefText, isFileUrl, LinkChecks, linkHoverText, logicalLine, refRange } from './links.ts'
import { terminalUi } from './ui.svelte.ts'

/** What core answered lately, for every terminal of the window (one cache: the key carries the session). */
const checks = new LinkChecks(async (sessionId, paths) => (await call('editor.resolvePaths', { sessionId, paths })).paths)

/** Checked references the window remembers (the resource report's `linkChecks`). */
export function linkChecks(): number {
  return checks.size
}

/** The session whose worktree a terminal's paths are relative to; null for a terminal of no session (the shells). */
function sessionOf(ptyId: string): string | null {
  const id = terminalsList.get(ptyId)?.sessionId
  return id !== undefined && sessions.get(id) !== undefined ? id : null
}

function provider(term: Terminal, ptyId: string): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const sessionId = sessionOf(ptyId)
      if (sessionId === null) return callback(undefined)
      const line = logicalLine(term.buffer.active, y - 1)
      void fileLinks(line.text, sessionId, checks).then(
        (found) => {
          const links: ILink[] = []
          for (const f of found) {
            const range = refRange(line.cells, f)
            if (!range) continue
            const text = fileRefText(f.file, f.line, f.col)
            links.push({
              range,
              text,
              decorations: { pointerCursor: true, underline: true },
              activate: (e) => {
                if (!modClick(e)) return
                void openInEditor({ target: 'session', id: sessionId, path: f.file, ...(f.line !== null ? { line: f.line } : {}), ...(f.line !== null && f.col !== null ? { col: f.col } : {}) })
              },
              hover: (e) => terminalUi.linkHover({ ptyId, x: e.clientX, y: e.clientY, text: linkHoverText(text) }),
              leave: () => terminalUi.linkLeave(ptyId),
            })
          }
          callback(links.length > 0 ? links : undefined)
        },
        () => callback(undefined),
      )
    },
  }
}

/** Make the file references of `term`'s lines links. Returns what removes them. */
export function installFileLinks(term: Terminal, ptyId: string): Disposable {
  return term.registerLinkProvider(provider(term, ptyId))
}

/**
 * A `⌘`-click on a link whose target is a `file:` URL: opened in the editor when it is a file of the
 * terminal's session. Resolves false when it is not one (the caller then offers Copy link, as for any other scheme).
 */
export async function openFileUrl(ptyId: string, target: string): Promise<boolean> {
  const sessionId = sessionOf(ptyId)
  if (sessionId === null || !isFileUrl(target)) return false
  const [file] = await checks.check(sessionId, [target]).catch(() => [null])
  if (!file) return false
  void openInEditor({ target: 'session', id: sessionId, path: file })
  return true
}
