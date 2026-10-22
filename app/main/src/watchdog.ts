// The memory watchdog: a safety net, not the plan. A trigger is a bug, and dogfooding and every other test must see
// none. No Electron here: main.ts supplies the samples, the idle time and the actions, so the policy is unit-tested in
// Node (U-MEM-9).
//
// At the end of each footprint sample (resources.ts, one per L.watchdogIntervalMs) the policy looks at core, ptyhost,
// each window's renderer and the GPU process:
// · Soft limit. One trigger per episode, never one per sample. An episode ends when a sample finds the process back
//   at or under the limit, or replaced (another pid), or gone.
// · Hard limit. One action per episode (restart core, restart ptyhost, reload the window, reset WebGL in
//   every window), taken at the first sample that finds the process over it while the person has given no input for
//   L.watchdogIdleMs, no action for that process is still under way, and L.watchdogCooldownMs has passed since the last
//   one for it. The cool-down follows the process's role, not its pid: a restarted core is still core. A role is the
//   process's name in the sample, except a window's renderer, whose role is its window: the sample names renderers by
//   their place (`renderer` is whichever window comes first), so when the first window closes the next one takes its
//   name, and by name it would be a new process in an old role (`RoleOf`; main says which window a renderer is). A
//   hard episode whose action has to wait says so once (`deferred`, with why).
// · When the action did not help. A process that an action replaced starts a new episode, so a new core that passes the
//   limit again is restarted again once the cool-down allows, each time a trigger, without end: a restart every
//   L.watchdogCooldownMs while the person is away costs less than a process that grows without bound. A process the
//   action did not replace (the GPU process; a window's renderer, which a reload keeps) and that is still over the
//   limit when the cool-down is over gets no second action: the watchdog says once that it gave up on it (`gaveUp`) and
//   leaves it alone until it is back under the limit or replaced.
// · A failed sample (the helper did not answer) acts on nothing and ends no episode; so does a process the sample
//   could not read.
//
// Every trigger is logged at error level (`watchdog: limit exceeded`: the process, the limit, the action), which is how
// Copy diagnostics shows it (in its "Recent errors" section), and written as one `resources.ndjson` line with trigger
// `watchdog`: every process's resource report, the sample, and the triggers. The reports are collected before
// an action starts, so the line shows the process the action is about to replace.

import { systemClock, type Clock, type Logger } from '@kea/kit'
import { L } from '@kea/protocol'
import type { FootprintSample, WatchdogAction, WatchdogTrigger } from './resources.ts'

/** The processes the watchdog limits. */
export type LimitKind = 'core' | 'ptyhost' | 'renderer' | 'gpu'

/** The limits for each kind of process (constants/limits.toml `watchdog_*`) and its action. */
export const WATCHDOG_LIMITS: Readonly<Record<LimitKind, { soft: number; hard: number; action: WatchdogAction }>> = {
  core: { soft: L.watchdogSoftCoreBytes, hard: L.watchdogHardCoreBytes, action: 'restart' },
  ptyhost: { soft: L.watchdogSoftPtyhostBytes, hard: L.watchdogHardPtyhostBytes, action: 'restart' },
  renderer: { soft: L.watchdogSoftRendererBytes, hard: L.watchdogHardRendererBytes, action: 'reload' },
  gpu: { soft: L.watchdogSoftGpuBytes, hard: L.watchdogHardGpuBytes, action: 'resetWebgl' },
}

/** Which limits apply to a process of a sample, by its name there (resources.ts `nameProcesses`); null: none (main, Electron's own helpers). */
export function limitKind(name: string): LimitKind | null {
  if (name === 'core' || name === 'ptyhost' || name === 'gpu') return name
  if (name === 'renderer' || name.startsWith('renderer:')) return 'renderer'
  return null
}

/**
 * The role of a sampled process: what its episodes, its cool-down and its action under way belong to. Default: its
 * name in the sample. Main gives a window's renderer the window's own id (the header says why).
 */
export type RoleOf = (name: string, pid: number) => string

/** What the policy remembers of one process role. */
interface Role {
  /** The process the episodes belong to (0: none seen). */
  pid: number
  /** A soft episode is open: its trigger was written. */
  soft: boolean
  /** The hard episode: none, one whose action waits, one whose action was taken, one given up on. */
  hard: 'no' | 'waiting' | 'acted' | 'gaveUp'
  /** When the last action for this role was decided (monotonic ms), or null. */
  actedAt: number | null
  /** That action is still under way. */
  busy: boolean
}

