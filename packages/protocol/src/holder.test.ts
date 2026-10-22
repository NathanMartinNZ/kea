import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  clientFrameSplitter,
  decodeClientPayload,
  decodeHolderPayload,
  encodeClientFrame,
  encodeHolderFrame,
  holderFrameSplitter,
  HolderProtocolError,
  parseRingHeader,
  readRing,
  type ClientFrame,
  type HolderFrame,
} from './holder.ts'
import { L } from './generated/limits.ts'

const golden = JSON.parse(readFileSync(join(import.meta.dirname, '../../../fixtures/protocol/holder-golden.json'), 'utf8')) as {
  frames: { name: string; dir: 'c2h' | 'h2c'; type: number; fields: Record<string, unknown>; hex: string }[]
  ring: { example: { capacity: number; earliestSeq: number; latestSeq: number; hex: string } }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'))

function clientFromFields(name: string, type: number, f: Record<string, unknown>): ClientFrame {
  switch (type) {
    case 0x01: return { t: 'hello', proto: f.proto as number }
    case 0x02: return { t: 'attach', mode: (['fromSeq', 'earliest', 'latest'] as const)[f.mode as number]!, seq: f.seq as number }
    case 0x03: return { t: 'input', data: unhex(f.bytesHex as string) }
    case 0x04: return { t: 'resize', cols: f.cols as number, rows: f.rows as number, xpx: f.xpx as number, ypx: f.ypx as number }
    case 0x05: return { t: 'ack', seq: f.seq as number }
    case 0x06: return { t: 'signal', signo: f.signo as number, target: (['child', 'fg', 'session'] as const)[f.target as number]! }
    case 0x07: return { t: 'terminate', graceMs: f.graceMs as number }
    case 0x08: return { t: 'stat' }
    case 0x09: return { t: 'detach' }
    case 0x0a: return { t: 'release' }
  }
  throw new Error(`unknown golden frame ${name}`)
}

function holderFromFields(type: number, f: Record<string, unknown>): HolderFrame {
  switch (type) {
    case 0x81: return { t: 'hello', proto: f.proto as number, childPid: f.childPid as number, cols: f.cols as number, rows: f.rows as number, earliestSeq: f.earliestSeq as number, latestSeq: f.latestSeq as number, exited: f.exited === 1, code: f.code as number, signal: f.signal as number, ptyId: f.ptyId as string }
    case 0x82: return { t: 'output', seq: f.seq as number, data: unhex(f.bytesHex as string) }
    case 0x83: return { t: 'exit', code: f.code as number, signal: f.signal as number }
    case 0x84: return { t: 'stat', childPid: f.childPid as number, fgPid: f.fgPid as number, fgName: f.fgName as string, cwd: f.cwd as string, descendants: f.descendants as number[] }
    case 0x85: return { t: 'error', code: f.code as number, message: f.message as string }
  }
  throw new Error('unknown')
}

describe('holder protocol (TS side)', () => {
  it('U-HLD-1 · every golden frame encodes to and decodes from the shared golden bytes', () => {
    for (const g of golden.frames) {
      if (g.dir === 'c2h') {
        const f = clientFromFields(g.name, g.type, g.fields)
        expect(hex(encodeClientFrame(f)), g.name).toBe(g.hex)
        const bytes = unhex(g.hex)
        expect(decodeClientPayload(g.type, bytes.subarray(5))).toEqual(f)
      } else {
        const f = holderFromFields(g.type, g.fields)
        expect(hex(encodeHolderFrame(f)), g.name).toBe(g.hex)
        expect(decodeHolderPayload(g.type, unhex(g.hex).subarray(5))).toEqual(f)
      }
    }
  })

  it('U-HLD-1 · split and merged reads yield the same frames', () => {
    const frames = golden.frames.filter((g) => g.dir === 'h2c').map((g) => unhex(g.hex))
    const all = Buffer.concat(frames)
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 60 }), (cuts) => {
        const s = holderFrameSplitter()
        const got: HolderFrame[] = []
        let o = 0
        let i = 0
        while (o < all.length) {
          const n = cuts[i++ % cuts.length]!
          got.push(...s.push(new Uint8Array(all.subarray(o, o + n))))
          o += n
        }
        expect(got.length).toBe(frames.length)
        expect(s.pendingBytes).toBe(0)
      }),
    )
  })

  it('U-HLD-1 · an oversize frame is rejected', () => {
    const s = clientFrameSplitter()
    const hdr = new Uint8Array(5)
    new DataView(hdr.buffer).setUint8(0, 0x03)
    new DataView(hdr.buffer).setUint32(1, L.holderMaxFrameBytes + 1, true)
    expect(() => s.push(hdr)).toThrow(HolderProtocolError)
  })

  it('U-HLD-1 · frames before a bad one are delivered whatever the read boundaries; the splitter then stays failed', () => {
    const good = golden.frames.filter((g) => g.dir === 'h2c').map((g) => unhex(g.hex))
    const bad = new Uint8Array(5)
    new DataView(bad.buffer).setUint32(1, L.holderReadBufferBytes + 65, true)
    const all = Buffer.concat([...good, bad, ...good])
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 60 }), (cuts) => {
        const s = holderFrameSplitter()
        const got: HolderFrame[] = []
        let failed: HolderProtocolError | null = null
        let o = 0
        let i = 0
        while (o < all.length && !failed) {
          const n = cuts[i++ % cuts.length]!
          try {
            got.push(...s.push(new Uint8Array(all.subarray(o, o + n))))
          } catch (e) {
            expect(e).toBeInstanceOf(HolderProtocolError)
            failed = e as HolderProtocolError
            got.push(...(failed.before as HolderFrame[]))
          }
          o += n
        }
        expect(failed).not.toBeNull()
        expect(got.length).toBe(good.length)
        expect(() => s.push(good[0]!)).toThrow(HolderProtocolError)
      }),
    )
  })

  it('C-FUZZ-2 · random bytes from a fake holder never throw anything but HolderProtocolError', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const s = holderFrameSplitter()
        try {
          s.push(bytes)
        } catch (e) {
          expect(e).toBeInstanceOf(HolderProtocolError)
        }
      }),
      { numRuns: 2000 },
    )
  })
})

