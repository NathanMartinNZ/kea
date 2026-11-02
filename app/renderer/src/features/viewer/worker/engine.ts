// The highlight worker's scheduler: requests are tokenised a chunk at a time — the first L.viewerFirstLines lines, then
// L.highlightChunkLines per chunk — and between chunks the worker returns to its event loop, so a `cancel` or a newer
// request is seen before the next chunk starts. A cancelled request posts nothing more. Several requests take turns,
// chunk by chunk (a diff tokenises both of its sides).
//
// Per document key the grammar's state at each chunk boundary is kept ("marks"), so a reload resumes from the last
// boundary before its first changed line and its unchanged first part is not tokenised again.
//
// A document the user edits (a request with `edit`, protocol.ts `EditRun`) keeps instead the state at the end of every
// line, and the line ranges still to tokenise. Each request moves both through its edits; the run tokenises each range,
// and the lines after it until one ends in the state recorded for it, so typing in a line usually tokenises that line
// alone. Lines posted to a window that did not put them in its store are tokenised again on its next request.
//
// No DOM and no worker globals: the worker entry (highlight.worker.ts) gives it the grammars, the clock, the way to
// post and the way to yield, and the unit tests give it theirs.

import { INITIAL, type IGrammar, type StateStack } from 'shiki/textmate'
import type { EditRun, FromWorker, LineEdit, ToWorker, TokenizeRequest } from './protocol.ts'
import { LineTokenizer, splitLines } from './tokenizer.ts'

export interface EngineLimits {
  /** The lines of a document's first chunk, and of an edit run's. */
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

/** What is kept for an editable document, numbered in the text of the last request for it. */
interface EditState {
  /**
   * The grammar's state at the end of each line, one per line; undefined where it is not known. The last line of a
   * range still to tokenise holds the state the lines after it were tokenised from, to compare with.
   */
  ends: (StateStack | undefined)[]
  /**
   * Line ranges still to tokenise, as `[from, to)` pairs: ascending, apart, never empty, and never starting where a
   * line's end state is unknown. A range's lines are tokenised, then the lines after it until one ends in the state
   * recorded for it; the recorded end of a range's last line is the one the lines after it were tokenised from.
   */
  dirty: number[]
  /** The document's change count the states are for. */
  count: number
  /** The chunks posted for the last request, as `[from, to)` pairs in the order posted. */
  posted: number[]
}

interface DocMarks {
  lang: string
  /** Ascending by line; the first is line 0 in the initial state. */
  marks: Mark[]
  /** Kept instead of the marks for a document the user edits. */
  edit: EditState | null
}

interface Job {
  req: TokenizeRequest
  lines: string[]
  next: number
  state: StateStack
  spentMs: number
  tokenizer: LineTokenizer | null
  doc: DocMarks
  /** No chunk posted yet: the first is L.viewerFirstLines long. */
  first: boolean
  /** Cancelled, forgotten or replaced by a newer request for its document: it posts nothing more. */
  dropped: boolean
}

export class HighlightEngine {
  private readonly host: EngineHost
  private readonly limits: EngineLimits
  // bounded: one per unfinished request; a document has at most one (a newer request replaces it), and the window
  // sends requests only for the documents on screen
  private readonly jobs: Job[] = []
  // bounded: `limits.docsMax` documents, least recently tokenised first out; each holds one mark per chunk of its
  // document, or for an editable document one end state per line and its ranges and chunks, at most one per line
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

