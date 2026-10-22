import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { z } from 'zod'
import { channelPair } from './channel.ts'
import { RpcPeer, type Api } from './rpc.ts'
import { L } from './generated/limits.ts'
import { coreTerminalApi, PTY_ID_PATTERN, PTY_ID_RE, ptyhostApi, zPtyId } from './terminal.ts'
import { projectsApi, sessionsApi } from './sessions.ts'
import { worktreesApi } from './worktrees.ts'
import { settingsApi } from './settings.ts'
import { statusApi } from './status.ts'
import { editorApi } from './editor.ts'
import { visibleApi } from './visible.ts'
import { diskApi } from './disk.ts'
import { diagnosticsApi } from './diagnostics.ts'

// Every RPC surface that crosses a process boundary. A new API joins this list when it is defined.
const APIS: Record<string, Api> = { ptyhost: ptyhostApi, coreTerminal: coreTerminalApi, projects: projectsApi, sessions: sessionsApi, worktrees: worktreesApi, settings: settingsApi, status: statusApi, visible: visibleApi, editor: editorApi, disk: diskApi, diagnostics: diagnosticsApi }

type Def = { type: string; checks?: { _zod: { def: Record<string, unknown> } }[]; [k: string]: unknown }
const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def
const checksOf = (d: Def) => (d.checks ?? []).map((c) => c._zod.def)

const I32 = 2 ** 31 - 1
function intIn(lo: number, hi: number): fc.Arbitrary<number> {
  if (lo >= -I32 && hi <= I32) return fc.integer({ min: lo, max: hi })
  return fc.oneof(fc.integer({ min: Math.max(lo, -I32), max: Math.min(hi, I32) }), fc.maxSafeInteger().filter((v) => v >= lo && v <= hi))
}

/**
 * A fast-check arbitrary for the zod shapes the protocol uses. Throws on a shape it does not know, so a new kind of
 * schema fails this test loudly instead of going unchecked.
 */
function arb(schema: z.ZodType): fc.Arbitrary<unknown> {
  const d = defOf(schema)
  const checks = checksOf(d)
  const bound = (name: string, key: string) => checks.find((c) => c.check === name)?.[key] as number | undefined
  switch (d.type) {
    case 'string': {
      const pattern = checks.find((c) => c.check === 'string_format')?.pattern as RegExp | undefined
      const min = bound('min_length', 'minimum') ?? 0
      const max = bound('max_length', 'maximum')
      const base = pattern ? fc.stringMatching(pattern) : fc.string({ minLength: min, maxLength: max ?? 40, unit: 'grapheme' })
      return base.filter((v) => schema.safeParse(v).success)
    }
    case 'number': {
      const isInt = checks.some((c) => c.check === 'number_format' && c.format === 'safeint')
      const gt = checks.find((c) => c.check === 'greater_than')
      const lt = checks.find((c) => c.check === 'less_than')
      if (isInt) return intIn((gt?.value as number) ?? Number.MIN_SAFE_INTEGER, (lt?.value as number) ?? Number.MAX_SAFE_INTEGER)
      return fc.double({ noNaN: true, noDefaultInfinity: true, min: gt?.value as number | undefined, max: lt?.value as number | undefined }).filter((v) => schema.safeParse(v).success)
    }
    case 'boolean':
      return fc.boolean()
    case 'enum':
      return fc.constantFrom(...Object.values(d.entries as Record<string, string>))
    case 'literal':
      return fc.constantFrom(...(d.values as unknown[]))
    case 'nullable':
      return fc.option(arb(d.innerType as z.ZodType), { nil: null })
    case 'array': {
      const len = bound('length_equals', 'length')
      const min = len ?? bound('min_length', 'minimum') ?? 0
      const max = len ?? Math.min(bound('max_length', 'maximum') ?? 5, 5)
      return fc.array(arb(d.element as z.ZodType), { minLength: min, maxLength: Math.max(min, max) })
    }
    case 'record':
      return fc.dictionary(arb(d.keyType as z.ZodType) as fc.Arbitrary<string>, arb(d.valueType as z.ZodType), { maxKeys: 5 })
    case 'object': {
      const shape = d.shape as Record<string, z.ZodType>
      const model: Record<string, fc.Arbitrary<unknown>> = {}
      const required: string[] = []
      for (const [k, v] of Object.entries(shape)) {
        const vd = defOf(v)
        if (vd.type === 'optional') model[k] = arb(vd.innerType as z.ZodType)
        else {
          model[k] = arb(v)
          required.push(k)
        }
      }
      const record = fc.record(model, { requiredKeys: required })
      // an object's own refinements (`.refine`: a rule across its fields, as zPlatformReport's "no line twice") are kept
      // by filtering, as a string's and a number's checks are
      return checks.length ? record.filter((v) => schema.safeParse(v).success) : record
    }
    case 'unknown':
      return fc.jsonValue()
    case 'custom':
      // z.instanceof: the protocol only uses it for byte arrays.
      if (schema.safeParse(new Uint8Array(0)).success) return fc.uint8Array({ maxLength: 64 })
  }
  throw new Error(`no arbitrary for zod type ${d.type}`)
}

