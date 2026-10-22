// The dev server of each session: detection, Run / Stop / Restart, its ports and URL, the "port in use" hint.
//
// The server runs in a PTY holder of kind `server`, started and reconciled as an agent's is, so it survives everything
// a terminal survives: this service holds no process, only what it has learned about one.
//
//   state        the `kit/Fsm` table in fsm.ts, per session
//   after a restart of core, the app or ptyhost
//                the terminal records say which server PTYs run: each is taken up again as `running` (or `stopping`,
//                when a Stop was under way), its ports are scanned at once and its output read again; one that ended
//                meanwhile reads `stopped` if it exited 0 or Kea had begun to stop it (`kv`, below), else `crashed`
//   kv           `server:<sessionId>` → { ptyId, stopped, url }: what a restarted core cannot read from the records.
//                Written when a Stop begins and when a printed URL is confirmed; removed with the session
//   Stop         `SIGINT`, then `SIGTERM`, then `SIGKILL`, a step apart, in `stopFlow`
//   scans        one `ScanSchedule` per live server (scan.ts); every live server is scanned, shown or not:
//                Run's check for a port another session holds and the hint need the ports of the others
//   output       read through ptyhost each time the PTY's output starts or pauses (`pty.activity`), ring only
//   store        `server:<sessionId>`, one row, registered only while a window shows the session;
//                what is kept for a session nobody shows is its entry here, and only while its server is alive
//
// Kea never stops anything that is not a Kea dev server: "Stop it and run here" stops another session's server by its
// own Stop, and a port held by anything else is only named (`lsof` reads, nothing is signalled).

import { PoolFullError, runProcess, systemClock, type Clock, type Disposable, type Fsm, type Logger } from '@kea/kit'
import {
  KeyedStore,
  L,
  need,
  SERVER_ROW,
  sessionStoreName,
  type Grid,
  type Handlers,
  type ServerExit,
  type ServerHint,
  type ServerRefusal,
  type ServerResult,
  type ServerSource,
  type ServerState,
  type ServerView,
  type SessionView,
  type SimpleStoreRegistry,
  type serverApi,
} from '@kea/protocol'
import { coreOs, type PortHolder } from '../os/index.ts'
import { kvDelete, kvGet, kvSet, type KeaDb } from '../platform/db/db.ts'
import type { VisibleSet } from '../platform/visible.ts'
import type { WatchService } from '../platform/watch/service.ts'
import type { Projects } from '../sessions/projects.ts'
import type { Sessions } from '../sessions/sessions.ts'
import type { Env } from '../terminal/shellEnv.ts'
import { userShell } from '../terminal/spawn.ts'
import type { TerminalRecord } from '../terminal/records.ts'
import type { ActivityNote, TerminalExit, Terminals } from '../terminal/terminals.ts'
import { inspectStartScript, resolveRun, runSource } from './command.ts'
import { serverAlive, serverFsm, type ServerEvent } from './fsm.ts'
import { parsePorts, ScanSchedule } from './scan.ts'
import { announcesListening, portInUse, primaryUrl, printedUrls, stripAnsi, urlPort, type PrintedUrl } from './url.ts'

const SIGINT = 2
const KV_PREFIX = 'server:'

export type ServerTerminals = Pick<
  Terminals,
  'launch' | 'stat' | 'signal' | 'terminate' | 'tail' | 'stop' | 'releaseEnded' | 'forgetRecord' | 'sessionRecords' | 'record' | 'exits' | 'stops'
>

export interface ServersOptions {
  db: KeaDb
  log: Logger
  terminals: ServerTerminals
  sessions: Pick<Sessions, 'store' | 'refresh' | 'serverEnv'>
  projects: Pick<Projects, 'get' | 'updateSettings' | 'store'>
  visible: VisibleSet
  watch: WatchService
  stores: SimpleStoreRegistry
  /** The login-shell environment (the user's `$SHELL` for a run command). */
  env: () => Promise<Env>
  /** The `kea-helper` Kea ships (`ports`); without it no port is ever found. */
  helperPath: string | null
  clock?: Clock
  /** `kit/runProcess` (tests count the runs). */
  run?: typeof runProcess
  /** Whether a pid is a live process of this user (tests). */
  alive?: (pid: number) => boolean
}

interface Mark {
  ptyId: string
  /** Kea had begun to stop this run. */
  stopped: boolean
  /** The printed URL that was confirmed listening, so the chip is the same after a restart. */
  url: string | null
}

interface Stopping {
  /** Skip to `SIGKILL` (the second click). */
  kill: boolean
  /** Wakes the flow's current wait (a second click, the PTY's exit). */
  wake: (() => void) | null
  /** Resolves when the Stop is over. */
  done: Promise<void>
  finished(): void
}

interface Entry {
  readonly sessionId: string
  fsm: Fsm<ServerState, ServerEvent, undefined>
  source: ServerSource
  /** The Server tab's PTY: the live server's, else the last run's. */
  ptyId: string | null
  pid: number | null
  ports: number[]
  url: string | null
  // bounded: L.serverUrlCandidatesMax, one per port, in the order printed
  printed: PrintedUrl[]
  /** The output sequence number read up to. */
  outputEnd: number
  exit: ServerExit | null
  hint: ServerHint | null
  schedule: ScanSchedule | null
  scanAbort: AbortController | null
  /** The run in flight is being stopped by Kea. */
  byKea: boolean
  stopping: Stopping | null
  reading: boolean
  readAgain: boolean
  /** The store, while a window shows the session. */
  store: KeyedStore<ServerView> | null
  /** The root directory followed while shown. */
  dirWatch: Disposable | null
  watchedDir: string | null
  /** Run / Restart / take-over calls of this session, one at a time. */
  ops: Promise<unknown>
  busy: number
  /**
   * Bumped by every Stop. A Run carries the number it was asked under, and one that is still waiting its turn when a
   * later Stop arrives does not start a server: the last click wins (C-RACE-4).
   */
  stops: number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0: an existence check, nothing is delivered
    return true
  } catch {
    // ESRCH: gone. EPERM: another user's process, so the pid was reused (a dev server runs as this user)
    return false
  }
}

