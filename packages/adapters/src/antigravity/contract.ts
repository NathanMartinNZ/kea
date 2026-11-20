// Antigravity CLI's contract: every CLI flag, subcommand, mode, setting key, config path, status-line feed field,
// quota bucket, transcript value and environment prefix the adapter relies on — and nothing else. The contract tests
// check it against the CLI and recorded fixtures, U-AGT-12 checks the adapter's code uses nothing outside it, the
// feed's projection is generated from it, and `pnpm lint` (U-AGT-11) refuses every one of these strings outside
// packages/adapters.

/** The command on the login-shell PATH. */
export const COMMAND = 'agy'

/** Every name the CLI installs under. */
export const COMMANDS = [COMMAND] as const

/** Minimum supported version: base-family `--model` without `--effort`, stacked `statusLine`, `conversation_title`. */
export const MIN_VERSION = '1.3.4'

/** `agy --version` → `1.5.13`. */
export const VERSION_RE = /^\s*(?:agy\s+(?:version\s+)?)?v?(\d+\.\d+\.\d+)\s*$/im

/** What the composer shows when the CLI is missing. */
export const INSTALL_COMMAND = 'curl -fsSL https://antigravity.google/cli/install.sh | bash'

/** Every flag the adapter passes or reads during detection and launch. */
export const FLAGS = {
  version: '--version',
  help: '--help',
  model: '--model',
  effort: '--effort',
  mode: '--mode',
  dangerouslySkipPermissions: '--dangerously-skip-permissions',
  settings: '--settings',
  promptInteractive: '--prompt-interactive',
  conversation: '--conversation',
} as const

/** Subcommands the adapter invokes. */
export const SUBCOMMANDS = {
  models: 'models',
} as const

/**
 * Permission modes offered in the composer. `id`: Kea's name. `flag`: what `--mode=<flag>` passes, or null when the
 * mode uses no `--mode` flag (`default` passes no flag; `yolo` passes `--dangerously-skip-permissions`).
 */
export const PERMISSION_MODES = [
  { id: 'default', label: 'Ask before edits', dangerous: false, flag: null },
  { id: 'accept-edits', label: 'Accept edits', dangerous: false, flag: 'accept-edits' },
  { id: 'plan', label: 'Plan', dangerous: false, flag: 'plan' },
  { id: 'auto', label: 'Auto', dangerous: false, flag: 'auto' },
  { id: 'yolo', label: 'Bypass permissions (yolo)', dangerous: true, flag: null },
] as const

export const MODES = PERMISSION_MODES

/** The default permission mode (`agents.antigravity.defaults`). */
export const DEFAULT_PERMISSION_MODE = 'default'

/** Unknown mode names from `--help` matching this pattern are marked dangerous. */
export const DANGEROUS_MODE_RE = /yolo|bypass|danger|skip/i

/** `--mode   Set the agent execution mode for this session (accept-edits, auto, plan)`. */
export const HELP_MODES_RE = /--mode\b[^(\n]*\(([^)]*)\)/

/** `--effort   Reasoning effort for the current CLI session (low|medium|high|xhigh|max)`. */
export const HELP_EFFORTS_RE = /--effort\b[^(\n]*\(([^)]*)\)/

/** Canonical reasoning effort levels in order. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORTS)[number]

/** The composer's default model entry: passes no `--model`, so the user's own Antigravity CLI default applies. */
export const DEFAULT_MODEL = 'default'
export const DEFAULT_MODEL_LABEL = "Default (Antigravity's own)"

/** Status line printed by `agy models` before or beside the tab-separated model rows. */
export const MODELS_HEADER = 'Fetching available models...'

/**
 * Where Antigravity CLI keeps its configuration and transcripts under `HOME`. `legacyBrainDir` is the path
 * `statusLine` payloads emit without the `-cli` suffix (`~/.gemini/antigravity/brain`), which the adapter normalises
 * to `<configDir>/brain`.
 */
export const CONFIG = {
  dir: ['.gemini', 'antigravity-cli'],
  legacyBrainDir: ['.gemini', 'antigravity', 'brain'],
  brainSubdir: 'brain',
  settingsFile: 'settings.json',
} as const

/** Keys read from `settings.json` or passed in session-only `--settings=<json>`. */
export const SETTINGS_KEYS = {
  statusLine: 'statusLine',
  statusLineType: 'type',
  statusLineCommand: 'command',
  statusLineEnabled: 'enabled',
  statusLineStack: 'stack_with_default',
  trustedWorkspaces: 'trustedWorkspaces',
  clearScrollbackOnResize: 'clearScrollbackOnResize',
} as const

/** `statusLine.type` value for a shell command status line. */
export const STATUS_LINE_TYPE = 'command'

/** `kea-helper` subcommand invoked by the injected `statusLine`. */
export const FEED_SUBCOMMAND = 'feed'

