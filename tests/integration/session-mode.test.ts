// Holders with and without a systemd user manager, end to end, on Linux. Where none answers for the terminal's
// environment (no `XDG_RUNTIME_DIR`: an SSH login with no user bus, a container), the launcher starts the holder in a
// session of its own and its state json says `detach: "session"`; ptyhost raises the session-mode banner once, and core
// shows it only the first time for its KEA_HOME, across a restart of Kea (core and ptyhost). Where one answers, the
// holder runs in a scope of its own (`detach: "scope"`, its cgroup the unit `kea-<8 hex>-<ptyId>.scope`) and nothing is
// said.

import fs from 'node:fs'
import path from 'node:path'
import { SESSION_MODE_SHOWN_KEY } from '@kea/core/src/platform/banners.ts'
import { kvGet } from '@kea/core/src/platform/db/db.ts'
import type { Banner, PtyhostNote } from '@kea/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { kitOs } from '../../packages/kit/src/os/index.ts'
import { SESSION_MODE_BANNER } from '../../app/ptyhost/src/backend/backend.ts'
import { holderState, ptyhostHarness, testEnv, until, type Harness } from '../support/holders.ts'
import { ownPtyIds, startFullCore, type FullCoreUnderTest } from './core-support.ts'

const cleanup: (() => unknown)[] = []
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

/** The whole of core; its terminals' environment has no XDG_RUNTIME_DIR (testEnv), so no user manager answers. */
function core(h: Harness): FullCoreUnderTest {
  const c = startFullCore(h, { env: testEnv({ SHELL: '/bin/sh' }) })
  cleanup.push(() => c.dispose())
  return c
}

const cat = (cwd: string, env?: Record<string, string>) => ({ sessionId: 'shells', kind: 'shell' as const, command: { argv: ['/bin/cat'] }, cwd, cols: 80, rows: 24, ...(env ? { env } : {}) })
const detachOf = (home: string, ptyId: string) => (holderState(home, ptyId) as { detach?: string } | null)?.detach
const said = (h: Harness) => h.notes.filter((n: PtyhostNote) => n.m === 'pty.banner' && n.a.kind === 'sessionMode')
const shown = (c: FullCoreUnderTest) => [...c.core.banners.store.values()].filter((b: Banner) => b.kind === 'sessionMode')

/** This user's systemd user manager, where one runs: its runtime folder holds `systemd/private`, a socket. */
function userManager(): string | null {
  const rt = process.env.XDG_RUNTIME_DIR
  try {
    return rt && fs.statSync(path.join(rt, 'systemd/private')).isSocket() ? rt : null
  } catch {
    return null
  }
}

describe('holders with and without a user manager', () => {
  it.runIf(kitOs.system === 'linux')('I-PLT-6 · with no user manager a holder runs in session mode: ptyhost says so once, core shows the banner the first time for its KEA_HOME and never again, across a restart of Kea', async () => {
    const h = await harness()
    let c = core(h)
    await c.reconciled()
    const a = (await c.core.terminals.launch(cat(h.home))).ptyId
    expect(detachOf(h.home, a)).toBe('session')
    await until('the session-mode banner', () => shown(c).length === 1)
    expect(shown(c)[0]).toMatchObject({ source: 'ptyhost', severity: 'warning', message: SESSION_MODE_BANNER })
    expect(kvGet(c.core.db, SESSION_MODE_SHOWN_KEY), 'recorded for this home').toBeDefined()
    // a second terminal: ptyhost has said it already
    const b = (await c.core.terminals.launch(cat(h.home))).ptyId
    expect(detachOf(h.home, b)).toBe('session')
    expect(said(h)).toHaveLength(1)

    // Kea again: the new ptyhost says it once more for its first session-mode launch, and core shows nothing
    c.dispose()
    h.stop()
    await h.restart()
    c = core(h)
    await c.reconciled()
    const d = (await c.core.terminals.launch(cat(h.home))).ptyId
    expect(detachOf(h.home, d)).toBe('session')
    await until('the new ptyhost to say it', () => said(h).length === 2)
    expect(shown(c), 'shown once per KEA_HOME').toEqual([])
  })

  it.runIf(kitOs.system === 'linux' && userManager() !== null)('I-PLT-6 · where a user manager answers, the holder runs in a scope of its own and nothing is said', async () => {
    const h = await harness()
    const c = core(h)
    await c.reconciled()
    const a = (await c.core.terminals.launch(cat(h.home, { XDG_RUNTIME_DIR: userManager()! }))).ptyId
    expect(detachOf(h.home, a)).toBe('scope')
    const pid = holderState(h.home, a)!.pid!
    // os-ok: the holder's cgroup, read as the holder reads its own at its start
    expect(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8')).toMatch(new RegExp(`/kea-[0-9a-f]{8}-${a}\\.scope$`, 'm'))
    expect(said(h)).toEqual([])
    expect(shown(c)).toEqual([])
    expect(kvGet(c.core.db, SESSION_MODE_SHOWN_KEY)).toBeUndefined()
  })
})