/**
 * The policy alone: from one interval's sample, the person's idle time and what it remembers (episodes, cool-downs,
 * actions under way), it answers the triggers of this interval. The caller logs them and runs the actions, and says
 * when each action is over (`settled`).
 */
export class WatchdogPolicy {
  // bounded: one per limited process of the newest sample (core, ptyhost, the GPU process, each window's renderer),
  // plus roles that have left it while their cool-down runs or their action is under way; each of those leaves at the
  // first sample after both are over
  private readonly roles = new Map<string, Role>()

  /** Roles remembered (read by the cycle test, U-MEM-9). */
  get size(): number {
    return this.roles.size
  }

  /**
   * Row `main.watchdog`: actions under way, and roles inside their cool-down. Both are 0 unless the watchdog
   * acted in the last L.watchdogCooldownMs. (Not the roles remembered: that count follows the newest sample, so it
   * would read one more or less around a window's closing depending on when the sampler last ran.)
   */
  counts(now: number): { acting: number; cooling: number } {
    let acting = 0
    let cooling = 0
    for (const r of this.roles.values()) {
      if (r.busy) acting++
      if (this.cooling(r, now)) cooling++
    }
    return { acting, cooling }
  }

  /**
   * One interval. `sample`: null when it failed. `idleMs`: how long the person has given no input. `now`: monotonic ms.
   * `roleOf`: the role of each sampled process (default: its name). At most one trigger per process: a process found
   * over both limits at once gets the hard one. A trigger names the process as the sample does.
   */
  evaluate(sample: FootprintSample | null, idleMs: number, now: number, roleOf: RoleOf = (name) => name): WatchdogTrigger[] {
    if (!sample) return []
    const out: WatchdogTrigger[] = []
    const seen = new Set<string>() // bounded: the limited processes of this sample, gone with the call
    for (const [name, pid] of Object.entries(sample.pids)) {
      const kind = limitKind(name)
      if (!kind) continue
      const role = roleOf(name, pid)
      seen.add(role)
      let r = this.roles.get(role)
      if (!r) this.roles.set(role, (r = { pid, soft: false, hard: 'no', actedAt: null, busy: false }))
      if (r.pid !== pid) {
        // replaced: its episodes are over; the cool-down and an action under way stay with the role
        r.pid = pid
        r.soft = false
        r.hard = 'no'
      }
      const bytes = sample.bytes[name]
      if (bytes === undefined) continue // not read this time: nothing is known, nothing changes
      const lim = WATCHDOG_LIMITS[kind]
      const trigger = (limit: 'soft' | 'hard', action: WatchdogTrigger['action'], why?: WatchdogTrigger['why']): void => {
        out.push({ process: name, pid, bytes, limit, limitBytes: lim[limit], action, ...(why ? { why } : {}) })
      }
      if (bytes <= lim.soft) r.soft = false
      if (bytes <= lim.hard) {
        r.hard = 'no'
        if (bytes > lim.soft && !r.soft) {
          r.soft = true
          trigger('soft', 'none')
        }
        continue
      }
      const cooling = this.cooling(r, now)
      if (r.hard === 'gaveUp') continue
      if (r.hard === 'acted') {
        // the action was taken on this very process, and it is still over the limit: not repeated
        if (!cooling && !r.busy) {
          r.hard = 'gaveUp'
          trigger('hard', 'gaveUp')
        }
        continue
      }
      const why = r.busy ? 'action under way' : cooling ? 'cool-down' : idleMs < L.watchdogIdleMs ? 'not idle' : null
      if (why === null) {
        r.hard = 'acted'
        r.actedAt = now
        r.busy = true
        r.soft = true
        trigger('hard', lim.action)
      } else if (r.hard === 'no') {
        r.hard = 'waiting'
        r.soft = true
        trigger('hard', 'deferred', why)
      }
    }
    // a role the sample no longer names (its window closed, its process between two lives): its episodes are over, and
    // it is forgotten once nothing of it is left to remember
    for (const [role, r] of this.roles) {
      if (seen.has(role)) continue
      r.pid = 0
      r.soft = false
      r.hard = 'no'
      if (!r.busy && !this.cooling(r, now)) this.roles.delete(role)
    }
    return out
  }

