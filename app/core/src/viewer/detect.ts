// Encoding and binary detection, VS Code's rule: a byte-order mark names the encoding (UTF-8, UTF-16 LE / BE);
// otherwise a NUL byte in the first L.binarySniffBytes bytes means binary; otherwise the file is UTF-8. Bytes that are
// not valid in the encoding are reported, not refused: the window shows them as replacement characters with a notice.
// Line endings are told from the bytes too, so the header can name them when they are not LF.
//
// Pure functions over bytes: nothing is decoded and no string of the contents is made here.

import { isUtf8 } from 'node:buffer'
import { L, type LineEnding, type TextEncoding } from '@kea/protocol'

export interface Detected {
  /** A NUL in the first bytes and no byte-order mark: not shown as text. */
  binary: boolean
  encoding: TextEncoding
  /** Not valid in `encoding`. */
  invalid: boolean
  eol: LineEnding
}

const CR = 0x0d
const LF = 0x0a

function view(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** The encoding a byte-order mark names, or null. */
export function bomEncoding(bytes: Uint8Array): TextEncoding | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf16be'
  return null
}

/** The binary test for a file with no byte-order mark: a NUL in its first L.binarySniffBytes bytes. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, L.binarySniffBytes)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

/**
 * The line endings of single-byte-compatible text (UTF-8): `lf` when there is none or only LF, else `crlf`, `cr`, or
 * `mixed` for more than one kind. A file with no CR at all (the usual case) costs one scan for it.
 */
function eolOfBytes(buf: Buffer): LineEnding {
  let i = buf.indexOf(CR)
  if (i < 0) return 'lf'
  let crlf = false
  let cr = false
  for (; i >= 0; i = buf.indexOf(CR, i + 1)) {
    if (buf[i + 1] === LF) crlf = true
    else cr = true
    if (crlf && cr) return 'mixed'
  }
  // an LF with no CR before it is the third kind
  for (let j = buf.indexOf(LF); j >= 0; j = buf.indexOf(LF, j + 1)) if (j === 0 || buf[j - 1] !== CR) return 'mixed'
  return crlf ? 'crlf' : 'cr'
}

/** The same over UTF-16 code units, which also finds what is not valid UTF-16: an odd length, a surrogate without its pair. */
function scanUtf16(buf: Buffer, le: boolean): { eol: LineEnding; invalid: boolean } {
  let invalid = buf.length % 2 === 1
  let crlf = false
  let cr = false
  let lf = false
  let prev = 0
  const units = buf.length >> 1
  for (let i = 0; i < units; i++) {
    const u = le ? buf.readUInt16LE(i * 2) : buf.readUInt16BE(i * 2)
    if (u === LF) {
      if (prev === CR) crlf = true
      else lf = true
    } else if (prev === CR) cr = true
    if (u >= 0xdc00 && u <= 0xdfff) {
      if (!(prev >= 0xd800 && prev <= 0xdbff)) invalid = true
    } else if (prev >= 0xd800 && prev <= 0xdbff) invalid = true
    prev = u
  }
  if (prev === CR) cr = true
  if (prev >= 0xd800 && prev <= 0xdbff) invalid = true
  const kinds = Number(crlf) + Number(cr) + Number(lf)
  return { eol: kinds > 1 ? 'mixed' : crlf ? 'crlf' : cr ? 'cr' : 'lf', invalid }
}

export function detect(bytes: Uint8Array): Detected {
  const buf = view(bytes)
  const bom = bomEncoding(buf)
  if (bom === 'utf16le' || bom === 'utf16be') return { binary: false, encoding: bom, ...scanUtf16(buf.subarray(2), bom === 'utf16le') }
  if (bom === null && looksBinary(buf)) return { binary: true, encoding: 'utf8', invalid: false, eol: 'lf' }
  return { binary: false, encoding: 'utf8', invalid: !isUtf8(buf), eol: eolOfBytes(buf) }
}

/** Lines in `bytes` as a diff counts them, stopping once past `max`: LF-terminated, plus a last line with no LF. */
export function countLines(bytes: Uint8Array, max: number): number {
  const buf = view(bytes)
  if (buf.length === 0) return 0
  let n = 0
  let i = buf.indexOf(LF)
  let last = -1
  for (; i >= 0 && n <= max; i = buf.indexOf(LF, i + 1)) {
    n++
    last = i
  }
  if (n <= max && last !== buf.length - 1) n++
  return n
}
