// One PTY in ptyhost: its holder connection, headless mirror, coalescer and attached renderer streams, all in one scope
// that is disposed when the PTY is removed.
//
// Data path for each OUTPUT frame: seq check → coalescer → every attached renderer first, then the mirror → the
// mirror's write callback acks the holder and wakes snapshot requests waiting for a ground-state seq.
//
// The mirror can be absent: *parked* (no renderer and no output for L.mirrorParkIdleMs), after exit, or not yet rebuilt
// after an adoption. It is then rebuilt from the last checkpoint plus the ring ("woken") on the first new output byte,
// on attach (which is served the checkpoint at once), when it is visible, or in idle time. A gap in the output, a
// stalled parser and an exception inside xterm all rebuild it the same way.

import { L, type Channel, type PtyhostNote, type PtyInfo, type PtyKind, type HolderHello, type HolderStat, type SignalTarget } from '@kea/protocol'
import { Scope, type Clock, type Logger } from '@kea/kit'
import type { ColorTheme } from '@kea/terminal'
import type { CheckpointCandidate, CheckpointReason, CheckpointScheduler } from './checkpoint/scheduler.ts'
import type { Checkpoint, CheckpointStore } from './checkpoint/store.ts'
import type { HolderConnection } from './holder/connection.ts'
import { Mirror } from './mirror/mirror.ts'
import { Attachment, type AttachmentHost, type StreamSnapshot } from './stream/attachment.ts'
import { Coalescer } from './stream/coalescer.ts'
import { RingFile } from './stream/ring.ts'

export interface PtyMeta {
  ptyId: string
  sessionId: string
  kind: PtyKind
  stateDir: string
  sock: string
  cwd: string
  argv: string[]
  holderPid: number | null
  holderStartedAt: number | null
  /** false: a non-detached holder, which ends with this ptyhost. */
  detached: boolean
}

export interface PtyDeps {
  clock: Clock
  log: Logger
  notify(note: PtyhostNote): void
  colors(): ColorTheme
  scrollback(): number
  checkpoints(): CheckpointStore
  scheduler: CheckpointScheduler
  /** The PTY's connection closed and it holds nothing any more; the manager forgets it. */
  removed(p: Pty): void
  /** A rebuild from the ring finished (the manager starts the next idle-time rebuild). */
  rebuilt?(p: Pty): void
  /**
   * The holder connection closed while the child ran: connect to the same holder again. Resolves once the
   * holder answers as this PTY; rejects when it is gone or cannot be reached. Without it, any such close is a loss.
   */
  readopt?(p: Pty): Promise<{ conn: HolderConnection; hello: HolderHello }>
  /** Output arrived and input was sent: ptyhost's activity notes for tier 3 (`activity.ts`). */
  activity?: { output(p: Pty): void; input(p: Pty, data: string | Uint8Array): void }
  /** Each checkpoint written or refused, for the disk-full banner (`checkpoint/diskFull.ts`). */
  disk?: { written(): void; failed(e: unknown): void }
}

export type PtyStart =
  /** A fresh spawn: the mirror starts at `fromSeq` and answers everything, backlog included. */
  | { mode: 'live'; fromSeq: number }
  /** An adopted holder: no mirror until it is woken; streaming starts at the holder's latest seq. */
  | { mode: 'parked' }

type SnapshotWaiter = { cb: (s: StreamSnapshot) => void; since: number }

