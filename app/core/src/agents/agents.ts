// Core's agent service: the adapter registry in core.
//
//   detection   each adapter's CLI is detected in the background at start, when its `agents.<id>.command` changes and
//               on `agents.refresh`. The result and the adapter's options for that version are the `agents` store's
//               rows, so the composer never waits for a detection. Dangerous permission modes are listed only when
//               `agents.<id>.allowDangerousModes` is on.
//   launch      `command` is the sessions' AgentCommand seam: the adapter's argv for a start (a pre-assigned
//               conversation id), Resume (its resume command) or Restart (a fresh conversation), with its environment
//               edits. A CLI that is not installed fails the launch with the install command.
//   signals     per live agent session (bounded by the live agent PTYs): the adapter's SessionSignals, fed by
//                 hooks     envelopes from the intake socket or the session's spool. A live envelope is applied first,
//                           live, then the session's spool is drained; the status machine places each by its emission
//                           time. Each envelope id is applied once, whichever way it came first: a line that a busy or
//                           hung core read late was spooled too, and the live copy wins. A drained envelope is quiet
//                           (`spooled`, no notification) only if it was emitted before this core started; one emitted
//                           since (a busy core, the intake down) notifies as usual. An envelope stamped before the
//                           agent's launch is an earlier agent's (a Resume's leftover spool): it is not applied at all;
//                 tier 1b   the agent's live status file, watched read-only from the PTY's child pid. It is a full
//                           exact source: every reading goes to the engine, a file just registered with no status too,
//                           since it answers the trust question. A busy → idle change inside an open turn is an
//                           interrupt after L.statusFileInterruptGraceMs unless a Stop arrives first; after a Stop that
//                           comes while the file says busy, the file is read again once that grace has passed (a Stop
//                           hook can keep the turn going); an unknown wait is logged once per session;
//                 tier 2    the transcript, tailed only while `starting`/`working`/`blocked`;
//                 tier 3    ptyhost's activity notes for the agent's PTY (output started/stopped, keystrokes, bells,
//                           OSC 9/777) through adapters/kit's `Tier3`, one timer while its next decision waits. Once a
//                           hook or a status-file reading has come, tier 3 never overrides them: it neither starts nor
//                           finishes a turn nor raises attention. The user-input rule (output after typing into a
//                           blocked agent starts the turn) still applies while the session has hooks but no status
//                           file (the file says itself when a prompt is answered); typing into a blocked agent is
//                           `userTyped`;
//               and every AgentEvent goes to the status engine's `ingest` with its tier as the source.
//   reconcile   at start (and for a session first seen live: a rebuilt one), each live agent session's spool is
//               drained, then its transcript tail decides the status. When an agent PTY ends, the tail's cost-state and
//               title are written for the detached session.
//
// Hooks a launching agent sends before its session turns live wait (≤ L.signalRingEntries per session) and are applied
// when it does, with their own times: the status engine places the spawn at the launch (`launchedAt`), so they follow
// it; an envelope emitted before the launch belongs to an earlier agent and is dropped.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { type Logger } from '@kea/kit'
import {
  AGENTS_STORE,
  agentsApi,
  KeyedStore,
  L,
  type AgentEvent,
  type AgentInfo,
  type Handlers,
  type LaunchConfig,
  type Phase,
  type PtyInfo,
  type SessionView,
  type StatusSource,
  zAgentEvent,
  zStatusFileReading,
} from '@kea/protocol'
import { atMention, Tier3, type AdapterRegistry, type AgentAdapter, type Detection, type Env, type LaunchContext, type ReconcileResult, type SessionSignals, type SpawnSpec, type TranscriptWatch } from '@kea/adapters'
import type { StatusBatch } from '../platform/db/batch.ts'
import type { KeaDb } from '../platform/db/db.ts'
import { SHELL_AGENT } from '../sessions/rebuild.ts'
import type { AgentLaunchCommand, AgentLaunchHow, AgentLaunchSession } from '../sessions/sessions.ts'
import type { SettingsFile } from '../settings/settings.ts'
import type { StatusEngine } from '../status/engine.ts'
import type { ActivityNote } from '../terminal/terminals.ts'
import { LOGIN_SHELL_ARG0, LOGIN_SHELL_SCRIPT } from '../terminal/spawn.ts'
import { installAgentFiles, installHookHelper } from './helper.ts'
import { EnvelopeIds, HookIntake, type Envelope } from './intake.ts'
import { drainSpool, hasSpool, SPOOL_LOCK_FLAG, spooledSessions } from './spool.ts'
import type { WatchService } from '../platform/watch/service.ts'
import { Watcher } from '../platform/watch/watcher.ts'
import { AgentWatches, type FileWatch } from './watch.ts'

export interface AgentServiceOptions {
  home: string
  version: string
  log: Logger
  db: KeaDb
  registry: AdapterRegistry
  settings: SettingsFile
  /** The login-shell environment: detection's PATH, the launch's base environment. */
  env(): Promise<Env>
  /** The kea-helper Kea ships (hooks run a per-build copy of it, helper.ts); null: agents cannot be given hooks. */
  helperSource: string | null
  /** Core's `sessions` store: lifecycle, agent and phase of every session. */
  sessions: KeyedStore<SessionView>
  /** Core's `terminals` store: each agent PTY's child pid (the status file's name). */
  terminals: KeyedStore<PtyInfo>
  /**
   * The argv of every PTY not known to have ended, as recorded at its launch: a launch-files folder one of them names
   * is kept (helper.ts). Core gives the terminal records, which it knows from its start, before ptyhost has listed
   * what runs. Default: the running rows of `terminals`.
   */
  runningArgvs?: () => Iterable<readonly string[]>
  status: Pick<StatusEngine, 'ingest' | 'statusFile' | 'reconcile' | 'userTyped' | 'state'>
  /** Writes for a detached session (cost after the agent exits). */
  batch: Pick<StatusBatch, 'queue'>
  /** Listen on the hook socket (default true; unit tests feed envelopes directly). */
  intake?: boolean
  /** Core's watch service, which follows the status files and transcripts. Default: one of this service's own. */
  watch?: WatchService
  now?: () => number
  /**
   * Core's monotonic clock (ns): `process.hrtime`, the status engine's. Envelopes' stamps, on the helper's clock that
   * stops while the machine sleeps, are converted to it (`toHrtime`).
   */
  mono?: () => bigint
  /** The open flag that takes a spool under the hook's lock (`spool.ts`; default the OS layer's, 0 where it has none: Linux). */
  spoolLockFlag?: number
}

