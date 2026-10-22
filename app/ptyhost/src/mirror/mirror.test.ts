// The mirror's own memory: what an awake mirror keeps besides its buffer.

import { DEFAULT_TERMINAL_SETTINGS, L } from '@kea/protocol'
import { colorThemeOf } from '@kea/terminal'
import { afterEach, describe, expect, it } from 'vitest'
import { Mirror } from './mirror.ts'

const mirrors: Mirror[] = []
afterEach(() => {
  for (const m of mirrors.splice(0)) m.dispose()
})

function mirror(o: { restore?: { cols: number; rows: number; data: string }; parsed?: (seq: number) => void } = {}): Mirror {
  const m = new Mirror({ cols: 80, rows: 24, scrollback: 1000, colors: colorThemeOf(DEFAULT_TERMINAL_SETTINGS.theme), startSeq: 0, reply: () => {}, parsed: o.parsed ?? (() => {}), now: () => 0, ...(o.restore ? { restore: o.restore } : {}) })
  mirrors.push(m)
  return m
}

/** xterm's parse buffer: 4 bytes per unit of the largest write it was given, kept for good. */
const parseBuffer = (m: Mirror) => (m.terminal as unknown as { _core: { _inputHandler: { _parseBuffer: Uint32Array } } })._core._inputHandler._parseBuffer

describe('mirror writes', () => {
  it('U-PTY-50 · a 64 KiB batch and a large checkpoint reach xterm in pieces: its parse buffer stays at its first size, the text is whole, and the batch is acked once at its end', async () => {
    const parsed: number[] = []
    const m = mirror({ parsed: (seq) => parsed.push(seq) })
    const first = parseBuffer(m).length
    expect(first).toBe(L.mirrorWriteMaxBytes)
    // a coalescer-sized batch whose piece boundaries cut through multi-byte characters
    const line = `${'é'.repeat(39)}x\r\n` // 81 bytes: boundaries every 4 096 bytes fall inside an 'é' somewhere
    const batch = new TextEncoder().encode(line.repeat(Math.ceil(L.coalesceMaxBytes / 81))).subarray(0, L.coalesceMaxBytes)
    m.write(0, batch)
    await new Promise<void>((r) => m.terminal.write('', r))
    expect(parsed).toEqual([L.coalesceMaxBytes])
    expect(parseBuffer(m).length).toBe(first)
    const b = m.terminal.buffer.active
    const whole = Math.floor(L.coalesceMaxBytes / 81)
    for (let y = 0; y < whole; y++) expect(b.getLine(y)!.translateToString(true), `line ${y}`).toBe(`${'é'.repeat(39)}x`)
    // a mirror rebuilt from a checkpoint: its data, one string, goes in pieces too
    const r = mirror({ restore: { cols: 80, rows: 24, data: 'ü'.repeat(70) + '\r\n'.repeat(3) + 'z'.repeat(8 * L.mirrorWriteMaxBytes) } })
    await r.whenRestored()
    expect(parseBuffer(r).length).toBe(first)
    expect(r.terminal.buffer.active.getLine(0)!.translateToString(true)).toBe('ü'.repeat(70))
  })
})