export class Pty implements AttachmentHost, CheckpointCandidate {
  readonly ptyId: string
  readonly meta: PtyMeta
  readonly scope: Scope
  private readonly deps: PtyDeps
  private conn: HolderConnection
  private mirror: Mirror | null = null
  /** The seq of the batch being forwarded to renderers, before the mirror has it (see `mirrorSeq`). */
  private forwarding: number | null = null
  private readonly coalescer: Coalescer
  private readonly ring: RingFile
  private readonly capacity: number
  private readonly attachments = new Set<Attachment>() // bounded: one per renderer stream for this PTY (one window)
  private readonly waiters = new Set<SnapshotWaiter>() // bounded: one per attachment awaiting a snapshot
  private syncTimer: { dispose(): void } | null = null
  /** Mirrors whose checkpoint restore the snapshot waiters wait on (U-PTY-57): one wait per mirror, held weakly. */
  private readonly restoreWaits = new WeakSet<Mirror>() // bounded: weak; only the current mirror can be restoring
  /** Replies stay off until the mirror has parsed this far (replay after a rebuild). */
  private replayTo = 0
  /** The rebuild started from the ring alone: nudge a full-screen app to repaint when it is done. */
  private nudgeAfterReplay = false
  private childPid: number
  private cols: number
  private rows: number
  private exitInfo: { code: number | null; signal: number | null } | null = null
  private state: PtyInfo['state'] = 'running'
  private lastTitle: string | null = null
  private resizeTimer: { dispose(): void } | null = null
  private pendingSize: { cols: number; rows: number; xpx: number; ypx: number } | null = null
  private pixel = { xpx: 0, ypx: 0 }
  // checkpoints
  private ckptSeq: number | null = null
  /** ⌘K cleared the mirror at this seq: the next checkpoint must be written even with no new output. */
  private clearedAt: number | null = null
  private ckptAt: number
  private cutBlockedSince: number | null = null
  private cutRetry: { dispose(): void } | null = null
  // parking
  private lastOutputAt: number
  private parkTimer: { dispose(): void } | null = null
  // mirror health: armed only while the mirror has data pending
  private stallTimer: { dispose(): void } | null = null
  // re-adoption after a connection the holder closed
  private readoptedAt = Number.NEGATIVE_INFINITY
  /** Core let the holder go (`release`): no checkpoint is written after that. */
  private released = false
  /** What waits for the holder while it is re-adopted, sent in order once it answers. */
  // bounded: input and the mirror's replies up to L.holderInputCapBytes (empty input is not held), one entry per
  // distinct signal and target, one TERMINATE (the shortest grace asked); resizes and STATs are never held
  private held: { ops: (() => void)[]; bytes: number; signals: Set<string>; graceMs: number | null } | null = null
  lastKeystrokeAt = Number.NEGATIVE_INFINITY
  /** Counters for the resource report and tests. */
  readonly stats = { wakes: 0, parks: 0, checkpoints: 0, rebuilds: 0, nudges: 0, gaps: 0, readopts: 0 }

  /** Take over a connected holder (after HELLO). */
  constructor(meta: PtyMeta, conn: HolderConnection, hello: HolderHello, deps: PtyDeps, start: PtyStart) {
    this.ptyId = meta.ptyId
    this.meta = meta
    this.deps = deps
    this.conn = conn
    this.scope = new Scope(`pty:${meta.ptyId}`, { clock: deps.clock })
    this.childPid = hello.childPid
    this.cols = hello.cols
    this.rows = hello.rows
    this.ckptAt = deps.clock.now()
    this.lastOutputAt = deps.clock.now()
    this.ring = new RingFile(`${meta.stateDir}/${meta.ptyId}.ring`)
    this.capacity = this.ring.header()?.capacity ?? L.ringBytesDefault
    const fromSeq = start.mode === 'live' ? start.fromSeq : hello.latestSeq
    this.coalescer = new Coalescer({ clock: deps.clock, flush: (seq, data) => this.onFlush(seq, data) })
    this.coalescer.reset(fromSeq)
    if (start.mode === 'live') {
      this.mirror = this.newMirror(fromSeq)
    } else {
      const c = this.usableCheckpoint(fromSeq)
      if (c) {
        this.lastTitle = c.title
        this.ckptSeq = c.seq
      }
    }
    // An adopted holder whose child has exited is exited now. A fresh spawn's child can exit before ptyhost connects (a
    // short script): it stays running here until the EXIT frame, which the holder sends after all its output, so
    // whoever sees it end finds every byte it printed
    if (hello.exited && start.mode !== 'live') this.markExited(hello.code, hello.signal)
    deps.scheduler.add(this)
    this.scope.add({
      dispose: () => {
        deps.scheduler.remove(this)
        this.coalescer.dispose()
        this.mirror?.dispose()
        this.mirror = null
        this.ring.close()
        this.syncTimer?.dispose()
        this.resizeTimer?.dispose()
        this.cutRetry?.dispose()
        this.parkTimer?.dispose()
        this.stallTimer?.dispose()
        for (const a of [...this.attachments]) a.gone('removed')
        this.waiters.clear()
        if (!this.conn.isClosed) this.conn.destroy()
      },
    })
    this.listen(conn, fromSeq)
    this.armPark()
  }

  /** ATTACH on `conn` from `seq`; events of a connection that is no longer this PTY's are ignored. */
  private listen(conn: HolderConnection, seq: number): void {
    const mine = () => conn === this.conn
    conn.attach('fromSeq', seq, {
      gap: (expected, got) => mine() && this.onGap(expected, got),
      output: (s, data) => mine() && this.onOutput(s, data),
      exit: (code, signal) => mine() && this.onExit(code, signal),
      error: (code, message) => this.deps.log.warn('holder error', { ptyId: this.ptyId, code, message }),
      close: (reason) => mine() && this.onClose(reason),
    })
  }