/** One live agent session's signal state. */
interface Live {
  id: string
  adapter: AgentAdapter
  signals: SessionSignals
  /** When the agent was launched (ns, core's clock), or null for a session first seen live (restored). */
  launched: bigint | null
  /** Its launch can report nothing (`SpawnSpec.silent`); false for a session first seen live. */
  silent: boolean
  /** Whether any hook has arrived (the first one confirms the repo's trust even when it maps to nothing). */
  hooked: boolean
  /** Whether a status-file reading has come (a file just registered included): the user-input rule is off. */
  fileSeen: boolean
  /** An unknown wait was logged for this session (once, for the contract to learn the value). */
  unknownWaitLogged: boolean
  /** A Stop came while the file said busy: the file is read again when this fires (a Stop hook may keep the turn going). */
  stopCheckTimer: ReturnType<typeof setTimeout> | null
  /** A drain found a helper appending to the spool (its lock held): one more drain when this fires. */
  spoolRetry: ReturnType<typeof setTimeout> | null
  pid: number | null
  statusPath: string | null
  /** Looked at again at each sign of the agent's life while the file is not there yet (U-AGT-35). */
  statusWatch: FileWatch | null
  interruptTimer: ReturnType<typeof setTimeout> | null
  /** Tier 3 over the agent PTY's activity; `tier3.tier1` once a hook or a status-file reading came. */
  tier3: Tier3
  /** When `tier3` next has something to decide (its deadline), else null. */
  tier3Timer: ReturnType<typeof setTimeout> | null
  transcriptPath: string | null
  transcriptWatch: TranscriptWatch | null
  /** The transcript the watch follows (re-armed when /clear moves it). */
  watchedTranscript: string | null
  /** Where the last watch of `readTranscript` stopped: the next turn's watch starts there (U-AGT-19). */
  readTranscript: string | null
  readTo: number
}

/** Envelopes of a launching agent, waiting for its session to turn live. */
interface Pending {
  adapter: string
  /** The launch's time (ns): envelopes emitted earlier belong to an earlier agent. */
  since: bigint
  /** The agent was started with a prompt in its argv (tier 3 counts it as the first turn's keystroke). */
  prompted: boolean
  /** The adapter said this launch can report nothing (`SpawnSpec.silent`): no trust window for it. */
  silent: boolean
  envs: Envelope[]
  dropped: number
}

/** Phases in which titles, interrupts and usage appear in the transcript. */
const TRANSCRIPT_PHASES: ReadonlySet<Phase> = new Set<Phase>(['starting', 'working', 'blocked'])

const NO_DETECTION: Detection = { installed: false, path: null, version: null, supported: true, loggedIn: null, notice: null }

export class AgentService {
  /** `agents`: one row per adapter, plus the `shell` pseudo-agent. */
  readonly store = new KeyedStore<AgentInfo>(AGENTS_STORE)
  readonly intake: HookIntake | null
  /** The status-file and transcript watches, held through core's watch service. */
  readonly watches: AgentWatches
  /** The watch service made here when none was given (unit tests): closed with this service. */
  private readonly ownWatch: Watcher | null
  /** Counters for the resource report and tests. */
  readonly stats = { envelopes: 0, unknownSession: 0, wrongAdapter: 0, early: 0, stale: 0, malformed: 0, oversize: 0, duplicates: 0, spoolDrains: 0, spoolApplied: 0, spoolSkipped: 0, interrupts: 0, invalidEvents: 0, foreignTranscript: 0 }
  private readonly o: AgentServiceOptions
  private readonly now: () => number
  private readonly mono: () => bigint
  // bounded: one per adapter: the last detection, when it ran, the override it used and the binary as it was then (a
  // launch detects again when it changed: C-RES-11)
  private readonly detections = new Map<string, { det: Detection; at: number; command: string | null; stamp: string | null }>()
  // bounded: one per adapter, while a detection runs
  private readonly detecting = new Map<string, Promise<Detection>>()
  // bounded: one per live agent session
  private readonly live = new Map<string, Live>()
  // bounded: one per session launching an agent, each ≤ L.signalRingEntries envelopes
  private readonly pending = new Map<string, Pending>()
  // bounded: one per session in the `sessions` store
  private readonly lifecycles = new Map<string, SessionView['lifecycle']>()
  /** The envelope ids each launching or live session took (a late copy of one is dropped). */
  private readonly ids = new EnvelopeIds()
  private loginEnv: Env = {}
  private helperPath: string | null = null
  private readonly offs: (() => void)[] = []
  private disposed = false
  /** The intake's refused count at the last spool sweep. */
  private refusedSwept = 0
  /** process.hrtime − the helper's monotonic clock (ns), held while envelopes agree (`toHrtime`). */
  private clockOffset: bigint | null = null
  /** When this core started (ns, core's clock): a drained envelope emitted earlier could never have been shown live. */
  private readonly born: bigint

  constructor(o: AgentServiceOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.mono = o.mono ?? (() => process.hrtime.bigint())
    this.born = this.mono()
    this.ownWatch = o.watch ? null : new Watcher({ log: o.log })
    this.watches = new AgentWatches(o.watch ?? (this.ownWatch as Watcher))
    this.intake = o.intake === false ? null : new HookIntake({ home: o.home, log: o.log, onEnvelope: (e) => this.envelope(e), onClose: () => this.connectionClosed() })
    this.publishAll()
    for (const v of o.sessions.values()) {
      this.lifecycles.set(v.id, v.lifecycle)
      if (v.lifecycle === 'live') this.startLive(v, true)
    }
    this.offs.push(
      o.sessions.onDelta((d) => {
        for (const id of d.del ?? []) this.forget(id)
        for (const [id, v] of Object.entries(d.set ?? {})) this.sessionChanged(id, v)
      }),
      o.terminals.onDelta((d) => {
        for (const v of Object.values(d.set ?? {})) if (v.kind === 'agent') this.armStatusFile(v.sessionId)
        if (d.del?.length) for (const id of [...this.live.keys()]) this.armStatusFile(id)
      }),
      o.settings.onChange(() => this.settingsChanged()),
    )
  }

