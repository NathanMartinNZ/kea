// Core's side of terminals: core owns what a terminal means, ptyhost owns its bytes. Core keeps a record of every PTY
// it starts (records.ts, dbRecords.ts) and, whenever the control port connects (at launch and after either side
// restarts), reconciles them with ptyhost's holder list and the disk (reconcile.ts). The `terminals` store
// shows the recorded PTYs: live from ptyhost where record and holder agree, from the record otherwise;
// `terminals.orphans` lists live holders no record accounts for. Shell tabs open through `openShell()`; a session's
// agent, dev server and scripts start through `launch()`.
//
// Shell tab numbers: a shell tab reads `Terminal n` (`PtyInfo.number`). Core gives the number as it makes the tab's
// record (or adopts an orphan as a shell): 1 + the highest among the shell records it lists for that session, the
// `shells` pseudo-session counting its own, an ended or lost one included; 1 when none. It never changes while core
// runs. The numbers live in this memory only, never on a record, so nothing on disk holds one: a restarted core numbers
// its records again, in the order the store lists them.
//
// Shell tab tooltips: a shell tab's tooltip names the process in its foreground. Core learns it from the holder's `STAT`,
// asked only for the running shell tabs of a session on screen, and only when something happened: the session came on
// screen or the tab's output paused (asked at once: nothing is due later), its output started or a key was typed (at
// most once per L.tabTitleStatMs per tab: the one timer there is, armed for an event inside that time and taken back by
// the pause that follows). The name goes into the store entry (`PtyInfo.foreground`). A hidden session's tabs are asked
// nothing and hold nothing here, and with no window nothing is on screen. Nothing polls: a quiet shell costs no call
// and holds no timer.

import fs from 'node:fs'
import os from 'node:os'
import { Emitter, isOwnSocket, ptyId as newPtyId, runDir, socketPath, systemClock, type Clock, type Disposable, type Logger, type TimerHandle } from '@kea/kit'
import {
  coreTerminalApi,
  DEFAULT_TERMINAL_SETTINGS,
  hasControlCharacter,
  KeyedStore,
  L,
  ptyhostApi,
  RpcError,
  RpcPeer,
  TERMINAL_ORPHANS_STORE,
  TERMINALS_STORE,
  type Channel,
  type Handlers,
  type MirrorConfig,
  type HolderRow,
  type OrphanInfo,
  type PtyhostNote,
  type PtyInfo,
  type PtyKind,
} from '@kea/protocol'
import { colorThemeOf, isDarkTheme, type ColorTheme } from '@kea/terminal'
import type { VisibleSet } from '../platform/visible.ts'
import { inspectHolder, judge, removeStateFiles, scanHolders, type HolderScan } from './holders.ts'
import { procsProbe, type ProcessProbe } from './procs.ts'
import { planReconcile, recordFromHolder, SHELLS_SESSION, startedAtMs, type ReconcilePlan } from './reconcile.ts'
import { MemoryRecords, type TerminalRecord, type TerminalRecords } from './records.ts'
import { terminalEnv, type Env, type ShellEnvSource } from './shellEnv.ts'
import { shellTabArgv, spawnSpec, userShell, type Command } from './spawn.ts'

export { SHELLS_SESSION } from './reconcile.ts'

const SIGHUP = 1
/** Bracketed paste (xterm's mode 2004): what `sendText` wraps a paste in, and removes from the text. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const PASTE_MARKERS = /\x1b\[20[01]~/g
/** What a paste that core submits may hold besides text: a tab and a line feed. */
const PASTE_WHITESPACE = /[\t\n]/g

/**
 * The character rule, for every caller: what is written to the PTY for `text`, or null when the call is refused
 * (nothing is written then, not a part of the text and no Enter).
 *
 *   typed as keys     no control character (C0, DEL, C1): a terminal reads `\r` and `\n` as Enter, `\t` as a completion,
 *                     `\x03` as an interrupt, ESC as the start of a control sequence
 *   as a paste        the paste markers in the text are removed first, until none is left (removing one can join the
 *                     halves of another), so the text cannot end the paste early; then no control character either,
 *                     except, in a paste core itself submits, a tab and a line feed: text of the paste to a program
 *                     that reads pastes. Core cannot see whether the program does (mode 2004 is the mirror's), so in a
 *                     paste that must not submit a line feed could still be Enter: refused
 *
 * Refused, never typed with the character dropped: a path without its control character is another path.
 */
export function typedData(text: string, o: { bracketed?: boolean; submit?: boolean }): string | null {
  if (!o.bracketed) return hasControlCharacter(text) ? null : text
  let clean = text
  for (let next = clean.replace(PASTE_MARKERS, ''); next !== clean; next = clean.replace(PASTE_MARKERS, '')) clean = next
  if (hasControlCharacter(o.submit ? clean.replace(PASTE_WHITESPACE, '') : clean)) return null
  return `${PASTE_START}${clean}${PASTE_END}`
}

export interface TerminalsOptions {
  version: string
  log: Logger
  /** The resolved login-shell environment. */
  env(): Promise<Env>
  /** "Reload shell environment". */
  reloadEnv?(): Promise<ShellEnvSource>
  /** KEA_HOME: where state files and sockets are found. Without it only records and ptyhost's list are compared. */
  home?: string
  /**
   * Default: in memory, nothing loaded (tests). Core passes `RoutedRecords`: the `shells` pseudo-session's records in
   * terminals.json, every other session's in SQLite.
   */
  records?: TerminalRecords
  /** Holder liveness. Default: none to ask (`procsProbe(null)`): a holder's pid cannot be told; core passes its helper's. */
  probe?: ProcessProbe
  /** Wall clock, ms (record timestamps). */
  now?: () => number
  /** After each reconciliation: core detaches the sessions whose agent PTY ended and takes up the dev servers again. */
  onReconciled?(plan: ReconcilePlan): void
  /** Reconciliation waits for this (the database's rebuild from the holders' state files). */
  ready?: Promise<unknown>
  /** The settings the terminals use (a change reaches the mirrors live and the next spawn). Default: the schema's defaults. */
  settings?: TerminalsSettings
  /**
   * Ptyhost's `pty.banner` notes, for the `banners` store: holders that cannot detach, a missing helper, a full
   * disk, holders in a session of their own rather than a systemd scope.
   */
  onBanner?(b: { kind: 'notDetached' | 'helperMissing' | 'diskFull' | 'sessionMode'; message: string }): void
  /** Ptyhost's `pty.bannerCleared`: what raised the banner is over (the disk has room again). */
  onBannerCleared?(kind: 'diskFull'): void
  /** A new control port: a new ptyhost, whose banners are its own. */
  onConnect?(): void
  /** Ptyhost's activity notes (bell, OSC 9/777, output started/stopped, keystrokes) for tier 3. */
  onActivity?(n: ActivityNote): void
  /** Which sessions a window shows: their shell tabs' tooltips name their foreground process. */
  visible?: Pick<VisibleSet, 'has' | 'onChange'>
  /** The clock of the tab-title rate limit (default: the system's; tests pass their own). */
  clock?: Clock
}

/** Ptyhost's notes tier 3 reads. */
export type ActivityNote = Extract<PtyhostNote, { m: 'pty.bell' | 'pty.oscNotify' | 'pty.activity' | 'pty.keystroke' }>

/** What Terminals reads from the `terminal.*` settings. */
export interface TerminalsSettings {
  /** The mirror's colours and scrollback and "Keep scrollback on disk". */
  mirror(): { theme: string; scrollback: number; diskBackedScrollback: boolean; colors?: ColorTheme }
  /** `terminal.ringBytes` for new PTYs. */
  ringBytes(): number
  /** Called after any settings change; returns the unsubscribe function. */
  onChange(cb: () => void): () => void
}

