// PtyManager: every PTY ptyhost knows, the control API core calls (`ptyhostApi`), and the stream ports renderers attach
// with. Independent of Electron, so tests drive it with in-memory channels.

import fs from 'node:fs'
import path from 'node:path'
import { ensurePrivateDir, isOwnSocket, registerSingletonGauge, resources, runDir, socketPath, systemClock, type Clock, type Logger } from '@kea/kit'
import { DEFAULT_TERMINAL_SETTINGS, isStreamToPtyhost, L, PTY_ID_RE, ptyhostApi, type Channel, type Handlers, type HolderHello, type MirrorConfig, type PtyhostNote, type PtyInfo, type PtyKind, type SpawnSpec, type StreamToPtyhost } from '@kea/protocol'
import { colorThemeOf, type ColorTheme } from '@kea/terminal'
import { coldScreen } from './checkpoint/cold.ts'
import { CheckpointScheduler } from './checkpoint/scheduler.ts'
import { DiskFullBanner } from './checkpoint/diskFull.ts'
import { diskCheckpoints, MemoryCheckpoints, type CheckpointStore } from './checkpoint/store.ts'
import { HolderBackend, type BackendDeps } from './backend/backend.ts'
import { HolderConnectError, HolderConnection } from './holder/connection.ts'
import { clientRequirement } from './holder/launch.ts'
import type { ClientOption } from './os/index.ts'
import { ActivityNotes } from './activity.ts'
import { Pty, type PtyMeta } from './pty.ts'
import { RingFile } from './stream/ring.ts'

export interface PtyhostConfig {
  home: string
  /** The helper binary shipped with this build (copied to `<home>/bin/current/` before use). */
  helperSource: string
  keaVersion: string
  dev: boolean
  /** Whom holders admit; default: derived from this process's own executable (`clientRequirement`). */
  client?: ClientOption
  /** False when holders may not detach on this machine, so they run non-detached. Default true. */
  detach?: boolean
}

export interface ManagerDeps {
  clock?: Clock
  log: Logger
  notify(note: PtyhostNote): void
  /**
   * A note that is only worth something live (tier 3's activity notes): sent while core is connected, dropped while it
   * is away, never queued. Default: `notify`.
   */
  notifyLive?(note: PtyhostNote): void
  /** Test seams for the two ways a holder is launched. */
  launchDetached?: BackendDeps['launchDetached']
  launchHeld?: BackendDeps['launchHeld']
  /**
   * Test seam: where checkpoints go while "Keep scrollback on disk" is on (default: the disk; a test passes one that
   * refuses writes, as a full disk does).
   */
  checkpoints?: CheckpointStore
}

export interface SpawnArgs {
  ptyId: string
  sessionId: string
  kind: PtyKind
  spec: SpawnSpec
  cols: number
  rows: number
  ringBytes: number
  keaVersion: string
}

/** Every PtyManager not yet disposed in this process (one in the app; tests may run several), for the report's rows. */
const managers = new Set<PtyManager>() // bounded: one per live PtyManager
let gaugesRegistered = false

/**
 * Ptyhost's resource-report rows that are not counted where they are created: read from every live manager
 * when the report is taken, so `resources.report()` — the leak suite's and "Copy diagnostics"' view — holds them too.
 */
function registerGauges(): void {
  if (gaugesRegistered) return
  gaugesRegistered = true
  const row = <K extends keyof ReportRows>(k: K) => (): number | Record<string, number> => {
    const none = NO_ROWS[k]
    if (typeof none === 'number') {
      let n = 0
      for (const m of managers) n += m.reportRows()[k] as number
      return n
    }
    const out: Record<string, number> = { ...none }
    for (const m of managers) for (const [n, v] of Object.entries(m.reportRows()[k] as Record<string, number>)) out[n] = (out[n] ?? 0) + v
    return out
  }
  for (const k of Object.keys(NO_ROWS) as (keyof ReportRows)[]) registerSingletonGauge(`ptyhost.${k}`, row(k))
}