export class Servers {
  private readonly o: ServersOptions
  private readonly clock: Clock
  private readonly run: typeof runProcess
  private readonly alive: (pid: number) => boolean
  // bounded: sessions a window shows + sessions whose dev server is alive or being run (one each); an entry goes when
  // neither holds (`settle`), and with its session
  private readonly entries = new Map<string, Entry>()
  // bounded: one per live server PTY (≤ entries)
  private readonly byPty = new Map<string, Entry>()
  // bounded: sessions being created now, waiting to learn whether `autoStartServer` starts their server; dropped once
  // they are live with setup settled, or gone
  private readonly creating = new Set<string>()
  private readonly subs: (() => void)[] = []
  private scansRunning = 0
  /** The terminals have been reconciled with ptyhost at least once: a PTY can be signalled. */
  private attached = false
  private disposed = false

  constructor(o: ServersOptions) {
    this.o = o
    this.clock = o.clock ?? systemClock
    this.run = o.run ?? runProcess
    this.alive = o.alive ?? pidAlive
    const v = o.visible.onChange((c) => {
      for (const id of c.shown) this.show(id)
      for (const id of c.hidden) this.hide(id)
    })
    this.subs.push(() => v.dispose())
    this.subs.push(o.sessions.store.onDelta((d) => this.onSessions(d.set ?? {}, d.del ?? [])))
    this.subs.push(
      o.projects.store.onDelta((d) => {
        // a run command set or cleared changes what there is to run
        for (const e of this.entries.values()) if (e.store && Object.hasOwn(d.set ?? {}, o.sessions.store.get(e.sessionId)?.projectId ?? '')) this.detect(e)
      }),
    )
    const x = o.terminals.exits.event((ev) => this.onExit(ev))
    const s = o.terminals.stops.event((ev) => {
      if (ev.kind === 'server') this.stoppedByKea(ev.sessionId, ev.ptyId)
    })
    this.subs.push(() => x.dispose(), () => s.dispose())
    for (const [id, view] of o.sessions.store.entries()) if (view.lifecycle === 'creating') this.creating.add(id)
    this.dropStaleMarks()
    this.resync(false)
  }

  // ── the window's calls ──────────────────────────────────────────────────────────────────────────

  handlers(): Handlers<typeof serverApi> {
    return {
      'server.run': ({ sessionId, grid }) => this.start(sessionId, grid),
      'server.stop': ({ sessionId }) => this.stop(sessionId),
      'server.restart': ({ sessionId, grid }) => this.restart(sessionId, grid),
      'server.takeOver': ({ sessionId, grid }) => this.takeOver(sessionId, grid),
      'server.scan': ({ sessionId }) => {
        this.entries.get(sessionId)?.schedule?.opened()
        return { ok: true }
      },
      'server.dismissHint': ({ sessionId }) => {
        const e = this.entries.get(sessionId)
        if (e?.hint) {
          e.hint = null
          this.publish(e)
        }
        return { ok: true }
      },
    }
  }

  /** What the store would show for a session (tests, and the header of a session not on screen yet). */
  view(sessionId: string): ServerView {
    const e = this.entries.get(sessionId) ?? this.build(sessionId)
    if (!e.store) e.source = this.sourceOf(sessionId).source
    return this.viewOf(e)
  }

  /** Run. One server per session: a no-op while one is alive. */
  start(sessionId: string, grid?: Grid): Promise<ServerResult> {
    const e = this.entry(sessionId)
    const asked = e.stops
    return this.serial(e, () => this.doRun(e, grid, asked))
  }

  /** Stop, then Run, one action. */
  restart(sessionId: string, grid?: Grid): Promise<ServerResult> {
    const e = this.entry(sessionId)
    const asked = e.stops
    return this.serial(e, async () => {
      await this.halt(sessionId)
      return this.doRun(e, grid, asked)
    })
  }

  /** "Stop it and run here": only another session's dev server is ever stopped. */
  takeOver(sessionId: string, grid?: Grid): Promise<ServerResult> {
    const e = this.entry(sessionId)
    const asked = e.stops
    return this.serial(e, async () => {
      const holder = e.hint?.holder
      const other = holder?.kind === 'session' && holder.sessionId !== sessionId ? this.entries.get(holder.sessionId) : undefined
      if (!other || !serverAlive(other.fsm.state)) {
        // nothing of Kea's holds it (any more): the hint was stale, or names a process Kea may not stop
        if (holder?.kind === 'session') return this.doRun(e, grid, asked)
        return this.refused(e, 'notHeld')
      }
      this.o.log.info('dev server stopped for another session', { sessionId: other.sessionId, for: sessionId, port: e.hint?.port })
      await this.stop(other.sessionId)
      return this.doRun(e, grid, asked)
    })
  }

  /**
   * Stop. Resolves once the server has stopped and nothing of its tree is left. On a server that is already stopping
   * this is the second click: straight to `SIGKILL`.
   */
  stop(sessionId: string): Promise<ServerResult> {
    // a Run asked before this Stop and not started yet is not to start (the last click wins)
    const e = this.entries.get(sessionId)
    if (e) e.stops++
    return this.halt(sessionId)
  }