  info(): PtyInfo {
    return {
      ptyId: this.ptyId,
      sessionId: this.meta.sessionId,
      kind: this.meta.kind,
      state: this.state,
      holderPid: this.meta.holderPid,
      holderStartedAt: this.meta.holderStartedAt,
      childPid: this.childPid || null,
      cwd: this.meta.cwd,
      argv: this.meta.argv,
      cols: this.cols,
      rows: this.rows,
      exitCode: this.exitInfo?.code ?? null,
      exitSignal: this.exitInfo?.signal ?? null,
      detached: this.meta.detached,
      title: this.lastTitle,
    }
  }

  get isDisposed(): boolean {
    return this.scope.isDisposed
  }

  /** No mirror in memory (parked, exited, or not rebuilt yet). */
  get isParked(): boolean {
    return this.mirror === null
  }

  /** A rebuild from the ring is still being parsed. */
  get isReplaying(): boolean {
    return this.mirror !== null && this.replayTo > 0
  }

  get isRunning(): boolean {
    return this.state === 'running'
  }

  /** Unparsed bytes in the mirror (an exception inside xterm leaves these behind). */
  get pendingWrites(): number {
    return this.mirror?.pendingWrites ?? 0
  }

  /** The seq the stored checkpoint describes, if any. */
  get checkpointSeq(): number | null {
    return this.ckptSeq
  }

  /** The awake mirror, for tests and diagnostics only (null while parked or after exit). */
  get currentMirror(): Mirror | null {
    return this.mirror
  }

  // ── renderer streams ──────────────────────────────────────────────────────────────

  attach(ch: Channel): Attachment {
    const a = new Attachment(this, ch)
    this.attachments.add(a)
    this.parkTimer?.dispose()
    this.parkTimer = null
    a.start()
    if (this.exitInfo) a.exit(this.exitInfo.code, this.exitInfo.signal)
    // the checkpoint was the snapshot; the mirror rebuilds behind it
    if (this.mirror === null && this.state === 'running') this.wake(this.mirrorSeq)
    return a
  }

  get attachedCount(): number {
    return this.attachments.size
  }

  /** For the resource report: credit outstanding across this PTY's streams, bytes the coalescer holds, … */
  get resourceCounts(): { holderSocket: number; creditOutstanding: number; coalescerBytes: number; snapshotWaiters: number; holderWriteBytes: number; timers: number } {
    let credit = 0
    for (const a of this.attachments) credit += a.flow.outstandingBytes
    const timers = [this.syncTimer, this.resizeTimer, this.cutRetry, this.parkTimer, this.stallTimer].filter((t) => t !== null).length
    return {
      holderSocket: this.conn.isClosed ? 0 : 1,
      creditOutstanding: credit,
      coalescerBytes: this.coalescer.pendingBytes,
      snapshotWaiters: this.waiters.size,
      holderWriteBytes: this.conn.isClosed ? 0 : this.conn.queuedBytes,
      timers,
    }
  }

  detached(a: Attachment): void {
    this.attachments.delete(a)
    if (this.attachments.size === 0) this.armPark()
  }

  flushedSeq(): number {
    return this.coalescer.flushedSeq
  }

  readRing(from: number, to: number, max: number): Uint8Array | null {
    return this.ring.read(from, to, max)
  }

  requestSnapshot(cb: (s: StreamSnapshot) => void): () => void {
    if (this.mirror === null) {
      // Parked or exited: the checkpoint is the snapshot when the ring still covers what follows it.
      const c = this.usableCheckpoint(this.coalescer.flushedSeq)
      if (c) {
        cb({ seq: c.seq, cols: c.cols, rows: c.rows, data: c.data, exited: this.exitInfo, title: this.lastTitle })
        return () => {}
      }
      this.wake(this.mirrorSeq)
    }
    const w: SnapshotWaiter = { cb, since: this.deps.clock.now() }
    this.waiters.add(w)
    this.serveSnapshots()
    return () => this.waiters.delete(w)
  }

  // ── input from renderers and core ─────────────────────────────────────────────────

  input(data: string | Uint8Array): void {
    if (this.state !== 'running') return
    this.deps.activity?.input(this, data)
    this.lastKeystrokeAt = this.deps.clock.now()
    this.deps.scheduler.keystroke()
    if (!this.send(data)) this.deps.log.warn('input dropped: holder not reading', { ptyId: this.ptyId })
  }

  /** Bytes for the PTY (keystrokes, the mirror's replies): held while re-adopting, up to `L.holderInputCapBytes`. */
  private send(data: string | Uint8Array): boolean {
    const held = this.held
    if (!held) return this.conn.input(data)
    const n = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    if (n === 0) return true
    if (held.bytes + n > L.holderInputCapBytes) return false
    held.bytes += n
    held.ops.push(() => this.conn.input(data))
    return true
  }