/** The rows of `PtyManager.reportRows`, every count 0 (the report keeps its shape with no manager). */
const NO_ROWS = {
  ptys: { awake: 0, parked: 0 },
  connections: { windows: 0, streams: 0 },
  creditWindows: { windows: 0, outstandingBytes: 0 },
  ptyQueues: { coalescerBytes: 0, snapshotWaiters: 0, holderWriteBytes: 0 },
  ptyTimers: 0,
  pendingRebuilds: { queued: 0, running: 0 },
  checkpoints: { watched: 0, pending: 0, timer: 0, inMemory: 0, inMemoryChars: 0 },
  activity: { ptys: 0, timers: 0 },
} as const
type ReportRows = { [K in keyof typeof NO_ROWS]: (typeof NO_ROWS)[K] extends number ? number : { [N in keyof (typeof NO_ROWS)[K]]: number } }

/** The holder's state file; only the fields ptyhost reads. */
type HolderJson = { ptyId?: string; sessionId?: string; socket?: string; kind?: PtyKind; cwd?: string; argv?: string[]; pid?: number; pidStartTime?: number; exited?: boolean }

export class PtyManager {
  private readonly cfg: PtyhostConfig
  private readonly deps: ManagerDeps
  private readonly clock: Clock
  private readonly ptys = new Map<string, Pty>() // bounded: one per live holder (the session count)
  private readonly spawning = new Set<string>() // bounded: ptyIds being launched
  private colors: ColorTheme = colorThemeOf(DEFAULT_TERMINAL_SETTINGS.theme)
  private scrollback = DEFAULT_TERMINAL_SETTINGS.scrollback
  private visible: string[] = [] // bounded: the visible terminals core last reported (≤ live PTYs)
  /** Detached holders, the non-detached fallback, or no terminals. */
  readonly backend: HolderBackend
  private req: Promise<ClientOption> | null = null
  private disposed = false
  /**
   * The startup adoption. Ptyhost says it is ready before its holders are adopted, so whatever names a PTY meanwhile —
   * `pty.list`, a renderer's stream, a call for one PTY — is answered after it, never with "gone".
   */
  private adopting: Promise<unknown> = Promise.resolve()
  private adoptionsRunning = 0
  readonly scheduler: CheckpointScheduler
  /** Checkpoints on disk, or a test's stand-in. */
  private readonly disk: CheckpointStore
  /** Raised by a checkpoint the full disk refuses, cleared by the next one written. */
  private readonly diskFull: DiskFullBanner
  private checkpoints: CheckpointStore
  /** Adopted PTYs still to rebuild in idle time, one at a time. */
  private readonly rebuildQueue: string[] = [] // bounded: ≤ live PTYs
  private rebuilding: Pty | null = null
  /**
   * Each window's renderer connection scope: its stream ports, by main's `connId`. Main's `disconnect` closes
   * them all; a scope whose last stream closed goes with it.
   */
  private readonly connections = new Map<number, Set<Channel>>() // bounded: one per window with a stream open; each set ≤ one port per terminal attached there
  /** Each PTY's activity notes for tier 3 (`activity.ts`). */
  private readonly activity = new Map<string, ActivityNotes>() // bounded: one per live PTY

  constructor(cfg: PtyhostConfig, deps: ManagerDeps) {
    this.cfg = cfg
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    this.disk = deps.checkpoints ?? diskCheckpoints
    this.checkpoints = this.disk
    this.diskFull = new DiskFullBanner((n) => deps.notify(n))
    managers.add(this)
    registerGauges()
    this.scheduler = new CheckpointScheduler(this.clock)
    this.backend = new HolderBackend(
      { home: cfg.home, helperSource: cfg.helperSource, keaVersion: cfg.keaVersion, dev: cfg.dev, detach: cfg.detach ?? true },
      {
        log: deps.log,
        notify: (n) => deps.notify(n),
        ...(deps.launchDetached ? { launchDetached: deps.launchDetached } : {}),
        ...(deps.launchHeld ? { launchHeld: deps.launchHeld } : {}),
      },
    )
  }

  get runDir(): string {
    return runDir(this.cfg.home)
  }

  get size(): number {
    return this.ptys.size
  }

  get(ptyId: string): Pty | undefined {
    return this.ptys.get(ptyId)
  }

  list(): PtyInfo[] {
    return [...this.ptys.values()].map((p) => p.info())
  }

