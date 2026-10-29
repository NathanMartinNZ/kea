// The `sessions` feature's messages: projects first, then sessions, with the creation pipeline as a session sees it and
// the composer's core side.
//
// What crosses the boundary: the `projects` store (Project by id) and the `sessions` store (SessionView by id), both
// snapshot + deltas, and the `projectsApi` and `sessionsApi` calls. Errors are RpcErrors with one of PROJECT_ERRORS /
// SESSION_ERRORS as their code.
import { z } from 'zod'
import { L } from './generated/limits.ts'
import { defineApi } from './rpc.ts'
import { zEndReason, zFailureKind, zIsolation, zLifecycle, zPhase, zStatusSource, zTitleSource, type Isolation } from './enums.ts'
import { zBranchPrefix } from './settings.ts'
import { zPtyId, zRecordKey, zSessionId } from './terminal.ts'

/** A database id: a ULID, generated in core, of 26 Crockford base-32 characters. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
export const zProjectId = z.string().regex(ULID_RE)

/** An absolute path as the renderer sends it (core resolves it with realpath). */
const zAbsPath = z.string().startsWith('/')

// ── LaunchConfig (`sessions.launch_config`) ────────────────────────────────────────────────────────────────

/** How an agent is launched: the prompt plus the adapter's options. */
export const zLaunchConfig = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  extraArgs: z.array(z.string()).max(L.settingsExtraArgsMax).optional(),
})
export type LaunchConfig = z.infer<typeof zLaunchConfig>
/** LaunchConfig without the prompt (presets, `ProjectSettings.lastLaunch`). */
export const zLaunchOptions = zLaunchConfig.omit({ prompt: true })
export type LaunchOptions = z.infer<typeof zLaunchOptions>

// ── ProjectSettings (JSON in `projects.settings`) ───────────────────────────────────────────────────────

export const SERVICES_MODES = ['shared', 'perSession'] as const

/** The default "Files to copy" (gitignore syntax): `.env` and `.env.*` at any depth, two files at the root. */
export const DEFAULT_FILES_TO_COPY: readonly string[] = ['.env', '.env.*', '/CLAUDE.local.md', '/.commandcode/settings.local.json']

/** The default rebuildable folders: directories that match one of these and are git-ignored. */
export const DEFAULT_REBUILDABLE_DIRS: readonly string[] = ['node_modules', '.next', '.turbo', '.parcel-cache', 'dist', 'build', 'out', 'target', '.venv', 'coverage']

/** A project's settings, kept as JSON. Every field is optional: an absent one takes its default where it is used. */
export const zProjectSettings = z.object({
  /** Override the detected default branch. */
  baseBranch: z.string().min(1).optional(),
  /** Per-project override of `general.branchPrefix`. */
  branchPrefix: zBranchPrefix.optional(),
  /** Else `.kea/setup.sh` if present. */
  setupCommand: z.string().optional(),
  /** Else `.kea/teardown.sh` if present. */
  teardownCommand: z.string().optional(),
  startAgentWithoutWaitingForSetup: z.boolean().optional(),
  /** `perSession` gives each session a `COMPOSE_PROJECT_NAME` of its own; default `shared`. */
  services: z.enum(SERVICES_MODES).optional(),
  /** Fixed ports this project's dev servers have listened on, so Run can tell another session holds one. */
  serverPorts: z.array(z.number().int().min(1).max(0xffff)).optional(),
  /** Default: DEFAULT_REBUILDABLE_DIRS. */
  rebuildableDirs: z.array(z.string()).optional(),
  /** Default: DEFAULT_FILES_TO_COPY; ignored when `.worktreeinclude` exists. */
  filesToCopy: z.array(z.string()).optional(),
  /** Default `./start.sh`. */
  runCommand: z.string().optional(),
  /** Start the session's dev server once the session is created and its setup, if any, has succeeded. */
  autoStartServer: z.boolean().optional(),
  /** Turn on git's fsmonitor (`core.fsmonitor`, `core.untrackedCache`) in each session's worktree config. */
  useFsmonitor: z.boolean().optional(),
  /**
   * The choices of the project's last start; `isolation` is also the composer's Worktree toggle default.
   * `byAgent`: the choices of the last start with each agent, which the composer takes when the agent is changed, for
   * the L.lastLaunchAgentsMax most recent agents.
   */
  lastLaunch: z.object({ agent: z.string().min(1), config: zLaunchOptions, isolation: zIsolation, base: z.string(), byAgent: z.record(zRecordKey, zLaunchOptions).optional() }).optional(),
})
export type ProjectSettings = z.infer<typeof zProjectSettings>
export const PROJECT_SETTING_KEYS = Object.keys(zProjectSettings.shape) as (keyof ProjectSettings)[]
const zProjectSettingKey = z.enum(PROJECT_SETTING_KEYS as [keyof ProjectSettings, ...(keyof ProjectSettings)[]])