  /**
   * Debounced: the first size goes out at once, later ones at most once per L.resizeDebounceMs, the last one
   * always. Sizes are clamped to at least L.ptyMinCols × L.ptyMinRows.
   */
  resize(cols: number, rows: number, xpx = 0, ypx = 0): void {
    this.pendingSize = { cols: Math.max(L.ptyMinCols, Math.floor(cols)), rows: Math.max(L.ptyMinRows, Math.floor(rows)), xpx, ypx }
    if (this.resizeTimer) return
    this.applySize()
    this.armResize()
  }

  /** A size applied when the debounce period ends starts the next period, so a steady storm is held to its rate. */
  private armResize(): void {
    this.resizeTimer = this.scope.timeout(() => {
      this.resizeTimer = null
      if (!this.pendingSize) return
      this.applySize()
      this.armResize()
    }, L.resizeDebounceMs)
  }

  /** While the holder is re-adopted a signal waits, once per signal and target. */
  signal(signo: number, target: SignalTarget): void {
    const held = this.held
    if (!held) return this.conn.signal(signo, target)
    const key = `${signo}:${target}`
    if (held.signals.has(key)) return
    held.signals.add(key)
    held.ops.push(() => this.conn.signal(signo, target))
  }

  /** While the holder is re-adopted one TERMINATE waits, with the shortest grace asked. */
  terminate(graceMs: number): void {
    const held = this.held
    if (!held) return this.conn.terminate(graceMs)
    if (held.graceMs === null) held.ops.push(() => this.conn.terminate(held.graceMs ?? graceMs))
    held.graceMs = Math.min(held.graceMs ?? graceMs, graceMs)
  }

  /** No answer (null) while the holder is re-adopted, as from a closed connection. */
  stat(): Promise<HolderStat | null> {
    return this.held ? Promise.resolve(null) : this.conn.stat()
  }

  /**
   * Let go of the holder without releasing or signalling it (`pty.detach`): it keeps running and can be adopted again.
   * Its last screen is checkpointed first; attached renderers are told it is gone. A non-detached holder cannot outlive
   * its ptyhost, so it ends.
   */
  detachHolder(): void {
    if (this.scope.isDisposed) return
    this.coalescer.flushNow()
    if (this.mirror && this.dirtyBytes() > 0) this.checkpoint('shutdown')
    for (const a of [...this.attachments]) a.gone('detached')
    this.deps.removed(this)
    this.dispose()
  }

  /**
   * The holder may go: only after the child has exited. Its last checkpoint is written now, even one the rate
   * rules still hold back, and nothing after: core may remove its files next (an archived session's shell).
   * A screen that cannot be cut now is still covered by the ring after the last checkpoint.
   */
  release(): boolean {
    if (this.state === 'running') return false
    if (!this.released) {
      this.released = true
      if (this.mirror && this.dirtyBytes() > 0) this.checkpoint('shutdown')
      this.deps.scheduler.remove(this)
    }
    if (!this.conn.isClosed) this.conn.release()
    return true
  }

  setColors(colors: ColorTheme): void {
    this.mirror?.setColors(colors)
  }

  /** The visible screen as text, or null while parked (for report bundles). */
  screenText(): string | null {
    return this.mirror?.screenText() ?? null
  }