  configure(c: MirrorConfig): void {
    this.colors = { foreground: c.foreground, background: c.background, cursor: c.cursor, palette: c.palette }
    this.scrollback = c.scrollback
    // "Keep scrollback on disk" off: checkpoints live in memory and those on disk are removed; on again: they are
    // written back. Either way each live PTY keeps its checkpoint, so a parked one still wakes from it.
    const next = c.diskBackedScrollback ? this.disk : this.checkpoints === this.disk ? new MemoryCheckpoints() : this.checkpoints
    if (next !== this.checkpoints) {
      for (const p of this.ptys.values()) {
        const ckpt = this.checkpoints.read(p.meta.stateDir, p.ptyId)
        try {
          if (ckpt) next.write(p.meta.stateDir, p.ptyId, ckpt)
        } catch (e) {
          this.deps.log.warn('checkpoint not moved', { ptyId: p.ptyId, error: (e as Error).message })
        }
        this.checkpoints.remove(p.meta.stateDir, p.ptyId)
      }
      this.checkpoints = next
    }
    for (const p of this.ptys.values()) p.setColors(this.colors)
  }

  /** The visible terminals are rebuilt first and their keystrokes hold checkpoints back. */
  setVisible(ptyIds: string[]): void {
    this.visible = ptyIds
    for (const id of ptyIds) this.ptys.get(id)?.ensureAwake()
  }

  /**
   * Launch a holder and attach to it (non-detached when it cannot detach). The PTY's first output is answered as it
   * arrives.
   */
  async spawn(a: SpawnArgs): Promise<{ holderPid: number; childPid: number; detached: boolean }> {
    if (this.ptys.has(a.ptyId) || this.spawning.has(a.ptyId)) throw new Error(`pty ${a.ptyId} exists`)
    if (this.disposed) throw new Error('ptyhost is shutting down')
    this.spawning.add(a.ptyId)
    try {
      const stateDir = path.join(this.cfg.home, 'sessions', a.sessionId)
      const sock = socketPath(this.runDir, a.ptyId)
      const client = await this.client()
      const { pid, childPid, detached } = await this.backend.launch({
        ptyId: a.ptyId,
        sessionId: a.sessionId,
        kind: a.kind,
        stateDir,
        sock,
        cols: Math.max(L.ptyMinCols, a.cols),
        rows: Math.max(L.ptyMinRows, a.rows),
        client,
        ringBytes: a.ringBytes,
        keaVersion: a.keaVersion,
        spec: a.spec,
      })
      let opened: Awaited<ReturnType<typeof HolderConnection.open>>
      try {
        opened = await HolderConnection.open(sock)
      } catch (e) {
        this.backend.release(a.ptyId) // a non-detached holder nobody can attach ends now
        throw e
      }
      const { conn, hello } = opened
      if (this.disposed) {
        conn.destroy()
        this.backend.release(a.ptyId)
        throw new Error('ptyhost is shutting down')
      }
      const meta: PtyMeta = { ptyId: a.ptyId, sessionId: a.sessionId, kind: a.kind, stateDir, sock, cwd: a.spec.cwd, argv: [a.spec.file, ...a.spec.args], holderPid: pid, holderStartedAt: Date.now(), detached }
      this.add(new Pty(meta, conn, hello, this.ptyDeps(), { mode: 'live', fromSeq: hello.earliestSeq }))
      return { holderPid: pid, childPid, detached }
    } finally {
      this.spawning.delete(a.ptyId)
    }
  }

  /**
   * Reconnect to every holder socket in the run dir (after a ptyhost restart or relaunch). Each PTY starts
   * parked; the visible ones are rebuilt at once, the rest one at a time in idle time, and any PTY that produces output
   * wakes itself. Replies to replayed queries are dropped.
   */
  adoptAll(): Promise<{ adopted: string[]; failed: string[] }> {
    const run = this.adoptEach()
    this.adoptionsRunning++
    const done = run.catch(() => undefined).finally(() => this.adoptionsRunning--)
    this.adopting = Promise.all([this.adopting, done])
    return run
  }

  /** `fn` with the PTY: now, or — while an adoption is still connecting — once it has finished. */
  private withPty<R>(ptyId: string, fn: (p: Pty | undefined) => R): R | Promise<Awaited<R>> {
    const p = this.ptys.get(ptyId)
    if (p || this.adoptionsRunning === 0) return fn(p)
    return this.adopting.then(() => fn(this.ptys.get(ptyId)) as Awaited<R>)
  }

