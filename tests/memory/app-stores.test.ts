// Store deltas and supervised restarts against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts. The store here is core's terminals store; the status storm across 50 sessions is in
// app-status.test.ts.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@kea/kit'
import { KeaRun, PROMPT, until, type Kea } from '../support/app.ts'
import { holdersUnharmed } from '../support/app-chaos.ts'
import { expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'

/** Deltas per cycle; ten measured cycles make 10 000. */
const TITLES_PER_CYCLE = 1000
/** The restart test's live holders, and restarts of each process. */
const HOLDERS = 20
const RESTARTS = 50
/** The restart test's time limit: 100 restarts, each re-adopting the 20 holders. */
const RESTARTS_TEST_MS = 15 * 60_000

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

async function start(): Promise<{ run: KeaRun; kea: Kea; renderer: RendererProbe }> {
  const run = KeaRun.create()
  runs.push(run)
  const kea = await run.launch()
  await kea.waitScreen('the first shell prompt', (s) => s.includes(PROMPT))
  const renderer = await RendererProbe.open(kea)
  probes.push(renderer)
  return { run, kea, renderer }
}

describe('store and restart leaks (app)', () => {
  it('L-MEM-3 · 10 000 terminals-store deltas (shell titles through ptyhost and core to the tab strip): heaps within budget; tab strip and every count constant', async () => {
    const { run: kr, kea, renderer } = await start()
    const page = await kea.page()
    // OSC 2 titles: each is a delta of the store's entry for this PTY (latest wins). The shell prints a batch whenever
    // the test writes to a FIFO, so no cycle types into the terminal: Chromium keeps up to 1000 undo steps of xterm's
    // input textarea, two DOM nodes each, which would read as growth here
    const fifo = path.join(kr.home, 'titles.fifo')
    expect((await runProcess('/usr/bin/mkfifo', [fifo], { pool: 'other' })).code).toBe(0) // os-ok: in /usr/bin on both systems
    await kea.enter(`while read n < ${fifo}; do for i in {1..${TITLES_PER_CYCLE}}; do printf '\\e]2;c%s-%d\\a' "$n" $i; done; done`)
    const run = await runCycles({
      kea,
      renderer,
      batch: 1,
      cycle: async (i) => {
        fs.writeFileSync(fifo, `${i}\n`)
        await until(`title c${i}-${TITLES_PER_CYCLE} on the tab`, async () => (await page.locator('[role=tab]', { hasText: `c${i}-${TITLES_PER_CYCLE}` }).count()) === 1 || undefined)
      },
    })
    expect(run.cycles.at(-1)! * TITLES_PER_CYCLE).toBe(10_000)
    expectCountsFlat(run, () => true)
    await expectBytesFlat(kea, renderer, run, ['renderer.heap', 'core.heap', 'ptyhost.heap', 'main.heap'], 'L-MEM-3')
  })

  it(
    'L-MEM-8 · ptyhost restarted 50 times, then core 50 times, with 20 live holders: holders untouched; main heap within budget; each restarted process starts at the same counts',
    async () => {
      const { run, kea, renderer } = await start()
      for (let i = 1; i < HOLDERS; i++) await kea.newTab()
      const holders = run.holders()
      expect(holders).toHaveLength(HOLDERS)
      // ready again: the new ptyhost holds every holder's socket; the new core has its control port and the window's
      const serving = {
        ptyhost: async () => ((await kea.debug<Record<string, number>>('ptyhost', 'kit'))['ptyhost.holderSockets'] === HOLDERS ? true : undefined),
        core: async () => ((await kea.debug<number>('core', 'ports')) === 2 ? true : undefined),
      }
      for (const name of ['ptyhost', 'core'] as const) {
        const result = await runCycles({
          kea,
          renderer,
          batch: RESTARTS / 10,
          cycle: async () => {
            const old = await kea.pid(name)
            await kea.supervisorRestart(name)
            await kea.restarted(name, old)
            await until(`the new ${name} serving`, serving[name])
          },
        })
        expect(result.cycles.at(-1)).toBe(RESTARTS)
        // every checkpoint reads a different process: each starts where the first restarted one did
        expectCountsFlat(result, (k) => k.startsWith(`${name}.`) || k.startsWith('main.'))
        await expectBytesFlat(kea, renderer, result, ['main.heap', `${name}.heap`], `L-MEM-8-${name}`)
      }
      holdersUnharmed(run, holders)
    },
    RESTARTS_TEST_MS,
  )
})
