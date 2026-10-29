// A contextual menu's items from the command table: the surface's commands in table order, only those listed where
// the menu opened (available there, or kept disabled with their reason, `keepInMenus`), each with the key it has now.
// Pure: the registry and the bindings in use come in as a `MenuSource` (sessions/sheets.ts gives the window's), so a
// test can give either system's titles and keys.

import { COMMANDS, surfaceMenu, type CommandDef, type Surface } from '@kea/protocol'
import type { MenuItem } from '@kea/ui'

export interface MenuSource {
  /** Whether the command is listed for these arguments. */
  inMenus(id: string, args: unknown): boolean
  /** Why it cannot run with these arguments; undefined when it can. */
  reason(id: string, args: unknown): string | undefined
  /** Its title on this system. */
  title(def: CommandDef): string
  /** Its key now, the person's bindings applied, as a chip shows it; undefined when it has none. */
  key(id: string): string | undefined
}

export function surfaceItems(surface: Surface, args: unknown, src: MenuSource, table: readonly CommandDef[] = COMMANDS): MenuItem[] {
  return surfaceMenu(surface, (id) => src.inMenus(id, args), table).map((id) => {
    const c = table.find((x) => x.id === id)!
    // a key that works in one place only (the detached overlay's ↵) is not shown where the menu opens
    const key = c.keyScope ? undefined : src.key(id)
    const reason = src.reason(id, args)
    return { id, label: src.title(c), ...(key ? { shortcut: key } : {}), ...(reason ? { disabled: true, reason } : {}) }
  })
}