  /** The action decided for `role` is over (done or failed): the next one may be decided once its cool-down allows. */
  settled(role: string): void {
    const r = this.roles.get(role)
    if (r) r.busy = false
  }

  private cooling(r: Role, now: number): boolean {
    return r.actedAt !== null && now - r.actedAt < L.watchdogCooldownMs
  }
}

export interface WatchdogOptions {
  log: Logger
  /** Monotonic time for cool-downs (default kit's clock). */
  clock?: Pick<Clock, 'now'>
  /** How long the person has given no input, in ms (main: the system's idle time; a test's stand-in). One that throws counts as not idle. */
  idleMs: () => number
  /**
   * Take one of the watchdog's actions on the process the trigger names; resolves when it is over (the new
   * process ready, the window loaded).
   */
  act: (t: WatchdogTrigger & { action: WatchdogAction }) => Promise<unknown>
  /** Write the interval's `resources.ndjson` line (trigger `watchdog`); resolves once it is written. */
  line: (triggers: readonly WatchdogTrigger[], sample: FootprintSample) => Promise<unknown>
  /** The role of a sampled process (`RoleOf`; main: a window's renderer by its window). One that throws: the name. */
  role?: RoleOf
}

/** What one interval came to: its triggers, and `done` once its line is written and its actions are over. */
export interface WatchdogTick {
  triggers: WatchdogTrigger[]
  done: Promise<void>
}

const isAction = (t: WatchdogTrigger): t is WatchdogTrigger & { action: WatchdogAction } => t.action === 'restart' || t.action === 'reload' || t.action === 'resetWebgl'

/** The policy at work: it logs each trigger, has the line written, then runs the actions (watchdog.ts header). */
export class Watchdog {
  private readonly policy = new WatchdogPolicy()
  private readonly o: WatchdogOptions
  private readonly clock: Pick<Clock, 'now'>

  constructor(o: WatchdogOptions) {
    this.o = o
    this.clock = o.clock ?? systemClock
  }

  /** Row `main.watchdog`: actions under way, and roles inside their cool-down. */
  counts(): { acting: number; cooling: number } {
    return this.policy.counts(this.clock.now())
  }

  /** The end of one sampler interval, with its sample (null when it failed). */
  tick(sample: FootprintSample | null): WatchdogTick {
    if (!sample) return { triggers: [], done: Promise.resolve() }
    let idle = 0
    try {
      idle = this.o.idleMs()
    } catch (err) {
      this.o.log.warn('watchdog: idle time not read', { error: String(err) })
    }
    // the role each process was judged under, by its name in this sample: an action's end is told to that role, which
    // may be asked about differently by then (its window closed meanwhile)
    const roles = new Map<string, string>() // bounded: the limited processes of this sample, gone with this interval's actions
    const roleOf: RoleOf = (name, pid) => {
      let role = name
      try {
        role = this.o.role?.(name, pid) ?? name
      } catch (err) {
        this.o.log.warn('watchdog: role not read', { process: name, error: String(err) })
      }
      roles.set(name, role)
      return role
    }
    const triggers = this.policy.evaluate(sample, idle, this.clock.now(), roleOf)
    if (triggers.length === 0) return { triggers, done: Promise.resolve() }
    for (const t of triggers) this.o.log.error('watchdog: limit exceeded', { ...t })
    // the reports first: an action replaces the very process whose counts the line is written for
    const written = Promise.resolve()
      .then(() => this.o.line(triggers, sample))
      .catch((err: unknown) => this.o.log.warn('watchdog: line not written', { error: String(err) }))
    const acts = triggers.filter(isAction).map((t) =>
      written.then(async () => {
        const started = this.clock.now()
        try {
          await this.o.act(t)
          this.o.log.info('watchdog: action finished', { process: t.process, action: t.action, ms: Math.round(this.clock.now() - started) })
        } catch (err) {
          this.o.log.error('watchdog: action failed', { process: t.process, action: t.action, error: String(err) })
        } finally {
          this.policy.settled(roles.get(t.process) ?? t.process)
        }
      }),
    )
    return { triggers, done: Promise.all([written, ...acts]).then(() => undefined) }
  }
}