  /** Background start work: the hook socket, the launch drain of every spool, the first detection. */
  async start(): Promise<void> {
    if (this.intake) await this.intake.start()
    this.launchDrain()
    try {
      this.loginEnv = await this.o.env()
    } catch (e) {
      this.o.log.warn('agents: no login-shell environment for detection', { error: String(e) })
    }
    // sessions restored before the environment was known look for their status files again
    this.rearmStatusFiles()
    await Promise.all(this.o.registry.list().map((a) => this.detect(a.id)))
  }

  // ── detection and the `agents` store ──────────────────────────────────────────────────────────

  /**
   * The cached detection, or the one in flight, or a new one. A cached one older than the adapter's `detectionTtlMs`
   * (its lists are the CLI's own) is still the answer, and is renewed in the background.
   */
  detection(id: string): Promise<Detection> {
    const d = this.detections.get(id)
    if (d && d.command === this.override(id)) {
      const ttl = this.o.registry.get(id)?.detectionTtlMs
      if (ttl !== undefined && this.now() - d.at >= ttl && !this.detecting.has(id)) void this.detect(id)
      return Promise.resolve(d.det)
    }
    return this.detecting.get(id) ?? this.detect(id)
  }

  /** Detect `id` again (one at a time per adapter; a call while one runs gets that one). */
  detect(id: string): Promise<Detection> {
    const a = this.o.registry.get(id)
    if (!a) return Promise.resolve(NO_DETECTION)
    const running = this.detecting.get(id)
    if (running) return running
    const command = this.override(id)
    const p = (async () => {
      let env = this.loginEnv
      try {
        env = await this.o.env()
        this.loginEnv = env
        this.rearmStatusFiles()
      } catch {
        // the last one
      }
      const det = await a.detect(env, command).catch((e: unknown): Detection => ({ ...NO_DETECTION, notice: `Detection failed: ${String(e)}` }))
      return { det, stamp: det.path ? binaryStamp(det.path) : null }
    })()
    const q = p.then((r) => r.det)
    this.detecting.set(id, q)
    void p.then(({ det, stamp }) => {
      this.detecting.delete(id)
      if (this.disposed) return
      this.detections.set(id, { det, at: this.now(), command, stamp })
      this.o.log.info('agent detected', { agent: id, installed: det.installed, version: det.version, supported: det.supported, loggedIn: det.loggedIn })
      this.publish(a)
    })
    return q
  }

  async refresh(): Promise<{ ok: boolean }> {
    await Promise.all(this.o.registry.list().map((a) => this.detect(a.id)))
    return { ok: true }
  }

  /** The detected version of `agent`'s CLI (status reports). */
  cliVersion(agent: string): string | null {
    return this.detections.get(agent)?.det.version ?? null
  }

  /** `agents.<id>.command`: the binary path override. */
  private override(id: string): string | null {
    return this.o.settings.values.agent(id).command
  }

  private settingsChanged(): void {
    for (const a of this.o.registry.list()) {
      const d = this.detections.get(a.id)
      if (d && d.command !== this.override(a.id)) void this.detect(a.id)
      this.publish(a)
    }
    this.rearmStatusFiles()
  }

  /** Each live session's status file again: the path follows the login environment and the agent's settings. */
  private rearmStatusFiles(): void {
    if (this.disposed) return
    for (const id of [...this.live.keys()]) this.armStatusFile(id)
  }

  private publishAll(): void {
    for (const a of this.o.registry.list()) this.publish(a)
    const shell: AgentInfo = {
      id: SHELL_AGENT,
      displayName: 'Shell',
      state: 'pseudo',
      version: null,
      path: null,
      loggedIn: null,
      notice: null,
      installCommand: null,
      loginCommand: null,
      rightButtonMenu: false,
      options: { models: [], allowCustomModel: false, permissionModes: [] },
      defaults: {},
      detectedAt: null,
      order: this.o.registry.list().length,
    }
    this.store.set(SHELL_AGENT, shell)
  }

  private publish(a: AgentAdapter): void {
    const d = this.detections.get(a.id) ?? null
    const det = d?.det ?? null
    const s = this.o.settings.values.agent(a.id)
    const opts = a.options(det ?? NO_DETECTION)
    const row: AgentInfo = {
      id: a.id,
      displayName: a.displayName,
      state: !det ? 'detecting' : !det.installed ? 'missing' : det.supported ? 'ready' : 'outdated',
      version: det?.version ?? null,
      path: det?.path ?? null,
      loggedIn: det?.loggedIn ?? null,
      notice: det?.notice ?? null,
      installCommand: a.installCommand,
      loginCommand: a.loginCommand,
      rightButtonMenu: a.rightButtonMenu === true,
      options: { ...opts, permissionModes: s.allowDangerousModes ? opts.permissionModes : opts.permissionModes.filter((m) => !m.dangerous) },
      defaults: { ...a.settings.defaults, ...s.defaults },
      detectedAt: d?.at ?? null,
      order: this.o.registry.list().indexOf(a),
    }
    const cur = this.store.get(a.id)
    if (!cur || JSON.stringify(cur) !== JSON.stringify(row)) this.store.set(a.id, row)
  }

  // ── launch (the AgentCommand seam) ────────────────────────────────────────────────────────────

  /** The AgentCommand seam: the command that starts `s`'s agent `how`, or null for the `shell` pseudo-agent. */
  async command(s: AgentLaunchSession, how: AgentLaunchHow): Promise<AgentLaunchCommand | null> {
    const id = s.agent !== SHELL_AGENT ? s.agent : (s.requestedAgent ?? null)
    if (!id || id === SHELL_AGENT) return null
    const a = this.o.registry.get(id)
    if (!a) throw new Error(`Kea has no agent called “${id}”.`)
    let det = await this.detection(id)
    // installed since the last detection, or removed or replaced since (C-RES-11): one more look before launching
    const cached = this.detections.get(id)
    if (!det.installed || !det.path || binaryStamp(det.path) !== cached?.stamp) det = await this.detect(id)
    if (!det.installed) throw new Error(`${a.displayName} is not installed. Install it with: ${a.installCommand}`)
    const helperPath = this.hookHelper()
    const settings = this.o.settings.values.agent(id)
    const env = await this.o.env()
    const ctx: LaunchContext = {
      keaSessionId: s.id,
      cwd: s.cwd,
      ownWorktree: s.isolation === 'worktree',
      helperPath,
      keaHome: this.o.home,
      portBase: this.o.sessions.get(s.id)?.portBase ?? null,
      binary: det.path,
      version: det.version,
      env,
      settings,
      filesDir: this.launchFiles(a),
    }
    const opts = a.options(det)
    const mode = s.launch.permissionMode
    // A dangerous mode is never launched while it is not allowed (a preset or an older draft may name one)
    const allowed = !mode || settings.allowDangerousModes || !opts.permissionModes.some((m) => m.id === mode && m.dangerous)
    const launch: LaunchConfig = allowed ? s.launch : { ...s.launch, permissionMode: undefined }
    let spec: SpawnSpec | null = null
    if (how === 'resume' && s.agentSessionId) {
      spec = a.buildResume({ keaSessionId: s.id, agentSessionId: s.agentSessionId, transcriptPath: null, cwd: s.cwd, launch }, ctx)
    }
    // a start runs the composer's prompt; Restart, and a Resume with nothing to resume, start a fresh conversation without one
    spec ??= a.buildLaunch(how === 'start' ? launch : { ...launch, prompt: '' }, { ...ctx, agentSessionId: randomUUID() })
    const set: Record<string, string> = {}
    for (const [k, v] of Object.entries(spec.env)) if (env[k] !== v) set[k] = v
    this.pending.set(s.id, { adapter: id, since: this.mono(), prompted: how === 'start' && !!launch.prompt, silent: spec.silent === true, envs: [], dropped: 0 })
    return {
      argv: [spec.file, ...spec.args],
      env: set,
      unsetEnv: spec.unset,
      throughLoginShell: settings.throughLoginShell,
      agent: id,
      agentSessionId: spec.agentSessionId,
    }
  }