// ── the `projects` store ─────────────────────────────────────────────────────────────────────────────────

export const PROJECTS_STORE = 'projects'

/** One row of the `projects` table, as the renderer sees it. The sidebar orders projects by `sortOrder`. */
export const zProject = z.object({
  id: zProjectId,
  /** Display name: the folder name until renamed. */
  name: z.string(),
  /** realpath of the main checkout, or of the folder for a non-git project. */
  rootPath: z.string(),
  /** False: a plain folder — its sessions are always `inplace` and the git UI is hidden. */
  isGit: z.boolean(),
  /**
   * True (and only then present): a bare repository. `rootPath` is the repository's own folder, there is
   * no main checkout, its sessions are always worktrees and no base is "Current HEAD".
   */
  bare: z.boolean().optional(),
  /** The detected default branch, cached; null until detected. `settings.baseBranch` overrides it. */
  defaultBranch: z.string().nullable(),
  /** Manual order: ascending; new projects are appended. */
  sortOrder: z.number(),
  collapsed: z.boolean(),
  settings: zProjectSettings,
  /** The root was not there at the last check: dimmed, with Locate… and Remove. */
  missing: z.boolean(),
  /** A Claude hook has arrived from this repo, so its workspace trust is accepted. */
  trustConfirmed: z.boolean(),
  createdAt: z.number().int(),
  /**
   * How many of its sessions "Restore Deleted Session…" lists (deleted within the retention); 0 disables the command,
   * with its reason. Counted again on every delete, restore and purge (a session whose retention ends between
   * two purges counts until the next one).
   */
  restorable: z.number().int().nonnegative(),
})
export type Project = z.infer<typeof zProject>

/**
 * How `projects.add` and `projects.locate` registered a path: as given, as the repo root of a folder inside a
 * repo, or as the main worktree of a linked worktree. The UI says so when it is not `asGiven`.
 */
export const REGISTERED_AS = ['asGiven', 'repoRoot', 'mainWorktree'] as const

/** The codes of the RpcErrors these calls fail with. */
export const PROJECT_ERRORS = [
  /** No project with that id. */
  'not_found',
  /** The path does not exist or is not a directory. */
  'invalid_path',
  /** `projects.locate`: another project already has that root. */
  'already_registered',
  /** `projects.initGit`: git cannot run, `git init` failed, or the folder is inside another repository. */
  'git_failed',
] as const

/** A running session "Stop and remove" stops: its agent or a shell tab runs, and it has no worktree on disk. */
export const zRunningSession = z.object({ sessionId: zSessionId, title: z.string() })

/** Why a session keeps its project from being removed: its worktree is on disk, or its creation is in progress or failed. */
export const REMOVE_BLOCKERS = ['worktree', 'creating', 'createFailed'] as const
/** A session that keeps its project from being removed until the user deletes, discards or cleans it. */
export const zBlockingSession = z.object({ sessionId: zSessionId, title: z.string(), reason: z.enum(REMOVE_BLOCKERS) })
export type RemoveBlocker = (typeof REMOVE_BLOCKERS)[number]

/** What removing a project would do. */
export const zProjectRemoval = z.object({
  /** Sessions that refuse the removal, "Stop and remove" included. */
  blocking: z.array(zBlockingSession),
  /** Sessions still running, stopped only by "Stop and remove". */
  running: z.array(zRunningSession),
  /** Deleted sessions still restorable: removing the project ends that, their snapshot refs go. */
  restorable: z.number().int().min(0),
})
export type ProjectRemoval = z.infer<typeof zProjectRemoval>

