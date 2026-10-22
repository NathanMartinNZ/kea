import { describe, expect, it } from 'vitest'
import { isResourceReport } from '@kea/protocol'
import { readGauges, type Gauge } from './rows.ts'

describe('renderer resource rows', () => {
  it('U-MEM-19 · a renderer gauge that throws gives NaN for its own rows only; the report is still whole, dotted under `renderer.`, and passes main’s checks', () => {
    const failed: string[][] = []
    const gauges: Gauge[] = [
      { rows: ['terminals', 'webglContexts'], read: () => ({ terminals: 3, webglContexts: 2 }) },
      {
        rows: ['atlasBytes', 'atlasPages'],
        read: () => {
          throw new Error('atlas gone')
        },
      },
      { rows: ['commandHandlers'], read: () => ({ commandHandlers: 12 }) },
      { rows: ['storeSubscriptions'], read: () => ({}) }, // a row its gauge forgot: NaN, not missing
    ]
    const r = readGauges(gauges, (rows) => failed.push([...rows]))
    expect(r).toEqual({
      'renderer.terminals': 3,
      'renderer.webglContexts': 2,
      'renderer.atlasBytes': Number.NaN,
      'renderer.atlasPages': Number.NaN,
      'renderer.commandHandlers': 12,
      'renderer.storeSubscriptions': Number.NaN,
    })
    expect(failed).toEqual([['atlasBytes', 'atlasPages']])
    expect(isResourceReport(r), 'NaN is a valid value where the report crosses to main').toBe(true)
    // a row a gauge reports beyond its declared ones is kept
    expect(readGauges([{ rows: ['a'], read: () => ({ a: 1, b: 2 }) }])).toEqual({ 'renderer.a': 1, 'renderer.b': 2 })
  })
})
