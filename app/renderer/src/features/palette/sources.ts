// The window's own sources for the palette (`data.ts` has the seam): its sessions as the sidebar lists them, the
// command table with what the registry says of each command now, and the projects.

import { attentionOrder, COMMANDS, heldSessions, systemTitle } from '@kea/protocol'
import { shortcut } from '../commands/bindings.svelte.ts'
import { commands } from '../commands/registry.ts'
import { listed } from '../sessions/model.ts'
import { activeSessionId, mru, projects, sessionRows } from '../sessions/state.svelte.ts'
import { conditions } from '../status/state.ts'
import type { Sources } from './data.ts'

/** The command table as the palette searches it: each command by its title on this system (File Manager, not Finder, on Linux). */
const COMMAND_SOURCES = COMMANDS.map((c) => ({ id: c.id, title: systemTitle(c), category: c.category }))

/** The window's own sources. */
export const windowSources: Sources = {
  sessions() {
    const names = new Map(projects.values().map((p) => [p.id, p.name]))
    const held = heldSessions(conditions.values())
    const rows = sessionRows().filter(listed)
    const needing = new Set(attentionOrder(rows, held).map((s) => s.id))
    return rows.map((s) => ({ id: s.id, title: s.title, branch: s.branch, project: names.get(s.projectId) ?? '', glyph: s.glyph, needsYou: needing.has(s.id) }))
  },
  needing: () => attentionOrder(sessionRows().filter(listed), heldSessions(conditions.values())).map((s) => s.id),
  // the one on screen is left out: `⌘⇧P ↵` then goes to the session before it, as `⌃Tab` does
  recent: () => mru.list().filter((id) => id !== activeSessionId()),
  commands: () => COMMAND_SOURCES,
  projects: () => [...projects.values()].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => ({ id: p.id, name: p.name })),
  now(id) {
    const reason = commands.reason(id) ?? null
    return { title: commands.title(id), shortcut: shortcut(id) ?? null, reason, remedy: reason === null ? null : (commands.remedy(id)?.label ?? null) }
  },
}
