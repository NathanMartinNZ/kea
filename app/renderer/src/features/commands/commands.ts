// The commands that belong to no feature: Keyboard Shortcuts, Open Reports Folder, the ones main runs itself (Open
// Kea, Close to Menu Bar, Quit Kea Completely, Check for Updates…: their menu items work with no window, and from the
// palette they are asked of main; the update command's title follows main's update state), and Copy and Paste, which are the Edit menu's native roles: a key or a menu click never comes through
// here, the palette's and the terminal menu's picks do (the terminal menu focuses its terminal first, so the role
// acts there). `App.svelte` calls this once for the window.
//
// The Command Palette's own command is the palette's (`features/palette/commands.ts`).

import { MAIN_COMMANDS, NATIVE_ROLES } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { editRole, openHomeItem, runMainCommand } from '../../lib/bridge.ts'
import { call } from '../../lib/rpc.ts'
import { showToast, ui } from '../sessions/state.svelte.ts'
import { updates, updateTitle } from '../settings/updates.ts'
import { activeView, viewFor } from '../terminal/views.ts'
import { commands } from './registry.ts'

/** "Open keybindings.json": core makes sure the file is there, main opens it. */
export async function openKeybindingsFile(): Promise<void> {
  try {
    await call('keybindings.ensureFile', {})
    openHomeItem('keybindings')
  } catch (e) {
    showToast({ message: `Couldn't open keybindings.json: ${e instanceof Error ? e.message : String(e)}` })
  }
}

/** Something is selected: in the terminal a menu was opened on; else in the terminal on screen, or in the page. */
function hasSelection(args: unknown): boolean {
  if (args !== undefined) return viewFor(args)?.xterm.hasSelection() === true
  return activeView()?.xterm.hasSelection() === true || (window.getSelection()?.isCollapsed === false && window.getSelection()?.toString() !== '')
}

export function registerAppCommands(): Disposable {
  const ds: Disposable[] = [
    commands.register('app.shortcuts', {
      run: () => {
        ui.sheet = { kind: 'shortcuts' }
      },
    }),
    commands.register('app.openReports', { run: () => openHomeItem('reports') }),
    ...MAIN_COMMANDS.map((id) => commands.register(id, { run: () => runMainCommand(id), ...(id === 'app.checkUpdates' ? { title: () => updateTitle(updates.state) } : {}) })),
    // the palette's title follows main's update state
    { dispose: updates.subscribe(() => commands.changed()) },
    ...Object.entries(NATIVE_ROLES).map(([id, role]) =>
      commands.register(id, {
        run: () => editRole(role),
        when: (args) => (role === 'copy' ? hasSelection(args) : args === undefined || viewFor(args) !== undefined),
        unavailableReason: () => (role === 'copy' ? 'Nothing is selected' : 'The terminal has closed'),
        // the terminal menu keeps Copy, disabled with its reason, while nothing is selected
        keepInMenus: role === 'copy',
      }),
    ),
  ]
  return { dispose: () => disposeAll(ds) }
}
