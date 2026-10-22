import { describe, expect, it } from 'vitest'
import { ariaShortcut, firstEnabled, menuMove, type NavItem } from './menuNav.ts'

const items: NavItem[] = [
  { label: 'Rename' },
  { label: 'Open in Editor', disabled: true },
  { label: 'Reveal Worktree in Finder' },
  { label: 'Copy Branch Name' },
  { label: 'Copy Worktree Path' },
  { label: 'Duplicate' },
  { label: 'Archive', disabled: true },
]

describe('menu keyboard model', () => {
  it('U-MENU-1 · arrows skip disabled items and wrap; Home and End; a letter jumps to the next item starting with it, cycling', () => {
    expect(firstEnabled(items)).toBe(0)
    expect(firstEnabled([{ label: 'a', disabled: true }, { label: 'b' }])).toBe(1)
    expect(firstEnabled([{ label: 'a', disabled: true }])).toBe(-1)

    expect(menuMove(items, 0, 'ArrowDown')).toBe(2) // past the disabled one
    expect(menuMove(items, 5, 'ArrowDown')).toBe(0) // wraps: Archive is disabled
    expect(menuMove(items, 0, 'ArrowUp')).toBe(5)
    expect(menuMove(items, 2, 'ArrowUp')).toBe(0)
    expect(menuMove(items, -1, 'ArrowDown')).toBe(0)
    expect(menuMove(items, 3, 'Home')).toBe(0)
    expect(menuMove(items, 0, 'End')).toBe(5)

    // type-ahead, case-insensitive; the same letter again cycles among the matches
    expect(menuMove(items, 0, 'c')).toBe(3)
    expect(menuMove(items, 3, 'c')).toBe(4)
    expect(menuMove(items, 4, 'C')).toBe(3)
    expect(menuMove(items, 0, 'o')).toBe(0) // the only "O…" item is disabled
    expect(menuMove(items, 0, 'z')).toBe(0) // no match: stays
    // a longer prefix stays on the first match from the current item
    expect(menuMove(items, 3, 'w', 'copy w')).toBe(4)
    // keys that are not navigation leave it where it is
    expect(menuMove(items, 2, 'Shift')).toBe(2)
    expect(menuMove(items, 2, ' ')).toBe(2)
    // nothing enabled: nowhere to go
    expect(menuMove([{ label: 'x', disabled: true }], -1, 'ArrowDown')).toBe(-1)
  })

  it('U-MENU-1 · shortcut hints are announced in aria-keyshortcuts form', () => {
    expect(ariaShortcut('⌘N')).toBe('Meta+N')
    expect(ariaShortcut('⌘⇧N')).toBe('Meta+Shift+N')
    expect(ariaShortcut('⌥⌘J')).toBe('Alt+Meta+J')
    expect(ariaShortcut('⌘⇧⌫')).toBe('Meta+Shift+Backspace')
    expect(ariaShortcut('⌃Tab')).toBe('Control+Tab')
    // Linux's labels (the command table's Linux keys)
    expect(ariaShortcut('Ctrl+Shift+N')).toBe('Control+Shift+N')
    expect(ariaShortcut('Ctrl+Shift+Alt+Enter')).toBe('Control+Shift+Alt+Enter')
    expect(ariaShortcut('Alt+Down')).toBe('Alt+ArrowDown')
    expect(ariaShortcut('Ctrl+Shift+-')).toBe('Control+Shift+-')
    expect(ariaShortcut('Shift+F6')).toBe('Shift+F6')
  })
})