/** Dotted payload paths used by `antigravityProjection()` and `mapping.ts`. */
export const FEED_FIELDS = {
  conversationId: 'conversation_id',
  agentState: 'agent_state',
  toolConfirmationPending: 'tool_confirmation_pending',
  cycleMode: 'cycle_mode',
  model: 'model',
  modelId: 'model.id',
  modelEffort: 'model.effort',
  transcriptPath: 'transcript_path',
  pendingInputCount: 'pending_input_count',
  taskCount: 'task_count',
  contextUsedPct: 'context_window.used_percentage',
  costTotalUsd: 'cost.total_usd',
  conversationTitle: 'conversation_title',
  subagents: 'subagents',
  subagentStatus: 'status',
  subagentsStatus: 'subagents.status',
  quota: 'quota',
  remainingFraction: 'remaining_fraction',
  remainingAmount: 'remaining_amount',
  resetTime: 'reset_time',
  resetInSeconds: 'reset_in_seconds',
  disabled: 'disabled',
} as const

export const FIELDS = FEED_FIELDS

/** Projection field lists by key in `FEED_FIELDS`. */
export const PROJECTION_KEEP = [
  'conversationId',
  'agentState',
  'toolConfirmationPending',
  'cycleMode',
  'modelId',
  'modelEffort',
  'transcriptPath',
  'pendingInputCount',
  'taskCount',
  'contextUsedPct',
  'costTotalUsd',
] as const

export const PROJECTION_SUMMARISE = ['conversationTitle'] as const

export const PROJECTION_QUOTA_FIELDS = [
  'remainingFraction',
  'remainingAmount',
  'resetTime',
  'resetInSeconds',
  'disabled',
] as const

/** Known `agent_state` values emitted by the status-line feed. */
export const AGENT_STATES = {
  idle: 'idle',
  working: 'working',
  toolUse: 'tool_use',
  reviewing: 'reviewing',
  authenticating: 'authenticating',
  initializing: 'initializing',
  error: 'error',
} as const

export const KNOWN_AGENT_STATES = [
  AGENT_STATES.idle,
  AGENT_STATES.working,
  AGENT_STATES.toolUse,
  AGENT_STATES.reviewing,
  AGENT_STATES.authenticating,
  AGENT_STATES.initializing,
  AGENT_STATES.error,
] as const
export type KnownAgentState = (typeof KNOWN_AGENT_STATES)[number]

/** `agent_state` values protected above `spool_soft_bytes` as state-changing transitions. */
export const CRITICAL_AGENT_STATES = [
  AGENT_STATES.idle,
  AGENT_STATES.reviewing,
  AGENT_STATES.authenticating,
  AGENT_STATES.error,
] as const

/** `subagents[*].status` value counted by `countWhere`. */
export const SUBAGENT_RUNNING = 'running'

/** Display labels and sort priority for known `quota` buckets in the status-line feed. */
export interface QuotaBucketMeta {
  readonly shortLabel: string
  readonly tipLabel: string
  readonly spokenLabel: string
  readonly priority: number
}

export const QUOTA_BUCKETS: Readonly<Record<string, QuotaBucketMeta>> = {
  'gemini-5h': { shortLabel: 'Gem 5h', tipLabel: 'Gemini 5-hour', spokenLabel: 'Gemini 5-hour', priority: 0 },
  'gemini-weekly': { shortLabel: 'Gem 7d', tipLabel: 'Gemini weekly', spokenLabel: 'Gemini weekly', priority: 1 },
  '3p-5h': { shortLabel: '3p 5h', tipLabel: 'Partner 5-hour', spokenLabel: 'partner 5-hour', priority: 2 },
  '3p-weekly': { shortLabel: '3p 7d', tipLabel: 'Partner weekly', spokenLabel: 'partner weekly', priority: 3 },
  'gemini-argon-wtu-weekly': {
    shortLabel: 'Argon 7d',
    tipLabel: 'Gemini Argon weekly',
    spokenLabel: 'Gemini Argon weekly',
    priority: 4,
  },
} as const

/** Transcript step record fields and values (`transcript.jsonl`). */
export const TRANSCRIPT = {
  stepTypeField: 'type',
  stepStatusField: 'status',
  modelField: 'model',
  toolCallsField: 'tool_calls',
  userInput: 'USER_INPUT',
  plannerResponse: 'PLANNER_RESPONSE',
  generic: 'GENERIC',
  done: 'DONE',
  running: 'RUNNING',
  error: 'ERROR',
} as const

export const TRANSCRIPT_EXT = '.jsonl'

/**
 * Prefix of environment variables set by an outer Antigravity session (`ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_AGENT`,
 * `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CONVERSATION_ID`, and siblings) that must be stripped before launching a child.
 */
export const STRIP_ENV_PREFIX = 'ANTIGRAVITY_'
