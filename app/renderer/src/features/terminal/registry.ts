// The terminal-view registry: views keyed by ptyId, outside any rune state. Components hold ids and mount
// a view's element; this registry decides which views live and which hold a WebGL context (`warm.ts`), and
// disposes the rest in the disposal contract's order: the view's own `dispose`, then removal from here.
//
// A window shows a terminal in each of its panes (`Slot`): the work pane, and the agent pane beside it. Every
// activation names both, so one pane's switch never lets go of the other's terminal, and a view that moves from one
// pane to the other is never disposed on the way.

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

/** The panes a terminal can be on screen in. */
export type Slot = 'work' | 'agent'
export const SLOTS: readonly Slot[] = ['work', 'agent']

/** What each pane is to show (null: no terminal); a pane left out shows none. */
export interface SlotTargets {
  readonly work: string | null
  readonly agent?: string | null
}

export interface RegistryPolicy {
  warm: number
  glMax: number
  /**
   * Runs `fn` once the renderer is idle and returns what cancels it. A warm view that gave up its WebGL context for a
   * switch gets it back here, never inside the switch's reveal (building a context is synchronous).
   */
  idle?: (fn: () => void) => () => void
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

function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const h = requestIdleCallback(() => fn())
    return () => cancelIdleCallback(h)
  }
  const t = setTimeout(fn, 0)
  return () => clearTimeout(t)
}

const none = (): Record<Slot, string | null> => ({ work: null, agent: null })

export class TerminalRegistry<V extends ManagedView> {
  private readonly views = new Map<string, V>() // bounded: visible + leaving + pinned + policy.warm
  // bounded: ≤ existing PTYs, ids that are gone dropped on every switch
  private mru: string[] = []
  private readonly visibleBy = none()
  private readonly shownBy = none()
  private readonly withGl = new Set<string>() // bounded: ≤ policy.glMax, the views this registry gave a context
  private cancelRegain: (() => void) | null = null
  private ctx: { exists: (id: string) => boolean; pinned: readonly string[]; warmable?: (id: string) => boolean } = { exists: () => false, pinned: [] }
  private readonly create: (ptyId: string) => V
  private readonly policy: RegistryPolicy
  /** Told when the terminal on screen in a pane changes (screen-reader mode follows the active pane's). */
  private readonly onShown: ((ptyId: string | null, slot: Slot) => void) | null

  constructor(create: (ptyId: string) => V, policy: RegistryPolicy = { warm: L.warmTerminals, glMax: L.webglContextsMax }, onShown: ((ptyId: string | null, slot: Slot) => void) | null = null) {
    this.create = create
    this.policy = policy
    this.onShown = onShown
  }

  /**
   * What each pane is to show (a ptyId alone is the work pane's, null: none), among `tabs` (the active context's open
   * tabs, both panes'). Creates the visible views if needed; evicts what the instance policy does not keep. The
   * terminal on screen in a pane until now stays until that pane's switch is shown (`setShown`). Returns the work
   * pane's view (the agent pane's: `visible('agent')`).
   */
  activate(target: string | null | SlotTargets, tabs: readonly string[], o: ActivateOptions = {}): V | undefined {
    const t: SlotTargets = target === null || typeof target === 'string' ? { work: target } : target
    const open = new Set(tabs)
    const exists = o.exists ? (id: string) => open.has(id) || o.exists!(id) : (id: string) => open.has(id)
    for (const s of SLOTS) {
      const id = t[s] ?? null
      this.visibleBy[s] = id !== null && open.has(id) ? id : null
    }
    const visible = this.visibleIds()
    this.ctx = { exists, pinned: (o.pinned ?? []).filter((id) => !visible.includes(id)), ...(o.warmable ? { warmable: o.warmable } : {}) }
    let mru = this.mru.filter(exists)
    if (o.representative && exists(o.representative)) mru = touch(mru, o.representative, exists)
    for (const id of [...visible].reverse()) mru = touch(mru, id, exists)
    this.mru = mru
    for (const id of visible) {
      if (!this.views.has(id)) this.views.set(id, this.create(id))
    }
    this.apply(false)
    return this.visible('work')
  }

  /** A tab was closed: dispose its view now. */
  close(ptyId: string): void {
    const v = this.views.get(ptyId)
    if (v) {
      v.dispose()
      this.views.delete(ptyId)
    }
    this.withGl.delete(ptyId)
    this.mru = this.mru.filter((id) => id !== ptyId)
    for (const s of SLOTS) {
      if (this.visibleBy[s] === ptyId) this.visibleBy[s] = null
      if (this.shownBy[s] === ptyId) {
        this.shownBy[s] = null
        this.onShown?.(null, s)
      }
    }
  }

