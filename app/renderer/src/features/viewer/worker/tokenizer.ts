// Tokenising lines with a TextMate grammar, in chunks that carry the grammar's state from one to the next: a chunk
// tokenised from the state its predecessor ended in equals the same lines of a whole-file run
// (U-FV-5). Runs in the highlight worker; nothing here touches the DOM or the worker's globals, so it is tested in
// Node against the real grammars.
//
// A chunk is two typed arrays (cheap to post, and to keep for a large file): `data` holds every token of its lines as
// `(start column << STYLE_BITS) | style` (syntax.ts), and `starts[i]` is where line `from + i`'s tokens begin in it
// (`starts[lines]` is the end). A token runs to the next token's start, the last one to the end of its line.

import { EncodedTokenMetadata, type IGrammar, type StateStack } from 'shiki/textmate'
import { STYLE_BITS, STYLE_BOLD, STYLE_ITALIC, STYLE_UNDERLINE } from '../syntax.ts'

/** TextMate's font-style bits in a token's metadata (vscode-textmate `FontStyle`, an ambient const enum, so not importable). */
const TM_ITALIC = 1
const TM_BOLD = 2
const TM_UNDERLINE = 4

export interface TokenChunk {
  /** First line (0-based) and the line after the last. */
  from: number
  to: number
  starts: Uint32Array
  data: Uint32Array
}

/** A growable Uint32 buffer: a chunk's tokens are appended, then copied out at their exact size. */
class U32 {
  private buf = new Uint32Array(1024)
  length = 0
  push(v: number): void {
    if (this.length === this.buf.length) {
      const next = new Uint32Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.length++] = v
  }
  take(): Uint32Array {
    return this.buf.slice(0, this.length)
  }
}

export class LineTokenizer {
  private readonly grammar: IGrammar
  /** Role index per theme colour id (the theme's colour map, resolved once per worker). */
  private readonly roleOf: Uint8Array
  /** A longer line is not tokenised (it shows as plain text and leaves the state as it was). */
  private readonly lineMax: number
  /** One line's tokenising stops after this long; what it had not reached shows as plain text. */
  private readonly lineMs: number

  constructor(grammar: IGrammar, roleOf: Uint8Array, o: { lineMax: number; lineMs: number }) {
    this.grammar = grammar
    this.roleOf = roleOf
    this.lineMax = o.lineMax
    this.lineMs = o.lineMs
  }

  /** Tokenise `lines[from, to)` from `state`; the state after the last line is what the next chunk starts from. */
  run(lines: readonly string[], from: number, to: number, state: StateStack): { chunk: TokenChunk; state: StateStack } {
    const starts = new Uint32Array(to - from + 1)
    const data = new U32()
    let st = state
    for (let n = from; n < to; n++) {
      starts[n - from] = data.length
      const line = lines[n] as string
      if (line.length === 0 || line.length > this.lineMax) {
        // an empty line still moves the grammar's state on (a block comment's blank line); a long one is skipped whole
        if (line.length === 0) st = this.grammar.tokenizeLine2(line, st, this.lineMs).ruleStack
        continue
      }
      const r = this.grammar.tokenizeLine2(line, st, this.lineMs)
      st = r.ruleStack
      const t = r.tokens
      let last = -1
      for (let i = 0; i < t.length; i += 2) {
        const meta = t[i + 1] as number
        const font = EncodedTokenMetadata.getFontStyle(meta)
        let style = this.roleOf[EncodedTokenMetadata.getForeground(meta)] ?? 0
        if (font > 0) {
          if (font & TM_BOLD) style |= STYLE_BOLD
          if (font & TM_UNDERLINE) style |= STYLE_UNDERLINE
          if (font & TM_ITALIC) style |= STYLE_ITALIC
        }
        // neighbours that look the same are one token
        if (style === last) continue
        last = style
        data.push((((t[i] as number) << STYLE_BITS) | style) >>> 0)
      }
    }
    starts[to - from] = data.length
    return { chunk: { from, to, starts, data: data.take() }, state: st }
  }
}

/** Split as CodeMirror splits a document into lines, so line numbers agree on both sides of the worker. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n?|\n/)
}
