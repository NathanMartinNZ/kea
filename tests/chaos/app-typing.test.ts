// Typing through a core crash, against the real app (tests/support/app.ts). It measures echo latency, which a loaded
// machine distorts, so `pnpm verify` leaves it out: it runs with `pnpm chaos`, on demand, like the perf harness.

import { afterEach, describe, expect, it } from 'vitest'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { quantile } from '../../tools/perf/src/stats.ts'
import { KeaRun, PROMPT } from '../support/app.ts'
import { expectTypingUninterrupted, watchTerminals } from '../support/app-chaos.ts'

/** Keys before the measurement (JIT, the glyph atlas), as for budget P-TERM-1 in tools/perf. */
const WARMUP = 30
/** Measured keys before the kill and again after the window is back on the new core: enough for a p99. */
const KEYS = 100
/** `cat` gets a new line now and then, so the line never wraps. */
const LINE = 60

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

describe('typing (app)', () => {
  it('I-PTY-15 · core killed while typing into a shell: echo p99 within P-TERM-1 throughout, and no key typed during the outage slower than that p99; core restarts and the window re-subscribes', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
    await kea.enter('cat')
    let typed = 0
    const key = async (): Promise<number> => {
      if (typed > 0 && typed % LINE === 0) await kea.press('Enter')
      return kea.keyEcho(String.fromCharCode(97 + (typed++ % 26)))
    }
    for (let i = 0; i < WARMUP; i++) await key()
    const samples: number[] = []
    for (let i = 0; i < KEYS; i++) samples.push(await key())
    const watch = await watchTerminals(kea)
    const core = await kea.signal('core', 'SIGKILL')
    // through the outage, until the window holds the new core's port, then as many keys again
    const during: number[] = []
    for (;;) {
      during.push(await key())
      if ((await watch.received('rpc')) >= 1) break
    }
    for (let i = 0; i < KEYS; i++) samples.push(await key())
    samples.push(...during)
    await kea.press('Control+c')
    const next = await kea.pid('core')
    expect(next.pid, 'core restarted').not.toBe(core.pid)
    expect(kea.started('core', next.pid), 'the new core is serving').toBe(true)
    const b = BUDGETS['P-TERM-1']
    const p99 = quantile(samples, 0.99)
    expect(during.length, 'keys typed while core was down or restarting').toBeGreaterThan(0)
    expect(p99, `echo p99 over ${samples.length} keys (max ${Math.max(...samples).toFixed(1)} ms) within P-TERM-1`).toBeLessThanOrEqual(b.p99)
    // a stall during the outage is one slow key among hundreds, which the pooled p99 drops: the outage keys on their own
    expectTypingUninterrupted(during, 'while core was down or restarting')
    await kea.assertUnfocused()
  })
})

