// The menu bar (macOS) or the window's menu (Linux, opened from the header's button or `Alt`), generated from the
// command table. Every command of the table has an item, by category in table order, so each is discoverable in the
// menus and through Help › Search (macOS searches the items of the menu bar from the Help menu). The renderer reports
// which commands it has handlers for, whether each is available, which of a row's titles applies now
// (`Stop Dev Server`) and the keys `keybindings.json` changed (`kea:menuState`); a command it has not reported, or
// cannot run now, is listed disabled ("Close Tab" on the Agent tab). A click goes back as `kea:command`. The shortcuts
// are shown but not registered with the system: the renderer's key router runs them, so a key has one path. Main runs
// the commands that must work with no window (⌘Q to the menu bar or quit; quit completely; reopen); copy and paste are
// native roles so the browser's clipboard events reach the focused element. `⌘M`, `⌘H`, `⌃⌘F` stay standard macOS. `⌘R`
// never reloads the window: there is no reload item, except a developer one without a shortcut in dev builds.
//
// On Linux the window draws the menu itself (a drill-down `Menu` under the header's button): `windowMenuTree` gives it
// the template's items as plain data, and a pick comes back by id (`findMenuItem`), so both menus are one template.
//
// `menuTemplate` is pure (Electron's template objects), so its shape is unit-tested without Electron.

import type { MenuItemConstructorOptions } from 'electron'
import { chordAccelerator, commandById, commandTitle, MAIN_COMMANDS, menuSections, NATIVE_ROLES, need, protocolOs, SELECT_ALL_COMMAND, systemKeys, systemTitle, toAccelerator, type Category, type MenuState, type ProtocolOs, type WindowMenuNode } from '@kea/protocol'
import { mainOs, type MenuChrome, type MenuParts } from './os/index.ts'

/** What a window's renderer last reported (`kea:menuState`), as the menu reads it. */
export interface WindowMenuState {
  /** The commands it has handlers for: available now, and the title that applies now where the row has several. */
  commands: ReadonlyMap<string, { enabled: boolean; title?: string }>
  /** The keys the person changed, by command: a canonical chord, or null where the command has none now. */
  keys: Readonly<Record<string, string | null>>
}

export function windowMenuState(s: MenuState): WindowMenuState {
  return { commands: new Map(s.commands.map((c) => [c.id, { enabled: c.enabled, ...(c.title !== undefined ? { title: c.title } : {}) }])), keys: s.keys ?? {} }
}

export interface MenuInput {
  appName: string
  /** What the window's renderer reported; null while there is no window (or no report yet). */
  renderer: WindowMenuState | null
  hasWindow: boolean
  dev: boolean
  /** A renderer command was chosen. */
  send(id: string, args?: unknown): void
  /** Main's own commands, and the developer reload. */
  main: { openKea(): void; closeToMenuBar(): void; quit(): void; reload(): void }
  /** The layout to use; this system's (`mainOs.menu`) when left out. Tests pass the other system's. */
  chrome?: MenuChrome
  /** The keys and titles to use; this system's (`protocolOs`) when left out. Tests pass the other system's. */
  system?: ProtocolOs
}

const TOP_MENUS: Partial<Record<Category, string>> = { Session: 'Session', Project: 'Project', Terminal: 'Terminal', Files: 'Files', Viewer: 'Viewer', Server: 'Server', View: 'View' }

/** The commands the generated lists leave out: main's own and the Edit menu's roles have their items already. */
const PLACED: ReadonlySet<string> = new Set([...MAIN_COMMANDS, ...Object.keys(NATIVE_ROLES), SELECT_ALL_COMMAND])

/** The key an item shows: the person's where `keybindings.json` changed it, else the table's first. */
function accelerator(id: string, input?: MenuInput): string | undefined {
  const c = commandById(id)
  // a scoped key belongs to its context (a viewer tab's `]`): the menu bar names no key that works only there
  if (!c || c.keyScope) return undefined
  const changed = input?.renderer?.keys[id]
  if (changed !== undefined) return changed === null ? undefined : (chordAccelerator(changed) ?? undefined)
  // this system's column of the table: the Shortcut column on macOS, the Linux column on Linux
  const first = systemKeys(c, (input?.system ?? protocolOs).keys)[0]
  return first ? (toAccelerator(first) ?? undefined) : undefined
}

function rendererItem(id: string, input: MenuInput, itemId = id): MenuItemConstructorOptions {
  const c = commandById(id)
  const accel = accelerator(id, input)
  const args = c?.keyArgs?.[0]
  const state = input.hasWindow ? input.renderer?.commands.get(id) : undefined
  return {
    id: itemId,
    label: state?.title ?? (c ? commandTitle(c, input.system) : id),
    enabled: state?.enabled ?? false,
    ...(accel ? { accelerator: accel, registerAccelerator: false } : {}),
    click: () => input.send(id, args),
  }
}

