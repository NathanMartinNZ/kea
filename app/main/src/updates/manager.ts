// Main's update state: how this Kea is updated, what the last check found, when the next automatic check is due, and
// what the window is told (`UpdateState`). Pure: the clock, the check itself, the macOS updater and the file main keeps
// its marks in are handed in, so tests drive it with fakes.
//
// · A check the person asks for runs whenever Kea came from a release. An automatic one runs only where nothing else
//   updates Kea (`how.auto`), only after core has said in this run that `updates.check` is on, and only once the
//   one-time line saying Kea checks for updates has been shown. Due by the wall clock: first L.updateCheckDelayMs after
//   the window first loads, then L.updateCheckIntervalMs after the last attempt, tested every L.updateTickMs and on
//   resume (timers stop while the system sleeps). A failed automatic check is tried again at the next resume.
// · Where Kea updates itself (macOS), a newer version is downloaded at once; Squirrel's "ready" offers Restart to
//   Update. A version that is still not running after L.updateInstallAttemptsMax starts is never downloaded again.
// · A Linux package replaced under the running Kea (`upgraded`) ends checking: Restart Kea is all there is to do.

import { compareVersions, L, type UpdateMarks, type UpdatePhase, type UpdateState } from '@kea/protocol'
import type { UpdaterDriver, UpdaterEvents } from './driver.ts'
import type { UpdateHow } from './how.ts'

/** The newest skipped versions kept (`UpdateMarks.skip`): an older one is never offered again anyway. */
const SKIP_KEPT = 4

export interface UpdateClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(t: unknown): void
}

export interface ManagerDeps {
  /** The running Kea's version. */
  version: string
  how: UpdateHow
  /** Automatic checks may run in this run at all (the default home, or the test hooks). */
  autoAllowed: boolean
  /** The first automatic check's delay after the window's first load; L.updateCheckDelayMs unless the test hooks say. */
  firstDelayMs?: number
  clock: UpdateClock
  marks: { load(): UpdateMarks; save(m: UpdateMarks): void }
  /** The check where Kea's own updater does not run: the version the release offers this install, or null for none. */
  feed(): Promise<string | null>
  /** The macOS updater, made on first use with these events; null where it does not run. */
  makeDriver: ((on: UpdaterEvents) => UpdaterDriver) | null
  /** The state changed: tell the windows, retitle the menu. */
  changed(state: UpdateState): void
  /** Keep the window's drafts for the next start; resolves when they are kept, or cannot be. */
  beforeRestart(): Promise<void>
  /** Restart Kea into the files a package manager put under it (Linux). */
  relaunch(): void
  log: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void }
}

export class UpdateManager {
  private readonly d: ManagerDeps
  private how: UpdateHow
  private phase: UpdatePhase = { k: 'idle' }
  private lastChecked: number | null = null
  private marks: UpdateMarks // bounded: its skip list keeps the newest SKIP_KEPT versions (`skipList`)
  private driver: UpdaterDriver | null = null
  /** core's `updates.check`, once it has said it in this run. */
  private coreCheck: boolean | null = null
  /** When the window first loaded (the first check's delay counts from it). */
  private loadedAt: number | null = null
  private lastAttempt: number | null = null
  private lastAutoFailed = false
  private inFlight = false
  private restarting = false
  private delayTimer: unknown = null
  private tickTimer: unknown = null
  private disposed = false

  constructor(d: ManagerDeps) {
    this.d = d
    this.how = d.how
    this.marks = d.marks.load()
  }

  private get firstDelay(): number {
    return this.d.firstDelayMs ?? L.updateCheckDelayMs
  }

  /** How this install is updated now: the macOS updater gives way to install.sh when it cannot install. */
  get howNow(): UpdateHow {
    return this.how
  }

  /** core's `updates.check` as it last said it in this run; null before it has. */
  get coreSwitch(): boolean | null {
    return this.coreCheck
  }

  /** What the resource report counts: the timers held, the updater made, a check in flight. */
  counts(): { timers: number; driver: number; inFlight: number } {
    return { timers: (this.delayTimer !== null ? 1 : 0) + (this.tickTimer !== null ? 1 : 0), driver: this.driver ? 1 : 0, inFlight: this.inFlight ? 1 : 0 }
  }

  get state(): UpdateState {
    return { mode: this.how.mode, auto: this.how.auto, command: this.how.command, why: this.how.why, phase: this.phase, lastChecked: this.lastChecked, notice: this.noticeDue() }
  }

