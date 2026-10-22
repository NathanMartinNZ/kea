// Bounded collections. Every cache and queue that outlives a function call is built from these, with its cap taken
// from constants/ and a `bounded:` comment naming its cap.

export type EvictReason = 'capacity' | 'bytes' | 'too-large' | 'replaced' | 'deleted' | 'cleared'

export interface LruOptions<K, V> {
  /** Entry cap (≥ 1). */
  maxEntries: number
  /** Optional byte cap; requires `sizeOf`. */
  maxBytes?: number
  /** Size of one entry in bytes (called once, on `set`). */
  sizeOf?: (value: V, key: K) => number
  /**
   * Called for every value that leaves the cache other than through `clearAndLeak`: evictions
   * (`capacity`, `bytes`), a rejected oversize value (`too-large`), overwrites (`replaced`),
   * `delete`/`deleteWhere` (`deleted`) and `clear` (`cleared`) — so an owner can dispose values.
   */
  onEvict?: (key: K, value: V, reason: EvictReason) => void
}

interface Slot<V> {
  value: V
  size: number
}

/**
 * Least-recently-used cache with an entry cap and an optional byte cap. `get` refreshes recency;
 * `peek` and `has` do not. Eviction removes the least recently used entries first.
 */
export class LruCache<K, V> {
  // bounded: by maxEntries / maxBytes — the caller's own `bounded:` comment names the cap
  private readonly map = new Map<K, Slot<V>>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly sizeOf: ((value: V, key: K) => number) | undefined
  private readonly onEvict: ((key: K, value: V, reason: EvictReason) => void) | undefined
  private totalBytes = 0

  constructor(opts: LruOptions<K, V>) {
    if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1) throw new RangeError('LruCache: maxEntries must be an integer ≥ 1')
    if (opts.maxBytes !== undefined) {
      if (!(opts.maxBytes > 0)) throw new RangeError('LruCache: maxBytes must be > 0')
      if (!opts.sizeOf) throw new TypeError('LruCache: maxBytes needs sizeOf')
    }
    this.maxEntries = opts.maxEntries
    this.maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY
    this.sizeOf = opts.sizeOf
    this.onEvict = opts.onEvict
  }

  get size(): number {
    return this.map.size
  }

  /** Sum of `sizeOf` over the entries (0 without `sizeOf`). */
  get bytes(): number {
    return this.totalBytes
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  /** The value, marking the entry most recently used. */
  get(key: K): V | undefined {
    const slot = this.map.get(key)
    if (!slot) return undefined
    this.map.delete(key)
    this.map.set(key, slot)
    return slot.value
  }

  /** The value, without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value
  }

  /**
   * Insert or overwrite (the entry becomes most recently used), then evict least recently used
   * entries until both caps hold. Returns false — and stores nothing — when the value alone is
   * larger than `maxBytes`.
   */
  set(key: K, value: V): boolean {
    const size = this.sizeOf ? this.sizeOf(value, key) : 0
    const prev = this.map.get(key)
    if (prev) {
      this.map.delete(key)
      this.totalBytes -= prev.size
      if (prev.value !== value) this.onEvict?.(key, prev.value, 'replaced')
    }
    if (size > this.maxBytes) {
      this.onEvict?.(key, value, 'too-large')
      return false
    }
    this.map.set(key, { value, size })
    this.totalBytes += size
    while (this.map.size > this.maxEntries) this.evictOldest('capacity')
    while (this.totalBytes > this.maxBytes && this.map.size > 0) this.evictOldest('bytes')
    return true
  }

  delete(key: K): boolean {
    const slot = this.map.get(key)
    if (!slot) return false
    this.map.delete(key)
    this.totalBytes -= slot.size
    this.onEvict?.(key, slot.value, 'deleted')
    return true
  }

  /** Delete every entry matching `pred` (e.g. all entries of a removed session). Returns the count. */
  deleteWhere(pred: (key: K, value: V) => boolean): number {
    const doomed: K[] = []
    for (const [k, slot] of this.map) if (pred(k, slot.value)) doomed.push(k)
    for (const k of doomed) this.delete(k)
    return doomed.length
  }

  clear(): void {
    const entries = [...this.map]
    this.map.clear()
    this.totalBytes = 0
    if (this.onEvict) for (const [k, slot] of entries) this.onEvict(k, slot.value, 'cleared')
  }

  /** Keys, most recently used first. */
  keys(): K[] {
    return [...this.map.keys()].reverse()
  }

  /** Entries, most recently used first. */
  entries(): Array<[K, V]> {
    const out: Array<[K, V]> = []
    for (const [k, slot] of this.map) out.push([k, slot.value])
    return out.reverse()
  }

  private evictOldest(reason: EvictReason): void {
    const first = this.map.entries().next()
    if (first.done) return
    const [k, slot] = first.value
    this.map.delete(k)
    this.totalBytes -= slot.size
    this.onEvict?.(k, slot.value, reason)
  }
}