  /**
   * When `sessionId`'s agent was launched (ns, core's clock): taken as the launch command is handed over, just before the
   * PTY is spawned, so no hook of that agent is older. The status engine places the spawn there (its `launchedAt`); it
   * asks as the session turns live, before this service takes the launch's waiting envelopes. Null when unknown.
   */
  launchedAt(sessionId: string): bigint | null {
    return this.pending.get(sessionId)?.since ?? this.live.get(sessionId)?.launched ?? null
  }

  /**
   * Whether `sessionId`'s agent was launched in a way that can report nothing to Kea (its adapter's `SpawnSpec.silent`:
   * Command Code without its mod). The status engine asks as the session turns live, like `launchedAt`: it starts no
   * trust window for such a launch. False when unknown.
   */
  silentLaunch(sessionId: string): boolean {
    return this.pending.get(sessionId)?.silent ?? this.live.get(sessionId)?.silent ?? false
  }

  /**
   * The per-build helper copy hooks run (helper.ts), installed on first use, and again when it is no longer there (as
   * ptyhost does before every holder): a copy that has gone (removed by hand; core's prune keeps the one handed out
   * here, `hookHelperPath`) must never be the path the next agent's hooks are given.
   */
  private hookHelper(): string {
    if (this.helperPath && fs.existsSync(this.helperPath)) return this.helperPath
    if (!this.o.helperSource) throw new Error('kea-helper is not available: agent hooks cannot be set up')
    this.helperPath = installHookHelper(this.o.helperSource, this.o.home, this.o.version)
    return this.helperPath
  }

  /**
   * The helper copy the agents' hooks were last handed, or null before the first launch: core's prune of earlier
   * builds' copies never removes it (helper.ts `HelperCopies`, U-HLD-16), since the launch it went to may have no
   * terminal yet, and after a helper rebuilt under a running dev core it is not this build's.
   */
  hookHelperPath(): string | null {
    return this.helperPath
  }

  /**
   * The folder holding `a`'s launch files, written on first use and checked at every launch; null when it has none, or
   * they cannot be written: the adapter then launches without them.
   */
  private launchFiles(a: AgentAdapter): string | null {
    if (!a.launchFiles) return null
    try {
      return installAgentFiles(this.o.home, a.id, a.launchFiles(), (dir) => this.filesInUse(dir))
    } catch (e) {
      this.o.log.warn('an agent’s launch files could not be written: it starts without them', { agent: a.id, error: String(e) })
      return null
    }
  }

  /** A PTY that still runs was started with a file of `dir`: its argv names one. */
  private filesInUse(dir: string): boolean {
    const under = dir + path.sep
    const argvs = this.o.runningArgvs?.() ?? [...this.o.terminals.values()].filter((p) => p.state === 'running').map((p) => p.argv)
    for (const argv of argvs) if (argv.some((a) => a.includes(under))) return true
    return false
  }

  // ── live sessions ─────────────────────────────────────────────────────────────────────────────

  private sessionChanged(id: string, v: SessionView): void {
    const prev = this.lifecycles.get(id)
    this.lifecycles.set(id, v.lifecycle)
    const cur = this.live.get(id)
    const adapter = v.lifecycle === 'live' ? this.o.registry.get(v.agent) : undefined
    if (!adapter) {
      if (cur) this.stopLive(cur)
      if (v.lifecycle !== 'creating' && v.lifecycle !== 'detached') {
        this.pending.delete(id)
        this.ids.forget(id)
      }
      return
    }
    if (cur && cur.adapter !== adapter) this.stopLive(cur)
    if (!this.live.has(id)) this.startLive(v, prev === undefined)
    const l = this.live.get(id)
    if (l) this.armTranscript(l, v)
  }

  /** A session turned live with an adapter's agent: its signals; a restored one is drained and reconciled. */
  private startLive(v: SessionView, restored: boolean): void {
    const adapter = this.o.registry.get(v.agent)
    if (!adapter || this.disposed) return
    const row = this.o.db.get<{ transcriptPath: string | null }>('SELECT transcript_path AS transcriptPath FROM sessions WHERE id = ?', v.id)
    const p = this.pending.get(v.id)
    const l: Live = {
      id: v.id,
      adapter,
      signals: adapter.signals(v.agentSessionId),
      launched: p && p.adapter === adapter.id ? p.since : null,
      silent: !!p && p.adapter === adapter.id && p.silent,
      hooked: false,
      fileSeen: false,
      unknownWaitLogged: false,
      stopCheckTimer: null,
      spoolRetry: null,
      pid: null,
      statusPath: null,
      statusWatch: null,
      interruptTimer: null,
      // an argv prompt counts as the keystroke that starts the first turn
      tier3: new Tier3({ prompted: p && p.adapter === adapter.id && p.prompted ? nsToMs(p.since) : null }),
      tier3Timer: null,
      transcriptPath: row?.transcriptPath ?? null,
      transcriptWatch: null,
      watchedTranscript: null,
      readTranscript: null,
      readTo: 0,
    }
    this.live.set(v.id, l)
    // older envelopes first: the spool (in file order), then those that came while the launch went on (in arrival order)
    this.drain(v.id)
    this.pending.delete(v.id)
    if (p && p.adapter === adapter.id) {
      for (const e of p.envs) this.applyHook(l, e, false)
      if (p.dropped) this.o.log.warn('hooks before the session went live dropped (cap)', { sessionId: v.id, dropped: p.dropped })
    }
    this.armStatusFile(v.id)
    this.armTranscript(l, v)
    if (restored) void this.reconcileLive(l)
  }