describe('ring file', () => {
  it('U-HLD-3 · the golden ring header parses', () => {
    const h = parseRingHeader(unhex(golden.ring.example.hex))
    expect(h).toEqual({ version: 1, capacity: golden.ring.example.capacity, earliestSeq: golden.ring.example.earliestSeq, latestSeq: golden.ring.example.latestSeq })
  })

  it('U-HLD-3 · readRing returns the bytes in order across the wrap, clamped to earliestSeq', () => {
    const cap = 16
    const file = new Uint8Array(L.ringHeaderBytes + cap)
    const all = new Uint8Array(40).map((_, i) => i)
    // write bytes 0..39 into a ring of 16 → holds 24..39
    for (let s = 0; s < all.length; s++) file[L.ringHeaderBytes + (s % cap)] = all[s]!
    file.set([0x4b, 0x45, 0x41, 0x52], 0)
    const v = new DataView(file.buffer)
    v.setUint16(4, 1, true)
    v.setUint32(8, cap, true)
    v.setUint32(16, 24, true)
    v.setUint32(24, 40, true)
    const r = readRing(file, 0)!
    expect(r.seq).toBe(24)
    expect([...r.data]).toEqual([...all.subarray(24)])
    expect([...readRing(file, 30)!.data]).toEqual([...all.subarray(30)])
    // seqs beyond exact integers, or a capacity above L.ringBytesMax: corrupt (C-COR-3)
    const big = file.slice()
    new DataView(big.buffer).setUint32(28, 0x0020_0000, true) // latestSeq ≥ 2^53
    new DataView(big.buffer).setUint32(20, 0x0020_0000, true) // earliestSeq too, so the span still fits
    expect(parseRingHeader(big)).toBeNull()
    const huge = file.slice()
    new DataView(huge.buffer).setUint32(8, L.ringBytesMax + 1, true)
    expect(parseRingHeader(huge)).toBeNull()
    // corrupt header → null (C-COR-3)
    file[0] = 0
    expect(readRing(file)).toBeNull()
  })
})