/** Methods core serves to the renderer for projects. Every change also reaches the `projects` store. */
export const projectsApi = defineApi({
  /**
   * Register a folder. A folder inside a repo registers the repo root, a linked worktree its main worktree; a folder
   * outside git is a non-git project. A root already registered returns that project (`existing: true`: the UI focuses
   * it).
   */
  'projects.add': {
    args: z.object({ path: zAbsPath }),
    result: z.object({ project: zProject, existing: z.boolean(), registered: z.enum(REGISTERED_AS) }),
  },
  /** What removing the project would do: the confirmation's contents. */
  'projects.removePreview': { args: z.object({ id: zProjectId }), result: zProjectRemoval },
  /**
   * Remove a project. Refused (`removed: false`) while any session is `blocking` (its worktree is on disk,
   * or its creation is in progress or failed), and while sessions are `running` unless `stopSessions` ("Stop and
   * remove"). Removing ends the restorability of its deleted sessions (`restorable`) and drops their snapshot refs;
   * nothing else in the repository is touched.
   */
  'projects.remove': {
    args: z.object({ id: zProjectId, stopSessions: z.boolean().optional() }),
    result: zProjectRemoval.extend({ removed: z.boolean() }),
  },
  /** Rename the project; the name is for display only. */
  'projects.rename': { args: z.object({ id: zProjectId, name: z.string().min(1).max(L.projectNameMaxChars) }), result: z.object({ project: zProject }) },
  /** Drag to `index` (0 = first) of the current order. */
  'projects.move': { args: z.object({ id: zProjectId, index: z.number().int().min(0) }), result: z.object({ ok: z.boolean() }) },
  /** Collapsed state, persisted. */
  'projects.setCollapsed': { args: z.object({ id: zProjectId, collapsed: z.boolean() }), result: z.object({ ok: z.boolean() }) },
  /**
   * "Locate…" a missing project at `path`, resolved as in `projects.add`. Linked worktrees are repaired
   * (`git worktree repair`, `repaired`), and in-place sessions move with the root.
   */
  'projects.locate': {
    args: z.object({ id: zProjectId, path: zAbsPath }),
    result: z.object({ project: zProject, registered: z.enum(REGISTERED_AS), repaired: z.boolean() }),
  },
  /** Change project settings: `set` merges fields, `unset` removes them. */
  'projects.updateSettings': {
    args: z.object({ id: zProjectId, set: zProjectSettings.optional(), unset: z.array(zProjectSettingKey).optional() }),
    result: z.object({ settings: zProjectSettings }),
  },
  /**
   * "Initialise git…": `git init` in a non-git project's folder, which then is a git project (`isGit`), and one empty
   * commit with the user's own git identity, so a worktree session can start at once. A folder already at
   * a repository's root is only marked as git; one inside another repository is refused (`git_failed`). Without a
   * configured git identity the repository stays but the call fails (`git_failed`), and the composer says it has no
   * commit yet.
   */
  'projects.initGit': { args: z.object({ id: zProjectId }), result: z.object({ project: zProject }) },
  /** Check every project's root again now (also done at launch); returns the ids now missing. */
  'projects.checkRoots': { args: z.object({}), result: z.object({ missing: z.array(zProjectId) }) },
})

// ── sessions (the `sessions` and `session_runtime` tables, the `sessions` store) ───────────────────────────────

export const SESSIONS_STORE = 'sessions'

/** A session id as the renderer sends it (a ULID for sessions Kea created; a rebuilt one keeps its directory name). */
export const zSessionRef = zSessionId

/**
 * Where a new worktree starts: the default branch, fetched (`default`); the main checkout's current HEAD (`head`); any
 * branch or tag (`ref`, with `ref` its name); or an existing branch checked out as-is with no new branch (`existing`,
 * with `ref` the branch name).
 */
export const BASE_KINDS = ['default', 'head', 'ref', 'existing'] as const
export type BaseKind = (typeof BASE_KINDS)[number]
export const zBaseChoice = z.object({ kind: z.enum(BASE_KINDS), ref: z.string().min(1).max(L.settingsBranchPrefixMaxChars + L.slugMaxChars * 4).optional() })
export type BaseChoice = z.infer<typeof zBaseChoice>

/** `ProjectSettings.lastLaunch.base` as a string: `default`, `head`, `ref:<name>` or `existing:<name>`. */
export function baseKey(b: BaseChoice): string {
  if ((b.kind === 'ref' || b.kind === 'existing') && b.ref) return `${b.kind}:${b.ref}`
  return b.kind === 'head' ? 'head' : 'default'
}

