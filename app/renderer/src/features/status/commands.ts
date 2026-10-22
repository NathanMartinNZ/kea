// The status feature's commands. "Why This Status?" and "Show Launch Config" open the session popover; "Report
// Wrong Status" (⌥⌘J, the session menu, the popover's link) opens it with the report picker. "Continue All"
// (the sidebar footer) types `continue` into the sessions a usage limit held once it has reset, only on that
// click. `⌘J` lives with the sessions' commands (sessions/commands.ts).

import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { call } from '../../lib/rpc.ts'
import { commands } from '../commands/registry.ts'
import { sessionOf } from '../sessions/commands.ts'
import { activeSessionId, failed, selectSession, sessions } from '../sessions/state.svelte.ts'
import { conditions } from './state.ts'
import { openPopover } from './ui.svelte.ts'

const noSession = () => 'No session is selected'

/** The session popover of `id`, the session shown first (from a row's menu it may be another than the one on screen). */
function popover(id: string, o: { report?: boolean } = {}): void {
  if (activeSessionId() !== id) selectSession(id)
  openPopover(id, o)
}

/** The agent a Continue All acts on: its footer line's, else the only condition that has reset. */
function agentOf(args: unknown): string | null {
  const a = typeof args === 'object' && args !== null ? (args as { agent?: unknown }).agent : undefined
  if (typeof a === 'string') return conditions.get(a)?.state === 'reset' ? a : null
  const reset = conditions.values().filter((c) => c.state === 'reset')
  return reset.length === 1 ? reset[0]!.agent : null
}

export function registerStatusCommands(): Disposable {
  const ds: Disposable[] = [
    commands.register('session.whyStatus', { run: (a) => popover(sessionOf(a)!.id), when: (a) => !!sessionOf(a), unavailableReason: noSession }),
    commands.register('session.showLaunchConfig', { run: (a) => popover(sessionOf(a)!.id), when: (a) => !!sessionOf(a), unavailableReason: noSession }),
    commands.register('session.reportStatus', {
      run: (a) => popover(sessionOf(a)!.id, { report: true }),
      when: (a) => {
        const s = sessionOf(a)
        return !!s && (s.lifecycle === 'live' || s.lifecycle === 'detached')
      },
      unavailableReason: (a) => (sessionOf(a) ? 'Only a running or ended session has a status to report' : noSession()),
    }),
    commands.register('session.continueAll', {
      run: async (a) => {
        const agent = agentOf(a)
        if (!agent) return
        try {
          await call('status.continueAll', { agent })
        } catch (e) {
          failed("Couldn't continue the sessions", e)
        }
      },
      when: (a) => agentOf(a) !== null,
      unavailableReason: () => 'No usage limit has reset',
    }),
  ]
  const offs = [conditions.subscribeAny(() => commands.changed()), sessions.subscribeAny(() => commands.changed())]
  return {
    dispose: () => {
      for (const off of offs) off()
      disposeAll(ds)
    },
  }
}