/** A PTY for a session (its agent, a dev server, a setup or teardown script; shell tabs use `openShell`). */
export interface LaunchRequest {
  sessionId: string
  kind: PtyKind
  command: Command
  cwd: string
  cols: number
  rows: number
  /** Added to the PTY's environment (the session variables). */
  env?: Env
  /** Removed from the PTY's environment (an agent adapter's edits). */
  unsetEnv?: readonly string[]
  /** The tab's title for PTYs whose program sets none (`Setup`, `Teardown`: kind `script`). */
  title?: string
  /**
   * The id the PTY gets (kit's `ptyId()`), for a caller that must write something of its own about the PTY before
   * its record exists (a teardown's mark). Default: a new one.
   */
  ptyId?: string
}

/** A recorded PTY that stopped running (its child exited, or its holder was lost). */
export interface TerminalExit {
  ptyId: string
  sessionId: string
  kind: PtyKind
  state: 'exited' | 'lost'
  exitCode: number | null
  exitSignal: number | null
}

/** The key of a `terminal.setVisible` that came with no window connection (a test's direct call). */
const NO_WINDOW = {}

/**
 * The order the `terminals` store lists records in, which shell numbers follow: tab order, then creation; records
 * rebuilt from the holders (all at tab order 0, made at once) by their holder's start, then PTY id.
 */
function byListOrder(a: TerminalRecord, b: TerminalRecord): number {
  return a.tabOrder - b.tabOrder || a.createdAt - b.createdAt || (a.holderStartedAt ?? 0) - (b.holderStartedAt ?? 0) || (a.ptyId < b.ptyId ? -1 : a.ptyId > b.ptyId ? 1 : 0)
}

/** What is known of the foreground process of one shell tab on screen. */
interface Foreground {
  /** The name last answered, which the store entry shows; null until the first answer. */
  name: string | null
  /** The foreground pid last answered. */
  pid: number
  /** When its holder was last asked (the clock's ms). */
  askedAt: number
  /** The rate limit's one timer, while an ask is due: armed only by something happening in the tab, never kept alive for. */
  timer: TimerHandle | null
  /** An ask is out. */
  asking: boolean
  /** Something happened while that ask was out: it is asked again, at once (`now`: the output paused) or by the rate limit. */
  again: 'now' | 'soon' | null
}

type Ptyhost = RpcPeer<Record<string, never>, typeof ptyhostApi>
/** What an exit note says of a holder. */
type ExitFacts = Pick<PtyInfo, 'state' | 'exitCode' | 'exitSignal'>
/** The same of a PTY that has ended. */
type EndFacts = Pick<TerminalExit, 'state' | 'exitCode' | 'exitSignal'>

export class Terminals {
  readonly store = new KeyedStore<PtyInfo>(TERMINALS_STORE)
  readonly orphans = new KeyedStore<OrphanInfo>(TERMINAL_ORPHANS_STORE)
  private readonly opts: TerminalsOptions
  private readonly records: TerminalRecords
  private readonly probe: ProcessProbe
  private readonly now: () => number
  private ptyhost: Ptyhost | null = null
  // bounded: L.coreControlWaitersMax calls awaiting the control port, released on connect, ended on dispose
  private waiters: { resolve(): void; reject(e: Error): void }[] = []
  private visible: string[] = [] // bounded: the windows' visible terminals, each once (≤ open terminals)
  // bounded: one list per window connection that said what it shows, dropped with the window (`windowGone`)
  private readonly visibleBy = new Map<object, readonly string[]>()
  /** Ptyhost's holders as last listed, kept current by its notes. */
  private readonly listed = new Map<string, PtyInfo>() // bounded: one per live holder
  /** Recorded PTYs whose holder ptyhost holds: the only ones core ever routes to ptyhost (C-COR-6). */
  private attached = new Set<string>() // bounded: ≤ records (L.terminalRecordsMax)
  /** Running records whose holder is alive but not connected to ptyhost. */
  private unreachable = new Set<string>() // bounded: ≤ records (L.terminalRecordsMax)
  /**
   * PTYs being launched: from the moment their record is written until ptyhost's list has answered and they are
   * attached (`launch`). Until then core does not hold their holder, so nothing here may be read as "it has none":
   * they are not released, not forgotten and not judged by a reconciliation. The value: an exit note that came
   * meanwhile, applied by `launch` when it attaches the PTY (so one exit ends a record once).
   */
  // bounded: launches in flight (resource row `core.terminalLaunches`); one whose ptyhost went before it was listed
  // waits as one of L.coreControlWaitersMax calls waiting for the control port, and core shutdown ends it
  private readonly spawning = new Map<string, EndFacts | null>()
  // bounded: one per running shell tab of a session on screen, each with at most one timer and one `STAT` out;
  // dropped when its session is hidden, its tab ends or closes, and at dispose
  private readonly foregrounds = new Map<string, Foreground>()
  /** Each shell record's number (`numberShells`): in memory only, never on a record. */
  // bounded: one per shell record (≤ L.terminalRecordsMax), dropped with its record; one whose record the records' cap
  // made room for goes at the next numbering
  private readonly numbers = new Map<string, number>()
  private readonly clock: Clock
  private readonly offVisible: Disposable | null
  /**
   * Exit notes that came while a reconciliation was reading ptyhost's list and the disk: the list may be older
   * than they are. Null when none is under way.
   */
  private exitsNoted: Map<string, ExitFacts> | null = null // bounded: ≤ live holders, for one reconciliation
  private readonly stateChanged = new Emitter<string>({ name: 'terminals.state' })
  /** A recorded PTY stopped running while core watched (the sessions and the dev servers listen). */
  readonly exits = new Emitter<TerminalExit>({ name: 'terminals.exits' })
  /** Fires when Kea begins to stop a running PTY (`stop`), before any signal: what ends next was ended by Kea. */
  readonly stops = new Emitter<{ ptyId: string; sessionId: string; kind: PtyKind }>({ name: 'terminals.stops' })
  /** Reconciliation, spawn completion and adoption run one at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  private rebuilt = false
  /** The first reconciliation has compared the records with ptyhost's holders: `attached` says which holders core holds. */
  private reconciled = false
  private readonly offSettings: (() => void) | null
  /** The mirror configuration ptyhost was last sent (resent when the settings change it). */
  private configured = ''
  private markRestored!: () => void
  /** The first reconciliation (startup restore). */
  private readonly restored = new Promise<void>((r) => (this.markRestored = r))

  constructor(opts: TerminalsOptions) {
    this.opts = opts
    this.records = opts.records ?? new MemoryRecords()
    this.probe = opts.probe ?? procsProbe(null)
    this.now = opts.now ?? Date.now
    this.clock = opts.clock ?? systemClock
    // A restarted core lists what it recorded before ptyhost answers, so the window keeps its terminals; the
    // first reconciliation then updates each entry in place. Its shells are numbered again, in their order
    this.numberShells()
    for (const r of this.records.list()) this.show(r.ptyId)
    this.offSettings = opts.settings?.onChange(() => this.settingsChanged()) ?? null
    // A session coming on screen has its shell tabs asked once; one leaving gives up what was known
    this.offVisible = opts.visible?.onChange(() => this.screenChanged()) ?? null
  }

  /** A new control port to ptyhost (startup, or either side restarted). */
  setControl(ch: Channel): void {
    this.ptyhost?.dispose()
    this.configured = '' // a new ptyhost has no configuration yet
    const peer: Ptyhost = new RpcPeer(
      ch,
      {
        name: 'core→ptyhost',
        notes: {
          'pty.exit': (a) => this.onNote({ m: 'pty.exit', a } as PtyhostNote),
          'pty.title': (a) => this.onNote({ m: 'pty.title', a } as PtyhostNote),
          'pty.banner': (a) => this.onNote({ m: 'pty.banner', a } as PtyhostNote),
          'pty.bannerCleared': (a) => this.onNote({ m: 'pty.bannerCleared', a } as PtyhostNote),
          // tier 3's signals: core's agent service reads them
          'pty.bell': (a) => this.opts.onActivity?.({ m: 'pty.bell', a } as ActivityNote),
          'pty.oscNotify': (a) => this.opts.onActivity?.({ m: 'pty.oscNotify', a } as ActivityNote),
          'pty.activity': (a) => {
            const { ptyId, active } = a as { ptyId: string; active: boolean }
            this.touched(ptyId, !active) // output that paused: what is in the foreground now is what stays
            this.opts.onActivity?.({ m: 'pty.activity', a } as ActivityNote)
          },
          'pty.keystroke': (a) => {
            this.touched((a as ActivityNote['a']).ptyId)
            this.opts.onActivity?.({ m: 'pty.keystroke', a } as ActivityNote)
          },
        },
        onError: (e) => this.opts.log.warn('control port error', { error: String(e) }),
      },
      ptyhostApi,
    )
    this.ptyhost = peer
    this.opts.onConnect?.()
    for (const w of this.waiters.splice(0)) w.resolve()
    void this.refresh(peer)
  }

