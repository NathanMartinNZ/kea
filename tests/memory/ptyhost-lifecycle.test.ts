// PTY lifecycles leave nothing behind in ptyhost: every per-PTY object (mirror, holder socket, scope, timers,
// checkpoint entry) belongs to the PTY's scope and goes with it.

import { afterEach, describe, expect, it } from 'vitest'
import { DisposableTracker, resources, setDisposableTracker } from '@kea/kit'
import { ptyhostHarness, until, type Harness } from '../support/holders.ts'
import { settle } from './ptyhost-leak.ts'

let h: Harness | null = null
afterEach(async () => {
  setDisposableTracker(null)
  await h?.dispose()
  h = null
})

const PTYS = 100
const BATCH = 10

describe('PTY lifecycle', () => {
  it(`L-PTY-2 · ${PTYS} PTYs spawned, exited and released: mirrors, sockets, per-PTY scopes and timers back to 0, disposable tracker empty`, async () => {
    h = await ptyhostHarness()
    const m = h.manager
    await settle()
    // the report main logs and the debug RPC answers
    const before = resources.report()
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    for (let b = 0; b < PTYS / BATCH; b++) {
      const ptys = await Promise.all(Array.from({ length: BATCH }, () => h!.spawn({ argv: ['/usr/bin/true'] }))) // os-ok: in /usr/bin on both systems
      await until('the batch to exit', () => ptys.every((p) => !p.isRunning))
      for (const p of ptys) expect(p.release()).toBe(true)
      await until('the batch to be removed', () => ptys.every((p) => p.isDisposed && m.get(p.ptyId) === undefined))
    }
    await settle()
    const after = resources.report()
    expect({
      ptys: after['ptyhost.ptys'],
      holderSockets: after['ptyhost.holderSockets'],
      nonDetachedHolders: (after['kit.children'] as Record<string, number>)['held.active'],
      creditWindows: after['ptyhost.creditWindows'],
      ptyQueues: after['ptyhost.ptyQueues'],
      ptyTimers: after['ptyhost.ptyTimers'],
      pendingRebuilds: after['ptyhost.pendingRebuilds'],
      checkpoints: after['ptyhost.checkpoints'],
    }).toEqual({
      ptys: { awake: 0, parked: 0 },
      holderSockets: 0,
      nonDetachedHolders: 0,
      creditWindows: { windows: 0, outstandingBytes: 0 },
      ptyQueues: { coalescerBytes: 0, snapshotWaiters: 0, holderWriteBytes: 0 },
      ptyTimers: 0,
      pendingRebuilds: { queued: 0, running: 0 },
      checkpoints: { watched: 0, pending: 0, timer: 0, inMemory: 0, inMemoryChars: 0 },
    })
    const kit = (r: typeof after) => ({
      mirrors: r['ptyhost.mirrors'] ?? 0,
      sockets: r['ptyhost.holderSockets'] ?? 0,
      streams: r['ptyhost.streams'] ?? 0,
      scopes: r['kit.scopes'] ?? 0,
      timers: r['kit.timers'] ?? 0,
      listeners: r['kit.targetListeners'] ?? 0,
    })
    expect(kit(after)).toEqual(kit(before))
    expect(tracker.report()).toBe('')
    expect(h.spawned.size).toBe(PTYS)
  })
})
