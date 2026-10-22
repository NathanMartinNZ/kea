// Command Code's contract: every CLI flag, env var, path, mod event, payload field and transcript value the
// adapter relies on — and nothing else. The contract tests check it against the installed CLI (K-CM-*), U-AGT-12
// checks the adapter's code uses nothing outside it, the mod's projection is generated from it, and `pnpm lint`
// (U-AGT-11) refuses every one of these strings outside packages/adapters. Verified on 1.79.2.

import { zFailureKind, type FailureKind } from '@kea/protocol'

/** The command on the login-shell PATH. */
export const COMMAND = 'cmd'

/** Every name npm installs the CLI under (1.79.2's `bin`): all of them start the same program. */
export const COMMANDS = [COMMAND, 'cmdc', 'command-code', 'commandcode'] as const

/** Minimum supported version: the version the flags below were first verified on. */
export const MIN_VERSION = '1.74.0'

/** `cmd --version` → `1.79.2`. */
export const VERSION_RE = /^\s*v?(\d+\.\d+\.\d+)\s*$/m

/** What the composer shows when the CLI is missing. */
export const INSTALL_COMMAND = 'npm i -g command-code'

/** Subcommand argv for detection: `cmd status --json` prints JSON and exits 0 (signed in) or 1. */
export const STATUS = ['status', '--json'] as const
/** The fields of that JSON the adapter reads. */
export const STATUS_FIELDS = { authenticated: 'authenticated', version: 'version' } as const
/** Subcommand that signs the CLI in: what the signed-out condition tells the person to run. */
export const LOGIN = ['login'] as const

/** Every flag the adapter passes (K-CM-2 checks `--help` lists each). */
export const FLAGS = {
  model: '--model',
  effort: '--effort',
  permissionMode: '--permission-mode',
  mod: '--mod',
  modOption: '--mod-option',
  trust: '--trust',
  name: '--name',
  resume: '--resume',
  version: '--version',
  help: '--help',
  listModels: '--list-models',
} as const

/** Ends the options: the prompt follows. */
export const END_OF_OPTIONS = '--'

/** Version gates: the session mod and its options are passed from the version they were verified on. */
export const GATES = { mods: '1.79.2' } as const

/**
 * Permission modes. `id`: Kea's name. `flag`: what the adapter passes. `names`: every spelling
 * `--permission-mode` takes for it; a mode is offered when `--help` lists one of them (1.79.2's help prints
 * `standard, plan, accept-edits, yolo`). `reported`: the name `permission_mode_changed` carries.
 */
export const PERMISSION_MODES = [
  { id: 'default', label: 'Ask before edits', dangerous: false, flag: 'standard', names: ['default', 'standard'], reported: 'default' },
  { id: 'accept-edits', label: 'Accept edits', dangerous: false, flag: 'accept-edits', names: ['accept-edits', 'auto-accept'], reported: 'auto-accept' },
  { id: 'plan', label: 'Plan', dangerous: false, flag: 'plan', names: ['plan'], reported: 'plan' },
  { id: 'dont-ask', label: "Don't ask (deny anything not pre-approved)", dangerous: false, flag: 'dont-ask', names: ['dont-ask'], reported: 'dont-ask' },
  { id: 'yolo', label: 'Bypass permissions (yolo)', dangerous: true, flag: 'yolo', names: ['yolo', 'bypass'], reported: 'bypass' },
] as const

/** The default permission mode (`agents.commandcode.defaults`). */
export const DEFAULT_PERMISSION_MODE = 'default'

/** A mode name `--help` lists that the table above does not know is offered under its own name; one like these is dangerous. */
export const DANGEROUS_MODE_RE = /yolo|bypass|danger|skip/i

/** `--permission-mode <mode>   Set permission mode (standard, plan, accept-edits, yolo)`: the list in its description. */
export const HELP_MODES_RE = /--permission-mode <[^>]+>[^(\n]*\(([^)]*)\)/

/** Effort levels offered; no `--effort` is the model's own default. The CLI ignores a level a model lacks. */
export const EFFORTS = ['low', 'medium', 'high'] as const

/** The composer's first model: no `--model`, so the person's own Command Code default applies. */
export const DEFAULT_MODEL = 'default'
export const DEFAULT_MODEL_LABEL = 'Default (Command Code’s own)'

