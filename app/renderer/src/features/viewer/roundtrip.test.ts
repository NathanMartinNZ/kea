// A file's bytes as the file view reads them, and the text a save sends back: decoded, split into the document's lines
// and joined again with the file's own line ending. Core turns that text into the same bytes
// (app/core/src/viewer/roundtrip.test.ts, over the same fixture).
import { readFileSync } from 'node:fs'
import { EditorState, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { LineEnding, TextEncoding } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { decodeText, splitLines } from './decode.ts'
import { fileState } from './editor.ts'
import { textStats, viewPolicy } from './policy.ts'
import { saveText } from './saving.ts'
import { EMPTY_VIEW } from './tab.ts'

interface Case {
  name: string
  hex: string
  encoding: TextEncoding
  bom: boolean
  eol: LineEnding
  lines: string[]
  text: string
}

const { cases } = JSON.parse(readFileSync(new URL('../../../../../fixtures/viewer/text-round-trip.json', import.meta.url), 'utf8')) as { cases: Case[] }

/** The file's document as the file view builds it: no line separator of its own, the file's ending on a copy. */
function documentOf(c: Case): EditorState {
  const lines = splitLines(decodeText({ bytes: Uint8Array.from(Buffer.from(c.hex, 'hex')), encoding: c.encoding }))
  const edit = { eol: c.eol, indent: '  ', aids: [], host: { unsaved: () => false, save: () => {} } }
  return fileState({ path: 'a.txt', lines, eol: c.eol, policy: viewPolicy(textStats(c.hex.length / 2, lines)), store: null, wrap: false, changes: null, edit }, EMPTY_VIEW, null)
}

const copied = (s: EditorState, text: string): string => s.facet(EditorView.clipboardOutputFilter).reduce((t, f) => f(t, s), text)

describe('a file’s text read and saved again', () => {
  it('U-FV-21 · decoded into the document and joined with the file’s ending, every file gives the text core encodes back into its bytes', () => {
    expect(cases.map((c) => c.name)).toEqual(expect.arrayContaining(['LF', 'CRLF', 'CR', 'LF with no final newline', 'empty', 'UTF-8 with a byte-order mark', 'UTF-8 without a byte-order mark', 'UTF-16 LE', 'UTF-16 BE']))
    for (const c of cases) {
      const s = documentOf(c)
      expect(s.doc.toJSON(), c.name).toEqual(c.lines)
      expect(saveText(s.doc, c.eol), c.name).toBe(c.text)
    }
  })

  it('U-FV-21 · text pasted with LF into a CRLF document is saved with CRLF, and a copy from it has CRLF', () => {
    const crlf = cases.find((c) => c.name === 'CRLF') as Case
    let s = documentOf(crlf)
    s = s.update({ changes: { from: s.doc.length, insert: 'pasted\nlines\n' }, userEvent: 'input.paste' }).state
    expect(saveText(s.doc, 'crlf')).toBe('one\r\ntwo\r\npasted\r\nlines\r\n')
    // the same with any ending pasted
    s = s.update({ changes: { from: 0, insert: 'cr\rmixed\r\n' }, userEvent: 'input.paste' }).state
    expect(saveText(s.doc, 'crlf')).toBe('cr\r\nmixed\r\none\r\ntwo\r\npasted\r\nlines\r\n')
    expect(copied(s, s.sliceDoc(0, s.doc.line(3).to))).toBe('cr\r\nmixed\r\none')
    // a LF file copies as it is
    const lf = documentOf(cases.find((c) => c.name === 'LF') as Case)
    expect(copied(lf, lf.sliceDoc())).toBe('one\ntwo\n')
    expect(saveText(Text.of(['a', 'b']), 'cr')).toBe('a\rb')
  })
})