  private async adoptEach(): Promise<{ adopted: string[]; failed: string[] }> {
    const adopted: string[] = []
    const failed: string[] = []
    let names: string[] = []
    try {
      ensurePrivateDir(this.runDir)
      names = fs.readdirSync(this.runDir).filter((n) => n.endsWith('.sock') && PTY_ID_RE.test(n.slice(0, -'.sock'.length)))
    } catch (e) {
      this.deps.log.error('run directory refused; no holders adopted', { dir: this.runDir, error: (e as Error).message })
      return { adopted, failed }
    }
    // the visible terminals first, then the rest one at a time
    const order = names.map((n) => n.slice(0, -5)).sort((x, y) => Number(this.visible.includes(y)) - Number(this.visible.includes(x)))
    for (const id of order) {
      if (this.disposed) break
      if (this.ptys.has(id) || this.spawning.has(id)) continue
      try {
        await this.adopt(id)
        adopted.push(id)
      } catch (e) {
        failed.push(id)
        this.deps.log.warn('holder not adopted', { ptyId: id, error: (e as Error).message })
      }
    }
    return { adopted, failed }
  }

  /**
   * Connect to one holder and take it over, parked. A holder whose state file is ambiguous or disagrees with
   * where it lives, or whose HELLO names another PTY, is refused and left alone: never signalled or released.
   * A socket with no state file that refuses the connection is stale and is removed (C-COR-8).
   */
  async adopt(ptyId: string): Promise<Pty> {
    const sock = socketPath(this.runDir, ptyId)
    // A symlink or someone else's socket in the run directory is never followed.
    const before = ownSocketStat(sock)
    if (!before) throw new Error(`${ptyId}.sock is not a socket owned by this user`)
    const found = this.findStateDir(ptyId)
    if (found) {
      const { stateDir, json } = found
      const wrong =
        json.ptyId !== ptyId ? `its state file names PTY ${String(json.ptyId)}` : json.sessionId !== path.basename(stateDir) ? `its state file names session ${String(json.sessionId)}, not its directory` : json.socket !== sock ? `its state file names socket ${String(json.socket)}` : null
      if (wrong) throw new Error(`holder ${ptyId} refused: ${wrong}`)
    }
    let opened: Awaited<ReturnType<typeof HolderConnection.open>>
    try {
      opened = await HolderConnection.open(sock)
    } catch (e) {
      if (!found && e instanceof HolderConnectError && e.code === 'ECONNREFUSED') this.removeStaleSocket(sock, before)
      throw e
    }
    const { conn, hello } = opened
    if (!found) {
      conn.destroy() // a live holder nothing identifies: left alone
      throw new Error(`no state file for ${ptyId}`)
    }
    if (hello.ptyId !== ptyId) {
      conn.destroy()
      throw new Error(`holder ${ptyId} refused: its HELLO names PTY ${hello.ptyId}`)
    }
    if (this.disposed || this.ptys.has(ptyId)) {
      conn.destroy()
      throw new Error(`pty ${ptyId} already adopted`)
    }
    const { stateDir, json } = found
    const meta: PtyMeta = {
      ptyId,
      sessionId: path.basename(stateDir),
      kind: json.kind ?? 'shell',
      stateDir,
      sock,
      cwd: json.cwd ?? '/',
      argv: json.argv ?? [],
      holderPid: json.pid ?? null,
      holderStartedAt: json.pidStartTime ? Math.floor(json.pidStartTime / 1000) : null,
      // a non-detached holder ends with the ptyhost that started it: a survivor is a detached one
      detached: true,
    }
    const p = new Pty(meta, conn, hello, this.ptyDeps(), { mode: 'parked' })
    this.add(p)
    if (this.visible.includes(ptyId)) p.ensureAwake()
    else if (!hello.exited && p.checkpointSeq !== hello.latestSeq) this.queueRebuild(p)
    return p
  }

  private queueRebuild(p: Pty): void {
    this.rebuildQueue.push(p.ptyId)
    this.nextRebuild()
  }

  /** One idle-time rebuild at a time; a PTY woken some other way meanwhile is skipped. */
  private nextRebuild(): void {
    if (this.disposed || (this.rebuilding && !this.rebuilding.isDisposed && this.rebuilding.isReplaying)) return
    this.rebuilding = null
    while (this.rebuildQueue.length) {
      const p = this.ptys.get(this.rebuildQueue.shift()!)
      if (!p || !p.isParked || !p.isRunning) continue
      this.rebuilding = p
      p.ensureAwake()
      if (p.isReplaying) return
      this.rebuilding = null
    }
  }

