// What may come in while a modal is open: the gate's table, Linux's copy and paste keys still reaching a modal's field,
// the menu bar's greyed entries, and code inside a modal still running commands.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindings, COMMANDS, MAIN_COMMANDS } from '@kea/protocol'
import { linux } from '@kea/protocol/os/linux'
import { routeKey, setBindings, type KeyLike, type RouteContext } from './keys.ts'
import { allowed, gatedMenuState } from './modalGate.ts'
import { CommandRegistry } from './registry.ts'

const CLIPBOARD = ['terminal.copy', 'terminal.paste', 'terminal.selectAll']
const SETTINGS_OWN = ['app.settings', 'app.showDisk', 'project.settings']
const others = COMMANDS.map((c) => c.id).filter((id) => !CLIPBOARD.includes(id) && !SETTINGS_OWN.includes(id))

/** A key as Chromium reports it on Linux, US layout. */
const key = (k: string, code: string, mods: { ctrl?: boolean; shift?: boolean } = {}): KeyLike => ({ key: k, code, metaKey: false, ctrlKey: !!mods.ctrl, altKey: false, shiftKey: !!mods.shift })

describe('the modal gate', () => {
  it('U-KB-21 · with no modal every command comes in; over a confirmation only copy, paste and select all; with Settings on top also ⌘, and the commands that show its pages; between a sequence’s steps only the clipboard’s', () => {
    for (const id of COMMANDS.map((c) => c.id)) expect(allowed(id, false, null), id).toBe(true)
    for (const id of CLIPBOARD) for (const top of ['confirm', 'settings', null] as const) expect(allowed(id, true, top), `${id} ${top}`).toBe(true)
    for (const id of SETTINGS_OWN) {
      expect(allowed(id, true, 'settings'), id).toBe(true)
      expect(allowed(id, true, 'confirm'), id).toBe(false)
      expect(allowed(id, true, null), id).toBe(false)
    }
    expect(others.length).toBeGreaterThan(50)
    for (const id of others) for (const top of ['confirm', 'settings', null] as const) expect(allowed(id, true, top), `${id} ${top}`).toBe(false)
  })

  describe('on Linux', () => {
    beforeAll(() => setBindings(bindings(COMMANDS, linux.keys)))
    afterAll(() => setBindings(bindings()))

    it('U-KB-21 · over a confirmation, Ctrl+Shift+C and Ctrl+Insert copy and Ctrl+Shift+V and Shift+Insert paste in a modal’s field through the Edit roles; a command’s key (New Session, the palette, ⌘,) runs nothing and goes to the field', () => {
      const has: RouteContext['has'] = (id) => !MAIN_COMMANDS.includes(id) && allowed(id, true, 'confirm')
      const field: RouteContext = { inTerminal: false, has }
      const route = (e: KeyLike) => routeKey(e, field, linux.keys)
      expect(route(key('C', 'KeyC', { ctrl: true, shift: true }))).toEqual({ do: 'edit', id: 'terminal.copy', role: 'copy' })
      expect(route(key('Insert', 'Insert', { ctrl: true }))).toEqual({ do: 'edit', id: 'terminal.copy', role: 'copy' })
      expect(route(key('V', 'KeyV', { ctrl: true, shift: true }))).toEqual({ do: 'edit', id: 'terminal.paste', role: 'paste' })
      expect(route(key('Insert', 'Insert', { shift: true }))).toEqual({ do: 'edit', id: 'terminal.paste', role: 'paste' })
      for (const e of [key('N', 'KeyN', { ctrl: true, shift: true }), key('P', 'KeyP', { ctrl: true, shift: true }), key('<', 'Comma', { ctrl: true, shift: true })]) expect(route(e).do, e.code).not.toBe('command')
    })
  })

  it('U-KB-21 · the menu bar greys every enabled command a modal does not allow and leaves the rest as they were', () => {
    const state = { commands: [{ id: 'session.new', enabled: true }, { id: 'terminal.copy', enabled: true }, { id: 'app.settings', enabled: true, title: 'Settings…' }, { id: 'session.archive', enabled: false }] }
    expect(gatedMenuState(state, (id) => allowed(id, false, null))).toEqual(state)
    expect(gatedMenuState(state, (id) => allowed(id, true, 'confirm')).commands).toEqual([
      { id: 'session.new', enabled: false },
      { id: 'terminal.copy', enabled: true },
      { id: 'app.settings', enabled: false, title: 'Settings…' },
      { id: 'session.archive', enabled: false },
    ])
    expect(gatedMenuState(state, (id) => allowed(id, true, 'settings')).commands.filter((c) => c.enabled).map((c) => c.id)).toEqual(['terminal.copy', 'app.settings'])
  })

  it('U-KB-21 · code inside a modal still runs a command: the gate closes the ways in, not the registry', () => {
    const r = new CommandRegistry()
    let ran = 0
    r.register('app.reloadShellEnv', { run: () => void ran++ })
    expect(allowed('app.reloadShellEnv', true, 'settings')).toBe(false)
    expect(r.run('app.reloadShellEnv')).toBe(true)
    expect(ran).toBe(1)
  })
})
