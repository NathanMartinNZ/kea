// The adapter interface: what every agent adapter gives core, and what core gives it. An adapter is the only
// code that knows anything agent-specific: its flags, paths, env vars and payload fields are declared in its
// `contract.ts` and used only inside its folder.

import type { AgentEvent, AgentInfo, AgentOptions, AgentSettingsExtension, LaunchConfig, StatusFileReading } from '@kea/protocol'

export type Env = Record<string, string>

/** What detection found. Never thrown: a failure is a value. */
export interface Detection {
  installed: boolean
  /** Absolute path of the binary that runs (the `agents.<id>.command` override, else the first match on the login-shell PATH). */
  path: string | null
  /** `--version`'s version, e.g. `2.1.296`; null when it could not be read. */
  version: string | null
  /** At or above the contract's minimum; an unknown newer version is assumed compatible. */
  supported: boolean
  /** The logged-in indicator; null when unknown. Kea never reads or stores credentials. */
  loggedIn: boolean | null
  /** One line for the composer and Settings (outdated, signed out, detection failed), or null. */
  notice: string | null
  /**
   * What the CLI printed about itself at detection, for an adapter whose option lists are the CLI's own: its model list
   * and its permission-mode names, each null when it could not be read. Absent for static lists.
   */
  listed?: { models: readonly ListedModel[] | null; permissionModes: readonly string[] | null }
}

/** One row of a CLI's own model list. */
export interface ListedModel {
  id: string
  description: string
  /** The CLI marks it as its default. */
  isDefault: boolean
}

/** What core gives an adapter to launch with, and the PTY environment it starts from (session variables). */
export interface LaunchContext {
  /** Stable Kea id; survives the agent's /clear and resume. */
  keaSessionId: string
  /** Pre-assigned where the agent supports it (Claude: `--session-id`). */
  agentSessionId?: string
  /** The worktree (or the project root, in place). */
  cwd: string
  /**
   * `cwd` is a worktree Kea made for this session. False for a session used in place: its folder is the project's own
   * (the person's checkout), where an adapter never answers the agent's trust question for them.
   */
  ownWorktree: boolean
  /** Absolute path to kea-helper (the hook command). */
  helperPath: string
  /** KEA_HOME: the helper derives run/core.sock and the session's spool from it. */
  keaHome: string
  /** The session's reserved port block (for its dev servers); null without one. */
  portBase: number | null
  /** The binary to run (detection's path); null: the adapter's command name, found on PATH. */
  binary: string | null
  /** The detected version (version-gated argv); null when unknown. */
  version: string | null
  /** The PTY environment before the adapter's edits: login shell, terminal and session variables. */
  env: Readonly<Env>
  /** The agent's settings (`agents.<id>.*`): extra args, extra environment, the adapter's own keys. */
  settings: AgentSettingsLike
  /**
   * The folder core wrote the adapter's `launchFiles` into (absolute), or null when it has none or they could not be
   * written: the adapter then launches without them.
   */
  filesDir?: string | null
}

export interface AgentSettingsLike {
  extraArgs: readonly string[]
  env: Readonly<Record<string, string>>
  allowDangerousModes: boolean
  [key: string]: unknown
}

/** What a launch runs: argv straight to execve, the complete environment, the directory. */
export interface SpawnSpec {
  file: string
  args: string[]
  /** The complete environment (the context's, with the adapter's edits). */
  env: Env
  /** Keys of the context's environment the adapter removed (core's terminal layer must drop them too). */
  unset: string[]
  cwd: string
  /** The agent's conversation id this launch uses (pre-assigned, or the resumed one), when known. */
  agentSessionId: string | null
  /**
   * True: nothing this launch runs can report to Kea (Command Code without its mod): tier 3 only. Core then starts no
   * trust window for it: only an event of the agent's ends that window, so in a repo whose trust was never
   * confirmed its question would come up `L.trustWindowMs` into every quiet launch and never be answered.
   */
  silent?: boolean
}

/** One hook or mod payload as the intake delivers it: the projected payload and when it was emitted. */
export interface RawAgentSignal {
  payload: Record<string, unknown>
  /** The envelope's `mono` stamp in ms (a clock that stops while the machine sleeps), for the adapter's windows. */
  monoMs: number
}

