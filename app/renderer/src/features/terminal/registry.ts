// The terminal-view registry: views keyed by ptyId, outside any rune state. Components hold ids and mount
// a view's element; this registry decides which views live and which hold a WebGL context (`warm.ts`), and
// disposes the rest in the disposal contract's order: the view's own `dispose`, then removal from here.

import { L } from '@kea/protocol'
import { retention, touch } from './warm.ts'

export interface ManagedView {
  readonly ptyId: string
  setWebgl(on: boolean): void
  dispose(): void
  /** Released by the instance policy (not closed): what it should leave for its next view. */
  released?(): void
  /** Its snapshot has painted: switching to it is shown at once. */
  readonly isAttached?: boolean
}

export interface RegistryPolicy {
  warm: number
  glMax: number
}

/** What a switch is made in: the active session's tabs are `tabs`; these say how the rest are judged. */
export interface ActivateOptions {
  /** The active context's other tabs, kept alive without WebGL (the active session's). */
  pinned?: readonly string[]
  /** Every PTY that still exists, in any session (default: `tabs`). */
  exists?: (id: string) => boolean
  /** Which views may be kept warm (default: any): the Agent terminals of other sessions. */
  warmable?: (id: string) => boolean
  /** The terminal that stands for the active context among the warm ones (a session's Agent terminal); viewing the context makes it recent. */
  representative?: string | null
}

export class TerminalRegistry<V extends ManagedView> {
  private readonly views = new Map<string, V>() // bounded: visible + leaving + pinned + policy.warm
  // bounded: ≤ existing PTYs, ids that are gone dropped on every switch
  private mru: string[] = []
  private visibleId: string | null = null
  private shownId: string | null = null
  private ctx: { exists: (id: string) => boolean; pinned: readonly string[]; warmable?: (id: string) => boolean } = { exists: () => false, pinned: [] }
  private readonly create: (ptyId: string) => V
  private readonly policy: RegistryPolicy
  /** Told when the terminal on screen changes (screen-reader mode follows it). */
  private readonly onShown: ((ptyId: string | null) => void) | null

  constructor(create: (ptyId: string) => V, policy: RegistryPolicy = { warm: L.warmTerminals, glMax: L.webglContextsMax }, onShown: ((ptyId: string | null) => void) | null = null) {
    this.create = create
    this.policy = policy
    this.onShown = onShown
  }

  /**
   * `ptyId` becomes the visible terminal (null: none), one of `tabs` (the active context's open tabs). Creates the
   * visible view if needed; evicts what the instance policy does not keep. The terminal on screen until now
   * stays until the switch is shown (`setShown`).
   */
  activate(ptyId: string | null, tabs: readonly string[], o: ActivateOptions = {}): V | undefined {
    const open = new Set(tabs)
    const exists = o.exists ? (id: string) => open.has(id) || o.exists!(id) : (id: string) => open.has(id)
    this.ctx = { exists, pinned: (o.pinned ?? []).filter((id) => id !== ptyId), ...(o.warmable ? { warmable: o.warmable } : {}) }
    this.visibleId = ptyId !== null && open.has(ptyId) ? ptyId : null
    let mru = this.mru.filter(exists)
    if (o.representative && exists(o.representative)) mru = touch(mru, o.representative, exists)
    if (this.visibleId !== null) mru = touch(mru, this.visibleId, exists)
    this.mru = mru
    let v: V | undefined
    if (this.visibleId !== null) {
      v = this.views.get(this.visibleId)
      if (!v) {
        v = this.create(this.visibleId)
        this.views.set(this.visibleId, v)
      }
    }
    this.apply()
    return v
  }

  /** A tab was closed: dispose its view now. */
  close(ptyId: string): void {
    const v = this.views.get(ptyId)
    if (v) {
      v.dispose()
      this.views.delete(ptyId)
    }
    this.mru = this.mru.filter((id) => id !== ptyId)
    if (this.visibleId === ptyId) this.visibleId = null
    if (this.shownId === ptyId) {
      this.shownId = null
      this.onShown?.(null)
    }
  }

  get(ptyId: string): V | undefined {
    return this.views.get(ptyId)
  }

  /** The terminal the user is switching to or looking at. */
  visible(): V | undefined {
    return this.visibleId !== null ? this.views.get(this.visibleId) : undefined
  }

  /** The terminal actually on screen (the visible one once it has painted); OSC 52's "visible". */
  shown(): V | undefined {
    return this.shownId !== null ? this.views.get(this.shownId) : undefined
  }

  /** The switch is on screen: the terminal it replaced is judged like any other now (kept warm, pinned, or let go). */
  setShown(ptyId: string | null): void {
    const was = this.shownId
    this.shownId = ptyId
    if (was !== ptyId) this.onShown?.(ptyId)
    if (was !== null && was !== ptyId) this.apply()
  }

  isShown(ptyId: string): boolean {
    return this.shownId === ptyId
  }

  all(): IterableIterator<V> {
    return this.views.values()
  }

  /** Ids with a live view, visible first, then most recently viewed. */
  liveIds(): string[] {
    return [...this.views.keys()].sort((a, b) => this.rank(a) - this.rank(b))
  }

  get size(): number {
    return this.views.size
  }

  /** Ids in the most-recently-viewed order (read by the cycle test, U-TERM-35). */
  get mruSize(): number {
    return this.mru.length
  }

  private rank(id: string): number {
    if (id === this.visibleId) return -1
    const i = this.mru.indexOf(id)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }

  private apply(): void {
    const { exists, pinned, warmable } = this.ctx
    // a switch to a view that has painted is shown at once: nothing is left on screen meanwhile
    const target = this.visibleId !== null ? this.views.get(this.visibleId) : undefined
    const leaving = this.shownId !== this.visibleId && !target?.isAttached ? this.shownId : null
    const r = retention({ visible: this.visibleId, mru: this.mru, exists, alive: (id) => this.views.has(id), pinned, leaving, warm: this.policy.warm, glMax: this.policy.glMax, ...(warmable ? { warmable } : {}) })
    const keep = new Set(r.keep)
    const gl = new Set(r.webgl)
    for (const [id, v] of [...this.views]) {
      if (keep.has(id)) continue
      v.released?.()
      v.dispose() // The view releases everything, then it leaves the registry
      this.views.delete(id)
      if (this.shownId === id) this.shownId = null
    }
    // release before loading, so the context count never goes above the cap, even for a moment
    for (const [id, v] of this.views) if (!gl.has(id)) v.setWebgl(false)
    for (const id of r.webgl) this.views.get(id)?.setWebgl(true)
  }
}
