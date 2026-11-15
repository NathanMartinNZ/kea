import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { sendsImageKey } from './paste.ts'
import { terminalText } from './text.ts'

describe('paste', () => {
  it('U-TERM-22 · an image-only clipboard sends the image-paste key; any text, several lines included, is the terminal’s own paste', () => {
    expect(sendsImageKey({ text: '', hasImage: true })).toBe(true)
    // text and an image: the text wins
    expect(sendsImageKey({ text: 'a', hasImage: true })).toBe(false)
    expect(sendsImageKey({ text: 'rm -rf build\nmake\n', hasImage: false })).toBe(false)
    expect(sendsImageKey({ text: 'make\r', hasImage: false })).toBe(false)
    expect(sendsImageKey({ text: 'one line', hasImage: false })).toBe(false)
    expect(sendsImageKey({ text: '', hasImage: false })).toBe(false)
  })
})

describe('terminal text as data', () => {
  it('U-TERM-20 · titles lose control, zero-width and bidi characters, collapse whitespace and are cut to the cap', () => {
    expect(terminalText('vim\x1b[31m README‮.md\u0007')).toBe('vim [31m README .md')
    expect(terminalText('  a \t\n b  ')).toBe('a b')
    expect(terminalText(null)).toBe('')
    const long = 'x'.repeat(L.oscTextMaxChars + 10)
    const cut = terminalText(long)
    expect([...cut]).toHaveLength(L.oscTextMaxChars)
    expect(cut.endsWith('…')).toBe(true)
    expect(terminalText('é'.repeat(L.oscTextMaxChars))).toBe('é'.repeat(L.oscTextMaxChars))
  })
})
