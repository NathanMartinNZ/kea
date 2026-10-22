// The viewer's document cache: the few documents most recently viewed, kept so that a flip back to their tab
// shows them at once (the file is still read again, and what changed is applied as a reload). Capped by count and by
// bytes; the oldest goes first, and a document that is over the byte cap on its own is never kept. Whatever leaves is
// handed to `onDrop` (the highlight worker forgets its marks). Plain objects in a plain registry; nothing here
// knows what a document is beyond its size.

export interface Sized {
  /** What the entry holds: the file's bytes plus its tokens'. */
  bytes: number
}

export interface DocCacheOptions<V> {
  maxDocs: number
  maxBytes: number
  onDrop?(key: string, value: V): void
}

export class DocCache<V extends Sized> {
  // bounded: L.viewerDocCache documents and L.viewerDocCacheBytes bytes
  private readonly map = new Map<string, V>()
  private readonly o: DocCacheOptions<V>
  private total = 0

  constructor(o: DocCacheOptions<V>) {
    this.o = o
  }

  get size(): number {
    return this.map.size
  }

  get bytes(): number {
    return this.total
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  /** Keep `value` as the most recently viewed; whatever no longer fits is dropped, oldest first. */
  put(key: string, value: V): void {
    this.drop(key)
    if (value.bytes > this.o.maxBytes || this.o.maxDocs < 1) {
      this.o.onDrop?.(key, value)
      return
    }
    this.map.set(key, value)
    this.total += value.bytes
    while (this.map.size > this.o.maxDocs || this.total > this.o.maxBytes) {
      const oldest = this.map.keys().next().value as string
      this.drop(oldest)
    }
  }

  /** Take a document out to show it (it is put back when its tab is hidden again). */
  take(key: string): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.total -= v.bytes
    return v
  }

  drop(key: string): void {
    const v = this.take(key)
    if (v !== undefined) this.o.onDrop?.(key, v)
  }

  /** Drop every entry `keep` does not vouch for (tabs that closed). */
  prune(keep: (key: string) => boolean): void {
    for (const key of [...this.map.keys()]) if (!keep(key)) this.drop(key)
  }

  clear(): void {
    for (const key of [...this.map.keys()]) this.drop(key)
  }
}
