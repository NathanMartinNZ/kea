import { describe, expect, it } from 'vitest'
import { disposeParts } from './dispose.ts'
import { TerminalRegistry } from './registry.ts'

describe('terminal disposal', () => {
  it('U-TERM-23 · a view is released in order: context, WebGL addon, addons, Terminal, observers, port (both ends); then the registry forgets it', () => {
    const log: string[] = []
    const d = (name: string) => ({ dispose: () => log.push(name) })
    const reg = new TerminalRegistry((ptyId) => ({
      ptyId,
      setWebgl: () => {},
      dispose: () =>
        disposeParts({
          loseContext: () => log.push('loseContext'),
          webgl: {
            dispose() {
              log.push('webgl')
              throw new Error('disposing a lost context can throw')
            },
          },
          addons: [d('search'), d('links'), d('unicode11'), d('fit')],
          terminal: d('terminal'),
          observers: [d('resizeObserver'), d('dprQuery'), d('listeners')],
          port: { send: (m) => log.push(`send ${m.k}`), close: () => log.push('port.close') },
        }),
    }))
    reg.activate('a', ['a'])
    reg.close('a')
    expect(log).toEqual(['loseContext', 'webgl', 'search', 'links', 'unicode11', 'fit', 'terminal', 'resizeObserver', 'dprQuery', 'listeners', 'send close', 'port.close'])
    expect(reg.get('a')).toBeUndefined()
    expect(reg.size).toBe(0)
  })

  it('U-TERM-23 · a view without WebGL or a port still releases the rest; errors are reported, never thrown', () => {
    const log: string[] = []
    const errors: string[] = []
    disposeParts(
      {
        loseContext: () => {
          throw new Error('no canvas')
        },
        webgl: null,
        addons: [],
        terminal: { dispose: () => log.push('terminal') },
        observers: [{ dispose: () => log.push('observer') }],
        port: null,
      },
      (step) => errors.push(step),
    )
    expect(log).toEqual(['terminal', 'observer'])
    expect(errors).toEqual(['loseContext'])
  })
})
