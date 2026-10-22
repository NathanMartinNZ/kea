// A file's bytes as core sent them → the text the editor shows. Decoding replaces what is not valid in the
// encoding with U+FFFD (core has already said whether anything is: the notice) and drops a byte-order mark. Lines are
// split as CodeMirror and the highlight worker split them, so line numbers agree everywhere.

import type { LineEnding, TextBytes, TextEncoding } from '@kea/protocol'

const LABEL: Readonly<Record<TextEncoding, string>> = { utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be' }

export function decodeText(t: Pick<TextBytes, 'bytes' | 'encoding'>): string {
  return new TextDecoder(LABEL[t.encoding], { fatal: false, ignoreBOM: false }).decode(t.bytes)
}

/** As `Text.of` wants them and as the worker's `splitLines` gives them. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n?|\n/)
}

/** What a copy from the view puts between lines: the file's own line ending (LF for a mixed file). */
export function lineBreakOf(eol: LineEnding): string {
  return eol === 'crlf' ? '\r\n' : eol === 'cr' ? '\r' : '\n'
}

/** The header's words for an encoding and line ending that are not the usual ones; null for UTF-8 with LF. */
export function encodingNote(encoding: TextEncoding, eol: LineEnding): string | null {
  const parts: string[] = []
  if (encoding === 'utf16le') parts.push('UTF-16 LE')
  else if (encoding === 'utf16be') parts.push('UTF-16 BE')
  if (eol === 'crlf') parts.push('CRLF')
  else if (eol === 'cr') parts.push('CR')
  else if (eol === 'mixed') parts.push('Mixed line endings')
  return parts.length ? parts.join(' · ') : null
}