  private stopLive(l: Live): void {
    this.live.delete(l.id)
    this.ids.forget(l.id)
    l.statusWatch?.dispose()
    l.transcriptWatch?.dispose()
    if (l.interruptTimer) clearTimeout(l.interruptTimer)
    if (l.tier3Timer) clearTimeout(l.tier3Timer)
    if (l.stopCheckTimer) clearTimeout(l.stopCheckTimer)
    if (l.spoolRetry) clearTimeout(l.spoolRetry)
    l.statusWatch = l.transcriptWatch = l.interruptTimer = l.tier3Timer = l.stopCheckTimer = l.spoolRetry = null
    // cost-state is written when the agent exits; the detached session shows it
    if (l.transcriptPath) void this.afterExit(l)
  }

  private forget(id: string): void {
    const l = this.live.get(id)
    if (l) this.stopLive(l)
    this.pending.delete(id)
    this.ids.forget(id)
    this.lifecycles.delete(id)
  }

  /**
   * Reconcile a restored session from its transcript. However it ends, the reconcile has completed: the transcript's
   * phase is applied, and nothing usable or a failure leaves the restored status as it is, confirmed, rather than
   * waiting for the status engine's confirmation timer.
   */
  private async reconcileLive(l: Live): Promise<void> {
    let r: ReconcileResult
    try {
      r = await l.adapter.reconcile(this.record(l))
    } catch (e) {
      this.o.log.warn('agent reconcile failed', { sessionId: l.id, error: String(e) })
      if (this.live.get(l.id) === l) this.o.status.reconcile(l.id, null)
      return
    }
    if (this.live.get(l.id) !== l) return
    if (r.phase === 'finished') this.o.status.reconcile(l.id, { phase: 'ready' })
    else if (r.phase === 'working') this.o.status.reconcile(l.id, { phase: 'working' })
    else if (r.phase === 'interrupted') this.o.status.reconcile(l.id, { phase: 'ready', unread: false })
    else this.o.status.reconcile(l.id, null)
    const meta = metaOf(r)
    if (meta) this.ingest(l.id, 'transcript', [meta])
  }

  private async afterExit(l: Live): Promise<void> {
    let r: ReconcileResult
    try {
      r = await l.adapter.reconcile(this.record(l))
    } catch {
      return
    }
    if (this.disposed || !this.o.sessions.has(l.id)) return
    const runtime = r.costUsd !== undefined ? { costUsd: r.costUsd } : undefined
    const session = r.title ? { title: r.title } : undefined
    if (!runtime && !session) return
    try {
      this.o.batch.queue({ sessionId: l.id, ...(runtime ? { runtime } : {}), ...(session ? { session } : {}) })
    } catch (e) {
      this.o.log.debug('agent exit summary not written', { sessionId: l.id, error: String(e) })
    }
  }

  private record(l: Live): { keaSessionId: string; agentSessionId: string | null; transcriptPath: string | null; cwd: string; launch: LaunchConfig } {
    const v = this.o.sessions.get(l.id)
    return { keaSessionId: l.id, agentSessionId: l.signals.agentSessionId, transcriptPath: l.transcriptPath, cwd: v?.cwd ?? '', launch: { prompt: '', ...(v?.launch ?? {}) } }
  }

  private ingest(id: string, source: StatusSource, events: AgentEvent[], o: { mono?: bigint | number; at?: number; spooled?: boolean; raw?: unknown } = {}): void {
    // the engine does not validate: what an adapter emits is checked against the protocol here
    const valid = events.filter((e) => {
      if (zAgentEvent.safeParse(e).success) return true
      this.stats.invalidEvents++
      this.o.log.warn('agent event dropped: not a valid AgentEvent', { sessionId: id, source, t: (e as { t?: unknown }).t })
      return false
    })
    if (!valid.length && (source !== 'hook' || events.length)) return
    try {
      this.o.status.ingest({ sessionId: id, source, events: valid, ...o })
    } catch (e) {
      // what an adapter emits was checked above, so a throw here is a fault of Kea's and the input is lost: an error
      this.o.log.error('status input not applied', { sessionId: id, source, error: String(e) })
    }
  }

  // ── tier 1: hooks ─────────────────────────────────────────────────────────────────────────────

  /** One envelope from the socket. */
  envelope(env: Envelope): void {
    if (this.disposed) return
    this.stats.envelopes++
    const id = env.keaSessionId
    // the helper could not read the hook's stdin (not JSON, or over L.hookStdinMaxBytes): its payload is `{}` (C-COR-7)
    if (env.malformed) this.dropped('malformed', 'hook payload was not JSON: dropped', env)
    if (env.oversize) this.dropped('oversize', 'hook payload over the stdin cap: dropped', env)
    const l = this.live.get(id)
    if (l) {
      if (l.adapter.id !== env.adapter) {
        this.stats.wrongAdapter++
        return
      }
      // the live copy wins (a busy core: the helper spooled this line too); then the spool, its copy of this one skipped
      if (!this.duplicate(env)) this.applyHook(l, env, false)
      if (hasSpool(this.o.home, id)) this.drain(id)
      return
    }
    const p = this.pending.get(id)
    if (p && p.adapter === env.adapter && this.toHrtime(env) >= p.since) {
      if (this.duplicate(env)) return
      this.stats.early++
      if (p.envs.length < L.signalRingEntries) p.envs.push(env)
      else p.dropped++
      return
    }
    if (this.o.sessions.has(id)) this.stats.stale++
    else this.dropped('unknownSession', 'hook envelope for an unknown session: dropped', env)
  }

  /** An envelope whose id its session took before: the copy that came second, from the socket or the spool. */
  private duplicate(env: Envelope): boolean {
    if (this.ids.take(env)) return false
    this.stats.duplicates++
    return true
  }

