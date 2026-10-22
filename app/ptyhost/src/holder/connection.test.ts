import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { encodeHolderFrame, HOLDER_PROTO, type HolderFrame } from '@kea/protocol'
import { tempHome } from '../test-support.ts'
import { HolderConnectError, HolderConnection } from './connection.ts'

// C-FUZZ-2: whatever a holder (or something squatting on its socket) sends, ptyhost's holder client never lets an
// exception escape, and the connection ends exactly once with every waiter answered.

let dir: string
beforeAll(() => {
  dir = tempHome()
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const u16 = fc.integer({ min: 0, max: 0xffff })
const u32 = fc.integer({ min: 0, max: 0xffffffff })
const seq = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
const frameArb: fc.Arbitrary<HolderFrame> = fc.oneof(
  fc.record({ t: fc.constant('hello' as const), proto: fc.oneof(fc.constant(HOLDER_PROTO), u16), childPid: u32, cols: u16, rows: u16, earliestSeq: seq, latestSeq: seq, exited: fc.boolean(), code: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), signal: fc.integer({ min: 0, max: 255 }), ptyId: fc.string({ maxLength: 16 }) }),
  fc.record({ t: fc.constant('output' as const), seq, data: fc.uint8Array({ maxLength: 64 }) }),
  fc.record({ t: fc.constant('exit' as const), code: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), signal: fc.integer({ min: 0, max: 255 }) }),
  fc.record({ t: fc.constant('stat' as const), childPid: u32, fgPid: u32, fgName: fc.string({ maxLength: 16 }), cwd: fc.string({ maxLength: 32 }), descendants: fc.array(u32, { maxLength: 4 }) }),
  fc.record({ t: fc.constant('error' as const), code: u16, message: fc.string({ maxLength: 32 }) }),
)

const hello = fc.record({ t: fc.constant('hello' as const), proto: fc.constant(HOLDER_PROTO), childPid: u32, cols: u16, rows: u16, earliestSeq: seq, latestSeq: seq, exited: fc.boolean(), code: fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), signal: fc.integer({ min: 0, max: 255 }), ptyId: fc.string({ maxLength: 16 }) })

/** A valid frame, a valid frame cut short, or random bytes: what a broken or hostile holder could write. */
const piece = fc.oneof(
  frameArb.map((f) => encodeHolderFrame(f)),
  fc.tuple(frameArb, fc.nat()).map(([f, n]) => {
    const b = encodeHolderFrame(f)
    return b.subarray(0, n % Math.max(1, b.byteLength))
  }),
  fc.uint8Array({ minLength: 1, maxLength: 48 }),
)

/** Serve one connection with `chunks` (one socket write each), then end it. */
async function fakeHolder(sock: string, chunks: Uint8Array[]): Promise<{ server: net.Server; done: Promise<void> }> {
  const server = net.createServer()
  let finish!: () => void
  const done = new Promise<void>((r) => (finish = r))
  server.on('connection', (s) => {
    s.on('error', () => {})
    s.on('close', finish)
    s.on('data', () => {}) // drain the client's frames
    for (const c of chunks) s.write(c)
    s.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sock, () => resolve())
  })
  return { server, done }
}

const MODE = 'fromSeq' as const
let n = 0
let opens = 0
describe('holder client under garbage', () => {
  it('C-FUZZ-2 · no exception escapes; the connection closes once and answers every waiter', async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(hello, { nil: null }), fc.array(piece, { maxLength: 12 }), fc.boolean(), async (first, rest, statFirst) => {
        const sock = path.join(dir, `f${n++}.sock`)
        const { server, done } = await fakeHolder(sock, first ? [encodeHolderFrame(first), ...rest] : rest)
        const closes: string[] = []
        try {
          let opened: Awaited<ReturnType<typeof HolderConnection.open>> | null = null
          try {
            opened = await HolderConnection.open(sock)
          } catch (e) {
            // The only way open() fails: a refusal or the socket ending before a HELLO.
            expect(e).toBeInstanceOf(HolderConnectError)
          }
          if (first) expect(opened).not.toBeNull()
          if (opened) {
            opens++
            const { conn } = opened
            const stat = statFirst ? conn.stat() : null
            let closed!: () => void
            const isClosed = new Promise<void>((r) => (closed = r))
            conn.attach(MODE, 0, {
              output: () => {},
              exit: () => {},
              error: () => {},
              close: (reason) => {
                closes.push(reason)
                closed()
              },
            })
            // The holder ends the socket after its bytes, so the connection must close and answer the STAT.
            await isClosed
            if (stat) expect([null, 'stat']).toContain((await stat)?.t ?? null)
            expect(conn.isClosed).toBe(true)
            conn.destroy()
            expect(closes).toHaveLength(1)
          }
          await done
        } finally {
          await new Promise<void>((r) => server.close(() => r()))
        }
      }),
      { numRuns: 150 },
    )
    expect(opens).toBeGreaterThan(0)
  })
})
