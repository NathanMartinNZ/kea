// Keyboard model of a menu: which item a key moves to. Pure, so the renderer's menus behave the same whether
// they are context menus, the header overflow or a dropdown.
//
//   ↓ / ↑         next / previous enabled item, wrapping
//   Home / End    first / last enabled item
//   a printable   type-ahead: the next enabled item whose label starts with the typed text (case-insensitive)

export interface NavItem {
  label: string
  disabled?: boolean
}

function enabled(items: readonly NavItem[]): number[] {
  return items.flatMap((it, i) => (it.disabled ? [] : [i]))
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

/** An item of a floating menu (`Menu.svelte`). */
export interface MenuItem {
  id: string
  label: string
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

export interface MenuProps {
  /** The accessible name (`Session menu`, `Project menu`). */
  label: string
  items: readonly MenuItem[]
  /** Viewport point to open at; the menu is kept inside the window. */
  at: { x: number; y: number }
  /** `end`: the menu's right edge is at `at.x` (a button at the window's right edge, the header's ⋯); default `start`. */
  align?: 'start' | 'end'
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