// ── BoundedQueue ────────────────────────────────────────────────────────────────

export type OverflowPolicy = 'drop-oldest' | 'reject'

export interface BoundedQueueOptions<T> {
  /** Maximum items held (≥ 1). */
  cap: number
  /** Full queue: `drop-oldest` discards the head to make room; `reject` refuses the new item. */
  overflow: OverflowPolicy
  /** Called with each item discarded or refused because the queue was full. */
  onDrop?: (item: T) => void
}

/** Initial ring size; the ring doubles on demand up to `cap` (a large cap costs nothing until used). */
const INITIAL_SLOTS = 16

/** FIFO queue with a hard cap (ring buffer, grows on demand up to `cap`). */
export class BoundedQueue<T> {
  // bounded: by cap — the caller's own `bounded:` comment names it
  private buf: Array<T | undefined>
  private head = 0
  private len = 0
  private droppedCount = 0
  readonly cap: number
  readonly overflow: OverflowPolicy
  private readonly onDrop: ((item: T) => void) | undefined

  constructor(opts: BoundedQueueOptions<T>) {
    if (!Number.isInteger(opts.cap) || opts.cap < 1) throw new RangeError('BoundedQueue: cap must be an integer ≥ 1')
    this.cap = opts.cap
    this.overflow = opts.overflow
    this.onDrop = opts.onDrop
    this.buf = new Array<T | undefined>(Math.min(opts.cap, INITIAL_SLOTS))
  }

  get length(): number {
    return this.len
  }

  get isFull(): boolean {
    return this.len >= this.cap
  }

  /** Items dropped (drop-oldest) or refused (reject) since creation. */
  get dropped(): number {
    return this.droppedCount
  }

  /** Append `item`. Returns false only when the queue is full and the policy is `reject`. */
  push(item: T): boolean {
    if (this.len >= this.cap) {
      this.droppedCount++
      if (this.overflow === 'reject') {
        this.onDrop?.(item)
        return false
      }
      const old = this.shift() as T
      this.onDrop?.(old)
    }
    if (this.len === this.buf.length) this.grow()
    this.buf[(this.head + this.len) % this.buf.length] = item
    this.len++
    return true
  }

  /** Remove and return the oldest item. */
  shift(): T | undefined {
    if (this.len === 0) return undefined
    const item = this.buf[this.head]
    this.buf[this.head] = undefined
    this.head = (this.head + 1) % this.buf.length
    this.len--
    return item
  }

  peek(): T | undefined {
    return this.len === 0 ? undefined : this.buf[this.head]
  }

  /** Remove and return every item, oldest first. */
  drain(): T[] {
    const out: T[] = []
    while (this.len > 0) out.push(this.shift() as T)
    return out
  }

  clear(): void {
    this.drain()
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this.len; i++) yield this.buf[(this.head + i) % this.buf.length] as T
  }

  private grow(): void {
    const next = new Array<T | undefined>(Math.min(this.cap, Math.max(1, this.buf.length * 2)))
    for (let i = 0; i < this.len; i++) next[i] = this.buf[(this.head + i) % this.buf.length]
    this.buf = next
    this.head = 0
  }
}
