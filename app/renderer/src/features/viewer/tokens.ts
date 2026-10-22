// The tokens of one document, as the highlight worker's chunks arrive. The editor asks for one line at a
// time, and only for the lines on screen. Plain data: typed arrays and numbers, kept beside the document in the
// viewer's registries, never in rune state.
//
// A chunk covers a run of lines. The store is a list of segments, each a run of document lines whose tokens are a run
// of one chunk's lines, so:
//   put    a chunk replaces what was known of its lines (a re-tokenised range after a reload);
//   edit   the document changed: the tokens of lines before the change stay, those of the replaced lines go, and the
//          lines after it keep theirs under their new numbers until the worker's fresh ones arrive — text that did not
//          change keeps its colours while the agent writes, instead of flashing plain on every reload.

import { STYLE_BITS } from './syntax.ts'

/** A chunk as the worker posts it (worker/tokenizer.ts `TokenChunk`). */
export interface TokenChunkData {
  from: number
  to: number
  starts: Uint32Array
  data: Uint32Array
}

interface Segment {
  /** First document line (0-based) and how many lines. */
  line: number
  count: number
  chunk: TokenChunkData
  /** The chunk line that is this segment's first line. */
  offset: number
}

/** One line's tokens: `data[from, to)`, each `(start column << STYLE_BITS) | style`. */
export interface LineTokens {
  data: Uint32Array
  from: number
  to: number
}

export const tokenStart = (v: number): number => v >>> STYLE_BITS
export const tokenStyle = (v: number): number => v & ((1 << STYLE_BITS) - 1)

export class TokenStore {
  // bounded: at most one segment per chunk of the document plus two per reload still being re-tokenised; the document
  // itself is capped by the large-file policy, and the store goes with its document
  private segs: Segment[] = []
  /** Changes with every `put`, `edit` and `clear`: the editor redraws when it differs from what it drew. */
  version = 0

  /** The tokens of line `n` (0-based), or null while the worker has not reached it. */
  line(n: number): LineTokens | null {
    const s = this.find(n)
    if (!s) return null
    const i = s.offset + (n - s.line)
    return { data: s.chunk.data, from: s.chunk.starts[i] as number, to: s.chunk.starts[i + 1] as number }
  }

  /** Whether line `n` has tokens. */
  has(n: number): boolean {
    return this.find(n) !== null
  }

  put(chunk: TokenChunkData): void {
    const count = chunk.to - chunk.from
    if (count <= 0) return
    this.cut(chunk.from, chunk.to)
    const at = this.segs.findIndex((s) => s.line >= chunk.to)
    this.segs.splice(at < 0 ? this.segs.length : at, 0, { line: chunk.from, count, chunk, offset: 0 })
    this.version++
  }

  /** Lines `[from, oldTo)` were replaced by lines `[from, newTo)`. */
  edit(from: number, oldTo: number, newTo: number): void {
    this.cut(from, oldTo)
    const delta = newTo - oldTo
    if (delta !== 0) for (const s of this.segs) if (s.line >= oldTo) s.line += delta
    this.version++
  }

  clear(): void {
    this.segs = []
    this.version++
  }

  /** Lines that have tokens. */
  get lines(): number {
    let n = 0
    for (const s of this.segs) n += s.count
    return n
  }

  /** Bytes held: each chunk still referenced counts whole (its buffers stay alive while any line of it is used). */
  get bytes(): number {
    const seen = new Set<TokenChunkData>()
    let n = 0
    for (const s of this.segs) {
      if (seen.has(s.chunk)) continue
      seen.add(s.chunk)
      n += s.chunk.data.byteLength + s.chunk.starts.byteLength
    }
    return n
  }

  get segments(): number {
    return this.segs.length
  }

  private find(n: number): Segment | null {
    let lo = 0
    let hi = this.segs.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = this.segs[mid] as Segment
      if (n < s.line) hi = mid - 1
      else if (n >= s.line + s.count) lo = mid + 1
      else return s
    }
    return null
  }

  /** Forget the tokens of lines `[from, to)`: segments inside go, segments across an edge are trimmed or split. */
  private cut(from: number, to: number): void {
    if (to <= from) return
    const out: Segment[] = []
    for (const s of this.segs) {
      const end = s.line + s.count
      if (end <= from || s.line >= to) {
        out.push(s)
        continue
      }
      if (s.line < from) out.push({ line: s.line, count: from - s.line, chunk: s.chunk, offset: s.offset })
      if (end > to) out.push({ line: to, count: end - to, chunk: s.chunk, offset: s.offset + (to - s.line) })
    }
    this.segs = out
  }
}