/**
 * The project's `lastLaunch` after a start: the start's choices, and each agent's last choices with this one's
 * added (`max` agents, the most recently started last; the oldest goes first).
 */
export function nextLastLaunch(prev: ProjectSettings['lastLaunch'], start: { agent: string; config: LaunchOptions; isolation: Isolation; base: string }, max: number): NonNullable<ProjectSettings['lastLaunch']> {
  const byAgent = new Map(Object.entries(prev?.byAgent ?? {}))
  // one start before `byAgent` existed: its agent's choices are known too
  if (prev && !byAgent.has(prev.agent)) byAgent.set(prev.agent, prev.config)
  byAgent.delete(start.agent)
  byAgent.set(start.agent, start.config)
  while (byAgent.size > Math.max(1, max)) byAgent.delete(byAgent.keys().next().value!)
  return { agent: start.agent, config: start.config, isolation: start.isolation, base: start.base, byAgent: Object.fromEntries(byAgent) }
}

/** The choices of the project's last start with `agent`, or undefined when it never started one. */
export function lastChoicesFor(last: ProjectSettings['lastLaunch'], agent: string): LaunchOptions | undefined {
  if (!last) return undefined
  if (last.agent === agent) return last.config
  return last.byAgent && Object.hasOwn(last.byAgent, agent) ? last.byAgent[agent] : undefined
}

/** The inverse of `baseKey`; anything unreadable is the default branch. */
export function parseBaseKey(s: string | undefined): BaseChoice {
  if (s === 'head') return { kind: 'head' }
  const m = /^(ref|existing):(.+)$/.exec(s ?? '')
  return m ? { kind: m[1] as 'ref' | 'existing', ref: m[2]! } : { kind: 'default' }
}

/** A branch name the user typed (checked with `git check-ref-format --branch` in core). */
export const zBranchName = z.string().min(1).max(L.settingsBranchPrefixMaxChars + L.slugMaxChars * 4)

/** One pending attention item, a permission prompt or a question (`session_runtime.attention`). */
export const zAttentionItem = z.object({
  kind: z.enum(['permission', 'question']),
  key: z.string(),
  summary: z.string(),
  source: zStatusSource,
  at: z.number().int(),
  /** A prompt the agent's status file only estimates (an unknown `waitingFor`): shown, never notified. */
  estimated: z.literal(true).optional(),
})
export type AttentionItem = z.infer<typeof zAttentionItem>

/**
 * The creation pipeline's journaled steps, in order (`sessions.creation_step`). `base` also records the
 * resolved base on the session, and `submodules` also pulls Git LFS files.
 */
export const CREATION_STEPS = ['git', 'base', 'add', 'copy', 'submodules', 'setup', 'launch'] as const
export type CreationStep = (typeof CREATION_STEPS)[number]

/** What the main pane shows while a session is created or after its creation failed. */
export const zCreationState = z.object({
  /** The step running, or the one that failed. */
  step: z.enum(CREATION_STEPS),
  /** `create_failed`: why (Retry · Discard). */
  error: z.string().nullable(),
  /** Non-fatal notes the creation log also has: "using cached origin/main (fetch failed)". */
  notices: z.array(z.string()),
  /** Bytes in the creation log (`sessions.creationLog` reads it; a change means new lines). */
  logBytes: z.number().int().min(0),
})
export type CreationState = z.infer<typeof zCreationState>

/** The setup command's run: its `Setup` tab offers Skip while running, Retry and Start agent anyway after a failure. */
export const SETUP_STATES = ['running', 'failed', 'done', 'skipped'] as const
export const zSetupState = z.object({
  state: z.enum(SETUP_STATES),
  /** The PTY of the `Setup` tab (kind `script`). */
  ptyId: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  reason: z.enum(['create', 'unarchive', 'restore']),
})
export type SetupState = z.infer<typeof zSetupState>

/**
 * The sidebar glyph, derived by core so both sides agree: `working` (spinner: starting, working, creating), `needsYou`
 * (attention set non-empty), `unread` (turn finished, not yet seen), `idle` (read, or no turn yet), `detached` (dashed
 * ring: stopped by the user or exited normally), `failed` (turn failed, crashed, lost, creation failed), `limited` (an
 * account condition: a rate limit, or an auth or billing failure).
 */
