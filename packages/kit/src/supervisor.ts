// The Supervisor: `main` runs core and ptyhost under it. A child that exits is restarted with backoff from
// L.supervisorBackoffMinMs doubling to L.supervisorBackoffMaxMs, reset to the minimum once a child has stayed up
// L.supervisorHealthyResetMs; a heartbeat ping goes every L.supervisorHeartbeatMs, and after
// L.supervisorMissedHeartbeats missed pongs the child is killed and restarted. Never two instances: a new child is
// spawned only after the previous one has exited. Before any respawn (never the first start) it asks
// `beforeRespawn`; a refusal leaves it without a child and without a retry until stopped (`onRespawnRefused`), so
// main can restart the whole of Kea instead of starting a child from files another build replaced.
//
// The child is injected (`spawn: () => SupervisedChild`) so the policy is testable with fake
// children and fake timers; the Electron `utilityProcess` adapter lives in app/main.

import { L } from '@kea/protocol/limits'
import { systemClock } from './clock.ts'
import type { Clock, TimerHandle } from './clock.ts'
import { DisposableStore } from './disposable.ts'
import type { Disposable } from './disposable.ts'
import { Emitter } from './emitter.ts'
import type { Event } from './emitter.ts'
import type { Logger } from './logger.ts'

export interface SupervisedChild {
  readonly pid?: number
  /** Make the child exit (SIGKILL). `onExit` must follow. */
  kill(): void
  /** Send a heartbeat request; the child answers through `onPong`. */
  ping(): void
  onPong(cb: () => void): Disposable
  onExit(cb: (code: number | null) => void): Disposable
}

export type SupervisorState = 'idle' | 'running' | 'killing' | 'backoff' | 'refused' | 'stopping' | 'stopped'

/** Why a child went away: it exited on its own, missed heartbeats, was restarted or stopped on request, or failed to spawn. */
export type ExitReason = 'exited' | 'heartbeat' | 'restart' | 'stopped' | 'spawn-failed'

export interface SupervisorStartEvent {
  pid: number | undefined
  /** 1 for the first child, then +1 per spawn. */
  generation: number
}

export interface SupervisorExitEvent {
  code: number | null
  reason: ExitReason
  uptimeMs: number
  generation: number
}

export interface SupervisorRestartEvent {
  /** Backoff before the next spawn. */
  delayMs: number
  reason: ExitReason
}

/** A respawn `beforeRespawn` refused: the generation that would have started. */
export interface SupervisorRefusedEvent {
  generation: number
}

export interface SupervisorOptions {
  name: string
  spawn: () => SupervisedChild
  /**
   * Asked before every respawn (a child after the first, by backoff or `restart()`); false refuses it. The answer is
   * the caller's: main refuses once the app's files changed under it.
   */
  beforeRespawn?: () => boolean
  clock?: Pick<Clock, 'setTimeout' | 'clearTimeout' | 'now'>
  /** Heartbeat pings (default true). */
  heartbeat?: boolean
  logger?: Logger
}

interface Running {
  readonly child: SupervisedChild
  readonly generation: number
  readonly startedAt: number
  readonly subs: DisposableStore
  killReason: ExitReason | undefined
  // bounded: callers awaiting this one child's exit (stop / restart), resolved together
  readonly waiters: Array<() => void>
}

export class Supervisor implements Disposable {
  readonly name: string
  private readonly opts: SupervisorOptions
  private readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout' | 'now'>
  private readonly startEmitter = new Emitter<SupervisorStartEvent>({ name: 'Supervisor.onStart' })
  private readonly exitEmitter = new Emitter<SupervisorExitEvent>({ name: 'Supervisor.onExit' })
  private readonly restartEmitter = new Emitter<SupervisorRestartEvent>({ name: 'Supervisor.onRestart' })
  private readonly refusedEmitter = new Emitter<SupervisorRefusedEvent>({ name: 'Supervisor.onRespawnRefused' })

  readonly onStart: Event<SupervisorStartEvent> = this.startEmitter.event
  readonly onExit: Event<SupervisorExitEvent> = this.exitEmitter.event
  readonly onRestart: Event<SupervisorRestartEvent> = this.restartEmitter.event
  /** A respawn was refused (`beforeRespawn`): no child runs and none will until the Supervisor is stopped. */
  readonly onRespawnRefused: Event<SupervisorRefusedEvent> = this.refusedEmitter.event

  private current: Running | undefined
  private generation = 0
  private supervising = false
  private restartRequested = false
  private phase: SupervisorState = 'idle'
  private backoff: number = L.supervisorBackoffMinMs
  private missed = 0
  private restartCount = 0
  private heartbeatTimer: TimerHandle | undefined
  private healthyTimer: TimerHandle | undefined
  private restartTimer: TimerHandle | undefined

  constructor(opts: SupervisorOptions) {
    this.name = opts.name
    this.opts = opts
    this.clock = opts.clock ?? systemClock
  }

  get state(): SupervisorState {
    return this.phase
  }

  /** The live child, if any. */
  get child(): SupervisedChild | undefined {
    return this.current?.child
  }

  /** The delay the next unexpected exit would wait before respawning. */
  get nextBackoffMs(): number {
    return this.backoff
  }

  /** Respawns so far (not counting the first start). */
  get restarts(): number {
    return this.restartCount
  }

  /** Begin supervising: spawn the child now. No-op if already supervising. */
  start(): void {
    if (this.supervising) return
    if (this.phase === 'stopping' || this.phase === 'stopped') throw new Error(`Supervisor ${this.name}: start() after stop()`)
    this.supervising = true
    this.launch()
  }

