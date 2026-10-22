// The adapter registry: every agent is one folder that registers here. Core, the composer's
// options, the Settings agent cards and the status pipeline read adapters only through it, so adding an agent touches
// only its folder, its fixtures and its contract tests (U-AGT-15).

import type { AgentSettingsExtension } from '@kea/protocol'
import { claude } from './claude/adapter.ts'
import { commandcode } from './commandcode/adapter.ts'
import type { AgentAdapter } from './types.ts'

export class AdapterRegistry {
  private readonly byId: ReadonlyMap<string, AgentAdapter>
  private readonly order: readonly AgentAdapter[]

  constructor(adapters: readonly AgentAdapter[]) {
    const m = new Map<string, AgentAdapter>()
    for (const a of adapters) {
      if (m.has(a.id)) throw new Error(`two adapters named ${a.id}`)
      if (!/^[0-9A-Za-z_-]{1,64}$/.test(a.id)) throw new Error(`bad adapter id ${a.id}`) // kea-helper's <adapter> rule
      m.set(a.id, a)
    }
    this.byId = m
    this.order = [...adapters]
  }

  get(id: string): AgentAdapter | undefined {
    return this.byId.get(id)
  }

  list(): readonly AgentAdapter[] {
    return this.order
  }

  /** The adapter that started a recorded argv (a rebuilt session), or null. */
  identify(argv: readonly string[]): string | null {
    return this.order.find((a) => a.identify(argv))?.id ?? null
  }

  /**
   * The kea-helper executables a running terminal's command names, by what every adapter says of it: core keeps the
   * copies they lie in. An adapter that throws names nothing.
   */
  helperPaths(argv: readonly string[]): string[] {
    const found = new Set<string>()
    for (const a of this.order) {
      try {
        for (const p of a.helperPaths?.(argv) ?? []) found.add(p)
      } catch {
        // an adapter's reading of a command never stops the others'
      }
    }
    return [...found]
  }

  /** Every adapter's settings extension (`agents.<id>.*`). */
  settingsExtensions(): AgentSettingsExtension[] {
    return this.order.map((a) => a.settings)
  }
}

/** The adapters Kea ships, in the composer's order. */
export const ADAPTERS: readonly AgentAdapter[] = [claude, commandcode]

/**
 * Every command name a shipped adapter's CLI is installed under, by adapter id. The harnesses read this list: a run of
 * Kea must find each of these names as the run's own stand-in or not at all, before Kea starts, so a new adapter is
 * covered by registering it.
 */
export function agentCommands(adapters: readonly AgentAdapter[] = ADAPTERS): { adapter: string; names: readonly string[] }[] {
  return adapters.map((a) => ({ adapter: a.id, names: a.commands }))
}

export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry(ADAPTERS)
}