/**
 * `cmd --list-models` (human text, 1.79.2): `Available models  ·  87 models`, then per provider a heading line
 * and rows `<id>  <description>[ (default)]` (two or more spaces between), then a hint that starts with HINT.
 */
export const MODEL_ROW_RE = /^([A-Za-z0-9][\w.:/@+-]*[A-Za-z0-9])\s{2,}(\S.*)$/
export const MODEL_DEFAULT_MARK = /\s*\(default\)\s*$/
export const MODELS_HINT = 'Pass the full id'

/** Where Command Code keeps its files (no variable moves it): `<HOME>/.commandcode`. */
export const CONFIG_DIR_NAME = '.commandcode'
/** Transcripts: `<config dir>/projects/<slug of the cwd>/<session id>.jsonl`, with `<session id>.meta.json` beside. */
export const TRANSCRIPTS_DIR = 'projects'
export const TRANSCRIPT_EXT = '.jsonl'
export const META_EXT = '.meta.json'
/** The title in `<session id>.meta.json` (the generated one, or the person's own: then `userRenamed` is true). */
export const META_TITLE = 'title'
export const META_USER_RENAMED = 'userRenamed'
/** `<session id>.checkpoints.jsonl`: one record per prompt, written as the prompt is sent (lines joined by newlines). */
export const CHECKPOINTS_EXT = '.checkpoints.jsonl'
/** When a checkpoint's prompt was sent (ISO 8601). */
export const CHECKPOINT_AT = 'createdAt'

/**
 * Removed from the agent's environment: what a Command Code process sets for its own children, present only when Kea
 * itself was started inside one.
 */
export const ENV_REMOVED = ['COMMANDCODE_SESSION_ID', 'COMMANDCODE_PROJECT_DIR', 'COMMANDCODE_CWD', 'COMMANDCODE_PERMISSION_MODE', 'COMMANDCODE_HOOK_EVENT', 'COMMANDCODE_SCRATCHPAD'] as const

// ── the session mod ─────────────────────────────────────────────────────────────────────────────────────

/** The mod Kea ships and loads with `--mod`; its one option, read with the mod API's `getFlag`. */
export const MOD_FILE = 'kea-mod.ts'
export const MOD_OPTION = 'kea'

/** The mod API members kea-mod.ts calls (K-FX-2's fixtures were recorded through them). */
export const MOD_API = ['addFlag', 'getFlag', 'on', 'hooks'] as const
/** The session hooks it registers: they carry what the plain `session_start` / `session_shutdown` events lack. */
export const MOD_HOOKS = { start: 'onSessionStart', end: 'onSessionEnd' } as const

/** The agent events the mod subscribes to. `tool_queued` only starts its permission timer; the rest are forwarded. */
export const MOD_EVENTS = [
  'run_start',
  'run_end',
  'tool_queued',
  'tool_running',
  'tool_completed',
  'tool_errored',
  'tool_denied',
  'tool_hook_blocked',
  'interrupted',
  'run_error',
  'session_titled',
  'permission_mode_changed',
  'model_request_start',
  'compaction_start',
  'compaction_done',
] as const
export type ModEvent = (typeof MOD_EVENTS)[number]

/** The events the mod makes itself: the two session hooks under the host events' names, and its permission timer's. */
export const SESSION_START = 'session_start'
export const SESSION_END = 'session_shutdown'
export const TOOL_WAITING = 'kea_tool_waiting'

/** Never forwarded (the mod reads it only): its `input` is the one place a tool call's input appears. */
export const QUEUED_EVENT = 'tool_queued'
/** Forwarded only when its model differs from the last one sent. */
export const MODEL_EVENT = 'model_request_start'
/** Any of these for a tool of the waiting batch means its permissions were answered (or the run ended). */
export const BATCH_END_EVENTS = ['tool_running', 'tool_completed', 'tool_errored', 'tool_hook_blocked', 'run_end', 'interrupted', 'run_error'] as const
/** These carry the queued call's input along (the mod adds it). */
export const TOOL_EVENTS = ['tool_running', 'tool_completed', 'tool_errored', 'tool_denied', 'tool_hook_blocked'] as const
/** A run is over: the mod keeps nothing of it. */
export const RUN_END_EVENTS = ['run_end', 'interrupted', 'run_error'] as const
/** Where the mod looks for the session's transcript (it appears when a turn commits). */
export const TRANSCRIPT_LOOK_EVENTS = ['run_start', 'run_end'] as const
/** Tools that only read: when a batch waits for a permission, the prompt is for another of its tools if there is one. */
export const READ_ONLY_TOOLS = ['read_file', 'read_directory', 'glob', 'grep'] as const
/** Events that change state: still spooled above the soft cap. */
export const CRITICAL_EVENTS = ['session_start', 'session_shutdown', 'run_end', 'run_error', 'interrupted', 'kea_tool_waiting', 'tool_denied'] as const

