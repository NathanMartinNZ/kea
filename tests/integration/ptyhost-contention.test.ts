// Two terminals in one ptyhost, one of them flooding: keystroke echo in the other, and core's control RPC, stay
// within the hard bound L.floodNeighbourBoundMs: neither waits behind the flood. Ptyhost runs in a worker thread, so
// its event loop is not the renderers' (as in the app: one ptyhost process; one renderer process for the window, which
// parses the flood's terminal too). Both renderers and core's end of the control port live in the test thread.
//
// The bound holds under any load, and the integration suite's other files run alongside this one. How fast the echo is
// on a quiet reference machine is budget P-TERM-2, which tests/perf/app-terminal.test.ts measures in the real window.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { zooCommand } from '@kea-tools/process-zoo/src/index.ts'
import { quantile } from '../../tools/perf/src/stats.ts'
import { rawTty, until } from '../support/holders.ts'
import { TestRenderer } from './ptyhost-support.ts'
import { PtyhostWorker } from './ptyhost-worker.ts'

let w: PtyhostWorker | null = null
const renderers: TestRenderer[] = []
afterEach(async () => {
  for (const r of renderers.splice(0)) r.close()
  await w?.dispose()
  w = null
})

/** As many keys as budget P-TERM-2 measures, after the harness's warm-up keys (tools/perf). */
const KEYS = 1000
const WARMUP = 30
/** Core pings ptyhost once per this many keys, between them. */
const PING_EVERY = 10
/** The flood must make progress in every block of this many keys. */
const BLOCK = 100
/** A flood that outlasts the test (which terminates it). */
const FLOOD = ['--bytes', '1000G']
const chars = 'abcdefghijklmnopqrstuvwxy'

describe('a flood next door', () => {
  it(`I-PTY-8 · one terminal floods: echo in the other over ${KEYS} keys and core's RPC ping stay within the hard flood-neighbour bound (p99), the flood keeps flowing and the echo stream has no gap`, async () => {
    w = await PtyhostWorker.start()
    const worker = w
    const core = await worker.control()
    const echoId = await worker.spawn(rawTty(['/bin/cat']))
    let wake: ((seq: number) => void) | null = null
    const echo = new TestRenderer({ port: await worker.attach(echoId) }, echoId, { onWritten: (seq) => wake?.(seq) })
    renderers.push(echo)
    await until('the echo terminal\'s snapshot', () => echo.snapshots === 1 && echo.writtenSeq >= 0)

    /** Type one key; resolves with the ms until the renderer has written its echo. */
    const key = (ch: string) =>
      new Promise<number>((resolve) => {
        const want = echo.writtenSeq + 1
        const t0 = performance.now()
        wake = (seq) => {
          if (seq < want) return
          wake = null
          resolve(performance.now() - t0)
        }
        echo.input(ch)
      })
    const ping = async () => {
      const t0 = performance.now()
      await core.call('pty.list', {})
      return performance.now() - t0
    }

    // at rest first, for the report
    const idle: number[] = []
    for (let i = 0; i < WARMUP + KEYS / PING_EVERY; i++) {
      await key(chars[i % chars.length]!)
      if (i >= WARMUP) idle.push(await ping())
    }

    const floodCmd = zooCommand('flood', FLOOD)
    const floodId = await worker.spawn([floodCmd.file, ...floodCmd.args])
    const flood = new TestRenderer({ port: await worker.attach(floodId) }, floodId, { keepData: false })
    renderers.push(flood)
    await until('the flood to reach its renderer', () => flood.writtenSeq > 0)

    const echoes: number[] = []
    const pings: number[] = []
    const stalledBlocks: number[] = []
    const t0 = performance.now()
    const bytes0 = flood.writtenSeq
    let blockStart = flood.writtenSeq
    for (let i = 0; i < WARMUP + KEYS; i++) {
      const ms = await key(chars[i % chars.length]!)
      if (i < WARMUP) continue
      echoes.push(ms)
      const n = i - WARMUP + 1
      if (n % PING_EVERY === 0) pings.push(await ping())
      if (n % BLOCK === 0) {
        if (flood.writtenSeq === blockStart) stalledBlocks.push(n / BLOCK)
        blockStart = flood.writtenSeq
      }
    }
    const secs = (performance.now() - t0) / 1000
    const floodMBps = (flood.writtenSeq - bytes0) / 1e6 / secs
    const fmt = (xs: number[]) => `p50 ${quantile(xs, 0.5).toFixed(1)}, p99 ${quantile(xs, 0.99).toFixed(1)}, max ${Math.max(...xs).toFixed(1)} ms`
    console.log(`I-PTY-8 echo under flood: ${fmt(echoes)}; RPC ping at rest ${fmt(idle)}, under flood ${fmt(pings)}; flood ${floodMBps.toFixed(1)} MB/s to its renderer`)

    expect(stalledBlocks, 'the flood stalled during these blocks of keys').toEqual([])
    expect(echo.discontinuities).toEqual([])
    // the hard bound, under whatever load the suite's other files make (the 99th percentile: one scheduling hiccup of a
    // loaded machine is not a stalled neighbour); the perf suite judges budget P-TERM-2's p99, on a quiet machine
    expect(quantile(echoes, 0.99)).toBeLessThanOrEqual(L.floodNeighbourBoundMs)
    expect(quantile(pings, 0.99)).toBeLessThanOrEqual(L.floodNeighbourBoundMs)
  })
})
