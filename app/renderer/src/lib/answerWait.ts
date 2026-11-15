// The window's wait for main's answer to a hand-off (Open in Browser): one request at a time, each bounded. Main always
// answers by its own deadline, so this one only catches a main that never answers. Kept free of `window` so the unit
// tests load it.

/** Words for a request main did not answer in time. */
export const BROWSER_DID_NOT_ANSWER = 'The browser did not answer'

export interface WaitClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

const timers: WaitClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

/**
 * A single slot: `begin` starts a wait and ends the one before it with no words; main's answer for the request in the
 * slot ends it with main's words (null once handed over); with none by `deadlineMs`, it ends with `timeoutWords`. An
 * answer for any other request (replaced, or after the deadline) is dropped.
 */
export class AnswerWait {
  private readonly deadlineMs: number
  private readonly timeoutWords: string
  private readonly clock: WaitClock
  private current: { reqId: number; done: (message: string | null) => void; timer: unknown } | null = null

  constructor(deadlineMs: number, timeoutWords: string, clock: WaitClock = timers) {
    this.deadlineMs = deadlineMs
    this.timeoutWords = timeoutWords
    this.clock = clock
  }

  /** Whether a request is waiting (for the resource report). */
  get waiting(): boolean {
    return this.current !== null
  }

  begin(reqId: number): Promise<string | null> {
    this.end(null)
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => {
        if (this.current?.reqId === reqId) this.end(this.timeoutWords)
      }, this.deadlineMs)
      this.current = { reqId, done: resolve, timer }
    })
  }

  answer(reqId: unknown, message: string | null): void {
    if (this.current === null || this.current.reqId !== reqId) return
    this.end(message)
  }

  private end(message: string | null): void {
    const c = this.current
    if (!c) return
    this.current = null
    this.clock.clearTimeout(c.timer)
    c.done(message)
  }
}
