import { L } from '@kea/protocol/limits'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Disposable } from './disposable.ts'
import { Emitter } from './emitter.ts'
import { Supervisor } from './supervisor.ts'
import type { SupervisedChild, SupervisorExitEvent } from './supervisor.ts'

let alive = 0
let maxAlive = 0
let nextPid = 100

/** A fake supervised process. `kill()` only records the request unless `exitOnKill` is set. */
class FakeChild implements SupervisedChild {
  readonly pid = nextPid++
  pings = 0
  kills = 0
  isAlive = true
  autoPong = false
  exitOnKill = true
  private readonly exitEm = new Emitter<number | null>()
  private readonly pongEm = new Emitter<void>()

  constructor() {
    alive++
    maxAlive = Math.max(maxAlive, alive)
  }
  kill(): void {
    this.kills++
    if (this.exitOnKill) this.exit(null)
  }
  ping(): void {
    this.pings++
    if (this.autoPong) this.pongEm.fire()
  }
  pong(): void {
    this.pongEm.fire()
  }
  onPong(cb: () => void): Disposable {
    return this.pongEm.event(cb)
  }
  onExit(cb: (code: number | null) => void): Disposable {
    return this.exitEm.event(cb)
  }
  exit(code: number | null): void {
    if (!this.isAlive) return
    this.isAlive = false
    alive--
    this.exitEm.fire(code)
  }
}

function setup(opts: { heartbeat?: boolean; configure?: (c: FakeChild) => void } = {}) {
  const spawned: FakeChild[] = []
  const sup = new Supervisor({
    name: 'core',
    heartbeat: opts.heartbeat ?? false,
    spawn: () => {
      const c = new FakeChild()
      opts.configure?.(c)
      spawned.push(c)
      return c
    },
  })
  const delays: number[] = []
  const exits: SupervisorExitEvent[] = []
  sup.onRestart((e) => delays.push(e.delayMs))
  sup.onExit((e) => exits.push(e))
  const last = (): FakeChild => spawned.at(-1) as FakeChild
  return { sup, spawned, delays, exits, last }
}

