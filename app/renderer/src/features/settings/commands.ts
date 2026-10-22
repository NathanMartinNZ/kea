// The settings feature's commands: `app.settings` (`⌘,`) opens the Settings sheet on the page it showed last, or on the
// page its argument names (`{ page }`: `app.showDisk` and others open one directly); `project.settings` opens it on
// Projects with that project picked (its row's, else the window's); `app.reloadShellEnv` resolves the login-shell
// environment again (also a button in Advanced). Titles, bindings and menu placement come from the command
// table.

import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { named } from '../commands/bindings.svelte.ts'
import { commands } from '../commands/registry.ts'
import { projectOf } from '../sessions/commands.ts'
import { openSettings, reloadShellEnv } from './state.svelte.ts'

function pageOf(args: unknown): string | undefined {
  const page = typeof args === 'object' && args !== null ? (args as { page?: unknown }).page : undefined
  return typeof page === 'string' ? page : undefined
}

export function registerSettingsCommands(): Disposable {
  const ds: Disposable[] = [
    commands.register('app.settings', { run: (a) => openSettings(pageOf(a)) }),
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