/** The session as the adapter sees it for resume, the transcript watcher and reconcile. */
export interface SessionRecord {
  keaSessionId: string
  agentSessionId: string | null
  transcriptPath: string | null
  cwd: string
  launch: LaunchConfig
}

/** What a transcript tail says, for the status engine (phase) and the session row (title, cost, context). */
export interface ReconcileResult {
  /**
   * What the last turn-level record says: `finished` (the last turn ended), `working` (a prompt or a pending tool use:
   * working or awaiting permission, shown as working until a live signal says otherwise), `interrupted` (the interrupt
   * marker), or null when nothing is known.
   */
  phase: 'finished' | 'working' | 'interrupted' | null
  title?: { title: string; source: 'agent' | 'user' }
  costUsd?: number
  contextUsedPct?: number
  model?: string
}

/** A disposable handle (kit's shape, without depending on kit's classes). */
export interface Disposable {
  dispose(): void
}

/** Watches one file for changes (core's watch service). */
export type WatchFile = (file: string, onChange: () => void) => Disposable

/**
 * A transcript watcher. Disposing it reads what was appended since the last notification first (a record
 * written just before the phase changed), and `position` is where it stopped, so the next one (the next turn) starts
 * there and nothing appended while none watched is lost (U-AGT-19).
 */
export interface TranscriptWatch extends Disposable {
  readonly position: number
}

/** Per-session interpretation state: a hook stream's normaliser and its tier-1b reader, kept by core per live session. */
export interface SessionSignals {
  /** A hook payload → events, with the adapter's in-tier dedupe. */
  hook(raw: RawAgentSignal): AgentEvent[]
  /** The agent's session ids this session has reported (the launch's and later ones: /clear, resume). */
  sessionIds(): ReadonlySet<string>
  /** The conversation id later resumes target (updated on /clear). */
  readonly agentSessionId: string | null
  /**
   * Tier 1b: the status file's text after a change, or null when it is gone. The reading to apply (null when
   * the change is ignored), `registered` when the file is the session's but has no status yet (it proves the trust
   * dialog was answered), events it implies at once, and an interrupt candidate: the turn number to pass to
   * `confirmInterrupt` once hooks emitted before the change have had time to arrive (L.statusFileInterruptGraceMs).
   * `again`: a look the caller asked for (after a Stop): the reading is returned even when it has not changed.
   */
  statusFile(text: string | null, again?: boolean): { reading: StatusFileReading | null; registered?: boolean; events: AgentEvent[]; interruptCandidate: number | null }
  /** The last reading's status, when the adapter has a status file (a Stop while it says `busy` is looked at again). */
  readonly fileStatus?: StatusFileReading['status'] | null
  /** `turn.interrupted` if turn `seq` is still open with no Stop since; else nothing. */
  confirmInterrupt(seq: number): AgentEvent[]
  /** Another tier saw the turn end (a transcript interrupt marker). */
  turnEnded(): void
  /**
   * Inputs ignored or not understood (K-FX-7): unknown `status` values, other sessions' files, torn reads and unknown
   * hook events are ignored; an unknown `waitingFor` is read as a question and counted here.
   */
  readonly ignored: { unknownStatus: number; unknownWait: number; foreignSession: number; unparsable: number; unknownEvent: number }
}

/** `AgentAdapter.trustGated`: false (no trust question holds anything back), or whose answer the trust is. */
export type TrustGate = false | 'repo' | 'launch'

