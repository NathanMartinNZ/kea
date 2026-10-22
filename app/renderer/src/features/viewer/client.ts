// The window's side of the highlight worker: it owns the one worker, follows the lifecycle table (lifecycle.ts) and
// passes documents to tokenise and their chunks back. A plain object in a plain registry, never rune state.
//
// · The worker starts with the first request and not before.
// · A request's chunks go to its `onChunk`; `cancel()` stops it, and whatever still arrives for it is dropped
//   (a document that is no longer visible is cancelled by whoever asked).
// · `setVisible(false)` — no file or diff tab on screen — starts the idle timer; when it fires the worker is
//   terminated, and the next request starts a fresh one.
// · When the worker says it holds more grammars than the limit it is terminated at once and the requests still
//   running are sent again to a fresh worker, from their first line (their marks went with the old one).
// · A worker error ends the worker and fails the requests it had: their documents stay plain text.

import { L } from '@kea/protocol/limits'
import { createWorkerLifecycle, type WorkerState } from './lifecycle.ts'
import type { TokenChunkData } from './tokens.ts'
import type { FromWorker, ToWorker } from './worker/protocol.ts'

/** What the client needs of a Worker (the tests' stand-in implements it). */
export interface WorkerLike {
  postMessage(m: ToWorker): void
  terminate(): void
  onmessage: ((e: { data: FromWorker }) => void) | null
  onerror: ((e: unknown) => void) | null
}

export interface TimerHost {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface HighlightJob {
  /** The worker's document key (worker/protocol.ts): the same key again means a reload of the same document. */
  doc: string
  lang: string
  text: string
  /** The first line that may differ from the text last sent under `doc`. */
  from: number
  budgetMs: number | null
  onChunk(chunk: TokenChunkData): void
  /** `stoppedAt`: `budgetMs` ran out after that many lines; null: all of it. `failed`: it stays plain text. */
  onDone(r: { stoppedAt: number | null; failed: string | null }): void
}

export interface HighlightHandle {
  cancel(): void
}

export interface HighlightClientOptions {
  spawn(): WorkerLike
  timers?: TimerHost
  idleMs?: number
  grammarsMax?: number
}

const systemTimers: TimerHost = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

export class HighlightClient {
  private readonly o: HighlightClientOptions
  private readonly timers: TimerHost
  private readonly fsm = createWorkerLifecycle((rec) => this.moved(rec.from, rec.to))
  private worker: WorkerLike | null = null
  private idle: unknown = null
  private nextId = 1
  // bounded: one per request not finished or cancelled; the viewer has at most one per document on screen (a file,
  // a diff's two sides, a Markdown preview's fences one at a time)
  private readonly jobs = new Map<number, HighlightJob>()
  private startCount = 0
  private grammars = 0
  private visible = false

  constructor(o: HighlightClientOptions) {
    this.o = o
    this.timers = o.timers ?? systemTimers
  }

  get state(): WorkerState {
    return this.fsm.state
  }

  /** For the resource report and the leak tests. */
  get stats(): { workers: number; pending: number; starts: number; grammars: number; idleTimers: number } {
    return { workers: this.worker ? 1 : 0, pending: this.jobs.size, starts: this.startCount, grammars: this.worker ? this.grammars : 0, idleTimers: this.idle === null ? 0 : 1 }
  }

  tokenize(job: HighlightJob): HighlightHandle {
    const id = this.nextId++
    // a request for a document that has an unfinished one replaces it (worker/protocol.ts): the worker posts nothing
    // more for the older one, so it must not stay waiting here
    for (const [older, j] of this.jobs) if (j.doc === job.doc) this.jobs.delete(older)
    this.jobs.set(id, job)
    this.fsm.send({ t: 'request' })
    // a request made while nothing is visible (a tab hidden in the same breath) must not keep the worker for ever
    if (!this.visible) this.fsm.send({ t: 'hidden' })
    this.send(id, job, job.from)
    return {
      cancel: () => {
        if (!this.jobs.delete(id)) return
        this.worker?.postMessage({ t: 'cancel', id })
      },
    }
  }

  /** Drop what the worker keeps for a document (its tab closed, or it left the window's cache). */
  forget(doc: string): void {
    for (const [id, job] of this.jobs) if (job.doc === doc) this.jobs.delete(id)
    this.worker?.postMessage({ t: 'forget', doc })
  }

  /** A file or diff tab is on screen, or none is. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.fsm.send({ t: visible ? 'shown' : 'hidden' })
  }

  dispose(): void {
    this.jobs.clear()
    this.clearIdle()
    this.stop()
  }

  private send(id: number, job: HighlightJob, from: number): void {
    this.worker?.postMessage({ t: 'tokenize', id, doc: job.doc, lang: job.lang, text: job.text, from, budgetMs: job.budgetMs })
  }

  /** What a change of state means for the worker and the timer. */
  private moved(from: WorkerState, to: WorkerState): void {
    if (from === 'idle') this.clearIdle()
    if (to === 'idle')
      this.idle = this.timers.setTimeout(() => {
        this.idle = null
        this.fsm.send({ t: 'timeout' })
        // nothing was visible for the whole wait, so nobody is waiting for these: they end with the worker
        const left = [...this.jobs.values()]
        this.jobs.clear()
        for (const j of left) j.onDone({ stoppedAt: null, failed: 'the highlight worker went idle' })
      }, this.o.idleMs ?? L.highlightIdleMs)
    if (to === 'off') this.stop()
    if (from === 'off') this.start()
  }

  private start(): void {
    const w = this.o.spawn()
    this.worker = w
    this.startCount++
    this.grammars = 0
    w.onmessage = (e) => {
      if (this.worker === w) this.received(e.data)
    }
    w.onerror = () => {
      if (this.worker !== w) return
      const failed = [...this.jobs.values()]
      this.jobs.clear()
      this.fsm.send({ t: 'crashed' })
      for (const j of failed) j.onDone({ stoppedAt: null, failed: 'the highlight worker stopped' })
    }
  }

  private stop(): void {
    const w = this.worker
    if (!w) return
    this.worker = null
    w.onmessage = null
    w.onerror = null
    w.terminate()
  }

  private clearIdle(): void {
    if (this.idle === null) return
    this.timers.clearTimeout(this.idle)
    this.idle = null
  }

  private received(m: FromWorker): void {
    const job = this.jobs.get(m.id)
    if (m.t === 'chunk') {
      job?.onChunk(m)
      return
    }
    this.grammars = m.grammars
    if (job) {
      this.jobs.delete(m.id)
      job.onDone(m.t === 'done' ? { stoppedAt: m.stoppedAt, failed: null } : { stoppedAt: null, failed: m.message })
    }
    if (m.grammars > (this.o.grammarsMax ?? L.highlightGrammarsMax)) this.recycle()
  }

  /** End the worker above the grammar limit; the requests still running start again on a fresh one. */
  private recycle(): void {
    this.fsm.send({ t: 'over' })
    if (this.jobs.size === 0) return
    this.fsm.send({ t: 'request' })
    if (!this.visible) this.fsm.send({ t: 'hidden' })
    for (const [id, job] of this.jobs) this.send(id, job, 0)
  }
}
