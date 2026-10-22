// Claude Code's contract: every CLI flag, env var, path, hook event, payload field and status-file value the adapter
// relies on — and nothing else. The contract tests check it against the installed CLI (K-CL-*), U-AGT-12 checks the
// adapter's code uses nothing outside it, the hook projection is generated from it, and `pnpm lint` (U-AGT-11) refuses
// every one of these strings outside packages/adapters.

import { zFailureKind, type FailureKind } from '@kea/protocol'

/** The command on the login-shell PATH. */
export const COMMAND = 'claude'

/** Minimum supported version: `manual`, worktrees sharing the main checkout's local settings. */
export const MIN_VERSION = '2.1.211'

/** `claude --version` → `2.1.296 (Claude Code)`. */
export const VERSION_RE = /^\s*(\d+\.\d+\.\d+)\s+\(Claude Code\)/

/** What the composer shows when the CLI is missing. */
export const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash'

/** Subcommand argv for detection: `claude auth status` prints JSON and exits 0 (logged in) or 1. */
export const AUTH_STATUS = ['auth', 'status'] as const
/** The logged-in field of `auth status`'s JSON. */
export const AUTH_LOGGED_IN = 'loggedIn'
/** Subcommand argv that signs the CLI in again: what the signed-out condition tells the person to run. */
export const AUTH_LOGIN = ['auth', 'login'] as const

/** Every flag the adapter passes (K-CL-2 checks `--help` lists each). */
export const FLAGS = {
  sessionId: '--session-id',
  model: '--model',
  effort: '--effort',
  permissionMode: '--permission-mode',
  settings: '--settings',
  resume: '--resume',
  version: '--version',
  help: '--help',
} as const

/** Ends the options: the prompt follows. */
export const END_OF_OPTIONS = '--'

/**
 * Permission modes: id (what the adapter passes), label, danger. `manual` is an alias of `default` since 2.1.200 and
 * payloads report `default`; K-CL-3 accepts either name of the alias group in `--help`.
 */
export const PERMISSION_MODES = [
  { id: 'manual', label: 'Ask before edits', dangerous: false, aliases: ['default'] },
  { id: 'acceptEdits', label: 'Accept edits', dangerous: false, aliases: [] },
  { id: 'plan', label: 'Plan', dangerous: false, aliases: [] },
  { id: 'auto', label: 'Auto', dangerous: false, aliases: [] },
  { id: 'dontAsk', label: "Don't ask (deny anything not pre-approved)", dangerous: false, aliases: [] },
  { id: 'bypassPermissions', label: 'Bypass permissions', dangerous: true, aliases: [] },
] as const

/** Version gates: `manual` names the default mode from this version (payloads report `default` either way). */
export const GATES = { manualAlias: '2.1.200' } as const

/** The default permission mode (`agents.claude.defaults`). */
export const DEFAULT_PERMISSION_MODE = 'manual'

/** Effort levels, in order; K-CL-4 checks `--help` lists them. `xhigh` is hidden for 4.6-era model ids. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Model ids of the 4.6 era (no `xhigh`). */
export const NO_XHIGH_MODEL_RE = /-4-6\b/

/** The static model list: aliases are stable; `default` passes no `--model`. Plus free text. */
export const MODELS = [
  { id: 'default', label: 'Default (recommended)', efforts: true },
  { id: 'fable', label: 'Fable', efforts: true },
  { id: 'opus', label: 'Opus', efforts: true },
  { id: 'sonnet', label: 'Sonnet', efforts: true },
  { id: 'haiku', label: 'Haiku', efforts: false },
  { id: 'best', label: 'Best available', efforts: true },
  { id: 'opusplan', label: 'Opus plan, Sonnet execute', efforts: true },
] as const
export const DEFAULT_MODEL = 'default'

/**
 * Context windows by model id prefix, for `meta.contextUsedPct`, from Claude 2.1.296's own model table; the longest
 * matching prefix wins; an unknown model gets none.
 */
