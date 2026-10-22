import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { CharsetTracker, VtScanner } from './scanner.ts'
import { internals, newTerminal, type HeadlessTerminal } from './test-support.ts'

const enc = new TextEncoder()
const bytes = (s: string | number[]) => (typeof s === 'string' ? enc.encode(s) : Uint8Array.from(s))

/** Ground state after each prefix of `input`, fed one byte at a time. */
function groundTrace(input: string | number[]): boolean[] {
  const s = new VtScanner()
  return [...bytes(input)].map((b) => {
    s.feed(Uint8Array.of(b))
    return s.atGround
  })
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

function xterm(): HeadlessTerminal {
  const t = newTerminal('mirror')
  cleanup.push(() => t.dispose())
  return t
}
/** Synchronous parse (test only): xterm.js's write queue is asynchronous. */
function writeSync(t: HeadlessTerminal, b: Uint8Array): void {
  ;(t as unknown as { _core: { writeSync(d: Uint8Array): void } })._core.writeSync(b)
}

describe('ground-state scanner', () => {
  it.each([
    ['plain text', 'abc', [true, true, true]],
    ['CSI', '\x1b[1;2H', [false, false, false, false, false, true]],
    ['CSI with private prefix and intermediate', '\x1b[?1$p', [false, false, false, false, false, true]],
    ['ESC with intermediate', '\x1b(0', [false, false, true]],
    ['OSC ended by BEL', '\x1b]2;t\x07', [false, false, false, false, false, true]],
    ['OSC ended by ST', '\x1b]2;t\x1b\\', [false, false, false, false, false, false, true]],
    ['DCS', '\x1bP$qr\x1b\\', [false, false, false, false, false, false, true]],
    ['APC', '\x1b_Gx\x1b\\', [false, false, false, false, false, true]],
    ['SOS', '\x1bXs\x1b\\', [false, false, false, false, true]],
    ['CAN aborts a CSI', '\x1b[12\x18', [false, false, false, false, true]],
    ['SUB aborts an OSC', '\x1b]0;x\x1a', [false, false, false, false, false, true]],
    ['C0 inside a CSI executes but the CSI goes on', '\x1b[1\nm', [false, false, false, false, true]],
  ])('U-PTY-4 · %s', (_name, input, expected) => {
    expect(groundTrace(input)).toEqual(expected)
  })

  it('U-PTY-4 · a partial UTF-8 character is not ground; invalid bytes are dropped as xterm.js does', () => {
    expect(groundTrace([0xe6, 0x97, 0xa5])).toEqual([false, false, true]) // 日
    expect(groundTrace([0xf0, 0x9f, 0x98, 0x80])).toEqual([false, false, false, true]) // 😀
    expect(groundTrace([0x9b, 0x31])).toEqual([true, true]) // a raw 0x9B byte is not C1 CSI in a UTF-8 stream
    expect(groundTrace([0xc2, 0x9b, 0x31, 0x6d])).toEqual([false, false, false, true]) // U+009B is C1 CSI
    expect(groundTrace([0xe6, 0x41])).toEqual([false, true]) // broken sequence: pending bytes dropped, A printed
    expect(groundTrace([0xff, 0x41])).toEqual([true, true])
  })

  it('U-PTY-4 · inside a synchronized-output (DEC 2026) block is never ground; DECSTR and RIS end it', () => {
    const s = new VtScanner()
    s.feed(bytes('\x1b[?2026h'))
    expect(s.parserIdle).toBe(true)
    expect(s.atGround).toBe(false)
    s.feed(bytes('frame'))
    expect(s.atGround).toBe(false)
    s.feed(bytes('\x1b[?2026l'))
    expect(s.atGround).toBe(true)
    s.feed(bytes('\x1b[?1;2026h'))
    expect(s.syncOpen).toBe(true)
    s.feed(bytes('\x1b[!p'))
    expect(s.atGround).toBe(true)
    s.feed(bytes('\x1b[?2026h\x1bc'))
    expect(s.atGround).toBe(true)
  })

  const FRAGMENTS: (string | number[])[] = [
    'a', 'é', '日', '😀', ' ', '\r\n', '\x07', '\x18', '\x1a', '\x7f', '\x0e', '\x0f', '\x1b', '\x1b\\',
    '[', ']', 'P', '_', 'X', '^', '?', '>', '<', '=', '$', '!', ' ', '(', ';', ':', '1', '0', '2026', '1049',
    'h', 'l', 'm', 'H', 'q', 'p', 'c', 'u', 'r', '\\',
    '\x1b[', '\x1b]', '\x1bP', '\x1b_', '\x1bX', '\x1b[?2026h', '\x1b[?2026l', '\x1b]0;title', '\x1bP$q', '\x1b[!p', '\x1bc',
    [0x9b], [0x9c], [0xc2, 0x9b], [0xc2, 0x9c], [0xc2, 0x90], [0xc2, 0x9d], [0xc2, 0x98], [0xc2, 0x9f], [0xe6], [0x97], [0xa5], [0xff], [0xef, 0xbb, 0xbf],
  ]
  const stream = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 60 }).map((fs) => Uint8Array.from(fs.flatMap((f) => [...bytes(f)])))

  it('U-PTY-4 · a flood of intermediates keeps the collected sequence bounded and still ends at ground', () => {
    const s = new VtScanner()
    s.feed(bytes('\x1b[?'))
    const flood = new Uint8Array(1 << 20).fill(0x24) // '$' × 1 MiB
    s.feed(flood)
    expect((s as unknown as { collect: string }).collect.length).toBeLessThanOrEqual(4)
    s.feed(bytes('p'))
    expect(s.atGround).toBe(true)
  })

  it('U-PTY-4 · property: after every byte, the scanner agrees with xterm.js’s own parser and DEC 2026 state', () => {
    fc.assert(
      fc.property(stream, (input) => {
        const t = xterm()
        const s = new VtScanner()
        for (const b of input) {
          const one = Uint8Array.of(b)
          writeSync(t, one)
          s.feed(one)
          const x = internals(t)
          expect(s.parserIdle).toBe(x.parserState === 0 && !x.utf8Pending)
          expect(s.syncOpen).toBe(t.modes.synchronizedOutputMode)
        }
        t.dispose()
        cleanup.pop()
      }),
      { numRuns: 150 },
    )
  })

  it('U-PTY-4 · property: with arbitrary chunking (xterm.js’s CSI fast path), ground at every chunk boundary still agrees', () => {
    fc.assert(
      fc.property(stream, fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 30 }), (input, sizes) => {
        const t = xterm()
        const s = new VtScanner()
        let i = 0
        let k = 0
        while (i < input.length) {
          const chunk = input.subarray(i, i + (sizes[k++ % sizes.length] as number))
          i += chunk.length
          writeSync(t, chunk)
          s.feed(chunk)
          const x = internals(t)
          expect(s.parserIdle).toBe(x.parserState === 0 && !x.utf8Pending)
        }
        t.dispose()
        cleanup.pop()
      }),
      { numRuns: 150 },
    )
  })
})

