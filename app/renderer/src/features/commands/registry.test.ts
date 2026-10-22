import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from './registry.ts'

describe('command registry', () => {
  it('U-KB-2 · handlers bind to table ids only, once each; when / unavailableReason decide availability', () => {
    const r = new CommandRegistry()
    expect(() => r.register('not.a.command', { run() {} })).toThrow(/command table/)
    let enabled = false
    const run = vi.fn()
    const d = r.register('terminal.find', { run, when: () => enabled, unavailableReason: () => 'No terminal' })
    expect(() => r.register('terminal.find', { run() {} })).toThrow(/already/)
    expect(r.has('terminal.find')).toBe(true)
    expect(r.available('terminal.find')).toBe(false)
    expect(r.reason('terminal.find')).toBe('No terminal')
    expect(r.run('terminal.find')).toBe(false)
    expect(run).not.toHaveBeenCalled()
    enabled = true
    expect(r.reason('terminal.find')).toBeUndefined()
    expect(r.run('terminal.find', { x: 1 })).toBe(true)
    expect(run).toHaveBeenCalledWith({ x: 1 })
    // a table command nobody has built yet is listed with a reason, never run
    expect(r.has('session.new')).toBe(false)
    expect(r.reason('session.new')).toBe('Not available yet')
    expect(r.run('session.new')).toBe(false)
    d.dispose()
    expect(r.has('terminal.find')).toBe(false)
  })

  it('U-KB-2 · the menu state lists registered commands with their availability; changes notify listeners', () => {
    const r = new CommandRegistry()
    const seen: number[] = []
    const off = r.onChange(() => seen.push(r.menuState().commands.length))
    const a = r.register('terminal.newShell', { run() {} })
    r.register('terminal.closeTab', { run() {}, when: () => false })
    expect(r.menuState()).toEqual({
      commands: [
        { id: 'terminal.newShell', enabled: true },
        { id: 'terminal.closeTab', enabled: false },
      ],
    })
    a.dispose()
    off()
    r.changed()
    expect(seen).toEqual([1, 2, 1])
  })

  it('U-KB-2 · a failing handler or a throwing `when` never escapes', async () => {
    const r = new CommandRegistry()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    r.register('terminal.clear', {
      run() {
        throw new Error('boom')
      },
    })
    r.register('terminal.find', { run: () => Promise.reject(new Error('later')) })
    r.register('terminal.copy', {
      run() {},
      when() {
        throw new Error('bad when')
      },
    })
    expect(r.run('terminal.clear')).toBe(true)
    expect(r.run('terminal.find')).toBe(true)
    expect(r.available('terminal.copy')).toBe(false)
    await Promise.resolve()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
