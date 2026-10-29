// The terminal menu's opening rule and its listeners, over plain events on a stand-in element whose child stands for
// xterm (no DOM): which presses open the menu, which are the program's, and which never reach xterm.

import { describe, expect, it } from 'vitest'
import { cursorPoint, listenForMenu, menuOpens, type MenuDeps, type PressFacts, type PressLike } from './contextMenu.ts'

const RIGHT: PressLike = { button: 2, ctrlKey: false, shiftKey: false, altKey: false }
const CTRL_CLICK: PressLike = { button: 0, ctrlKey: true, shiftKey: false, altKey: false }
const facts = (o: Partial<PressFacts> = {}): PressFacts => ({ tracking: false, hadSelection: false, agentGivesButton: false, ...o })

type Listener = (e: FakeEvent) => void
interface FakeEvent {
  type: string
  button: number
  buttons: number
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  clientX: number
  clientY: number
  defaultPrevented: boolean
  stopped: boolean
  preventDefault(): void
  stopPropagation(): void
}

/**
 * Kea's element with xterm inside it: an event goes through Kea's capture listeners, then xterm's, then Kea's bubble
 * listeners, and stops where a listener stops it, as in the page.
 */
function terminalElement() {
  const capture = new Map<string, Listener[]>()
  const bubble = new Map<string, Listener[]>()
  const xterm: string[] = []
  const el = {
    addEventListener: (type: string, fn: Listener, useCapture?: boolean) => {
      const m = useCapture ? capture : bubble
      m.set(type, [...(m.get(type) ?? []), fn])
    },
    removeEventListener: (type: string, fn: Listener, useCapture?: boolean) => {
      const m = useCapture ? capture : bubble
      m.set(type, (m.get(type) ?? []).filter((f) => f !== fn))
    },
  }
  const send = (type: string, o: Partial<FakeEvent> = {}): FakeEvent => {
    const e: FakeEvent = {
      type,
      button: 2,
      buttons: 0,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      clientX: 10,
      clientY: 20,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {
        this.stopped = true
      },
      ...o,
    }
    for (const fn of capture.get(type) ?? []) fn(e)
    if (e.stopped) return e
    xterm.push(type)
    for (const fn of bubble.get(type) ?? []) fn(e)
    return e
  }
  return { el: el as unknown as HTMLElement, send, xterm, listeners: () => [...capture.values(), ...bubble.values()].flat().length }
}

