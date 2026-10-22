import { describe, expect, it } from 'vitest'
import { CastError, CastWriter, outputBytes, outputChunks, parseCast } from './cast.ts'

const kea = { scenario: 't', agent: 'claude', agentVersion: '0', prompt: 'p', model: 'mock-model' as const, altScreen: false, recorder: 'test' }
const enc = (s: string) => new TextEncoder().encode(s)

describe('cassette format', () => {
  it('U-CAST-1 · output round-trips byte for byte, including code points split across reads', () => {
    const all = enc('\x1b[1mhé\x1b[0m ✻ 🦜 done\r\n')
    const w = new CastWriter()
    // split everywhere, including inside the 2-, 3- and 4-byte sequences
    for (let i = 0; i < all.length; i++) w.output(i * 0.001, all.subarray(i, i + 1))
    w.input(0.5, '\x1b[?1;2c')
    w.resize(0.6, 100, 30)
    w.marker(0.7, 'done')
    const text = w.finish({ version: 2, width: 120, height: 36, kea })
    const cast = parseCast(text)
    expect(cast.header.kea?.bytes).toBe(all.length)
    expect(outputBytes(cast)).toEqual(all)
    expect(outputChunks(cast).every((c) => new TextDecoder('utf-8', { fatal: true }).decode(c.data).length > 0)).toBe(true)
    expect(cast.events.filter((e) => e[1] !== 'o')).toEqual([
      [0.5, 'i', '\x1b[?1;2c'],
      [0.6, 'r', '100x30'],
      [0.7, 'm', 'done'],
    ])
  })

  it('U-CAST-2 · invalid UTF-8, a truncated sequence, a length mismatch or time going backwards are refused', () => {
    expect(() => new CastWriter().output(0, Uint8Array.of(0x41, 0xff))).toThrow(CastError)
    const w = new CastWriter()
    w.output(0, enc('ok').subarray(0, 2))
    w.output(0.1, Uint8Array.of(0xe2, 0x9c))
    expect(() => w.finish({ version: 2, width: 80, height: 24, kea })).toThrow(/inside a UTF-8 sequence/)
    const good = new CastWriter()
    good.output(0, enc('abc'))
    const text = good.finish({ version: 2, width: 80, height: 24, kea })
    expect(() => parseCast(text.replace('"bytes":3', '"bytes":4'))).toThrow(/kea.bytes/)
    expect(() => parseCast(`{"version":2,"width":80,"height":24}\n[1,"o","a"]\n[0.5,"o","b"]\n`)).toThrow(/backwards/)
    expect(() => parseCast('{"version":1}\n')).toThrow(/header/)
  })
})
