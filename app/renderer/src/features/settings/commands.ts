// The settings feature's commands: `app.settings` (`⌘,`) opens the Settings modal on the page it showed last, or on the
// page its argument names (`{ page }`: `app.showDisk` and others open one directly); with Settings open it closes it,
// and over another modal it does nothing (Settings would take that modal's place); `project.settings` opens it on
// Projects with that project picked (its row's, else the window's); `app.reloadShellEnv` resolves the login-shell
// environment again (also a button in Advanced). Titles, bindings and menu placement come from the command
// table.

import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { named } from '../commands/bindings.svelte.ts'
import { commands } from '../commands/registry.ts'
import { projectOf } from '../sessions/commands.ts'
import { modals } from '../../shell/modals.ts'
import { closeSettings, openSettings, reloadShellEnv } from './state.svelte.ts'

function pageOf(args: unknown): string | undefined {
  const page = typeof args === 'object' && args !== null ? (args as { page?: unknown }).page : undefined
  return typeof page === 'string' ? page : undefined
}

export function registerSettingsCommands(): Disposable {
  const ds: Disposable[] = [
    commands.register('app.settings', {
      run: (a) => {
        const page = pageOf(a)
        if (page === undefined && modals.top === 'settings') closeSettings()
        else openSettings(page)
      },
      when: () => !modals.open || modals.top === 'settings',
    }),
    commands.register('project.settings', {
      run: (a) => openSettings('projects', projectOf(a)!.id),
      // the sessions feature tells the registry when the projects or the pane change (sessions/commands.ts)
      when: (a) => !!projectOf(a),
      unavailableReason: () => named('project.add', 'Add a project first'),
    }),
    commands.register('app.reloadShellEnv', { run: () => reloadShellEnv() }),
  ]
  return { dispose: () => disposeAll(ds) }
}