  get(ptyId: string): V | undefined {
    return this.views.get(ptyId)
  }

  /** The terminal the user is switching to or looking at in a pane. */
  visible(slot: Slot = 'work'): V | undefined {
    const id = this.visibleBy[slot]
    return id !== null ? this.views.get(id) : undefined
  }

  /** The terminal actually on screen in a pane (the visible one once it has painted). */
  shown(slot: Slot = 'work'): V | undefined {
    const id = this.shownBy[slot]
    return id !== null ? this.views.get(id) : undefined
  }

  /** A pane's switch is on screen: the terminal it replaced is judged like any other now (kept warm, pinned, or let go). */
  setShown(ptyId: string | null, slot: Slot = 'work'): void {
    const was = this.shownBy[slot]
    this.shownBy[slot] = ptyId
    if (was !== ptyId) this.onShown?.(ptyId, slot)
    if (was !== null && was !== ptyId) this.apply(false)
  }

  /** On screen in either pane: OSC 52's "visible". */
  isShown(ptyId: string): boolean {
    return SLOTS.some((s) => this.shownBy[s] === ptyId)
  }

  /** On screen in a pane other than `slot`: that pane's find, scroll and layers are its own. */
  shownElsewhere(ptyId: string, slot: Slot): boolean {
    return SLOTS.some((s) => s !== slot && this.shownBy[s] === ptyId)
  }

  /** The pane a terminal is on screen in, if any. */
  slotOf(ptyId: string): Slot | null {
    return SLOTS.find((s) => this.shownBy[s] === ptyId) ?? null
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

  /** The views holding a WebGL context, as this registry gave them (read by the retention tests). */
  webglIds(): string[] {
    return [...this.withGl]
  }

  private visibleIds(): string[] {
    const ids: string[] = []
    for (const s of SLOTS) {
      const id = this.visibleBy[s]
      if (id !== null && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  private rank(id: string): number {
    const v = this.visibleIds().indexOf(id)
    if (v >= 0) return v - SLOTS.length
    const i = this.mru.indexOf(id)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }

  /** The terminals still on screen while their pane's visible one paints: a switch to a view that has painted is shown at once. */
  private leavingIds(): string[] {
    const ids: string[] = []
    for (const s of SLOTS) {
      const shown = this.shownBy[s]
      const want = this.visibleBy[s]
      const target = want !== null ? this.views.get(want) : undefined
      if (shown !== null && shown !== want && !target?.isAttached && !ids.includes(shown)) ids.push(shown)
    }
    return ids
  }

  /**
   * Judge every view. The terminals on screen and arriving get their WebGL at once; a warm view owed one gets it in
   * idle time (`regainWarm`), unless `warmToo`.
   */
  private apply(warmToo: boolean): void {
    const { exists, pinned, warmable } = this.ctx
    const visible = this.visibleIds()
    const leaving = this.leavingIds()
    const r = retention({ visible, mru: this.mru, exists, alive: (id) => this.views.has(id), pinned, leaving, warm: this.policy.warm, glMax: this.policy.glMax, ...(warmable ? { warmable } : {}) })
    const keep = new Set(r.keep)
    const gl = new Set(r.webgl)
    for (const [id, v] of [...this.views]) {
      if (keep.has(id)) continue
      v.released?.()
      v.dispose() // The view releases everything, then it leaves the registry
      this.views.delete(id)
      this.withGl.delete(id)
      for (const s of SLOTS) if (this.shownBy[s] === id) this.shownBy[s] = null
    }
    // release before loading, so the context count never goes above the cap, even for a moment
    for (const [id, v] of this.views) {
      if (gl.has(id)) continue
      v.setWebgl(false)
      this.withGl.delete(id)
    }
    const now = new Set([...visible, ...leaving])
    let owed = false
    for (const id of r.webgl) {
      // asked again of a view that has one: it reloads a context it could not get (the window-wide count was full)
      if (!warmToo && !now.has(id) && !this.withGl.has(id)) {
        owed = true
        continue
      }
      this.views.get(id)?.setWebgl(true)
      this.withGl.add(id)
    }
    if (owed) this.regainWarm()
  }

  /** The warm views owed a context get it once the renderer is idle: after the reveal, never inside it. */
  private regainWarm(): void {
    if (this.cancelRegain) return
    const idle = this.policy.idle ?? whenIdle
    this.cancelRegain = idle(() => {
      this.cancelRegain = null
      this.apply(true)
    })
  }
}