  /**
   * Kill the running child and spawn a new one as soon as it has exited, skipping the backoff (the memory watchdog's
   * "restart core"). During a backoff wait, spawns at once.
   */
  async restart(): Promise<void> {
    if (!this.supervising) return
    const cur = this.current
    if (cur) {
      this.restartRequested = true
      const exited = this.waitForExit(cur)
      this.kill(cur, 'restart')
      await exited
      return
    }
    if (this.restartTimer !== undefined) {
      this.clearTimer('restartTimer')
      this.launch()
    }
  }

  /** Stop supervising and kill the child; resolves once it has exited. */
  async stop(): Promise<void> {
    this.supervising = false
    this.restartRequested = false
    this.clearTimer('restartTimer')
    const cur = this.current
    if (cur) {
      this.phase = 'stopping'
      const exited = this.waitForExit(cur)
      this.kill(cur, 'stopped')
      await exited
    }
    this.phase = 'stopped'
  }

  dispose(): void {
    void this.stop().finally(() => {
      this.startEmitter.dispose()
      this.exitEmitter.dispose()
      this.restartEmitter.dispose()
      this.refusedEmitter.dispose()
    })
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private launch(): void {
    if (this.current) throw new Error(`Supervisor ${this.name}: refusing to spawn a second instance`)
    if (this.generation > 0 && this.supervising && this.opts.beforeRespawn && !this.opts.beforeRespawn()) {
      this.phase = 'refused'
      this.opts.logger?.warn('supervisor: respawn refused', { name: this.name, generation: this.generation + 1 })
      this.refusedEmitter.fire({ generation: this.generation + 1 })
      return
    }
    const generation = ++this.generation
    if (generation > 1) this.restartCount++
    let child: SupervisedChild
    try {
      child = this.opts.spawn()
    } catch (err) {
      this.opts.logger?.error('supervisor: spawn failed', { name: this.name, err })
      this.exitEmitter.fire({ code: null, reason: 'spawn-failed', uptimeMs: 0, generation })
      if (this.supervising) this.scheduleRestart('spawn-failed')
      else this.phase = 'stopped'
      return
    }
    const cur: Running = {
      child,
      generation,
      startedAt: this.clock.now(),
      subs: new DisposableStore(),
      killReason: undefined,
      waiters: [],
    }
    this.current = cur
    this.phase = 'running'
    this.missed = 0
    cur.subs.add(child.onExit((code) => this.handleExit(cur, code)))
    cur.subs.add(
      child.onPong(() => {
        if (this.current === cur) this.missed = 0
      }),
    )
    if (this.opts.heartbeat !== false) this.scheduleHeartbeat(cur)
    this.healthyTimer = this.clock.setTimeout(() => {
      this.healthyTimer = undefined
      if (this.current === cur) this.backoff = L.supervisorBackoffMinMs
    }, L.supervisorHealthyResetMs)
    this.opts.logger?.info('supervisor: started', { name: this.name, pid: child.pid, generation })
    this.startEmitter.fire({ pid: child.pid, generation })
  }

  private scheduleHeartbeat(cur: Running): void {
    this.heartbeatTimer = this.clock.setTimeout(() => {
      this.heartbeatTimer = undefined
      if (this.current !== cur || cur.killReason) return
      if (this.missed >= L.supervisorMissedHeartbeats) {
        this.opts.logger?.warn('supervisor: missed heartbeats, killing', { name: this.name, missed: this.missed })
        this.kill(cur, 'heartbeat')
        return
      }
      this.missed++
      try {
        cur.child.ping()
      } catch (err) {
        // A ping that cannot be sent counts as missed.
        this.opts.logger?.warn('supervisor: ping failed', { name: this.name, err })
      }
      this.scheduleHeartbeat(cur)
    }, L.supervisorHeartbeatMs)
  }

  private kill(cur: Running, reason: ExitReason): void {
    if (this.current !== cur || cur.killReason) return
    cur.killReason = reason
    if (this.phase === 'running') this.phase = 'killing'
    this.clearTimer('heartbeatTimer')
    this.clearTimer('healthyTimer')
    try {
      cur.child.kill()
    } catch (err) {
      this.opts.logger?.error('supervisor: kill failed', { name: this.name, err })
    }
  }

  private handleExit(cur: Running, code: number | null): void {
    if (this.current !== cur) return // a stale or repeated exit
    this.current = undefined
    cur.subs.dispose()
    this.clearTimer('heartbeatTimer')
    this.clearTimer('healthyTimer')
    const reason = cur.killReason ?? 'exited'
    const uptimeMs = this.clock.now() - cur.startedAt
    this.opts.logger?.info('supervisor: exited', { name: this.name, code, reason, uptimeMs })
    const immediate = this.restartRequested
    this.restartRequested = false
    this.phase = this.supervising ? 'backoff' : 'stopped'
    for (const w of cur.waiters.splice(0)) w()
    this.exitEmitter.fire({ code, reason, uptimeMs, generation: cur.generation })
    if (!this.supervising || this.current) return
    if (immediate) this.launch()
    else this.scheduleRestart(reason)
  }

  private scheduleRestart(reason: ExitReason): void {
    const delayMs = this.backoff
    this.backoff = Math.min(this.backoff * 2, L.supervisorBackoffMaxMs)
    this.phase = 'backoff'
    this.restartTimer = this.clock.setTimeout(() => {
      this.restartTimer = undefined
      if (this.supervising && !this.current) this.launch()
    }, delayMs)
    this.restartEmitter.fire({ delayMs, reason })
  }

  private waitForExit(cur: Running): Promise<void> {
    return new Promise<void>((resolve) => cur.waiters.push(resolve))
  }

  private clearTimer(which: 'heartbeatTimer' | 'healthyTimer' | 'restartTimer'): void {
    const h = this[which]
    if (h !== undefined) {
      this.clock.clearTimeout(h)
      this[which] = undefined
    }
  }
}
