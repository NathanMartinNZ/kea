import { readFileSync, existsSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { camel, generateAll, genLimitsRs, genLimitsTs, parseBudgets, parseLimits, resolveRef } from './codegen.ts'
import { repoRoot } from './paths.ts'

const root = repoRoot()
const sources = () => ({
  limits: readFileSync(join(root, 'constants/limits.toml'), 'utf8'),
  budgets: readFileSync(join(root, 'constants/budgets.toml'), 'utf8'),
  tokens: readFileSync(join(root, 'constants/tokens.json'), 'utf8'),
})

describe('codegen', () => {
  it('R-LIM-1 · limits.ts, limits.rs, budgets.ts, tokens.css, tokens.ts and the generated themes equal codegen output for constants/', () => {
    const files = generateAll(sources())
    expect(files.map((f) => f.path).sort()).toEqual(
      [
        'native/kea-helper/src/limits.rs',
        'packages/protocol/src/generated/limits.ts',
        'packages/protocol/src/generated/themes.ts',
        'packages/terminal/src/generated/themes.ts',
        'packages/ui/src/generated/syntax-theme.json',
        'packages/ui/src/generated/tokens.css',
        'packages/ui/src/generated/tokens.ts',
        'tools/perf/src/generated/budgets.ts',
      ].sort(),
    )
    const stale = files.filter((f) => {
      const abs = join(root, f.path)
      return !existsSync(abs) || readFileSync(abs, 'utf8') !== f.content
    })
    expect(stale.map((f) => f.path), 'stale generated files — run `pnpm codegen`').toEqual([])
  })

  it('U-LIM-1 · limits: every entry needs a numeric value, unit and why, and nothing else; names are snake_case', () => {
    const ok = parseLimits('[ring_bytes]\nvalue = 4194304\nunit = "bytes"\nwhy = "ring"\n')
    expect(ok).toEqual({ ring_bytes: { value: 4194304, unit: 'bytes', why: 'ring' } })
    expect(camel('holder_flow_high_bytes')).toBe('holderFlowHighBytes')
    expect(() => parseLimits('[RingBytes]\nvalue = 1\nunit = "b"\nwhy = "x"\n')).toThrow(/bad name/)
    expect(() => parseLimits('[a]\nvalue = "1"\nunit = "b"\nwhy = "x"\n')).toThrow(/must be a number/)
    expect(() => parseLimits('[a]\nvalue = 1\nwhy = "x"\n')).toThrow(/needs unit and why/)
    expect(() => parseLimits('[a]\nvalue = nan\nunit = "b"\nwhy = "x"\n')).toThrow(/must be a number/)
    expect(() => parseLimits('[a]\nvalue = 1\nunit = "b"\nowner = "x"\nwhy = "x"\n')).toThrow(/unknown field owner/)
    const ts = genLimitsTs(ok)
    expect(ts).toContain('ringBytes: 4194304,')
    expect(ts).toContain('/** ring (bytes) */')
    expect(ts).toContain('ringBytes: { unit: "bytes", why: "ring" }')
    expect(genLimitsRs({ ...ok, ratio: { value: 0.5, unit: 'x', why: 'r' } })).toMatch(/\/\/\/ ring \(bytes\)\npub const RING_BYTES: u64 = 4194304;[\s\S]*pub const RATIO: f64 = 0.5;/)
  })

  it('U-PLT-2 · a linux or darwin override resolves per system in limits.ts and limits.rs; budgets take the macOS value; an override needs why_linux', () => {
    const entry = (name: string, fields: string) => `[${name}]\n${fields}\nunit = "u"\nwhy = "w"\n`
    const limits = parseLimits(
      entry('a_ms', 'value = 10\nlinux = 20\nwhy_linux = "slower on Linux"') + entry('b_ms', 'value = 1') + entry('c_ratio', 'value = 0.5\ndarwin = 0.25\nwhy_linux = "macOS measured lower"'),
    )
    expect(limits.a_ms).toEqual({ value: 10, linux: 20, whyLinux: 'slower on Linux', unit: 'u', why: 'w' })
    // limits.ts, evaluated as each system's OS layer answers
    const ts = genLimitsTs(limits)
    expect(ts).toContain("import { protocolOs } from '../os/index.ts'")
    const evaluate = (system: 'darwin' | 'linux') => {
      const body = stripTypeScriptTypes(ts).replace(/^import .*$/m, '').replace(/^export /gm, '')
      return new Function('protocolOs', `${body}\nreturn { L, LIMIT_META }`)({ system }) as { L: Record<string, number>; LIMIT_META: Record<string, { whyLinux?: string }> }
    }
    expect(evaluate('linux').L).toEqual({ aMs: 20, bMs: 1, cRatio: 0.5 })
    expect(evaluate('darwin').L).toEqual({ aMs: 10, bMs: 1, cRatio: 0.25 })
    expect(evaluate('darwin').LIMIT_META.aMs!.whyLinux).toBe('slower on Linux')
    expect(evaluate('darwin').LIMIT_META.bMs).not.toHaveProperty('whyLinux')
    // no number differs between systems: limits.ts does not import the OS layer
    expect(genLimitsTs(parseLimits(entry('b_ms', 'value = 1')))).not.toContain('protocolOs')
    // limits.rs: the `os` module that `cfg` picked decides
    const rs = genLimitsRs(limits)
    expect(rs).toContain('pub const A_MS: u64 = if crate::os::IS_LINUX { 20 } else { 10 };')
    expect(rs).toContain('pub const B_MS: u64 = 1;')
    expect(rs).toContain('pub const C_RATIO: f64 = if crate::os::IS_LINUX { 0.5 } else { 0.25 };')
    // perf gates on the macOS reference machine
    const budget = (limit: string) => parseBudgets(`["P-TERM-4"]\nmetric = "m"\nmax_limit = "${limit}"\nunit = "u"\n`, limits)['P-TERM-4']!.max
    expect([budget('a_ms'), budget('c_ratio')]).toEqual([10, 0.25])
    expect(() => parseLimits(entry('a', 'value = 1\nlinux = 2'))).toThrow(/needs why_linux/)
    expect(() => parseLimits(entry('a', 'value = 1\nwhy_linux = "x"'))).toThrow(/explains no linux or darwin value/)
    expect(() => parseLimits(entry('a', 'value = 1\nlinux = 2.5\nwhy_linux = "x"'))).toThrow(/linux must be an integer/)
    expect(() => parseLimits(entry('a', 'value = 1\nlinux = "2"\nwhy_linux = "x"'))).toThrow(/linux must be a number/)
    expect(() => parseLimits(entry('a', 'value = 1\nlinx = 2'))).toThrow(/unknown field linx/)
  })

  it('U-LIM-2 · budgets: `_limit` fields resolve to the named limit; bad ids, unknown limits, missing fields and covers are rejected', () => {
    const limits = parseLimits('[stream_credit_bytes]\nvalue = 262144\nunit = "bytes"\nwhy = "w"\n')
    const b = parseBudgets('["P-TERM-4"]\nmetric = "m"\nmax_limit = "stream_credit_bytes"\nunit = "bytes"\n', limits)
    expect(b['P-TERM-4']).toEqual({ metric: 'm', max: 262144, unit: 'bytes' })
    expect(() => parseBudgets('["P-TERM-4"]\nmetric = "m"\nmax_limit = "nope"\nunit = "b"\n', limits)).toThrow(/unknown limit nope/)
    expect(() => parseBudgets('["X-4"]\nmetric = "m"\nunit = "b"\n', limits)).toThrow(/bad id/)
    expect(() => parseBudgets('["P-TERM-4"]\nunit = "b"\n', limits)).toThrow(/needs metric and unit/)
    expect(() => parseBudgets('["P-TERM-4"]\nmetric = "m"\nunit = "b"\ncovers = ["x"]\n', limits)).toThrow(/covers is not a budget field/)
    expect(Object.keys(parseBudgets(sources().budgets, parseLimits(sources().limits)))).toContain('P-MEM-2b')
  })

  it('U-LIM-3 · token references resolve through the tree; unknown, non-token and cyclic references are rejected', () => {
    const tokens = {
      color: { a: { $value: '#000001' }, b: { $value: '{color.a}' }, loop1: { $value: '{color.loop2}' }, loop2: { $value: '{color.loop1}' } },
      group: { notALeaf: { inner: 1 } },
    }
    expect(resolveRef(tokens, '{color.b}')).toBe('#000001')
    expect(resolveRef(tokens, 'plain')).toBe('plain')
    expect(resolveRef(tokens, 42)).toBe(42)
    expect(() => resolveRef(tokens, '{color.missing}')).toThrow(/unknown reference/)
    expect(() => resolveRef(tokens, '{group.notALeaf}')).toThrow(/not a token/)
    expect(() => resolveRef(tokens, '{color.loop1}')).toThrow(/cycle/)
    // every syntax entry of the real tokens resolves to a colour
    const real = JSON.parse(sources().tokens) as { syntax: Record<string, { $value?: string }> }
    for (const [name, v] of Object.entries(real.syntax)) {
      if (name.startsWith('$')) continue
      expect(String(resolveRef(real, v.$value)), name).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})
