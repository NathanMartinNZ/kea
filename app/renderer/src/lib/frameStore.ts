// A core store as the window's lists read it: updates from many rows are applied at most once per animation
// frame, a row's subscribers hear only about their row, a group's (a project's sessions) only about its rows, and a
// list's only when something it lays out changed (a row added, removed or moved, per `structure`). A status change
// therefore re-renders its one row and, at most, its project's row (the needs-you count of a collapsed project).
//
// The values are the RPC client's own (plain data, replaced, never mutated); after a core restart the snapshot brings
// every row again, and rows equal to the ones shown notify nobody.

import { L } from '@kea/protocol'

/** Runs `cb` before the next frame (requestAnimationFrame in the window; a manual queue in tests). */
export type Schedule = (cb: () => void) => void

export interface FrameStoreOptions<V> {
  schedule: Schedule
  /** What of a row the lists lay out (order, grouping, filtering); a change here notifies list subscribers. */
  structure?: (v: V) => string
  /** The group a row belongs to (a session's project). */
  group?: (v: V) => string
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

export class FrameStore<V> {
  private readonly rows = new Map<string, V>() // bounded: a copy of one core store, whose owner sets the cap
  private readonly rowSubs = new Map<string, Set<() => void>>() // bounded: one entry per mounted row
  private readonly groupSubs = new Map<string, Set<() => void>>() // bounded: one entry per mounted group row
  private readonly listSubs = new Set<() => void>() // bounded: the lists that show this store
  private readonly anySubs = new Set<() => void>() // bounded: the window's command availability (one per feature)
  // bounded: keys of this store changed since the last frame, emptied by each frame's flush; a snapshot marks them
  // all at once ('all')
  private dirty: Set<string> | 'all' = new Set()
  private source: ReadonlyMap<string, V> | null = null
  private scheduled = false
  private list: readonly V[] = []
  private listStale = true
  private version = 0
  private structure: (v: V) => string
  private readonly group: ((v: V) => string) | undefined
  private readonly schedule: Schedule
  /** Frames flushed (tests check that a store flushes at most once per frame). */
  flushes = 0

  constructor(o: FrameStoreOptions<V>) {
    this.schedule = o.schedule
    this.structure = o.structure ?? (() => '')
    this.group = o.group
  }

  /** From the RPC subscription: the store's current copy and the keys that changed (null: a snapshot). */
  push(data: ReadonlyMap<string, V>, changed: readonly string[] | null): void {
    this.source = data
    if (changed === null) this.dirty = 'all'
    else if (this.dirty !== 'all') for (const k of changed) this.dirty.add(k)
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => this.flush())
  }

  /** Lay out differently (e.g. `general.sessionOrder` changed): every list is told. */
  setStructure(fn: (v: V) => string): void {
    this.structure = fn
    this.bumpList()
    for (const cb of [...this.listSubs]) cb()
  }

  private flush(): void {
    this.scheduled = false
    const src = this.source
    if (!src) return
    this.flushes++
    const keys = this.dirty === 'all' ? new Set([...this.rows.keys(), ...src.keys()]) : this.dirty
    this.dirty = new Set()
    let listChanged = false
    const rows: string[] = []
    const groups = new Set<string>()
    for (const k of keys) {
      const next = src.get(k)
      const prev = this.rows.get(k)
      if (next === undefined) {
        if (prev === undefined) continue
        this.rows.delete(k)
        listChanged = true
        rows.push(k)
        if (this.group) groups.add(this.group(prev))
        continue
      }
      if (prev !== undefined && same(prev, next)) continue
      this.rows.set(k, next)
      rows.push(k)
      if (this.group) {
        groups.add(this.group(next))
        if (prev !== undefined) groups.add(this.group(prev))
      }
      if (prev === undefined || this.structure(prev) !== this.structure(next)) listChanged = true
    }
    if (listChanged) this.bumpList()
    for (const k of rows) for (const cb of [...(this.rowSubs.get(k) ?? [])]) cb()
    for (const g of groups) for (const cb of [...(this.groupSubs.get(g) ?? [])]) cb()
    if (listChanged) for (const cb of [...this.listSubs]) cb()
    if (rows.length) for (const cb of [...this.anySubs]) cb()
  }

  private bumpList(): void {
    this.listStale = true
    this.version++
  }

  get(id: string): V | undefined {
    return this.rows.get(id)
  }

  get size(): number {
    return this.rows.size
  }

  /** Every row; the same array until the list's structure changes (a stable snapshot, `lib/reactive.svelte.ts` `External`). */
  values(): readonly V[] {
    if (this.listStale) {
      this.list = [...this.rows.values()]
      this.listStale = false
    }
    return this.list
  }

  /** Changes whenever `values()` does. */
  get listVersion(): number {
    return this.version
  }

  /** Rows of one group, read now (not cached). */
  inGroup(g: string): V[] {
    if (!this.group) return []
    return [...this.rows.values()].filter((v) => this.group!(v) === g)
  }

  subscribeRow = (id: string, cb: () => void): (() => void) => subscribeIn(this.rowSubs, id, cb)
  subscribeGroup = (g: string, cb: () => void): (() => void) => subscribeIn(this.groupSubs, g, cb)
  subscribeList = (cb: () => void): (() => void) => {
    this.listSubs.add(cb)
    return () => this.listSubs.delete(cb)
  }
  /** Once per frame in which any row changed (command availability follows it). */
  subscribeAny = (cb: () => void): (() => void) => {
    this.anySubs.add(cb)
    return () => this.anySubs.delete(cb)
  }

  /** Mounted subscribers (the resource report and the leak suite). */
  get subscribers(): number {
    let n = this.listSubs.size + this.anySubs.size
    for (const s of this.rowSubs.values()) n += s.size
    for (const s of this.groupSubs.values()) n += s.size
    return n
  }
}

function subscribeIn(map: Map<string, Set<() => void>>, key: string, cb: () => void): () => void {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(cb)
  return () => {
    set.delete(cb)
    if (set.size === 0 && map.get(key) === set) map.delete(key)
  }
}

const queued: (() => void)[] = [] // bounded: one flush per FrameStore of the window, emptied each frame
let frameArmed = false

/**
 * The window's frame scheduler: every store's flush runs in the same frame. A window that is hidden or covered gets
 * no animation frames, so the flush also runs after L.frameFallbackMs — the lists stay current for whoever looks
 * next, and nothing waits on a frame that never comes. That is longer than a frame at any rate a display runs, so a
 * shown window's frame always comes first: a shorter fallback would flush twice within one 60 Hz frame (U-SB-6).
 */
export const nextFrame: Schedule = (cb) => {
  queued.push(cb)
  if (frameArmed) return
  frameArmed = true
  let done = false
  const run = () => {
    if (done) return
    done = true
    frameArmed = false
    for (const f of queued.splice(0)) f()
  }
  requestAnimationFrame(run)
  setTimeout(run, L.frameFallbackMs)
}
