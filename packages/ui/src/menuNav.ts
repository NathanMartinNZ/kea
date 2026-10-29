// Keyboard model of a menu: which item a key moves to. Pure, so the renderer's menus behave the same whether
// they are context menus, the header overflow or a dropdown.
//
//   ↓ / ↑         next / previous enabled item, wrapping (separators are never reached)
//   Home / End    first / last enabled item
//   a printable   type-ahead: the next enabled item whose label starts with the typed text (case-insensitive)
//   → / ↵         on a submenu: its items, in place of these, after a back row (a drill-down, as GNOME's menus)
//   ← / Esc       in a submenu: back to the menu it came from (Esc at the top closes)

export interface NavItem {
  label: string
  disabled?: boolean
  separator?: boolean
}

function enabled(items: readonly NavItem[]): number[] {
  return items.flatMap((it, i) => (it.disabled || it.separator ? [] : [i]))
}

/** The first enabled item, or -1 when none is. */
export function firstEnabled(items: readonly NavItem[]): number {
  return enabled(items)[0] ?? -1
}

/** The item `key` moves to from `current` (-1: none focused). Returns `current` when the key does not move. */
export function menuMove(items: readonly NavItem[], current: number, key: string, typed = ''): number {
  const on = enabled(items)
  if (on.length === 0) return -1
  switch (key) {
    case 'ArrowDown':
      return on.find((i) => i > current) ?? on[0]!
    case 'ArrowUp':
      return [...on].reverse().find((i) => i < current) ?? on.at(-1)!
    case 'Home':
      return on[0]!
    case 'End':
      return on.at(-1)!
  }
  const text = (typed || key).toLowerCase()
  if ([...key].length !== 1 || !text.trim()) return current
  // a repeated single letter cycles among the items starting with it; a longer prefix stays on the first match
  const from = typed.length > 1 ? current - 1 : current
  const order = [...on.filter((i) => i > from), ...on.filter((i) => i <= from)]
  return order.find((i) => items[i]!.label.toLowerCase().startsWith(text)) ?? current
}

/** What can say whether a node lies inside it: an element, or a test's stand-in. */
export interface Contains {
  contains(other: unknown): boolean
}

/**
 * Whether a pointer press closes the open menu: one outside the menu and outside the button that opened it. A press
 * on that button is left to its click, which closes the menu (a menu's own button toggles it).
 */
export function pressCloses(target: unknown, menu: Contains | null, trigger: Contains | null): boolean {
  if (!menu) return false
  return !menu.contains(target) && !(trigger?.contains(target) ?? false)
}

/**
 * Whether a closing menu gives focus back to where it was before it opened: only while focus is nowhere else (it
 * went with the menu, or the menu is still laid out). A pick that focused something (the terminal it was opened on)
 * or a press that focused another control keeps that focus.
 */
export function restoresFocus(active: unknown, menu: Contains | null, body: unknown): boolean {
  return active === null || active === body || (menu?.contains(active) ?? false)
}

/** The window root's class while a menu is open: the headers stop being drag regions, so a press there closes it. */
export const MENU_OPEN_CLASS = 'kea-menu-open'

/** Where the open-menu class goes: the document's root element, or a test's stand-in. */
export interface ClassTarget {
  classList: { toggle(name: string, force: boolean): unknown }
}

/** The window's open menus: one at a time, an opening menu closing the others, and `MENU_OPEN_CLASS` while any is open. */
/** Where an open menu gives the keyboard back as it closes, and which elements are its own. */
export interface MenuFocus<T> {
  before: T | null
  owns(node: unknown): boolean
}

export class OpenMenus<T = unknown> {
  // bounded: the open menu, and the one its opening closed until that one goes
  private readonly menus = new Set<{ close: () => void; focus: MenuFocus<T> | null }>()
  private readonly root: ClassTarget | null

  constructor(root: ClassTarget | null) {
    this.root = root
  }

  /**
   * A menu opened; `close` asks its owner to close it, and `focus` says where the keyboard was. Each other open menu is
   * closed. Returns what to call once it has gone, and where it gives the keyboard back: where it was, or, when the
   * keyboard was in a menu this one replaced, where that menu would have given it back.
   */
  opened(close: () => void, focus: MenuFocus<T> | null = null): { gone: () => void; before: T | null } {
    let before: T | null = focus?.before ?? null
    for (const other of [...this.menus]) {
      if (focus && other.focus?.owns(before)) before = other.focus.before
      other.close()
    }
    const entry = { close, focus: focus ? { before, owns: focus.owns } : null }
    this.menus.add(entry)
    this.sync()
    return {
      before,
      gone: () => {
        this.menus.delete(entry)
        this.sync()
      },
    }
  }

  get count(): number {
    return this.menus.size
  }

  private sync(): void {
    this.root?.classList.toggle(MENU_OPEN_CLASS, this.menus.size > 0)
  }
}

