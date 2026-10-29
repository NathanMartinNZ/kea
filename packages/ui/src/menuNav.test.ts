import { describe, expect, it } from 'vitest'
import { ariaShortcut, drillKey, firstEnabled, levelItems, levelStart, MENU_BACK, MENU_OPEN_CLASS, menuMove, OpenMenus, pressCloses, restoresFocus, type MenuItem, type NavItem } from './menuNav.ts'

/** A stand-in element: what it contains, by name. */
const box = (...inside: string[]) => ({ contains: (n: unknown) => inside.includes(n as string) })

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

  it('U-MENU-2 · a press outside the menu closes it; a press on its own button does not (that button’s click closes it), nor one inside it', () => {
    const menu = box('menu', 'item')
    const trigger = box('trigger', 'trigger icon')
    expect(pressCloses('elsewhere', menu, trigger)).toBe(true)
    expect(pressCloses('elsewhere', menu, null)).toBe(true) // a context menu has no button
    expect(pressCloses('item', menu, trigger)).toBe(false)
    expect(pressCloses('trigger icon', menu, trigger)).toBe(false)
    expect(pressCloses('trigger', menu, null)).toBe(true) // the button is not known: it is outside
    expect(pressCloses('elsewhere', null, trigger)).toBe(false) // not laid out yet
  })

  it('U-MENU-2 · closing gives focus back only when it is nowhere else: not after a pick that focused something, nor a click on another control', () => {
    const menu = box('item')
    expect(restoresFocus('body', menu, 'body')).toBe(true) // the menu's own focus went with it (Esc, a pick that moved nothing)
    expect(restoresFocus(null, menu, 'body')).toBe(true)
    expect(restoresFocus('item', menu, 'body')).toBe(true) // still laid out
    expect(restoresFocus('terminal', menu, 'body')).toBe(false) // the pick focused the clicked terminal
    expect(restoresFocus('other button', null, 'body')).toBe(false)
  })

  it('U-MENU-2 · one menu at a time: opening one closes the others; the window carries the open-menu class while any is open', () => {
    const on = new Set<string>()
    const root = { classList: { toggle: (c: string, force: boolean) => void (force ? on.add(c) : on.delete(c)) } }
    const menus = new OpenMenus(root)
    const closed: string[] = []
    const a = menus.opened(() => closed.push('a')).gone
    expect(on.has(MENU_OPEN_CLASS)).toBe(true)
    expect(menus.count).toBe(1)
    const b = menus.opened(() => closed.push('b')).gone
    expect(closed).toEqual(['a']) // b's opening closed a
    a() // a goes once its owner has closed it
    expect(on.has(MENU_OPEN_CLASS)).toBe(true)
    b()
    expect(on.has(MENU_OPEN_CLASS)).toBe(false)
    expect(menus.count).toBe(0)
    b() // a second disposal changes nothing
    expect(menus.count).toBe(0)
    expect(new OpenMenus(null).opened(() => {}).gone).toBeTypeOf('function') // no window (a server render)
  })

  it('U-MENU-2 · a menu opened in another’s place while the keyboard was in that one gives the keyboard back where that one would have; opened from elsewhere, where it was', () => {
    const menus = new OpenMenus<string>(null)
    // the terminal menu, opened from the terminal
    const terminal = menus.opened(() => {}, { before: 'terminal', owns: (n) => n === 'terminal-menu-item' })
    expect(terminal.before).toBe('terminal')
    // Alt alone with the keyboard on its item: the window's menu replaces it, and its close goes back to the terminal
    const windowMenu = menus.opened(() => terminal.gone(), { before: 'terminal-menu-item', owns: (n) => n === 'window-menu-item' })
    expect(windowMenu.before).toBe('terminal')
    windowMenu.gone()
    // a menu opened while the keyboard was elsewhere keeps its own
    const a = menus.opened(() => {}, { before: 'field', owns: () => false })
    expect(menus.opened(() => a.gone(), { before: 'sidebar row', owns: () => false }).before).toBe('sidebar row')
  })

  it('U-MENU-3 · a drill-down: a submenu shows its items after a back row naming the menu it came from; separators are never reached', () => {
    const edit: MenuItem[] = [{ id: 'undo', label: 'Undo' }, { id: 'sep:1', label: '', separator: true }, { id: 'copy', label: 'Copy' }, { id: 'paste', label: 'Paste', disabled: true }]
    const top: MenuItem[] = [{ id: 'menu:File', label: 'File', submenu: [{ id: 'quit', label: 'Quit' }] }, { id: 'menu:Edit', label: 'Edit', submenu: edit }, { id: 'about', label: 'About' }]
    expect(levelItems(top, [])).toEqual({ items: top, depth: 0 })
    const inEdit = levelItems(top, [1])
    expect(inEdit.depth).toBe(1)
    expect(inEdit.items.map((i) => i.id)).toEqual([MENU_BACK, 'undo', 'sep:1', 'copy', 'paste'])
    expect(inEdit.items[0]?.label).toBe('Edit')
    // a path past the leaves stops at the last submenu
    expect(levelItems(top, [1, 0]).depth).toBe(1)
    expect(levelItems(top, [2]).depth).toBe(0)
    // a level opens on its first item, past the back row
    expect(levelStart(top, 0)).toBe(0)
    expect(levelStart(inEdit.items, 1)).toBe(1)
    expect(levelStart([{ label: 'Edit' }, { label: 'x', disabled: true }], 1)).toBe(0) // nothing else: the back row
    // the arrows step over the separator and the disabled item, and wrap through the back row
    expect(menuMove(inEdit.items, 1, 'ArrowDown')).toBe(3)
    expect(menuMove(inEdit.items, 3, 'ArrowDown')).toBe(0)
    expect(menuMove(inEdit.items, 3, 'ArrowUp')).toBe(1)
    expect(firstEnabled([{ label: '', separator: true }, { label: 'a' }])).toBe(1)
  })

  it('U-MENU-3 · → or ↵ goes into a submenu, ← or Esc comes back, Esc at the top closes; the back row goes back by ↵', () => {
    const sub = { id: 'menu:Edit', submenu: [] as unknown[] }
    expect(drillKey('ArrowRight', sub, 0)).toBe('in')
    expect(drillKey('Enter', sub, 0)).toBe('in')
    expect(drillKey(' ', sub, 1)).toBe('in')
    expect(drillKey('ArrowRight', { id: 'copy' }, 1)).toBeNull() // a leaf: → does nothing
    expect(drillKey('Enter', { id: 'copy' }, 1)).toBeNull() // a leaf: ↵ picks, as in any menu
    expect(drillKey('ArrowLeft', { id: 'copy' }, 1)).toBe('back')
    expect(drillKey('ArrowLeft', { id: 'copy' }, 0)).toBeNull()
    expect(drillKey('Escape', { id: 'copy' }, 2)).toBe('back')
    expect(drillKey('Escape', { id: 'copy' }, 0)).toBe('close')
    expect(drillKey('Escape', undefined, 0)).toBe('close')
    expect(drillKey('Enter', { id: MENU_BACK }, 1)).toBe('back')
    expect(drillKey('ArrowRight', { id: MENU_BACK }, 1)).toBeNull()
    expect(drillKey('Enter', { ...sub, disabled: true }, 0)).toBeNull()
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
