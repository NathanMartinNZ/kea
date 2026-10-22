// How often the palette ran each command (an empty query lists the most-used ones; a command's boost). Only the
// palette's own runs count: a command run by its key is one the person already knows the key of. Kept in the window's
// own storage (as the layout is), so it is there before core answers and survives a restart.
//
// A long-lived record: one count per command of the command table at most. Ids the table does not have (a command that
// was removed) are dropped when the record is read, and none is ever added.

export interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const USAGE_KEY = 'kea.palette.usage'

export class Usage {
  private readonly counts = new Map<string, number>() // bounded: one per command id of the table
  private readonly storage: KeyValue | null
  private readonly known: (id: string) => boolean

  constructor(storage: KeyValue | null, known: (id: string) => boolean) {
    this.storage = storage
    this.known = known
    let raw: unknown = null
    try {
      raw = JSON.parse(storage?.getItem(USAGE_KEY) ?? 'null') as unknown
    } catch {
      raw = null
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
    for (const [id, n] of Object.entries(raw)) if (known(id) && typeof n === 'number' && Number.isSafeInteger(n) && n > 0) this.counts.set(id, n)
  }

  count(id: string): number {
    return this.counts.get(id) ?? 0
  }

  /** The palette ran `id`. A command the table does not have is not counted. */
  ran(id: string): void {
    if (!this.known(id)) return
    const n = this.count(id)
    if (!Number.isSafeInteger(n + 1)) return
    this.counts.set(id, n + 1)
    try {
      this.storage?.setItem(USAGE_KEY, JSON.stringify(Object.fromEntries(this.counts)))
    } catch {
      // not remembered this time
    }
  }

  /** Commands with a count (the resource report's `paletteUsage`). */
  get size(): number {
    return this.counts.size
  }
}