function mainItem(id: 'app.openKea' | 'app.closeToMenuBar' | 'app.quit', input: MenuInput): MenuItemConstructorOptions {
  const accel = accelerator(id, input)
  // ⌘Q goes to the menu bar or quits (main.ts); ⌥⌘Q quits completely, holders running on
  const click = id === 'app.openKea' ? input.main.openKea : id === 'app.closeToMenuBar' ? input.main.closeToMenuBar : input.main.quit
  const c = commandById(id)
  return { id, label: c ? systemTitle(c, input.system) : id, ...(accel ? { accelerator: accel } : {}), click: () => click() }
}

/** A command's title on this system, or `fallback` where the table has no such row. */
function titleOf(id: string, fallback: string, system?: ProtocolOs): string {
  const c = commandById(id)
  return c ? systemTitle(c, system) : fallback
}

export function menuTemplate(input: MenuInput): MenuItemConstructorOptions[] {
  const sections = menuSections((id) => !PLACED.has(id))
  const items = (cat: Category) => (sections.find((s) => s.category === cat)?.ids ?? []).map((id) => rendererItem(id, input))
  const copyKey = accelerator('terminal.copy', input)
  const pasteKey = accelerator('terminal.paste', input)
  const parts: MenuParts = {
    appName: input.appName,
    app: items('App'),
    openKea: input.hasWindow ? null : mainItem('app.openKea', input),
    closeToMenuBar: mainItem('app.closeToMenuBar', input),
    quit: mainItem('app.quit', input),
    edit: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { id: 'terminal.copy', role: 'copy', label: titleOf('terminal.copy', 'Copy', input.system) },
      { id: 'terminal.paste', role: 'paste', label: titleOf('terminal.paste', 'Paste', input.system) },
      // the role serves ⌘A in a field the page does not draw; in a terminal the router runs the command instead
      { id: SELECT_ALL_COMMAND, role: 'selectAll', label: titleOf(SELECT_ALL_COMMAND, 'Select All', input.system) },
    ],
    editKeys: { ...(copyKey ? { copy: copyKey } : {}), ...(pasteKey ? { paste: pasteKey } : {}) },
    sections: (Object.entries(TOP_MENUS) as [Category, string][]).map(([category, label]) => ({ category, label, items: items(category) })).filter((s) => s.items.length > 0),
    // dev builds only, and without a shortcut: ⌘R is server.toggle
    dev: input.dev ? [{ label: 'Developer', submenu: [{ id: 'dev.reload', label: 'Reload Window', click: () => input.main.reload() }, { role: 'toggleDevTools' }] }] : [],
    // Help: the system's own items first (macOS: its search field, which finds every item by title); then the keyboard
    // list and Copy Diagnostics, each also in the app menu (macOS) under its own id
    help: [rendererItem('app.shortcuts', input, 'help:app.shortcuts'), rendererItem('app.copyDiagnostics', input, 'help:app.copyDiagnostics')],
  }
  // the system lays the parts out (the OS layer's `menu`): macOS's menu bar, Linux's File … Help
  return (input.chrome ?? need(mainOs.menu)).layout(parts)
}

/** A role item's title where the template names none (Electron's own, as its menus write them). */
const ROLE_LABELS: Readonly<Record<string, string>> = { undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', toggleDevTools: 'Toggle Developer Tools' }

/** An item's id in the window's menu: its own, else its role's, else its place (`2/0`). */
function nodeId(i: MenuItemConstructorOptions, place: string): string {
  if (i.type === 'separator') return `sep:${place}`
  if (Array.isArray(i.submenu)) return `menu:${place}`
  if (i.id) return String(i.id)
  return i.role ? `role:${i.role}` : `item:${place}`
}

/** The application menu as plain items the window draws (Linux: a drill-down `Menu`); hidden items are left out. */
export function windowMenuTree(template: readonly MenuItemConstructorOptions[], at = ''): WindowMenuNode[] {
  return template.flatMap((i, k): WindowMenuNode[] => {
    if (i.visible === false) return []
    const place = at ? `${at}/${k}` : String(k)
    const id = nodeId(i, place)
    if (i.type === 'separator') return [{ id, label: '', enabled: false, separator: true }]
    const label = i.label ?? (i.role ? (ROLE_LABELS[i.role] ?? i.role) : '')
    if (Array.isArray(i.submenu)) return [{ id, label, enabled: i.enabled !== false, submenu: windowMenuTree(i.submenu, place) }]
    return [{ id, label, enabled: i.enabled !== false, ...(typeof i.accelerator === 'string' ? { shortcut: i.accelerator } : {}) }]
  })
}

/** The item a window-menu pick names (`windowMenuTree`'s id), in the template as it is now; null when it has none. */
export function findMenuItem(template: readonly MenuItemConstructorOptions[], id: string, at = ''): MenuItemConstructorOptions | null {
  for (const [k, i] of template.entries()) {
    if (i.visible === false) continue
    const place = at ? `${at}/${k}` : String(k)
    if (Array.isArray(i.submenu)) {
      const found = findMenuItem(i.submenu, id, place)
      if (found) return found
    } else if (i.type !== 'separator' && nodeId(i, place) === id) return i
  }
  return null
}

