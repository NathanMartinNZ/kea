// A status storm across 50 sessions against the real app (tests/support/app.ts), measured with
// tests/support/app-leak.ts: the delta storm and the frozen renderer that app-stores.test.ts and app-window.test.ts put
// the terminals store through, here for the status stores. The storm is applied inside core through the status engine,
// as the hook intake applies a hook's events (tests/support/app-child-hooks.cjs `status`; core hands the hook its
// engine, app/core/src/status/seam.ts).

import { L } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { KeaRun, until, type Kea } from '../support/app.ts'
import { BYTE_BUDGET, expectBytesFlat, expectCountsFlat, RendererProbe, runCycles } from '../support/app-leak.ts'
import { addProject, demoRepo, startSession, waitLive } from '../support/app-sessions.ts'

const SESSIONS = 50
/** Status inputs per cycle; ten measured cycles make 10 000. */
const PER_CYCLE = 1_000
/** The storm during the freeze: 10 000 at once. */
const STORM = 10_000
/** Inputs per store tick (L.storeTickMs): far above any real hook stream, so every tick carries a change for every session. */
const CHUNK = 50
/** 50 sessions created through the composer, two storms and twelve checkpoints of every process. */
const TEST_MS = 15 * 60_000

const runs: KeaRun[] = []
const probes: RendererProbe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
  for (const r of runs.splice(0)) await r.dispose()
})

/** `deltas` status inputs across every live session; each session ends ready (unread) with the title `title`. */
function storm(kea: Kea, deltas: number, title: string): Promise<{ sessions: number; ringEntries: number }> {
  return kea.debug('core', 'status', JSON.stringify({ deltas, chunk: CHUNK, everyMs: L.storeTickMs, title }))
}

/** The sidebar's DOM nodes, and how many session rows show `title`. */
async function sidebar(kea: Kea, title: string): Promise<{ nodes: number; titled: number }> {
  return (await kea.page()).evaluate((t) => {
    const tree = document.querySelector('[role=tree]')
    return { nodes: tree ? tree.querySelectorAll('*').length : -1, titled: document.querySelectorAll(`[role=treeitem][data-session-id][aria-label=${JSON.stringify(t)}]`).length }
  }, title)
}

describe('status store deltas (app)', () => {
  it(
    'L-MEM-19 · 10 000 status deltas across 50 sessions: heaps within budget, sidebar DOM nodes and every count constant; the same storm with the renderer frozen: core holds at most one pending delta per store, its heap within budget, and the resumed sidebar shows the latest',
    async (ctx) => {
      const run = KeaRun.create()
      runs.push(run)
      const kea = await run.launch()
      // main relays only the ops it lists (app/main/src/testHooks.ts); this one needs `status` there
      const probe = await storm(kea, 0, '').then(
        () => '',
        (e: Error) => e.message,
      )
      if (/unknown op/.test(probe)) {
        ctx.skip('main does not relay the `status` test op yet (app/main/src/testHooks.ts OPS)')
        return
      }
      await addProject(kea, demoRepo(run).root)
      const ids: string[] = []
      for (let i = 0; i < SESSIONS; i++) ids.push(await startSession(kea, `storm ${i + 1}`, { background: true, open: i === 0 }))
      for (const id of ids) await waitLive(kea, id)
      const renderer = await RendererProbe.open(kea)
      probes.push(renderer)
      const shows = (title: string) => until(`every row titled ${title}`, async () => ((await sidebar(kea, title)).titled === SESSIONS ? true : undefined))

      // first, every session's recent-signal ring filled, so the rings are at their cap from the baseline on
      expect((await storm(kea, SESSIONS * (L.signalRingEntries + 2 + 4), 'primed')).sessions).toBe(SESSIONS)
      await shows('primed')
      const nodes: number[] = []
      const leak = await runCycles({
        kea,
        renderer,
        batch: 1,
        cycle: async (i) => {
          await storm(kea, PER_CYCLE, `c${i}`)
          await shows(`c${i}`)
          nodes.push((await sidebar(kea, `c${i}`)).nodes)
        },
      })
      expect(leak.cycles.at(-1)! * PER_CYCLE).toBe(10_000)
      expect(new Set(nodes).size, `sidebar DOM nodes after each storm: ${nodes}`).toBe(1)
      expectCountsFlat(leak, () => true)
      await expectBytesFlat(kea, renderer, leak, ['renderer.heap', 'core.heap', 'main.heap'], 'L-MEM-19')

      // the same storm while the renderer is frozen (app-window.test.ts freezes it for the terminals store)
      const kit = async () => {
        const k = await kea.debug<Record<string, unknown>>('core', 'kit')
        return { pending: k['core.pendingDeltas'] as number, subscriptions: k['core.subscriptions'] as number }
      }
      const heapOf = async () => {
        await kea.debug('core', 'gc')
        return (await kea.debug<{ heapUsed: number }>('core', 'heap')).heapUsed
      }
      const before = { heap: await heapOf(), nodes: (await sidebar(kea, '')).nodes, kit: await kit() }
      const frozen = await kea.signal('renderer', 'SIGSTOP')
      const seen: { pending: number; subscriptions: number }[] = []
      try {
        let done = false
        const storming = storm(kea, STORM, 'frozen').finally(() => {
          done = true
        })
        // one delta in flight and one merged pending per subscription, whatever the storm brings
        while (!done) seen.push(await kit())
        await storming
        seen.push(await kit())
        expect(seen.length, 'readings during the storm').toBeGreaterThan(1)
        for (const r of seen) expect(r.pending, `pending deltas against ${r.subscriptions} subscriptions`).toBeLessThanOrEqual(r.subscriptions)
        expect(seen.every((r) => r.subscriptions === before.kit.subscriptions), 'the frozen window keeps its subscriptions').toBe(true)
        expect((await heapOf()) - before.heap, 'core heap growth while the renderer was frozen').toBeLessThanOrEqual(BYTE_BUDGET.absolute)
      } finally {
        await kea.signal('renderer', 'SIGCONT')
      }
      expect((await kea.processes()).renderer?.pid, 'the same renderer resumed').toBe(frozen.pid)
      await shows('frozen')
      expect((await sidebar(kea, 'frozen')).nodes).toBe(before.nodes)
    },
    TEST_MS,
  )
})
