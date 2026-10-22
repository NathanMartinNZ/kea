// Main's side of its children's lifecycle, kept free of Electron so it is unit-tested in Node.
//
// · Core availability. When a core that had been ready exits, every window is told (`kea:coreAway`); a window
//   that says hello while core is still away is told too. A new RPC port (core ready again) means it is back. The
//   renderer shows the thin "Reconnecting…" bar only once core has been away longer than L.reconnectingBarDelayMs.
//   Nothing is announced once Kea is quitting.
// · RPC ports: one per renderer load and core instance (`RpcPortHandout`).
// · Full quit. Main asks each child to shut down (ptyhost writes its last checkpoints) and stops any that has not
//   exited L.supervisorShutdownGraceMs later; stopping supervision also cancels a restart a child's exit has scheduled
//   meanwhile.

import { systemClock, type Clock, type Disposable } from '@kea/kit'
import { L, type MainToChild } from '@kea/protocol'

export class CoreAvailability {
  private away = false
  private quitting = false
  private readonly notify: (windowId?: number) => void

  /** `notify(id)`: tell window `id` that core is away; `notify()`: tell every window. */
  constructor(notify: (windowId?: number) => void) {
    this.notify = notify
  }

  get isAway(): boolean {
    return this.away
  }

  /** A core child exited; `wasReady`: it had said `ready` (a core that never started was never there). */
  exited(wasReady: boolean): void {
    if (!wasReady || this.away || this.quitting) return
    this.away = true
    this.notify()
  }

  /** A core child is ready; main hands every window a new RPC port, which tells it core is back. */
  ready(): void {
    this.away = false
  }

  /** Window `windowId`'s renderer said hello (first load or reload). */
  hello(windowId: number): void {
    if (this.away && !this.quitting) this.notify(windowId)
  }

  /** Kea is quitting: its children go on purpose. */
  quit(): void {
    this.quitting = true
  }
}

/**
 * When main hands a window an RPC port to core: one per renderer load and core instance. A renderer asks with hello
 * (first load or reload); a core that becomes ready (first start or restart) gets a port to every renderer that has
 * asked. A window whose renderer has not said hello yet gets none from core's ready (its hello will ask), because two
 * ports in a row close the first, and with it every call the renderer made on it.
 */
export class RpcPortHandout {
  // bounded: one per open window; gone with its renderer
  private readonly greeted = new Set<number>()

  /** Window `windowId`'s renderer said hello. True: hand it a port now (core is ready). */
  hello(windowId: number, coreReady: boolean): boolean {
    this.greeted.add(windowId)
    return coreReady
  }

  /** A core became ready: the windows to hand a port. */
  coreReady(): number[] {
    return [...this.greeted]
  }

  /** Window `windowId`'s renderer went: reload, crash, or the window closed. */
  gone(windowId: number): void {
    this.greeted.delete(windowId)
  }

  get size(): number {
    return this.greeted.size
  }
}

/** The slice of a supervised child (main.ts's `Child`) the shutdown uses. */
export interface ShutdownTarget {
  current: { post(m: MainToChild): void; onExit(cb: () => void): Disposable } | null
  sup: { stop(): Promise<void> }
}

/** Ask every child to shut down, wait for each up to L.supervisorShutdownGraceMs, then stop its supervision (killing it if it is still there). */
export async function shutdownChildren(children: readonly ShutdownTarget[], clock: Pick<Clock, 'setTimeout' | 'clearTimeout'> = systemClock): Promise<void> {
  await Promise.all(
    children.map(async (c) => {
      const u = c.current
      if (u) {
        await new Promise<void>((resolve) => {
          const timer = clock.setTimeout(done, L.supervisorShutdownGraceMs)
          const sub = u.onExit(done)
          function done(): void {
            clock.clearTimeout(timer)
            sub.dispose()
            resolve()
          }
          u.post({ k: 'shutdown' })
        })
      }
      await c.sup.stop()
    }),
  )
}
