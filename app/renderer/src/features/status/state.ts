// The window's copies of what status shows beyond the `sessions` store: core's `status.conditions` store (one footer
// line, one menu line and one count per account condition), and the display names of the `agents` store
// (`Claude Code · limited until 15:00`), read from the composer's copy (one subscription per window). Frame-coalesced
// like the sessions feature's copies; plain data.

import { attentionGroup, CONDITIONS_STORE, heldSessions, type AccountCondition, type SessionView } from '@kea/protocol'
import { FrameStore, nextFrame } from '../../lib/frameStore.ts'
import { subscribe } from '../../lib/rpc.ts'
import { agents, installAgents } from '../composer/agents.ts'

export { agents }

/** `status.conditions`: one row per agent with an account condition. */
export const conditions = new FrameStore<AccountCondition>({ schedule: nextFrame, structure: (c) => JSON.stringify(c) })

/** An agent's display name (`Claude Code`), else its id. */
export function agentName(id: string): string {
  return agents.get(id)?.displayName ?? id
}

/** The account condition holding a session, if any. */
export function conditionOf(sessionId: string): AccountCondition | undefined {
  for (const c of conditions.values()) if (c.sessionIds.includes(sessionId)) return c
  return undefined
}

/**
 * The needs-you count as the window title says it (`Kea — 2 need you`): an account condition counts once, for
 * the sessions it holds; a session failed on one that no condition holds any more counts itself.
 */
export function needsYouCount(sessions: readonly SessionView[]): number {
  const held = heldSessions(conditions.values())
  let n = 0
  for (const s of sessions) if (s.lifecycle !== 'archived' && s.lifecycle !== 'deleted' && attentionGroup(s, held) !== null) n++
  for (const c of conditions.values()) if (c.sessionIds.length > 0) n++
  return n
}

let installed = false

export function installStatusState(): void {
  if (installed) return
  installed = true
  subscribe<AccountCondition>(CONDITIONS_STORE, (d, c) => conditions.push(d, c))
  installAgents()
}

/** The copies' rows and listeners, for the resource report: the conditions copy, and the agents copy status follows. */
export function statusResources(): { rows: number; listeners: number } {
  return { rows: conditions.size + agents.size, listeners: conditions.subscribers + agents.subscribers }
}