export const SESSION_GLYPHS = ['working', 'needsYou', 'unread', 'idle', 'detached', 'failed', 'limited'] as const
export type SessionGlyph = (typeof SESSION_GLYPHS)[number]

/** One row of the `sessions` store: the session and its runtime row, plus what core derives for the sidebar. */
export const zSessionView = z.object({
  id: zSessionId,
  projectId: zProjectId,
  /** Stable after creation: the worktree directory and branch derive from it. */
  slug: z.string(),
  title: z.string(),
  titleSource: zTitleSource,
  isolation: zIsolation,
  /** The worktree path, or the project root for an in-place session. */
  cwd: z.string(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  /** `KEA_PORT`; the block is `portBase … portBase + L.portBlockSize − 1`. Null while archived or deleted. */
  portBase: z.number().int().nullable(),
  agent: z.string(),
  agentSessionId: z.string().nullable(),
  /** The launch config without its prompt (the session header's popover). */
  launch: zLaunchOptions,
  lifecycle: zLifecycle,
  endReason: zEndReason.nullable(),
  /** Ascending: the stable order within a project (newest first; a drag reorder persists). */
  sortOrder: z.number(),
  pinnedOrder: z.number().int(),
  createdAt: z.number().int(),
  archivedAt: z.number().int().nullable(),
  /** Allocated size, an upper bound; null until measured. */
  diskBytes: z.number().int().nullable(),
  diskAt: z.number().int().nullable(),
  // session_runtime
  phase: zPhase,
  attention: z.array(zAttentionItem),
  background: z.boolean(),
  failureKind: zFailureKind.nullable(),
  unread: z.boolean(),
  lastActivityAt: z.number().int(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: z.string().nullable(),
  costUsd: z.number().nullable(),
  contextPct: z.number().nullable(),
  /** The session's colour in the sidebar: an index into the session palette (`% L.sessionColors`), chosen once by core. */
  color: z.number().int().min(0),
  // derived
  glyph: z.enum(SESSION_GLYPHS),
  /** The row's trailing label: the first attention item's kind (`permission`, `question`), or null. */
  label: z.string().nullable(),
  /** While `creating`, and after a failed creation (`create_failed`); null otherwise. */
  creation: zCreationState.nullable(),
  /** The setup command's last run; null when the project has none. */
  setup: zSetupState.nullable(),
  /** The last teardown failed or timed out (Retry teardown · View log). */
  teardownFailed: z.boolean(),
  /** The worktree directory is gone (Recreate from branch · Delete session). */
  worktreeMissing: z.boolean(),
  /** A dev server of this session is running (the row's trailing dot). */
  serverRunning: z.boolean(),
})
export type SessionView = z.infer<typeof zSessionView>

/** The sidebar glyph for a session (see SESSION_GLYPHS). */
export function sessionGlyph(s: Pick<SessionView, 'lifecycle' | 'endReason' | 'phase' | 'attention' | 'unread' | 'failureKind'>): SessionGlyph {
  switch (s.lifecycle) {
    case 'creating':
      return 'working'
    case 'create_failed':
      return 'failed'
    case 'live':
      if (s.attention.length) return 'needsYou'
      if (s.phase === 'failed') return s.failureKind === 'rate_limit' || s.failureKind === 'auth' || s.failureKind === 'billing' ? 'limited' : 'failed'
      if (s.phase === 'starting' || s.phase === 'working') return 'working'
      if (s.phase === 'blocked') return 'needsYou'
      if (s.phase === 'ready' && s.unread) return 'unread'
      return 'idle'
    default:
      return s.endReason === 'crashed' || s.endReason === 'lost' ? 'failed' : 'detached'
  }
}

/** A problem `sessions.validate` found. `hard` ones disable Start, with `message` as its tooltip. */
export const VALIDATION_CODES = [
  /** The branch exists already: `suggestion` is the next free name (`-2`, …), or use it as an existing branch. */
  'branchExists',
  /** The existing branch is checked out in another worktree: `path` (and `sessionId` when it is a session's). */
  'branchCheckedOut',
  /** Not a valid branch name (`git check-ref-format --branch`). */
  'branchInvalid',
  /** The base ref does not resolve. */
  'baseMissing',
  /**
   * The agent is not installed or not known (`suggestion`: its install command), or is outdated or signed out (a soft
   * note). The composer reports this one itself.
   */
  'agentMissing',
  /** The project's root is missing. */
  'projectMissing',
  /** A worktree in a non-git project, or git is missing. */
  'notGit',
  /** In place in a bare repository, which has no working tree to run in. */
  'bareInPlace',
  /** The worktree path would not stay under L.worktreePathMaxChars. */
  'pathTooLong',
  /** The worktree location (`general.worktreeRoot`) is the home folder, or lies in or holds a project. */
  'worktreeRoot',
] as const
export const zValidationProblem = z.object({
  code: z.enum(VALIDATION_CODES),
  hard: z.boolean(),
  message: z.string(),
  suggestion: z.string().nullable(),
  path: z.string().nullable(),
  sessionId: zSessionId.nullable(),
})
export type ValidationProblem = z.infer<typeof zValidationProblem>

/** A ref the Base list offers (from `git for-each-ref`). */
export const zBaseRef = z.object({
  name: z.string(),
  kind: z.enum(['local', 'remote', 'tag']),
  /** A local branch checked out in a worktree: where (an existing-branch base there is refused). */
  checkedOutAt: z.string().nullable(),
})

/**
 * What the composer needs to open a draft like a session's (Duplicate); the isolation holds for that draft
 * only.
 */
export const zComposerDraft = z.object({
  projectId: zProjectId,
  agent: z.string(),
  prompt: z.string().max(L.composerDraftMaxBytes),
  config: zLaunchOptions,
  isolation: zIsolation,
  base: zBaseChoice,
})
export type ComposerDraft = z.infer<typeof zComposerDraft>

/** A composer draft as the window keeps it, one per project; `branch` as edited, null while it follows the prompt. */
export const zKeptDraft = z.object({
  prompt: z.string().max(L.composerDraftMaxBytes),
  isolation: zIsolation,
  base: zBaseChoice,
  branch: z.string().max(L.settingsBranchPrefixMaxChars + L.slugMaxChars * 4).nullable(),
  agent: z.string(),
  config: zLaunchOptions,
})

/**
 * What a window hands the one made in its place (on Wayland a minimized window is rebuilt): its composer drafts by
 * project, the latest `L.windowHandoffDraftsMax`. Main checks it on the way through.
 */
export const zWindowHandoff = z.object({ drafts: z.array(z.tuple([zProjectId, zKeptDraft])).max(L.windowHandoffDraftsMax) })
export type WindowHandoff = z.infer<typeof zWindowHandoff>

/**
 * Why `sessions.archive` asks first. `shellBusy`: a shell has a program in its foreground (`detail`: its name).
 * `shellUnknown`: it could not be learned whether one has (core's foreground check answered `known: false`);
 * the sheet says so.
 */
export const zArchiveReason = z.object({ kind: z.enum(['midTurn', 'server', 'shellBusy', 'shellUnknown']), detail: z.string() })

/** What a delete will lose and keep: the confirmation's numbers. */
export const zDeletePreview = z.object({
  isolation: zIsolation,
  branch: z.string().nullable(),
  /** `git status --porcelain` entries (tracked changes and untracked files that are not ignored). */
  uncommittedFiles: z.number().int().min(0),
  /**
   * Commits only the session's branch holds, the work lost if the branch goes: reachable from it and from no other
   * local branch or remote-tracking ref (`git rev-list refs/heads/<branch> --not --exclude=<branch> --branches --remotes`).
   */
  ownCommits: z.number().int().min(0),
  /** Commits on the branch that its base does not have (deleting the branch then needs `-D`). */
  uniqueCommits: z.number().int().min(0),
  /** Merged into its base (or no unique commits; a squash merge counts too). */
  merged: z.boolean(),
  /** "Delete branch too" starts ticked only for a merged branch or one with no commits of its own. */
  deleteBranchDefault: z.boolean(),
  /** Untracked files over L.snapshotUntrackedMaxBytes: left out of the snapshot, so not recoverable. */
  oversize: z.array(z.object({ path: z.string(), bytes: z.number().int() })),
  /** Untracked folders that are git repositories of their own (an agent's clone): not in the snapshot, not recoverable. */
  nestedRepos: z.array(z.string()),
  /** A teardown command will run. */
  teardown: z.boolean(),
  retentionDays: z.number().int(),
  worktreeMissing: z.boolean(),
})
export type DeletePreview = z.infer<typeof zDeletePreview>

/** A session deleted within the retention, as "Restore Deleted Session…" lists it. */
export const zDeletedSession = z.object({
  id: zSessionId,
  title: z.string(),
  branch: z.string().nullable(),
  isolation: zIsolation,
  deletedAt: z.number().int(),
  /** What the snapshot holds: files changed relative to the branch tip (0: the branch tip alone). */
  snapshotFiles: z.number().int().min(0),
})

/** The codes of the RpcErrors the session calls fail with (besides `not_found` and `invalid_args`). */
export const SESSION_ERRORS = [
  'not_found',
  /** The call does not apply in the session's lifecycle (e.g. delete while `creating`). */
  'wrong_state',
  /** A creation was refused by validation: the message names the problem. */
  'invalid_session',
  /** Git or the worktree failed; the message carries git's error. */
  'git_failed',
] as const

const zOk = z.object({ ok: z.boolean() })
const zSessionArg = z.object({ id: zSessionId })

/**
 * The main pane's cell grid: a PTY is spawned at the real viewport size, so calls that start one carry it;
 * core remembers the last one for background starts.
 */
export const zGrid = z.object({ cols: z.number().int().min(L.ptyMinCols), rows: z.number().int().min(L.ptyMinRows) })
export type Grid = z.infer<typeof zGrid>
const zSpawnArg = z.object({ id: zSessionId, grid: zGrid.optional() })

/** Methods core serves to the renderer for sessions. Every change also reaches the `sessions` store. */
export const sessionsApi = defineApi({
  /**
   * Create a session. Resolves as soon as its `creating` row is in the store, within one frame; the creation
   * pipeline continues in core and reports into the row. Saves `lastLaunch`.
   */
  'sessions.create': {
    args: z.object({
      projectId: zProjectId,
      prompt: z.string().max(L.composerDraftMaxBytes),
      agent: z.string().min(1),
      config: zLaunchOptions,
      isolation: zIsolation,
      base: zBaseChoice,
      /** The branch name as edited; default `<prefix><slug>`. Ignored in place. */
      branch: zBranchName.optional(),
      /** Composer › Advanced: extra environment variables for the agent. */
      env: z.record(zRecordKey, z.string()).optional(),
      /** The main pane's grid; `⌥⌘↵` background starts send the current one too. */
      grid: zGrid.optional(),
    }),
    result: z.object({ sessionId: zSessionId, slug: z.string(), branch: z.string().nullable() }),
  },
  /** What Start would do and the problems it would hit (inline, non-blocking until start). */
  'sessions.validate': {
    args: z.object({ projectId: zProjectId, prompt: z.string().max(L.composerDraftMaxBytes), isolation: zIsolation, base: zBaseChoice, branch: zBranchName.optional(), agent: z.string().optional() }),
    result: z.object({ slug: z.string(), branch: z.string().nullable(), problems: z.array(zValidationProblem) }),
  },
  /** The composer's Base list: the default branch, the main checkout's branch, and at most L.baseRefsMax refs. */
  'sessions.bases': {
    args: z.object({ projectId: zProjectId }),
    result: z.object({ defaultBranch: z.string().nullable(), head: z.string().nullable(), bare: z.boolean(), refs: z.array(zBaseRef), truncated: z.boolean() }),
  },
  /** Retry: run a failed creation again from its first unfinished step. */
  'sessions.retry': { args: zSpawnArg, result: zOk },
  /** Discard: teardown first if setup had started, then undo what the creation made; the row goes. */
  'sessions.discard': { args: zSessionArg, result: zOk },
  /**
   * End the agent: SIGTERM to its process group, then SIGKILL after L.stopGraceMs (the `shell` pseudo-agent is hung up
   * instead); `detached` with `end_reason = stopped`.
   */
  'sessions.stop': { args: zSessionArg, result: zOk },
  /** Resume: the agent again in the same directory, with its adapter's resume command. */
  'sessions.resume': { args: zSpawnArg, result: zOk },
  /** Restart: a fresh conversation in the same worktree. */
  'sessions.restart': { args: zSpawnArg, result: zOk },
  /**
   * A shell tab of a `live` or `detached` session (`⌘T`): `$SHELL -l` in the session's directory with the session
   * environment. It is listed in the `terminals` store under the session.
   */
  'sessions.openShell': { args: zSpawnArg, result: z.object({ ptyId: zPtyId }) },
  /**
   * Archive. Without `confirmed`, a session mid-turn, with a dev server running or a busy shell is not archived
   * and the reasons come back. Teardown never blocks it.
   */
  'sessions.archive': {
    args: z.object({ id: zSessionId, confirmed: z.boolean().optional() }),
    result: z.object({ archived: z.boolean(), reasons: z.array(zArchiveReason), teardownFailed: z.boolean() }),
  },
  /**
   * Unarchive: back as `detached`, with a port block. Setup runs again when the project has a teardown command,
   * the worktree had to be added back, or the build folders were removed while it was archived.
   */
  'sessions.unarchive': { args: zSessionArg, result: zOk },
  /** The delete confirmation's numbers. */
  'sessions.deletePreview': { args: zSessionArg, result: zDeletePreview },
  /**
   * Delete. `deleteBranch` uses `git branch -d`; `forceBranch` (after the "n unmerged commits" confirmation) `-D`.
   * Teardown never blocks it (`teardownFailed`). When it failed, `log` is the session's log as the delete left it, the
   * teardown's output included, for the toast's View log: the log goes with the session's state directory, so it cannot
   * be read afterwards. Null otherwise.
   */
  'sessions.delete': {
    args: z.object({ id: zSessionId, deleteBranch: z.boolean(), forceBranch: z.boolean().optional() }),
    result: z.object({ deleted: z.boolean(), branchDeleted: z.boolean(), teardownFailed: z.boolean(), log: z.object({ text: z.string(), truncated: z.boolean() }).nullable() }),
  },
  /** A project's sessions deleted within the retention, newest first. */
  'sessions.listDeleted': { args: z.object({ projectId: zProjectId }), result: z.object({ sessions: z.array(zDeletedSession) }) },
  /**
   * Restore a deleted session: a worktree is added again from its delete snapshot (`refs/kea/deleted/<id>`), and the
   * session comes back `detached`.
   */
  'sessions.restore': { args: zSessionArg, result: z.object({ ok: z.boolean(), branch: z.string().nullable() }) },
  /** Rename the session: a user rename wins forever. */
  'sessions.rename': { args: z.object({ id: zSessionId, title: z.string().min(1).max(L.titleMaxChars) }), result: zOk },
  /** Drag to `index` (0 = first) of the project's current order; persists. */
  'sessions.move': { args: z.object({ id: zSessionId, index: z.number().int().min(0) }), result: zOk },
  /** Duplicate: the composer's draft, base = this session's branch. */
  'sessions.duplicate': { args: zSessionArg, result: z.object({ draft: zComposerDraft }) },
  /** Recreate from branch: a missing worktree is added again on its branch. */
  'sessions.recreateWorktree': { args: zSessionArg, result: zOk },
  /** Retry teardown: run the session's teardown again. */
  'sessions.retryTeardown': { args: zSessionArg, result: z.object({ ok: z.boolean(), teardownFailed: z.boolean() }) },
  /** The setup tab's controls: Skip (start the agent now; setup keeps running), Retry, Start agent anyway. */
  'sessions.setup': { args: z.object({ id: zSessionId, action: z.enum(['skip', 'retry', 'startAnyway']), grid: zGrid.optional() }), result: zOk },
  /** "Re-sync copied files": copies them again from the main checkout; returns their names only. */
  'sessions.resyncFiles': { args: zSessionArg, result: z.object({ copied: z.array(z.string()) }) },
  /** The creation log (`<KEA_HOME>/sessions/<id>/creation.log`): steps, git output, setup and teardown output; the newest L.creationLogMaxBytes. */
  'sessions.creationLog': { args: zSessionArg, result: z.object({ text: z.string(), truncated: z.boolean() }) },
  /** The session's saved panel state (`session_ui.state`). */
  'sessions.getUi': { args: zSessionArg, result: z.object({ state: z.record(zRecordKey, z.unknown()) }) },
  /**
   * Save it, key by key: each key given replaces that key (null removes it), the others stay; at most
   * L.sessionUiMaxBytes as JSON afterwards. The `files` key is the file panel's (`files.saveUi`) and is left out here.
   */
  'sessions.setUi': { args: z.object({ id: zSessionId, state: z.record(zRecordKey, z.unknown()) }), result: zOk },
})