export const CONTEXT_WINDOWS: readonly { prefix: string; tokens: number }[] = [
  { prefix: 'claude-fable-5', tokens: 1_000_000 },
  { prefix: 'claude-opus-5', tokens: 1_000_000 },
  { prefix: 'claude-sonnet-5', tokens: 1_000_000 },
  { prefix: 'claude-opus-4-8', tokens: 1_000_000 },
  { prefix: 'claude-opus-4-7', tokens: 1_000_000 },
  { prefix: 'claude-opus-4-6', tokens: 1_000_000 },
  { prefix: 'claude-opus-4-5', tokens: 200_000 },
  { prefix: 'claude-opus-4-1', tokens: 200_000 },
  { prefix: 'claude-sonnet-4-6', tokens: 1_000_000 },
  { prefix: 'claude-sonnet-4-5', tokens: 200_000 },
  { prefix: 'claude-sonnet-4-0', tokens: 200_000 },
  { prefix: 'claude-haiku-4-5', tokens: 1_000_000 },
]

/** Environment the adapter sets (the renderer setting): `1` fullscreen, `0` classic, unset for the agent's default. */
export const ENV_NO_FLICKER = 'CLAUDE_CODE_NO_FLICKER'
/** Where Claude keeps its config (status files, transcripts): this, else `~/.claude`. */
export const ENV_CONFIG_DIR = 'CLAUDE_CONFIG_DIR'
/** The config directory under HOME when CLAUDE_CONFIG_DIR is unset. */
export const CONFIG_DIR_NAME = '.claude'
/** Live status files: `<config dir>/sessions/<pid>.json`. */
export const STATUS_DIR = 'sessions'
/**
 * Transcripts: `<config dir>/projects/<cwd slug>/<session id>.jsonl`; a payload's transcript_path elsewhere is refused.
 */
export const TRANSCRIPTS_DIR = 'projects'

/**
 * Removed from the agent's environment: markers of a Claude process, present only when Kea itself was started
 * inside a Claude session, which would make the agent believe it is nested in it.
 */
export const ENV_REMOVED = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
] as const

/** Inline settings keys. */
export const SETTINGS_HOOKS = 'hooks'

/** Hook events Kea injects, each synchronous, exec form, `timeout` L.hookTimeoutS. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** Hook events that change state: still spooled above the soft cap. */
export const CRITICAL_EVENTS: readonly HookEvent[] = ['SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'PermissionRequest', 'PermissionDenied', 'Notification']

/** Payload fields (the projection's): the dotted paths the helper keeps, counts and summarises. */
export const FIELDS = {
  event: 'hook_event_name',
  sessionId: 'session_id',
  transcriptPath: 'transcript_path',
  cwd: 'cwd',
  permissionMode: 'permission_mode',
  toolName: 'tool_name',
  toolUseId: 'tool_use_id',
  agentId: 'agent_id',
  agentType: 'agent_type',
  promptId: 'prompt_id',
  effortLevel: 'effort.level',
  notificationType: 'notification_type',
  source: 'source',
  reason: 'reason',
  error: 'error',
  sessionTitle: 'session_title',
  model: 'model',
  backgroundTasks: 'background_tasks',
  sessionCrons: 'session_crons',
  toolCommand: 'tool_input.command',
  toolFilePath: 'tool_input.file_path',
  toolUrl: 'tool_input.url',
  toolPattern: 'tool_input.pattern',
  toolQuestions: 'tool_input.questions',
  message: 'message',
  lastAssistantMessage: 'last_assistant_message',
  prompt: 'prompt',
} as const

/** The projection's lists, by field name in FIELDS. */
export const PROJECTION_KEEP = ['event', 'sessionId', 'transcriptPath', 'cwd', 'permissionMode', 'toolName', 'toolUseId', 'agentId', 'agentType', 'promptId', 'effortLevel', 'notificationType', 'source', 'reason', 'error', 'sessionTitle', 'model'] as const
export const PROJECTION_COUNT = ['backgroundTasks', 'sessionCrons'] as const
export const PROJECTION_SUMMARISE = ['toolCommand', 'toolFilePath', 'toolUrl', 'toolPattern', 'toolQuestions', 'message', 'lastAssistantMessage', 'prompt'] as const

/** `SessionStart.source` values (carried by `session.started`). */
export const START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const

/** The tool whose permission request is a question (on 2.1.296 PermissionRequest fires for it too). */
export const QUESTION_TOOL = 'AskUserQuestion'
/** The first question's text inside a summarised `tool_input.questions` (compact JSON, possibly cut). */
export const QUESTION_TEXT_RE = /"question":"((?:[^"\\]|\\.)*)"/

