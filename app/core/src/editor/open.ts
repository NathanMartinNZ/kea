// Open in editor: what serves `editor.open` (protocol editor.ts). The launcher is `Editors` (editors.ts: detection, the
// launch strategies of argv.ts, through kit's `runProcess`); a test may pass another through `CoreOptions.editor`.
// "unavailable" is the answer when no editor is installed, so every caller handles it; `unavailableEditor` is the
// launcher that always says so.

import type { EditorOpenRequest, EditorOpenResult } from '@kea/protocol'

export interface EditorLauncher {
  /** Resolves with why not instead of rejecting for a predictable state. */
  open(req: EditorOpenRequest): Promise<EditorOpenResult>
}

export const unavailableEditor: EditorLauncher = {
  open: () => Promise.resolve({ ok: false, editor: null, reason: 'unavailable', message: null }),
}