  /** The update command's title now. */
  get title(): 'Check for Updates…' | 'Restart to Update' | 'Restart Kea' {
    return this.phase.k === 'ready' ? 'Restart to Update' : this.phase.k === 'upgraded' ? 'Restart Kea' : 'Check for Updates…'
  }

  /** At start, where Kea updates itself: was the version Squirrel had ready installed? */
  checkInstalled(): void {
    const e = this.marks.expected
    if (!e) return
    if (compareVersions(this.d.version, e.version) >= 0) {
      this.saveMarks({ ...this.marks, expected: null })
      return
    }
    const attempts = e.attempts + 1
    if (attempts < L.updateInstallAttemptsMax) {
      this.saveMarks({ ...this.marks, expected: { version: e.version, attempts } })
      return
    }
    this.d.log.warn('update did not install', { version: e.version, attempts })
    this.saveMarks({ ...this.marks, expected: null, skip: skipList([...this.marks.skip, e.version]) })
    this.set({ k: 'didNotInstall', version: e.version })
  }

  /** core's `updates.check`, at its start and on each change. */
  coreSetting(check: boolean): void {
    this.coreCheck = check
    this.reschedule()
  }

  /** The window's first load. */
  windowLoaded(): void {
    if (this.loadedAt !== null) return
    this.loadedAt = this.d.clock.now()
    this.reschedule()
  }

  /** The window showed the line saying Kea checks for updates, or the person opened About's Updates block. */
  noticeShown(): void {
    if (this.marks.noticeShown) return
    this.saveMarks({ ...this.marks, noticeShown: true })
    this.emit()
    this.reschedule()
  }

  /** The system woke: a check that failed, or one that came due while asleep, runs now. */
  resume(): void {
    if (!this.autoNow()) return
    if (this.lastAutoFailed || this.due()) void this.run('auto')
  }

  /** The person asked (the menu, the palette, About). */
  checkNow(): void {
    void this.run('manual')
  }

  /** Restart to Update (macOS, `ready`) or Restart Kea (Linux, `upgraded`), the window's drafts kept; nothing otherwise. */
  restart(): void {
    const k = this.phase.k
    if ((k !== 'ready' && k !== 'upgraded') || this.restarting) return
    this.restarting = true
    void this.d
      .beforeRestart()
      .catch(() => undefined)
      .then(() => {
        if (this.disposed) return
        if (k === 'ready') this.driver?.install()
        else this.d.relaunch()
      })
      .finally(() => (this.restarting = false))
  }

  /** The package was replaced under the running Kea (`version`: the new tree's, when it says). */
  upgraded(version: string | null): void {
    if (this.phase.k === 'upgraded') return
    this.clearTimers()
    this.set({ k: 'upgraded', version })
  }

  /** Kea's files were removed under it. */
  removed(): void {
    this.clearTimers()
    this.set({ k: 'removed' })
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
    this.driver?.dispose()
    this.driver = null
  }

  // ── scheduling ──────────────────────────────────────────────────────────────────────────────────

  private noticeDue(): boolean {
    return this.how.auto && this.d.autoAllowed && !this.marks.noticeShown
  }

  /** Every gate for an automatic check holds now. */
  private autoNow(): boolean {
    return !this.disposed && this.how.auto && this.d.autoAllowed && this.coreCheck === true && this.marks.noticeShown && this.loadedAt !== null && !this.ended()
  }

  private ended(): boolean {
    return this.phase.k === 'upgraded' || this.phase.k === 'removed' || this.phase.k === 'ready'
  }

  private due(): boolean {
    const now = this.d.clock.now()
    if (this.lastAttempt === null) return this.loadedAt !== null && now - this.loadedAt >= this.firstDelay
    return now - this.lastAttempt >= L.updateCheckIntervalMs
  }

  private reschedule(): void {
    if (!this.autoNow()) {
      this.clearTimers()
      return
    }
    if (this.lastAttempt === null && this.delayTimer === null) {
      const left = Math.max(0, this.firstDelay - (this.d.clock.now() - (this.loadedAt as number)))
      this.delayTimer = this.d.clock.setTimeout(() => {
        this.delayTimer = null
        if (this.autoNow() && this.due()) void this.run('auto')
      }, left)
    }
    if (this.tickTimer === null) {
      this.tickTimer = this.d.clock.setInterval(() => {
        if (this.autoNow() && this.due()) void this.run('auto')
      }, L.updateTickMs)
    }
  }

