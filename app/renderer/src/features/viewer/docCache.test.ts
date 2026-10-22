import { describe, expect, it } from 'vitest'
import { DocCache } from './docCache.ts'

describe('the viewer document cache', () => {
  it('U-FV-14 · keeps the most recently viewed documents within its count and byte caps, never one over the byte cap, and hands every dropped one to onDrop', () => {
    const dropped: string[] = []
    const c = new DocCache<{ bytes: number; n: number }>({ maxDocs: 3, maxBytes: 100, onDrop: (k) => dropped.push(k) })
    c.put('a', { bytes: 10, n: 1 })
    c.put('b', { bytes: 20, n: 2 })
    c.put('c', { bytes: 30, n: 3 })
    expect([c.size, c.bytes]).toEqual([3, 60])
    // a fourth pushes the oldest out
    c.put('d', { bytes: 5, n: 4 })
    expect(dropped).toEqual(['a'])
    expect([c.size, c.bytes, c.has('a'), c.has('b')]).toEqual([3, 55, false, true])
    // the byte cap drops as many of the oldest as it takes
    c.put('e', { bytes: 70, n: 5 })
    expect(dropped).toEqual(['a', 'b', 'c'])
    expect([c.size, c.bytes]).toEqual([2, 75])
    // one that is too big on its own is not kept, and what was there stays
    c.put('huge', { bytes: 101, n: 6 })
    expect(dropped.at(-1)).toBe('huge')
    expect([c.size, c.bytes, c.has('huge')]).toEqual([2, 75, false])
    // taking a document out to show it is not a drop; putting it back makes it the newest
    expect(c.take('d')?.n).toBe(4)
    expect([c.size, c.bytes, dropped.length]).toEqual([1, 70, 4])
    expect(c.take('d')).toBeUndefined()
    c.put('d', { bytes: 5, n: 4 })
    c.put('f', { bytes: 5, n: 7 })
    c.put('g', { bytes: 5, n: 8 })
    expect(dropped.at(-1)).toBe('e')
    // the same key again replaces its entry (the old one is dropped, the bytes are the new one's)
    c.put('g', { bytes: 9, n: 9 })
    expect([c.size, c.bytes, dropped.at(-1)]).toEqual([3, 19, 'g'])
    // tabs that closed
    c.prune((k) => k !== 'f')
    expect([c.size, c.has('f'), dropped.at(-1)]).toEqual([2, false, 'f'])
    c.clear()
    expect([c.size, c.bytes]).toEqual([0, 0])
    expect(dropped.slice(-2).sort()).toEqual(['d', 'g'])
    // a cache of nothing keeps nothing
    const none = new DocCache<{ bytes: number }>({ maxDocs: 0, maxBytes: 100 })
    none.put('x', { bytes: 1 })
    expect(none.size).toBe(0)
  })
})
