// xterm's screen-reader mode and each terminal's accessible name, as logic.
//
// Screen-reader mode makes xterm keep a second, text copy of the screen in the DOM and announce what is printed. It is
// on only while a screen reader runs (main says so: Electron's accessibility support, which VoiceOver turns on; on
// Linux, where Electron reports no change, the `terminal.screenReader` setting can say on or off, views.ts), and then
// only in the terminal on screen: a warm or hidden terminal keeps no such copy, so it pays nothing. Turning it on and
// off is live: no terminal is made again.
//
// A terminal's accessible name says which session and which tab it is ("Fix auth redirect, Agent terminal"), so a
// screen reader's user knows where the keyboard is; it is set whether or not a screen reader runs.

export interface ScreenReaderTarget {
  readonly ptyId: string
  /** Turn xterm's screen-reader mode on or off, live. */
  setScreenReader(on: boolean): void
  /** The name assistive technology reads for this terminal. */
  setAccessibleName(name: string): void
}

/** A terminal's accessible name: its session's title (none for the shells outside a session), then its tab. */
export function terminalName(session: string | null | undefined, tab: string): string {
  const t = tab.trim() || 'shell'
  const s = session?.trim()
  return s ? `${s}, ${t} terminal` : `${t} terminal`
}

export class ScreenReaderMode<V extends ScreenReaderTarget> {
  private readonly views: () => Iterable<V>
  private running = false
  private shown: string | null = null
  // bounded: one per open tab of the context on screen, replaced whole by `setNames`
  private readonly names = new Map<string, string>()

  constructor(views: () => Iterable<V>) {
    this.views = views
  }

  /** A screen reader started or stopped. */
  setRunning(on: boolean): void {
    if (this.running === on) return
    this.running = on
    this.apply()
  }

  /** The terminal on screen changed (null: none). */
  setShown(ptyId: string | null): void {
    if (this.shown === ptyId) return
    this.shown = ptyId
    this.apply()
  }

  /** The open tabs' names, replacing the ones before (a tab that is gone is forgotten). */
  setNames(entries: Iterable<readonly [string, string]>): void {
    this.names.clear()
    for (const [id, name] of entries) this.names.set(id, name)
    for (const v of this.views()) this.name(v)
  }

  /** A view was just made: it takes its name, and the mode if it is the one on screen. */
  adopt(v: V): void {
    this.name(v)
    v.setScreenReader(this.running && v.ptyId === this.shown)
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Names held: at most the open tabs (U-TERM-33). */
  get nameCount(): number {
    return this.names.size
  }

  private name(v: V): void {
    const n = this.names.get(v.ptyId)
    if (n !== undefined) v.setAccessibleName(n)
  }

  private apply(): void {
    for (const v of this.views()) v.setScreenReader(this.running && v.ptyId === this.shown)
  }
}