  handlers(): Handlers<typeof coreTerminalApi> {
    return {
      'terminal.openShell': (a) => this.openShell(a),
      'terminal.close': ({ ptyId }) => this.close(ptyId),
      'terminal.foreground': ({ ptyId }) => this.foreground(ptyId),
      'terminal.restored': async () => {
        await this.restored
        const all = [...this.store.values()]
        // whether the window opens a first shell: the running shells, and the sessions that have a terminal,
        // running or ended (those a database rebuild brought back are here, though a window's first `sessions` snapshot
        // may be older)
        return {
          shells: all.filter((i) => i.kind === 'shell' && i.state === 'running').length,
          sessions: new Set(all.filter((i) => i.sessionId !== SHELLS_SESSION).map((i) => i.sessionId)).size,
        }
      },
      'terminal.setVisible': async ({ ptyIds }, ctx) => {
        this.visibleBy.set((ctx as { peer?: object } | undefined)?.peer ?? NO_WINDOW, ptyIds)
        this.visible = [...new Set([...this.visibleBy.values()].flat())]
        this.screenChanged() // The shells pane is on screen while a window shows one of its terminals
        const p = await this.control()
        await p.call('pty.setVisible', { ptyIds: this.visibleAttached() })
        return { ok: true }
      },
      'terminal.clear': async ({ ptyId }) => {
        if (!this.attached.has(ptyId)) return { ok: false }
        const p = await this.control()
        return p.call('pty.clear', { ptyId })
      },
      'terminal.lastScreen': ({ ptyId, cols, rows }) => this.lastScreen(ptyId, cols, rows),
      'terminal.adoptOrphan': ({ ptyId }) => this.adoptOrphan(ptyId),
      'terminal.terminateOrphan': ({ ptyId }) => this.terminateOrphan(ptyId),
      'terminal.holders': async () => ({ holders: await this.holders() }),
      'terminal.terminateHolder': async ({ ptyId }) => ({ ok: await this.terminateHolder(ptyId) }),
      'terminal.reloadShellEnv': async () => {
        if (!this.opts.reloadEnv) throw new RpcError('unavailable', 'shell environment reload is not available')
        return { source: await this.opts.reloadEnv() }
      },
      // from the window, never submitted: Enter is core's own, for Continue all
      'terminal.sendText': async ({ sessionId, ptyId, text, bracketed }) => ({ ok: await this.sendText(sessionId, text, { ...(ptyId ? { ptyId } : {}), ...(bracketed ? { bracketed } : {}) }) }),
    }
  }

  /** A shell tab: `$SHELL -l` with the login environment and terminal variables. */
  async openShell(a: { cwd?: string | undefined; cols: number; rows: number }): Promise<{ ptyId: string }> {
    const shell = userShell(await this.opts.env())
    return this.launch({ sessionId: SHELLS_SESSION, kind: 'shell', command: { argv: shellTabArgv(shell) }, cwd: a.cwd ?? os.homedir(), cols: a.cols, rows: a.rows })
  }

  /**
   * Start a PTY for a session. Its record is written before the holder exists, so a core that dies mid-spawn still
   * knows it after restarting. Once the spawn has returned the PTY lives, so a ptyhost that goes before it has listed
   * the PTY does not fail the launch: the next ptyhost is asked (`listedAfterSpawn`, U-PTY-74).
   */
  async launch(req: LaunchRequest): Promise<{ ptyId: string }> {
    if (this.stoppingAll) throw new RpcError('unavailable', 'Kea is quitting and stopping every terminal')
    const env = { ...terminalEnv(await this.opts.env(), this.opts.version), ...req.env }
    for (const k of req.unsetEnv ?? []) delete env[k]
    const spec = spawnSpec(req.command, env, req.cwd)
    const ptyId = req.ptyId ?? newPtyId()
    if (this.records.get(ptyId) || this.spawning.has(ptyId)) throw new RpcError('refused', `a terminal ${ptyId} exists already`)
    const rec: TerminalRecord = {
      ptyId,
      sessionId: req.sessionId,
      kind: req.kind,
      argv: [spec.file, ...spec.args],
      cwd: req.cwd,
      title: req.title ?? null,
      holderPid: null,
      holderStartedAt: null,
      childPid: null,
      cols: req.cols,
      rows: req.rows,
      state: 'running',
      exitCode: null,
      exitSignal: null,
      tabOrder: this.nextTabOrder(req.sessionId),
      createdAt: this.now(),
      endedAt: null,
    }
    this.spawning.set(ptyId, null)
    let p: Ptyhost
    try {
      this.records.put(rec)
      // numbered as its record is made, before anything is awaited: two quick new tabs differ, in their order
      if (rec.kind === 'shell') this.numberShells()
      p = await this.control()
      await p.call('pty.spawn', { ptyId, sessionId: req.sessionId, kind: req.kind, spec, cols: req.cols, rows: req.rows, ringBytes: this.opts.settings?.ringBytes() ?? L.ringBytesDefault, keaVersion: this.opts.version })
    } catch (e) {
      // no holder was started (one that started anyway shows up as an orphan at the next reconciliation)
      this.spawning.delete(ptyId)
      this.forget(ptyId)
      throw e
    }
    await this.serially(async () => {
      let noted: EndFacts | null = null
      const info = await this.listedAfterSpawn(p, ptyId).finally(() => {
        // launched (or not, when no ptyhost lists it: the next reconciliation decides): from here its notes are its record's
        noted = this.spawning.get(ptyId) ?? null
        this.spawning.delete(ptyId)
      })
      // an exit that came while it was being launched (its note was kept, not applied), or that the list already shows
      const exit: EndFacts | null = info && info.state !== 'running' ? { state: info.state, exitCode: info.exitCode, exitSignal: info.exitSignal } : noted
      if (info) this.listed.set(ptyId, exit ? { ...info, ...exit } : info)
      const cur = this.records.get(ptyId)
      if (!cur) {
        // Its record went while it was being launched (its session was deleted, its tab closed): it is never written
        // again, and nobody is told that it ended. Its holder is nobody's now, so it goes too, outside this queue
        // (ending it waits for its exit).
        if (info) {
          void this.endHolder(ptyId).then(
            (gone) => void (gone && this.opts.home && removeStateFiles(this.opts.home, req.sessionId, ptyId)),
            (e) => this.opts.log.warn('holder of a forgotten launch not ended', { ptyId, error: String(e) }),
          )
        }
        return
      }
      const ended = cur.state === 'running' && exit ? { ...exit, endedAt: this.now() } : {}
      if (info) {
        this.attached.add(ptyId)
        const json = this.opts.home ? judge(this.opts.home, ptyId, [{ sessionId: req.sessionId, files: [`${ptyId}.json`] }]).json : null
        this.save({ ...cur, holderPid: info.holderPid, holderStartedAt: json ? startedAtMs(json) : info.holderStartedAt, childPid: info.childPid, ...ended })
      } else if (cur.state === 'running' && exit) this.save({ ...cur, ...ended }) // its holder has gone already
      if (cur.state === 'running' && exit) this.exits.fire({ ptyId, sessionId: req.sessionId, kind: req.kind, ...exit })
      if (!info) return // gone already, with no word of an exit: the next reconciliation decides
      this.show(ptyId)
      this.touched(ptyId) // A new shell tab of a session on screen is asked from the start
    })
    return { ptyId }
  }

