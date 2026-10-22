// The disk feature's commands: `app.showDisk` opens Settings on its Disk page; `session.removeBuildFolders` removes the
// rebuildable folders of a session's worktree (the active session's, or the one a row gives), after asking. Titles and
// placement come from the command table.

import type { SessionView } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { commands } from '../commands/registry.ts'
import { sessionOf } from '../sessions/commands.ts'
import { ui } from '../sessions/state.svelte.ts'
import { openSettings } from '../settings/state.svelte.ts'

/** The session has a worktree of its own that is there. */
const hasWorktree = (s: SessionView | undefined): boolean => !!s && s.isolation === 'worktree' && !s.worktreeMissing && (s.lifecycle === 'live' || s.lifecycle === 'detached' || s.lifecycle === 'archived')

export function registerDiskCommands(): Disposable {
  const ds: Disposable[] = [
    commands.register('app.showDisk', { run: () => openSettings('disk') }),
    commands.register('session.removeBuildFolders', {
      // from the palette, the menu bar or a key nothing shows what would go, and it cannot be undone: it asks first
      // (RemoveBuildFoldersSheet.svelte). The Disk view's own buttons act at once (actions.ts)
      run: (a) => void (ui.sheet = { kind: 'removeBuildFolders', sessionId: sessionOf(a)!.id }),
      // the sessions feature tells the registry when the sessions or the pane change (sessions/commands.ts)
      when: (a) => hasWorktree(sessionOf(a)),
      unavailableReason: (a) => (sessionOf(a) ? 'The session has no worktree of its own' : 'No session is selected'),
    }),
  ]
  return { dispose: () => disposeAll(ds) }
}
