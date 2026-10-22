// Shared by the ptyhost suites (integration, chaos, memory): a stand-in renderer on a stream port and the terminal
// state that "renderer equals mirror" compares. The renderer is a headless xterm created with the renderer's options,
// its query forms swallowed exactly as the real renderer swallows them and its own replies, if it ever made any, sent
// back as input (so a duplicate answer would reach the PTY and be caught).

import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import headless from '@xterm/headless'
import serializeAddon from '@xterm/addon-serialize'
import { channelPair, DEFAULT_TERMINAL_SETTINGS, type Channel, type StreamToRenderer } from '@kea/protocol'
import { createTerminalOptions, installRendererSwallow, ModeTracker } from '@kea/terminal'
import { internals } from '../../packages/terminal/src/test-support.ts'
import type { PtyManager } from '../../app/ptyhost/src/manager.ts'
import type { Pty } from '../../app/ptyhost/src/pty.ts'
import { REPO_ROOT, until } from '../support/holders.ts'

const { Terminal } = headless
const { SerializeAddon } = serializeAddon
export type HeadlessTerminal = InstanceType<typeof Terminal>

/** Signal numbers for `pty.signal` (this system's numbering, from the OS, never written inline). */
export const SIG = os.constants.signals

/** A renderer-side headless terminal, as the window's xterm is configured. */
export function rendererTerminal(cols: number, rows: number, scrollback = DEFAULT_TERMINAL_SETTINGS.scrollback): HeadlessTerminal {
  return new Terminal(createTerminalOptions({ side: 'renderer', cols, rows, scrollback }))
}

/** Everything that must match between a mirror and a renderer that attached to it (I-PTY-1, I-PTY-2). */
export function terminalState(term: HeadlessTerminal) {
  const addon = new SerializeAddon()
  term.loadAddon(addon)
  let serialized: string
  try {
    serialized = addon.serialize()
  } finally {
    addon.dispose()
  }
  const i = internals(term)
  const b = term.buffer.active
  return {
    cols: term.cols,
    rows: term.rows,
    buffer: b.type,
    cursor: [b.cursorX, b.cursorY],
    lines: b.length,
    viewportY: b.viewportY,
    serialized,
    kitty: i.kitty,
    mouseEncoding: i.mouseEncoding,
    mouseProtocol: i.mouseProtocol,
    scrollRegion: i.scrollRegion,
    cursorStyle: i.cursorStyle,
    cursorBlink: i.cursorBlink,
    glevel: i.glevel,
    charsets: i.charsets,
    title: i.title,
    // the DEC private modes, insert mode and cursor visibility, LNM, and each screen's tab stops
    modes: { ...term.modes },
    lnm: term.options.convertEol,
    tabs: i.tabs,
  }
}

