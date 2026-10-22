// The highlight worker: one dedicated Web Worker holding one Shiki instance (shiki.ts). The window sends
// documents (protocol.ts); the engine (engine.ts) tokenises them in chunks and posts each back. The window's client
// starts the worker on first use, recycles it above L.highlightGrammarsMax grammars and ends it when idle, which
// releases the WASM heap and every grammar.
//
// File contents are untrusted input: they are only ever tokenised here, never evaluated.

import { L } from '@kea/protocol/limits'
import { HighlightEngine } from './engine.ts'
import type { FromWorker, ToWorker } from './protocol.ts'
import { ShikiGrammars } from './shiki.ts'

interface WorkerScope {
  postMessage(m: unknown, transfer: Transferable[]): void
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
}
const scope = self as unknown as WorkerScope

const grammars = new ShikiGrammars()

// one channel to come back to the event loop on: messages queued meanwhile are handled first
const tick = new MessageChannel()
let woken: (() => void) | null = null
tick.port1.onmessage = () => {
  const w = woken
  woken = null
  w?.()
}

const engine = new HighlightEngine(
  {
    grammar: (lang) => grammars.grammar(lang),
    roleOf: () => grammars.roleOf(),
    grammars: () => grammars.count(),
    post: (m: FromWorker, transfer) => scope.postMessage(m, transfer),
    now: () => performance.now(),
    yield: () =>
      new Promise<void>((resolve) => {
        woken = resolve
        tick.port2.postMessage(0)
      }),
  },
  // the documents whose marks are kept: the file view's, a diff's two sides, and the window's cache
  { firstLines: L.viewerFirstLines, chunkLines: L.highlightChunkLines, lineMax: L.viewerTokenLineMax, lineMs: L.highlightLineMs, docsMax: L.viewerDocCache + 3 },
)

scope.onmessage = (e) => engine.handle(e.data)
