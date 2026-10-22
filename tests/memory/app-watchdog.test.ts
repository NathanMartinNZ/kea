// The memory watchdog against real allocations in the real app (tests/support/app.ts). Its policy is tested in
// app/main/src/watchdog.test.ts, and its four actions with a test seam's weights in tests/chaos/app-watchdog.test.ts:
// what is left here is the allocation itself. Core, then ptyhost, really holds more than its hard limit (the child
// hook's `alloc`: buffers outside V8's heap, every page written, so V8's cap of the same size does not end the process
// first), the person is idle (main's seam, the one thing faked), and the watchdog acts on a real footprint sample.

import { afterEach, describe, expect, it } from 'vitest'
import { L } from '@kea/protocol'
import { counterCommand, counterNumbers, KeaRun, STEP_MS, type Kea } from '../support/app.ts'
import { holdersUnharmed, lastOnScreen, ringContinuity, seamContinuous } from '../support/app-chaos.ts'
import { agentEvents, claudeByDefault, fakeAgentTerminal, startFakeSession } from '../support/app-fake-agent.ts'
import { addProject, demoRepo, waitRow } from '../support/app-sessions.ts'
import { actionTimes, brief, loggedTriggers, watchdogFeed, watchdogIdle, watchdogLines, type Trigger } from '../support/app-watchdog.ts'

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

/** Counter lines per second in the shell tab (tests/support/app-chaos.ts). */
const RATE = 4
/** Held past the hard limit: enough that the process's own memory cannot be what decides it. */
const OVER_BY = 64 * 1024 * 1024
const HARD = { core: L.watchdogHardCoreBytes, ptyhost: L.watchdogHardPtyhostBytes } as const
/** A launch, a session, then two allocations, samples and restarts. */
const ROW_MS = 6 * STEP_MS

/** An agent at its prompt that waits: the session stays live and quiet. */
const IDLE = `steps:
  - frame: ["✻ fake-agent", "", "> "]
  - wait: { answer: z }
`

describe('the memory watchdog under real allocations (app)', () => {
  it(
    'L-MEM-12 · core, then ptyhost, really holding more than its hard limit while the person is idle: the watchdog finds it in a real footprint sample and restarts it through the Supervisor, once; the new process holds none of it and the next sample finds nothing over; the session’s holders, its agent and a counter run on without a gap; each trigger is an error in main.log and a resources.ndjson line with every process’s report from before the restart',
    async () => {
      const run = KeaRun.create()
      runs.push(run)
      run.expectWatchdog()
      claudeByDefault(run)
      const kea: Kea = await run.launch()
      await addProject(kea, demoRepo(run).root)
      const agent = await startFakeSession(kea, 'l-mem-12', 'idle through the watchdog', IDLE)
      await fakeAgentTerminal(kea, agent.id)
      const counter = await kea.newTab()
      await kea.enter(counterCommand(RATE))
      await kea.waitScreen('counter output', (s) => counterNumbers(s).length >= 2)
      const seen = await lastOnScreen(kea)
      const holders = run.holders()

      // the person is idle from here on, and the watchdog looks when the test feeds it (from the first fed interval on,
      // the sampler's own intervals no longer reach it): every interval below is a real sample, no process's weight given
      await watchdogIdle(kea, L.watchdogIdleMs)
      expect(await watchdogFeed(kea, {}), 'a real sample before anything is allocated: nothing over').toEqual([])

      const triggers: Trigger[] = []
      for (const name of ['core', 'ptyhost'] as const) {
        const before = await kea.pid(name)
        const heapLimit = (await kea.debug<{ heap_size_limit: number }>(name, 'heap')).heap_size_limit
        const held = await kea.debug<{ held: number; heapUsed: number }>(name, 'alloc', String(HARD[name] + OVER_BY))
        expect(held.held, `${name} holds what it was asked to`).toBe(HARD[name] + OVER_BY)
        // outside V8's heap: its cap (the hard limit plus the young generation) is not what this reaches
        expect(held.heapUsed, `${name}'s JavaScript heap stays far under V8's cap of ${heapLimit} B`).toBeLessThan(heapLimit / 4)

        const got = await watchdogFeed(kea, {}, 2 * STEP_MS)
        expect(got.map((t) => ({ ...t, bytes: 0 })), `${name}: one trigger, the restart`).toEqual([{ process: name, pid: before.pid, bytes: 0, limit: 'hard', limitBytes: HARD[name], action: 'restart' }])
        expect(got[0]!.bytes, `${name}'s footprint as the sample read it`).toBeGreaterThan(HARD[name])
        triggers.push(got[0]!)
        await kea.restarted(name, before)

        // its line was collected before the restart: the reports of the process that went, the sample's bytes
        const line = watchdogLines(run).at(-1)!
        expect(line.watchdog).toEqual(got)
        expect(Object.keys(line.reports).sort(), 'every process’s report').toEqual(['core', 'main', 'ptyhost', 'renderer'])
        expect(line.missing).toEqual({})
        expect(line.footprint?.pids[name]).toBe(before.pid)
        expect(line.footprint?.bytes[name]).toBe(got[0]!.bytes)

        // the new process holds none of it: the next real sample finds nothing over, and nothing acts
        expect(await watchdogFeed(kea, {}), `after ${name}'s restart`).toEqual([])
        const after = await kea.pid(name)
        expect((await kea.debug<{ heapUsed: number }>(name, 'heap')).heapUsed, `the new ${name}'s heap`).toBeLessThan(HARD[name] / 4)
        expect(after.pid).not.toBe(before.pid)

        // the session through it: its agent still at its prompt, the counter without a gap
        await waitRow(kea, agent.id, `live after ${name}'s restart`, (r) => r.lifecycle === 'live')
        expect(agentEvents(agent.log).filter((e) => e.t === 'ending' || e.t === 'exit'), `the agent did not end (${name})`).toEqual([])
        await seamContinuous(run, kea, counter, { before: seen })
      }

      holdersUnharmed(run, holders)
      ringContinuity(run, counter)
      // every trigger is an error in main.log, and each action finished
      expect(brief(loggedTriggers(kea))).toEqual(['core hard:restart', 'ptyhost hard:restart'])
      expect(actionTimes(kea).map((a) => [a.process, a.action])).toEqual([
        ['core', 'restart'],
        ['ptyhost', 'restart'],
      ])
      console.log(`L-MEM-12: footprints read by the watchdog: ${triggers.map((t) => `${t.process} ${(t.bytes / 2 ** 20).toFixed(0)} MiB (hard limit ${(t.limitBytes / 2 ** 20).toFixed(0)} MiB)`).join(', ')}`)
      await kea.assertUnfocused()
    },
    ROW_MS,
  )
})