  /**
   * An exception escaped from inside xterm: rebuild the mirrors it can have come from — those with unparsed writes.
   * Returns how many; 0 means it was not a mirror's.
   */
  recoverFromException(e: unknown): number {
    const suspects = [...this.ptys.values()].filter((p) => p.pendingWrites > 0)
    for (const p of suspects) p.rebuildMirror(`exception: ${e instanceof Error ? e.message : String(e)}`)
    return suspects.length
  }

  /** Graceful shutdown: every dirty mirror is checkpointed first. */
  shutdown(): void {
    if (this.disposed) return
    this.scheduler.flushAll()
    this.dispose()
  }

  /**
   * A renderer's stream port for one terminal (brokered by main). While the startup adoption is still connecting, the
   * port waits for it (what the renderer sends meanwhile is kept, `holdStream`): after a ptyhost restart the window
   * re-attaches before its PTYs are adopted.
   */
  attachStream(ptyId: string, ch: Channel, connId?: number): void {
    if (connId !== undefined) this.track(connId, ch)
    const p = this.ptys.get(ptyId)
    if (p) return void p.attach(ch)
    if (this.adoptionsRunning === 0 || this.disposed) return gone(ch)
    const held = holdStream(ch)
    void this.adopting.then(() => {
      const q = this.ptys.get(ptyId)
      if (q && !q.isDisposed && !this.disposed) q.attach(held)
      else gone(held)
    })
  }

  /** Main's `disconnect`: window `connId` reloaded, crashed or closed, so every stream port of it is closed. */
  disconnect(connId: number): void {
    const streams = this.connections.get(connId)
    if (!streams) return
    this.connections.delete(connId)
    for (const ch of [...streams]) ch.close()
  }

  private track(connId: number, ch: Channel): void {
    let streams = this.connections.get(connId)
    if (!streams) this.connections.set(connId, (streams = new Set()))
    streams.add(ch)
    const scope = streams
    ch.onClose(() => {
      scope.delete(ch)
      if (scope.size === 0 && this.connections.get(connId) === scope) this.connections.delete(connId)
    })
  }

