// The colours of a document the user edits: one `EditTokens` per editable document, kept with the document while it is
// on screen, in the window's cache or among its unsaved files. The viewer's controller makes it, tells it of every
// change and of the document coming on and off screen, and disposes of it when the document leaves the window. A plain
// object in the viewer's registries, never rune state.
//
// · The highlight plugin moves the store's tokens with each change at once (highlight.ts `followEdits`: the edited
//   lines keep their colours, stale). The changes are gathered here until the next animation frame.
// · At most once per frame a request goes to the worker: the whole text, the line edits since the previous request and
//   the document's change count. The worker tokenises from each edited line until a line ends as it ended before
//   (worker/engine.ts), so typing in a line usually tokenises that line alone.
// · Chunks go into the store as they arrive and are drawn once per frame. A chunk of a request the text changed after
//   is numbered for the old text: it is dropped, and the next request says how many were put, so the worker tokenises
//   the rest again.
// · Hidden, the request is cancelled; shown again, what is not done is asked for. A worker recycled, ended when idle or
//   crashed has lost the line states: the next request starts from the top, as does a text the tokeniser did not follow.

import type { ChangeSet, EditorState, StateEffect, Text } from '@codemirror/state'
import type { HighlightClient, HighlightHandle } from './client.ts'
import { lineEdits, tokensArrived, tokenStore } from './highlight.ts'
import { highlighter } from './highlighter.ts'
import type { TokenStore } from './tokens.ts'
import type { EditRun } from './worker/protocol.ts'

/** Animation frames (the tests give their own). */
export interface FrameHost {
  request(fn: () => void): unknown
  cancel(handle: unknown): void
}

/** A change of the editor that shows the document: a `ViewUpdate`. */
export interface DocChange {
  docChanged: boolean
  changes: ChangeSet
  startState: { doc: Text }
  state: { doc: Text }
}

/** The editor that shows the document (an `EditorView`). */
export interface TokenView {
  readonly state: EditorState
  dispatch(spec: { effects: StateEffect<null> }): void
}

export interface EditTokensOptions {
  /** The worker's document key: the one the document's read-only requests use. */
  doc: string
  lang: string
  store: TokenStore
  budgetMs?: number | null
  /** Tokens arrived and were drawn. */
  onTokens?(): void
  /** A request ended: as `HighlightJob.onDone`. */
  onDone?(r: { stoppedAt: number | null; failed: string | null }): void
  client?: Pick<HighlightClient, 'tokenize'>
  frames?: FrameHost
}

const animationFrames: FrameHost = {
  request: (fn) => requestAnimationFrame(fn),
  cancel: (h) => cancelAnimationFrame(h as number),
}

export class EditTokens {
  private readonly o: EditTokensOptions
  private readonly client: Pick<HighlightClient, 'tokenize'>
  private readonly frames: FrameHost
  private view: TokenView | null = null
  /** The text as last followed. */
  private doc: Text | null = null
  /** The text the last request carried (null: the next request starts from the top), and the changes made since. */
  private sent: Text | null = null
  private changes: ChangeSet | null = null
  /** The document's change count, and the count the last request carried. */
  private count = 0
  private sentCount = 0
  /** The text changed since the last request. */
  private unsent = true
  /** The request in flight. `moved`: the text changed after it was sent, so what still arrives for it is dropped. */
  private job: HighlightHandle | null = null
  private jobId = 0
  private moved = false
  /** Chunks of the last request put in the store. */
  private applied = 0
  /** The last request ran to its end before the text changed. */
  private done = false
  private frame: unknown = null
  /** Tokens went into the store since the last draw. */
  private arrived = false
  private disposed = false

  constructor(o: EditTokensOptions) {
    this.o = o
    this.client = o.client ?? highlighter()
    this.frames = o.frames ?? animationFrames
  }

  /** The store holds the worker's tokens for the text as it is: nothing is running or waiting for a frame. */
  get settled(): boolean {
    return this.done && !this.unsent
  }

  /** The document is on screen in `view`: what is not tokenised yet is asked for at once. */
  show(view: TokenView): void {
    if (this.disposed) return
    this.view = view
    if (view.state.doc !== this.doc) this.restart(view.state.doc)
    if (!this.settled) this.send()
  }

  /** The editor that shows the document updated (every `ViewUpdate`, in order; those that leave the text alone are ignored). */
  changed(u: DocChange): void {
    if (this.disposed || !u.docChanged) return
    this.count++
    if (this.doc === null || u.startState.doc !== this.doc) this.restart(u.state.doc)
    else {
      this.changes = this.changes ? this.changes.compose(u.changes) : u.changes
      this.doc = u.state.doc
    }
    this.unsent = true
    this.done = false
    if (this.job) this.moved = true
    this.schedule()
  }

  /** The document left the screen: its request is cancelled, and nothing is drawn. */
  hide(): void {
    this.view = null
    this.arrived = false
    if (this.frame !== null) {
      this.frames.cancel(this.frame)
      this.frame = null
    }
    this.job?.cancel()
    this.job = null
  }

  /**
   * The store was emptied and the worker told to forget the document (it left the screen with unsaved text): when it is
   * shown again its colours are asked for from the top.
   */
  dropped(): void {
    this.hide()
    this.doc = null
    this.sent = null
    this.changes = null
    this.unsent = true
    this.done = false
  }

  /** The document left the window. What the worker keeps for it goes with `HighlightClient.forget`, as for any document. */
  dispose(): void {
    if (this.disposed) return
    this.hide()
    this.disposed = true
    this.doc = null
    this.sent = null
    this.changes = null
  }

  /** The text is not the one followed: the next request starts from the top. */
  private restart(doc: Text): void {
    this.doc = doc
    this.sent = null
    this.changes = null
    this.unsent = true
    this.done = false
  }

  private schedule(): void {
    if (this.frame !== null || !this.view) return
    this.frame = this.frames.request(() => this.onFrame())
  }

  private onFrame(): void {
    this.frame = null
    const view = this.view
    if (!view || this.disposed) return
    if (this.unsent) this.send()
    if (!this.arrived) return
    this.arrived = false
    // (the editor shows this document unless the controller has not said it left yet)
    if (view.state.facet(tokenStore) === this.o.store) view.dispatch({ effects: tokensArrived.of(null) })
    this.o.onTokens?.()
  }

  private send(): void {
    const doc = this.doc
    if (!this.view || this.disposed || !doc) return
    const from = this.sent
    const edit: EditRun = {
      since: from === null ? null : this.sentCount,
      count: this.count,
      edits: from !== null && this.changes ? lineEdits(this.changes, from, doc) : [],
      applied: this.applied,
    }
    this.sent = doc
    this.changes = null
    this.sentCount = this.count
    this.unsent = false
    this.done = false
    this.moved = false
    this.applied = 0
    const id = ++this.jobId
    this.job = this.client.tokenize({
      doc: this.o.doc,
      lang: this.o.lang,
      text: doc.toString(),
      from: edit.edits[0]?.from ?? 0,
      budgetMs: this.o.budgetMs ?? null,
      edit,
      onChunk: (c) => {
        if (id !== this.jobId || this.moved) return
        this.o.store.put(c)
        this.applied++
        this.arrived = true
        this.schedule()
      },
      onDone: (r) => {
        if (id !== this.jobId) return
        this.job = null
        if (!this.moved) this.done = true
        this.o.onDone?.(r)
      },
      onRestart: () => {
        if (id === this.jobId) this.applied = 0
      },
    })
  }
}
