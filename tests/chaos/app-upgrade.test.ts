// Kea's files replaced under the running Kea, on the dev build the other chaos suites launch (C-UPD-8): once main
// knows the files changed, a core that dies is not started again from them; Kea asks to restart into the new files
// instead (the test hooks record the restart rather than make it), the windows stay, and the holders keep running.
// The same path with real packages, apt replacing a running Kea's files, is the Docker run of the release checks.

import { afterEach, describe, expect, it } from 'vitest'
import { KeaRun, STEP_MS, until } from '../support/app.ts'
import { holdersUnharmed } from '../support/app-chaos.ts'

type Probe = { state: { phase: { k: string; version?: string | null } }; title: string; relaunches: string[] }
type UpdatesApi = { updates(): Probe; upgraded(version: string | null): void; pids(): Record<'core' | 'ptyhost', number | null> }

const runs: KeaRun[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.dispose()
})

describe('files replaced under a running Kea (app)', () => {
  it('C-UPD-8 · once Kea’s files are replaced, a killed core is not started again: Kea asks once to restart into them, Restart Kea is offered, the window and the holders stay', async () => {
    const run = KeaRun.create()
    runs.push(run)
    const kea = await run.launch()
    const holders = run.holders()
    await kea.app.evaluate(() => (globalThis as unknown as { __keaTest: UpdatesApi }).__keaTest.upgraded('9.9.9'))
    const updates = () => kea.app.evaluate(() => (globalThis as unknown as { __keaTest: UpdatesApi }).__keaTest.updates())
    const probe = await updates()
    expect(probe.state.phase).toEqual({ k: 'upgraded', version: '9.9.9' })
    expect(probe.title).toBe('Restart Kea')

    await kea.signal('core', 'SIGKILL')
    const relaunches = await until('a restart asked for', async () => {
      const p = await updates()
      return p.relaunches.length > 0 ? p.relaunches : undefined
    })
    expect(relaunches, 'once, for the version on disk (none in a dev tree)').toEqual(['unknown'])
    const pids = await kea.app.evaluate(() => (globalThis as unknown as { __keaTest: UpdatesApi }).__keaTest.pids())
    expect(pids.core, 'no core started from the replaced files').toBeNull()
    expect(pids.ptyhost, 'ptyhost untouched').not.toBeNull()
    expect(await kea.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    holdersUnharmed(run, holders)
  })
})