/** The selector of the button a menu hangs from, marked `data-menu-trigger="<name>"`: a menu's `trigger`. */
export const menuTrigger = (name: string): string => `[data-menu-trigger="${name}"]`

/** An item of a floating menu (`Menu.svelte`). */
export interface MenuItem {
  id: string
  label: string
  /** A line between groups: drawn, never focused or chosen. */
  separator?: boolean
  /** A submenu: choosing it shows these items in the menu's place, after a back row. */
  submenu?: readonly MenuItem[]
  /** The binding, as the command table writes it (`⌘N`); shown right-aligned. */
  shortcut?: string
  disabled?: boolean
  /** Why a disabled item cannot run now (the command's `unavailableReason`): its tooltip and accessible description. */
  reason?: string
  /** Destructive: `--danger` text. */
  danger?: boolean
  /**
   * Greyed like a disabled item, yet it can be chosen (an agent whose CLI is missing, which still copies its install
   * command). `reason` says why it is greyed, as its accessible description.
   */
  muted?: boolean
}

/** The id of a submenu's back row. */
export const MENU_BACK = 'kea-menu:back'

/**
 * The items a drill-down menu shows at `path` (the indexes of the submenus gone into, from the top): the top level's
 * own, or a submenu's after a back row that names the menu it came from. A path that no longer leads to a submenu
 * stops where it does.
 */
export function levelItems(items: readonly MenuItem[], path: readonly number[]): { items: readonly MenuItem[]; depth: number } {
  let level = items
  let depth = 0
  let title = ''
  for (const i of path) {
    const it = level[i]
    if (!it?.submenu) break
    title = it.label
    level = it.submenu
    depth++
  }
  return depth === 0 ? { items: level, depth } : { items: [{ id: MENU_BACK, label: title }, ...level], depth }
}

/** Where a level opens with focus: its first enabled item, past the back row when it has others. */
export function levelStart(items: readonly NavItem[], depth: number): number {
  if (depth === 0) return firstEnabled(items)
  const after = firstEnabled(items.slice(1))
  return after < 0 ? 0 : after + 1
}

/**
 * What a key does in a drill-down menu, on the focused item (`it`, at `depth`): go into its submenu, back to the menu
 * above, close, or nothing of the drill-down's (the key moves or picks as in any menu).
 */
export function drillKey(key: string, it: { id: string; submenu?: readonly unknown[]; disabled?: boolean } | undefined, depth: number): 'in' | 'back' | 'close' | null {
  if (key === 'Escape') return depth > 0 ? 'back' : 'close'
  if (key === 'ArrowLeft') return depth > 0 ? 'back' : null
  if (!it || it.disabled) return null
  if (it.id === MENU_BACK) return key === 'Enter' || key === ' ' ? 'back' : null
  if (it.submenu && (key === 'ArrowRight' || key === 'Enter' || key === ' ')) return 'in'
  return null
}

export interface MenuProps {
  /** The accessible name (`Session menu`, `Project menu`). */
  label: string
  items: readonly MenuItem[]
  /** Viewport point to open at; the menu is kept inside the window. */
  at: { x: number; y: number }
  /** `end`: the menu's right edge is at `at.x` (a button at the window's right edge, the header's ⋯); default `start`. */
  align?: 'start' | 'end'
  /**
   * The button that opened it, as a selector (`menuTrigger('open-in')`): a press on it is not outside, and its click closes
   * the menu rather than opening it again. A selector, never an element: a menu's props are rune state.
   */
  trigger?: string
  onPick(id: string): void
  onClose(): void
}

/** Linux's modifier names in a label (`Ctrl+Shift+N`) as aria-keyshortcuts names them. */
const NAMED_MODS: Readonly<Record<string, string>> = { Ctrl: 'Control', Shift: 'Shift', Alt: 'Alt', Super: 'Meta' }
const KEY_NAMES: Readonly<Record<string, string>> = { '↵': 'Enter', '⌫': 'Backspace', '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Esc: 'Escape' }

/** `⌘⇧N` → `Meta+Shift+N`, and Linux's `Ctrl+Shift+N` → `Control+Shift+N` (aria-keyshortcuts). */
export function ariaShortcut(s: string): string {
  const mods: string[] = []
  let rest = s
  for (;;) {
    const c = rest[0]
    if (c === '⌘') mods.push('Meta')
    else if (c === '⇧') mods.push('Shift')
    else if (c === '⌥') mods.push('Alt')
    else if (c === '⌃') mods.push('Control')
    else break
    rest = rest.slice(1)
  }
  for (;;) {
    const m = /^(Ctrl|Shift|Alt|Super)\+(?=.)/.exec(rest)
    if (!m) break
    mods.push(NAMED_MODS[m[1] as string] as string)
    rest = rest.slice(m[0].length)
  }
  return [...mods, KEY_NAMES[rest] ?? ([...rest].length === 1 ? rest.toUpperCase() : rest)].join('+')
}