/** The backoff sequence the policy must follow, from the constants. */
function expectedDelays(n: number): number[] {
  const out: number[] = []
  let d: number = L.supervisorBackoffMinMs
  for (let i = 0; i < n; i++) {
    out.push(d)
    d = Math.min(d * 2, L.supervisorBackoffMaxMs)
  }
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  alive = 0
  maxAlive = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Supervisor', () => {
  it('U-FAIL-1 · restart backoff doubles from its minimum to its maximum', () => {
    const { sup, spawned, delays, last } = setup()
    sup.start()
    expect(spawned).toHaveLength(1)
    let steps = 0
    for (let d: number = L.supervisorBackoffMinMs; d < L.supervisorBackoffMaxMs; d *= 2) steps++
    const expected = expectedDelays(steps + 3) // reach the max, then stay there
    expected.forEach((delay, i) => {
      last().exit(1)
      expect(delays[i]).toBe(delay)
      expect(sup.state).toBe('backoff')
      vi.advanceTimersByTime(delay - 1)
      expect(spawned).toHaveLength(i + 1)
      vi.advanceTimersByTime(1)
      expect(spawned).toHaveLength(i + 2)
      expect(sup.state).toBe('running')
    })
    expect(delays.at(-1)).toBe(L.supervisorBackoffMaxMs)
    expect(delays.at(-2)).toBe(L.supervisorBackoffMaxMs)
    expect(sup.restarts).toBe(expected.length)
    expect(maxAlive).toBe(1)
  })

  it('U-FAIL-1 · backoff resets to the minimum after a healthy period, not before', () => {
    const { sup, delays, last } = setup()
    sup.start()
    const [d0, d1, d2] = expectedDelays(3) as [number, number, number]
    last().exit(1)
    vi.advanceTimersByTime(d0)
    last().exit(1)
    vi.advanceTimersByTime(d1)
    expect(delays).toEqual([d0, d1])
    // Up for just under the healthy period: the next delay keeps doubling.
    vi.advanceTimersByTime(L.supervisorHealthyResetMs - 1)
    last().exit(1)
    expect(delays.at(-1)).toBe(d2)
    vi.advanceTimersByTime(d2)
    // Up for the full healthy period: back to the minimum.
    vi.advanceTimersByTime(L.supervisorHealthyResetMs)
    expect(sup.nextBackoffMs).toBe(L.supervisorBackoffMinMs)
    last().exit(1)
    expect(delays.at(-1)).toBe(L.supervisorBackoffMinMs)
  })

  it('U-FAIL-1 · kill + restart after the missed-heartbeat count', () => {
    const { sup, spawned, exits, delays } = setup({ heartbeat: true })
    sup.start()
    const child = spawned[0] as FakeChild
    // Each heartbeat sends a ping; a ping counts as missed when the next heartbeat finds no pong.
    vi.advanceTimersByTime(L.supervisorHeartbeatMs * L.supervisorMissedHeartbeats)
    expect(child.pings).toBe(L.supervisorMissedHeartbeats)
    expect(child.kills).toBe(0)
    vi.advanceTimersByTime(L.supervisorHeartbeatMs)
    expect(child.kills).toBe(1)
    expect(exits).toEqual([{ code: null, reason: 'heartbeat', uptimeMs: L.supervisorHeartbeatMs * (L.supervisorMissedHeartbeats + 1), generation: 1 }])
    expect(delays).toEqual([L.supervisorBackoffMinMs])
    vi.advanceTimersByTime(L.supervisorBackoffMinMs)
    expect(spawned).toHaveLength(2)
  })

  it('U-FAIL-1 · a pong resets the missed count; a responsive child is never killed', () => {
    const { sup, spawned } = setup({ heartbeat: true })
    sup.start()
    const child = spawned[0] as FakeChild
    // Answer late but before the limit, repeatedly.
    for (let round = 0; round < 5; round++) {
      vi.advanceTimersByTime(L.supervisorHeartbeatMs * L.supervisorMissedHeartbeats)
      child.pong()
    }
    child.autoPong = true
    vi.advanceTimersByTime(L.supervisorHeartbeatMs * 100)
    expect(child.kills).toBe(0)
    expect(spawned).toHaveLength(1)
  })

  it('U-FAIL-1 · never two instances: a new child spawns only after the previous one has exited', () => {
    const { sup, spawned, exits } = setup({
      heartbeat: true,
      configure: (c) => {
        c.exitOnKill = false
      },
    })
    sup.start()
    const hung = spawned[0] as FakeChild
    vi.advanceTimersByTime(L.supervisorHeartbeatMs * (L.supervisorMissedHeartbeats + 1))
    expect(hung.kills).toBe(1)
    expect(sup.state).toBe('killing')
    // However long the kill takes, nothing new is spawned.
    vi.advanceTimersByTime(L.supervisorBackoffMaxMs * 10)
    expect(spawned).toHaveLength(1)
    expect(hung.kills).toBe(1)
    hung.exit(null)
    expect(exits.at(-1)?.reason).toBe('heartbeat')
    vi.advanceTimersByTime(L.supervisorBackoffMinMs)
    expect(spawned).toHaveLength(2)
    // A stale exit from the old child changes nothing.
    hung.exit(0)
    expect(sup.state).toBe('running')
    expect(maxAlive).toBe(1)
  })

  it('U-FAIL-6 · restart() waits for the exit, then respawns at once without backoff', async () => {
    const { sup, spawned, delays } = setup({
      configure: (c) => {
        c.exitOnKill = false
      },
    })
    sup.start()
    const first = spawned[0] as FakeChild
    const p = sup.restart()
    expect(first.kills).toBe(1)
    expect(spawned).toHaveLength(1)
    first.exit(null)
    await p
    expect(spawned).toHaveLength(2)
    expect(delays).toEqual([])
    expect(maxAlive).toBe(1)
  })

  it('U-FAIL-1 · stop() kills, waits for the exit and never restarts', async () => {
    const { sup, spawned, exits } = setup({
      heartbeat: true,
      configure: (c) => {
        c.exitOnKill = false
      },
    })
    sup.start()
    const child = spawned[0] as FakeChild
    let stopped = false
    const p = sup.stop().then(() => {
      stopped = true
    })
    expect(sup.state).toBe('stopping')
    await Promise.resolve()
    expect(stopped).toBe(false)
    child.exit(null)
    await p
    expect(stopped).toBe(true)
    expect(sup.state).toBe('stopped')
    expect(exits.at(-1)?.reason).toBe('stopped')
    vi.advanceTimersByTime(L.supervisorBackoffMaxMs * 10)
    expect(spawned).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => sup.start()).toThrow()
  })

  it('U-FAIL-1 · a spawn that throws is retried with backoff', () => {
    let attempts = 0
    const sup = new Supervisor({
      name: 'ptyhost',
      heartbeat: false,
      spawn: () => {
        attempts++
        if (attempts < 3) throw new Error('ENOENT')
        return new FakeChild()
      },
    })
    const reasons: string[] = []
    sup.onExit((e) => reasons.push(e.reason))
    sup.start()
    expect(sup.state).toBe('backoff')
    const [d0, d1] = expectedDelays(2) as [number, number]
    vi.advanceTimersByTime(d0)
    vi.advanceTimersByTime(d1)
    expect(attempts).toBe(3)
    expect(sup.state).toBe('running')
    expect(reasons).toEqual(['spawn-failed', 'spawn-failed'])
  })
})
