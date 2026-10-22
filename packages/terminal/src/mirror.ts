// Everything a ptyhost mirror needs from this package, wired once: the query responders, the mode tracker and the
// byte-ordered charset tracker, the ground-state scanner, and the reply gate (replies are dropped while the mirror
// rebuilds from the ring). Ptyhost owns the `@xterm/headless` instance and the serialize addon; this kit only attaches
// to it.

import { ColorState, type ColorTheme } from './colors.ts'
import { composeSnapshot, ModeTracker, type Trailer } from './modes.ts'
import { installMirrorResponders } from './queries.ts'
import { CharsetTracker, VtScanner } from './scanner.ts'
import { disposeAll, type Disposable, type SerializerApi, type TerminalApi } from './xterm.ts'

export interface MirrorTerminal extends TerminalApi {
  onData(listener: (data: string) => void): Disposable
}

export interface MirrorKitOptions {
  colors: ColorTheme
  /** Where replies go (the PTY). Called synchronously during parsing, in the order the queries arrived. */
  reply(data: string): void
}

export class MirrorKit {
  readonly scanner = new VtScanner()
  readonly charsets = new CharsetTracker()
  readonly colors: ColorState
  readonly modes: ModeTracker
  private readonly term: MirrorTerminal
  private readonly ds: Disposable[] = [] // bounded: fixed set
  private pixel: { width: number; height: number } | null = null
  private replying = true
  private dropped = 0

  constructor(term: MirrorTerminal, opts: MirrorKitOptions) {
    this.term = term
    this.colors = new ColorState(opts.colors)
    this.scanner.addListener(this.charsets)
    const emit = (d: string) => {
      if (this.replying) opts.reply(d)
      else this.dropped++
    }
    // responders first, tracker second: hooks registered later run first, and the tracker only observes
    this.ds.push(
      installMirrorResponders(term, { colors: this.colors, pixelSize: () => this.pixel, reply: emit }),
      term.onData(emit), // xterm.js's own replies (DA, DSR, DECRQM, kitty, XTVERSION, DECRQSS)
    )
    this.modes = new ModeTracker(term)
    this.ds.push(this.modes)
  }

  /** Feed the bytes the mirror has just parsed (from its write callback), so scanner and mirror describe one seq. */
  parsed(bytes: Uint8Array): void {
    this.scanner.feed(bytes)
  }

  /** A checkpoint or snapshot may be cut now. */
  get atGround(): boolean {
    return this.scanner.atGround && !this.term.modes.synchronizedOutputMode
  }

  /** From the renderer's RESIZE (`xpx`, `ypx`), for `CSI 14 t` / `CSI 16 t`. */
  setPixelSize(width: number, height: number): void {
    this.pixel = width > 0 && height > 0 ? { width, height } : null
  }

  /** Off while the mirror is rebuilt from the ring: replies to replayed queries must never reach the PTY. */
  setReplying(on: boolean): void {
    this.replying = on
  }
  get droppedReplies(): number {
    return this.dropped
  }

  setTheme(theme: ColorTheme): void {
    this.colors.setTheme(theme)
  }

  trailer(serializer?: SerializerApi): Trailer {
    return this.modes.trailer({
      charsets: this.charsets,
      colors: this.colors,
      serializeNormalRow: serializer ? (row) => serializer.serialize({ range: { start: row, end: row }, excludeModes: true, excludeAltBuffer: true }) : undefined,
    })
  }

  /**
   * The snapshot of the current state, with a serialize addon loaded on this terminal. Take it only `atGround`; it is
   * written into a fresh terminal of the same size.
   */
  snapshot(serializer: SerializerApi): string {
    return composeSnapshot(serializer.serialize(), this.trailer(serializer))
  }

  get title(): string {
    return this.modes.currentTitle
  }

  dispose(): void {
    disposeAll(this.ds.splice(0))
  }
}
