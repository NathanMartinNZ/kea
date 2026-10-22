// Messages between the window and the highlight worker. The worker tokenises a document's lines in chunks and posts
// each as it is done; the window draws what has arrived. Plain data and typed arrays only.

/** Tokenise `text` as `lang`. A request for a `doc` that has an unfinished one replaces it. */
export interface TokenizeRequest {
  t: 'tokenize'
  /** Names the request in every answer, and in `cancel`. */
  id: number
  /**
   * The document's key. The worker keeps the grammar's state at chunk boundaries per key, so a reload of the same
   * document resumes from the last boundary before its first changed line instead of from the top.
   */
  doc: string
  lang: string
  text: string
  /** The first line (0-based) that may differ from the text last sent under `doc`; 0 for a document sent for the first time. */
  from: number
  /** The tokenising time this request may use in all, or null for no limit. */
  budgetMs: number | null
}

export type ToWorker =
  | TokenizeRequest
  /** Stop a request: nothing more is posted for it (its document is no longer visible). */
  | { t: 'cancel'; id: number }
  /** Drop what is kept for a document (its tab closed, or it left the window's cache). */
  | { t: 'forget'; doc: string }

export type FromWorker =
  /** Lines `[from, to)` of request `id` (tokenizer.ts `TokenChunk`). The first chunk's `from` is where the run started. */
  | { t: 'chunk'; id: number; from: number; to: number; starts: Uint32Array; data: Uint32Array }
  /**
   * The request ended. `stoppedAt`: the number of lines tokenised when the budget ran out, null when it
   * reached the end. `grammars`: grammars the worker has loaded so far (the window recycles it above a limit).
   */
  | { t: 'done'; id: number; lines: number; stoppedAt: number | null; grammars: number }
  /** The request could not run: no grammar for the language, or the tokeniser threw. The document stays plain text. */
  | { t: 'failed'; id: number; message: string; grammars: number }
