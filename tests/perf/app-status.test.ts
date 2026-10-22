// Status budgets in the window against the real app, a release build launched unfocused on a fresh KEA_HOME
// (tests/perf/app-harness.ts), with tools/fake-agent as its `claude` (tests/support/app-fake-agent.ts).
//
//   P-UI-6  hook fired → sidebar glyph changed: the agent waits at a gate (a FIFO); the test opens it and the agent's
//           next step is the hook (a real `kea-helper hook` process → core's socket → the status engine → the
//           `sessions` store → the window). From the gate's opening (the test's wall clock, just before its write) to
//           the frame that draws the row's new glyph (the window's wall clock in the first animation frame after the
//           row changed). The gate's opening comes a little before the hook's start (the fake agent reads the gate and
//           builds the payload first), so the number is an upper bound. The session is not on screen and its status
//           file is off: only the hook moves the row.

import { afterEach, describe, expect, it } from 'vitest'
import { STEP_MS } from '../support/app.ts'
import { addProject, demoRepo, waitRow } from '../support/app-sessions.ts'
import { gate, startFakeSession } from '../support/app-fake-agent.ts'
import { budget, check, disposeRuns, dist, median, record, RUNS, startKea, WARMUPS } from './app-harness.ts'

afterEach(disposeRuns)

/** Status changes measured per run: half permission requests (→ needs you), half answers (→ working). */
const CHANGES = 10

describe('status in the window (app)', () => {
  it(`P-UI-6 · hook fired → the sidebar row's glyph changed (the frame that draws it), median of ${RUNS} runs of ${CHANGES} changes after ${WARMUPS} unmeasured run`, async () => {
    const { run, kea } = await startKea({ settings: { general: { defaultAgent: 'claude' } } })
    const page = await kea.page()
    await addProject(kea, demoRepo(run).root)
    const g = gate(run, 'p-ui-6')
    const rounds = ((WARMUPS + RUNS) * CHANGES) / 2
    const s = await startFakeSession(
      kea,
      'p-ui-6',
      'measured',
      `statusFile: off
steps:
  - hook: UserPromptSubmit
  - frame: ["✻ fake-agent", "", "✶ Working…"]
  - loop:
      times: ${rounds}
      steps:
        - ${g.step}
        - hook: { event: PermissionRequest, tool: Bash, input: { command: "npm test" } }
        - ${g.step}
        - hook: { event: PostToolUse, tool: Bash, input: { command: "npm test" } }
`,
      { background: true, open: false },
    )
    await waitRow(kea, s.id, 'working', (r) => r.status === 'working')

    const runs: number[][] = []
    for (let r = 0; r < WARMUPS + RUNS; r++) {
      const ms: number[] = []
      for (let i = 0; i < CHANGES; i++) {
        // armed first: the row's glyph now, then the wall time of the frame after it changes
        await page.evaluate(
          ([id, timeoutMs]) => {
            const w = window as unknown as { __pui6?: Promise<{ at: number; glyph: string | null }> }
            const glyph = () => document.querySelector(`[role=treeitem][data-session-id="${id}"] .kea-glyph`)?.getAttribute('data-glyph') ?? null
            const from = glyph()
            w.__pui6 = new Promise((resolve, reject) => {
              const obs = new MutationObserver(() => {
                if (glyph() === from) return
                obs.disconnect()
                clearTimeout(timer)
                requestAnimationFrame(() => resolve({ at: Date.now(), glyph: glyph() }))
              })
              const timer = setTimeout(() => {
                obs.disconnect()
                reject(new Error(`the glyph stayed ${from}`))
              }, timeoutMs)
              obs.observe(document.querySelector('aside[aria-label=Sidebar]')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-glyph'] })
            })
          },
          [s.id, STEP_MS] as const,
        )
        const opened = await g.open()
        const seen = await page.evaluate(() => (window as unknown as { __pui6: Promise<{ at: number; glyph: string | null }> }).__pui6)
        expect(seen.glyph, `change ${i}`).toBe(i % 2 === 0 ? 'needsYou' : 'working')
        ms.push(seen.at - opened)
      }
      runs.push(ms)
    }
    const measured = runs.slice(WARMUPS)
    const all = measured.flat()
    const value = median(measured.map((x) => median(x)))
    const b = budget('P-UI-6')
    const d = dist(all)
    const e = record({
      id: 'P-UI-6',
      metric: b.metric,
      method: `one fake-agent session not on screen, status file off; its agent waits at a FIFO gate, then fires PermissionRequest (→ needs you) or PostToolUse (→ working) through a real kea-helper hook; from the gate's opening (test wall clock) to the first animation frame after the row's glyph changed (window wall clock); ${CHANGES} changes per run, ${WARMUPS} unmeasured run, the median of ${RUNS} run medians (p99 and max of every change reported)`,
      values: { medianMs: value, p50Ms: d.p50, p99Ms: d.p99, maxMs: d.max, changes: d.n },
      checks: [check('medianMs', value, b.max, 'max', b.unit)],
    })
    expect(e.pass, `P-UI-6: ${JSON.stringify(runs)}`).toBe(true)
  })
})