  /** Lines whose end state is kept for an editable document (0: none, or not an editable document). */
  endStates(doc: string): number {
    return this.docs.get(doc)?.edit?.ends.length ?? 0
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
    if (!doc || doc.lang !== req.lang) doc = { lang: req.lang, marks: [{ line: 0, state: INITIAL }], edit: null }
    // most recently used last; over the cap, the oldest document's marks go
    this.docs.delete(req.doc)
    this.docs.set(req.doc, doc)
    while (this.docs.size > this.limits.docsMax) this.docs.delete(this.docs.keys().next().value as string)
    const lines = splitLines(req.text)
    if (req.edit) {
      doc.edit = followRun(doc.edit, req.edit, lines.length)
      doc.marks.length = 1
      this.jobs.push({ req, lines, next: 0, state: INITIAL, spentMs: 0, tokenizer: null, doc, first: true, dropped: false })
      void this.pump()
      return
    }
    doc.edit = null
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
    this.jobs.push({ req, lines, next: Math.min(mark.line, lines.length), state: mark.state, spentMs: 0, tokenizer: null, doc, first: mark.line === 0, dropped: false })
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
    const edit = job.req.edit ? job.doc.edit : null
    if (edit) return this.stepEdit(job, job.tokenizer, edit)
    const total = job.lines.length
    const size = job.first ? this.limits.firstLines : this.limits.chunkLines
    job.first = false
    const to = Math.min(total, job.next + size)
    const t0 = this.host.now()
    const r = job.tokenizer.run(job.lines, job.next, to, job.state)
    job.spentMs += this.host.now() - t0
    job.state = r.state
    job.next = to
    if (to < total) job.doc.marks.push({ line: to, state: r.state })
    this.post(job, r.chunk)
    const over = job.req.budgetMs !== null && job.spentMs >= job.req.budgetMs
    if (to < total && !over) return false
    this.host.post({ t: 'done', id: job.req.id, lines: total, stoppedAt: to >= total ? null : to, grammars: this.host.grammars() }, [])
    return true
  }

  /** One chunk of an edit run: from the first range still to tokenise, until its lines end as recorded, the chunk's size or the end. */
  private stepEdit(job: Job, tokenizer: LineTokenizer, e: EditState): boolean {
    const total = job.lines.length
    const d = e.dirty
    if (d.length === 0) {
      this.host.post({ t: 'done', id: job.req.id, lines: total, stoppedAt: null, grammars: this.host.grammars() }, [])
      return true
    }
    const from = d[0] as number
    const state = from === 0 ? INITIAL : e.ends[from - 1]
    if (!state) {
      // a range always starts after a line whose end is known; should one not, everything is tokenised again
      e.ends = new Array<StateStack | undefined>(total)
      e.dirty = [0, total]
      return false
    }
    const size = job.first ? this.limits.firstLines : this.limits.chunkLines
    job.first = false
    let matched = false
    const t0 = this.host.now()
    const r = tokenizer.run(job.lines, from, Math.min(total, from + size), state, (n, end) => {
      const old = e.ends[n]
      e.ends[n] = end
      // a range that starts on the next line joins this one: its lines are tokenised from this end state
      while (d.length > 2 && (d[2] as number) <= n + 1) {
        d[1] = Math.max(d[1] as number, d[3] as number)
        d.splice(2, 2)
      }
      // from the range's last line on, a line that ends as it ended before leaves the lines after it as they are
      matched = n + 1 >= (d[1] as number) && old !== undefined && end.equals(old)
      return matched
    })
    job.spentMs += this.host.now() - t0
    if (r.chunk.to >= total) d.length = 0
    else if (matched) d.splice(0, 2)
    else {
      // the rest of the range; past its last line, the next line is compared with the end recorded for it, which is
      // what the lines after it were tokenised from (the line before now holds this run's end)
      d[0] = r.chunk.to
      if ((d[1] as number) <= r.chunk.to) d[1] = r.chunk.to + 1
    }
    e.posted.push(r.chunk.from, r.chunk.to)
    this.post(job, r.chunk)
    const over = job.req.budgetMs !== null && job.spentMs >= job.req.budgetMs
    if (d.length > 0 && !over) return false
    this.host.post({ t: 'done', id: job.req.id, lines: total, stoppedAt: d.length === 0 ? null : (d[0] as number), grammars: this.host.grammars() }, [])
    return true
  }

