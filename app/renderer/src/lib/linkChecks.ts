// What core answered about links the window asked for, remembered for a while so that moving the pointer along a line
// asks once: the paths a terminal prints (`features/terminal/links.ts`) and the file references in the viewer's text
// (`features/viewer/fileLinks.ts`), each an instance with its own key, answers and caps. One question per key is out at
// once: asking again while it is out waits for the same answer, and once as many questions are out as answers may be
// kept, one more is not asked (it reads as not known yet). An answer the instance is told not to keep (`keep`) is
// handed back and forgotten; one that comes after `clear` is handed back and not kept either. Pure: the asking is the
// `resolve` it is given.

export interface LinkChecksOptions<G, Q, A> {
  /** Asks core about `qs`, all of one group (a session, a file): one answer per question, in order. */
  resolve(group: G, qs: Q[]): Promise<readonly A[]>
  /** What identifies a question, its group included. */
  key(group: G, q: Q): string
  /** Whether an answer is remembered (default: every answer). */
  keep?(a: A): boolean
  /** How long an answer is remembered. */
  maxAgeMs: number
  /** Answers remembered, least recently used first out; also the questions out at once. */
  max: number
  now?: () => number
}

export class LinkChecks<G, Q, A> {
  // bounded: the instance's `max` answers (L.terminalLinkCacheMax for the terminal's, L.viewerLinkCacheMax for the viewer's), least recently used first out
  private readonly answers = new Map<string, { a: A; at: number }>()
  // bounded: the instance's `max` questions out at once (L.terminalLinkCacheMax for the terminal's, L.viewerLinkCacheMax for the viewer's); one more is not asked
  private readonly asking = new Map<string, Promise<A | undefined>>()
  private readonly o: LinkChecksOptions<G, Q, A>
  private readonly now: () => number
  /** Moves on at `clear`, so an answer to an older question is not kept. */
  private generation = 0

  constructor(o: LinkChecksOptions<G, Q, A>) {
    this.o = o
    this.now = o.now ?? (() => performance.now())
  }

  /** Answers remembered. */
  get size(): number {
    return this.answers.size
  }

  /** Questions out. */
  get inFlight(): number {
    return this.asking.size
  }

  /** Forgets every answer and every question out (their answers, when they come, are handed back and not kept). */
  clear(): void {
    this.answers.clear()
    this.asking.clear()
    this.generation++
  }

  /** The answer remembered for `q`, while it is fresh; undefined when none is. */
  known(group: G, q: Q): A | undefined {
    return this.fresh(this.o.key(group, q), this.now())?.a
  }

  /** Whether a question for `q` is out now. */
  asked(group: G, q: Q): boolean {
    return this.asking.has(this.o.key(group, q))
  }

  /**
   * The answers for `qs`: remembered ones at once, the rest asked (those out already are waited for, not asked again).
   * Undefined for one not asked (too many out), and for one whose question failed.
   */
  check(group: G, qs: readonly Q[]): Promise<(A | undefined)[]> {
    const t = this.now()
    const out: (A | undefined | Promise<A | undefined>)[] = []
    const ask: Q[] = []
    const keys: string[] = []
    // this call's questions, at most `qs`, and how each is answered
    const mine = new Map<string, Promise<A | undefined>>()
    const pending: { slot: number; resolve: (a: A | undefined) => void }[] = []
    for (const q of qs) {
      const key = this.o.key(group, q)
      const hit = this.fresh(key, t)
      if (hit) {
        out.push(hit.a)
        continue
      }
      const waiting = mine.get(key) ?? this.asking.get(key)
      if (waiting) {
        out.push(waiting)
        continue
      }
      if (this.asking.size >= this.o.max) {
        out.push(undefined)
        continue
      }
      ask.push(q)
      keys.push(key)
      const slot = ask.length - 1
      const answer = new Promise<A | undefined>((resolve) => pending.push({ slot, resolve }))
      mine.set(key, answer)
      this.asking.set(key, answer)
      out.push(answer)
    }
    if (ask.length > 0) {
      const gen = this.generation
      const settle = (answers: readonly A[]): void => {
        for (const p of pending) {
          const key = keys[p.slot] as string
          const a = answers[p.slot]
          if (this.asking.get(key) === mine.get(key)) this.asking.delete(key)
          if (a !== undefined && gen === this.generation && (this.o.keep?.(a) ?? true)) this.remember(key, a, this.now())
          p.resolve(a)
        }
      }
      this.o.resolve(group, ask).then(settle, () => settle([]))
    }
    return Promise.all(out)
  }

  private fresh(key: string, t: number): { a: A; at: number } | null {
    const e = this.answers.get(key)
    if (!e) return null
    if (t - e.at >= this.o.maxAgeMs) {
      this.answers.delete(key)
      return null
    }
    // most recently used last
    this.answers.delete(key)
    this.answers.set(key, e)
    return e
  }

  private remember(key: string, a: A, at: number): void {
    this.answers.delete(key)
    this.answers.set(key, { a, at })
    while (this.answers.size > this.o.max) this.answers.delete(this.answers.keys().next().value as string)
  }
}
