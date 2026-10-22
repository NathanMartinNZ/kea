import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { z } from 'zod'
import { channelPair } from './channel.ts'
import { L } from './generated/limits.ts'
import { defineApi, RpcError, RpcPeer } from './rpc.ts'
import { applyDelta, KeyedStore, mergeDelta, SimpleStoreRegistry, type Delta } from './store.ts'

const api = defineApi({
  'math.add': { args: z.object({ a: z.number(), b: z.number() }), result: z.number() },
  'slow.wait': { args: z.object({ ms: z.number() }), result: z.literal('done') },
})

function pair(stores?: SimpleStoreRegistry) {
  const [a, b] = channelPair()
  let aborted = 0
  const server = new RpcPeer(a, {
    name: 'server',
    api,
    stores,
    handlers: {
      'math.add': ({ a, b }) => a + b,
      'slow.wait': ({ ms }, ctx) =>
        new Promise<'done'>((resolve) => {
          const t = setTimeout(() => resolve('done'), ms)
          ctx.signal.addEventListener('abort', () => {
            aborted++
            clearTimeout(t)
          })
        }),
    },
  })
  const client = new RpcPeer(b, { name: 'client', validateResults: true }, api)
  return { server, client, aborted: () => aborted }
}

// Fake timers throughout: messages travel on microtasks, store deltas on the store tick. `settle` runs both until
// nothing is left to deliver; no test waits on the wall clock.
const settle = async (ticks = 4) => {
  for (let i = 0; i < ticks; i++) await vi.advanceTimersByTimeAsync(L.storeTickMs)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('rpc', () => {
  it('U-RPC-1 · calls validate args on the receiving side and return results', async () => {
    const { client } = pair()
    await expect(client.call('math.add', { a: 2, b: 3 })).resolves.toBe(5)
    await expect(client.call('math.add', { a: 2, b: 'x' } as never)).rejects.toMatchObject({ code: 'invalid_args' })
    await expect(client.call('nope' as never, {} as never)).rejects.toMatchObject({ code: 'unknown_method' })
  })

  it('U-RPC-1 · a method named after an Object.prototype member is unknown, not a hang (found by C-FUZZ-5)', async () => {
    const { client } = pair()
    for (const m of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const rejected = expect(client.call(m as never, {} as never), m).rejects.toMatchObject({ code: 'unknown_method' })
      await settle(1)
      await rejected
    }
  })

  it('U-RPC-1 · cancellation reaches the handler and rejects the caller', async () => {
    const { client, server, aborted } = pair()
    const ac = new AbortController()
    const p = client.call('slow.wait', { ms: 10_000 }, { signal: ac.signal })
    const rejected = expect(p).rejects.toBeInstanceOf(RpcError)
    await settle(1)
    expect(server.stats.servingCalls).toBe(1)
    ac.abort()
    await rejected
    await settle(1)
    expect(aborted()).toBe(1)
    expect(server.stats.servingCalls).toBe(0)
  })

  it('U-RPC-1 · disposing a connection drops every call and subscription on both ends', async () => {
    const stores = new SimpleStoreRegistry()
    stores.add(new KeyedStore<number>('nums'))
    const { client, server } = pair(stores)
    client.subscribe('nums', () => {})
    const p = client.call('slow.wait', { ms: 10_000 })
    const rejected = expect(p).rejects.toMatchObject({ code: 'closed' })
    await settle(1)
    expect(server.stats).toMatchObject({ servedSubs: 1, servingCalls: 1 })
    client.dispose()
    await rejected
    await settle(1)
    expect(server.isDisposed).toBe(true)
    expect(server.stats).toEqual({ pendingCalls: 0, servingCalls: 0, servedSubs: 0, clientSubs: 0, pendingDeltas: 0 })
    expect(stores.get('nums')!.listenerCount).toBe(0)
  })
})

describe('stores', () => {
  const arbDelta = fc.record({
    set: fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd', 'e'), fc.integer(), { maxKeys: 5 }),
    del: fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 3 }),
  }) as fc.Arbitrary<Delta<number>>

  it('U-MEM-3 · a merged pending delta equals sequential application', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd', 'e'), fc.integer()), fc.array(arbDelta, { maxLength: 8 }), (start, deltas) => {
        const seq = new Map(Object.entries(start))
        for (const d of deltas) {
          // a delta's own del applies before its set (applyDelta order); normalise the generator to that meaning
          applyDelta(seq, d)
        }
        const merged = deltas.reduce<Delta<number>>((acc, d) => mergeDelta(acc, mergeDelta({ del: d.del }, { set: d.set })), {})
        const once = new Map(Object.entries(start))
        applyDelta(once, merged)
        expect(Object.fromEntries(once)).toEqual(Object.fromEntries(seq))
      }),
    )
  })

  it('U-RPC-1 · a subscriber’s copy equals the producer’s snapshot after any mutation sequence (property)', async () => {
    const op = fc.record({ k: fc.constantFrom('a', 'b', 'c', 'd'), v: fc.option(fc.integer()), wait: fc.constantFrom(0, 0, 0, 1, L.storeTickMs) })
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 60 }), async (ops) => {
        const stores = new SimpleStoreRegistry()
        const store = stores.add(new KeyedStore<number>('nums'))
        const { client, server } = pair(stores)
        const view = client.subscribe<number>('nums', () => {})
        await settle(1)
        expect(view.ready).toBe(true)
        for (const { k, v, wait } of ops) {
          if (v === null) store.delete(k)
          else store.set(k, v)
          if (wait) await vi.advanceTimersByTimeAsync(wait)
        }
        await settle()
        expect(Object.fromEntries([...view.data].sort())).toEqual(Object.fromEntries(Object.entries(store.snapshot()).sort()))
        client.dispose()
        server.dispose()
      }),
      { numRuns: 100 },
    )
  })

  it('U-MEM-3 · at most one unacknowledged delta per subscription; later changes merge into it', async () => {
    {
      const stores = new SimpleStoreRegistry()
      const store = stores.add(new KeyedStore<number>('nums'))
      const [a, b] = channelPair()
      new RpcPeer(a, { name: 'server', stores })
      const sent: { k: string }[] = []
      // A "frozen renderer": records messages but never acks.
      b.onMessage((m) => sent.push(m as { k: string }))
      b.send({ k: 'sub', id: 1, store: 'nums' })
      await vi.advanceTimersByTimeAsync(1)
      expect(sent.filter((m) => m.k === 'snap')).toHaveLength(1)
      for (let i = 0; i < 1000; i++) {
        store.set(`k${i % 10}`, i)
        await vi.advanceTimersByTimeAsync(5)
      }
      // snapshot not acked → no delta sent at all, regardless of 1000 changes
      expect(sent.filter((m) => m.k === 'delta')).toHaveLength(0)
      b.send({ k: 'ack', id: 1, rev: 1 })
      await vi.advanceTimersByTimeAsync(50)
      const deltas = sent.filter((m) => m.k === 'delta') as unknown as { d: Delta<number> }[]
      expect(deltas).toHaveLength(1)
      expect(Object.keys(deltas[0]!.d.set!)).toHaveLength(10)
    }
  })

  it('U-RPC-1 · removing a session store tells its subscribers it is gone', async () => {
    const stores = new SimpleStoreRegistry()
    stores.add(new KeyedStore<number>('tree:s1'))
    const { client, server } = pair(stores)
    let gone = false
    client.subscribe('tree:s1', () => {}, () => (gone = true))
    await settle(1)
    expect(server.stats.servedSubs).toBe(1)
    stores.remove('tree:s1')
    await settle(1)
    expect(gone).toBe(true)
    expect(client.stats.clientSubs).toBe(0)
    expect(server.stats.servedSubs).toBe(0)
  })
})
