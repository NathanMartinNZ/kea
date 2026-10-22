// A holder's memory and descriptors do not move with the clients that come and go: a thousand connections, some
// well-formed, some cut short, some garbage, leave its footprint and fd count where they were. On Linux a holder is not
// dumpable, so its descriptors cannot be listed: the count is its sockets, the listening one and each accepted
// connection still open, read from the system's table by the socket's path.

import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { encodeClientFrame, HOLDER_PROTO } from '@kea/protocol'
import { isAvailable } from '../../packages/protocol/src/platform.ts'
import { harnessOs } from '../../tools/perf/src/os/index.ts'
import { holderState, ptyhostHarness, until, type Harness } from '../support/holders.ts'
import { fdCount, footprint, leakCycles } from './ptyhost-leak.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

const CYCLES = 1000

/** The holder's open descriptors, or (Linux) its sockets at `sock`: see the top of this file. */
const holderFds = (pid: number, sock: string): Promise<number> => (isAvailable(harnessOs.unixSockets) ? harnessOs.unixSockets.at(sock) : fdCount(pid))

type Visit = 'hello' | 'garbage' | 'truncated' | 'silent'

/** One client visit: connect, behave as `kind`, then close and wait for the socket to be gone on the client's side. */
function visit(sock: string, kind: Visit, garbage: Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    const s = net.createConnection({ path: sock })
    s.on('error', () => {})
    s.on('close', () => resolve())
    s.resume() // read (and drop) whatever the holder answers, so its end of the socket is seen
    s.on('connect', () => {
      const hello = encodeClientFrame({ t: 'hello', proto: HOLDER_PROTO })
      if (kind === 'hello') {
        s.write(hello)
        s.once('data', () => s.end()) // its HELLO (or nothing, if refused: then the holder closes)
      } else if (kind === 'garbage') {
        s.end(garbage)
      } else if (kind === 'truncated') {
        s.end(hello.subarray(0, Math.max(1, hello.byteLength - 3)))
      } else {
        s.end()
      }
    })
  })
}

describe('holder under client churn', () => {
  it(`L-HLD-2 · ${CYCLES} client connect/disconnect cycles with malformed frames mixed in: footprint and fd count equal`, async () => {
    h = await ptyhostHarness()
    const pty = await h.spawn({ argv: ['/bin/cat'] })
    const { sock } = pty.meta
    const pid = holderState(h.home, pty.ptyId)!.pid!
    h.stop() // ptyhost lets go: from here on the holder sees only the visitors
    const kinds = fc.sample(fc.constantFrom<Visit>('hello', 'garbage', 'truncated', 'silent'), { numRuns: CYCLES, seed: 2026 })
    const junk = fc.sample(fc.uint8Array({ minLength: 1, maxLength: 256 }), { numRuns: CYCLES, seed: 7 })
    let fds = -1
    const g = await leakCycles({
      total: CYCLES,
      cycle: (i) => visit(sock, kinds[i]!, junk[i]!),
      measure: async () => {
        // every admission check reaped and every visitor's descriptor closed: back to the count after warm-up
        if (fds < 0) fds = await holderFds(pid, sock)
        else await until('the holder fd count to return to its baseline', async () => (await holderFds(pid, sock)) === fds)
        return footprint(h!.helper, pid)
      },
      budget: { slopeBytesPerCycle: 0, absoluteBytes: 0 },
    })
    expect(fds).toBeGreaterThan(0)
    expect(g.ok, `footprint ${g.points.map((p) => p.y).join(', ')}`).toBe(true)
    // still serving: ptyhost adopts it again
    const m = await h.restart()
    expect(m.get(pty.ptyId)?.isRunning).toBe(true)
  })
})
