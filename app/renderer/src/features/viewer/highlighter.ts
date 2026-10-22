// The window's one highlight client, made on first use: a plain object in module state. The worker itself starts with
// the first request (client.ts).

import { HighlightClient, type HighlightHandle, type WorkerLike } from './client.ts'
import { TokenStore } from './tokens.ts'

let client: HighlightClient | null = null

export function highlighter(): HighlightClient {
  return (client ??= new HighlightClient({
    spawn: () => new Worker(new URL('./worker/highlight.worker.ts', import.meta.url), { type: 'module', name: 'kea-highlight' }) as unknown as WorkerLike,
  }))
}

/** The client's numbers for the resource report; zeros before the first use. */
export function highlighterStats(): HighlightClient['stats'] {
  return client?.stats ?? { workers: 0, pending: 0, starts: 0, grammars: 0, idleTimers: 0 }
}

export interface TokenizeInto {
  doc: string
  lang: string
  text: string
  from: number
  budgetMs: number | null
  store: TokenStore
  /** Tokens were added to `store`: draw. */
  onTokens(): void
  onDone(r: { stoppedAt: number | null; failed: string | null }): void
}

/** Tokenise a document into its store, chunk by chunk. */
export function tokenizeInto(t: TokenizeInto): HighlightHandle {
  return highlighter().tokenize({
    doc: t.doc,
    lang: t.lang,
    text: t.text,
    from: t.from,
    budgetMs: t.budgetMs,
    onChunk: (chunk) => {
      t.store.put(chunk)
      t.onTokens()
    },
    onDone: t.onDone,
  })
}
