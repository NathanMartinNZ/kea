import { describe, expect, it } from 'vitest'
import { TerminalRegistry, type ManagedView } from './registry.ts'
import { ScreenReaderMode, terminalName, type ScreenReaderTarget } from './screenReader.ts'

/** A terminal view as the mode sees it: what it was told, in order. */
class FakeView implements ManagedView, ScreenReaderTarget {
  readonly ptyId: string
  mode = false
  name: string | null = null
  /** Every change of the mode this view was told (a call that changes nothing is not one). */
  switches = 0
  disposed = false
  constructor(ptyId: string) {
    this.ptyId = ptyId
  }
  setScreenReader(on: boolean): void {
    if (this.disposed) throw new Error(`setScreenReader on disposed ${this.ptyId}`)
    if (on !== this.mode) this.switches++
    this.mode = on
  }
  setAccessibleName(name: string): void {
    this.name = name
  }
  setWebgl(): void {}
  dispose(): void {
    this.disposed = true
    this.mode = false
  }
}

/** The window's wiring (views.ts): a registry whose views the mode adopts, and which tells it the terminal on screen. */
function setup() {
  const made: FakeView[] = []
  const mode: ScreenReaderMode<FakeView> = new ScreenReaderMode<FakeView>(() => reg.all())
  const reg: TerminalRegistry<FakeView> = new TerminalRegistry<FakeView>(
    (id) => {
      const v = new FakeView(id)
      made.push(v)
      mode.adopt(v)
      return v
    },
    { warm: 3, glMax: 4 },
    (id) => mode.setShown(id),
  )
  /** Switch to `id` among `tabs` and let the switch show, as the terminal area does once the view has painted. */
  const show = (id: string | null, tabs: readonly string[], o: { exists?: (id: string) => boolean } = {}): void => {
    reg.activate(id, tabs, { pinned: tabs.filter((t) => t !== id), ...o })
    reg.setShown(id)
  }
  const on = (): string[] => [...reg.all()].filter((v) => v.mode).map((v) => v.ptyId)
  return { reg, mode, made, show, on }
}

describe('screen-reader mode', () => {
  it('U-TERM-33 · while a screen reader runs, xterm’s screen-reader mode is on in the terminal on screen and in no other; it follows the terminal on screen, goes on and off live with the screen reader, and no terminal is made again for it', () => {
    const t = setup()
    const tabs = ['agent', 'server', 'zsh']
    for (const id of [...tabs, 'agent']) t.show(id, tabs)
    expect(t.reg.size, 'the session’s three tabs are alive').toBe(3)
    // no screen reader: no terminal keeps a screen-reader copy of its screen
    expect(t.on()).toEqual([])
    expect(t.made.every((v) => v.switches === 0), 'and none was ever told to').toBe(true)

    // it starts: the terminal on screen, and only it (a hidden terminal pays nothing)
    t.mode.setRunning(true)
    expect(t.mode.isRunning).toBe(true)
    expect(t.on()).toEqual(['agent'])
    // another tab comes on screen: the mode moves with it
    t.show('zsh', tabs)
    expect(t.on()).toEqual(['zsh'])
    t.show('server', tabs)
    expect(t.on()).toEqual(['server'])
    // a terminal made while it runs (a new shell): on once it is the one on screen, not before
    const more = [...tabs, 'zsh-2']
    t.reg.activate('zsh-2', more, { pinned: tabs })
    expect(t.reg.get('zsh-2')?.mode, 'made, not on screen yet').toBe(false)
    expect(t.on()).toEqual(['server'])
    t.reg.setShown('zsh-2')
    expect(t.on()).toEqual(['zsh-2'])
    // nothing on screen (the composer, a file tab): none
    t.reg.setShown(null)
    expect(t.on()).toEqual([])
    t.show('agent', more)
    expect(t.on()).toEqual(['agent'])
    // the tab on screen is closed: no view is left with the mode on
    t.reg.close('agent')
    expect(t.on()).toEqual([])
    t.show('server', ['server', 'zsh', 'zsh-2'])

    // it stops: off everywhere, at once
    t.mode.setRunning(false)
    expect(t.on()).toEqual([])
    // and on again, live: the same views, none made for it
    const before = t.made.length
    t.mode.setRunning(true)
    expect(t.on()).toEqual(['server'])
    t.mode.setRunning(true)
    expect(t.made.length, 'no terminal was made again').toBe(before)
    // a view is told only on a change: `server` came on screen, left, came back, and saw the stop and the start
    expect(t.reg.get('server')!.switches).toBe(5)
  })

  it('U-TERM-33 · each terminal’s accessible name says its session and its tab; a rename and a tab’s new title reach the views, a view made later takes its name, and the names held never outgrow the open tabs', () => {
    expect(terminalName('Fix auth redirect', 'Agent')).toBe('Fix auth redirect, Agent terminal')
    expect(terminalName('Fix auth redirect', 'Server')).toBe('Fix auth redirect, Server terminal')
    expect(terminalName('Fix auth redirect', 'vim')).toBe('Fix auth redirect, vim terminal')
    // the shells outside a session have no session to name
    expect(terminalName(null, 'zsh')).toBe('zsh terminal')
    expect(terminalName('  ', 'zsh')).toBe('zsh terminal')
    expect(terminalName('Fix auth redirect', ' ')).toBe('Fix auth redirect, shell terminal')

    const t = setup()
    const names = (session: string, tabs: readonly [string, string][]) => tabs.map(([id, tab]) => [id, terminalName(session, tab)] as const)
    // the names arrive with the tabs list, before any view: the views take theirs as they are made
    t.mode.setNames(names('Fix auth redirect', [['agent', 'Agent'], ['zsh', 'zsh']]))
    t.show('agent', ['agent', 'zsh'])
    t.show('zsh', ['agent', 'zsh'])
    expect(t.reg.get('agent')?.name).toBe('Fix auth redirect, Agent terminal')
    expect(t.reg.get('zsh')?.name).toBe('Fix auth redirect, zsh terminal')
    // the session is renamed, and the shell's program sets a title: the live views follow
    t.mode.setNames(names('Auth redirect loop', [['agent', 'Agent'], ['zsh', 'vim']]))
    expect(t.reg.get('agent')?.name).toBe('Auth redirect loop, Agent terminal')
    expect(t.reg.get('zsh')?.name).toBe('Auth redirect loop, vim terminal')
    expect(t.mode.nameCount).toBe(2)

    // a hundred sessions shown one after another, each with its tabs: the names held are the ones of the tabs open now
    for (let i = 0; i < 100; i++) {
      const tabs: [string, string][] = [[`agent-${i}`, 'Agent'], [`zsh-${i}`, 'zsh'], [`srv-${i}`, 'Server']]
      t.mode.setNames(names(`session ${i}`, tabs))
      t.show(`agent-${i}`, tabs.map(([id]) => id), { exists: (id) => id.startsWith('agent-') })
      expect(t.mode.nameCount).toBe(3)
    }
    t.mode.setNames([])
    expect(t.mode.nameCount).toBe(0)
  })
})
