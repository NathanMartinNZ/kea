import { describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { lineCount, pasteDecision } from './paste.ts'
import { terminalText } from './text.ts'
import { terminalUi, uiState } from './ui.svelte.ts'

describe('paste', () => {
  it('U-TERM-22 · an image-only clipboard sends the image-paste key; multi-line text into a plain shell asks first (setting); everything else pastes', () => {
    expect(pasteDecision({ text: '', hasImage: true, plainShell: false, confirmMultiline: true })).toEqual({ do: 'imageKey' })
    expect(pasteDecision({ text: '', hasImage: true, plainShell: true, confirmMultiline: true })).toEqual({ do: 'imageKey' })
    // text and an image: the text wins
    expect(pasteDecision({ text: 'a', hasImage: true, plainShell: true, confirmMultiline: true })).toEqual({ do: 'default' })
    expect(pasteDecision({ text: 'rm -rf build\nmake\n', hasImage: false, plainShell: true, confirmMultiline: true })).toEqual({ do: 'confirm', lines: 2 })
    expect(pasteDecision({ text: 'make\r', hasImage: false, plainShell: true, confirmMultiline: true })).toEqual({ do: 'confirm', lines: 1 })
    expect(pasteDecision({ text: 'a\nb', hasImage: false, plainShell: true, confirmMultiline: false })).toEqual({ do: 'default' })
    expect(pasteDecision({ text: 'a\nb', hasImage: false, plainShell: false, confirmMultiline: true })).toEqual({ do: 'default' })
    expect(pasteDecision({ text: 'one line', hasImage: false, plainShell: true, confirmMultiline: true })).toEqual({ do: 'default' })
    expect(pasteDecision({ text: '', hasImage: false, plainShell: true, confirmMultiline: true })).toEqual({ do: 'default' })
    expect(lineCount('a\r\nb\r\nc')).toBe(3)
  })

  it('U-TERM-22 · the text waiting for confirmation is given back once if confirmed, never if cancelled, then dropped', () => {
    terminalUi.askPaste('p1', 2, 'a\nb\n')
    expect(terminalUi.settlePaste(true)).toBe('a\nb\n')
    expect(uiState.snapshot().paste).toBeNull()
    expect(terminalUi.settlePaste(true)).toBeNull()
    terminalUi.askPaste('p1', 2, 'a\nb\n')
    expect(terminalUi.settlePaste(false)).toBeNull()
    expect(terminalUi.settlePaste(true)).toBeNull()
  })

  it('U-TERM-30 · the store holds only the paste sheet’s line count, never the text waiting for confirmation', () => {
    const text = 'a\nb\n'
    terminalUi.askPaste('p1', 2, text)
    expect(uiState.snapshot().paste).toEqual({ ptyId: 'p1', lines: 2 })
    expect(JSON.stringify(uiState.snapshot())).not.toContain(JSON.stringify(text).slice(1, -1))
    expect(terminalUi.settlePaste(false)).toBeNull()
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