  /** Stop the server that is there, leaving the Runs that wait their turn alone: Restart's own first half. */
  private async halt(sessionId: string): Promise<ServerResult> {
    const e = this.entries.get(sessionId)
    if (!e || !serverAlive(e.fsm.state)) return { ok: true, state: e?.fsm.state ?? this.view(sessionId).state, reason: null }
    let s = e.stopping
    if (s) {
      s.kill = true
      s.wake?.()
    } else s = this.beginStop(e, e.fsm.state === 'stopping') // `stopping` with no Stop under way: the last one could not end it
    await s.done
    return { ok: !serverAlive(e.fsm.state), state: e.fsm.state, reason: null }
  }

  /** Ptyhost's activity notes (core.ts): a server PTY's output started or paused, so it is read. */
  activity(n: ActivityNote): void {
    if (n.m !== 'pty.activity') return
    const e = this.byPty.get(n.a.ptyId)
    if (e && serverAlive(e.fsm.state) && !e.stopping) this.readSoon(e)
  }

  /** After each reconciliation of the terminals (launch, a restarted ptyhost): the records say which servers run. */
  reconciled(): void {
    if (this.disposed) return
    this.attached = true
    this.resync(true)
  }

  /** Background work done (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.entries.values()].filter((e) => e.busy > 0 || e.stopping)
      if (!pending.length) return
      await Promise.all(pending.map((e) => Promise.all([e.ops, e.stopping?.done])))
    }
  }

  /** The resource-report rows held here. */
  get resourceCounts(): { entries: number; live: number; stores: number; scanTimers: number; scans: number; watches: number; creating: number } {
    let live = 0
    let stores = 0
    let scanTimers = 0
    let watches = 0
    for (const e of this.entries.values()) {
      if (serverAlive(e.fsm.state)) live++
      if (e.store) stores++
      if (e.dirWatch) watches++
      scanTimers += e.schedule?.timers ?? 0
    }
    return { entries: this.entries.size, live, stores, scanTimers, scans: this.scansRunning, watches, creating: this.creating.size }
  }

  /** Core goes: timers, scans and watches end. The servers keep running. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.subs.splice(0)) off()
    for (const e of this.entries.values()) {
      e.schedule?.stop()
      e.scanAbort?.abort()
      e.dirWatch?.dispose()
      e.dirWatch = null
      e.stopping?.wake?.()
      if (e.store) this.o.stores.remove(e.store.name)
      e.store = null
    }
    this.entries.clear()
    this.byPty.clear()
    this.creating.clear()
  }

  // ── entries ─────────────────────────────────────────────────────────────────────────────────────

  private entry(sessionId: string): Entry {
    let e = this.entries.get(sessionId)
    if (!e) {
      e = this.build(sessionId)
      this.entries.set(sessionId, e)
      if (e.ptyId && serverAlive(e.fsm.state)) this.takeUp(e, e.ptyId)
    }
    return e
  }

  /** A session's entry as the terminal records and `kv` describe it. */
  private build(sessionId: string): Entry {
    const last = this.lastServer(sessionId)
    const mark = last ? this.mark(sessionId, last.ptyId) : null
    let state: ServerState = 'stopped'
    let exit: ServerExit | null = null
    if (last?.state === 'running') state = mark?.stopped ? 'stopping' : 'running'
    else if (last) {
      exit = { code: last.exitCode, signal: last.exitSignal }
      state = mark?.stopped || (last.state === 'exited' && last.exitCode === 0) ? 'stopped' : 'crashed'
    }
    return {
      sessionId,
      fsm: serverFsm(state),
      source: 'none',
      ptyId: last?.ptyId ?? null,
      pid: last?.state === 'running' ? last.childPid : null,
      ports: [],
      url: null,
      printed: [],
      outputEnd: 0,
      exit,
      hint: null,
      schedule: null,
      scanAbort: null,
      byKea: false,
      stopping: null,
      reading: false,
      readAgain: false,
      store: null,
      dirWatch: null,
      watchedDir: null,
      ops: Promise.resolve(),
      busy: 0,
      stops: 0,
    }
  }

  private lastServer(sessionId: string): TerminalRecord | undefined {
    return this.o.terminals
      .sessionRecords(sessionId)
      .filter((r) => r.kind === 'server')
      .reduce<TerminalRecord | undefined>((a, r) => (!a || r.createdAt >= a.createdAt ? r : a), undefined)
  }

  /** A live server found in the records (a restarted core or ptyhost): scans and output from here on, or its Stop resumed. */
  private takeUp(e: Entry, ptyId: string): void {
    this.byPty.set(ptyId, e)
    const mark = this.mark(e.sessionId, ptyId)
    if (e.fsm.state === 'stopping') {
      // a Stop that core did not live to finish goes on, once ptyhost holds the PTY again (`reconciled`)
      e.byKea = true
      if (!e.stopping && this.attached) this.beginStop(e, false)
      return
    }
    const port = mark?.url ? urlPort(mark.url) : null
    if (mark?.url && port !== null && !e.printed.some((p) => p.port === port)) e.printed.push({ url: mark.url, port })
    this.scanning(e, ptyId).start({ now: true })
    this.readSoon(e)
  }

  /**
   * The records say which servers run: live ones are taken up, and one that ended while away is finished. `reconciled`:
   * after a reconciliation with ptyhost (before the first, nothing can be signalled or released yet).
   */
  private resync(reconciled: boolean): void {
    for (const sessionId of this.o.sessions.store.keys()) {
      const last = this.lastServer(sessionId)
      if (!last) continue
      const e = this.entries.get(sessionId)
      if (last.state === 'running') {
        if (!e) this.entry(sessionId)
        else if (e.ptyId === last.ptyId && !e.stopping && ((e.fsm.state === 'running' && !e.schedule) || e.fsm.state === 'stopping')) this.takeUp(e, last.ptyId)
      } else if (e && e.ptyId === last.ptyId && serverAlive(e.fsm.state) && !e.stopping && e.fsm.state !== 'starting') this.finish(e, last.ptyId)
      // a server that ended while core was away still has its holder lingering; nothing else lets it go
      else if (reconciled && !e) void this.o.terminals.releaseEnded(last.ptyId).catch(() => false)
    }
  }