  private post(job: Job, c: { from: number; to: number; starts: Uint32Array; data: Uint32Array }): void {
    this.host.post({ t: 'chunk', id: job.req.id, from: c.from, to: c.to, starts: c.starts, data: c.data }, [c.starts.buffer as ArrayBuffer, c.data.buffer as ArrayBuffer])
  }
}

/**
 * The edit state for a request: the one kept, moved through the request's edits, when the request follows on from the
 * one it was kept for; otherwise a new one, with every line still to tokenise.
 */
function followRun(kept: EditState | null, run: EditRun, total: number): EditState {
  const fresh = (): EditState => ({ ends: new Array<StateStack | undefined>(total), dirty: total > 0 ? [0, total] : [], count: run.count, posted: [] })
  if (!kept || run.since === null || kept.count !== run.since) return fresh()
  const was = kept.ends.length
  let at = 0
  let grows = 0
  for (const ed of run.edits) {
    if (ed.from < at || ed.to < ed.from || ed.to > was || ed.lines < 0) return fresh()
    at = ed.to
    grows += ed.lines - (ed.to - ed.from)
  }
  if (was + grows !== total) return fresh()
  // what the previous request posted and the window did not put in its store is tokenised again
  const ranges = kept.dirty.slice()
  for (let i = Math.max(0, run.applied) * 2; i < kept.posted.length; i += 2) ranges.push(kept.posted[i] as number, kept.posted[i + 1] as number)
  const ends = grows === 0 && run.edits.every((ed) => ed.lines === ed.to - ed.from) ? kept.ends : []
  if (ends === kept.ends) {
    // the same line count everywhere: the edited lines' ends are let go in place, the last of each kept to compare with
    for (const ed of run.edits) for (let i = ed.from; i < ed.to - 1; i++) ends[i] = undefined
  } else {
    at = 0
    for (const ed of run.edits) {
      for (let i = at; i < ed.from; i++) ends.push(kept.ends[i])
      for (let i = 1; i < ed.lines; i++) ends.push(undefined)
      // the edit's last line takes the end of the last line it replaced (or, for lines put in, of the line before them):
      // the lines after it were tokenised from that
      if (ed.lines > 0) ends.push(ed.to > ed.from ? kept.ends[ed.to - 1] : ed.from > 0 ? kept.ends[ed.from - 1] : INITIAL)
      at = ed.to
    }
    for (let i = at; i < was; i++) ends.push(kept.ends[i])
  }
  return { ends, dirty: movedRanges(merged(ranges), run.edits, total), count: run.count, posted: [] }
}

/** `[from, to)` pairs sorted and joined where they overlap or meet. */
function merged(ranges: number[]): number[] {
  const pairs: [number, number][] = []
  for (let i = 0; i < ranges.length; i += 2) pairs.push([ranges[i] as number, ranges[i + 1] as number])
  pairs.sort((a, b) => a[0] - b[0])
  const out: number[] = []
  for (const [from, to] of pairs) {
    const n = out.length
    if (n > 0 && from <= (out[n - 1] as number)) out[n - 1] = Math.max(out[n - 1] as number, to)
    else out.push(from, to)
  }
  return out
}

/** Ranges of the old lines moved through `edits`, with each edit's new lines added and everything past `total` cut. */
function movedRanges(ranges: number[], edits: readonly LineEdit[], total: number): number[] {
  if (edits.length === 0) return clipped(ranges, total)
  // where each edit's new lines start
  const starts: number[] = []
  let delta = 0
  for (const ed of edits) {
    starts.push(ed.from + delta)
    delta += ed.lines - (ed.to - ed.from)
  }
  /** Old line `x` now: its new number and the edit it is inside, if any. */
  const locate = (x: number): { line: number; inside: number } => {
    let lo = 0
    let hi = edits.length - 1
    let i = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((edits[mid] as LineEdit).from <= x) {
        i = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (i < 0) return { line: x, inside: -1 }
    const ed = edits[i] as LineEdit
    if (x < ed.to) return { line: starts[i] as number, inside: i }
    return { line: (starts[i] as number) + ed.lines + (x - ed.to), inside: -1 }
  }
  const out: number[] = []
  for (let i = 0; i < ranges.length; i += 2) {
    const from = ranges[i] as number
    const last = locate(Math.max(from, (ranges[i + 1] as number) - 1))
    out.push(locate(from).line, last.inside >= 0 ? (starts[last.inside] as number) + (edits[last.inside] as LineEdit).lines : last.line + 1)
  }
  // each edit's new lines; an edit that leaves none has the line after it compared
  for (let i = 0; i < edits.length; i++) out.push(starts[i] as number, (starts[i] as number) + Math.max(1, (edits[i] as LineEdit).lines))
  return clipped(merged(out), total)
}

function clipped(ranges: number[], total: number): number[] {
  const out: number[] = []
  for (let i = 0; i < ranges.length; i += 2) {
    const from = ranges[i] as number
    if (from >= total) break
    out.push(from, Math.min(total, ranges[i + 1] as number))
  }
  return out
}