describe('the terminal menu', () => {
  it('U-TERM-54 · a right-click opens the menu; a program that captures the mouse keeps the button unless the override is held, text is selected or the agent gives it up; on macOS a Ctrl+click is a right-click', () => {
    for (const system of ['darwin', 'linux'] as const) {
      // no program asked for the mouse: the menu, after xterm's own handling
      expect(menuOpens(RIGHT, facts(), system), system).toBe('menu')
      expect(menuOpens(RIGHT, facts({ hadSelection: true }), system), system).toBe('menu')
      // a program captures the mouse: the button is its own
      expect(menuOpens(RIGHT, facts({ tracking: true }), system), system).toBe('program')
      // ...unless text was selected (Shift-drag, then right-click) or the agent has nothing on that button: Kea stops it
      expect(menuOpens(RIGHT, facts({ tracking: true, hadSelection: true }), system), system).toBe('stopped')
      expect(menuOpens(RIGHT, facts({ tracking: true, agentGivesButton: true }), system), system).toBe('stopped')
      // the left and middle buttons are never the menu's
      expect(menuOpens({ ...RIGHT, button: 0 }, facts(), system), system).toBeNull()
      expect(menuOpens({ ...RIGHT, button: 1 }, facts({ tracking: true }), system), system).toBeNull()
    }
    // the override is xterm's: Shift on Linux, ⌥ on macOS; under it the program is told nothing
    expect(menuOpens({ ...RIGHT, shiftKey: true }, facts({ tracking: true }), 'linux')).toBe('menu')
    expect(menuOpens({ ...RIGHT, altKey: true }, facts({ tracking: true }), 'linux')).toBe('program')
    expect(menuOpens({ ...RIGHT, altKey: true }, facts({ tracking: true }), 'darwin')).toBe('menu')
    expect(menuOpens({ ...RIGHT, shiftKey: true }, facts({ tracking: true }), 'darwin')).toBe('program')
    // macOS's Ctrl+click follows the same rule, its press kept from xterm, which would take it for a left click that
    // replaces the selection; on Linux it is a link's click, never the menu's
    expect(menuOpens(CTRL_CLICK, facts(), 'darwin')).toBe('ctrlClick')
    expect(menuOpens({ ...CTRL_CLICK, altKey: true }, facts({ tracking: true }), 'darwin')).toBe('ctrlClick')
    expect(menuOpens(CTRL_CLICK, facts({ tracking: true }), 'darwin')).toBe('program')
    expect(menuOpens(CTRL_CLICK, facts({ tracking: true, hadSelection: true }), 'darwin')).toBe('stopped')
    expect(menuOpens(CTRL_CLICK, facts(), 'linux')).toBeNull()
  })

  it('U-TERM-54 · the listeners: a stopped press, its drag and its release never reach xterm and the menu opens at the pointer; the program’s press reaches xterm and only its contextmenu is stopped; a Ctrl+click’s press is kept from xterm and its contextmenu is not; a contextmenu no press started opens nothing', () => {
    const t = terminalElement()
    const opened: { x: number; y: number }[] = []
    let focused = 0
    const state = { system: 'linux' as 'linux' | 'darwin', tracking: true, selection: false, agent: false }
    const deps: MenuDeps = {
      get system() {
        return state.system
      },
      tracking: () => state.tracking,
      hasSelection: () => state.selection,
      agentGivesButton: () => state.agent,
      focus: () => void focused++,
      open: (at) => void opened.push(at),
    }
    const off = listenForMenu(t.el, deps)
    const xtermSaw = (): string[] => t.xterm.splice(0)

    // the agent gives up the button: the press, a drag with it held and its release reach no one, and Kea focuses the terminal
    state.agent = true
    expect(t.send('mousedown').defaultPrevented).toBe(true)
    expect(focused).toBe(1)
    t.send('mousemove', { buttons: 2 })
    expect(t.send('contextmenu', { clientX: 30, clientY: 40 }).defaultPrevented).toBe(true)
    expect(opened).toEqual([{ x: 30, y: 40 }])
    t.send('mouseup')
    expect(xtermSaw()).toEqual([])
    // once released, moves are the program's again
    t.send('mousemove', { buttons: 0 })
    t.send('mousemove', { buttons: 2 })
    expect(xtermSaw()).toEqual(['mousemove', 'mousemove'])

    // text selected: the same, so the selection stays
    state.agent = false
    state.selection = true
    t.send('mousedown')
    t.send('contextmenu')
    t.send('mouseup')
    expect(xtermSaw()).toEqual([])
    expect(opened).toHaveLength(2)

    // the program keeps the button: xterm reports the press and release, the contextmenu is stopped, nothing opens
    state.selection = false
    t.send('mousedown')
    expect(t.send('contextmenu').defaultPrevented).toBe(true)
    t.send('mouseup')
    expect(xtermSaw()).toEqual(['mousedown', 'mouseup'])
    expect(opened).toHaveLength(2)

    // no program asked for the mouse: xterm has the press and the contextmenu (its word selection), then the menu opens
    state.tracking = false
    t.send('mousedown')
    expect(t.send('contextmenu', { clientX: 5, clientY: 6 }).defaultPrevented).toBe(true)
    t.send('mouseup')
    expect(xtermSaw()).toEqual(['mousedown', 'contextmenu', 'mouseup'])
    expect(opened.at(-1)).toEqual({ x: 5, y: 6 })
    expect(focused).toBe(2)

    // macOS's Ctrl+click: its press and release are kept from xterm (they would replace the selection); xterm has the
    // contextmenu, which selects the word only outside the selection; then the menu opens, and Kea focuses the terminal
    state.system = 'darwin'
    t.send('mousedown', { button: 0, ctrlKey: true })
    expect(t.send('contextmenu', { button: 0, ctrlKey: true }).defaultPrevented).toBe(true)
    t.send('mousemove', { button: 0, buttons: 1 })
    t.send('mouseup', { button: 0, ctrlKey: true })
    expect(xtermSaw()).toEqual(['contextmenu'])
    expect(opened).toHaveLength(4)
    expect(focused).toBe(3)

    // a contextmenu with no press before it (the keyboard's) opens nothing; neither does one after a left press
    state.system = 'linux'
    expect(t.send('contextmenu').defaultPrevented).toBe(true)
    t.send('mousedown', { button: 0 })
    t.send('contextmenu')
    expect(opened).toHaveLength(4)

    off.dispose()
    expect(t.listeners()).toBe(0)
  })

  it('U-TERM-54 · the Menu key opens the menu under the text cursor’s cell, on the nearest row when the view is scrolled away from it', () => {
    const screen = { left: 100, top: 50, width: 800, height: 480 } // 80 × 24 cells of 10 × 20
    const at = (o: Partial<Parameters<typeof cursorPoint>[0]>) => cursorPoint({ cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0, cols: 80, rows: 24, ...o }, screen)
    expect(at({})).toEqual({ x: 100, y: 70 })
    expect(at({ cursorX: 5, cursorY: 2 })).toEqual({ x: 150, y: 110 })
    // scrollback above: the cursor's row counts from the last page
    expect(at({ cursorX: 5, cursorY: 2, baseY: 100, viewportY: 100 })).toEqual({ x: 150, y: 110 })
    // scrolled up past it: the bottom row
    expect(at({ cursorY: 2, baseY: 100, viewportY: 10 })).toEqual({ x: 100, y: 530 })
    // a cursor past the last column (after a full line) stays on the screen
    expect(at({ cursorX: 80 })).toEqual({ x: 890, y: 70 })
  })
})
