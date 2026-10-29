// The terminal feature's commands (the command table's Terminal category). Titles and bindings come from the command
// table; this file only says what each one does and when it is available. `terminal.copy` / `terminal.paste` are
// native menu roles (main), so they are not registered here. A command the terminal menu runs is given the terminal it
// was opened on (`{ ptyId }`); from a key, the menu bar or the palette, it acts on the terminal on screen.

import { tick } from 'svelte'
import { SELECT_ALL_COMMAND } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { call } from '../../lib/rpc.ts'
import { commands } from '../commands/registry.ts'
import { watch } from '../../lib/reactive.svelte.ts'
import { prefs } from './prefs.ts'
import { isScrolledUp, uiState } from './ui.svelte.ts'
import { activeView, clearAllAtlases, viewFor } from './views.ts'

export interface TerminalCommandDeps {
  /** The strip's tabs in order: the terminals, then the file and diff tabs. */
  tabs(): readonly string[]
  /** The active tab, of any kind. */
  active(): string | null
  /** The active tab when it is a terminal (default: `active`); null while a file or diff tab shows. */
  terminal?(): string | null
  /** Under a file tab: the terminal tab to go back to (the one shown last), or null when there is none. */
  lastTerminal?(): string | null
  openShell(): void
  /** ⌘T is available here (a session's shells only while it is live or detached, with its directory there). */
  canOpenShell?(): boolean
  /** Why it is not. */
  whyNoShell?(): string
  /** The Agent tab is not closable (⌘W does nothing, the menu item is disabled). */
  canClose?(tab: string): boolean
  /** The tab ⌘W acts on (default: `active`): in the split, the Agent's while the agent pane is the active one. */
  closing?(): string | null
  closeTab(tab: string): void
  /** Focus Terminal with no terminal to go back to: the agent's, where there is one. */
  focusAgent?(): void
  /** There is an agent to go to. */
  agentThere?(): boolean
  select(tab: string): void
  openFind(): void
}

export interface PaneCommandDeps {
  /** The split is drawn: the agent pane is beside the work pane. */
  split(): boolean
  /** The session has an Agent terminal. */
  agentThere(): boolean
  /** The keyboard to the agent: its pane in the split, its tab in one column. */
  focusAgent(): void
  /** The keyboard to the work pane: its terminal, its viewer or its empty state. */
  focusWork(): void
}

/** Focus Agent and Focus Work Pane (a session's pane only; the plain shells have no agent). */
export function registerPaneCommands(d: PaneCommandDeps): Disposable {
  const ds = [
    commands.register('view.focusAgent', { run: () => d.focusAgent(), when: () => d.agentThere(), unavailableReason: () => 'The agent is not running' }),
    commands.register('view.focusWork', { run: () => d.focusWork(), when: () => d.split(), unavailableReason: () => 'The agent is shown as a tab' }),
  ]
  return { dispose: () => disposeAll(ds) }
}

export function registerTerminalCommands(d: TerminalCommandDeps): Disposable {
  const hasActive = () => d.active() !== null
  const closing = () => (d.closing ? d.closing() : d.active())
  /** A terminal is the active tab (Find, Clear, Focus and Reset Rendering act on the terminal on screen). */
  const hasTerminal = () => (d.terminal ? d.terminal() : d.active()) !== null
  const step = (by: 1 | -1) => {
    const tabs = d.tabs()
    const i = tabs.indexOf(d.active() ?? '')
    const next = tabs[(i + by + tabs.length) % tabs.length]
    if (next) d.select(next)
  }
  const noTerminal = () => (hasActive() ? 'No terminal is showing' : 'No terminal is open')
  const ds = [
    commands.register('terminal.newShell', { run: () => d.openShell(), when: () => d.canOpenShell?.() ?? true, unavailableReason: () => d.whyNoShell?.() ?? 'No shell can be opened here' }),
    commands.register('terminal.closeTab', {
      run: () => d.closeTab(closing() as string),
      when: () => closing() !== null && (d.canClose?.(closing() as string) ?? true),
      unavailableReason: () => (closing() !== null ? 'This tab cannot be closed' : noTerminal()),
    }),
    commands.register('terminal.nextTab', { run: () => step(1), when: () => d.tabs().length > 1, unavailableReason: () => 'Only one tab' }),
    commands.register('terminal.previousTab', { run: () => step(-1), when: () => d.tabs().length > 1, unavailableReason: () => 'Only one tab' }),
    commands.register(SELECT_ALL_COMMAND, {
      run: (args) => viewFor(args)?.selectAll(),
      when: (args) => (args === undefined ? hasTerminal() : viewFor(args) !== undefined),
      unavailableReason: noTerminal,
    }),
    commands.register('terminal.find', { run: () => d.openFind(), when: hasTerminal, unavailableReason: noTerminal }),
    commands.register('terminal.clear', {
      run: () => {
        const v = activeView()
        if (!v) return
        v.clear()
        // the mirror and its checkpoint follow; if core's call fails, a later attach shows the old scrollback
        call('terminal.clear', { ptyId: v.ptyId }).catch((e: unknown) => console.warn('terminal.clear: the mirror was not cleared', e))
      },
      when: hasTerminal,
      unavailableReason: noTerminal,
    }),
    commands.register('terminal.jumpToBottom', {
      run: () => {
        activeView()?.scrollToBottom()
        activeView()?.focus()
      },
      when: () => isScrolledUp(activeView()?.ptyId),
      unavailableReason: () => 'Already at the bottom',
    }),
    commands.register('terminal.fontBigger', { run: () => prefs.zoomBy(1) }),
    commands.register('terminal.fontSmaller', { run: () => prefs.zoomBy(-1) }),
    commands.register('terminal.fontReset', { run: () => prefs.zoomBy(0), when: () => prefs.zoomSteps !== 0, unavailableReason: () => 'Already the default size' }),
    commands.register('terminal.resetRendering', { run: () => clearAllAtlases('reset'), when: hasTerminal, unavailableReason: noTerminal }),
    // Under a file tab, the terminal shown before it comes back, with the keyboard in it
    commands.register('terminal.focus', {
      run: () => {
        if (hasTerminal()) return void activeView()?.focus()
        const back = d.lastTerminal?.() ?? null
        if (back === null) return void d.focusAgent?.()
        d.select(back)
        void tick().then(() => activeView()?.focus())
      },
      when: () => hasTerminal() || (d.lastTerminal?.() ?? null) !== null || (d.focusAgent !== undefined && d.agentThere?.() === true),
      unavailableReason: noTerminal,
    }),
  ]
  // availability follows the zoom and the scroll position
  const offPrefs = prefs.subscribe(() => commands.changed())
  const offUi = watch(
    () => uiState.scrolledUp,
    () => commands.changed(),
  )
  return {
    dispose: () => {
      offPrefs()
      offUi()
      disposeAll(ds)
    },
  }
}
