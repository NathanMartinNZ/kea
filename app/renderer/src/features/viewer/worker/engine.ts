// The highlight worker's scheduler: requests are tokenised a chunk at a time — the first L.viewerFirstLines lines, then
// L.highlightChunkLines per chunk — and between chunks the worker returns to its event loop, so a `cancel` or a newer
// request is seen before the next chunk starts. A cancelled request posts nothing more. Several requests take turns,
// chunk by chunk (a diff tokenises both of its sides).
//
// Per document key the grammar's state at each chunk boundary is kept ("marks"), so a reload resumes from the last
// boundary before its first changed line and its unchanged first part is not tokenised again.
//
// No DOM and no worker globals: the worker entry (highlight.worker.ts) gives it the grammars, the clock, the way to
// post and the way to yield, and the unit tests give it theirs.

import { INITIAL, type IGrammar, type StateStack } from 'shiki/textmate'
import type { FromWorker, ToWorker, TokenizeRequest } from './protocol.ts'
import { LineTokenizer, splitLines } from './tokenizer.ts'

export interface EngineLimits {
  /** The lines of a document's first chunk. */
  firstLines: number
  /** The lines of each later chunk. */
  chunkLines: number
  /** A longer line is not tokenised. */
  lineMax: number
  /** One line's tokenising stops after this long. */
  lineMs: number
  /** Documents whose marks are kept (the window's visible documents and its cache). */
  docsMax: number
}

export interface EngineHost {
  /** The grammar of a language id, loaded on first use; null when the worker has none for it. */
  grammar(lang: string): Promise<IGrammar | null>
  /** Role index per theme colour id (syntax.ts). */
  roleOf(): Uint8Array
  /** Grammars loaded so far. */
  grammars(): number
  post(msg: FromWorker, transfer: Transferable[]): void
  now(): number
  /** Return to the event loop once, so queued messages are handled. */
  yield(): Promise<void>
}

interface Mark {
  /** The state before this line. */
  line: number
  state: StateStack
}

interface DocMarks {
  lang: string
  /** Ascending by line; the first is line 0 in the initial state. */
  marks: Mark[]
}

interface Job {
  req: TokenizeRequest
  lines: string[]
  next: number
  state: StateStack
  spentMs: number
  tokenizer: LineTokenizer | null
  doc: DocMarks
  /** Cancelled, forgotten or replaced by a newer request for its document: it posts nothing more. */
  dropped: boolean
}

export class HighlightEngine {
  private readonly host: EngineHost
  private readonly limits: EngineLimits
  // bounded: one per unfinished request; a document has at most one (a newer request replaces it), and the window
  // sends requests only for the documents on screen
  private readonly jobs: Job[] = []
  // bounded: `limits.docsMax` documents, least recently tokenised first out; each holds one mark per chunk of its document
  private readonly docs = new Map<string, DocMarks>()
  private pumping = false

  constructor(host: EngineHost, limits: EngineLimits) {
    this.host = host
    this.limits = limits
  }

  /** Unfinished requests. */
  get pending(): number {
    return this.jobs.length
  }

  /** Documents whose marks are kept. */
  get documents(): number {
    return this.docs.size
  }

  handle(m: ToWorker): void {
    switch (m.t) {
      case 'tokenize':
        this.start(m)
        return
      case 'cancel':
        this.drop((j) => j.req.id === m.id)
        return
      case 'forget':
        this.drop((j) => j.req.doc === m.doc)
        this.docs.delete(m.doc)
        return
    }
  }

  private drop(which: (j: Job) => boolean): void {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i] as Job
      if (!which(j)) continue
      j.dropped = true
      this.jobs.splice(i, 1)
    }
  }

  private start(req: TokenizeRequest): void {
    this.drop((j) => j.req.doc === req.doc)
    let doc = this.docs.get(req.doc)
    if (!doc || doc.lang !== req.lang) doc = { lang: req.lang, marks: [{ line: 0, state: INITIAL }] }
    // most recently used last; over the cap, the oldest document's marks go
    this.docs.delete(req.doc)
    this.docs.set(req.doc, doc)
    while (this.docs.size > this.limits.docsMax) this.docs.delete(this.docs.keys().next().value as string)
    // resume from the last mark at or before the first line that may have changed; later marks are stale
    let at = 0
    for (let i = doc.marks.length - 1; i >= 0; i--) {
      if ((doc.marks[i] as Mark).line <= req.from) {
        at = i
        break
      }
    }
    doc.marks.length = at + 1
    const mark = doc.marks[at] as Mark
    const lines = splitLines(req.text)
    this.jobs.push({ req, lines, next: Math.min(mark.line, lines.length), state: mark.state, spentMs: 0, tokenizer: null, doc, dropped: false })
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const job = this.jobs[0]
        if (!job) return
        let finished = true
        try {
          finished = await this.step(job)
        } catch (e) {
          if (!job.dropped) this.host.post({ t: 'failed', id: job.req.id, message: e instanceof Error ? e.message : String(e), grammars: this.host.grammars() }, [])
        }
        if (!job.dropped) {
          // done: it leaves; unfinished: to the back, so several requests take turns
          const i = this.jobs.indexOf(job)
          if (i >= 0) this.jobs.splice(i, 1)
          if (!finished) this.jobs.push(job)
        }
        // back to the event loop: a cancel or a newer request is handled before the next chunk
        await this.host.yield()
      }
    } finally {
      this.pumping = false
    }
  }

  /** One chunk of `job`; true when the request has ended (it reached the end, its budget, or cannot run). */
  private async step(job: Job): Promise<boolean> {
    if (!job.tokenizer) {
      const grammar = await this.host.grammar(job.req.lang)
      if (job.dropped) return true
      if (!grammar) {
        this.host.post({ t: 'failed', id: job.req.id, message: `no grammar for ${job.req.lang}`, grammars: this.host.grammars() }, [])
        return true
      }
      job.tokenizer = new LineTokenizer(grammar, this.host.roleOf(), { lineMax: this.limits.lineMax, lineMs: this.limits.lineMs })
    }
    const total = job.lines.length
    const size = job.next === 0 ? this.limits.firstLines : this.limits.chunkLines
    const to = Math.min(total, job.next + size)
    const t0 = this.host.now()
    const r = job.tokenizer.run(job.lines, job.next, to, job.state)
    job.spentMs += this.host.now() - t0
    job.state = r.state
    job.next = to
    if (to < total) job.doc.marks.push({ line: to, state: r.state })
    this.host.post({ t: 'chunk', id: job.req.id, from: r.chunk.from, to: r.chunk.to, starts: r.chunk.starts, data: r.chunk.data }, [r.chunk.starts.buffer as ArrayBuffer, r.chunk.data.buffer as ArrayBuffer])
    const over = job.req.budgetMs !== null && job.spentMs >= job.req.budgetMs
    if (to < total && !over) return false
    this.host.post({ t: 'done', id: job.req.id, lines: total, stoppedAt: to >= total ? null : to, grammars: this.host.grammars() }, [])
    return true
  }
}
