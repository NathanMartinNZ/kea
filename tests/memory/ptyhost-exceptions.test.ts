// Mirror exceptions cost a rebuild each and nothing else. `@xterm/headless` can throw from inside a timer; here ptyhost
// runs in a worker thread with its real `uncaughtException` guard, and a hundred injected headless stalls later its
// counts are where they started.

import { afterEach, describe, expect, it } from 'vitest'
import { rawTty } from '../support/holders.ts'
import { childArgv } from '../integration/ptyhost-child.ts'
import { PtyhostWorker } from '../integration/ptyhost-worker.ts'
import { leakCycles, median, METHOD } from './ptyhost-leak.ts'

let w: PtyhostWorker | null = null
afterEach(async () => {
  await w?.dispose()
  w = null
})

const THROWS = 100

describe('mirror exceptions', () => {
  it(`L-PTY-6 · ${THROWS} mirror exceptions thrown from timers: each mirror rebuilt, ptyhost never exits, mirror/timer/scope counts back to baseline, heap within budget`, async () => {
    w = await PtyhostWorker.start()
    const worker = w
    const a = await worker.spawn(rawTty(childArgv('echo')))
    const b = await worker.spawn(rawTty(childArgv('echo')))
    await worker.input(b, 'b ')
    const bBefore = await worker.settled(b, 'b echoed', (s) => s.screen?.includes('b') ?? false)
    const counts = (r: Awaited<ReturnType<PtyhostWorker['measure']>>['report']) => ({
      ptys: r['ptyhost.ptys'],
      ptyTimers: r['ptyhost.ptyTimers'],
      mirrors: r['ptyhost.mirrors'],
      sockets: r['ptyhost.holderSockets'],
      scopes: r['kit.scopes'],
      timers: r['kit.timers'],
    })
    let baseline: ReturnType<typeof counts> | null = null
    let thrown = 0
    const g = await leakCycles({
      total: THROWS,
      cycle: async (i) => {
        await worker.stall(a)
        await worker.input(a, `e${i}\r\n`)
        thrown++
        await worker.settled(a, `throw ${i} to rebuild A`, (s) => s.stats.rebuilds === thrown && (s.screen?.includes(`e${i}`) ?? false))
      },
      measure: async () => {
        const r: number[] = []
        for (let k = 0; k < METHOD.readings; k++) {
          const m = await worker.measure()
          r.push(m.heapUsed)
          baseline ??= counts(m.report)
          expect(counts(m.report)).toEqual(baseline)
        }
        return median(r)
      },
    })
    expect(thrown).toBe(THROWS)
    expect(worker.exited).toBeNull()
    expect((await worker.logs()).filter((e) => e.msg === 'uncaught exception')).toHaveLength(THROWS)
    expect((await worker.state(b)).stats).toEqual(bBefore.stats)
    expect(g.ok, `heap: ${Math.round(g.slope)} B/throw, ${g.absolute} B over the run`).toBe(true)
  })
})
