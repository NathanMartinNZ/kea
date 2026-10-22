// The window's copy of core's `agents` store: one row per adapter plus the `shell` pseudo-agent, with each CLI's
// detection and the options the composer offers. Core detects in the background and caches; the composer reads this
// copy and never waits for a detection. Subscribed once, on first use.

import { AGENTS_STORE, type AgentInfo } from '@kea/protocol'
import { FrameStore, nextFrame } from '../../lib/frameStore.ts'
import { subscribe } from '../../lib/rpc.ts'

/** Rows by adapter id: a handful of rows. */
export const agents = new FrameStore<AgentInfo>({ schedule: nextFrame, structure: (a) => `${a.order}|${a.state}` })

let installed = false

/** Follow core's `agents` store (idempotent). */
export function installAgents(): void {
  if (installed) return
  installed = true
  subscribe<AgentInfo>(AGENTS_STORE, (d, c) => agents.push(d, c))
}

/** The agents in the composer's order (the registry's; the pseudo-agent last). */
export function agentList(rows: Iterable<AgentInfo>): AgentInfo[] {
  return [...rows].sort((a, b) => a.order - b.order)
}
