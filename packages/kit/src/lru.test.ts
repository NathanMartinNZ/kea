import { L } from '@kea/protocol/limits'
import { describe, expect, it, vi } from 'vitest'
import { BoundedQueue, LruCache } from './lru.ts'
import type { EvictReason } from './lru.ts'

describe('LruCache', () => {
  it('U-FT-6 · entry cap: the least recently used entry is evicted first; get refreshes, peek does not', () => {
    const evicted: Array<[string, number, EvictReason]> = []
    const cache = new LruCache<string, number>({ maxEntries: L.fileCacheSessions, onEvict: (k, v, r) => evicted.push([k, v, r]) })
    const keys = Array.from({ length: L.fileCacheSessions }, (_, i) => `s${i}`)
    keys.forEach((k, i) => cache.set(k, i))
    expect(cache.keys()).toEqual([...keys].reverse())

    cache.get('s0') // s0 is now most recent; s1 is the oldest
    cache.peek('s1') // peek does not refresh
    expect(cache.has('s1')).toBe(true)
    cache.set('new', 99)
    expect(cache.size).toBe(L.fileCacheSessions)
    expect(cache.has('s1')).toBe(false)
    expect(evicted).toEqual([['s1', 1, 'capacity']])
    expect(cache.keys()[0]).toBe('new')
    expect(cache.keys()[1]).toBe('s0')
  })

  it('U-FT-6 · byte cap: evicts oldest entries until the sum fits; an oversize value is refused', () => {
    const evicted: Array<[string, EvictReason]> = []
    const cap = L.viewerDocCacheBytes
    const cache = new LruCache<string, Uint8Array>({
      maxEntries: L.viewerDocCache * 10,
      maxBytes: cap,
      sizeOf: (v) => v.byteLength,
      onEvict: (k, _v, r) => evicted.push([k, r]),
    })
    const quarter = cap / 4
    for (const k of ['a', 'b', 'c', 'd']) cache.set(k, new Uint8Array(quarter))
    expect(cache.bytes).toBe(cap)
    cache.get('a')
    cache.set('e', new Uint8Array(quarter + 1)) // needs two evictions: b, then c
    expect(evicted).toEqual([
      ['b', 'bytes'],
      ['c', 'bytes'],
    ])
    expect(cache.keys()).toEqual(['e', 'a', 'd'])
    expect(cache.bytes).toBe(quarter * 2 + quarter + 1)
    expect(cache.bytes).toBeLessThanOrEqual(cap)

    expect(cache.set('huge', new Uint8Array(cap + 1))).toBe(false)
    expect(cache.has('huge')).toBe(false)
    expect(evicted.at(-1)).toEqual(['huge', 'too-large'])
    expect(() => new LruCache({ maxEntries: 1, maxBytes: 10 })).toThrow('sizeOf')
  })

  it('U-FT-6 · session removal purges its entries (deleteWhere); overwrite and clear report to onEvict', () => {
    const onEvict = vi.fn()
    const cache = new LruCache<string, string>({ maxEntries: L.dirCacheEntriesMax, onEvict })
    cache.set('s1:/', 'root')
    cache.set('s1:/src', 'src')
    cache.set('s2:/', 'root2')
    expect(cache.deleteWhere((k) => k.startsWith('s1:'))).toBe(2)
    expect(cache.keys()).toEqual(['s2:/'])
    expect(onEvict).toHaveBeenCalledWith('s1:/', 'root', 'deleted')
    cache.set('s2:/', 'root2b')
    expect(onEvict).toHaveBeenLastCalledWith('s2:/', 'root2', 'replaced')
    cache.set('s2:/', 'root2b') // same value: not reported
    expect(onEvict).toHaveBeenCalledTimes(3)
    cache.clear()
    expect(onEvict).toHaveBeenLastCalledWith('s2:/', 'root2b', 'cleared')
    expect(cache.size).toBe(0)
    expect(cache.delete('missing')).toBe(false)
  })
})

describe('BoundedQueue', () => {
  it('U-MEM-14 · drop-oldest keeps the newest `cap` items and counts drops', () => {
    const dropped: number[] = []
    const cap = L.watchChunk
    const q = new BoundedQueue<number>({ cap, overflow: 'drop-oldest', onDrop: (v) => dropped.push(v) })
    for (let i = 0; i < cap + 3; i++) expect(q.push(i)).toBe(true)
    expect(q.length).toBe(cap)
    expect(q.dropped).toBe(3)
    expect(dropped).toEqual([0, 1, 2])
    expect(q.peek()).toBe(3)
    const all = q.drain()
    expect(all[0]).toBe(3)
    expect(all.at(-1)).toBe(cap + 2)
    expect(all).toHaveLength(cap)
    expect(q.length).toBe(0)
  })

  it('U-MEM-14 · reject refuses items when full and keeps FIFO order across wrap-around', () => {
    const q = new BoundedQueue<string>({ cap: 3, overflow: 'reject' })
    expect(q.push('a')).toBe(true)
    expect(q.push('b')).toBe(true)
    expect(q.shift()).toBe('a')
    expect(q.push('c')).toBe(true)
    expect(q.push('d')).toBe(true)
    expect(q.isFull).toBe(true)
    expect(q.push('e')).toBe(false)
    expect(q.dropped).toBe(1)
    expect([...q]).toEqual(['b', 'c', 'd'])
    expect(q.drain()).toEqual(['b', 'c', 'd'])
    expect(q.shift()).toBeUndefined()
  })
})
