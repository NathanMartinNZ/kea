// A mirror whose parser stops completing writes is found within the stall time, rebuilt from checkpoint + ring, and
// what it held is let go: acks resume and the counts return to where they were.

import { afterEach, describe, expect, it } from 'vitest'
import { resources } from '@kea/kit'
import { L } from '@kea/protocol'
import { ManualClock } from '../../app/ptyhost/src/test-support.ts'
import { ptyhostHarness, rawTty, until, type Harness } from '../support/holders.ts'
import { childArgv } from '../integration/ptyhost-child.ts'
import { heapUsed, leakCycles } from './ptyhost-leak.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.dispose()
  h = null
})

const STALLS = 20

describe('stalled mirror', () => {
  it(`L-PTY-4 · a mirror that never completes a write is found within the stall time and rebuilt; pending data released, acks resume (${STALLS} times)`, async () => {
    const clock = new ManualClock()
    h = await ptyhostHarness({ clock })
    const harness = h
    const p = await h.spawn({ argv: rawTty(childArgv('echo')) })
    const flush = () => clock.advance(L.coalesceWindowMs)
    let sent = 0
    const echo = async (text: string) => {
      p.input(text)
      sent += text.length
      await until(`"${text.trim()}" echoed and parsed`, () => p.flushedSeq() === sent && p.currentMirror?.parsedSeq === sent && p.pendingWrites === 0, undefined, flush)
    }
    await echo('ready\r\n')
    const counts = () => {
      const r = resources.report() // the report main logs
      return { ptys: r['ptyhost.ptys'], ptyTimers: r['ptyhost.ptyTimers'], mirrors: r['ptyhost.mirrors'], scopes: r['kit.scopes'], timers: r['kit.timers'] }
    }
    const before = counts()
    let stalls = 0
    const g = await leakCycles({
      total: STALLS,
      cycle: async (i) => {
        // the stall starts at an arbitrary point of time, not on a check boundary
        clock.advance(1 + ((i * 1777) % L.mirrorStallMs))
        const m = p.currentMirror!
        ;(m.terminal as unknown as { write(d: unknown, cb?: () => void): void }).write = () => {} // never parses, never calls back
        const line = `stall ${i}\r\n`
        p.input(line)
        sent += line.length
        await until('the write to be swallowed', () => p.flushedSeq() === sent && p.pendingWrites > 0, undefined, flush)
        const rebuilds = p.stats.rebuilds
        clock.advance(L.mirrorStallMs - 1 - L.coalesceWindowMs) // the swallowed write went in at most one flush tick ago
        expect(p.stats.rebuilds, 'rebuilt before the stall time').toBe(rebuilds)
        clock.advance(1 + L.coalesceWindowMs)
        expect(p.stats.rebuilds, 'not rebuilt at the stall time').toBe(rebuilds + 1)
        stalls++
        // the new mirror parses what the old one swallowed (from the ring), and acks flow again
        await until('the rebuild to catch up', () => p.currentMirror !== m && p.currentMirror?.parsedSeq === sent && p.pendingWrites === 0, undefined, flush)
        await echo(`after ${i}\r\n`)
      },
      measure: heapUsed,
    })
    expect(stalls).toBe(STALLS)
    expect(p.screenText()).toContain(`after ${STALLS - 1}`)
    expect(counts()).toEqual(before)
    expect(g.ok, `heap: ${Math.round(g.slope)} B/stall, ${g.absolute} B over the run`).toBe(true)
  })
})
