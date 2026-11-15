// While a modal is open (shell/modals.ts), commands come in only where it allows. The key router, the menu bar (and
// Linux's window menu, built from the same state) and the palette run none but copy, paste and select all, which act
// on the field that has the keyboard (Linux's copy and paste keys reach a modal's fields through them), and, while
// Settings is on top, the commands that close it or show one of its pages. Code inside a modal still runs any command
// (`commands.run`: Settings' Reload shell environment, a review putting a file on screen): only these ways in close.

import type { MenuState } from '@kea/protocol'
import type { ModalKind } from '../../shell/modals.ts'
import { modals } from '../../shell/modals.ts'

/** Allowed with any modal on top: the clipboard's commands. */
const ALWAYS: ReadonlySet<string> = new Set(['terminal.copy', 'terminal.paste', 'terminal.selectAll'])
/** Allowed while Settings is on top: `⌘,` closes it, the others show one of its pages. */
const SETTINGS: ReadonlySet<string> = new Set(['app.settings', 'app.showDisk', 'project.settings'])

/** Whether `id` may come in with the modals in this state (`open`: a modal or a hold is on; `top`: its kind). */
export function allowed(id: string, open: boolean, top: ModalKind | null): boolean {
  if (!open || ALWAYS.has(id)) return true
  return top === 'settings' && SETTINGS.has(id)
}

/** Whether `id` may come in now. */
export function gate(id: string): boolean {
  return allowed(id, modals.open, modals.top)
}

/** The menu state main builds the menu bar from, with what may not come in now greyed. */
export function gatedMenuState(state: MenuState, may: (id: string) => boolean = gate): MenuState {
  return { ...state, commands: state.commands.map((c) => (c.enabled && !may(c.id) ? { ...c, enabled: false } : c)) }
}
