// The per-event target for the synchronous hook helper, in-process: core as main.ts assembles it, on a temp
// KEA_HOME with a real ptyhost (tests/integration/core-agents-support.ts), and tools/fake-agent as `claude` firing 500
// hooks a turn through real `kea-helper hook` processes (the release build Kea ships). Run it on the reference machine
// with nothing else heavy running; tests/integration/core-agents.test.ts holds the same burst to the hard bound under
// the integration suite's load (I-AGT-3). The result is recorded in tools/perf/last.json like the others.

import { describe, expect, it } from 'vitest'
import type { Envelope } from '@kea/core/src/agents/intake.ts'
import { BUDGETS } from '../../tools/perf/src/generated/budgets.ts'
import { check, perfEnv, recordResult } from '../../tools/perf/src/record.ts'
import { startAgentSessions } from '../integration/core-agents-support.ts'
import { repo } from '../integration/core-sessions-support.ts'
import { helperBinary, until } from '../support/holders.ts'

/** Each scenario runs 3× after one warm-up; a p99 uses every sample. */
const RUNS = 3
/** A turn: UserPromptSubmit, this many PreToolUse/PostToolUse pairs, then Stop: 500 events (as in I-AGT-3). */
const PAIRS = 249
const EVENTS = 2 * PAIRS + 2

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!

describe('hook delivery (in-process)', () => {
  it(`P-AGT-1 · ${EVENTS} synchronous hook events a turn, ${RUNS} turns after one warm-up: the helper’s own run per event (its stamp → core reading the envelope), p99 of every sample within the target`, async () => {
    const s = await startAgentSessions({ opts: { helperPath: await helperBinary('release') } })
    const r = repo('perf-hooks')
    try {
      const p = await s.project(r.root)
      const pairs = `  - loop: { times: ${PAIRS}, steps: [ { hook: { event: PreToolUse, tool: Read, input: { file_path: "a.txt" } } }, { hook: { event: PostToolUse, tool: Read, input: { file_path: "a.txt" } } } ] }`
      s.shim({ FAKE_AGENT_SCENARIO: s.scenario('burst.yaml', `version: 1\nsteps:\n  - print: "READY\\r\\n"\nonLine:\n  - hook: UserPromptSubmit\n${pairs}\n  - hook: Stop\n`) })
      const v = await s.create(p.id, '')
      const hookName = (e: Envelope) => (e.payload as { hook_event_name?: string }).hook_event_name
      await until('SessionStart delivered', () => s.envelopes.some((e) => e.keaSessionId === v.id && hookName(e) === 'SessionStart'))
      const samples: number[] = []
      for (let run = 0; run <= RUNS; run++) {
        const from = s.envelopes.length
        s.type(v.id, 'go\r')
        await s.until(v.id, `turn ${run} applied`, (x) => x.phase === 'ready' && s.envelopes.length - from >= EVENTS)
        const burst = s.envelopes.slice(from, from + EVENTS)
        expect(burst.map(hookName).filter((n) => n === 'Stop')).toHaveLength(1)
        if (run === 0) continue // the warm-up
        const arrived = s.arrivals.slice(from, from + EVENTS)
        samples.push(...burst.map((e, i) => arrived[i]! - e.receivedAt))
      }
      expect(s.c.core.agents.stats.spoolDrains, 'none spooled: every helper had core’s answer').toBe(0)
      samples.sort((a, b) => a - b)
      const b = BUDGETS['P-AGT-1']
      const values = { p50Ms: quantile(samples, 0.5), p99Ms: quantile(samples, 0.99), maxMs: samples.at(-1)!, samples: samples.length }
      console.log(`P-AGT-1 hook delivery: p50 ${values.p50Ms.toFixed(2)} ms, p99 ${values.p99Ms.toFixed(2)} ms, max ${values.maxMs.toFixed(2)} ms over ${values.samples} events`)
      const entry = recordResult(
        {
          id: 'P-AGT-1',
          metric: b.metric,
          method: `tools/fake-agent as claude on an in-process core with a real ptyhost: ${RUNS} turns of ${EVENTS} synchronous hooks (UserPromptSubmit, ${PAIRS} PreToolUse/PostToolUse pairs, Stop) through the release kea-helper, after one unmeasured turn; per event, the helper's receivedAt stamp → core's intake reading the envelope (wall clock); p99 of every sample`,
          values,
          checks: [check('p99Ms', values.p99Ms, b.p99, 'max', b.unit)],
        },
        { env: perfEnv(`in-process: Vitest on Node ${process.version}, release kea-helper`) },
      )
      expect(entry.pass, `P-AGT-1: ${JSON.stringify(values)}`).toBe(true)
    } finally {
      await s.dispose()
      r.dispose()
    }
  })
})
