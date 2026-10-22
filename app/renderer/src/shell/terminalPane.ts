// What the terminal pane (`TerminalPane.svelte`) keeps beyond one mount: the `shells` context of plain shell tabs, the
// tab each session showed last and what the session itself is known to remember of it, the tab order and the tab
// titles.

import type { PtyInfo } from '@kea/protocol'
import { terminalText } from '../features/terminal/text.ts'
import type { TabMemory } from './tabs.ts'

/** The plain shell tabs, shown while no session or composer is on screen (core's SHELLS_SESSION). */
export const SHELLS_CONTEXT = 'shells'

/**
 * What the `shells` pane last decided about the first shell: `opened` one, `none` (a shell survived, or a session is
 * listed), or `gone` (the pane had left before it could decide). Null until a shells pane has decided. Read by the e2e
 * probe `__keaProbe.firstShell()`; nothing in the app reads it.
 */
export const firstShell: { decision: 'opened' | 'none' | 'gone' | null } = { decision: null }

/**
 * The `shells` pane opens its first shell only when nothing came back from the last run. `restored` is core's answer
 * once it has reconciled (the running shells; the sessions that have a terminal), `anyListed` whether core's first
 * `sessions` snapshot listed a session. Both are asked: a session that ended has no terminal but is listed, and one a
 * database rebuild brought back has a terminal but can be listed after that first snapshot.
 */
export function opensFirstShell(restored: { shells: number; sessions: number }, anyListed: boolean): boolean {
  return restored.shells === 0 && restored.sessions === 0 && !anyListed
}

/** The tab a session last showed, per session (switching back restores it). */
export const lastActive = new Map<string, string>() // bounded: one entry per session shown, dropped with the session

/**
 * What each session's saved panel state is known to hold as its tab (`session_ui`'s `tabs` key, read once when the
 * window first shows the session, then kept in step with every save); null: nothing saved. A session not in here has
 * not answered yet, and nothing is saved for it before it has.
 */
export const savedTab = new Map<string, TabMemory | null>() // bounded: one entry per session shown, dropped with the session

/** Sessions the window remembers a tab of, its own or the session's saved one (the resource report). */
export function tabMemory(): number {
  let n = lastActive.size
  for (const id of savedTab.keys()) if (!lastActive.has(id)) n++
  return n
}

export function forgetTabs(exists: (sessionId: string) => boolean): void {
  for (const id of [...lastActive.keys()]) if (id !== SHELLS_CONTEXT && !exists(id)) lastActive.delete(id)
  for (const id of [...savedTab.keys()]) if (!exists(id)) savedTab.delete(id)
}

/** A tab's order in the strip: Agent first, then setup, server and shells in the order they came. */
export const KIND_ORDER: Record<PtyInfo['kind'], number> = { agent: 0, script: 1, server: 2, shell: 3 }

export function byKind(list: readonly PtyInfo[], id: string): PtyInfo['kind'] {
  return list.find((t) => t.ptyId === id)?.kind ?? 'shell'
}

/**
 * A tab's title: `Agent`, `Setup`, `Server`. A shell tab shows the title its program set (OSC 0/2), else the name of
 * the process in its foreground (core's `foreground`, asked of the holder while the session is on screen), else the
 * shell's name. Title and process name are the program's own words: shown as data.
 */
export function tabTitle(t: PtyInfo): string {
  if (t.kind === 'agent') return 'Agent'
  if (t.kind === 'script') return 'Setup'
  if (t.kind === 'server') return 'Server'
  return terminalText(t.title) || terminalText(t.foreground) || (t.argv[0]?.split('/').pop() ?? 'shell')
}

/** What the sheet asks before a shell tab is closed. */
export interface CloseQuestion {
  /** The program's name, as data; empty when it has none or is not known. */
  name: string
  text: string
}

/**
 * What closing a running shell tab asks first, or null when it closes at once. `fg` is core's answer to
 * `terminal.foreground`, null when core did not answer. Only a shell known to be idle closes without the question: a
 * program that may be running is never ended unasked.
 */
export function closeQuestion(fg: { busy: boolean; name: string; known: boolean } | null): CloseQuestion | null {
  if (!fg || !fg.known) return { name: '', text: 'Kea could not tell whether a program is still running in this tab. Closing the tab ends whatever is.' }
  if (!fg.busy) return null
  const name = terminalText(fg.name)
  return { name, text: `${name ? `${name} is` : 'A program is'} still running in this tab. Closing the tab ends it.` }
}