/** `UserPromptSubmit.prompt` of a background subagent's completion fed back by Claude. */
export const TASK_NOTIFICATION_PREFIX = '<task-notification>'

/** `Notification.notification_type` values. */
export const NOTIFICATION = { permission: 'permission_prompt', elicitation: 'elicitation_dialog', idle: 'idle_prompt', needsInput: 'agent_needs_input' } as const

/**
 * `StopFailure.error` → failure kind; anything else is `other`. Claude's `rate_limit` and `overloaded` are also Kea's
 * own kind names, so those two values come from the enum, not from a string here.
 */
export const FAILURE_KINDS: Readonly<Record<string, FailureKind>> = {
  rate_limit: zFailureKind.enum.rate_limit,
  overloaded: zFailureKind.enum.overloaded,
  authentication_failed: 'auth',
  billing_error: 'billing',
}
/** The error values only Claude uses (for the agent-string lint, U-AGT-11). */
export const STOP_FAILURE_ERRORS = ['authentication_failed', 'billing_error'] as const

/** Payloads report `default` for the mode the adapter calls `manual`. */
export const REPORTED_DEFAULT_MODE = 'default'

/** Transcript records. */
export const TRANSCRIPT = {
  type: 'type',
  aiTitle: 'ai-title',
  aiTitleField: 'aiTitle',
  customTitle: 'custom-title',
  customTitleField: 'customTitle',
  costState: 'cost-state',
  /** 2.1.296's field; early fake-agent transcripts use `costUsd`. */
  costField: 'totalCostUSD',
  costFieldOld: 'costUsd',
  user: 'user',
  assistant: 'assistant',
  message: 'message',
  content: 'content',
  text: 'text',
  usage: 'usage',
  model: 'model',
  stopReason: 'stop_reason',
  endTurn: 'end_turn',
  toolUse: 'tool_use',
  toolResult: 'tool_result',
  inputTokens: 'input_tokens',
  cacheCreation: 'cache_creation_input_tokens',
  cacheRead: 'cache_read_input_tokens',
  sidechain: 'isSidechain',
} as const
/** User records that are not prompts: Claude's own (`isMeta`), the compaction summary, and slash-command records. */
export const NOT_PROMPT_FLAGS = ['isMeta', 'isCompactSummary'] as const
export const COMMAND_RECORD_PREFIXES = ['<command-name>', '<local-command-'] as const
/** A typed slash command (`/compact`): not a model turn of its own. */
export const SLASH_COMMAND_RE = /^\/[A-Za-z]/

/** Both interrupt markers start with this (`… for tool use]` after an Esc or "No" at a permission prompt). */
export const INTERRUPT_PREFIX = '[Request interrupted by user'

/** Live status file: fields and known values. An unknown value is ignored and counted (K-FX-7). */
export const STATUS_FILE = {
  pid: 'pid',
  sessionId: 'sessionId',
  status: 'status',
  waitingFor: 'waitingFor',
} as const
export const STATUS_VALUES = ['busy', 'waiting', 'idle', 'shell'] as const
/** `waitingFor` (while `waiting`) → Kea's reading: a permission item, a question item, or a dialog (not attention). */
export const WAITING_FOR: Readonly<Record<string, 'permission' | 'question' | 'other'>> = {
  'permission prompt': 'permission',
  'input needed': 'question',
  'dialog open': 'other',
  'worker request': 'permission',
  'sandbox request': 'permission',
  'goal proposal': 'question',
}
