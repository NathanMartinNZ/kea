import { afterEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '@kea/kit'
import { L, type MainToChild } from '@kea/protocol'
import { CoreAvailability, RpcPortHandout, shutdownChildren, type ShutdownTarget } from './lifecycle.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** A supervised child as main holds it: what it was sent, and when its supervision was stopped. */
function child(name: string, log: string[], o: { exitsOnShutdown: boolean }) {
  const exits = new Emitter<void>()
  let running = true
  const exit = () => {
    if (!running) return
    running = false
    log.push(`${name} exited`)
    exits.fire()
  }
  const t: ShutdownTarget = {
    current: {
      post: (m: MainToChild) => {
        log.push(`${name} ← ${m.k}`)
        if (m.k === 'shutdown' && o.exitsOnShutdown) queueMicrotask(exit)
      },
      onExit: (cb) => exits.event(cb),
    },
    sup: {
      stop: async () => {
        log.push(`${name} stopped`)
        exit() // the Supervisor kills a child that is still there
      },
    },
  }
  return t
}

describe('full quit', () => {
  it('U-FAIL-5 · each child is asked to shut down; one that exits is stopped at once, one that does not is stopped after L.supervisorShutdownGraceMs', async () => {
    vi.useFakeTimers()
    const log: string[] = []
    const ptyhost = child('ptyhost', log, { exitsOnShutdown: false })
    const core = child('core', log, { exitsOnShutdown: true })
    let done = false
    const p = shutdownChildren([ptyhost, core]).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toEqual(['ptyhost ← shutdown', 'core ← shutdown', 'core exited', 'core stopped'])
    await vi.advanceTimersByTimeAsync(L.supervisorShutdownGraceMs - 1)
    expect(log, 'ptyhost gets its whole grace period').not.toContain('ptyhost stopped')
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(log.slice(4)).toEqual(['ptyhost stopped', 'ptyhost exited'])
    expect(done).toBe(true)
    expect(vi.getTimerCount(), 'no timer left behind').toBe(0)
  })

  it('U-FAIL-5 · a child that is not running (restarting) is only stopped, so its pending restart never happens; nothing waits', async () => {
    vi.useFakeTimers()
    const log: string[] = []
    const core: ShutdownTarget = { current: null, sup: { stop: async () => void log.push('core stopped') } }
    const ptyhost = child('ptyhost', log, { exitsOnShutdown: true })
    await shutdownChildren([ptyhost, core])
    expect(log).toEqual(['ptyhost ← shutdown', 'core stopped', 'ptyhost exited', 'ptyhost stopped'])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('core availability for the Reconnecting bar', () => {
  it('U-FAIL-4 · main tells every window when a ready core exits, once per outage, and a window that says hello meanwhile; not a core that never started, not while quitting', () => {
    const told: (number | 'all')[] = []
    const a = new CoreAvailability((id) => told.push(id ?? 'all'))
    a.exited(false)
    a.hello(1)
    expect(told, 'core never started: nothing is away').toEqual([])
    a.ready()
    a.exited(true)
    a.exited(false) // a respawn that dies before it is ready (crash loop, or another instance's lock)
    a.exited(true)
    expect(told).toEqual(['all'])
    a.hello(7) // a window reloaded while core is away
    expect(told).toEqual(['all', 7])
    a.ready()
    expect(a.isAway).toBe(false)
    a.hello(7)
    expect(told).toEqual(['all', 7])
    a.quit()
    a.exited(true)
    a.hello(7)
    expect(told, 'quitting: core goes on purpose').toEqual(['all', 7])
  })
})

describe('RPC ports to core', () => {
  it('U-FAIL-9 · one RPC port per renderer load and core instance: hello before or after core is ready gets one; a reload or crash gets a new one at its hello; a core restart gives one to every renderer that said hello; a closed window none', () => {
    const ports: number[] = []
    let coreReady = false
    const h = new RpcPortHandout()
    const hello = (id: number) => {
      if (h.hello(id, coreReady)) ports.push(id)
    }
    const ready = () => {
      coreReady = true
      ports.push(...h.coreReady())
    }
    // first launch, the window open before core is ready, its renderer slower still: one port, at hello (a second one
    // from core's ready would close the first, and the renderer's first call with it)
    h.gone(1) // the page's first navigation
    ready()
    hello(1)
    expect(ports).toEqual([1])
    // a renderer that says hello while core is still starting gets its port when core is ready
    coreReady = false
    h.gone(1)
    hello(1)
    expect(ports).toEqual([1])
    ready()
    expect(ports).toEqual([1, 1])
    // a reload (or a renderer crash): the old renderer is gone; the new one asks again
    h.gone(1)
    hello(1)
    expect(ports).toEqual([1, 1, 1])
    // a second window; then core restarts: one new port each
    hello(2)
    coreReady = false
    ready()
    expect(ports).toEqual([1, 1, 1, 2, 1, 2])
    // a closed window gets none; the handout is empty once every window has gone
    h.gone(2)
    coreReady = false
    ready()
    expect(ports.slice(6)).toEqual([1])
    h.gone(1)
    expect(h.size).toBe(0)
  })
})
