// The text a save sends, encoded as a save encodes it: the file's encoding, its byte-order mark and its one line ending
// as read from the bytes it replaces. The file view's side, bytes to that text, is
// app/renderer/src/features/viewer/roundtrip.test.ts over the same fixture.
import { readFileSync } from 'node:fs'
import type { LineEnding, TextEncoding } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { bomEncoding, detect } from './detect.ts'
import { encodeText, onlyEnding } from './save.ts'

interface Case {
  name: string
  hex: string
  encoding: TextEncoding
  bom: boolean
  eol: LineEnding
  text: string
}

const { cases } = JSON.parse(readFileSync(new URL('../../../../fixtures/viewer/text-round-trip.json', import.meta.url), 'utf8')) as { cases: Case[] }

describe('a file’s text saved again', () => {
  it('U-FV-21 · the text the file view sends for a file is encoded into exactly the bytes it was read from', () => {
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      const bytes = Buffer.from(c.hex, 'hex')
      // what a save reads from the file it replaces
      const d = detect(bytes)
      expect({ binary: d.binary, invalid: d.invalid, encoding: d.encoding, eol: d.eol, bom: bomEncoding(bytes) !== null }, c.name).toEqual({ binary: false, invalid: false, encoding: c.encoding, eol: c.eol, bom: c.bom })
      expect(onlyEnding(c.text, d.eol), c.name).toBe(true)
      expect(encodeText(c.text, d.encoding, bomEncoding(bytes) !== null).toString('hex'), c.name).toBe(c.hex)
    }
  })
})