  /** Count a dropped envelope and log it: the first of each kind, then at each doubling of the count (bounded logs). */
  private dropped(kind: 'malformed' | 'oversize' | 'unknownSession', msg: string, env: Envelope): void {
    const n = ++this.stats[kind]
    if ((n & (n - 1)) === 0) this.o.log.warn(msg, { sessionId: env.keaSessionId, adapter: env.adapter, count: n })
  }

  /** One envelope into the live session's signals and the engine. `fromSpool`: drained from the session's spool. */
  private applyHook(l: Live, env: Envelope, fromSpool: boolean): void {
    const mono = this.toHrtime(env)
    // stamped before this agent's launch: an earlier agent's (a Resume's leftover spool) — it changes nothing here
    if (l.launched !== null && mono < l.launched) {
      this.stats.stale++
      return
    }
    // quiet only if Kea could not have shown it live: emitted before this core started
    const spooled = fromSpool && mono < this.born
    // the agent runs: a status file its watch has not seen appear may be there
    l.statusWatch?.look()
    this.exact(l)
    const events = l.signals.hook({ payload: env.payload, monoMs: env.mono / 1e6 })
    for (const e of events) {
      // a transcript path is the agent's to name: only one under its own config folder is taken
      if (e.t === 'session.started' && e.transcriptPath && l.adapter.ownsTranscript && !l.adapter.ownsTranscript(e.transcriptPath, this.agentEnv(l.adapter))) {
        const n = ++this.stats.foreignTranscript
        if ((n & (n - 1)) === 0) this.o.log.warn('a hook’s transcript path is outside the agent’s config folder: ignored', { sessionId: l.id, count: n })
        delete e.transcriptPath
      }
      if (e.t === 'session.started' && e.transcriptPath && e.transcriptPath !== l.transcriptPath) {
        l.transcriptPath = e.transcriptPath
        queueMicrotask(() => {
          const v = this.o.sessions.get(l.id)
          if (v && this.live.get(l.id) === l) this.armTranscript(l, v)
        })
      }
    }
    // the first hook confirms the repo's trust even when it maps to nothing; later empty ones add nothing
    if (!events.length && l.hooked) return
    l.hooked = true
    this.ingest(l.id, 'hook', events, { mono, at: env.receivedAt, spooled, raw: env.payload })
    if (events.some((e) => e.t === 'turn.finished')) this.checkAfterStop(l)
  }

  /**
   * A Stop while the status file says busy: normally the file goes idle 10–18 ms later; a user's Stop hook that returns
   * "block" keeps the turn going and the file stays busy, with no change to hear. So it is read again once the grace
   * has passed, and a busy reading then takes the session from `ready` back to `working`.
   */
  private checkAfterStop(l: Live): void {
    if (!l.statusPath || l.signals.fileStatus !== 'busy') return
    if (l.stopCheckTimer) clearTimeout(l.stopCheckTimer)
    l.stopCheckTimer = setTimeout(() => {
      l.stopCheckTimer = null
      if (this.live.get(l.id) === l) this.readStatusFile(l, true)
    }, L.statusFileInterruptGraceMs)
  }

  /**
   * An envelope's `mono` on this process's clock. kea-helper stamps a clock that stops while the machine sleeps
   * (CLOCK_UPTIME_RAW on macOS, CLOCK_MONOTONIC on Linux); `process.hrtime` (the status engine's clock) does not, so
   * the two differ by the sleep since boot. Both are compared with the wall clock at each end (the helper stamps
   * `receivedAt` with `mono`), which gives the offset to within the wall clock's millisecond; the offset is then held
   * while later envelopes agree within L.hookClockResyncMs, so envelopes keep their exact relative order, and taken
   * anew after a jump (a sleep, or an envelope spooled before one).
   */
  private toHrtime(env: Envelope): bigint {
    const MS = 1_000_000n
    const raw = BigInt(Math.trunc(env.mono))
    const off = this.mono() - BigInt(Date.now()) * MS - (raw - BigInt(Math.trunc(env.receivedAt)) * MS)
    const d = this.clockOffset === null ? null : off - this.clockOffset
    if (d === null || d > BigInt(L.hookClockResyncMs) * MS || d < -BigInt(L.hookClockResyncMs) * MS) this.clockOffset = off
    return raw + (this.clockOffset ?? off)
  }

  /**
   * Drain `id`'s spool into its live signals (or, for a session not live, just empty it: the reconcile covers it). A
   * helper appending at that moment holds the spool's lock: a live session's spool is then drained once more after
   * L.spoolLockRetryMs (`retry`: that drain, which arms no further one; the next envelope or status change drains too).
   * Where core takes a spool without that lock (Linux) every take is followed so, for the line a helper writes again.
   */
  private drain(id: string, retry = false): void {
    const l = this.live.get(id)
    const r = drainSpool(
      this.o.home,
      id,
      (env) => {
        if (!l || env.adapter !== l.adapter.id) return
        if (this.duplicate(env)) return false
        this.applyHook(l, env, true)
      },
      this.o.spoolLockFlag ?? SPOOL_LOCK_FLAG,
    )
    if (!r) return
    if ((r.locked || r.unlocked) && l && !retry && !l.spoolRetry) {
      l.spoolRetry = setTimeout(() => {
        l.spoolRetry = null
        if (this.live.get(id) === l) this.drain(id, true)
      }, L.spoolLockRetryMs)
    }
    this.stats.spoolDrains++
    this.stats.spoolApplied += r.applied
    this.stats.spoolSkipped += r.skipped
    this.o.log.info('spool drained', { sessionId: id, applied: r.applied, skipped: r.skipped, duplicates: r.duplicates, bytes: r.bytes, locked: r.locked, unlocked: r.unlocked, live: !!l })
  }

  /** Drain every spool under KEA_HOME at start. */
  private launchDrain(): void {
    for (const id of spooledSessions(this.o.home)) this.drain(id)
  }

  /**
   * The intake refused connections at its cap: those hooks spooled, so live sessions' spools are drained once one closes.
   * A refused helper spools a moment after its connection was dropped, so a sweep that finds nothing is tried again at
   * the next close, until one finds a spool or no connection is left open.
   */
  private connectionClosed(): void {
    const refused = this.intake?.stats.refused ?? 0
    if (refused === this.refusedSwept) return
    let found = false
    for (const id of [...this.live.keys()]) {
      if (!hasSpool(this.o.home, id)) continue
      found = true
      this.drain(id)
    }
    if (found || (this.intake?.connections ?? 0) === 0) this.refusedSwept = refused
  }