/** The visible rows as text. */
export function viewportText(term: HeadlessTerminal): string[] {
  const b = term.buffer.active
  const out: string[] = []
  for (let i = b.viewportY; i < b.viewportY + term.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
  return out
}

export function write(term: HeadlessTerminal, data: string | Uint8Array): Promise<void> {
  return new Promise((r) => term.write(data, r))
}

/** A mirror's terminal (awake PTYs only). */
export function mirrorTerminal(p: Pty): HeadlessTerminal {
  const m = p.currentMirror
  if (!m) throw new Error(`${p.ptyId} has no mirror (parked or exited)`)
  return m.terminal as HeadlessTerminal
}

/** The seq the PTY's mirror has parsed up to (0 when it has none). */
export function parsedSeq(p: Pty): number {
  return p.currentMirror?.parsedSeq ?? 0
}

export interface RendererOptions {
  /**
   * `auto` (default): return credit as each write completes, as the window does. `manual`: only when the test calls
   * `giveCredit`. `instant`: as each message arrives, before writing it (a renderer that is never behind).
   */
  credit?: 'auto' | 'manual' | 'instant'
  /** Sees every message ptyhost sends, at the moment it sends it (before it is delivered). */
  onPtyhostSend?: (m: StreamToRenderer) => void
  /** Keep data chunks in `messages` (default true); off for volume tests, which would otherwise hold every byte. */
  keepData?: boolean
  /** Called in each write callback with the new `writtenSeq` (latency tests time an echo from it). */
  onWritten?: (seq: number) => void
}

/**
 * One renderer terminal attached over a stream port, doing what the window's TerminalView does: on a
 * snapshot, reset → size → write it; then live chunks in order, each returning its credit once written.
 * Attached to an in-process `PtyManager`, or over a port whose other end a ptyhost elsewhere already holds (a
 * `PtyhostWorker`, whose event loop is not the renderer's, as in the app).
 */
export class TestRenderer {
  readonly ptyId: string
  term: HeadlessTerminal
  readonly modes: { tracker: ModeTracker }
  /** Every message, in arrival order (data chunks only when `keepData`). */
  readonly messages: StreamToRenderer[] = [] // bounded: one test's stream
  /** Data chunks whose seq did not continue the stream (must stay empty: a gap is always a snapshot). */
  readonly discontinuities: { expected: number; got: number }[] = []
  /** Input this renderer sent (its own query replies would show up here). */
  readonly sentInput: string[] = []
  snapshots = 0
  /** The next byte the renderer will be given, and the next one it has finished writing. */
  nextSeq = -1
  writtenSeq = -1
  /** Credit owed while `credit: 'manual'`. */
  owed = 0
  private readonly port: Channel
  private readonly mine: Channel | null
  private readonly credit: 'auto' | 'manual' | 'instant'
  private readonly keepData: boolean
  private readonly onWritten: ((seq: number) => void) | undefined
  private closed = false

  /** `target`: the in-process ptyhost to attach to, or the renderer end of a port already attached elsewhere. */
  constructor(target: PtyManager | { port: Channel }, ptyId: string, o: RendererOptions = {}) {
    this.ptyId = ptyId
    this.credit = o.credit ?? 'auto'
    this.keepData = o.keepData ?? true
    this.onWritten = o.onWritten
    const spy = o.onPtyhostSend
    let theirs: Channel
    if ('port' in target) {
      theirs = target.port
      this.mine = null
      if (spy) {
        // no ptyhost end here: see each message as it arrives instead
        const on = theirs.onMessage.bind(theirs)
        theirs.onMessage = (cb) => on((m, p) => (spy(m as StreamToRenderer), cb(m, p)))
      }
    } else {
      const [mine, other] = channelPair()
      if (spy) {
        const send = mine.send.bind(mine)
        mine.send = (m, t) => {
          spy(m as StreamToRenderer)
          send(m, t)
        }
      }
      this.mine = mine
      theirs = other
    }
    this.port = theirs
    this.term = rendererTerminal(80, 24)
    this.modes = { tracker: this.wire(this.term) }
    theirs.onMessage((m) => this.onMessage(m as StreamToRenderer))
    if (!('port' in target)) target.attachStream(ptyId, this.mine!)
  }

  private wire(term: HeadlessTerminal): ModeTracker {
    installRendererSwallow(term as never)
    term.onData((d) => {
      this.sentInput.push(d)
      this.port.send({ k: 'in', d })
    })
    return new ModeTracker(term as never)
  }

  private onMessage(m: StreamToRenderer): void {
    if (this.closed) return
    if (m.k !== 'data' || this.keepData) this.messages.push(m)
    if (this.credit === 'instant' && (m.k === 'snapshot' || m.k === 'data')) this.port.send({ k: 'credit', n: m.k === 'snapshot' ? m.data.length : m.b.byteLength })
    switch (m.k) {
      case 'snapshot': {
        this.snapshots++
        // as the window does: a fresh terminal state, the trailer seen by a fresh mode tracker
        this.modes.tracker.dispose()
        this.term.reset()
        this.modes.tracker = new ModeTracker(this.term as never)
        if (m.cols !== this.term.cols || m.rows !== this.term.rows) this.term.resize(m.cols, m.rows)
        this.nextSeq = m.seq
        const cost = m.data.length
        this.term.write(m.data, () => {
          this.writtenSeq = Math.max(this.writtenSeq, m.seq)
          this.pay(cost)
          this.onWritten?.(this.writtenSeq)
        })
        return
      }
      case 'data': {
        if (m.seq !== this.nextSeq) this.discontinuities.push({ expected: this.nextSeq, got: m.seq })
        const end = m.seq + m.b.byteLength
        this.nextSeq = end
        const n = m.b.byteLength
        this.term.write(m.b, () => {
          this.writtenSeq = end
          this.pay(n)
          this.onWritten?.(end)
        })
        return
      }
      default:
        return
    }
  }

  private pay(n: number): void {
    if (this.credit === 'auto') this.port.send({ k: 'credit', n })
    else if (this.credit === 'manual') this.owed += n
  }

  /** Return the credit owed (manual mode). */
  giveCredit(): void {
    const n = this.owed
    this.owed = 0
    if (n > 0) this.port.send({ k: 'credit', n })
  }

  /** The window resized its terminal: resize locally, then tell ptyhost. */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
    this.port.send({ k: 'resize', cols, rows, xpx: 0, ypx: 0 })
  }

  input(d: string): void {
    this.port.send({ k: 'in', d })
  }

  async untilWritten(seq: number, ms?: number): Promise<void> {
    await until(`renderer ${this.ptyId} to write up to ${seq} (at ${this.writtenSeq})`, () => this.writtenSeq >= seq, ms)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.port.send({ k: 'close' })
    this.port.close()
    this.modes.tracker.dispose()
    this.term.dispose()
  }

  /** The ptyhost end (tests that inspect what ptyhost sees; in-process ptyhost only). */
  get ptyhostEnd(): Channel {
    if (!this.mine) throw new Error('ptyhostEnd: this renderer is attached to a ptyhost elsewhere')
    return this.mine
  }
}

/** The window's own xterm (`@xterm/xterm`, resolved through the renderer's dependencies), for its keyboard encoder. */
export async function browserXterm(): Promise<{ Terminal: new (o: object) => { write(d: string, cb?: () => void): void; dispose(): void; _core: any } }> {
  const req = createRequire(path.join(REPO_ROOT, 'app/renderer/package.json'))
  const file = req.resolve('@xterm/xterm').replace(/xterm\.js$/, 'xterm.mjs')
  return (await import(file)) as never
}