describe('character sets', () => {
  function track(input: string): CharsetTracker {
    const s = new VtScanner()
    const c = new CharsetTracker()
    s.addListener(c)
    s.feed(bytes(input))
    return c
  }

  it('U-PTY-3 · designations, SO/SI, locking shifts and their trailer', () => {
    const c = track('\x1b(0\x1b)A\x1b+K\x1bn')
    expect(c.snapshot()).toEqual({ charsets: ['0', 'A', undefined, 'K'], glevel: 2 })
    expect(c.trailer()).toBe('\x1b(0\x1b)A\x1b*B\x1b+K\x1bn') // G2 is in the table (undesignated): a DECRC resets it
    expect(track('\x1b)0\x0e').trailer()).toBe('\x1b(B\x1b)0\x0e')
    expect(track('\x1b(0\x1b(B').snapshot()).toEqual({ charsets: [undefined, undefined, undefined, undefined], glevel: 0 })
    expect(track('\x1b(0\x0e\x1b%G').snapshot()).toEqual({ charsets: [undefined, undefined, undefined, undefined], glevel: 0 })
    expect(track('\x1b(9').snapshot().charsets[0]).toBeUndefined() // unknown final: ignored
  })

  it('U-PTY-3 · DECSC/DECRC and 1049 save and restore the charsets per screen; DECSTR and RIS reset', () => {
    expect(track('\x1b(0\x1b7\x1b(B\x0e\x1b8').snapshot()).toEqual({ charsets: ['0', undefined, undefined, undefined], glevel: 0 })
    expect(track('\x1b(0\x1b[?1049h\x1b(B\x1b[?1049l').snapshot().charsets[0]).toBe('0')
    expect(track('\x1b(0\x1b[s\x1b(B\x1b[u').snapshot().charsets[0]).toBe('0')
    expect(track('\x1b(0\x0e\x1b[!p').snapshot()).toEqual({ charsets: [undefined, undefined, undefined, undefined], glevel: 0 })
    expect(track('\x1b(0\x1b7\x1bc\x1b8').snapshot().charsets[0]).toBeUndefined()
  })

  it('U-PTY-3 · property: the tracker agrees with xterm.js’s charset service, table length and DECSC slots included', () => {
    const pieces = ['\x1b(0', '\x1b(B', '\x1b)0', '\x1b)A', '\x1b*0', '\x1b+K', '\x1b-0', '\x1b.A', '\x0e', '\x0f', '\x1bn', '\x1bo', '\x1b|', '\x1b}', '\x1b~', '\x1b7', '\x1b8', '\x1b[s', '\x1b[u', '\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1b[?47l', '\x1b[?1047h', '\x1b[?1048h', '\x1b[?1048l', '\x1b[?2h', '\x1b%G', '\x1b[!p', '\x1bc', 'x']
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 40 }), (ps) => {
        const t = xterm()
        const input = ps.join('')
        writeSync(t, bytes(input))
        const tracker = track(input)
        const c = tracker.snapshot()
        const x = internals(t)
        expect(c.glevel).toBe(x.glevel)
        expect(c.charsets.map((f) => f !== undefined)).toEqual(x.charsets.map((cs) => cs !== undefined && cs !== null))
        // the table's length (which G sets a DECRC resets) and both screens' DECSC slots
        const set = (list: readonly unknown[]) => Array.from(list, (f) => f !== undefined && f !== null)
        expect(set(tracker.state().charsets)).toEqual(set(x.charsetTable))
        for (const k of ['normal', 'alt'] as const) {
          const slot = tracker.saved(k)
          expect({ set: set(slot.charsets), glevel: slot.glevel }, k).toEqual({ set: set(x.savedCharsets[k].charsets), glevel: x.savedCharsets[k].glevel })
        }
        t.dispose()
        cleanup.pop()
      }),
      { numRuns: 200 },
    )
  })
})
