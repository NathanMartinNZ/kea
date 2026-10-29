// Holders where `/proc` is mounted `hidepid`: a holder is non-dumpable, so its own user cannot see its `/proc/<pid>`
// and `kea-helper procs` does not list it. Core must not take such a holder for gone: its pid still exists
// (`kill(pid, 0)`), so its liveness is unknown and ptyhost's connect over its socket decides.
//
// It runs only where `/proc` hides holders: `sudo node tools/test-hidepid.ts` prepares that. As root,
// `unshare --pid --fork --mount --mount-proc`, `mount -o remount,hidepid=invisible /proc`, then
// `setpriv --reuid <user> --regid <group> --init-groups` back to the user before the tests start (Ubuntu 24.04 lets
// no unprivileged process make the user namespace that would let the test do it itself).

import { holdersHidden, runProcess } from '@kea/kit'
import type { PtyInfo } from '@kea/protocol'
import { procsProbe } from '@kea/core/src/terminal/procs.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { linux } from '../../app/main/src/os/linux.ts'
import { holderState, ptyhostHarness, testEnv, type Harness } from '../support/holders.ts'
import { ownPtyIds, startCore, type CoreUnderTest } from './core-support.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function harness(): Promise<Harness> {
  const h = await ptyhostHarness()
  cleanup.push(async () => {
    for (const id of ownPtyIds(h.home)) h.spawned.add(id)
    await h.dispose()
  })
  return h
}

function core(h: Harness): CoreUnderTest {
  const c = startCore(h, { env: testEnv({ SHELL: '/bin/sh' }) })
  cleanup.push(() => c.dispose())
  return c
}

const cat = (sessionId: string, kind: PtyInfo['kind'], cwd: string) => ({ sessionId, kind, command: { argv: ['/bin/cat'] }, cwd, cols: 80, rows: 24 })

describe('holders hidden by /proc', () => {
  // A holder core started is missing from `kea-helper procs` yet runs; across a restart of ptyhost and of Kea it is
  // adopted and attached, never reported lost; the platform report's visibility line names hidepid with its fix.
  it.runIf(holdersHidden() !== null)('I-PLT-5 · holders missing from kea-helper procs are adopted, not taken as gone, after a restart of ptyhost and of Kea; the platform report names it', async () => {
    const h = await harness()
    let c = core(h)
    await c.reconciled()
    const agent = (await c.t.launch(cat('S1', 'agent', h.home))).ptyId
    const pid = holderState(h.home, agent)!.pid!
    const listed = await runProcess(h.helper, ['procs', String(pid)], { pool: 'other' })
    expect([listed.code, listed.stdout?.toString('utf8')], 'procs does not list it').toEqual([0, ''])
    expect(() => process.kill(pid, 0), 'yet it runs').not.toThrow()
    expect((await procsProbe(h.helper)([pid])).get(pid)?.hidden, 'core cannot tell').toBe(true)

    // Kea goes away; ptyhost restarts and adopts; core starts again and reconciles
    c.dispose()
    h.stop()
    await h.restart()
    c = core(h)
    const plan = await c.reconciled()
    expect(plan.attached).toEqual([agent])
    expect(plan.ended, 'nothing lost').toEqual([])
    expect(c.t.store.get(agent)).toMatchObject({ state: 'running', kind: 'agent', holderPid: pid })

    const report = linux.report
    if (!('platform' in report)) throw new Error('the Linux platform report is missing')
    const line = report.platform({ version: '6.8.0', arch: process.arch, resourcesDir: h.home, execPath: process.execPath, webgl2: 'enabled', trayHost: null, notificationService: null, rendererPid: null, corePid: null, idle: 'system', watchLimitHeld: null, display: 'x11', desktopId: 'dev.kea.app.dev', displayScale: null }).lines.find((l) => l.id === 'holderVisibility')
    expect(line?.value).toMatch(/^hidden by \/proc's hidepid=/)
    expect(line?.fix).toMatch(/^Mount \/proc without hidepid/)
  })
})