  /** An entry nobody needs goes: its session is not shown, its server is not alive, it has no hint and no call is under way. */
  private settle(e: Entry): void {
    if (this.entries.get(e.sessionId) !== e) return
    // a hint waits for its session to be shown (it goes with the next Run, a dismissal, or the session)
    if (e.store || e.busy > 0 || e.stopping || e.hint || serverAlive(e.fsm.state)) return
    this.entries.delete(e.sessionId)
  }

  private serial<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    e.busy++
    const run = e.ops.then(fn, fn)
    e.ops = run.then(
      () => undefined,
      () => undefined,
    )
    void e.ops.then(() => {
      e.busy--
      this.settle(e)
    })
    return run
  }

  // ── the store and detection ─────────────────────────────────────────────────────────────────────

  private viewOf(e: Entry): ServerView {
    return { state: e.fsm.state, source: e.source, ptyId: e.ptyId, pid: e.pid, ports: [...e.ports], url: e.url, exit: e.exit, hint: e.hint }
  }

  private publish(e: Entry): void {
    if (!e.store) return
    const next = this.viewOf(e)
    const cur = e.store.get(SERVER_ROW)
    if (!cur || JSON.stringify(cur) !== JSON.stringify(next)) e.store.set(SERVER_ROW, next)
  }

  /** A window shows the session: its store exists from here on, before `visible.set` returns. */
  private show(sessionId: string): void {
    if (this.disposed) return
    const e = this.entry(sessionId)
    if (!e.store) {
      e.store = new KeyedStore<ServerView>(sessionStoreName('server', sessionId))
      this.o.stores.add(e.store)
    }
    // re-evaluated on activation too, whatever the watch has seen
    this.detect(e)
    this.publish(e)
  }

  /** No window shows it any more: its store and its watch go; a live server keeps its entry and its scans. */
  private hide(sessionId: string): void {
    const e = this.entries.get(sessionId)
    if (!e) return
    if (e.store) this.o.stores.remove(e.store.name)
    e.store = null
    e.dirWatch?.dispose()
    e.dirWatch = null
    e.watchedDir = null
    this.settle(e)
  }

  /** What there is to run in a session's working directory now. */
  private sourceOf(sessionId: string): { source: ServerSource; cwd: string | null } {
    const v = this.o.sessions.store.get(sessionId)
    const settings = v ? this.o.projects.get(v.projectId)?.settings : undefined
    const cwd = v && !v.worktreeMissing ? v.cwd : null
    return { source: settings && cwd ? runSource(settings, inspectStartScript(cwd)) : 'none', cwd }
  }

  /** Is there something to run? Follows the session's root directory while it is shown. */
  private detect(e: Entry): void {
    if (this.disposed) return
    const { source, cwd } = this.sourceOf(e.sessionId)
    // a session shown while it is being created has no worktree yet: the watch service waits for the directory on its
    // nearest existing ancestor, and its appearance is a change that comes back here (service.ts `dir`; I-SRV-11)
    const dir = cwd || null
    if (e.store && dir !== e.watchedDir) {
      e.dirWatch?.dispose()
      e.dirWatch = dir ? this.o.watch.dir(dir, () => this.detect(e)) : null
      e.watchedDir = dir
    }
    if (source === e.source) return
    e.source = source
    this.publish(e)
  }

  // ── sessions coming and going ───────────────────────────────────────────────────────────────────

  private onSessions(set: Record<string, SessionView>, del: readonly string[]): void {
    for (const id of del) {
      this.creating.delete(id)
      kvDelete(this.o.db, KV_PREFIX + id)
      const e = this.entries.get(id)
      if (!e) continue
      // delete stops its server (sessions.ts stops every PTY first; this is for one it could not)
      if (serverAlive(e.fsm.state) && !e.stopping && e.fsm.state !== 'starting') this.beginStop(e, true)
      e.hint = null
      this.settle(e)
    }
    for (const [id, v] of Object.entries(set)) {
      if (v.lifecycle === 'creating') {
        this.creating.add(id)
        continue
      }
      if (this.creating.has(id)) this.created(id, v)
      const e = this.entries.get(id)
      if (!e) continue
      if (v.lifecycle !== 'live' && v.lifecycle !== 'detached' && serverAlive(e.fsm.state) && !e.stopping && e.fsm.state !== 'starting') void this.stop(id)
      if (e.store) this.detect(e)
    }
  }

  /** A session that was being created is live; its server starts once setup has succeeded (or there is none). */
  private created(id: string, v: SessionView): void {
    if (v.lifecycle !== 'live') {
      this.creating.delete(id) // creation failed, or it was discarded
      return
    }
    if (v.setup?.state === 'running') return // the agent started without waiting for setup: decided when it ends
    this.creating.delete(id)
    if (v.setup && v.setup.state !== 'done') return
    if (!this.o.projects.get(v.projectId)?.settings.autoStartServer) return
    void this.start(id).then(
      (r) => this.o.log.info('dev server started with the session', { sessionId: id, ok: r.ok, reason: r.reason }),
      (err) => this.o.log.warn('dev server not started with the session', { sessionId: id, error: String(err) }),
    )
  }

  // ── Run ─────────────────────────────────────────────────────────────────────────────────────────

  private refused(e: Entry, reason: ServerRefusal): ServerResult {
    return { ok: false, state: e.fsm.state, reason }
  }

  private async doRun(e: Entry, grid: Grid | undefined, asked: number): Promise<ServerResult> {
    if (this.disposed) return this.refused(e, 'wrongState')
    /** A Stop came after this Run was asked for, before it started anything. */
    const overtaken = (): boolean => asked !== e.stops
    if (overtaken()) return { ok: false, state: e.fsm.state, reason: null }
    if (e.fsm.state === 'stopping' && e.stopping) {
      // Run on a server that is being stopped: Stop, then Run (Restart's order), unless another Stop comes meanwhile
      await e.stopping.done
      if (this.disposed) return this.refused(e, 'wrongState')
      if (overtaken()) return { ok: false, state: e.fsm.state, reason: null }
    }
    if (serverAlive(e.fsm.state)) return { ok: true, state: e.fsm.state, reason: null }
    const id = e.sessionId
    const v = this.o.sessions.store.get(id)
    if (!v || (v.lifecycle !== 'live' && v.lifecycle !== 'detached') || v.worktreeMissing) return this.refused(e, 'wrongState')
    const project = this.o.projects.get(v.projectId)
    if (!project) return this.refused(e, 'wrongState')
    const target = resolveRun(project.settings, inspectStartScript(v.cwd), userShell(await this.o.env()))
    if (overtaken()) return { ok: false, state: e.fsm.state, reason: null }
    const source = target?.source ?? 'none'
    if (source !== e.source) {
      e.source = source
      this.publish(e)
    }
    if (!target) return this.refused(e, 'nothingToRun')
    // before running, a port this project's servers use that another session's dev server holds
    const held = this.heldByAnother(id, project.settings.serverPorts ?? [])
    if (held) {
      e.hint = held
      this.publish(e)
      return this.refused(e, 'portHeld')
    }
    e.fsm.send({ t: 'run' })
    e.hint = null
    e.exit = null
    e.ports = []
    e.url = null
    e.printed = []
    e.outputEnd = 0
    e.byKea = false
    e.pid = null
    this.publish(e)
    kvDelete(this.o.db, KV_PREFIX + id)
    const before = this.o.terminals.sessionRecords(id).filter((r) => r.kind === 'server' && r.state !== 'running')
    let ptyId: string
    try {
      // the worktree root, the session environment with PORT, and colours on
      const env = { ...(await this.o.sessions.serverEnv(id)), FORCE_COLOR: '1' }
      const g = grid ?? { cols: L.ptyDefaultCols, rows: L.ptyDefaultRows }
      ptyId = (await this.o.terminals.launch({ sessionId: id, kind: 'server', command: target.command, cwd: v.cwd, cols: g.cols, rows: g.rows, env })).ptyId
    } catch (err) {
      // no holder was started: nothing ran, and the caller is told why
      const stop = e.stopping
      e.stopping = null
      e.byKea = false
      e.fsm.send({ t: 'ended' })
      this.publish(e)
      stop?.finished()
      throw err
    }
    this.o.log.info('dev server started', { sessionId: id, ptyId, source: target.source, command: target.label })
    e.ptyId = ptyId
    e.pid = this.o.terminals.record(ptyId)?.childPid ?? null
    this.byPty.set(ptyId, e)
    if (e.fsm.state === 'starting') e.fsm.send({ t: 'alive' })
    this.publish(e)
    this.o.sessions.refresh(id)
    // the Server tab is this run's from here on; the run it replaces goes, scrollback and all
    for (const r of before) await this.o.terminals.forgetRecord(r.ptyId, { files: true }).catch(() => undefined)
    const now = this.o.sessions.store.get(id)
    if (!e.stopping && serverAlive(e.fsm.state) && (!now || (now.lifecycle !== 'live' && now.lifecycle !== 'detached'))) {
      // the session was archived or deleted while its server was starting
      await this.beginStop(e, true).done
      return { ok: false, state: e.fsm.state, reason: 'wrongState' }
    }
    if (e.stopping) {
      // Stop was asked while the holder was starting it
      await this.runStop(e, ptyId, e.stopping)
      return { ok: false, state: e.fsm.state, reason: null }
    }
    if (serverAlive(e.fsm.state) && this.o.terminals.record(ptyId)?.state !== 'running') this.finish(e, ptyId) // its exit report came before it was followed
    if (!serverAlive(e.fsm.state)) return { ok: e.fsm.state === 'stopped', state: e.fsm.state, reason: null }
    this.scanning(e, ptyId).start()
    return { ok: true, state: e.fsm.state, reason: null }
  }

  // ── exits ───────────────────────────────────────────────────────────────────────────────────────

  private onExit(ev: TerminalExit): void {
    if (ev.kind !== 'server' || this.disposed) return
    const e = this.entries.get(ev.sessionId)
    if (!e || e.ptyId !== ev.ptyId) {
      // nothing here follows it (it is still being launched: doRun looks at its record next); the sidebar's dot does
      this.o.sessions.refresh(ev.sessionId)
      return
    }
    if (e.stopping) {
      e.stopping.wake?.() // the Stop flow finishes it, once the rest of its tree is gone
      return
    }
    if (serverAlive(e.fsm.state)) this.finish(e, ev.ptyId)
  }

  /** Kea began to stop a server PTY from outside this service (archive, delete, Stop All and Quit: `terminals.stop`). */
  private stoppedByKea(sessionId: string, ptyId: string): void {
    this.writeMark(sessionId, { ptyId, stopped: true, url: this.mark(sessionId, ptyId)?.url ?? null })
    const e = this.entries.get(sessionId)
    if (!e || e.ptyId !== ptyId || !serverAlive(e.fsm.state)) return
    e.byKea = true
    e.schedule?.stop()
    e.scanAbort?.abort()
    if (e.fsm.state !== 'stopping') e.fsm.send({ t: 'stop' })
    this.publish(e)
  }

  /** The server's PTY has ended: `stopped` or `crashed`, its scans over, its holder let go. */
  private finish(e: Entry, ptyId: string): void {
    if (this.disposed) return
    const rec = this.o.terminals.record(ptyId)
    if (rec?.state === 'running') {
      this.o.log.warn('dev server not stopped: its terminal still runs', { sessionId: e.sessionId, ptyId })
      this.publish(e)
      return
    }
    this.byPty.delete(ptyId)
    e.schedule?.stop()
    e.schedule = null
    e.scanAbort?.abort()
    e.scanAbort = null
    const byKea = e.byKea || this.mark(e.sessionId, ptyId)?.stopped === true
    // no record: its session is being deleted, which stopped it
    const ok = !rec || byKea || (rec.state === 'exited' && rec.exitCode === 0)
    e.byKea = false
    e.pid = null
    e.ports = []
    e.url = null
    e.exit = rec ? { code: rec.exitCode, signal: rec.exitSignal } : null
    if (serverAlive(e.fsm.state)) e.fsm.send({ t: ok ? 'ended' : 'failed' })
    this.o.log.info('dev server ended', { sessionId: e.sessionId, ptyId, state: e.fsm.state, code: rec?.exitCode ?? null, signal: rec?.exitSignal ?? null, byKea })
    this.publish(e)
    this.o.sessions.refresh(e.sessionId)
    // a hint that named this session's server names nothing now
    for (const other of this.entries.values()) {
      if (other.hint?.holder.kind === 'session' && other.hint.holder.sessionId === e.sessionId) {
        other.hint = null
        this.publish(other)
      }
    }
    void this.afterExit(e, ptyId, e.fsm.state === 'crashed')
  }

  private async afterExit(e: Entry, ptyId: string, crashed: boolean): Promise<void> {
    e.busy++
    try {
      // read while its holder still lingers, then let the holder go; the tab keeps the output
      if (crashed) await this.explain(e, ptyId)
      if (!this.disposed) await this.o.terminals.releaseEnded(ptyId).catch(() => false)
    } catch (err) {
      this.o.log.warn('dev server exit not followed up', { sessionId: e.sessionId, error: String(err) })
    } finally {
      e.busy--
      this.settle(e)
    }
  }

  // ── Stop ────────────────────────────────────────────────────────────────────────────────────────

  private beginStop(e: Entry, kill: boolean): Stopping {
    let finished: () => void = () => undefined
    const done = new Promise<void>((r) => (finished = r))
    const stopping: Stopping = { kill, wake: null, done, finished }
    e.stopping = stopping
    e.byKea = true
    e.schedule?.stop()
    e.scanAbort?.abort()
    const launching = e.fsm.state === 'starting'
    if (e.fsm.state !== 'stopping') e.fsm.send({ t: 'stop' })
    this.publish(e)
    // while the holder is still starting it, doRun runs the flow as soon as the PTY exists
    if (!launching && e.ptyId) void this.runStop(e, e.ptyId, stopping)
    return stopping
  }

  private async runStop(e: Entry, ptyId: string, s: Stopping): Promise<void> {
    try {
      await this.stopFlow(e, ptyId, s)
    } catch (err) {
      this.o.log.warn('dev server Stop failed', { sessionId: e.sessionId, ptyId, error: String(err) })
    } finally {
      if (e.stopping === s) e.stopping = null
      this.finish(e, ptyId)
      s.finished()
    }
  }

  /**
   * The Stop flow: `SIGINT` to the foreground process group (what `⌃C` would do); after L.serverStopStepMs `SIGTERM` to
   * the terminal's groups (the holder's `TERMINATE`, which lists the tree then); after L.serverStopStepMs more the
   * holder `SIGKILL`s every listed process still alive. Each step ends early once the server's own process and every
   * process `STAT` listed at stop time are gone, which is when Stop is done. If its own process goes on `SIGINT` while
   * one it listed lives on, the `SIGTERM` step starts at once: the holder can still find the rest of the session then.
   * A second click (`s.kill`) skips to `SIGKILL`.
   */
  private async stopFlow(e: Entry, ptyId: string, s: Stopping): Promise<void> {
    const t = this.o.terminals
    const step = L.serverStopStepMs
    const settle = L.serverStopSettleMs
    this.writeMark(e.sessionId, { ptyId, stopped: true, url: this.mark(e.sessionId, ptyId)?.url ?? null })
    const tree = new Set<number>() // bounded: the pids one or two STAT replies list (L.holderStatPidsMax each)
    const list = async (): Promise<void> => {
      const st = await t.stat(ptyId)
      for (const pid of [st?.childPid ?? 0, ...(st?.descendants ?? [])]) if (pid > 1) tree.add(pid)
    }
    const left = (): boolean => [...tree].some((pid) => this.alive(pid))
    const running = (): boolean => t.record(ptyId)?.state === 'running'
    const over = (): boolean => this.disposed
    /** Waits `ms` on the service's clock, or less: the PTY's exit and a second click wake it (`s.wake`). */
    const pause = (ms: number): Promise<void> =>
      new Promise<void>((r) => {
        const done = (): void => {
          this.clock.clearTimeout(h)
          s.wake = null
          r()
        }
        const h = this.clock.setTimeout(done, Math.max(0, ms))
        s.wake = done
      })
    /** Resolves when the PTY has ended or `ms` have passed; `untilKill`: or when a second click asks for SIGKILL. */
    const exitOr = async (ms: number, untilKill: boolean): Promise<void> => {
      const end = this.clock.now() + ms
      while (running() && this.clock.now() < end && !(untilKill && s.kill) && !over()) await pause(end - this.clock.now())
    }
    /** Waits until nothing listed is alive, at most `ms`; `untilKill`: a second click ends the wait. */
    const goneOr = async (ms: number, untilKill: boolean): Promise<void> => {
      const end = this.clock.now() + ms
      while (left() && this.clock.now() < end && !(untilKill && s.kill) && !over()) await pause(Math.min(L.serverStopPollMs, end - this.clock.now()))
    }
    const wait = async (ms: number, untilKill: boolean): Promise<void> => {
      const end = this.clock.now() + ms
      await exitOr(ms, untilKill)
      await goneOr(end - this.clock.now(), untilKill)
    }
    let killed = false
    const kill = async (): Promise<void> => {
      killed = true
      await t.terminate(ptyId, 0)
    }

    await list() // the tree at stop time
    if (over()) return
    if (running() && !s.kill) {
      await t.signal(ptyId, SIGINT, 'fg')
      await exitOr(step, true)
    }
    if (over()) return
    if (s.kill) await kill()
    else if (running()) {
      await list()
      if (over()) return
      await t.terminate(ptyId, step)
      await wait(step + settle, true)
    } else if (left()) {
      // its own process went on SIGINT, something it started did not: SIGTERM now, SIGKILL a step later
      await t.terminate(ptyId, step)
      await wait(step + settle, true)
    } else {
      // all of it went on SIGINT: sweep whatever else the holder still finds of the session
      await kill()
    }
    if (over()) return
    if (left() || running()) {
      if (!killed) await kill()
      await wait(settle, false)
    }
    if (over()) return
    // a holder ptyhost cannot reach is ended as any stopped PTY is (its identity checked first)
    if (running()) await t.stop(ptyId, 'terminate', 0)
    if (left()) this.o.log.warn('dev server stopped, but a process it listed is still alive', { sessionId: e.sessionId, ptyId })
  }

  // ── ports and the URL ───────────────────────────────────────────────────────────────────────────

  private scanning(e: Entry, ptyId: string): ScanSchedule {
    e.schedule?.stop()
    e.scanAbort?.abort()
    const abort = new AbortController()
    e.scanAbort = abort
    e.schedule = new ScanSchedule({ clock: this.clock, scan: () => this.scan(e, ptyId, abort.signal) })
    return e.schedule
  }

  /** One scan: descendant pids from the holder (`STAT`), then `kea-helper ports` on the `ports` pool. */
  private async scan(e: Entry, ptyId: string, signal: AbortSignal): Promise<boolean> {
    const helper = this.o.helperPath
    if (!helper || signal.aborted) return e.ports.length > 0
    this.scansRunning++
    try {
      const st = await this.o.terminals.stat(ptyId)
      if (!st || signal.aborted) return e.ports.length > 0
      const pids = [...new Set([st.childPid, ...st.descendants])].filter((pid) => pid > 1)
      if (pids.length === 0) return e.ports.length > 0
      const res = await this.run(helper, ['ports', ...pids.map(String)], { pool: 'ports', env: {}, timeoutMs: L.portScanTimeoutMs, maxBytes: L.portScanMaxBytes, signal })
      if (signal.aborted || res.cancelled || res.timedOut || e.ptyId !== ptyId) return e.ports.length > 0
      const ports = parsePorts(res.stdout?.toString('utf8') ?? '').ports.slice(0, L.serverPortsMax)
      if (st.childPid && e.pid !== st.childPid) e.pid = st.childPid
      this.listening(e, ports)
      return ports.length > 0
    } catch (err) {
      if (!(err instanceof PoolFullError)) this.o.log.warn('port scan failed', { sessionId: e.sessionId, error: String(err) })
      return e.ports.length > 0
    } finally {
      this.scansRunning--
    }
  }

  private listening(e: Entry, ports: number[]): void {
    const changed = ports.length !== e.ports.length || ports.some((p, i) => p !== e.ports[i])
    e.ports = ports
    this.setUrl(e)
    this.remember(e, ports)
    if (!changed) return
    e.fsm.send({ t: 'ports' })
    this.publish(e)
    // a URL printed just before its port opened is confirmed by this scan; one not read yet is read now
    if (ports.length && !e.printed.some((p) => ports.includes(p.port))) this.readSoon(e)
  }

  private setUrl(e: Entry): void {
    const url = primaryUrl(e.printed, e.ports)
    if (url === e.url) return
    e.url = url
    const printed = e.printed.find((p) => p.url === url)
    if (e.ptyId && printed && this.mark(e.sessionId, e.ptyId)?.url !== url) this.writeMark(e.sessionId, { ptyId: e.ptyId, stopped: false, url })
    this.publish(e)
  }

  /** The fixed ports a project's servers listen on. A port of the session's own block follows `KEA_PORT`, and one the system handed out is nobody's. */
  private remember(e: Entry, ports: readonly number[]): void {
    const v = this.o.sessions.store.get(e.sessionId)
    const project = v ? this.o.projects.get(v.projectId) : undefined
    if (!v || !project) return
    const base = v.portBase
    const fixed = ports.filter((p) => p < L.ephemeralPortStart && (base === null || p < base || p >= base + L.portBlockSize))
    const known = project.settings.serverPorts ?? []
    const fresh = fixed.filter((p) => !known.includes(p))
    if (!fresh.length) return
    const next = [...known, ...fresh].slice(-L.projectServerPortsMax)
    void this.o.projects.updateSettings(project.id, { serverPorts: next }, []).catch((err) => this.o.log.warn('server ports not remembered', { projectId: project.id, error: String(err) }))
  }

  /** The live dev server of another session that listens on `port`. */
  private holderOf(port: number, except: string): Entry | undefined {
    for (const e of this.entries.values()) if (e.sessionId !== except && serverAlive(e.fsm.state) && e.ports.includes(port)) return e
    return undefined
  }

  private sessionHolder(port: number, e: Entry): ServerHint {
    return { port, holder: { kind: 'session', sessionId: e.sessionId, title: this.o.sessions.store.get(e.sessionId)?.title ?? e.sessionId } }
  }

  private heldByAnother(sessionId: string, ports: readonly number[]): ServerHint | null {
    for (const port of ports) {
      const other = this.holderOf(port, sessionId)
      if (other) return this.sessionHolder(port, other)
    }
    return null
  }

  // ── output ──────────────────────────────────────────────────────────────────────────────────────

  /** Read the server's latest output, once; a read asked for while one runs follows it. */
  private readSoon(e: Entry): void {
    if (e.reading) {
      e.readAgain = true
      return
    }
    const ptyId = e.ptyId
    if (!ptyId) return
    e.reading = true
    void this.read(e, ptyId)
      .catch((err) => this.o.log.warn('dev server output not read', { sessionId: e.sessionId, error: String(err) }))
      .finally(() => {
        e.reading = false
        if (e.readAgain) {
          e.readAgain = false
          if (serverAlive(e.fsm.state) && !e.stopping) this.readSoon(e)
        }
      })
  }

  private async read(e: Entry, ptyId: string): Promise<void> {
    const tail = await this.o.terminals.tail(ptyId, L.serverOutputTailBytes)
    if (!tail || e.ptyId !== ptyId || !serverAlive(e.fsm.state)) return
    const fresh = Math.min(tail.bytes.byteLength, Math.max(0, tail.end - e.outputEnd))
    e.outputEnd = tail.end
    if (fresh === 0) return
    // URLs are looked for in all of it (one may straddle two reads); "it is up" only in what is new
    const text = stripAnsi(Buffer.from(tail.bytes.buffer, tail.bytes.byteOffset, tail.bytes.byteLength).toString('utf8'))
    let grew = false
    for (const u of printedUrls(text)) {
      if (e.printed.length >= L.serverUrlCandidatesMax) break
      if (e.printed.some((p) => p.port === u.port)) continue
      e.printed.push(u)
      grew = true
    }
    if (grew) this.setUrl(e)
    const news = stripAnsi(Buffer.from(tail.bytes.buffer, tail.bytes.byteOffset + tail.bytes.byteLength - fresh, fresh).toString('utf8'))
    if (grew || announcesListening(news)) e.schedule?.output()
  }

  // ── the hint ────────────────────────────────────────────────────────────────────────────────────

  /** A run that crashed on a port in use: name what holds the port. */
  private async explain(e: Entry, ptyId: string): Promise<void> {
    const tail = await this.o.terminals.tail(ptyId, L.serverOutputTailBytes)
    if (!tail || e.ptyId !== ptyId || e.fsm.state !== 'crashed') return
    const found = portInUse(stripAnsi(Buffer.from(tail.bytes.buffer, tail.bytes.byteOffset, tail.bytes.byteLength).toString('utf8')))
    if (!found) return
    const v = this.o.sessions.store.get(e.sessionId)
    const remembered = (v && this.o.projects.get(v.projectId)?.settings.serverPorts) || []
    // the port its error names; else one this project's servers use that a dev server of Kea's holds; else its PORT
    const port = found.port ?? remembered.find((p) => this.holderOf(p, e.sessionId)) ?? v?.portBase ?? null
    if (port === null) return
    const hint = await this.holder(port, e.sessionId)
    if (e.ptyId !== ptyId || e.fsm.state !== 'crashed') return
    e.hint = hint
    this.publish(e)
  }

  /** What holds `port`: a dev server of Kea's from its own records, else what the system names (read only). */
  private async holder(port: number, sessionId: string): Promise<ServerHint> {
    const own = this.holderOf(port, sessionId)
    if (own) return this.sessionHolder(port, own)
    let found: PortHolder | null = null
    try {
      // the OS layer's `portOwner` (macOS: `lsof`; Linux: `kea-helper ports --all`); a system without one names
      // nobody (the catch below)
      found = await need(coreOs.portOwner).holder(port, { helper: this.o.helperPath, run: this.run })
    } catch (err) {
      this.o.log.warn('port holder not named', { port, error: String(err) })
    }
    if (!found) return { port, holder: { kind: 'unknown' } }
    // another user's process: it cannot be named
    if (found.kind === 'otherUser') return { port, holder: { kind: 'otherUser' } }
    const named = found
    // a dev server of Kea's whose scan has not found the port yet: the pid is in its tree
    for (const other of this.entries.values()) {
      if (other.sessionId === sessionId || !serverAlive(other.fsm.state) || !other.ptyId) continue
      const st = await this.o.terminals.stat(other.ptyId)
      if (st && (st.childPid === named.pid || st.descendants.includes(named.pid))) return this.sessionHolder(port, other)
    }
    return { port, holder: { kind: 'process', name: named.name || 'a process', pid: named.pid } }
  }

  // ── kv ──────────────────────────────────────────────────────────────────────────────────────────

  private mark(sessionId: string, ptyId: string): Mark | null {
    try {
      const m = JSON.parse(kvGet(this.o.db, KV_PREFIX + sessionId) ?? 'null') as Partial<Mark> | null
      if (!m || m.ptyId !== ptyId) return null
      return { ptyId, stopped: m.stopped === true, url: typeof m.url === 'string' ? m.url : null }
    } catch {
      return null
    }
  }

  private writeMark(sessionId: string, m: Mark): void {
    try {
      kvSet(this.o.db, KV_PREFIX + sessionId, JSON.stringify(m))
    } catch (err) {
      this.o.log.warn('dev server state not written', { sessionId, error: String(err) })
    }
  }

  /** Marks of sessions that no longer exist (a delete that core did not live to see). */
  private dropStaleMarks(): void {
    try {
      for (const r of this.o.db.all<{ key: string }>(`SELECT key FROM kv WHERE key LIKE '${KV_PREFIX}%'`)) {
        if (!this.o.sessions.store.has(r.key.slice(KV_PREFIX.length))) kvDelete(this.o.db, r.key)
      }
    } catch (err) {
      this.o.log.warn('dev server marks not checked', { error: String(err) })
    }
  }
}
