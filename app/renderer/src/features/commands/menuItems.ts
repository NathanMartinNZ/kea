// A contextual menu's items from the command table: the surface's commands in table order, only those listed where
// the menu opened (available there, or kept disabled with their reason, `keepInMenus`), each with the key it has now,
// and a separator between two neighbours of different groups (the table's `menuGroup`).
// Pure: the registry and the bindings in use come in as a `MenuSource` (sessions/sheets.ts gives the window's), so a
// test can give either system's titles and keys.

import { COMMANDS, surfaceMenu, type CommandDef, type Surface } from '@kea/protocol'
import type { MenuItem } from '@kea/ui'

export interface MenuSource {
  /** Whether the command is listed for these arguments. */
  inMenus(id: string, args: unknown): boolean
  /** Why it cannot run with these arguments; undefined when it can. */
  reason(id: string, args: unknown): string | undefined
  /** Its title on this system, for these arguments (`Cut File` or `Cut Folder`). */
  title(def: CommandDef, args?: unknown): string
  /** Its key now, the person's bindings applied, as a chip shows it; undefined when it has none. */
  key(id: string): string | undefined
}

export function surfaceItems(surface: Surface, args: unknown, src: MenuSource, table: readonly CommandDef[] = COMMANDS): MenuItem[] {
  const out: MenuItem[] = []
  let group: string | undefined
  for (const id of surfaceMenu(surface, (x) => src.inMenus(x, args), table)) {
    const c = table.find((x) => x.id === id)!
    if (out.length > 0 && c.menuGroup !== group) out.push({ id: `sep:${id}`, label: '', separator: true })
    group = c.menuGroup
    // a key that works in one place only (the detached overlay's ↵) is not shown where the menu opens
    const key = c.keyScope ? undefined : src.key(id)
    const reason = src.reason(id, args)
    out.push({ id, label: src.title(c, args), ...(key ? { shortcut: key } : {}), ...(reason ? { disabled: true, reason } : {}) })
  }
  return out
}
