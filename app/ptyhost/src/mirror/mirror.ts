// A PTY's headless mirror: `@xterm/headless` created with `createTerminalOptions({ side: 'mirror' })`, plus
// `MirrorKit` (query responders, mode trailer, ground-state scanner). It tracks which seq it has parsed, so acks
// follow parsing and snapshots carry the seq they describe, and it notices a stalled parser.

import headless from '@xterm/headless'
import serializeAddon from '@xterm/addon-serialize'
import { resources } from '@kea/kit'
import { L } from '@kea/protocol'
import { createTerminalOptions, MirrorKit, type ColorTheme, type MirrorTerminal } from '@kea/terminal'

/** Headless mirrors not yet disposed, in this process. */
const mirrorsAlive = resources.counter('ptyhost.mirrors')

const { Terminal } = headless
const { SerializeAddon } = serializeAddon
type HeadlessTerminal = InstanceType<typeof Terminal>

export interface MirrorOptions {
  cols: number
  rows: number
  scrollback: number
  colors: ColorTheme
  /** The seq of the first byte this mirror will parse. */
  startSeq: number
  /**
   * Start from a checkpoint: the terminal is created at its size and its data written first, with replies off;
   * `startSeq` must be the checkpoint's seq.
   */
  restore?: { cols: number; rows: number; data: string }
  /** Replies to terminal queries, in order. Written to the PTY by the caller. */
  reply(data: string): void
  /** Every byte below `seq` has been parsed (write callback): ack the holder. */
  parsed(seq: number): void
  title?(title: string): void
  bell?(): void
  /** A desktop notification the program asked for (OSC 9, OSC 777 `notify`): tier 3's attention signal. */
  notify?(text: string): void
  /** Data became pending (none was): the owner watches for a stall from now. */
  busy?(): void
  now(): number
}

export interface MirrorSnapshot {
  seq: number
  cols: number
  rows: number
  data: string
}

export class Mirror {
  private readonly term: HeadlessTerminal
  readonly kit: MirrorKit
  private readonly opts: MirrorOptions
  private written: number
  private parsedTo: number
  private pending = 0
  // bounded: one per `pty.capture` in flight on this PTY (core asks once per script run), all settled when the writes
  // before them are parsed or on dispose; counted with the headless mirrors
  private parsedWaiters: (() => void)[] = []
  private progressAt = 0
  private disposed = false
  private replyWanted = true
  private restoring = false
  private deferredSize: { cols: number; rows: number } | null = null
  private restoredP: Promise<void> = Promise.resolve()
  readonly startSeq: number

  constructor(opts: MirrorOptions) {
    this.opts = opts
    mirrorsAlive.inc()
    const size = opts.restore ?? opts
    this.term = new Terminal(createTerminalOptions({ side: 'mirror', cols: size.cols, rows: size.rows, scrollback: opts.scrollback }))
    this.kit = new MirrorKit(this.term as unknown as MirrorTerminal, { colors: opts.colors, reply: (d) => opts.reply(d) })
    this.term.onTitleChange((t) => opts.title?.(t))
    this.term.onBell(() => opts.bell?.())
    // OSC 9 (iTerm2's notification; `9;<n>;…` are ConEmu's progress and other commands, not notifications) and OSC 777
    // `notify;<title>;<body>`; the text cut to L.hookSummaryMaxChars
    const note = (text: string) => opts.notify?.(text.slice(0, L.hookSummaryMaxChars))
    this.term.parser.registerOscHandler(9, (d) => {
      if (!/^\d+(;|$)/.test(d)) note(d)
      return true
    })
    this.term.parser.registerOscHandler(777, (d) => {
      if (d.startsWith('notify;')) note(d.slice('notify;'.length))
      return true
    })
    this.startSeq = opts.startSeq
    this.written = opts.startSeq
    this.parsedTo = opts.startSeq
    if (opts.restore) this.restoreFrom(opts.restore.data)
  }

  get cols(): number {
    return this.term.cols
  }
  get rows(): number {
    return this.term.rows
  }
  /** Every byte below this seq has been parsed. */
  get parsedSeq(): number {
    return this.parsedTo
  }
  /** Every byte below this seq has been handed to the parser. */
  get writtenSeq(): number {
    return this.written
  }
  get pendingWrites(): number {
    return this.pending
  }
  get title(): string {
    return this.kit.title
  }
  /** No escape sequence in progress (the mirror's parser is idle at `parsedSeq`). */
  get parserIdle(): boolean {
    return this.kit.scanner.parserIdle
  }
  /** Parser idle and no DEC 2026 block open: a snapshot may be cut at `parsedSeq`. */
  get atGround(): boolean {
    return this.kit.atGround
  }
  get isDisposed(): boolean {
    return this.disposed
  }
  /** The alternate screen is active (a full-screen app, which a rebuild nudges to repaint). */
  get altScreen(): boolean {
    return this.term.buffer.active.type === 'alternate'
  }
  /** Still writing the checkpoint it started from. */
  get isRestoring(): boolean {
    return this.restoring
  }
  /** Resolves once the checkpoint it started from is written in (at once without one). */
  whenRestored(): Promise<void> {
    return this.restoredP
  }
  /** The headless terminal itself, for tests and diagnostics only: ptyhost goes through the methods here. */
  get terminal(): HeadlessTerminal {
    return this.term
  }