  private clearTimers(): void {
    if (this.delayTimer !== null) this.d.clock.clearTimeout(this.delayTimer)
    if (this.tickTimer !== null) this.d.clock.clearInterval(this.tickTimer)
    this.delayTimer = null
    this.tickTimer = null
  }

  // ── checking ────────────────────────────────────────────────────────────────────────────────────

  private async run(why: 'auto' | 'manual'): Promise<void> {
    if (this.disposed || this.inFlight || this.how.mode === 'none' || this.ended() || this.phase.k === 'downloading') return
    this.inFlight = true
    this.lastAttempt = this.d.clock.now()
    this.set({ k: 'checking' })
    if (this.how.mode === 'updater' && this.d.makeDriver) {
      let driver: UpdaterDriver | null = null
      try {
        driver = this.ensureDriver()
      } catch (e) {
        // the updater's bundle did not load: install.sh it is, and About says why
        this.d.log.warn('updater not made', { error: oneLine(e) })
        this.how = { ...this.how, mode: 'command', why: `Kea's updater could not start: ${oneLine(e)}` }
      }
      if (driver) {
        // answers through the driver's events; `inFlight` ends there
        driver.check()
        return
      }
    }
    try {
      const offered = await this.d.feed()
      this.finish(why, offered !== null && compareVersions(offered, this.d.version) > 0 ? { k: 'available', version: offered } : { k: 'current', version: this.d.version })
    } catch (e) {
      this.finish(why, { k: 'failed', reason: oneLine(e) })
    }
  }

  private finish(why: 'auto' | 'manual' | 'driver', phase: UpdatePhase): void {
    this.inFlight = false
    this.lastChecked = this.d.clock.now()
    if (why === 'auto') this.lastAutoFailed = phase.k === 'failed'
    else if (phase.k !== 'failed') this.lastAutoFailed = false
    if (this.ended()) return
    this.set(phase)
  }

  private ensureDriver(): UpdaterDriver {
    if (this.driver) return this.driver
    const make = this.d.makeDriver as (on: UpdaterEvents) => UpdaterDriver
    this.driver = make({
      checking: () => this.set({ k: 'checking' }),
      current: () => this.finish('driver', { k: 'current', version: this.d.version }),
      available: (version) => {
        if (this.marks.skip.includes(version)) return this.finish('driver', { k: 'didNotInstall', version })
        this.finish('driver', { k: 'downloading', version, percent: 0 })
        this.driver?.download()
      },
      progress: (version, percent) => this.set({ k: 'downloading', version, percent }),
      ready: (version) => {
        const kept = this.marks.expected?.version === version ? this.marks.expected.attempts : 0
        this.saveMarks({ ...this.marks, expected: { version, attempts: kept } })
        this.set({ k: 'ready', version })
      },
      failed: (reason, step) => {
        const version = this.phase.k === 'downloading' ? this.phase.version : null
        if (step === 'squirrel' || (step === 'download' && version)) {
          // the updater cannot install it here: the command does, and About says why
          this.how = { ...this.how, mode: 'command', why: `macOS could not install the update: ${reason}` }
          this.finish('driver', version ? { k: 'available', version } : { k: 'failed', reason })
          return
        }
        this.finish('driver', { k: 'failed', reason })
      },
      inactive: () => {
        this.how = { ...this.how, mode: 'none', auto: false }
        this.inFlight = false
        this.set({ k: 'idle' })
      },
    })
    return this.driver
  }

  private set(phase: UpdatePhase): void {
    this.phase = phase
    this.emit()
  }

  private emit(): void {
    if (!this.disposed) this.d.changed(this.state)
  }

  private saveMarks(m: UpdateMarks): void {
    this.marks = m
    try {
      this.d.marks.save(m)
    } catch (e) {
      this.d.log.warn('update marks not saved', { error: oneLine(e) })
    }
  }
}

/** The newest few skipped versions, oldest first, without repeats. */
function skipList(versions: readonly string[]): string[] {
  return [...new Set(versions)].sort(compareVersions).slice(-SKIP_KEPT)
}

/** An error as one short line for About and the log. */
export function oneLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return (text.split('\n')[0] ?? '').slice(0, 200) || 'unknown error'
}
