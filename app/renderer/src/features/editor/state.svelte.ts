// What the window knows about editors: what core found installed, the split button's pressed state, and the two menus
// another part of the window can ask the header's button to show — its own (nothing to open with) and "Choose editor"
// for a request that failed. A runes store: small plain values only.
//
// Until core's first answer the list is `NO_EDITORS`, which already means "no default editor": the button reads
// `Open in…`.

import { L, NO_EDITORS, type EditorList, type EditorOpenRequest } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { onCoreConnection } from '../../lib/bridge.ts'
import { call } from '../../lib/rpc.ts'
import { commands } from '../commands/registry.ts'
import { settings } from '../settings/store.ts'

class EditorState {
  list = $state.raw<EditorList>(NO_EDITORS)
  /** An open was just asked for. */
  pressed = $state(false)
  /** Bumped to ask the header's button for its menu. */
  menuWanted = $state(0)
  /** "Choose editor…": the request to run again with the editor picked; the header's button shows the menu. */
  choose = $state.raw<{ req: EditorOpenRequest; seq: number } | null>(null)
}

export const editorState = new EditorState()

/** Mounted header buttons: 0 or 1 (a menu asked for with none mounted has nowhere to show). */
let buttons = 0
export function buttonMounted(): () => void {
  buttons++
  return () => {
    buttons--
  }
}
export function hasButton(): boolean {
  return buttons > 0
}

let pressTimer: ReturnType<typeof setTimeout> | null = null

/** The pressed state, for L.editorPressedMs from the last open. */
export function press(): void {
  editorState.pressed = true
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    pressTimer = null
    editorState.pressed = false
  }, L.editorPressedMs)
}

/** Show the header button's menu (nothing happens when no session's header is on screen). */
export function wantEditorMenu(): void {
  editorState.menuWanted++
}

/** Offer the detected editors for `req`. */
export function chooseEditorFor(req: EditorOpenRequest): void {
  editorState.choose = { req, seq: (editorState.choose?.seq ?? 0) + 1 }
}

let asked = 0

/** Ask core what is installed (`fresh`: look again now, as when the menu opens). The newest answer wins. */
export async function refreshEditors(fresh = false): Promise<void> {
  const mine = ++asked
  try {
    const list = await call('editor.list', { fresh })
    if (mine !== asked) return
    editorState.list = list
    commands.changed()
  } catch {
    // core is away: the last answer stays, and its return asks again (below)
  }
}

/** Keep the list current: at start (at launch), when core comes back, and when the default editor or the terminal app is changed. */
export function installEditorState(): Disposable {
  // the two settings core's answer depends on: the default editor and the terminal app
  const chosen = () => `${settings.get<string>('general.defaultEditor')} ${settings.get<string>('general.terminalApp')}`
  let configured = chosen()
  const offs = [
    onCoreConnection((up) => {
      if (up) void refreshEditors()
    }),
    settings.subscribe(() => {
      const next = chosen()
      if (next === configured) return
      configured = next
      void refreshEditors()
    }),
  ]
  void refreshEditors()
  return {
    dispose() {
      for (const off of offs) off()
      if (pressTimer) clearTimeout(pressTimer)
      pressTimer = null
      editorState.pressed = false
    },
  }
}
