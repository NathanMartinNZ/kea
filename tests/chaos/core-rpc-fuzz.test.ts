// Random payloads from the "renderer" into core's RPC handlers. Payloads are validated where they cross the process
// boundary: everything malformed is rejected with a typed error and changes nothing — not the stores, not the records,
// not one call to ptyhost. Core runs against an in-memory ptyhost listing one attached PTY and one orphan, so every
// handler has something it could wrongly touch.

import fc from 'fast-check'
import { noopLogger } from '@kea/kit'
import { channelPair, coreTerminalApi, ptyhostApi, RpcError, RpcPeer, SimpleStoreRegistry, type PtyInfo } from '@kea/protocol'
import { MemoryRecords, type TerminalRecord } from '@kea/core/src/terminal/records.ts'
import { Terminals } from '@kea/core/src/terminal/terminals.ts'
import { describe, expect, it } from 'vitest'

const holder = (ptyId: string, sessionId: string): PtyInfo => ({
  ptyId,
  sessionId,
  kind: 'shell',
  state: 'running',
  holderPid: 10,
  holderStartedAt: 1,
  childPid: 11,
  cwd: '/tmp',
  argv: ['/bin/zsh', '-l'],
  cols: 80,
  rows: 24,
  exitCode: null,
  exitSignal: null,
  detached: true,
  title: null,
})

const record = (h: PtyInfo): TerminalRecord => ({ ...h, title: null, tabOrder: 0, createdAt: 1, endedAt: null })

/** Valid arguments per method, the seeds that mutations start from. */
const SEEDS: Record<string, Record<string, unknown>> = {
  'terminal.openShell': { cwd: '/tmp', cols: 80, rows: 24 },
  'terminal.close': { ptyId: 'aaaaaaaaaa' },
  'terminal.setVisible': { ptyIds: ['aaaaaaaaaa'] },
  'terminal.restored': {},
  'terminal.clear': { ptyId: 'aaaaaaaaaa' },
  'terminal.adoptOrphan': { ptyId: 'bbbbbbbbbb' },
  'terminal.terminateOrphan': { ptyId: 'bbbbbbbbbb' },
  'terminal.reloadShellEnv': {},
}

const nasty = fc.oneof(
  fc.anything(),
  fc.constantFrom(null, undefined, Number.NaN, -1, 0, 2 ** 53, Infinity, '', '__proto__', '../../etc', 'AAAAAAAAAA', 'aaaaaaaaa', 'aaaaaaaaaaa', [], {}, ['aaaaaaaaaa', 7]),
  fc.string({ maxLength: 4096 }),
)

/** Malformed arguments: a seed with one field replaced, removed or retyped, a whole random value, or junk added. */
const mutated = (seed: Record<string, unknown>): fc.Arbitrary<unknown> => {
  const keys = Object.keys(seed)
  const variants: fc.Arbitrary<unknown>[] = [nasty, fc.constant(null), fc.constant([seed])]
  if (keys.length) {
    variants.push(fc.record({ k: fc.constantFrom(...keys), v: nasty }).map(({ k, v }) => ({ ...seed, [k]: v })))
    variants.push(fc.constantFrom(...keys).map((k) => Object.fromEntries(Object.entries(seed).filter(([x]) => x !== k))))
  }
  return fc.oneof(...variants)
}

function setup() {
  const attached = holder('aaaaaaaaaa', 'shells')
  const orphan = holder('bbbbbbbbbb', 'S2')
  const [coreSide, ptyhostSide] = channelPair()
  const ptyhostCalls: string[] = []
  const ptyhost = new RpcPeer(ptyhostSide, {
    name: 'fake-ptyhost',
    api: ptyhostApi,
    handlers: Object.fromEntries(
      Object.keys(ptyhostApi).map((m) => [
        m,
        async () => {
          if (m === 'pty.list') return [{ ...attached }, { ...orphan }]
          if (!['pty.configure'].includes(m)) ptyhostCalls.push(m)
          return { ok: true }
        },
      ]),
    ) as never,
  })
  const records = new MemoryRecords([record(attached)])
  let envCalls = 0
  const t = new Terminals({
    version: 'test',
    log: noopLogger,
    env: async () => {
      envCalls++
      return {}
    },
    reloadEnv: async () => {
      envCalls++
      return 'fallback'
    },
    records,
  })
  t.setControl(coreSide)
  const stores = new SimpleStoreRegistry()
  stores.add(t.store)
  stores.add(t.orphans)
  const [rendererSide, coreRpcSide] = channelPair()
  const served = new RpcPeer(coreRpcSide, { name: 'core', api: coreTerminalApi, handlers: t.handlers(), stores })
  const renderer = new RpcPeer(rendererSide, { name: 'renderer' })
  const state = () => JSON.stringify({ store: t.store.snapshot(), orphans: t.orphans.snapshot(), records: records.list(), ptyhostCalls, envCalls })
  return {
    t,
    renderer,
    state,
    dispose() {
      renderer.dispose()
      served.dispose()
      t.dispose()
      ptyhost.dispose()
    },
    raw: (m: unknown) => rendererSide.send(m),
  }
}