  /** Bytes `[seq, seq + data.length)`; `seq` must equal `writtenSeq`. */
  write(seq: number, data: Uint8Array): void {
    if (this.disposed) return
    if (seq !== this.written) throw new Error(`mirror write out of order: got ${seq}, expected ${this.written}`)
    const end = seq + data.byteLength
    this.written = end
    if (this.pending++ === 0) {
      this.progressAt = this.opts.now()
      this.opts.busy?.()
    }
    this.writeInPieces(data, () => {
      if (this.disposed) return
      // Feed the scanner in the callback, so it and the mirror describe the same seq (packages/terminal README).
      this.kit.parsed(data)
      this.parsedTo = end
      this.pending--
      this.progressAt = this.opts.now()
      this.opts.parsed(end)
      if (this.pending === 0) for (const w of this.parsedWaiters.splice(0)) w()
    })
  }

  /** Resolves once every byte written so far is parsed (at once when nothing is pending, or once disposed). */
  whenParsed(): Promise<void> {
    if (this.disposed || this.pending === 0) return Promise.resolve()
    return new Promise((r) => this.parsedWaiters.push(r))
  }

  /** When this mirror counts as stalled if nothing completes before then; null while nothing is pending. */
  get stallAt(): number | null {
    return this.pending > 0 ? this.progressAt + L.mirrorStallMs : null
  }

  /** Data is pending and the write callback has not fired for L.mirrorStallMs. */
  stalled(now: number = this.opts.now()): boolean {
    return this.pending > 0 && now - this.progressAt >= L.mirrorStallMs
  }

  /** While a checkpoint is being written in, the resize waits for it: the checkpoint is for its own size. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return
    if (this.restoring) {
      this.deferredSize = { cols, rows }
      return
    }
    if (cols === this.term.cols && rows === this.term.rows) return
    this.term.resize(cols, rows)
  }

  /** Clear screen and scrollback (⌘K): the cursor line stays, as in xterm.js's own `clear()`. */
  clear(): void {
    if (!this.disposed) this.term.clear()
  }

  setPixelSize(width: number, height: number): void {
    this.kit.setPixelSize(width, height)
  }

  setColors(colors: ColorTheme): void {
    this.kit.setTheme(colors)
  }

  /** Off while rebuilding from the ring: replies to replayed queries never reach the PTY. */
  setReplying(on: boolean): void {
    this.replyWanted = on
    this.kit.setReplying(on && !this.restoring)
  }

  /**
   * The state at `parsedSeq` as one string for a fresh terminal of the same size. The serialize addon is loaded for
   * this call only; it is Kea's patched build, which fixes how the upstream addon writes some attribute
   * changes and rows. Callers check `parserIdle` / `atGround` first.
   */
  snapshot(): MirrorSnapshot {
    const addon = new SerializeAddon()
    this.term.loadAddon(addon)
    try {
      return { seq: this.parsedTo, cols: this.term.cols, rows: this.term.rows, data: this.kit.snapshot(addon) }
    } finally {
      addon.dispose()
    }
  }

  /**
   * Write a checkpoint's data before any output: it counts as pending but advances no seq, and nothing it
   * contains is answered. The scanner sees it too, so the charset tracker picks up the trailer's designations.
   */
  private restoreFrom(data: string): void {
    let resolve!: () => void
    this.restoredP = new Promise<void>((r) => (resolve = r))
    this.restoring = true
    this.kit.setReplying(false)
    if (this.pending++ === 0) {
      this.progressAt = this.opts.now()
      this.opts.busy?.()
    }
    this.writeInPieces(data, () => {
      if (this.disposed) return
      this.kit.parsed(new TextEncoder().encode(data))
      this.restoring = false
      this.kit.setReplying(this.replyWanted)
      // between this write and the next one in xterm's queue: later bytes see the new size
      const d = this.deferredSize
      this.deferredSize = null
      if (d && (d.cols !== this.term.cols || d.rows !== this.term.rows)) this.term.resize(d.cols, d.rows)
      resolve()
      this.pending--
      this.progressAt = this.opts.now()
      if (this.pending === 0) for (const w of this.parsedWaiters.splice(0)) w()
    })
  }

  /**
   * `data` handed to xterm in pieces of at most L.mirrorWriteMaxBytes (bytes, or UTF-16 units of a checkpoint).
   * xterm grows its parse buffer to 4 bytes per unit of the largest write and keeps it, so a 64 KiB batch would
   * leave 256 KiB in every awake mirror, and a checkpoint written in one piece 512 KiB. `done` goes with the last piece:
   * xterm parses writes in order, and its decoders carry a sequence split between pieces over.
   */
  private writeInPieces(data: Uint8Array | string, done: () => void): void {
    const max = L.mirrorWriteMaxBytes
    const n = typeof data === 'string' ? data.length : data.byteLength
    const piece = (from: number, to?: number) => (typeof data === 'string' ? data.slice(from, to) : data.subarray(from, to))
    let o = 0
    for (; n - o > max; o += max) this.term.write(piece(o, o + max))
    this.term.write(o === 0 ? data : piece(o), done)
  }

  /** The visible screen as text (for report bundles). */
  screenText(): string {
    const b = this.term.buffer.active
    const out: string[] = []
    for (let i = b.viewportY; i < b.viewportY + this.term.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
    return out.join('\n')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const w of this.parsedWaiters.splice(0)) w()
    mirrorsAlive.dec()
    this.kit.dispose()
    this.term.dispose()
  }
}