  /**
   * Close a tab: hang up its session, terminate what survives, then release the holder and forget the
   * record. A shell tab's state files go with it (below); nothing else of a session loses its files here.
   */
  async close(ptyId: string): Promise<{ ok: boolean }> {
    // which holders exist is known only once the first reconciliation has compared the records with ptyhost's
    // (`releaseEnded`): until then "not attached" is not "no holder", so a close waits for it rather than forget a
    // record, and remove the files, of a holder that runs on unsignalled
    if (!this.reconciled) await this.restored
    const rec = this.records.get(ptyId)
    if (!rec && !this.store.has(ptyId)) return { ok: false }
    let gone = !this.attached.has(ptyId) && !this.unreachable.has(ptyId)
    if (this.attached.has(ptyId)) gone = await this.endHolder(ptyId)
    else if (this.unreachable.has(ptyId)) await this.killUnreachable(ptyId)
    this.forget(ptyId)
    // A closed shell tab is never shown again (its record went just now), so its ring, checkpoint and state file go
    // with the tab, once its holder is gone: a shell of the `shells` pane has no session to be deleted with, and a
    // session's disk must not grow with every tab opened and closed in it. Only a shell: an Agent, Server or Setup
    // terminal keeps its files for its last screen, and a shell that is stopped, not closed (archive, Stop: `stop`),
    // keeps its record and files
    if (gone && rec && (rec.kind === 'shell' || rec.sessionId === SHELLS_SESSION) && this.opts.home) removeStateFiles(this.opts.home, rec.sessionId, ptyId)
    return { ok: true }
  }

  /** "Adopt as shell": the orphan becomes a shell tab of its own session. */
  adoptOrphan(ptyId: string): Promise<{ ptyId: string }> {
    return this.serially(async () => {
      const o = this.orphans.get(ptyId)
      if (!o) throw new RpcError('not_found', `no orphaned holder ${ptyId}`)
      const h = this.listed.get(ptyId)
      if (!o.canAdopt || !h || this.records.get(ptyId)) throw new RpcError('refused', `holder ${ptyId} cannot be adopted (${o.reason}${h ? '' : ', unreachable'})`)
      this.save(recordFromHolder(h, null, this.now(), { kind: 'shell', tabOrder: this.nextTabOrder(h.sessionId) }))
      this.numberShells()
      this.attached.add(ptyId)
      this.orphans.delete(ptyId)
      this.show(ptyId)
      this.touched(ptyId)
      const p = await this.control()
      if (this.visible.includes(ptyId)) await p.call('pty.setVisible', { ptyIds: this.visibleAttached() })
      return { ptyId }
    })
  }

  /**
   * "Terminate": a reachable orphan is ended through ptyhost like a closed tab; an unreachable one by
   * `SIGKILL` to its holder pid, only after its identity (pid, start time, executable) is confirmed again.
   */
  async terminateOrphan(ptyId: string): Promise<{ ok: boolean }> {
    const o = this.orphans.get(ptyId)
    if (!o) throw new RpcError('not_found', `no orphaned holder ${ptyId}`)
    let gone = false
    if (this.listed.has(ptyId)) gone = await this.endHolder(ptyId)
    else if (!(await this.killUnreachable(ptyId))) throw new RpcError('refused', `holder ${ptyId}: its process could not be confirmed, nothing was signalled`)
    this.orphans.delete(ptyId)
    if (gone && o.sessionId === SHELLS_SESSION && !this.records.get(ptyId) && this.opts.home) removeStateFiles(this.opts.home, SHELLS_SESSION, ptyId)
    return { ok: true }
  }