  handlers(): Handlers<typeof ptyhostApi> {
    const need = (id: string, p: Pty | undefined): Pty => {
      if (!p) throw new Error(`no pty ${id}`)
      return p
    }
    /** A call for one PTY, after any adoption still connecting (`withPty`). */
    const on = <R>(id: string, fn: (p: Pty) => R) => this.withPty(id, (p) => fn(need(id, p)))
    return {
      'pty.spawn': (a) => this.spawn(a),
      'pty.list': async () => {
        await this.adopting
        return this.list()
      },
      'pty.terminate': ({ ptyId, graceMs }) => on(ptyId, (p) => (p.terminate(graceMs), { ok: true })),
      'pty.signal': ({ ptyId, signo, target }) => on(ptyId, (p) => (p.signal(signo, target), { ok: true })),
      'pty.stat': ({ ptyId }) => on(ptyId, (p) => p.stat()),
      'pty.release': ({ ptyId }) => on(ptyId, (p) => ({ ok: p.release() })),
      'pty.detach': ({ ptyId }) =>
        this.withPty(ptyId, (p) => {
          if (!p) return { ok: false }
          p.detachHolder()
          return { ok: true }
        }),
      'pty.input': ({ ptyId, data }) => on(ptyId, (p) => (p.input(data), { ok: true })),
      'pty.resize': ({ ptyId, cols, rows }) => on(ptyId, (p) => (p.resize(cols, rows), { ok: true })),
      'pty.setVisible': ({ ptyIds }) => {
        this.setVisible(ptyIds)
        return { ok: true }
      },
      'pty.configure': (c) => {
        this.configure(c)
        return { ok: true }
      },
      'pty.capture': ({ ptyId, ringBytes, screen: wantScreen }) =>
        this.withPty(ptyId, async (p) => {
          if (!p) return null
          // everything received is parsed first (a script's last line); an exited PTY whose mirror has gone is read
          // from checkpoint + ring. `screen: false` reads the ring only (no cold render of a parked mirror each
          // time a dev server prints)
          const { cols, rows } = p.grid
          const screen =
            wantScreen === false
              ? ''
              : ((await p.settledScreenText()) ??
                (await coldScreen({ stateDir: p.meta.stateDir, ptyId, store: this.checkpoints, colors: this.colors, cols, rows, scrollback: this.scrollback, now: () => this.clock.now(), log: this.deps.log }))?.text ??
                '')
          const ring = new RingFile(`${p.meta.stateDir}/${ptyId}.ring`)
          try {
            const h = ring.header()
            const from = h ? Math.max(h.earliestSeq, h.latestSeq - ringBytes) : 0
            return { screen, ring: (h && ring.read(from, h.latestSeq, ringBytes)) || new Uint8Array(0), end: h?.latestSeq ?? 0 }
          } finally {
            ring.close()
          }
        }),
      'pty.lastScreen': ({ ptyId, sessionId, cols, rows }) =>
        this.withPty(ptyId, (p) => {
          const stateDir = p?.meta.stateDir ?? path.join(this.cfg.home, 'sessions', sessionId)
          if (p && !p.isParked) return null // a live mirror: attach a stream instead
          return coldScreen({ stateDir, ptyId, store: this.checkpoints, colors: this.colors, cols, rows, scrollback: this.scrollback, now: () => this.clock.now(), log: this.deps.log })
        }),
      // An archived session keeps only its checkpoints, so an ended PTY's last screen becomes its checkpoint at the
      // ring's latest seq before core removes the ring
      'pty.foldCheckpoint': ({ ptyId, sessionId }) =>
        this.withPty(ptyId, async (p) => {
          // still running: its own checkpoints follow it; in-memory ones die with ptyhost. An exited PTY whose release is
          // under way is folded as one already gone: its exit checkpoint and its ring hold the same last screen
          if (p?.isRunning || this.checkpoints instanceof MemoryCheckpoints) return { written: false }
          const stateDir = p?.meta.stateDir ?? path.join(this.cfg.home, 'sessions', sessionId)
          const s = await coldScreen({ stateDir, ptyId, store: this.checkpoints, colors: this.colors, cols: L.ptyDefaultCols, rows: L.ptyDefaultRows, scrollback: this.scrollback, now: () => this.clock.now(), log: this.deps.log })
          if (!s) return { written: false }
          const old = this.checkpoints.read(stateDir, ptyId)
          if (!old || old.seq !== s.seq) this.checkpoints.write(stateDir, ptyId, { seq: s.seq, cols: s.cols, rows: s.rows, data: s.data, title: old?.title ?? null })
          return { written: true }
        }),
      'pty.clear': ({ ptyId }) => on(ptyId, (p) => ({ ok: p.clear() })),
      // the very report main asks for on parentPort and logs, so a debug call and the leak suite see one view
      'debug.resources': () => resources.report(),
    }
  }

