// The dev server's commands (the command table's Server category): Run / Stop (`⌘R`), Restart (`⇧⌘R`), Open in Browser,
// Show Server Log. They act on the session on screen, whose `server:<sessionId>` store the window follows
// (state.svelte.ts, installed here); an unavailable one says why ("No start.sh in this worktree"). `App.svelte` calls
// this once for the window.

import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { commands } from '../commands/registry.ts'
import { activeSession, activeSessionId } from '../sessions/state.svelte.ts'
import { openInBrowser, restartServer, showServerLog, toggleServer } from './actions.ts'
import { canRunIn, NO_START_SCRIPT, portLinks, serverUp } from './model.ts'
import { installServerState, serverOf } from './state.svelte.ts'

const NO_SESSION = 'No session is selected'
const CANNOT_RUN = 'This session cannot run a dev server now'

/** The active session's server. */
const server = () => serverOf(activeSessionId())

/** Something Run would start here, now. */
function runnable(): boolean {
  return canRunIn(activeSession()) && server().source !== 'none'
}

function whyNotRunnable(): string {
  if (!activeSessionId()) return NO_SESSION
  return canRunIn(activeSession()) ? NO_START_SCRIPT : CANNOT_RUN
}

/**
 * Where nothing says what to run (no `start.sh`, no run command), the palette's dimmed row offers the other
 * way to say it: the project's run command, in its settings.
 */
function setRunCommand(): { label: string; run(): void } | undefined {
  if (!activeSessionId() || !canRunIn(activeSession()) || server().source !== 'none') return undefined
  return {
    label: 'Set a run command…',
    run: () => {
      commands.run('project.settings')
    },
  }
}

export function registerServerCommands(): Disposable {
  const state = installServerState()
  const ds: Disposable[] = [
    // ⌘R: stop the server that is there (a second ⌘R while it stops skips to SIGKILL), else run one
    commands.register('server.toggle', {
      run: () => {
        const id = activeSessionId()
        if (id) void toggleServer(id)
      },
      when: () => !!activeSessionId() && (serverUp(server().state) || runnable()),
      unavailableReason: whyNotRunnable,
      // the menu bar and the palette say which of the two it is now
      title: () => (activeSessionId() && serverUp(server().state) ? 'Stop Dev Server' : 'Run Dev Server'),
      remedy: setRunCommand,
    }),
    // Stop, then Run; on a server that is not running it is Run
    commands.register('server.restart', {
      run: () => {
        const id = activeSessionId()
        if (id) void restartServer(id)
      },
      when: () => !!activeSessionId() && runnable(),
      unavailableReason: whyNotRunnable,
      remedy: setRunCommand,
    }),
    // The primary URL, or the listening port a menu named
    commands.register('server.openBrowser', {
      run: (args) => {
        const links = portLinks(server())
        const port = typeof args === 'object' && args !== null ? (args as { port?: unknown }).port : undefined
        const link = typeof port === 'number' ? links.find((l) => l.port === port) : links[0]
        if (link) openInBrowser(link.url)
      },
      when: () => portLinks(server()).length > 0,
      unavailableReason: () => (!activeSessionId() ? NO_SESSION : server().state === 'running' ? 'The dev server is not listening on a port yet' : 'The dev server is not running'),
      // With several listening ports the palette lists them; with one it opens that one
      argument: () => {
        const links = portLinks(server())
        return links.length < 2 ? undefined : { placeholder: 'Open port in browser…', choices: () => links.map((l) => ({ label: l.label, detail: l.url, args: { port: l.port } })) }
      },
    }),
    commands.register('server.showLog', {
      run: () => {
        const id = activeSessionId()
        if (id) showServerLog(id)
      },
      when: () => server().ptyId !== null,
      unavailableReason: () => (activeSessionId() ? 'The dev server has not run in this session' : NO_SESSION),
    }),
  ]
  return {
    dispose() {
      disposeAll(ds)
      state.dispose()
    },
  }
}
