import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { cutChars, isCritical, projectPayload, type Projection } from './projection.ts'

describe('kit/projection', () => {
  it('U-AGT-57 · countWhere counts matching array elements without leaking strings', () => {
    const p: Projection = {
      keep: ['id'],
      count: ['total'],
      countWhere: [
        { path: 'workers', field: 'state', equals: 'running' },
        { path: 'nested.tasks', field: 'meta.done', equals: true },
        { path: 'cleared', field: 'val', equals: null },
        { path: 'missing', field: 'state', equals: 'running' },
        { path: 'notArray', field: 'state', equals: 'running' },
      ],
      summarise: [],
    }
    const payload = {
      id: 's-1',
      total: [1, 2, 3],
      workers: [
        { name: 'secret-alpha', role: 'helper', state: 'running' },
        { name: 'secret-beta', role: 'verifier', state: 'completed' },
        { name: 'secret-gamma', role: 'worker', state: 'running' },
        'not-an-object',
        null,
      ],
      nested: {
        tasks: [{ meta: { done: true } }, { meta: { done: false } }, {}],
      },
      cleared: [{ val: null }, { val: 'x' }, {}],
      notArray: { state: 'running' },
    }
    const out = projectPayload(payload, p)
    expect(out).toEqual({
      id: 's-1',
      total: 3,
      workers: 2,
      nested: { tasks: 1 },
      cleared: 1,
    })
    expect(JSON.stringify(out)).not.toContain('secret-')
  })

  it('U-AGT-57 · keepMap copies scalar subfields in deterministic sorted key order and clamps maxKeys', () => {
    const longKey = `k-${'x'.repeat(L.hookSummaryMaxChars + 25)}`
    const longVal = `v-${'🦜'.repeat(L.hookSummaryMaxChars + 25)}`
    const p: Projection = {
      keep: [],
      count: [],
      keepMap: [
        {
          path: 'buckets',
          fields: ['left', 'reset', 'secs', 'disabled', 'nested.flag'],
          maxKeys: 3,
        },
        {
          path: 'emptyOut',
          fields: ['onlyScalar'],
        },
      ],
      summarise: [],
    }
    const payload = {
      buckets: {
        'z-bucket': { left: 0.1, reset: '2026-11-20T22:00:00Z', secs: 7200, disabled: false },
        'b-bucket': {
          left: 0.75,
          reset: longVal,
          secs: 3600,
          disabled: false,
          ignored: 'secret',
          nonScalar: { deep: 1 },
          nested: { flag: true, arr: [1, 2] },
        },
        'a-empty': { nonScalar: [1, 2, 3], unknown: 'ignored' },
        'a-not-object': 'scalar',
        [longKey]: { left: 0, disabled: true },
        'm-bucket': { left: 0.5, secs: 1800 },
      },
      emptyOut: {
        first: { onlyScalar: { nope: 1 } },
        second: null,
      },
    }
    const out = projectPayload(payload, p)
    const buckets = out.buckets as Record<string, unknown>
    expect(Object.keys(buckets)).toEqual(['b-bucket', cutChars(longKey), 'm-bucket'])
    expect(buckets['b-bucket']).toEqual({
      left: 0.75,
      reset: cutChars(longVal),
      secs: 3600,
      disabled: false,
      nested: { flag: true },
    })
    expect(buckets[cutChars(longKey)]).toEqual({ left: 0, disabled: true })
    expect(buckets['m-bucket']).toEqual({ left: 0.5, secs: 1800 })
    expect(out.emptyOut).toBeUndefined()

    // Clamping to L.projectionMapKeysMax when maxKeys is omitted or exceeds the hard limit.
    const many: Record<string, unknown> = {}
    for (let i = 0; i < L.projectionMapKeysMax + 8; i++) {
      many[`k-${String(i).padStart(2, '0')}`] = { left: i }
    }
    const clamped = projectPayload(
      { buckets: many },
      {
        keep: [],
        count: [],
        keepMap: [{ path: 'buckets', fields: ['left'], maxKeys: L.projectionMapKeysMax + 50 }],
        summarise: [],
      },
    )
    const clampedKeys = Object.keys(clamped.buckets as Record<string, unknown>)
    expect(clampedKeys.length).toBe(L.projectionMapKeysMax)
    expect(clampedKeys[0]).toBe('k-00')
    expect(clampedKeys.at(-1)).toBe(`k-${String(L.projectionMapKeysMax - 1).padStart(2, '0')}`)
  })

  it('U-AGT-57 · isCritical supports single-object, multi-rule array and absent critical rules', () => {
    const single: Projection = {
      keep: ['event'],
      count: [],
      summarise: [],
      critical: { field: 'event', values: ['Stop', 'Start'] },
    }
    expect(isCritical({ event: 'Stop' }, single)).toBe(true)
    expect(isCritical({ event: 'PreTool' }, single)).toBe(false)
    expect(isCritical({}, single)).toBe(false)

    const multi: Projection = {
      keep: ['phase', 'awaiting'],
      count: [],
      summarise: [],
      critical: [
        { field: 'phase', values: ['idle', 'review', 'auth', 'failed'] },
        { field: 'awaiting', values: [true] },
      ],
    }
    expect(isCritical({ phase: 'working', awaiting: false }, multi)).toBe(false)
    expect(isCritical({ phase: 'working', awaiting: true }, multi)).toBe(true)
    expect(isCritical({ phase: 'idle', awaiting: false }, multi)).toBe(true)
    expect(isCritical({ phase: 'review' }, multi)).toBe(true)
    expect(isCritical({}, multi)).toBe(false)
    expect(isCritical({ phase: 'idle' }, { keep: [], count: [], summarise: [] })).toBe(false)
    expect(isCritical({ phase: 'idle' }, { keep: [], count: [], summarise: [], critical: null })).toBe(false)
  })

  it('U-AGT-57 · matches R-AGT-5 golden feed projection output byte-for-byte', () => {
    const p: Projection = {
      keep: ['conv', 'phase', 'awaiting', 'mode', 'model.id', 'model.effort', 'context.pct', 'cost.usd'],
      count: [],
      countWhere: [{ path: 'workers', field: 'state', equals: 'running' }],
      keepMap: [{ path: 'buckets', fields: ['left', 'reset', 'secs', 'disabled'], maxKeys: L.projectionMapKeysMax }],
      summarise: ['title'],
      critical: [
        { field: 'phase', values: ['idle', 'review', 'auth', 'failed'] },
        { field: 'awaiting', values: [true] },
      ],
    }
    const input = {
      conv: 'c-42',
      phase: 'working',
      awaiting: true,
      mode: 'auto',
      model: { id: 'Model X', effort: 'high', display: 'ignored' },
      context: { pct: 37.5, tokens: 99999 },
      cost: { usd: 0.12, sub: 0.04 },
      title: 'Fix projection parity',
      email: 'user@example.com',
      cwd: '/private/dir',
      workers: [
        { name: 'w1', role: 'r1', state: 'running' },
        { name: 'w2', role: 'r2', state: 'done' },
      ],
      buckets: {
        'b-week': { left: 0.8, reset: '2026-11-27T00:00:00Z', secs: 604800, extra: 'drop' },
        'b-5h': { left: 0.25, reset: '2026-11-20T19:00:00Z', secs: 18000, disabled: false },
      },
    }
    expect(projectPayload(input, p)).toEqual({
      conv: 'c-42',
      phase: 'working',
      awaiting: true,
      mode: 'auto',
      model: { id: 'Model X', effort: 'high' },
      context: { pct: 37.5 },
      cost: { usd: 0.12 },
      workers: 1,
      buckets: {
        'b-5h': { left: 0.25, reset: '2026-11-20T19:00:00Z', secs: 18000, disabled: false },
        'b-week': { left: 0.8, reset: '2026-11-27T00:00:00Z', secs: 604800 },
      },
      title: 'Fix projection parity',
    })
    expect(isCritical(input, p)).toBe(true)
  })
})