  /**
   * Ptyhost's resource-report rows kept here rather than in a counter: live PTYs by mirror state (an exited
   * PTY has none either), renderer connections, credit windows (one per attached renderer stream), per-PTY queues,
   * per-PTY timers, pending rebuilds, and the checkpoint scheduler with the checkpoints kept in memory when "Keep
   * scrollback on disk" is off.
   */
  reportRows(): ReportRows {
    const all = [...this.ptys.values()]
    const sum = (k: keyof Pty['resourceCounts']) => all.reduce((n, p) => n + p.resourceCounts[k], 0)
    const parked = all.filter((p) => p.isParked).length
    let streams = 0
    for (const s of this.connections.values()) streams += s.size
    const mem = this.checkpoints instanceof MemoryCheckpoints ? this.checkpoints : null
    return {
      ptys: { awake: all.length - parked, parked },
      connections: { windows: this.connections.size, streams },
      creditWindows: { windows: all.reduce((n, p) => n + p.attachedCount, 0), outstandingBytes: sum('creditOutstanding') },
      ptyQueues: { coalescerBytes: sum('coalescerBytes'), snapshotWaiters: sum('snapshotWaiters'), holderWriteBytes: sum('holderWriteBytes') },
      ptyTimers: sum('timers'),
      pendingRebuilds: { queued: this.rebuildQueue.length, running: this.rebuilding && !this.rebuilding.isDisposed && this.rebuilding.isReplaying ? 1 : 0 },
      checkpoints: { watched: this.scheduler.size, pending: this.scheduler.pending, timer: this.scheduler.armed ? 1 : 0, inMemory: mem?.size ?? 0, inMemoryChars: mem?.chars ?? 0 },
      activity: { ptys: this.activity.size, timers: [...this.activity.values()].filter((a) => a.armed).length },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    managers.delete(this)
    for (const p of [...this.ptys.values()]) p.dispose()
    this.ptys.clear()
    for (const a of this.activity.values()) a.dispose()
    this.activity.clear()
    for (const streams of [...this.connections.values()]) for (const ch of [...streams]) ch.close()
    this.connections.clear()
    this.rebuildQueue.length = 0
    this.scheduler.dispose()
    this.backend.dispose()
  }

  // ── internals ─────────────────────────────────────────────────────────────────────

  private add(p: Pty): void {
    this.ptys.set(p.ptyId, p)
  }

  private ptyDeps() {
    return {
      clock: this.clock,
      log: this.deps.log,
      notify: (n: PtyhostNote) => this.deps.notify(n),
      colors: () => this.colors,
      scrollback: () => this.scrollback,
      checkpoints: () => this.checkpoints,
      scheduler: this.scheduler,
      removed: (p: Pty) => {
        if (this.ptys.get(p.ptyId) === p) this.ptys.delete(p.ptyId)
        this.activity.get(p.ptyId)?.dispose()
        this.activity.delete(p.ptyId)
        if (!p.meta.detached) this.backend.release(p.ptyId) // nobody else can own it
        if (this.checkpoints instanceof MemoryCheckpoints) this.checkpoints.remove(p.meta.stateDir, p.ptyId)
        if (this.rebuilding === p) this.nextRebuild()
      },
      rebuilt: (p: Pty) => {
        if (this.rebuilding === p) {
          this.rebuilding = null
          this.nextRebuild()
        }
      },
      readopt: (p: Pty) => this.readopt(p),
      disk: this.diskFull,
      activity: {
        output: (p: Pty) => this.activityOf(p)?.output(),
        input: (p: Pty, data: string | Uint8Array) => this.activityOf(p)?.input(data),
      },
    }
  }

  /** The PTY's activity notes (made on its first output or input), or none for a PTY this manager no longer has. */
  private activityOf(p: Pty): ActivityNotes | null {
    if (this.disposed || this.ptys.get(p.ptyId) !== p) return null
    let a = this.activity.get(p.ptyId)
    if (!a) this.activity.set(p.ptyId, (a = new ActivityNotes(p.ptyId, { clock: this.clock, notify: (n) => (this.deps.notifyLive ?? this.deps.notify)(n) })))
    return a
  }

  /**
   * Reach a PTY's holder again after it closed ptyhost's connection while its child ran, with an adoption's checks: its
   * pid still runs, its socket is this user's and no symlink, and its HELLO names this PTY. Rejects when it is gone or
   * does not answer within L.holderConnectTimeoutMs; the PTY is then lost.
   */
  private async readopt(p: Pty): Promise<{ conn: HolderConnection; hello: HolderHello }> {
    if (this.disposed) throw new Error('ptyhost is shutting down')
    if (p.meta.holderPid !== null && !pidRuns(p.meta.holderPid)) throw new Error(`holder process ${p.meta.holderPid} is gone`)
    if (!ownSocketStat(p.meta.sock)) throw new Error(`${p.ptyId}.sock is not a socket owned by this user`)
    const opened = await HolderConnection.open(p.meta.sock)
    const wrong = opened.hello.ptyId !== p.ptyId ? `its HELLO names PTY ${opened.hello.ptyId}` : this.disposed || this.ptys.get(p.ptyId) !== p ? 'the PTY is gone' : null
    if (wrong) {
      opened.conn.destroy()
      throw new Error(`holder ${p.ptyId} not re-adopted: ${wrong}`)
    }
    return opened
  }

  private client(): Promise<ClientOption> {
    if (this.cfg.client) return Promise.resolve(this.cfg.client)
    this.req ??= clientRequirement().catch((e: unknown) => {
      this.req = null
      throw e
    })
    return this.req
  }

  /** The one session directory holding `<ptyId>.json`; null when none does; throws when several do (ambiguous). */
  private findStateDir(ptyId: string): { stateDir: string; json: HolderJson } | null {
    const root = path.join(this.cfg.home, 'sessions')
    let dirs: string[] = []
    try {
      dirs = fs.readdirSync(root)
    } catch {
      return null
    }
    const found: { stateDir: string; json: HolderJson }[] = [] // bounded: one per session directory (the session count)
    for (const d of dirs) {
      const file = path.join(root, d, `${ptyId}.json`)
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue // not this session
      }
      let json: HolderJson = {}
      try {
        json = JSON.parse(text) as HolderJson
      } catch {
        // unreadable: still a claim to this PTY, so it counts against ambiguity, and it matches nothing
      }
      found.push({ stateDir: path.join(root, d), json })
    }
    if (found.length > 1) throw new Error(`holder ${ptyId} refused: ${found.length} session directories hold ${ptyId}.json`)
    return found[0] ?? null
  }

