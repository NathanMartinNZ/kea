import { describe, expect, it } from 'vitest'
import { createResourceRegistry, resources } from './resources.ts'
import './emitter.ts'
import './runProcess.ts'
import './scope.ts'

describe('resource registry', () => {
  it('U-MEM-16 · counters and gauges appear in the report; disposing a gauge removes its row', () => {
    const reg = createResourceRegistry()
    const terms = reg.counter('ptyhost.mirrors')
    expect(reg.counter('ptyhost.mirrors')).toBe(terms)
    terms.inc()
    terms.inc(2)
    terms.dec()
    let ports = 3
    const g = reg.gauge('core.ports', () => ports)
    reg.gauge('core.caches', () => ({ dir: 1, git: 2 }))
    reg.gauge('core.broken', () => {
      throw new Error('nope')
    })
    ports = 4
    expect(reg.report()).toEqual({ 'core.broken': Number.NaN, 'core.caches': { dir: 1, git: 2 }, 'core.ports': 4, 'ptyhost.mirrors': 2 })
    expect(Object.keys(reg.report())).toEqual(['core.broken', 'core.caches', 'core.ports', 'ptyhost.mirrors'])
    g.dispose()
    expect(reg.names()).not.toContain('core.ports')
    expect(() => reg.gauge('core.caches', () => 0)).toThrow('already registered')
    expect(() => reg.counter('core.caches')).toThrow('already a gauge')
  })

  it("U-MEM-16 · the process-global registry carries kit's own rows", () => {
    const report = resources.report()
    expect(report['kit.children']).toMatchObject({ 'git.active': 0, 'git.queued': 0, 'ports.active': 0, 'other.active': 0 })
    for (const row of ['kit.timers', 'kit.listeners', 'kit.scopes', 'kit.targetListeners']) expect(typeof report[row]).toBe('number')
  })
})