describe('C-FUZZ-5 · RPC schema validation', () => {
  it('C-FUZZ-5 · malformed calls from the renderer are rejected with typed errors and leave core unchanged (property)', async () => {
    const s = setup()
    expect(await s.renderer.call('terminal.restored' as never, {} as never)).toEqual({ shells: 1, sessions: 0 })
    const before = s.state()
    const methods = [...Object.keys(coreTerminalApi), 'terminal.nope', 'pty.spawn', '__proto__', 'constructor', 'toString', '']
    const gen = fc.constantFrom(...methods).chain((m) => fc.record({ m: fc.constant(m), a: Object.hasOwn(SEEDS, m) ? mutated(SEEDS[m]!) : nasty }))
    await fc.assert(
      fc.asyncProperty(gen, async ({ m, a }) => {
        const def = Object.hasOwn(coreTerminalApi, m) ? (coreTerminalApi as Record<string, { args: { safeParse(v: unknown): { success: boolean } } }>)[m] : undefined
        fc.pre(!def || !def.args.safeParse(a).success) // only malformed calls; valid ones are other tests' business
        const err = await s.renderer.call(m as never, a as never).then(
          () => null,
          (e: unknown) => e,
        )
        expect(err, `${m} ${JSON.stringify(a)?.slice(0, 200)}`).toBeInstanceOf(RpcError)
        expect(['invalid_args', 'unknown_method']).toContain((err as RpcError).code)
        expect(s.state()).toBe(before)
      }),
      { numRuns: 1500 },
    )
    expect(await s.renderer.call('terminal.restored' as never, {} as never), 'core still answers').toEqual({ shells: 1, sessions: 0 })
    s.dispose()
  })

  it('C-FUZZ-5 · well-formed calls naming PTYs core does not hold answer typed errors or ok:false and change nothing', async () => {
    const s = setup()
    await s.renderer.call('terminal.restored' as never, {} as never)
    const before = s.state()
    const unknownId = fc.stringMatching(/^[a-z0-9]{10}$/).filter((id) => id !== 'aaaaaaaaaa' && id !== 'bbbbbbbbbb')
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('terminal.close', 'terminal.clear', 'terminal.adoptOrphan', 'terminal.terminateOrphan'), unknownId, async (m, ptyId) => {
        const r = await s.renderer.call(m as never, { ptyId } as never).then(
          (v) => ({ v }),
          (e: unknown) => ({ code: (e as RpcError).code }),
        )
        expect([{ v: { ok: false } }, { code: 'not_found' }]).toContainEqual(r)
        expect(s.state()).toBe(before)
      }),
      { numRuns: 300 },
    )
    s.dispose()
  })

  it('C-FUZZ-5 · raw garbage on the RPC port (not even messages) is ignored: no crash, no state change', async () => {
    const s = setup()
    await s.renderer.call('terminal.restored' as never, {} as never)
    const before = s.state()
    const msg = fc.oneof(
      fc.anything(),
      fc.record({ k: fc.constantFrom('req', 'res', 'cancel', 'note', 'sub', 'unsub', 'ack', 'snap', 'delta', 'gone', 'x'), id: fc.oneof(fc.integer(), fc.anything()), m: fc.oneof(fc.string(), fc.anything()), a: fc.anything(), store: fc.oneof(fc.constantFrom('terminals', 'terminals.orphans', '__proto__'), fc.string()) }, { requiredKeys: ['k'] }),
    )
    fc.assert(
      fc.property(fc.array(msg, { maxLength: 20 }), (ms) => {
        for (const m of ms) s.raw(m)
      }),
      { numRuns: 300 },
    )
    await new Promise((r) => setImmediate(r))
    expect(s.state()).toBe(before)
    expect(await s.renderer.call('terminal.restored' as never, {} as never), 'core still answers').toEqual({ shells: 1, sessions: 0 })
    s.dispose()
  })
})