  /** C-COR-8: unlink a socket nothing listens on, only if it is still the same socket of ours that was refused. */
  private removeStaleSocket(sock: string, before: fs.Stats): void {
    const now = ownSocketStat(sock)
    if (!now || now.ino !== before.ino || now.dev !== before.dev) return
    try {
      fs.unlinkSync(sock)
      this.deps.log.info('stale holder socket removed', { sock })
    } catch (e) {
      this.deps.log.warn('stale holder socket not removed', { sock, error: (e as Error).message })
    }
  }
}

function gone(ch: Channel): void {
  ch.send({ k: 'gone', reason: 'no such terminal' })
  ch.close()
}

/** Bytes of one input message from a renderer. */
function inputBytes(m: Extract<StreamToPtyhost, { k: 'in' | 'inb' }>): number {
  return typeof m.d === 'string' ? Buffer.byteLength(m.d) : m.d.byteLength
}

/**
 * A stream port whose PTY is still being adopted: what the renderer sends meanwhile is kept, in order, and
 * handed to the port's first subscriber (the attachment that takes it over), so a resize or keys typed during a
 * ptyhost restart are not lost. It keeps the last resize, the credit (summed), a close, and input up to
 * L.holderInputCapBytes; input past that is dropped, as in front of a holder that is not reading.
 */
export function holdStream(ch: Channel): Channel {
  let queue: StreamToPtyhost[] | null = [] // bounded: input ≤ L.holderInputCapBytes, one resize, one credit, one close
  let held = 0
  let sink: ((m: unknown, ports: readonly unknown[]) => void) | null = null
  streamsHeld.inc()
  let counted = true
  const uncount = () => {
    if (counted) streamsHeld.dec()
    counted = false
  }
  const off = ch.onMessage((m, ports) => {
    if (queue === null) return sink?.(m, ports)
    if (!isStreamToPtyhost(m)) return
    switch (m.k) {
      case 'resize':
      case 'close':
        queue = queue.filter((q) => q.k !== m.k)
        queue.push(m)
        return
      case 'credit': {
        const c = queue.find((q): q is Extract<StreamToPtyhost, { k: 'credit' }> => q.k === 'credit')
        if (c) c.n += m.n
        else queue.push({ k: 'credit', n: m.n })
        return
      }
      case 'in':
      case 'inb': {
        const n = inputBytes(m)
        if (held + n > L.holderInputCapBytes) return
        held += n
        queue.push(m)
        return
      }
    }
  })
  return {
    send: (m, transfer) => ch.send(m, transfer),
    onMessage(cb) {
      sink = cb
      // after the subscriber is set up; whatever arrives before then still queues behind what was held
      queueMicrotask(() => {
        const q = queue ?? []
        queue = null
        uncount()
        for (const m of q) sink?.(m, [])
      })
      return () => {
        sink = null
        off()
      }
    },
    onClose: (cb) => ch.onClose(cb),
    close() {
      uncount()
      off()
      ch.close()
    },
  }
}

/** Renderer streams waiting for the startup adoption. */
const streamsHeld = resources.counter('ptyhost.streamsHeld')

/**
 * A process of this user's runs with this pid (signal 0 delivers nothing). Only a hint: pids are reused, so the
 * holder's own HELLO decides. ESRCH (none) and EPERM (another user's process) both mean the holder is gone.
 */
function pidRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** `lstat` of a socket owned by this user (never followed through a symlink), or null. */
function ownSocketStat(sock: string): fs.Stats | null {
  if (!isOwnSocket(sock)) return null
  try {
    return fs.lstatSync(sock)
  } catch {
    return null
  }
}
