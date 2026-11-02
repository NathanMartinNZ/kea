// The tokens of one document, as the highlight worker's chunks arrive. The editor asks for one line at a
// time, and only for the lines on screen. Plain data: typed arrays and numbers, kept beside the document in the
// viewer's registries, never in rune state.
//
// A chunk covers a run of lines. The store is a list of segments, each a run of document lines whose tokens are a run
// of one chunk's lines, so:
//   put     a chunk replaces what was known of its lines (a re-tokenised range after a reload, or after an edit);
//   follow  the document changed: the tokens of lines before a change stay, those of the replaced lines go, and the
//           lines after it keep theirs under their new numbers until the worker's fresh ones arrive — text that did not
//           change keeps its colours while the agent writes, instead of flashing plain on every reload. Lines the user
//           edits can keep their old colours moved to their new columns ("shifted"): those are stale, and are not
//           counted in `lines`, until a chunk replaces them.

import type { LineEdit } from './worker/protocol.ts'
import { STYLE_BITS } from './syntax.ts'

/** A chunk as the worker posts it (worker/tokenizer.ts `TokenChunk`). */
export interface TokenChunkData {
  from: number
  to: number
  starts: Uint32Array
  data: Uint32Array
}

/** Edited lines that keep their colours: line `lines[i]` (new numbering, ascending) has the tokens of `chunk`'s line `i`. */
export interface ShiftedLines {
  lines: readonly number[]
  chunk: TokenChunkData
}

interface Segment {
  /** First document line (0-based) and how many lines. */
  line: number
  count: number
  chunk: TokenChunkData
  /** The chunk line that is this segment's first line. */
  offset: number
  /** Colours kept across an edit of these lines, until fresh ones arrive. */
  stale: boolean
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
  // bounded: at most one segment per line of the document, which the large-file policy caps; one per chunk plus a few
  // per place edited or reloaded until the worker's chunks for it arrive. The store goes with its document
  private segs: Segment[] = []
  /** Changes with every `put`, `follow` and `clear`: the editor redraws when it differs from what it drew. */
  version = 0

  /** The tokens of line `n` (0-based), or null while the worker has not reached it. */
  line(n: number): LineTokens | null {
    const s = this.find(n)
    if (!s) return null
    const i = s.offset + (n - s.line)
    return { data: s.chunk.data, from: s.chunk.starts[i] as number, to: s.chunk.starts[i + 1] as number }
  }

  /** Whether line `n` has tokens (stale ones included). */
  has(n: number): boolean {
    return this.find(n) !== null
  }

  put(chunk: TokenChunkData): void {
    const count = chunk.to - chunk.from
    if (count <= 0) return
    this.cut(chunk.from, chunk.to)
    const at = this.segs.findIndex((s) => s.line >= chunk.to)
    this.segs.splice(at < 0 ? this.segs.length : at, 0, { line: chunk.from, count, chunk, offset: 0, stale: false })
    this.version++
  }

  /**
   * The document's lines changed by `edits` (numbered in the old document: ascending and apart): the replaced lines'
   * tokens go and the lines after each edit move with it, in one pass. `shifted` lines (new numbering) then take the
   * colours they kept, stale until fresh ones arrive.
   */
  follow(edits: readonly LineEdit[], shifted: ShiftedLines | null = null): void {
    const out: Segment[] = []
    let e = 0
    let delta = 0
    for (const s of this.segs) {
      let line = s.line
      let offset = s.offset
      const end = s.line + s.count
      while (line < end) {
        // the edits before this line move it
        while (e < edits.length && (edits[e] as LineEdit).to <= line) {
          const ed = edits[e] as LineEdit
          delta += ed.lines - (ed.to - ed.from)
          e++
        }
        const ed = edits[e]
        if (!ed || ed.from >= end) {
          out.push({ line: line + delta, count: end - line, chunk: s.chunk, offset, stale: s.stale })
          break
        }
        if (ed.from > line) {
          out.push({ line: line + delta, count: ed.from - line, chunk: s.chunk, offset, stale: s.stale })
          offset += ed.from - line
          line = ed.from
        }
        // the replaced lines' tokens go
        const skip = Math.min(end, ed.to) - line
        offset += skip
        line += skip
      }
    }
    this.segs = shifted && shifted.lines.length > 0 ? withShifted(out, shifted) : out
    this.version++
  }

  clear(): void {
    this.segs = []
    this.version++
  }

  /** Lines that have fresh tokens: those kept across an edit of their own text are not counted until replaced. */
  get lines(): number {
    let n = 0
    for (const s of this.segs) if (!s.stale) n += s.count
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
      if (s.line < from) out.push({ line: s.line, count: from - s.line, chunk: s.chunk, offset: s.offset, stale: s.stale })
      if (end > to) out.push({ line: to, count: end - to, chunk: s.chunk, offset: s.offset + (to - s.line), stale: s.stale })
    }
    this.segs = out
  }
}

/** `segs` (ascending) with a one-line stale segment per shifted line, each in its place; a line that has tokens keeps them. */
function withShifted(segs: Segment[], shifted: ShiftedLines): Segment[] {
  const out: Segment[] = []
  let i = 0
  for (let k = 0; k < shifted.lines.length; k++) {
    const line = shifted.lines[k] as number
    while (i < segs.length && (segs[i] as Segment).line + (segs[i] as Segment).count <= line) out.push(segs[i++] as Segment)
    const next = segs[i]
    if (next && next.line <= line) continue
    out.push({ line, count: 1, chunk: shifted.chunk, offset: k, stale: true })
  }
  while (i < segs.length) out.push(segs[i++] as Segment)
  return out
}
