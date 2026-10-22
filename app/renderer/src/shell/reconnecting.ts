// The thin "Reconnecting…" bar: shown only once core has been away longer than L.reconnectingBarDelayMs, hidden the
// moment it is back. Main tells the window when core goes (`kea:coreAway`: a core that had been ready exited, or the
// window said hello while core was restarting); a new RPC port means core is back. A restart faster than the delay
// never shows the bar. Pure state with injected timers (unit-tested with fake ones); ReconnectingBar.svelte renders it.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

export class ReconnectingState {
  private readonly delayMs: number
  private readonly timers: Timers
  private timer: unknown = null
  private away = false
  private visible = false
  private readonly listeners = new Set<() => void>() // bounded: the window's bar components (one per terminal pane mounted)

  constructor(delayMs: number, timers: Timers = realTimers) {
    this.delayMs = delayMs
    this.timers = timers
  }

  /** The bar is on screen. */
  get shown(): boolean {
    return this.visible
  }

  /** Core went away: the bar shows after the delay unless core is back first. Repeats while away change nothing. */
  coreAway(): void {
    if (this.away) return
    this.away = true
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.set(true)
    }, this.delayMs)
  }

  /** Core is back (a new RPC port): the bar goes, and a pending one never shows. */
  coreBack(): void {
    this.away = false
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
    this.set(false)
  }

  /** For the bar (`External`, lib/reactive.svelte.ts). Returns an unsubscribe function. */
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(v: boolean): void {
    if (this.visible === v) return
    this.visible = v
    for (const l of [...this.listeners]) l()
  }
}