  /** The PTY's grid (a cold capture of an exited PTY is drawn at it). */
  get grid(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  /**
   * The visible screen as text once every byte received so far is parsed (a script's last line, printed right before it
   * exits, is in it); null when the mirror is parked or goes meanwhile (the caller reads checkpoint + ring).
   */
  async settledScreenText(): Promise<string | null> {
    this.coalescer.flushNow()
    const m = this.mirror
    if (!m) return null
    await m.whenParsed()
    return m.isDisposed ? null : m.screenText()
  }

  /** Rebuild the mirror now if it is parked (a visible terminal, or the idle-time queue). */
  ensureAwake(): void {
    if (this.mirror === null && this.state === 'running' && !this.isDisposed) this.wake(this.mirrorSeq)
  }

  /**
   * Throw the mirror away and rebuild it from checkpoint + ring (a stalled parser or an exception inside
   * xterm). Replies resume where the old mirror stopped answering.
   */
  rebuildMirror(why: string): void {
    const old = this.mirror
    if (!old || this.isDisposed) return
    this.deps.log.error('mirror rebuilt', { ptyId: this.ptyId, why, parsed: old.parsedSeq, written: old.writtenSeq })
    const answeredTo = old.parsedSeq
    old.dispose()
    this.mirror = null
    this.stats.rebuilds++
    if (this.state !== 'running') return
    this.wake(this.mirrorSeq, answeredTo)
  }

  /** Clear terminal and scrollback: the mirror is cleared and checkpointed; the ring is untouched. */
  clear(): boolean {
    if (!this.mirror) return false
    this.mirror.clear()
    this.clearedAt = this.mirror.parsedSeq
    this.deps.scheduler.request(this, 'now')
    return true
  }

  dispose(): void {
    this.scope.dispose()
  }

  // ── checkpoints (CheckpointCandidate) ─────────────────────────────────────────────

  dirtyBytes(): number {
    const m = this.mirror
    if (!m) return 0
    return m.parsedSeq - (this.ckptSeq ?? m.startSeq)
  }

  lastCheckpointAt(): number {
    return this.ckptAt
  }

  ringCapacity(): number {
    return this.capacity
  }

  checkpoint(reason: CheckpointReason | 'due' | 'shutdown'): 'done' | 'wait' | 'failed' {
    const m = this.mirror
    if (!m) return 'done'
    const final = reason === 'park' || reason === 'exit'
    if (reason === 'park' && !this.parkable()) return 'done' // something attached or arrived meanwhile
    if (final && m.pendingWrites > 0) return 'wait' // everything parsed before the mirror goes
    if (m.isRestoring || !this.cuttable(m)) {
      if (reason === 'shutdown') return 'done' // the previous checkpoint and the ring still cover it
      this.retryCutLater()
      return 'wait'
    }
    // parking needs a checkpoint to wake from, even of a screen with no output yet
    if (this.dirtyBytes() > 0 || this.clearedAt !== null || (final && this.ckptSeq === null)) {
      const s = m.snapshot()
      const c: Checkpoint = { seq: s.seq, cols: s.cols, rows: s.rows, data: s.data, title: this.lastTitle }
      try {
        this.deps.checkpoints().write(this.meta.stateDir, this.ptyId, c)
        this.ckptSeq = s.seq
        this.ckptAt = this.deps.clock.now()
        this.clearedAt = null
        this.stats.checkpoints++
        this.deps.disk?.written()
      } catch (e) {
        this.deps.log.error('checkpoint not written', { ptyId: this.ptyId, error: (e as Error).message })
        this.deps.disk?.failed(e)
        // the ring still holds everything after the last checkpoint: a final one keeps the mirror, any other is
        // skipped and tried again later
        if (final) return 'done'
        return 'failed'
      }
    }
    if (final && this.ckptSeq !== null) this.park(reason)
    return 'done'
  }

  // ── holder events ─────────────────────────────────────────────────────────────────

  /**
   * A gap (free-run overwrote bytes ptyhost never received; the holder client found it): the mirror is rebuilt from
   * checkpoint + ring at `got` on the next flush. Renderers get a fresh snapshot because the next batch is not
   * contiguous with what they have.
   */
  private onGap(expected: number, got: number): void {
    this.stats.gaps++
    this.deps.log.warn('output gap', { ptyId: this.ptyId, expected, got })
    this.coalescer.reset(got) // pending bytes are in the ring: the rebuild parses them
    this.mirror?.dispose()
    this.mirror = null
  }

  private onOutput(seq: number, data: Uint8Array): void {
    this.deps.activity?.output(this)
    this.lastOutputAt = this.deps.clock.now()
    this.coalescer.push(seq, data)
  }

  /**
   * Where a rebuilt mirror must stop replaying the ring: what has been flushed, less the batch being forwarded right
   * now. A renderer that asks for a snapshot while that batch is forwarded (a gap) wakes the mirror; `onFlush` then
   * parses the batch itself, with replies on.
   */
  private get mirrorSeq(): number {
    return this.forwarding ?? this.coalescer.flushedSeq
  }

  private onFlush(seq: number, data: Uint8Array): void {
    this.forwarding = seq
    try {
      for (const a of this.attachments) a.live(seq, data) // forward first
    } finally {
      this.forwarding = null
    }
    const m = this.mirror ?? this.wake(seq) // a parked mirror wakes on its first new byte
    if (m.writtenSeq !== seq) {
      // the ring could not bring a rebuild up to `seq`: start empty here rather than parse out of order
      this.deps.log.warn('mirror restarted without history', { ptyId: this.ptyId, at: seq, had: m.writtenSeq })
      m.dispose()
      this.mirror = this.newMirror(seq)
    }
    this.mirror!.write(seq, data) // parse second
  }

  private onParsed(seq: number): void {
    this.conn.ack(seq) // acked once parsed, so a flooding child runs at the mirror's parse speed
    if (this.replayTo > 0 && seq >= this.replayTo) this.replayDone()
    if (this.waiters.size) this.serveSnapshots()
    this.deps.scheduler.poke(this)
  }

  private onExit(code: number, signal: number): void {
    this.coalescer.flushNow()
    this.markExited(code, signal)
    for (const a of this.attachments) a.exit(this.exitInfo!.code, this.exitInfo!.signal)
    this.deps.notify({ m: 'pty.exit', a: { ptyId: this.ptyId, sessionId: this.meta.sessionId, code: this.exitInfo!.code, signal: this.exitInfo!.signal, lost: false } })
    this.parkTimer?.dispose()
    this.parkTimer = null
    // A final checkpoint, then the mirror goes
    if (this.mirror) this.deps.scheduler.request(this, 'exit')
  }

  private markExited(code: number, signal: number): void {
    this.state = 'exited'
    this.exitInfo = signal ? { code: null, signal } : { code, signal: null }
  }

  /**
   * The connection closed. While the child runs, a close the holder made (it admitted another client in its place,
   * or the socket broke) is not taken for a crash: the holder is re-adopted at once if it is still there,
   * streaming resumes at the next byte expected (a gap rebuilds the mirror), and what is sent meanwhile waits. Only a
   * holder that is gone, cannot be reached, or closes on us again within L.holderReadoptIntervalMs is reported lost.
   */
  private onClose(reason: string): void {
    if (this.scope.isDisposed) return
    const theirs = reason === 'closed' || reason.startsWith('socket error')
    const now = this.deps.clock.now()
    if (this.state === 'running' && theirs && this.deps.readopt && now - this.readoptedAt >= L.holderReadoptIntervalMs) {
      this.readoptedAt = now
      this.held = { ops: [], bytes: 0, signals: new Set(), graceMs: null }
      this.coalescer.flushNow()
      this.deps.log.warn('holder connection closed; re-adopting', { ptyId: this.ptyId, reason })
      this.deps.readopt(this).then(
        ({ conn, hello }) => this.resume(conn, hello),
        (e: unknown) => {
          this.held = null
          this.lose(`${reason}; not re-adopted: ${(e as Error).message}`)
        },
      )
      return
    }
    this.lose(reason)
  }

  /** The holder answered again: attach from the next byte expected, apply the latest size, send what waited. */
  private resume(conn: HolderConnection, hello: HolderHello): void {
    const held = this.held
    this.held = null
    if (this.scope.isDisposed) {
      conn.destroy()
      return
    }
    this.conn = conn
    this.stats.readopts++
    this.deps.log.info('holder re-adopted', { ptyId: this.ptyId })
    this.listen(conn, this.coalescer.flushedSeq)
    if (hello.cols !== this.cols || hello.rows !== this.rows) conn.resize(this.cols, this.rows, this.pixel.xpx, this.pixel.ypx)
    for (const op of held?.ops ?? []) op()
  }

  private lose(reason: string): void {
    if (this.scope.isDisposed) return
    if (this.state === 'running') {
      this.state = 'lost'
      this.deps.log.warn('holder connection lost', { ptyId: this.ptyId, reason })
      this.deps.notify({ m: 'pty.exit', a: { ptyId: this.ptyId, sessionId: this.meta.sessionId, code: null, signal: null, lost: true } })
    }
    this.coalescer.flushNow()
    // the last screen of a lost or released PTY comes from its checkpoint and ring; a released one wrote its own at the
    // release
    if (!this.released && this.mirror && this.dirtyBytes() > 0) this.checkpoint('shutdown')
    for (const a of [...this.attachments]) a.gone(this.state === 'exited' ? 'exited' : 'lost')
    this.deps.removed(this)
    this.dispose()
  }

  // ── mirror lifecycle ──────────────────────────────────────────────────────────────

  private newMirror(startSeq: number, restore?: Checkpoint): Mirror {
    const m = new Mirror({
      cols: this.cols,
      rows: this.rows,
      scrollback: this.deps.scrollback(),
      colors: this.deps.colors(),
      startSeq,
      ...(restore ? { restore: { cols: restore.cols, rows: restore.rows, data: restore.data } } : {}),
      reply: (d) => this.send(d),
      parsed: (seq) => {
        if (m === this.mirror) this.onParsed(seq)
      },
      title: (t) => {
        if (m === this.mirror) this.onTitle(t)
      },
      bell: () => {
        if (m === this.mirror && this.replayTo === 0) this.deps.notify({ m: 'pty.bell', a: { ptyId: this.ptyId } })
      },
      notify: (text) => {
        if (m === this.mirror && this.replayTo === 0) this.deps.notify({ m: 'pty.oscNotify', a: { ptyId: this.ptyId, text } })
      },
      busy: () => this.watchStall(),
      now: () => this.deps.clock.now(),
    })
    if (this.pixel.xpx > 0) m.setPixelSize(this.pixel.xpx, this.pixel.ypx)
    return m
  }

  /**
   * The stored checkpoint, if the ring can bring it up to `upTo`: its seq at or after the ring's earliest byte and not
   * past `upTo`. Anything else (truncated, from another run, overtaken by the ring) is ignored (C-COR-2).
   */
  private usableCheckpoint(upTo: number): Checkpoint | null {
    const c = this.deps.checkpoints().read(this.meta.stateDir, this.ptyId)
    if (!c) return null
    const h = this.ring.header()
    const earliest = h ? h.earliestSeq : upTo
    return c.seq >= earliest && c.seq <= upTo ? c : null
  }

  /**
   * Rebuild the mirror up to `upTo` (the next byte it will be given): from the checkpoint if the ring still holds
   * everything after it, else from the ring's first line boundary. Nothing below `answeredTo` is answered
   * again.
   */
  private wake(upTo: number, answeredTo = upTo): Mirror {
    this.stats.wakes++
    const h = this.ring.header()
    const earliest = h ? h.earliestSeq : upTo
    const c = this.usableCheckpoint(upTo)
    let m: Mirror
    if (c) {
      m = this.newMirror(c.seq, c)
      this.ckptSeq = c.seq
      this.nudgeAfterReplay = false
      if (c.cols !== this.cols || c.rows !== this.rows) m.resize(this.cols, this.rows)
    } else {
      const from = h ? firstLineBoundary(this.ring, earliest, upTo) : upTo
      m = this.newMirror(from)
      this.ckptSeq = null
      this.nudgeAfterReplay = from < upTo
    }
    this.mirror = m
    this.ckptAt = this.deps.clock.now()
    // replay what the ring holds below `upTo`, with replies off until `answeredTo`
    for (let s = m.writtenSeq; s < upTo; ) {
      const d = this.ring.read(s, upTo, L.coalesceMaxBytes)
      if (!d || d.byteLength === 0) break
      m.write(s, d)
      s += d.byteLength
    }
    const replyFrom = Math.min(answeredTo, m.writtenSeq)
    if (replyFrom > m.parsedSeq) {
      this.replayTo = replyFrom
      m.setReplying(false)
    } else {
      // nothing to replay: rebuilt as soon as the checkpoint is written in
      this.replayTo = 0
      this.nudgeAfterReplay = false
      queueMicrotask(() => {
        if (this.mirror === m) this.deps.rebuilt?.(this)
      })
    }
    this.armPark()
    return m
  }

  private replayDone(): void {
    this.replayTo = 0
    this.mirror?.setReplying(true)
    if (this.nudgeAfterReplay) {
      this.nudgeAfterReplay = false
      if (this.mirror?.altScreen && this.state === 'running') this.nudgeRepaint()
    }
    this.deps.rebuilt?.(this)
  }

  /** A full-screen app redraws on SIGWINCH: resize to rows − 1 and back L.repaintNudgeMs later. */
  private nudgeRepaint(): void {
    if (this.rows <= L.ptyMinRows || this.held) return
    this.stats.nudges++
    this.conn.resize(this.cols, this.rows - 1, this.pixel.xpx, this.pixel.ypx)
    this.scope.timeout(() => {
      // while the holder is re-adopted, `resume` restores the size: its HELLO reports it one row short
      if (!this.held) this.conn.resize(this.cols, this.rows, this.pixel.xpx, this.pixel.ypx)
    }, L.repaintNudgeMs)
  }

  private parkable(): boolean {
    return this.state === 'running' && this.attachments.size === 0 && this.deps.clock.now() - this.lastOutputAt >= L.mirrorParkIdleMs && this.replayTo === 0
  }

  /** Arm the park check while nothing is attached. */
  private armPark(): void {
    if (this.parkTimer || this.attachments.size > 0 || this.state !== 'running' || !this.mirror || this.isDisposed) return
    const wait = Math.max(0, this.lastOutputAt + L.mirrorParkIdleMs - this.deps.clock.now())
    this.parkTimer = this.scope.timeout(() => {
      this.parkTimer = null
      if (!this.mirror) return
      if (this.parkable()) this.deps.scheduler.request(this, 'park')
      else this.armPark()
    }, wait)
  }

  private park(reason: CheckpointReason): void {
    const m = this.mirror
    if (!m) return
    m.dispose()
    this.mirror = null
    this.cutRetry?.dispose()
    this.cutRetry = null
    if (reason === 'park') this.stats.parks++
  }

  /** A checkpoint or snapshot may be cut at `parsedSeq`. */
  private cuttable(m: Mirror): boolean {
    if (!m.parserIdle) return false
    if (m.atGround) {
      this.cutBlockedSince = null
      this.cutRetry?.dispose() // a retry left from an earlier wait would cut short the next block's wait
      this.cutRetry = null
      return true
    }
    const now = this.deps.clock.now()
    this.cutBlockedSince ??= now
    return now - this.cutBlockedSince >= L.snapshotSyncWaitMs
  }

  /** A DEC 2026 block may stay open with no more output: try again once its wait has passed. */
  private retryCutLater(): void {
    if (this.cutRetry) return
    this.cutRetry = this.scope.timeout(() => {
      this.cutRetry = null
      this.deps.scheduler.poke(this)
    }, L.snapshotSyncWaitMs)
  }

  private onTitle(t: string): void {
    const title = t.slice(0, L.oscTextMaxChars)
    if (title === this.lastTitle) return
    this.lastTitle = title
    for (const a of this.attachments) a.title(title)
    this.deps.notify({ m: 'pty.title', a: { ptyId: this.ptyId, title } })
  }

  /**
   * Hand out snapshots once the mirror may be cut: its parser idle and no DEC 2026 block open — a block
   * still open after L.snapshotSyncWaitMs no longer delays it.
   */
  private serveSnapshots(): void {
    if (this.waiters.size === 0) return
    const m = this.mirror
    if (m?.isRestoring) {
      // Writing a checkpoint in parses no seq, so no `parsed` callback follows it: with no output after the checkpoint
      // (an idle terminal woken by setVisible), nothing else would serve these waiters (U-PTY-57).
      if (!this.restoreWaits.has(m)) {
        this.restoreWaits.add(m)
        void m.whenRestored().then(() => {
          if (m === this.mirror && !this.isDisposed) this.serveSnapshots()
        })
      }
      return
    }
    if (!m || !m.parserIdle || this.replayTo > 0) return
    const now = this.deps.clock.now()
    const ready = m.atGround ? [...this.waiters] : [...this.waiters].filter((w) => now - w.since >= L.snapshotSyncWaitMs)
    if (ready.length === 0) {
      if (!this.syncTimer) {
        this.syncTimer = this.scope.timeout(() => {
          this.syncTimer = null
          this.serveSnapshots()
        }, L.snapshotSyncWaitMs)
      }
      return
    }
    const s = m.snapshot()
    const snap: StreamSnapshot = { ...s, exited: this.exitInfo, title: this.lastTitle }
    for (const w of ready) {
      this.waiters.delete(w)
      w.cb(snap)
    }
  }

  private applySize(): void {
    const s = this.pendingSize
    this.pendingSize = null
    if (!s) return
    this.pixel = { xpx: s.xpx, ypx: s.ypx }
    this.mirror?.setPixelSize(s.xpx, s.ypx)
    if (s.cols === this.cols && s.rows === this.rows) return
    this.cols = s.cols
    this.rows = s.rows
    if (!this.held) this.conn.resize(s.cols, s.rows, s.xpx, s.ypx) // else `resume` applies the latest size
    this.mirror?.resize(s.cols, s.rows)
  }

  /**
   * A mirror whose write callback has not fired for L.mirrorStallMs while data is pending is rebuilt from
   * checkpoint + ring. One timer per PTY, armed only while its mirror is busy, due exactly when it would count as
   * stalled (a mirror created in this very call is not `this.mirror` yet: it became busy now, so the full time).
   */
  private watchStall(): void {
    if (this.stallTimer || this.isDisposed) return
    const now = this.deps.clock.now()
    const at = this.mirror?.stallAt ?? now + L.mirrorStallMs
    this.stallTimer = this.scope.timeout(() => {
      this.stallTimer = null
      const m = this.mirror
      if (!m) return
      if (m.stalled()) this.rebuildMirror('stalled')
      else if (m.stallAt !== null) this.watchStall()
    }, Math.max(0, at - now))
  }
}

/** Where a rebuild without a checkpoint starts: the first byte after a newline at or after `earliest`. */
export function firstLineBoundary(ring: RingFile, earliest: number, latest: number): number {
  if (earliest === 0) return 0
  const head = ring.read(earliest, latest, L.coalesceMaxBytes)
  if (!head) return earliest
  const nl = head.indexOf(0x0a)
  return nl < 0 ? earliest : earliest + nl + 1
}
