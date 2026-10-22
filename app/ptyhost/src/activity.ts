// Ptyhost's activity notes: per PTY, what core's tier 3 needs to estimate an agent's status from its terminal, and
// nothing more. Core owns the meaning (adapters/kit `Tier3`); ptyhost only reports.
//
//   activity    output started (the first bytes after a quiet spell) and stopped (no output for L.activityReportMs), at
//               most one note per PTY per L.activityReportMs: a start that comes sooner is reported once the window
//               allows, a stop once the output has been quiet that long. The same derivation as `activityNotes` in
//               adapters/kit (K-FX-6 replays recordings through it).
//   keystroke   typed input from a window or core (core types on the user's behalf), at most one note per
//               L.activityReportMs, carrying the latest keystroke's time; what a terminal reports by itself (focus
//               in/out, mouse reports) is not typing
//
// Cheap: O(1) per output chunk and keystroke, and one timer per PTY, armed only while a note is due. Each note's `at` is
// the wall clock (ms) of what it reports (core puts it on its own clock by its age).

import type { Clock, TimerHandle } from '@kea/kit'
import { L, type PtyhostNote } from '@kea/protocol'

export interface ActivityDeps {
  clock: Clock
  /** Wall-clock ms (a note's `at`). */
  wall?: () => number
  notify(note: PtyhostNote): void
}

const NONE = Number.NEGATIVE_INFINITY

/** Focus reports (`CSI I`, `CSI O`), SGR and urxvt mouse reports, X10 mouse reports (`CSI M` + 3 bytes). */
const REPORTS = /\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M|\x1b\[M[\s\S]{3}/g

/** Input that is only what the terminal reports by itself, not typing. */
export function onlyTerminalReports(data: string | Uint8Array): boolean {
  const text = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1')
  return text.length > 0 && text.replace(REPORTS, '') === ''
}

export class ActivityNotes {
  readonly ptyId: string
  private readonly d: ActivityDeps
  private readonly wall: () => number
  /** What core was last told: output flowing. */
  private told = false
  private lastNote = NONE
  private lastOutput = NONE
  private lastKey = NONE
  private lastKeyNote = NONE
  private keyPending = false
  private timer: TimerHandle | null = null
  private timerAt = 0
  private disposed = false

  constructor(ptyId: string, d: ActivityDeps) {
    this.ptyId = ptyId
    this.d = d
    this.wall = d.wall ?? Date.now
  }

  /** Output arrived from the PTY. */
  output(): void {
    if (this.disposed) return
    const now = this.d.clock.now()
    this.lastOutput = now
    if (!this.told && now - this.lastNote >= L.activityReportMs) this.tell(true, now)
    this.arm()
  }

  /** Input for the PTY (a window's keys and pastes, or core's typing). */
  input(data: string | Uint8Array): void {
    if (this.disposed || onlyTerminalReports(data)) return
    const now = this.d.clock.now()
    this.lastKey = now
    if (now - this.lastKeyNote >= L.activityReportMs) this.tellKey(now)
    else this.keyPending = true
    this.arm()
  }

  /** Whether a note is due later (the timer is armed). */
  get armed(): boolean {
    return this.timer !== null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) this.d.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private tell(active: boolean, now: number): void {
    this.told = active
    this.lastNote = now
    this.d.notify({ m: 'pty.activity', a: { ptyId: this.ptyId, active, at: this.wallAt(now) } })
  }

  private tellKey(at: number): void {
    this.keyPending = false
    this.lastKeyNote = this.d.clock.now()
    this.d.notify({ m: 'pty.keystroke', a: { ptyId: this.ptyId, at: this.wallAt(at) } })
  }

  /** The wall-clock time of monotonic `t` (at most a reporting window ago). */
  private wallAt(t: number): number {
    return this.wall() - Math.max(0, this.d.clock.now() - t)
  }

  /** When the next note is due, or null. */
  private due(): number | null {
    let at: number | null = null
    const take = (t: number) => (at = at === null ? t : Math.min(at, t))
    if (!this.told && this.lastOutput > this.lastNote) take(this.lastNote + L.activityReportMs) // a start the window held back
    if (this.told) take(Math.max(this.lastOutput, this.lastNote) + L.activityReportMs) // the stop, once quiet that long
    if (this.keyPending) take(this.lastKeyNote + L.activityReportMs)
    return at
  }

  private arm(): void {
    const at = this.due()
    if (at === null) return
    if (this.timer !== null) {
      if (this.timerAt <= at) return // fires first; it re-arms for what is still due
      this.d.clock.clearTimeout(this.timer)
    }
    this.timerAt = at
    this.timer = this.d.clock.setTimeout(() => this.fire(), Math.max(0, at - this.d.clock.now()))
  }

  private fire(): void {
    this.timer = null
    if (this.disposed) return
    const now = this.d.clock.now()
    if (!this.told && this.lastOutput > this.lastNote && now - this.lastNote >= L.activityReportMs) this.tell(true, now)
    else if (this.told && now - this.lastOutput >= L.activityReportMs && now - this.lastNote >= L.activityReportMs) this.tell(false, now)
    if (this.keyPending && now - this.lastKeyNote >= L.activityReportMs) this.tellKey(this.lastKey)
    this.arm()
  }
}
