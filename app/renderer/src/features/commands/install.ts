// Wires the command registry to the window: the capture-phase keydown router (before any element, xterm included, sees
// the key), menu-bar choices from main, the menu state main builds the menu bar from, and the bindings in use (the
// table's with the person's `keybindings.json` applied, `bindings.svelte.ts`).

import { MAIN_COMMANDS } from '@kea/protocol'
import { installBindings } from './bindings.svelte.ts'
import { chordOf, copyHintDue, routeKey, type RouteContext } from './keys.ts'
import { commands } from './registry.ts'
import { currentKeyScopes } from './scope.ts'
import { editRole, onCommand, setMenuState } from '../../lib/bridge.ts'
import { call } from '../../lib/rpc.ts'
import { CopyHint } from '../terminal/ctrlCopy.ts'
import { prefs } from '../terminal/prefs.ts'
import { terminalUi } from '../terminal/ui.svelte.ts'
import { focusedView } from '../terminal/views.ts'

let installed = false
/** Entries in the last menu state sent to main (the resource report's `menuStateEntries`). */
let menuEntries = 0

export function menuStateEntries(): number {
  return menuEntries
}

/**
 * The commands main runs itself (Close to Menu Bar `⌘Q`, Quit Kea Completely `⌥⌘Q`): their keys are the menu bar's own
 * accelerators, which work with no window and with a window that is not answering, so the router leaves them to it.
 */
const MAINS: ReadonlySet<string> = new Set(MAIN_COMMANDS)

export function installCommands(): void {
  if (installed) return
  installed = true
  installBindings()
  // Linux's one-time hint: plain Ctrl+C over a selection interrupted rather than copied; shown on that terminal
  let hintOn: string | null = null
  const copyHint = new CopyHint(
    () => call('hints.once', { hint: 'ctrlCopy' }).then((r) => r.show),
    () => terminalUi.copyHint(hintOn),
  )

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing) return
      const view = focusedView()
      const ctx: RouteContext = {
        inTerminal: view !== undefined,
        scopes: currentKeyScopes(),
        has: (id, args) => !MAINS.has(id) && commands.available(id, args),
        ctrlCopyPaste: prefs.get().ctrlCopyPaste,
        userSelection: view?.userSelection() ?? false,
      }
      const r = routeKey(e, ctx)
      switch (r.do) {
        case 'command':
          e.preventDefault()
          e.stopPropagation()
          commands.run(r.id, r.args)
          return
        case 'pty': {
          e.preventDefault()
          e.stopPropagation()
          focusedView()?.input(r.data)
          return
        }
        case 'edit':
          // Linux: the Edit menu registers no key, so main runs the role on the focused element
          e.preventDefault()
          e.stopPropagation()
          if (r.plain && r.role === 'copy') view?.clearSelectionAfterCopy()
          editRole(r.role)
          return
        case 'prevent':
          e.preventDefault()
          e.stopPropagation()
          return
        case 'native':
        case 'swallow':
          // kept from the terminal; not prevented, so the native menu (copy, paste, hide, quit…) still acts
          e.stopPropagation()
          return
        case 'pass':
          if (copyHintDue(chordOf(e), ctx)) {
            hintOn = view?.ptyId ?? null
            void copyHint.due()
          }
          return
      }
    },
    true,
  )

  onCommand((c) => {
    commands.run(c.id, c.args)
  })

  // menu bar: one report per change, coalesced to a microtask, only when it differs from the last one
  let scheduled = false
  let last = ''
  commands.onChange(() => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const state = commands.menuState()
      const json = JSON.stringify(state)
      if (json === last) return
      last = json
      menuEntries = state.commands.length
      setMenuState(state)
    })
  })
  commands.changed()
}
