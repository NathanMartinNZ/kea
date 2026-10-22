import { afterAll, describe, expect, it } from 'vitest'
import { ZOO_PROGRAMS, zooCommand, zooScript } from './index.ts'
import { killAll, zoo } from './test-support.ts'

afterAll(killAll)

describe('process zoo: finding the programs', () => {
  it('U-ZOO-12 · zooCommand gives an argv for every program (Node ones run by node, forker by its binary); each has --help', async () => {
    expect(zooCommand('flood', ['--bytes', '100M'])).toEqual({ file: process.execPath, args: [zooScript('flood'), '--bytes', '100M'] })
    expect(zooCommand('counter', [], { node: '/opt/node' }).file).toBe('/opt/node')
    expect(zooScript('prober')).toMatch(/\/tools\/process-zoo\/src\/prober\.ts$/)
    expect(zooCommand('forker', ['--fork']).args).toEqual(['--fork'])
    expect(() => zooCommand('nope' as 'counter')).toThrow(/unknown zoo program/)
    const helps = ZOO_PROGRAMS.map((name) => ({ name, p: zoo(name, ['--help']) }))
    for (const { name, p } of helps) {
      expect(await p.exited).toEqual({ code: 0, signal: null })
      expect(p.out().startsWith(`${name}: `)).toBe(true)
      expect(p.out()).toContain('usage:')
    }
    const bad = zoo('counter', ['--nope'])
    expect((await bad.exited).code).toBe(2)
    expect(bad.err()).toBe('unknown option --nope\n(see --help)\n')
  })
})