/** Payload fields (the mod's projection): the dotted paths kept and summarised. `transcript` and `source` … are the mod's own. */
export const FIELDS = {
  event: 'type',
  sessionId: 'sessionId',
  source: 'source',
  reason: 'reason',
  transcript: 'transcript',
  toolCallId: 'toolCallId',
  toolName: 'toolName',
  title: 'title',
  mode: 'mode',
  model: 'model',
  stopReason: 'result.stopReason',
  finalText: 'result.finalText',
  error: 'error',
  errorName: 'error.name',
  errorStatus: 'error.status',
  errorMessage: 'error.message',
  toolCommand: 'input.command',
  toolFilePath: 'input.file_path',
  toolPath: 'input.path',
  toolUrl: 'input.url',
  toolPattern: 'input.pattern',
  toolQuery: 'input.query',
} as const

/** The projection's lists, by field name in FIELDS. */
export const PROJECTION_KEEP = ['event', 'sessionId', 'source', 'reason', 'transcript', 'toolCallId', 'toolName', 'title', 'mode', 'model', 'stopReason', 'error', 'errorName', 'errorStatus'] as const
export const PROJECTION_SUMMARISE = ['finalText', 'errorMessage', 'toolCommand', 'toolFilePath', 'toolPath', 'toolUrl', 'toolPattern', 'toolQuery'] as const
/** The input fields a tool call's one-line summary is taken from, first present wins. */
export const TOOL_SUMMARY_FIELDS = ['toolCommand', 'toolFilePath', 'toolPath', 'toolUrl', 'toolPattern', 'toolQuery'] as const

/** `onSessionStart`'s sources (carried by `session.started`), and `onSessionEnd`'s reasons. */
export const START_SOURCES = ['startup', 'resume'] as const
export const END_REASONS = { shutdown: 'shutdown', replaced: 'replaced' } as const

/** `run_end`'s stop reasons that some other event already reported (`interrupted`, `run_error`). */
export const STOP_ALREADY_REPORTED = ['interrupted', 'run_error'] as const

/**
 * `run_error`: an HTTP status → failure kind, then the error text; anything else is `other`. The kinds `rate_limit`
 * and `overloaded` are Kea's own names, so they come from the enum.
 */
export const FAILURE_STATUS: Readonly<Record<number, FailureKind>> = {
  401: 'auth',
  403: 'auth',
  402: 'billing',
  429: zFailureKind.enum.rate_limit,
  503: zFailureKind.enum.overloaded,
  529: zFailureKind.enum.overloaded,
}
export const FAILURE_TEXT: readonly { re: RegExp; kind: FailureKind }[] = [
  { re: /rate.?limit|too many requests/i, kind: zFailureKind.enum.rate_limit },
  { re: /overloaded|at capacity/i, kind: zFailureKind.enum.overloaded },
  { re: /insufficient credits|billing|payment/i, kind: 'billing' },
  { re: /not authenticated|authentication|api key|sign in again|log ?in/i, kind: 'auth' },
]

/** Transcript records (format version 3). */
export const TRANSCRIPT = {
  type: 'type',
  session: 'session',
  cwd: 'cwd',
  id: 'id',
  timestamp: 'timestamp',
  record: 'message',
  message: 'message',
  role: 'role',
  content: 'content',
  user: 'user',
  assistant: 'assistant',
  text: 'text',
  toolUse: 'tool_use',
  toolResult: 'tool_result',
  meta: 'meta',
  source: 'source',
  sourceUser: 'user',
  usage: 'usage',
  cost: 'costUsd',
  model: 'model',
} as const
/** A tool result's text when the person refused the tool: the run ended there (`run_end` with `permission_denied`). */
export const TRANSCRIPT_DENIED = 'Permission denied by the user.'
/** A failed run is written as a user-role record without a `meta.source`, its text starting with this. */
export const TRANSCRIPT_ERROR_PREFIX = 'Error: '