/** One agent's adapter: what core asks of it, and what it may add. */
export interface AgentAdapter {
  /** Registry key; also the `agents.<id>` settings key and `sessions.agent`. */
  id: string
  displayName: string
  /**
   * Every name the CLI is installed under; the first is the one Kea looks up on the login-shell PATH. A harness shadows
   * or hides all of them before Kea starts, so a test never runs a real CLI.
   */
  commands: readonly string[]
  /** The command to copy when the CLI is missing. */
  installCommand: string
  /** The command that signs the CLI in again, shown with the signed-out condition; null when it has none. */
  loginCommand: string | null
  /** Its settings extension (`agents.<id>.*`, settings.ts). */
  settings: AgentSettingsExtension
  /**
   * The agent captures the mouse yet does nothing with the right button: in its tab a plain right-click opens Kea's
   * terminal menu, and the agent is told nothing of that button. Absent or false: a terminal that captures the mouse
   * has the right button, and Kea's menu needs the selection override (Shift, ⌥ on macOS).
   */
  rightButtonMenu?: boolean
  /**
   * Whether its events are held back until the folder is trusted, and whose answer that trust is: the
   * engine's trust window follows it. `repo`: the agent keeps one answer per repository (Claude Code: keyed to the main
   * checkout), so once an event of it came from a project no later launch there is watched. `launch`: Kea cannot tell
   * whether it will ask in a folder (Command Code: a store of its own, `--trust` per launch), so every launch that can
   * report is watched, whatever came from the project before, and its events say nothing about the project.
   */
  trustGated: TrustGate
  /**
   * Files its launches name in argv (Command Code's session mod): core writes them once per content into a folder of
   * Kea's own (`<KEA_HOME>/bin/agents/<id>-<hash>/`) and passes it as `LaunchContext.filesDir`. Nothing is ever written
   * into the agent's config or the repo.
   */
  launchFiles?(): readonly { name: string; content: string }[]
  /**
   * How long a detection stays good (ms) for an adapter whose options come from the CLI (a model list): an older
   * one is renewed in the background the next time it is asked for. Absent: until the binary or the override changes.
   */
  detectionTtlMs?: number

  /** Is the CLI installed, which version, logged in. Never throws. */
  detect(env: Readonly<Env>, command: string | null): Promise<Detection>
  /** What the composer can offer for this version: unsupported knobs are omitted, not disabled. */
  options(detection: Detection): AgentOptions

  /** argv + env for a new conversation. No shell. */
  buildLaunch(cfg: LaunchConfig, ctx: LaunchContext): SpawnSpec
  /** argv + env to continue `session`'s conversation, or null when it cannot be resumed. */
  buildResume(session: SessionRecord, ctx: LaunchContext): SpawnSpec | null
  /** The agent of a rebuilt session, from its recorded argv: true when this adapter started it. */
  identify(argv: readonly string[]): boolean
  /**
   * The kea-helper executables a command names that this adapter's launch built (the copy an agent's hooks are called
   * through stays for as long as the agent runs). `argv` is a running terminal's command as recorded: any terminal's,
   * and an agent's may stand behind the login-shell wrapper, so the adapter looks for its own option wherever it is.
   * None named, or an option it cannot read: an empty list. Only the adapter knows how its launch carries the path
   * (inline settings, an encoded option): core never reads it itself. Absent for an adapter whose launches name no
   * helper.
   */
  helperPaths?(argv: readonly string[]): string[]

  /** Per-session signal state (hooks, tier 1b), given the conversation id the launch used. */
  signals(agentSessionId: string | null): SessionSignals
  /** The live status file of the agent process `pid` (tier 1b), or null when the agent has none. */
  statusFilePath?(pid: number, env: Readonly<Env>): string | null
  /**
   * The folders under which a file the adapter follows (status file, transcript) lives, in the agent's environment: its
   * config folder. Core watches an ancestor recursively only inside them while the file does not exist yet; none:
   * never recursively.
   */
  watchRoots?(env: Readonly<Env>): string[]
  /**
   * Whether a transcript path a payload names is the agent's own (under its config folder): any other is ignored and
   * counted, never stored, read or watched (an agent is untrusted).
   */
  ownsTranscript?(file: string, env: Readonly<Env>): boolean

  /**
   * Transcript signals hooks cannot give (titles, interrupts, usage), tailed incrementally: from `from` (the
   * previous watcher's `position`), else from the end of the file as it is (what was there before is reconcile's).
   */
  watchTranscript?(session: SessionRecord, watch: WatchFile, emit: (e: AgentEvent) => void, from?: number): TranscriptWatch
  /** After app start or core restart: status, title, cost from the transcript tail. */
  reconcile(session: SessionRecord): Promise<ReconcileResult>
  /**
   * The text that mentions the file at `path` (relative to the session's working directory) at this agent's prompt,
   * without a trailing space: `@path`, or the agent's quoted form where the bare one would not read back as that path.
   * Null: no form does, and nothing is typed. Absent: the generic form (kit/mention.ts).
   */
  fileMention?(path: string): string | null
}

export type { AgentInfo }