const methods = Object.entries(APIS).flatMap(([api, a]) => Object.keys(a).map((m) => ({ api, m, def: a[m]! })))

describe('protocol schemas', () => {
  it('U-RPC-1 · every method’s args and result survive the RPC round trip unchanged (property)', async () => {
    for (const [name, api] of Object.entries(APIS)) {
      const [a, b] = channelPair()
      let next: unknown
      let got: unknown
      const handlers = Object.fromEntries(
        Object.keys(api).map((m) => [
          m,
          (args: unknown) => {
            got = args
            return next
          },
        ]),
      )
      const server = new RpcPeer(a, { name: `${name}-server`, api, handlers: handlers as never })
      const client = new RpcPeer(b, { name: `${name}-client`, validateResults: true }, api)
      const entries = methods.filter((x) => x.api === name)
      const gen = fc.oneof(...entries.map((e) => fc.record({ m: fc.constant(e.m), args: arb(e.def.args), result: e.def.result ? arb(e.def.result) : fc.constant(undefined) })))
      await fc.assert(
        fc.asyncProperty(gen, async ({ m, args, result }) => {
          next = result
          got = undefined
          const r = await (client.call as (m: string, a: unknown) => Promise<unknown>)(m, args)
          expect(got).toEqual(args)
          expect(r).toEqual(result)
        }),
        { numRuns: 400 },
      )
      client.dispose()
      server.dispose()
    }
  })

  it('U-RPC-1 · every schema value is a parse fixed point: parse(structuredClone(v)) equals v (property)', () => {
    for (const { api, m, def } of methods) {
      for (const [side, s] of [['args', def.args], ['result', def.result]] as const) {
        if (!s) continue
        fc.assert(
          fc.property(arb(s), (v) => {
            const r = s.safeParse(structuredClone(v))
            expect(r.success, `${api}.${m} ${side}`).toBe(true)
            expect(r.data).toEqual(v)
          }),
          { numRuns: 100 },
        )
      }
    }
  })
})

describe('ptyId patterns', () => {
  it('U-HLD-5 · every ptyId pattern takes its length from L.ptyIdLength: exactly that many of [a-z0-9], also inside a file name', () => {
    const id = 'a0'.repeat(L.ptyIdLength).slice(0, L.ptyIdLength)
    expect(zPtyId.safeParse(id).success).toBe(true)
    for (const bad of [id.slice(1), `${id}a`, id.toUpperCase(), `${id.slice(1)}-`]) expect(zPtyId.safeParse(bad).success, bad).toBe(false)
    expect(PTY_ID_RE.source).toBe(`^${PTY_ID_PATTERN}$`)
    const sock = new RegExp(`^(${PTY_ID_PATTERN})\\.sock$`)
    expect(sock.exec(`${id}.sock`)?.[1]).toBe(id)
    expect(sock.test(`${id}a.sock`)).toBe(false)
  })
})