  // ── tier 1b: the status file ──────────────────────────────────────────────────────────────────

  private agentPty(sessionId: string): PtyInfo | undefined {
    let found: PtyInfo | undefined
    for (const p of this.o.terminals.values()) if (p.sessionId === sessionId && p.kind === 'agent' && p.state === 'running') found = p
    return found
  }

  /** Watch the live agent's status file once its child pid is known; again when the agent PTY changes. */
  private armStatusFile(sessionId: string): void {
    const l = this.live.get(sessionId)
    if (!l || !l.adapter.statusFilePath) return
    const pid = this.agentPty(sessionId)?.childPid ?? null
    // the path also depends on the login environment, which a restored session may see before it is resolved
    const statusPath = pid ? l.adapter.statusFilePath(pid, { ...this.loginEnv, ...this.o.settings.values.agent(l.adapter.id).env }) : null
    if (pid === l.pid && statusPath === l.statusPath) return
    l.statusWatch?.dispose()
    l.statusWatch = null
    l.pid = pid
    l.statusPath = statusPath
    if (!l.statusPath) return
    l.statusWatch = this.watches.watch(l.statusPath, () => this.readStatusFile(l), this.watchRoots(l.adapter))
    this.readStatusFile(l)
  }

  /**
   * The agent's environment as far as core knows it: the login environment (core's own until that is resolved) and the
   * agent's settings. Its config folder decides the status file's path, the transcripts it owns and the watch roots.
   */
  private agentEnv(a: AgentAdapter): Env {
    const base: Env = Object.keys(this.loginEnv).length ? this.loginEnv : processEnv()
    return { ...base, ...this.o.settings.values.agent(a.id).env }
  }

  /** Where an ancestor of a file the agent's adapter follows may be watched recursively (its config folder, U-AGT-30). */
  private watchRoots(a: AgentAdapter): string[] {
    return a.watchRoots?.(this.agentEnv(a)) ?? []
  }

  /** The status file `sessionId`'s agent writes (status reports), or null. */
  statusFilePath(sessionId: string): string | null {
    return this.live.get(sessionId)?.statusPath ?? null
  }

  /** Read the status file after a change (`again`: a look asked for after a Stop, reported even if unchanged). */
  private readStatusFile(l: Live, again = false): void {
    if (this.live.get(l.id) !== l || !l.statusPath) return
    const mono = this.mono()
    const at = this.now()
    const text = readCapped(l.statusPath, L.statusFileMaxBytes)
    const r = l.signals.statusFile(text, again)
    // the agent's own file, even one just registered with no status yet: an exact source from now on
    if (r.reading || r.registered) {
      this.exact(l)
      l.fileSeen = true
    }
    if (r.reading && !zStatusFileReading.safeParse(r.reading).success) {
      this.stats.invalidEvents++
    } else if (r.reading || r.registered) {
      if (r.reading?.waitingFor === 'unknown' && !l.unknownWaitLogged) {
        l.unknownWaitLogged = true
        this.o.log.warn('status file: unknown waitingFor, shown as an estimated question (the adapter contract may need it)', { sessionId: l.id, adapter: l.adapter.id, waitingFor: r.reading.detail ?? null })
      }
      try {
        this.o.status.statusFile(l.id, r.reading, { mono, at, raw: { statusFile: r.reading ?? 'registered' } })
      } catch (e) {
        this.o.log.warn('status file reading not applied', { sessionId: l.id, error: String(e) })
      }
    }
    this.ingest(l.id, 'status-file', r.events, { mono, at })
    if (r.interruptCandidate !== null) {
      const seq = r.interruptCandidate
      if (l.interruptTimer) clearTimeout(l.interruptTimer)
      // a Stop emitted before the change may still be on its way: it wins if it comes within the grace
      l.interruptTimer = setTimeout(() => {
        l.interruptTimer = null
        if (this.live.get(l.id) !== l) return
        if (hasSpool(this.o.home, l.id)) this.drain(l.id)
        const ev = l.signals.confirmInterrupt(seq)
        if (ev.length) this.stats.interrupts++
        this.ingest(l.id, 'status-file', ev, { mono, at })
      }, L.statusFileInterruptGraceMs)
    } else if (hasSpool(this.o.home, l.id)) {
      // a hook that spooled while core was busy is picked up at the agent's next status change
      this.drain(l.id)
    }
  }

  // ── tier 3: terminal activity ─────────────────────────────────────────────────────────────────

  /** One of ptyhost's activity notes (core's Terminals hands them on): tier 3 for the live agent session whose PTY it is. */
  activity(n: ActivityNote): void {
    if (this.disposed) return
    const pty = this.o.terminals.get(n.a.ptyId)
    if (!pty || pty.kind !== 'agent') return
    const l = this.live.get(pty.sessionId)
    if (!l) return
    l.statusWatch?.look() // as for a hook (applyHook)
    let events: AgentEvent[]
    switch (n.m) {
      case 'pty.activity':
        events = l.tier3.activity(n.a.active, this.noteTime(n.a.at))
        break
      case 'pty.keystroke':
        // typing into a blocked agent is remembered (the user-input rule then reads it)
        if (this.o.status.state(l.id)?.phase === 'blocked') this.o.status.userTyped(l.id)
        events = l.tier3.keystroke(this.noteTime(n.a.at))
        break
      case 'pty.bell':
        events = l.tier3.bell(this.monoMs())
        break
      case 'pty.oscNotify':
        events = l.tier3.notify(n.a.text, this.monoMs())
        break
    }
    this.tier3Events(l, events)
    this.armTier3(l)
  }

  /** Core's monotonic clock in ms (tier 3's times). */
  private monoMs(): number {
    return nsToMs(this.mono())
  }

  /** A note's wall-clock time on core's monotonic clock, by its age (at most a reporting window: ptyhost sends each when due). */
  private noteTime(at: number): number {
    return this.monoMs() - Math.min(Math.max(0, this.now() - at), L.activityReportMs)
  }

  /** A hook or a status-file reading came: tier 3 never overrides an exact source from now on. */
  private exact(l: Live): void {
    if (l.tier3.tier1) return
    l.tier3.tier1 = true
    this.armTier3(l)
  }

