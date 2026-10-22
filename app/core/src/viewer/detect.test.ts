import { L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { countLines, detect } from './detect.ts'

const utf8 = (s: string) => Buffer.from(s, 'utf8')
const BOM8 = Buffer.from([0xef, 0xbb, 0xbf])
const utf16 = (s: string, le: boolean) => {
  const b = Buffer.from(s, 'utf16le')
  if (!le) b.swap16()
  return Buffer.concat([Buffer.from(le ? [0xff, 0xfe] : [0xfe, 0xff]), b])
}

describe('encoding and binary detection', () => {
  it('U-FV-1 · a byte-order mark names the encoding, else a NUL in the first bytes is binary, else UTF-8; invalid bytes and line endings are reported', () => {
    const table: [string, Buffer, ReturnType<typeof detect>][] = [
      ['plain UTF-8', utf8('héllo\nwörld\n'), { binary: false, encoding: 'utf8', invalid: false, eol: 'lf' }],
      ['empty', Buffer.alloc(0), { binary: false, encoding: 'utf8', invalid: false, eol: 'lf' }],
      ['one line, no line ending', utf8('x'), { binary: false, encoding: 'utf8', invalid: false, eol: 'lf' }],
      ['UTF-8 with a mark', Buffer.concat([BOM8, utf8('a\n')]), { binary: false, encoding: 'utf8', invalid: false, eol: 'lf' }],
      // the mark decides: NULs after it do not make the file binary
      ['UTF-8 mark, then a NUL', Buffer.concat([BOM8, Buffer.from([0x61, 0, 0x62])]), { binary: false, encoding: 'utf8', invalid: false, eol: 'lf' }],
      ['UTF-16 LE', utf16('a\r\nb\r\n', true), { binary: false, encoding: 'utf16le', invalid: false, eol: 'crlf' }],
      ['UTF-16 BE', utf16('a\nb\n', false), { binary: false, encoding: 'utf16be', invalid: false, eol: 'lf' }],
      ['UTF-16 LE with an odd byte', Buffer.concat([utf16('ab', true), Buffer.from([0x41])]), { binary: false, encoding: 'utf16le', invalid: true, eol: 'lf' }],
      ['UTF-16 LE with a lone surrogate', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x00, 0xd8, 0x41, 0x00])]), { binary: false, encoding: 'utf16le', invalid: true, eol: 'lf' }],
      ['UTF-16 BE, mixed endings', utf16('a\r\nb\nc\r', false), { binary: false, encoding: 'utf16be', invalid: false, eol: 'mixed' }],
      ['a NUL at the start', Buffer.from([0, 1, 2, 3]), { binary: true, encoding: 'utf8', invalid: false, eol: 'lf' }],
      ['a NUL as the last sniffed byte', Buffer.concat([Buffer.alloc(L.binarySniffBytes - 1, 0x61), Buffer.from([0])]), { binary: true, encoding: 'utf8', invalid: false, eol: 'lf' }],
      // one byte later it is not looked at: text (a NUL is valid UTF-8)
      ['a NUL just past the sniffed bytes', Buffer.concat([Buffer.alloc(L.binarySniffBytes, 0x61), Buffer.from([0])]), { binary: false, encoding: 'utf8', invalid: false, eol: 'lf' }],
      ['invalid UTF-8', Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x0a]), { binary: false, encoding: 'utf8', invalid: true, eol: 'lf' }],
      ['a cut-off sequence', Buffer.from([0x61, 0xe2, 0x82]), { binary: false, encoding: 'utf8', invalid: true, eol: 'lf' }],
      ['CRLF', utf8('a\r\nb\r\n'), { binary: false, encoding: 'utf8', invalid: false, eol: 'crlf' }],
      ['CR only', utf8('a\rb\r'), { binary: false, encoding: 'utf8', invalid: false, eol: 'cr' }],
      ['CRLF and LF', utf8('a\r\nb\nc\r\n'), { binary: false, encoding: 'utf8', invalid: false, eol: 'mixed' }],
      ['LF first, CRLF later', utf8('a\nb\r\n'), { binary: false, encoding: 'utf8', invalid: false, eol: 'mixed' }],
      ['CRLF and CR', utf8('a\r\nb\rc'), { binary: false, encoding: 'utf8', invalid: false, eol: 'mixed' }],
    ]
    for (const [name, bytes, want] of table) expect(detect(bytes), name).toEqual(want)
    // a plain Uint8Array (what crosses a port) reads the same as a Buffer
    expect(detect(new Uint8Array(utf8('a\r\nb\r\n')))).toMatchObject({ eol: 'crlf' })

    // the diff's line count: LF-terminated lines plus an unterminated last one; it stops counting past the cap
    expect(countLines(utf8(''), 10)).toBe(0)
    expect(countLines(utf8('a'), 10)).toBe(1)
    expect(countLines(utf8('a\n'), 10)).toBe(1)
    expect(countLines(utf8('a\nb'), 10)).toBe(2)
    expect(countLines(utf8('a\r\nb\r\n'), 10)).toBe(2)
    expect(countLines(utf8('x\n'.repeat(50)), 10)).toBe(11)
  })
})
