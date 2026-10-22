// The one generic store implementation: a keyed collection that a producer mutates and that subscribers see as a
// snapshot followed by deltas. Every store — `sessions`, `projects`, `settings`, `tree:<sessionId>`, `git:<sessionId>`,
// `server:<sessionId>` — is a KeyedStore; a new store is a schema and a producer, not new sync code.

export type Delta<V> = { set?: Record<string, V>; del?: string[] }
export type Snapshot<V> = Record<string, V>

export function isEmptyDelta<V>(d: Delta<V>): boolean {
  return (!d.set || Object.keys(d.set).length === 0) && (!d.del || d.del.length === 0)
}

/** Merge `next` into `prev` so that applying the result equals applying prev then next (U-MEM-3). */
export function mergeDelta<V>(prev: Delta<V>, next: Delta<V>): Delta<V> {
  const set: Record<string, V> = { ...prev.set }
  const del = new Set(prev.del)
  for (const k of next.del ?? []) {
    delete set[k]
    del.add(k)
  }
  for (const [k, v] of Object.entries(next.set ?? {})) {
    set[k] = v
    del.delete(k)
  }
  const out: Delta<V> = {}
  if (Object.keys(set).length) out.set = set
  if (del.size) out.del = [...del]
  return out
}

/** Apply a delta to a mutable map; returns the keys that changed. */
export function applyDelta<V>(map: Map<string, V>, d: Delta<V>): string[] {
  const changed: string[] = []
  for (const k of d.del ?? []) if (map.delete(k)) changed.push(k)
  for (const [k, v] of Object.entries(d.set ?? {})) {
    map.set(k, v)
    changed.push(k)
  }
  return changed
}

export function diffSnapshots<V>(prev: Snapshot<V>, next: Snapshot<V>, equal: (a: V, b: V) => boolean = Object.is): Delta<V> {
  const d: Delta<V> = {}
  for (const k of Object.keys(prev)) if (!(k in next)) (d.del ??= []).push(k)
  for (const [k, v] of Object.entries(next)) {
    if (!(k in prev) || !equal(prev[k] as V, v)) (d.set ??= {})[k] = v
  }
  return d
}

type DeltaListener<V> = (d: Delta<V>) => void

/**
 * Producer side of a store. Mutations emit deltas synchronously to listeners (the RPC layer merges and
 * coalesces them per subscriber). Values must be structured-clonable plain data.
 * bounded: holds exactly the store's current state; its cap is the owning feature's (the file tree's, say).
 */
export class KeyedStore<V> {
  private readonly map = new Map<string, V>() // bounded: by the store's owner
  private readonly listeners = new Set<DeltaListener<V>>() // bounded: one per subscription; dropped with its connection
  private disposed = false
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  get size(): number {
    return this.map.size
  }
  get(key: string): V | undefined {
    return this.map.get(key)
  }
  has(key: string): boolean {
    return this.map.has(key)
  }
  keys(): IterableIterator<string> {
    return this.map.keys()
  }
  values(): IterableIterator<V> {
    return this.map.values()
  }
  entries(): IterableIterator<[string, V]> {
    return this.map.entries()
  }

  set(key: string, value: V): void {
    this.map.set(key, value)
    this.emit({ set: { [key]: value } })
  }

  /** Set many keys in one delta. */
  setMany(entries: Iterable<[string, V]>): void {
    const set: Record<string, V> = {}
    for (const [k, v] of entries) {
      this.map.set(k, v)
      set[k] = v
    }
    if (Object.keys(set).length) this.emit({ set })
  }

  delete(key: string): void {
    if (this.map.delete(key)) this.emit({ del: [key] })
  }

  /** Replace the whole state; emits only the difference. */
  replace(next: Snapshot<V>, equal?: (a: V, b: V) => boolean): void {
    const d = diffSnapshots(Object.fromEntries(this.map), next, equal)
    if (isEmptyDelta(d)) return
    applyDelta(this.map, d)
    this.emit(d)
  }

  snapshot(): Snapshot<V> {
    return Object.fromEntries(this.map)
  }

  onDelta(cb: DeltaListener<V>): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  /** The store is gone (e.g. a session left the visible set): subscribers are told and dropped. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.map.clear()
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  private emit(d: Delta<V>): void {
    for (const l of [...this.listeners]) l(d)
  }
}

/** Looks up stores by name for subscriptions; session-scoped stores come and go with the visible set. */
export interface StoreRegistry {
  get(name: string): KeyedStore<unknown> | undefined
  /** Fires when a named store is removed, so subscribers can be told it is gone. */
  onRemoved(cb: (name: string) => void): () => void
}

export class SimpleStoreRegistry implements StoreRegistry {
  private readonly stores = new Map<string, KeyedStore<unknown>>() // bounded: global stores + visible-set session stores
  // bounded: one per live RpcPeer serving these stores; each peer
  // removes its own when it is disposed (RpcPeer.dispose runs the unsubscribe onRemoved returned)
  private readonly removed = new Set<(name: string) => void>()

  add<V>(store: KeyedStore<V>): KeyedStore<V> {
    this.stores.set(store.name, store as KeyedStore<unknown>)
    return store
  }
  get(name: string): KeyedStore<unknown> | undefined {
    return this.stores.get(name)
  }
  remove(name: string): void {
    const s = this.stores.get(name)
    if (!s) return
    this.stores.delete(name)
    for (const cb of [...this.removed]) cb(name)
    s.dispose()
  }
  names(): string[] {
    return [...this.stores.keys()]
  }
  onRemoved(cb: (name: string) => void): () => void {
    this.removed.add(cb)
    return () => this.removed.delete(cb)
  }
}

/** `tree:<sessionId>` etc. */
export function sessionStoreName(kind: 'tree' | 'git' | 'server', sessionId: string): string {
  return `${kind}:${sessionId}`
}
