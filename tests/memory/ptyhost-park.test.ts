// Parking is memory-neutral and lossless: a mirror parked and woken a thousand times holds nothing back, and every wake
// shows exactly what a mirror that never parked shows.

import headless from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { resources } from '@kea/kit'
import { DEFAULT_TERMINAL_SETTINGS, L } from '@kea/protocol'
import { createTerminalOptions } from '@kea/terminal'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { ptyhostHarness, rawTty, until, type Harness } from '../support/holders.ts'
import { childArgv } from '../integration/ptyhost-child.ts'
import { mirrorTerminal, terminalState, write } from '../integration/ptyhost-support.ts'
import { heapUsed, leakCycles } from './ptyhost-leak.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

const CYCLES = 1000
const SAMPLE_EVERY = 100
/** Past the parking idle time and the checkpoint's gates (keystroke quiet, minimum interval): the park goes ahead. */
const IDLE = Math.max(L.mirrorParkIdleMs, L.checkpointQuietMs, L.checkpointMinIntervalMs) + 1

describe('parking', () => {
  it(`L-PTY-1 · park and unpark a mirror ${CYCLES} times: awake mirrors return to 0, heap within budget, every sampled wake equals a never-parked reference`, async () => {
    const clock = new ManualClock()
    h = await ptyhostHarness({ clock })
    const p = await h.spawn({ argv: rawTty(childArgv('echo')) })
    const reference = new headless.Terminal(createTerminalOptions({ side: 'mirror', cols: 80, rows: 24, scrollback: DEFAULT_TERMINAL_SETTINGS.scrollback }))
    const flush = () => clock.advance(L.coalesceWindowMs)
    let sent = 0
    let samples = 0
    const cycle = async (i: number) => {
      // an output burst wakes the mirror (the first new byte)
      const line = `cycle ${i} ${'·'.repeat(i % 50)}\r\n`
      p.input(line)
      sent += Buffer.byteLength(line)
      await write(reference, line)
      await until(`cycle ${i}'s echo to be parsed`, () => p.flushedSeq() === sent && p.currentMirror?.parsedSeq === sent && p.pendingWrites === 0, undefined, flush).catch((e: Error) => {
        const m = p.currentMirror
        const state = { sent, flushed: p.flushedSeq(), parsed: m?.parsedSeq, written: m?.writtenSeq, pending: p.pendingWrites, parked: p.isParked, replaying: p.isReplaying, stats: p.stats, log: h!.log.entries.slice(-5).map((l) => l.msg) }
        throw new Error(`${e.message}: ${JSON.stringify(state)}`)
      })
      if (i % SAMPLE_EVERY === 0) {
        expect(terminalState(mirrorTerminal(p))).toEqual(terminalState(reference))
        samples++
      }
      // idle: checkpointed and parked
      clock.advance(IDLE)
      await until(`cycle ${i}'s park`, () => p.isParked, undefined, () => clock.advance(L.checkpointMinIntervalMs))
      expect(resources.report()['ptyhost.ptys']).toEqual({ awake: 0, parked: 1 })
    }
    const g = await leakCycles({ total: CYCLES, cycle, measure: heapUsed })
    expect(p.stats.parks).toBeGreaterThanOrEqual(CYCLES)
    expect(samples).toBe(CYCLES / SAMPLE_EVERY)
    expect(g.ok, `heap: ${Math.round(g.slope)} B/cycle, ${g.absolute} B over the run`).toBe(true)
    reference.dispose()
  })
})