  /**
   * Tier 3's events to the engine (source `heuristic`; the engine's precedence between sources decides the rest).
   * With an exact source only the user-input rule applies, and only while the session has had no status-file reading
   * (the file says when a prompt is answered): output after typing into a blocked agent starts the turn; nothing else
   * of tier 3's.
   */
  private tier3Events(l: Live, events: AgentEvent[]): void {
    const pass = !l.tier3.tier1 ? events : l.fileSeen ? [] : events.filter((e) => e.t === 'turn.started' && this.o.status.state(l.id)?.phase === 'blocked')
    if (pass.length) this.ingest(l.id, 'heuristic', pass, { mono: msToNs(this.monoMs()) })
  }

  /** One timer per live session while tier 3 waits for its next decision. */
  private armTier3(l: Live): void {
    if (l.tier3Timer) clearTimeout(l.tier3Timer)
    l.tier3Timer = null
    const due = l.tier3.deadline()
    if (due === null || this.live.get(l.id) !== l) return
    l.tier3Timer = setTimeout(
      () => {
        l.tier3Timer = null
        if (this.live.get(l.id) !== l) return
        this.tier3Events(l, l.tier3.tick(this.monoMs()))
        this.armTier3(l)
      },
      Math.max(0, Math.ceil(due - this.monoMs())),
    )
  }

  // ── tier 2: the transcript ────────────────────────────────────────────────────────────────────

  /** A watcher only while the phase is starting, working or blocked, on the current transcript. */
  private armTranscript(l: Live, v: SessionView): void {
    const want = TRANSCRIPT_PHASES.has(v.phase) && l.transcriptPath && l.adapter.watchTranscript ? l.transcriptPath : null
    if (want === l.watchedTranscript) return
    // disposing reads what came since the last notification (a title written just before Stop) and says where it stopped
    const prev = l.transcriptWatch
    l.transcriptWatch = null
    prev?.dispose()
    if (prev && l.watchedTranscript) {
      l.readTranscript = l.watchedTranscript
      l.readTo = prev.position
    }
    l.watchedTranscript = want
    if (!want || !l.adapter.watchTranscript) return
    // the next turn of the same transcript starts where the last one stopped, so what was appended while ready is read
    const from = l.readTranscript === want ? l.readTo : undefined
    l.transcriptWatch = l.adapter.watchTranscript(
      this.record(l),
      (file, cb) => this.watches.watch(file, cb, this.watchRoots(l.adapter)),
      (e) => {
        if (this.live.get(l.id) !== l) return
        if (e.t === 'turn.interrupted') l.signals.turnEnded()
        this.ingest(l.id, 'transcript', [e])
      },
      from,
    )
  }

  // ── RPC, resources, shutdown ──────────────────────────────────────────────────────────────────

  handlers(): Handlers<typeof agentsApi> {
    return { 'agents.refresh': () => this.refresh(), 'agents.mention': (a) => ({ text: this.mention(a.sessionId, a.path) }) }
  }

  /**
   * The mention of `path` for the agent `sessionId` runs: its adapter's form, or the generic one for an agent
   * without its own (the `shell` pseudo-agent, where the person may have started any CLI). Null: no session, or no form.
   */
  mention(sessionId: string, path: string): string | null {
    const v = this.o.sessions.get(sessionId)
    if (!v) return null
    const a = this.o.registry.get(v.agent)
    return a?.fileMention ? a.fileMention(path) : atMention(path)
  }

  get resourceCounts(): { live: number; pending: number; watches: number; transcriptWatches: number; timers: number; connections: number; envelopeIds: number } {
    let timers = 0
    let transcriptWatches = 0
    for (const l of this.live.values()) {
      if (l.interruptTimer) timers++
      if (l.tier3Timer) timers++
      if (l.stopCheckTimer) timers++
      if (l.spoolRetry) timers++
      if (l.transcriptWatch) transcriptWatches++
    }
    return { live: this.live.size, pending: this.pending.size, watches: this.watches.size, transcriptWatches, timers, connections: this.intake?.connections ?? 0, envelopeIds: this.ids.size }
  }

  /** Inputs the live sessions' signals ignored (K-FX-7), summed. */
  get ignored(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const l of this.live.values()) for (const [k, n] of Object.entries(l.signals.ignored)) out[k] = (out[k] ?? 0) + n
    return out
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.offs.splice(0)) off()
    for (const l of [...this.live.values()]) {
      l.statusWatch?.dispose()
      l.transcriptWatch?.dispose()
      if (l.interruptTimer) clearTimeout(l.interruptTimer)
      if (l.tier3Timer) clearTimeout(l.tier3Timer)
      if (l.stopCheckTimer) clearTimeout(l.stopCheckTimer)
      if (l.spoolRetry) clearTimeout(l.spoolRetry)
    }
    this.live.clear()
    this.pending.clear()
    this.lifecycles.clear()
    this.watches.dispose()
    this.ownWatch?.dispose()
    this.intake?.dispose()
  }
}

const nsToMs = (ns: bigint): number => Number(ns) / 1e6

/** Core's own environment, as strings (the agent's until the login shell's is known). */
function processEnv(): Env {
  const out: Env = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v
  return out
}
const msToNs = (ms: number): bigint => BigInt(Math.trunc(ms * 1e6))

/** A CLI binary as it is now (through symlinks: an installer re-points one per version), or null when it is gone. */
function binaryStamp(file: string): string | null {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    const st = fs.statSync(file)
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

/** The agent of a recorded argv (a rebuilt session), through the login-shell wrapper too. */
export function identifyAgent(registry: Pick<AdapterRegistry, 'identify'>, argv: readonly string[]): string | null {
  const i = argv.indexOf(LOGIN_SHELL_SCRIPT)
  const inner = i >= 0 && argv[i + 1] === LOGIN_SHELL_ARG0 ? argv.slice(i + 2) : argv
  return registry.identify(inner)
}

function metaOf(r: ReconcileResult): AgentEvent | null {
  const m: Extract<AgentEvent, { t: 'meta' }> = { t: 'meta' }
  if (r.title) {
    m.title = r.title.title
    m.titleSource = r.title.source
  }
  if (r.costUsd !== undefined) m.costUsd = r.costUsd
  if (r.contextUsedPct !== undefined) m.contextUsedPct = r.contextUsedPct
  if (r.model !== undefined) m.model = r.model
  return Object.keys(m).length > 1 ? m : null
}

/**
 * The file's text, or null when it is gone or not a regular file; a file over `max` bytes reads as unparsable (its first
 * `max` bytes). Opened without waiting: the status file's folder is the agent's, and a FIFO there must not block core.
 */
function readCapped(file: string, max: number): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return null
    const buf = Buffer.alloc(Math.min(st.size, max))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