  /**
   * Every holder Kea left running, read from `<KEA_HOME>/run` (a holder's socket is there for as long as it
   * lives) and from the holders' own state files, never from the database or the records: this is what Settings ›
   * Advanced lists, so it must be right when those are wrong or empty. A socket whose holder is known to be dead is not
   * a running process and is left out (reconciliation removes it). Oldest first.
   */
  async holders(): Promise<HolderRow[]> {
    const home = this.opts.home
    if (!home) return []
    const scan = await scanHolders(home, this.probe)
    const rows: HolderRow[] = []
    for (const e of scan.entries.values()) {
      // with the run directory unreadable no socket is known: the state files whose holder process runs stand in
      if (scan.socketsKnown ? !e.socket : e.alive !== true) continue
      if (e.alive === false) continue
      const j = e.json
      rows.push({
        ptyId: e.ptyId,
        sessionId: j?.sessionId ?? null,
        kind: j?.kind ?? null,
        pid: j?.pid ?? null,
        childPid: j?.childPid ?? null,
        startedAt: j ? Math.round(j.pidStartTime / 1000) : null,
        alive: e.alive,
        exited: j?.exited ?? false,
        orphan: this.orphans.has(e.ptyId),
      })
    }
    return rows.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.ptyId.localeCompare(b.ptyId))
  }

  /** Settings' "Terminate" (see `terminal.terminateHolder`). True once the holder's program is gone. */
  async terminateHolder(ptyId: string): Promise<boolean> {
    if (this.orphans.has(ptyId)) return (await this.terminateOrphan(ptyId)).ok
    if (this.attached.has(ptyId) || this.unreachable.has(ptyId)) return this.stop(ptyId, 'terminate', L.shellCloseGraceMs)
    // nothing Kea knows accounts for it (it turned up since the last reconciliation): by pid, identity confirmed first
    return this.killUnreachable(ptyId)
  }

  /** Set once Kea is stopping every terminal to quit: no terminal starts after it. */
  private stoppingAll = false

  /** A quit is about to stop every terminal: none starts from now on. */
  refuseLaunches(): void {
    this.stoppingAll = true
  }

  /**
   * Stop every running terminal of every session and of the shell tabs, for a quit that leaves nothing running: each
   * is terminated (SIGTERM to its tree, SIGKILL after `graceMs`), shells included, since a hangup leaves `nohup` and
   * disowned jobs. No terminal starts meanwhile. Resolves with the
   * PTYs that are still running afterwards.
   */
  async stopAllForQuit(graceMs: number): Promise<string[]> {
    this.stoppingAll = true
    const running = this.records.list().filter((r) => r.state === 'running')
    await Promise.all(running.map((r) => this.stop(r.ptyId, 'terminate', graceMs).catch((e: unknown) => this.opts.log.warn('terminal not stopped (quit)', { ptyId: r.ptyId, error: String(e) }))))
    return this.records.list().filter((r) => r.state === 'running').map((r) => r.ptyId)
  }

  /** The recorded PTYs of a session, in tab order. */
  sessionRecords(sessionId: string): TerminalRecord[] {
    return this.records.list().filter((r) => r.sessionId === sessionId)
  }

  /**
   * The argv of every recorded PTY not known to have ended, as it was launched (the records are read at core's start,
   * so this is known before ptyhost has listed what runs): what an agent's launch files are kept for.
   */
  runningArgvs(): string[][] {
    return this.records.list().filter((r) => r.state === 'running').map((r) => r.argv)
  }

  /** A recorded PTY. */
  record(ptyId: string): TerminalRecord | undefined {
    return this.records.get(ptyId)
  }

  /**
   * End a PTY and keep its record, for Stop and archive; a delete does so before it removes the worktree. `terminate`
   * sends SIGTERM to its process groups and SIGKILL after `graceMs`; `hangup` is a closed tab's SIGHUP first. Then the
   * holder is released; its ring and state file stay until the session is deleted. True once the child is gone.
   */
  async stop(ptyId: string, how: 'terminate' | 'hangup', graceMs: number): Promise<boolean> {
    const asked = this.records.get(ptyId)
    if (asked?.state === 'running') this.stops.fire({ ptyId, sessionId: asked.sessionId, kind: asked.kind })
    if (this.attached.has(ptyId)) {
      const p = await this.control()
      if (this.listed.get(ptyId)?.state === 'running') {
        if (how === 'hangup') {
          await p.call('pty.signal', { ptyId, signo: SIGHUP, target: 'session' }).catch(() => undefined)
          if (!(await this.exited(ptyId, graceMs))) await p.call('pty.terminate', { ptyId, graceMs: 0 }).catch(() => undefined)
        } else await p.call('pty.terminate', { ptyId, graceMs }).catch(() => undefined)
        // SIGKILL follows `graceMs` later; wait for the exit report a little past it
        await this.exited(ptyId, graceMs + L.shellCloseGraceMs)
      }
      const gone = this.listed.get(ptyId)?.state !== 'running'
      await p.call('pty.release', { ptyId }).catch(() => undefined)
      if (gone) this.markEnded(ptyId)
      return gone
    }
    if (this.unreachable.has(ptyId)) {
      const killed = await this.killUnreachable(ptyId)
      if (killed) this.markEnded(ptyId)
      return killed
    }
    const r = this.records.get(ptyId)
    return !r || r.state !== 'running'
  }

  /** Resolves true once the PTY is no longer running, false after `ms`. */
  waitExit(ptyId: string, ms: number): Promise<boolean> {
    if (!this.attached.has(ptyId)) return Promise.resolve(this.records.get(ptyId)?.state !== 'running')
    return this.exited(ptyId, ms)
  }

  /** What runs in a PTY now (a shell tab with a foreground process). Null when ptyhost cannot tell. */
  async stat(ptyId: string): Promise<{ childPid: number; fgPid: number; fgName: string; cwd: string; descendants: number[] } | null> {
    if (!this.attached.has(ptyId)) return null
    const p = await this.control()
    return p.call('pty.stat', { ptyId }).catch(() => null)
  }

  /**
   * Is a program other than the PTY's own child (the shell) in the foreground? The archive check uses this
   * rule. A PTY that has ended is known not to be busy. `known` false: it could not be learned — ptyhost had no
   * answer or does not hold the PTY's holder (a record that still runs), or the holder could not tell which process
   * group has the terminal (0). The answer is then `busy`: closing must not end what may be running without
   * asking.
   */
  async foreground(ptyId: string): Promise<{ busy: boolean; name: string; known: boolean }> {
    const unknown = { busy: true, name: '', known: false }
    if (this.listed.get(ptyId)?.state !== 'running') return this.records.get(ptyId)?.state === 'running' ? unknown : { busy: false, name: '', known: true }
    const st = await this.stat(ptyId)
    if (!st || st.fgPid <= 0) return unknown
    const busy = st.fgPid !== st.childPid
    return { busy, name: busy ? st.fgName : '', known: true }
  }

  /**
   * One signal to a running PTY's child, its foreground process group or its session's groups (a dev server's
   * Stop begins with `SIGINT` to the foreground group, what `⌃C` would do). False when ptyhost does not hold it
   * or it has ended.
   */
  async signal(ptyId: string, signo: number, target: 'child' | 'fg' | 'session'): Promise<boolean> {
    if (!this.attached.has(ptyId) || this.listed.get(ptyId)?.state !== 'running') return false
    const p = await this.control()
    return p.call('pty.signal', { ptyId, signo, target }).then((r) => r.ok, () => false)
  }

  /**
   * The holder's `TERMINATE` and nothing else (the caller follows the exit itself and releases the
   * holder when its Stop is done): `SIGTERM` to everything of the terminal, `SIGKILL` to what survives `graceMs`. Also
   * for a PTY whose child has exited while its holder lingers: the rest of its session is swept. False when ptyhost
   * does not hold it.
   */
  async terminate(ptyId: string, graceMs: number): Promise<boolean> {
    if (!this.attached.has(ptyId)) return false
    const p = await this.control()
    return p.call('pty.terminate', { ptyId, graceMs }).then((r) => r.ok, () => false)
  }

  /**
   * The last `bytes` of a PTY's output, without its screen (a dev server's output is read for its URL), and the
   * output sequence number just past them. Null when ptyhost does not hold the PTY.
   */
  async tail(ptyId: string, bytes: number): Promise<{ bytes: Uint8Array; end: number } | null> {
    if (!this.attached.has(ptyId)) return null
    const p = await this.control()
    const r = await p.call('pty.capture', { ptyId, ringBytes: bytes, screen: false }).catch(() => null)
    return r ? { bytes: r.ring, end: r.end ?? 0 } : null
  }

  /** A PTY's current screen as text (a setup or teardown script's output for the creation log). */
  async captureScreen(ptyId: string): Promise<string | null> {
    if (!this.attached.has(ptyId)) return null
    const p = await this.control()
    const r = await p.call('pty.capture', { ptyId, ringBytes: 0 }).catch(() => null)
    return r?.screen ?? null
  }

  /**
   * Type `text` into one of a session's terminals (`pty.input`): `ptyId`, else its agent terminal. `bracketed`:
   * as a paste, inside bracketed-paste markers (any markers in the text are removed first, so it cannot end the paste
   * early); `submit`: then Enter, in a write of its own. Never without a user gesture: its callers run only from one
   * (Continue all's click; from the window, `terminal.sendText`: a file dragged in, the finder's `⌥↵`, a
   * reference sent, which never submit). False when the session has no such running PTY (none of its own with that id,
   * no agent).
   *
   * This is the gate that makes "never submits" true whoever calls: the text holds nothing a terminal reads as Enter or
   * as a control sequence (`typedData`), or the call is refused, false, with nothing written; the only Enter is the one
   * written here for `submit`.
   */
  async sendText(sessionId: string, text: string, o: { bracketed?: boolean; submit?: boolean; ptyId?: string } = {}): Promise<boolean> {
    const data = typedData(text, o)
    if (data === null) {
      // the text is not logged: it is a name from disk or a prompt
      this.opts.log.warn('sendText refused: the text holds a control character', { sessionId, chars: text.length })
      return false
    }
    const own = this.sessionRecords(sessionId)
    const rec = o.ptyId ? own.find((r) => r.ptyId === o.ptyId) : own.filter((r) => r.kind === 'agent').at(-1)
    if (!rec || !this.attached.has(rec.ptyId) || this.listed.get(rec.ptyId)?.state !== 'running') return false
    const p = await this.control()
    const write = (d: string) => p.call('pty.input', { ptyId: rec.ptyId, data: d }).then((r) => r.ok, () => false)
    if (data !== '' && !(await write(data))) return false
    return o.submit ? write('\r') : true
  }

  /**
   * Forget one ended record (a teardown script's PTY, which is never a tab; an agent PTY a resumed agent replaces); its
   * holder is released first. `files`: its ring, state and checkpoint files go too, once its holder is gone.
   * A holder whose release is not confirmed (it still runs, or ptyhost is away or restarting) may still linger: the
   * record stays, files and all, for the next reconcile to attach and release it, rather than turn up as an orphan.
   */
  async forgetRecord(ptyId: string, o: { files?: boolean } = {}): Promise<void> {
    const rec = this.records.get(ptyId)
    const unreachable = this.unreachable.has(ptyId) // a holder that may still run: its files stay with it
    const gone = await this.releaseEnded(ptyId).catch(() => false)
    if (!gone) {
      this.opts.log.info('record kept: its holder was not released', { ptyId })
      return
    }
    this.listed.delete(ptyId)
    this.forget(ptyId)
    if (o.files && !unreachable && rec && this.opts.home) removeStateFiles(this.opts.home, rec.sessionId, ptyId)
  }

  /**
   * Let an ended PTY's holder go (it lingers after its child exits until released). Its ring and state file stay
   * until the session is deleted, so its last screen still comes from checkpoint + ring. True once ptyhost has
   * confirmed the release (or core holds no holder for it); false while it runs, when the release failed (ptyhost
   * away or restarting: the PTY stays attached, and the next reconcile releases it), while it is still being launched,
   * and before the first reconciliation (which holders exist is not known yet; that reconciliation releases it).
   */
  async releaseEnded(ptyId: string): Promise<boolean> {
    // "Core holds no holder for it" is known only once the first reconciliation has compared the records with
    // ptyhost's holders, and never of a PTY still being launched (`launch` attaches it): until then its holder may
    // exist, and a record forgotten now would leave it an orphan with its files gone
    if (!this.reconciled || this.spawning.has(ptyId)) return false
    if (!this.attached.has(ptyId)) return this.records.get(ptyId)?.state !== 'running'
    if (this.listed.get(ptyId)?.state === 'running') return false
    const p = await this.control()
    const r = await p.call('pty.release', { ptyId }).catch(() => null)
    if (!r?.ok) return false
    this.markEnded(ptyId)
    return true
  }

  /**
   * The last screen of a recorded PTY whose holder is gone: ptyhost renders it from checkpoint + ring on
   * demand; nothing is kept. Null for a PTY ptyhost still holds (its stream has the screen), one with no record, or none
   * kept (a corrupt ring header, C-COR-3).
   */
  async lastScreen(ptyId: string, cols: number, rows: number): Promise<{ cols: number; rows: number; data: string } | null> {
    const rec = this.records.get(ptyId)
    if (!rec || rec.state === 'running' || this.attached.has(ptyId) || this.unreachable.has(ptyId)) return null
    const p = await this.control()
    const s = await p.call('pty.lastScreen', { ptyId, sessionId: rec.sessionId, cols, rows }).catch(() => null)
    return s ? { cols: s.cols, rows: s.rows, data: s.data } : null
  }

  /**
   * On archive, an ended PTY's last screen becomes its checkpoint, covering all its ring holds (ptyhost).
   * True when the ring may go; false while its holder is held or unreachable, or when ptyhost could not fold it.
   */
  async foldCheckpoint(ptyId: string): Promise<boolean> {
    const rec = this.records.get(ptyId)
    if (!rec || rec.state === 'running' || this.attached.has(ptyId) || this.unreachable.has(ptyId)) return false
    const p = await this.control()
    const r = await p.call('pty.foldCheckpoint', { ptyId, sessionId: rec.sessionId }).catch(() => null)
    return r?.written === true
  }

  /** Forget every record of a session that is being deleted (their PTYs have ended): holders released, records and store entries gone. */
  async forgetSession(sessionId: string): Promise<void> {
    // as `close`: before the first reconciliation no holder is attached, and a release would answer "it has none"
    if (!this.reconciled) await this.restored
    for (const r of this.sessionRecords(sessionId)) {
      await this.releaseEnded(r.ptyId).catch(() => false)
      this.listed.delete(r.ptyId)
      this.forget(r.ptyId)
    }
  }

  /** The mirror's colours and scrollback, from the terminal settings. */
  mirrorConfig(): MirrorConfig {
    const s = this.opts.settings?.mirror() ?? { theme: DEFAULT_TERMINAL_SETTINGS.theme, scrollback: DEFAULT_TERMINAL_SETTINGS.scrollback, diskBackedScrollback: true }
    // The colours of the theme in force ("Match Ghostty config" resolves them from the file; core.ts), else the bundled theme's
    const c = s.colors ?? colorThemeOf(s.theme)
    return { ...c, palette: [...c.palette], dark: isDarkTheme(c), scrollback: s.scrollback, diskBackedScrollback: s.diskBackedScrollback }
  }

  /**
   * The resource rows held here: the control connection, calls waiting for it, terminal records, orphaned
   * holders, the shell tabs followed for their title with the rate-limit timers armed and the `STAT`s out,
   * and the PTYs being launched (`spawning`).
   */
  get resourceCounts(): { control: number; waiters: number; records: number; orphans: number; titles: number; titleTimers: number; titleAsks: number; launching: number } {
    let titleTimers = 0
    let titleAsks = 0
    for (const f of this.foregrounds.values()) {
      if (f.timer !== null) titleTimers++
      if (f.asking) titleAsks++
    }
    return { control: this.ptyhost && !this.ptyhost.isDisposed ? 1 : 0, waiters: this.waiters.length, records: this.records.list().length, orphans: this.orphans.size, titles: this.foregrounds.size, titleTimers, titleAsks, launching: this.spawning.size }
  }

  /**
   * A window went (closed, reloaded, crashed): it shows no terminal any more, so the shells pane is not on
   * screen unless another window shows it. `window`: its connection; none: every window. With no window
   * left ptyhost is told nothing (the next window says what it shows); otherwise what the others still show.
   */
  windowGone(window?: object): void {
    if (window) this.visibleBy.delete(window)
    else this.visibleBy.clear()
    this.visible = [...new Set([...this.visibleBy.values()].flat())]
    this.screenChanged()
    if (this.visibleBy.size > 0) {
      void this.control()
        .then((p) => p.call('pty.setVisible', { ptyIds: this.visibleAttached() }))
        .catch(() => undefined)
    }
  }

  dispose(): void {
    this.offSettings?.()
    this.offVisible?.dispose()
    for (const id of [...this.foregrounds.keys()]) this.dropForeground(id)
    this.ptyhost?.dispose()
    this.ptyhost = null
    for (const w of this.waiters.splice(0)) w.reject(new RpcError('unavailable', 'core is shutting down'))
    this.store.dispose()
    this.orphans.dispose()
    this.stateChanged.dispose()
    this.exits.dispose()
    this.stops.dispose()
    this.listed.clear()
    this.numbers.clear()
  }

  // ── internals ─────────────────────────────────────────────────────────────────────

  /** Ptyhost's control port, waiting for the next one while ptyhost is away: at most L.coreControlWaitersMax calls wait. */
  private control(): Promise<Ptyhost> {
    if (this.ptyhost && !this.ptyhost.isDisposed) return Promise.resolve(this.ptyhost)
    if (this.waiters.length >= L.coreControlWaitersMax) return Promise.reject(new RpcError('unavailable', 'ptyhost is not connected'))
    return new Promise((resolve, reject) => this.waiters.push({ resolve: () => resolve(this.ptyhost as Ptyhost), reject }))
  }

  /**
   * A launched PTY as ptyhost lists it once its spawn has returned. When the ptyhost that spawned it goes before
   * it has answered, the holder lives on (detached), so the launch is not refused: it waits for the next control port
   * (one of L.coreControlWaitersMax waiting calls) and asks the next ptyhost, which answers once it has adopted the
   * holders it found. The PTY stays marked as launching meanwhile, so no reconciliation judges it and an exit
   * note is kept for the launch to apply. Undefined: no ptyhost lists it (the reconciliation that follows decides).
   */
  private async listedAfterSpawn(p: Ptyhost, ptyId: string): Promise<PtyInfo | undefined> {
    for (let peer = p; ; peer = await this.control()) {
      try {
        return (await peer.call('pty.list', {})).find((i) => i.ptyId === ptyId)
      } catch (e) {
        if (!peer.isDisposed) throw e
        this.opts.log.info('ptyhost went while a terminal was being launched: the next one is asked for it', { ptyId })
      }
    }
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private visibleAttached(): string[] {
    return this.visible.filter((id) => this.attached.has(id))
  }

  private nextTabOrder(sessionId: string): number {
    return this.records.list().reduce((n, r) => (r.sessionId === sessionId ? Math.max(n, r.tabOrder + 1) : n), 0)
  }

  /**
   * Number each shell record that has no number yet, in the order the store lists records (`byListOrder`): 1 + the
   * highest number among its session's shell records, 1 when none. A number once given is never changed; one whose
   * record is gone is dropped.
   */
  private numberShells(): void {
    const shells = this.records.list().filter((r) => r.kind === 'shell')
    const ids = new Set(shells.map((r) => r.ptyId))
    for (const id of [...this.numbers.keys()]) if (!ids.has(id)) this.numbers.delete(id)
    const highest = new Map<string, number>()
    for (const r of shells) {
      const n = this.numbers.get(r.ptyId)
      if (n !== undefined) highest.set(r.sessionId, Math.max(highest.get(r.sessionId) ?? 0, n))
    }
    for (const r of shells.filter((x) => !this.numbers.has(x.ptyId)).sort(byListOrder)) {
      const n = (highest.get(r.sessionId) ?? 0) + 1
      highest.set(r.sessionId, n)
      this.numbers.set(r.ptyId, n)
    }
  }

  /** Persist a record; a failed write is logged and the store still follows the change. */
  private save(...rs: TerminalRecord[]): void {
    try {
      this.records.putMany(rs)
    } catch (e) {
      this.opts.log.error('terminal records not written', { error: (e as Error).message })
    }
  }

  /** A stopped PTY's record says it ended (its exit note may not have come yet). */
  private markEnded(ptyId: string): void {
    const r = this.records.get(ptyId)
    const h = this.listed.get(ptyId)
    if (r && r.state === 'running') {
      const state = h && h.state !== 'running' ? h.state : 'exited'
      this.save({ ...r, state, exitCode: h?.exitCode ?? r.exitCode, exitSignal: h?.exitSignal ?? r.exitSignal, endedAt: this.now() })
      this.exits.fire({ ptyId, sessionId: r.sessionId, kind: r.kind, state, exitCode: h?.exitCode ?? null, exitSignal: h?.exitSignal ?? null })
    }
    this.attached.delete(ptyId)
    this.unreachable.delete(ptyId)
    this.listed.delete(ptyId)
    this.dropForeground(ptyId)
    this.show(ptyId)
  }

  private forget(ptyId: string): void {
    this.attached.delete(ptyId)
    this.unreachable.delete(ptyId)
    this.numbers.delete(ptyId)
    this.dropForeground(ptyId)
    try {
      this.records.delete(ptyId)
    } catch (e) {
      this.opts.log.error('terminal record not deleted', { ptyId, error: (e as Error).message })
    }
    this.store.delete(ptyId)
  }

  /** The store entry for a recorded PTY: ptyhost's live info when attached, the record otherwise. */
  private show(ptyId: string): void {
    const r = this.records.get(ptyId)
    if (!r) return
    const h = this.attached.has(ptyId) ? this.listed.get(ptyId) : undefined
    const fg = this.foregrounds.get(ptyId)?.name
    const n = this.numbers.get(ptyId)
    const number = n !== undefined ? { number: n } : {}
    const info: PtyInfo = h
      ? { ...h, kind: r.kind, title: r.kind === 'script' && r.title ? r.title : h.title, ...(fg ? { foreground: fg } : {}), ...number }
      : {
          ptyId,
          sessionId: r.sessionId,
          kind: r.kind,
          state: r.state,
          holderPid: r.holderPid,
          holderStartedAt: r.holderStartedAt,
          childPid: r.childPid,
          cwd: r.cwd,
          argv: r.argv,
          cols: r.cols,
          rows: r.rows,
          exitCode: r.exitCode,
          exitSignal: r.exitSignal,
          detached: false,
          title: r.title,
          ...number,
        }
    const cur = this.store.get(ptyId)
    if (!cur || JSON.stringify(cur) !== JSON.stringify(info)) this.store.set(ptyId, info)
  }

  private async refresh(p: Ptyhost): Promise<void> {
    try {
      await this.configure(p)
      await this.opts.ready?.catch(() => undefined)
      await this.reconcile(p)
      if (this.visible.length) await p.call('pty.setVisible', { ptyIds: this.visibleAttached() })
      this.markRestored()
      // once per ptyhost connection: when every live PTY ptyhost adopted is known again (P-START-4 times it)
      this.opts.log.info('ptyhost reconciled', { attached: this.attached.size, unreachable: this.unreachable.size })
    } catch (e) {
      this.opts.log.warn('ptyhost refresh failed', { error: (e as Error).message })
    }
  }

  /** Send the mirror configuration unless ptyhost already has it. */
  private async configure(p: Ptyhost): Promise<void> {
    const c = this.mirrorConfig()
    const key = JSON.stringify(c)
    if (key === this.configured) return
    await p.call('pty.configure', c)
    if (p === this.ptyhost) this.configured = key
  }

  /** Terminal settings apply live — the mirrors get the new colours and scrollback at once. */
  private settingsChanged(): void {
    const p = this.ptyhost
    if (!p || p.isDisposed) return
    this.configure(p).catch((e) => this.opts.log.warn('mirror configuration not sent', { error: (e as Error).message }))
  }

  /** Reconcile the records with ptyhost's holders and the disk (reconcile.ts). Never disturbs a live holder. */
  private reconcile(p: Ptyhost): Promise<void> {
    return this.serially(async () => {
      const home = this.opts.home
      // An exit note may overtake this reconciliation: ptyhost answers the list, the child exits, and its note is here
      // before the disk has been read. An exit is final, so what a note said is laid over the older list; otherwise the
      // record would have ended while its holder still read "running", an orphan that nothing ever releases
      const noted = new Map<string, ExitFacts>()
      this.exitsNoted = noted
      let answered: PtyInfo[]
      let scan: HolderScan | null
      try {
        answered = await p.call('pty.list', {})
        scan = home ? await scanHolders(home, this.probe) : null
      } finally {
        if (this.exitsNoted === noted) this.exitsNoted = null
      }
      const list = answered.map((h) => {
        const x = noted.get(h.ptyId)
        return x && h.state === 'running' ? { ...h, ...x } : h
      })
      const first = !this.rebuilt
      const records = this.records
      const rebuild = (sessionId: string) => first && (records.rebuildsSession ? records.rebuildsSession(sessionId) : !records.loaded)
      const plan = planReconcile({ records: this.records.list(), holders: list, scan, spawning: new Set(this.spawning.keys()), rebuild, now: this.now() })
      this.rebuilt = true
      if (plan.put.length) this.save(...plan.put)
      this.numberShells() // records rebuilt from the holders
      this.listed.clear()
      for (const i of list) this.listed.set(i.ptyId, i)
      this.attached = new Set(plan.attached)
      this.unreachable = new Set(plan.unreachable)
      this.reconciled = true
      this.orphans.replace(Object.fromEntries(plan.orphans.map((o) => [o.ptyId, o])), (x, y) => JSON.stringify(x) === JSON.stringify(y))
      for (const id of [...this.store.keys()]) if (!this.records.get(id)) this.store.delete(id)
      for (const r of this.records.list()) this.show(r.ptyId)
      for (const i of list) this.stateChanged.fire(i.ptyId) // a close waiting for an exit whose note was missed
      if (home) this.clean(home, plan)
      // an ended PTY's holder holds nothing: let it go now (its ring and state file stay)
      for (const id of plan.release) void this.releaseEnded(id).catch(() => false)
      this.screenChanged() // What is attached changed
      this.report(plan)
      this.opts.onReconciled?.(plan)
    })
  }

  /** Sockets of dead holders, and the `shells` pseudo-session's files of PTYs nobody knows (C-COR-6). */
  private clean(home: string, plan: ReconcilePlan): void {
    for (const id of plan.staleSockets) {
      const sock = socketPath(runDir(home), id)
      if (!isOwnSocket(sock)) continue
      try {
        fs.unlinkSync(sock)
      } catch (e) {
        this.opts.log.warn('stale socket not removed', { ptyId: id, error: (e as Error).message })
      }
    }
    for (const d of plan.deadFiles) removeStateFiles(home, d.sessionId, d.ptyId)
  }

  private report(plan: ReconcilePlan): void {
    const log = this.opts.log
    for (const i of plan.ignored) log.warn('holder not trusted', i)
    for (const r of plan.ended) log.info('terminal ended while away', { ptyId: r.ptyId, sessionId: r.sessionId, state: r.state })
    for (const id of plan.unreachable) log.warn('holder alive but not connected to ptyhost', { ptyId: id })
    if (plan.orphans.length || plan.staleSockets.length || plan.deadFiles.length || plan.detachedSessions.length) {
      log.info('terminals reconciled', {
        attached: plan.attached.length,
        orphans: plan.orphans.map((o) => `${o.ptyId}:${o.reason}`),
        staleSockets: plan.staleSockets.length,
        deadFiles: plan.deadFiles.length,
        detachedSessions: plan.detachedSessions,
      })
    }
  }

  private onNote(n: PtyhostNote): void {
    switch (n.m) {
      case 'pty.exit': {
        const { ptyId, sessionId, code, signal, lost } = n.a
        const state = lost ? 'lost' : 'exited'
        this.exitsNoted?.set(ptyId, { state, exitCode: code, exitSignal: signal })
        const cur = this.listed.get(ptyId)
        if (cur) this.listed.set(ptyId, { ...cur, state, exitCode: code, exitSignal: signal })
        const r = this.records.get(ptyId)
        // one still being launched: `launch` ends its record when it attaches it (nothing may forget it before)
        if (this.spawning.has(ptyId)) this.spawning.set(ptyId, { state, exitCode: code, exitSignal: signal })
        else if (r && r.state === 'running' && r.sessionId === sessionId) {
          this.save({ ...r, state, exitCode: code, exitSignal: signal, endedAt: this.now(), title: r.kind === 'script' ? r.title : (cur?.title ?? r.title) })
          this.show(ptyId)
          this.exits.fire({ ptyId, sessionId, kind: r.kind, state, exitCode: code, exitSignal: signal })
        }
        const o = this.orphans.get(ptyId)
        if (o) this.orphans.set(ptyId, { ...o, state })
        if (this.dropForeground(ptyId)) this.show(ptyId)
        this.stateChanged.fire(ptyId)
        return
      }
      case 'pty.title': {
        const cur = this.listed.get(n.a.ptyId)
        if (cur && cur.title !== n.a.title) {
          this.listed.set(n.a.ptyId, { ...cur, title: n.a.title })
          if (this.attached.has(n.a.ptyId)) this.show(n.a.ptyId)
        }
        return
      }
      case 'pty.banner':
        this.opts.log.warn('ptyhost banner', n.a)
        this.opts.onBanner?.(n.a)
        return
      case 'pty.bannerCleared':
        this.opts.log.info('ptyhost banner cleared', n.a)
        this.opts.onBannerCleared?.(n.a.kind)
        return
      default:
        return
    }
  }

  // ── shell tab titles ──────────────────────────────────────────────────────────────────────────────

  /** A session is on screen: a window shows it; the shells pseudo-session while the window shows one of its terminals. */
  private onScreen(sessionId: string): boolean {
    if (sessionId === SHELLS_SESSION) return this.visible.some((id) => this.records.get(id)?.sessionId === SHELLS_SESSION)
    return this.opts.visible?.has(sessionId) ?? false
  }

  /** A running shell tab ptyhost holds, of a session on screen: the only PTYs asked for their foreground process. */
  private titled(ptyId: string): boolean {
    const r = this.records.get(ptyId)
    return !!r && r.kind === 'shell' && r.state === 'running' && this.attached.has(ptyId) && this.listed.get(ptyId)?.state === 'running' && this.onScreen(r.sessionId)
  }

  /**
   * Something happened in a PTY: what runs in its foreground may have changed. `settled`: its output paused (ptyhost's
   * note, a reporting window after the last byte), so what is asked now is what stays.
   */
  private touched(ptyId: string, settled = false): void {
    if (this.titled(ptyId)) this.askSoon(ptyId, settled)
  }

  /** What is on screen changed: tabs that came on screen are asked once, tabs that left give up what was known. */
  private screenChanged(): void {
    for (const id of [...this.foregrounds.keys()]) if (!this.titled(id) && this.dropForeground(id)) this.show(id)
    for (const r of this.records.list()) if (r.kind === 'shell' && !this.foregrounds.has(r.ptyId) && this.titled(r.ptyId)) this.askSoon(r.ptyId, true)
  }

  /**
   * Ask a tab's holder what runs in its foreground. `now` (the tab came on screen; its output paused): at once, and a
   * timer that was due is taken back, so a quiet tab holds none. Otherwise (output started, a key): at once when
   * L.tabTitleStatMs have passed since the tab's last ask, else once when they have. That timer is the only one: it is
   * armed only by something happening in the tab, and it never keeps core alive.
   */
  private askSoon(ptyId: string, now: boolean): void {
    let f = this.foregrounds.get(ptyId)
    if (!f) {
      f = { name: null, pid: 0, askedAt: Number.NEGATIVE_INFINITY, timer: null, asking: false, again: null }
      this.foregrounds.set(ptyId, f)
    }
    if (now && f.timer !== null) {
      this.clock.clearTimeout(f.timer)
      f.timer = null
    }
    if (f.timer !== null) return // one is due, and will see this too
    if (f.asking) {
      if (now || f.again === null) f.again = now ? 'now' : 'soon'
      return
    }
    const entry = f
    const wait = now ? 0 : entry.askedAt + L.tabTitleStatMs - this.clock.now()
    if (wait <= 0) return void this.askForeground(ptyId, entry)
    entry.timer = this.clock.setTimeout(() => {
      entry.timer = null
      void this.askForeground(ptyId, entry)
    }, wait)
    ;(entry.timer as { unref?: () => void }).unref?.()
  }

  private async askForeground(ptyId: string, f: Foreground): Promise<void> {
    if (this.foregrounds.get(ptyId) !== f) return
    if (!this.titled(ptyId)) {
      if (this.dropForeground(ptyId)) this.show(ptyId)
      return
    }
    f.askedAt = this.clock.now()
    f.asking = true
    const st = await this.stat(ptyId).catch(() => null)
    f.asking = false
    if (this.foregrounds.get(ptyId) !== f) return // hidden, ended or closed meanwhile
    if (!this.titled(ptyId)) {
      if (this.dropForeground(ptyId)) this.show(ptyId)
      return
    }
    if (st && st.fgPid > 0) {
      const name = st.fgName || null
      f.pid = st.fgPid
      if (name !== f.name) {
        f.name = name
        this.show(ptyId)
      }
    }
    // what happened while the holder was answering: the answer may be from before it
    const again = f.again
    f.again = null
    if (again) this.askSoon(ptyId, again === 'now')
  }

  /** Forget a tab's foreground process and its timer. True when a name was showing (the caller updates the store entry). */
  private dropForeground(ptyId: string): boolean {
    const f = this.foregrounds.get(ptyId)
    if (!f) return false
    if (f.timer !== null) this.clock.clearTimeout(f.timer)
    f.timer = null
    this.foregrounds.delete(ptyId)
    return f.name !== null
  }

  /** End a holder ptyhost holds: SIGHUP its session, terminate what survives, release it. True once its child is gone. */
  private async endHolder(ptyId: string): Promise<boolean> {
    const p = await this.control()
    if (this.listed.get(ptyId)?.state === 'running') {
      await p.call('pty.signal', { ptyId, signo: SIGHUP, target: 'session' }).catch(() => undefined)
      if (!(await this.exited(ptyId, L.shellCloseGraceMs))) {
        await p.call('pty.terminate', { ptyId, graceMs: 0 }).catch(() => undefined)
        await this.exited(ptyId, L.shellCloseGraceMs)
      }
    }
    const gone = this.listed.get(ptyId)?.state !== 'running'
    await p.call('pty.release', { ptyId }).catch(() => undefined)
    if (gone) this.listed.delete(ptyId)
    return gone
  }

  /** `SIGKILL` a holder ptyhost cannot reach, only if its pid is still that holder (C-COR-6). True if signalled. */
  private async killUnreachable(ptyId: string): Promise<boolean> {
    const home = this.opts.home
    if (!home) return false
    const e = await inspectHolder(home, ptyId, this.probe)
    if (e.identity !== 'trusted' || e.alive !== true || !e.json) {
      this.opts.log.warn('holder not signalled: identity not confirmed', { ptyId, identity: e.identity, alive: e.alive })
      return false
    }
    try {
      process.kill(e.json.pid, 'SIGKILL')
      this.opts.log.info('unreachable holder killed', { ptyId, pid: e.json.pid })
      return true
    } catch {
      return false
    }
  }

  /** Resolves true once the PTY is no longer running, false after `ms`. */
  private exited(ptyId: string, ms: number): Promise<boolean> {
    const done = () => this.listed.get(ptyId)?.state !== 'running'
    if (done()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const sub = this.stateChanged.event((id) => {
        if (id !== ptyId || !done()) return
        cleanup()
        resolve(true)
      })
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, ms)
      const cleanup = () => {
        sub.dispose()
        clearTimeout(timer)
      }
    })
  }
}
