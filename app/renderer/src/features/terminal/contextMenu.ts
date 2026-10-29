// The terminal menu's opening rule: which presses open Kea's menu, and which belong to the program that asked for mouse
// reports. A program that captures the mouse keeps the right button, unless the selection override is held (Shift;
// ⌥ on macOS), text was selected when the button went down, or the tab's agent has nothing on that button; then Kea
// stops the press before xterm reports it. `listenForMenu` wires the rule to a terminal's element.

import type { System } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'

/** What a press reads: its button and modifiers. */
export interface PressLike {
  button: number
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** What the terminal is like as the button goes down. */
export interface PressFacts {
  /** The program asked for mouse reports (xterm's `modes.mouseTrackingMode` is not `none`). */
  tracking: boolean
  /** Text is selected in this terminal. */
  hadSelection: boolean
  /** The tab's agent captures the mouse but has nothing on the right button (`AgentInfo.rightButtonMenu`). */
  agentGivesButton: boolean
}

/** What a press does (`menuOpens`). */
export type MenuPress = 'menu' | 'ctrlClick' | 'stopped' | 'program'

/**
 * What a press does: `menu`, the menu opens on the `contextmenu` that follows, once xterm has handled it (macOS selects
 * the word under the pointer unless the press is inside the selection); `ctrlClick`, the same for macOS's Ctrl+click,
 * whose press, moves and release Kea stops first, since xterm would take them for a left click that replaces the
 * selection; `stopped`, the menu opens and Kea stops the press, its moves, its release and the `contextmenu` before
 * xterm, so the program is told nothing and the selection stays; `program`, the button is the program's and no menu
 * opens (Kea stops only the `contextmenu`, so xterm selects no word). Null: not a menu press. The right button opens
 * it on both systems; on macOS a Ctrl+click too.
 */
export function menuOpens(p: PressLike, f: PressFacts, system: System): MenuPress | null {
  const ctrlClick = system === 'darwin' && p.button === 0 && p.ctrlKey
  if (p.button !== 2 && !ctrlClick) return null
  // xterm's override: under it nothing is reported to the program
  const override = system === 'darwin' ? p.altKey : p.shiftKey
  if (!f.tracking || override) return ctrlClick ? 'ctrlClick' : 'menu'
  return f.hadSelection || f.agentGivesButton ? 'stopped' : 'program'
}

/** The menu opens once xterm has had the `contextmenu`. */
const afterXterm = (p: MenuPress | null): boolean => p === 'menu' || p === 'ctrlClick'

/** Where the text cursor is: xterm's buffer (`cursorY` counts from `baseY`, the last page) and the grid's size. */
export interface CursorFacts {
  cursorX: number
  cursorY: number
  baseY: number
  viewportY: number
  cols: number
  rows: number
}

/**
 * The point under the text cursor's cell, where the Menu key opens the menu: inside the screen's rectangle, on its
 * nearest row when the view is scrolled away from the cursor.
 */
export function cursorPoint(c: CursorFacts, screen: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(v, max))
  const col = clamp(c.cursorX, c.cols - 1)
  const row = clamp(c.baseY + c.cursorY - c.viewportY, c.rows - 1)
  const cw = screen.width / Math.max(1, c.cols)
  const ch = screen.height / Math.max(1, c.rows)
  return { x: Math.round(screen.left + col * cw), y: Math.round(screen.top + (row + 1) * ch) }
}

/** What `listenForMenu` asks of its terminal. */
export interface MenuDeps {
  system: System
  tracking(): boolean
  hasSelection(): boolean
  agentGivesButton(): boolean
  /** The keyboard to this terminal (xterm's own press, which would have done it, was stopped). */
  focus(): void
  open(at: { x: number; y: number }): void
}

/**
 * The menu's listeners on a terminal's element, the parent of xterm's: the press, its moves and release in the capture
 * phase, so they run before xterm's; the `contextmenu` in both phases, so a menu that waits for xterm opens after it.
 * A `contextmenu` no press started (the keyboard's) opens nothing here: the Menu key is the view's.
 */
export function listenForMenu(el: HTMLElement, d: MenuDeps): Disposable {
  let press: MenuPress | null = null
  /** The buttons of a stopped press (`MouseEvent.buttons`), while it is held; 0 when none is. */
  let held = 0
  const stop = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  const down = (e: MouseEvent): void => {
    press = menuOpens(e, { tracking: d.tracking(), hadSelection: d.hasSelection(), agentGivesButton: d.agentGivesButton() }, d.system)
    if (press !== 'stopped' && press !== 'ctrlClick') return
    stop(e)
    held = e.button === 2 ? 2 : 1
    d.focus()
  }
  const move = (e: MouseEvent): void => {
    if (held === 0) return
    if ((e.buttons & held) !== 0) stop(e)
    else held = 0
  }
  const up = (e: MouseEvent): void => {
    if (held === 0 || (e.button === 2 ? 2 : 1) !== held) return
    held = 0
    stop(e)
  }
  const early = (e: MouseEvent): void => {
    const p = press
    if (afterXterm(p)) return
    press = null
    stop(e)
    if (p === 'stopped') d.open({ x: e.clientX, y: e.clientY })
  }
  const late = (e: MouseEvent): void => {
    if (!afterXterm(press)) return
    press = null
    e.preventDefault()
    d.open({ x: e.clientX, y: e.clientY })
  }
  el.addEventListener('mousedown', down, true)
  el.addEventListener('mousemove', move, true)
  el.addEventListener('mouseup', up, true)
  el.addEventListener('contextmenu', early, true)
  el.addEventListener('contextmenu', late)
  return {
    dispose: () => {
      el.removeEventListener('mousedown', down, true)
      el.removeEventListener('mousemove', move, true)
      el.removeEventListener('mouseup', up, true)
      el.removeEventListener('contextmenu', early, true)
      el.removeEventListener('contextmenu', late)
    },
  }
}
