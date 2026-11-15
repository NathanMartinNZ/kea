// Main's hand-offs to the browser (Open in Browser): every request is answered within its deadline, at most a fixed
// number are in main at once, and each window has one page slot. The deadline reaches only main's wait, never a
// program a route started. Free of Electron, with the clock passed in, so it is unit-tested in Node.

/** Words for a hand-off that had not started by its deadline (it never starts). */
export const BROWSER_DID_NOT_ANSWER = 'The browser did not answer'
/** Words for a hand-off still waiting at its deadline on a call that cannot be taken back. */
export const BROWSER_NOT_YET = 'The browser has not answered yet'
/** Words for a request refused because main is at its cap. */
export const HANDOFFS_BUSY = 'Kea is still opening earlier pages'
/** Words for a route that failed without saying why. */
export const PAGE_NOT_OPENED = 'The page could not be opened'

export type HandoffKind = 'page'

/** What a route is given for one hand-off. */
export interface Handoff {
  /**
   * Aborted when main stops waiting for the hand-off to start: its deadline, a newer request of the window's, or the
   * window gone. A route passes it on as `queueSignal`, so a launch still waiting leaves and nothing started is stopped.
   */
  readonly queueSignal: AbortSignal
  /** The route has made a call it cannot take back (Electron's), before it has started. */
  called(): void
  /** The route has started the hand-off (macOS: `open` spawned). */
  started(): void
}

/** Runs one hand-off: why it failed in words, or null once it is handed over. */
export type HandoffRun = (h: Handoff) => Promise<string | null>

export interface HandoffClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

export interface HandoffOptions {
  deadlineMs: number
  max: number
  clock?: HandoffClock
  /** A route that settled after its deadline answered (for the log). */
  onLate?: (kind: HandoffKind, message: string | null) => void
}

interface Entry {
  readonly owner: number
  readonly kind: HandoffKind
  phase: 'waiting' | 'called' | 'started'
  readonly ctrl: AbortController
  readonly answer: (message: string | null) => void
  timer: unknown
  /** Answered, dropped or past its deadline: whatever the route says later reaches no one. */
  done: boolean
  /** Dropped unstarted (replaced, or its window gone): nothing to log when it settles. */
  dropped: boolean
}

const timers: HandoffClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

export class BrowserHandoffs {
  private readonly deadlineMs: number
  private readonly max: number
  private readonly clock: HandoffClock
  private readonly onLate: HandoffOptions['onLate']
  // bounded: L.browserHandoffsMax hand-offs, each until its answer or L.browserHandoffDeadlineMs
  private readonly inFlight = new Set<Entry>()
  // bounded: one slot per window and kind, freed with the window; its hand-off is counted under L.browserHandoffsMax
  private readonly slots = new Map<string, Entry>()

  constructor(o: HandoffOptions) {
    this.deadlineMs = o.deadlineMs
    this.max = o.max
    this.clock = o.clock ?? timers
    this.onLate = o.onLate
  }

  /**
   * Hands off for window `owner`: `run` is called once, and `answer` exactly once, unless the window replaces the
   * request or goes before it has started. One past the cap is answered at once and `run` is never called.
   */
  start(owner: number, kind: HandoffKind, run: HandoffRun, answer: (message: string | null) => void): void {
    const key = `${owner}:${kind}`
    const prev = this.slots.get(key)
    if (prev?.phase === 'waiting') this.drop(prev)
    if (this.inFlight.size >= this.max) {
      answer(HANDOFFS_BUSY)
      return
    }
    const e: Entry = { owner, kind, phase: 'waiting', ctrl: new AbortController(), answer, timer: undefined, done: false, dropped: false }
    this.inFlight.add(e)
    this.slots.set(key, e)
    e.timer = this.clock.setTimeout(() => this.expire(e), this.deadlineMs)
    const h: Handoff = {
      queueSignal: e.ctrl.signal,
      called: () => {
        if (e.phase === 'waiting') e.phase = 'called'
      },
      started: () => {
        e.phase = 'started'
      },
    }
    let settled: Promise<string | null>
    try {
      settled = run(h)
    } catch {
      settled = Promise.resolve(PAGE_NOT_OPENED)
    }
    settled.then(
      (message) => this.settle(e, message),
      () => this.settle(e, PAGE_NOT_OPENED),
    )
  }

  /** The window went: its unstarted hand-offs are dropped, its slots freed. Started ones run on, answering no one. */
  forget(owner: number): void {
    for (const [key, e] of this.slots) {
      if (e.owner !== owner) continue
      this.slots.delete(key)
      if (e.phase === 'waiting') this.drop(e)
    }
  }

  /** For main's resource report (`main.browserHandoffs`). */
  gauge(): { inFlight: number; timers: number; slots: number } {
    let timersLive = 0
    for (const e of this.inFlight) if (e.timer !== undefined) timersLive++
    return { inFlight: this.inFlight.size, timers: timersLive, slots: this.slots.size }
  }

  private finish(e: Entry): void {
    e.done = true
    this.inFlight.delete(e)
    if (e.timer !== undefined) this.clock.clearTimeout(e.timer)
    e.timer = undefined
    const key = `${e.owner}:${e.kind}`
    if (this.slots.get(key) === e) this.slots.delete(key)
  }

  private drop(e: Entry): void {
    if (e.done) return
    e.dropped = true
    this.finish(e)
    e.ctrl.abort()
  }

  private settle(e: Entry, message: string | null): void {
    if (e.done) {
      if (!e.dropped) this.onLate?.(e.kind, message)
      return
    }
    this.finish(e)
    e.answer(message)
  }

  private expire(e: Entry): void {
    if (e.done) return
    e.timer = undefined
    this.finish(e)
    if (e.phase === 'waiting') {
      // dropped unstarted: it never starts, so what its route returns is not a late answer
      e.dropped = true
      e.ctrl.abort()
      e.answer(BROWSER_DID_NOT_ANSWER)
    } else e.answer(e.phase === 'called' ? BROWSER_NOT_YET : null)
  }
}
