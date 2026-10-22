// Open in editor from the window: the one function every trigger calls — the header button, the tree and the Changes
// list (double-click, `⌘↵`, the context menu), the finder's `⌘↵`, a viewer tab's `⌘↵`, a `⌘`-click on a path in a
// terminal. It asks core (`editor.open`) and shows what the window shows around it, so no caller reports anything
// itself:
//
//   pressed     the split button's pressed state, at once (the editor's own window is the confirmation)
//   no editor   no editor to open with is a predictable state: no toast; the header button's menu opens instead
//   failed      every launch strategy failed: one toast with the last attempt's stderr and "Choose editor…"
//
// One path per call. A caller that knows where to land only after asking (a changed file's first changed line) passes
// the answer as a promise, so the pressed state does not wait for it.

import { EDITORS, L, type EditorOpenRequest, type EditorOpenResult } from '@kea/protocol'
import { call } from '../../lib/rpc.ts'
import { showToast } from '../sessions/state.svelte.ts'
import { chooseEditorFor, editorState, hasButton, press, refreshEditors, wantEditorMenu } from './state.svelte.ts'

const NAMES: Record<(typeof EDITORS)[number], string> = { vscode: 'VS Code', 'vscode-insiders': 'VS Code Insiders', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed' }

/** An editor's name as menus and messages say it. */
export function editorName(id: string | null): string {
  if (id === null) return 'the editor'
  return editorState.list.editors.find((e) => e.id === id)?.name ?? (NAMES as Record<string, string>)[id] ?? id
}

/** The end of a long message (a tool's last lines say what went wrong). */
function tail(message: string): string {
  const text = message.trim()
  return text.length > L.editorErrorMaxChars ? `…${text.slice(-L.editorErrorMaxChars)}` : text
}

/** A failure with no place of its own, as a toast. `req`: what "Choose editor…" would run again. */
export function launchFailed(what: string, message: string | null, req?: EditorOpenRequest): void {
  const text = message ? `${what}: ${tail(message)}` : what
  // "Choose editor…" needs a header to show its menu under, and another editor to choose
  const offer = req !== undefined && hasButton() && editorState.list.editors.length > 0
  showToast(offer ? { message: text, action: { label: 'Choose editor…', run: () => chooseEditorFor(req) } } : { message: text })
}

/** Where in the file to land (1-based), when the caller has to ask for it first. */
export type EditorPosition = { line: number; col?: number }

/**
 * `position`: where in `req.path` to land, for a caller that must ask for it first (the Changes list's first changed
 * line). The pressed state shows at once all the same; the launch waits for the answer, and one that fails or is
 * null opens the file without a position.
 */
export async function openInEditor(req: EditorOpenRequest, position?: Promise<EditorPosition | null>): Promise<EditorOpenResult> {
  press()
  if (position) {
    const at = await position.catch(() => null)
    if (at) req = { ...req, line: at.line, ...(at.col !== undefined ? { col: at.col } : {}) }
  }
  let r: EditorOpenResult
  try {
    r = await call('editor.open', req)
  } catch (e) {
    r = { ok: false, editor: req.editor ?? null, reason: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
  if (r.ok) return r
  // what the window believed is installed was wrong, or has just changed (core looks again after a failure)
  void refreshEditors(r.reason === 'unavailable')
  if (r.reason === 'unavailable') wantEditorMenu()
  else launchFailed(`Couldn't open ${editorName(r.editor)}`, r.message, req)
  return r
}
