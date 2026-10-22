// `git diff -U0` → the changed line ranges of the new side, for the gutter. Only the hunk headers are read:
// `@@ -a,b +c,d @@`. The parser is fed git's stdout as it arrives and keeps nothing of it but a header being read, so a
// large change costs no memory. With no context lines, a hunk is exactly one run of removed lines followed by
// one run of added lines:
//   b = 0          d lines were added: lines c … c+d-1
//   d = 0          b lines were removed after line c (0: before the first line)
//   otherwise      lines c … c+d-1 replace b lines: modified
// Content lines start with `+`, `-`, ` ` or `\`, and the file header's lines with `diff`, `index`, `---`, `+++` (or
// `old mode`, `rename from`, …), so a line that starts with `@@ ` is always a hunk header.

import type { LineChange } from '@kea/protocol'

const AT = 0x40
const LF = 0x0a
/** A header's numbers end well inside this; what follows them on the line (the function context) is not needed. */
const HEADER_MAX = 96
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseHunkHeader(line: string): LineChange | null {
  const m = HEADER.exec(line)
  if (!m) return null
  const b = m[2] === undefined ? 1 : Number(m[2])
  const c = Number(m[3])
  const d = m[4] === undefined ? 1 : Number(m[4])
  if (d === 0) return b === 0 ? null : { kind: 'deleted', from: c, to: c }
  return { kind: b === 0 ? 'added' : 'modified', from: c, to: c + d - 1 }
}

export class HunkParser {
  /** In order of appearance, which is ascending line order. */
  readonly changes: LineChange[] = [] // bounded: at most `max` entries; `overflow` is set instead of adding more
  /** More hunks than `max`: the caller shows no markers rather than some. */
  overflow = false
  private readonly max: number
  private atLineStart = true
  /** The bytes of a line that began with `@`, up to HEADER_MAX; null while not inside such a line. */
  private header: number[] | null = null

  constructor(max: number) {
    this.max = max
  }

  push(chunk: Uint8Array): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let i = 0
    while (i < buf.length) {
      if (this.header) {
        // inside a candidate header: take bytes up to the line's end
        const end = buf.indexOf(LF, i)
        const stop = end < 0 ? buf.length : end
        for (let j = i; j < stop && this.header.length < HEADER_MAX; j++) this.header.push(buf[j] as number)
        if (end < 0) return
        this.finishHeader()
        i = end + 1
        this.atLineStart = true
        continue
      }
      if (this.atLineStart && buf[i] === AT) {
        this.header = []
        this.atLineStart = false
        continue
      }
      // any other line: skip to its end
      const end = buf.indexOf(LF, i)
      if (end < 0) {
        this.atLineStart = false
        return
      }
      i = end + 1
      this.atLineStart = true
    }
  }

  /** The stream ended: a last header with no newline after it still counts. */
  end(): void {
    if (this.header) this.finishHeader()
  }

  private finishHeader(): void {
    const line = Buffer.from(this.header as number[]).toString('latin1')
    this.header = null
    const c = parseHunkHeader(line)
    if (!c) return
    if (this.changes.length >= this.max) this.overflow = true
    else this.changes.push(c)
  }
}
