// Sessions, core side: the `sessions` store the renderer subscribes to, the `sessionsApi` and `worktreesApi` calls,
// and everything a session's lifecycle does to git, the disk and its PTYs.
//
//   create                the `creating` row is in the store before the call returns; the pipeline runs after it, each
//                         step journaled in `creation_step` (`create:<step>`) and logged to
//                         `<KEA_HOME>/sessions/<id>/creation.log`: git → base → add (+ record) → copy → submodules →
//                         setup → launch. A failure leaves `create_failed` with Retry (from the journaled step) and
//                         Discard (teardown if setup had started, then the rollback of what the creation made). Kea
//                         killed meanwhile: the next launch offers the same.
//   stop, resume          the agent's command from its adapter (`agentCommand`), or for the `shell` pseudo-agent a
//                         login shell in the session's cwd
//   archive               asks first when mid-turn / a server runs / a shell is busy; stops every PTY, teardown
//                         (`archive`; a failed teardown never blocks it), the backup exclusion, releases the ports
//   delete                journaled `delete:<branch mode>`: stop every PTY → snapshot ref, always afresh (from here on
//                         a killed delete completes while the worktree is as snapshotted) → teardown (`delete`) →
//                         fsmonitor stop → move to the root's `.kea-trash`, prune, empty it in the background → branch
//                         per choice → ports → the session's state directory → `deleted`; a delete that fails in
//                         process before the move is undone before its error returns
//   restore               journaled `restore`: the worktree re-added from its delete snapshot
//                         (`refs/kea/deleted/<id>`), files copied, a port block, setup (`restore`) → `detached`
//   launch                interrupted creations become `create_failed`, interrupted deletes complete or are undone,
//                         interrupted restores are rolled back; per project: orphaned worktrees, initializing locks,
//                         missing worktrees, stale `.kea-trash` entries; then the purge after the retention and
//                         auto-clean, again every L.autoCleanIntervalMs. Unsafe worktree roots (the home folder, a
//                         folder in or holding a project) are never searched
//   project removal       refused while a session has a worktree on disk or a creation runs or failed
//
// Calls on one session run one at a time (its queue); worktree mutations of one repository go through the shared
// RepoMutex.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyTrash, emptyTrashEntry, git, moveToTrash, ptyId as newPtyId, ulid, type Logger } from '@kea/kit'
import {
  baseKey,
  nextLastLaunch,
  CREATION_STEPS,
  parseBaseKey,
  KeyedStore,
  L,
  RpcError,
  SESSIONS_STORE,
  sessionGlyph,
  sessionsApi,
  worktreesApi,
  zAttentionItem,
  zLaunchConfig,
  type AttentionItem,
  type BaseChoice,
  type ComposerDraft,
  type CreationState,
  type CreationStep,
  type DeletePreview,
  type EndReason,
  type FailureKind,
  type Grid,
  type Handlers,
  type Isolation,
  type LaunchConfig,
  type Lifecycle,
  type OrphanWorktree,
  type Phase,
  type Project,
  type ProjectRemoval,
  type RemoveBlocker,
  type SessionView,
  type SetupState,
  type TitleSource,
  type ValidationProblem,
} from '@kea/protocol'
import { kvDelete, kvGet, kvSet, type KeaDb } from '../platform/db/db.ts'
import type { PortBlocks } from '../server/ports.ts'
import type { SettingsFile } from '../settings/settings.ts'
import type { ReconcilePlan } from '../terminal/reconcile.ts'
import type { Env } from '../terminal/shellEnv.ts'
import { shellTabArgv, userShell } from '../terminal/spawn.ts'
import type { TerminalExit, Terminals } from '../terminal/terminals.ts'
import { backupsExcludable, backupTargets, excludeFromBackup } from '../worktrees/backup.ts'
import { copyEntries, planCopies, WORKTREE_INCLUDE } from '../worktrees/copy.ts'
import { canonical, canonicalPath, isBelow } from '../worktrees/git.ts'
import { appendLog, logBytes, readLog } from '../worktrees/log.ts'
import type { RepoMutex } from '../worktrees/mutex.ts'
import {
  addWorktree,
  BaseError,
  branchExists,
  branchFacts,
  checkedOutBranches,
  countUncommitted,
  deleteBranch,
  deletedRefs,
  deleteRef,
  detectDefaultBranch,
  hasRemote,
  listWorktrees,
  matchesSnapshot,
  pruneWorktrees,
  resolveBase,
  resolveCommit,
  restoreWorktree,
  rollbackAdd,
  snapshotBase,
  snapshotFiles,
  snapshotRef,
  snapshotTmpDir,
  stopFsmonitor,
  unsnapshottable,
  unlockInitializing,
  validBranchName,
  WORKTREE_TRASH,
  writeSnapshot,
  type Repo,
} from '../worktrees/ops.ts'
import { branchFor, projectSlug, randomSlug, SLUG_RE, slugFromPrompt, uniqueSlug } from '../worktrees/slug.ts'
import { sessionEnv, type EnvPurpose } from './env.ts'
import { nextLifecycle, type LifecycleEvent } from './lifecycle.ts'
import type { Projects } from './projects.ts'
import { SHELL_AGENT } from './rebuild.ts'
import { insertSession, titleFromSlug } from './rows.ts'
import { backfillColors, COLOR_UI_KEY, keepOrRepick } from './colors.ts'
import { hasScript, scriptCommand, type ScriptKind } from './scripts.ts'

/** The composer's choices a creation is planned from (sessions.validate, sessions.create). */
type PlanArgs = { prompt: string; isolation: Isolation; base: BaseChoice; branch?: string | undefined }

/** A `sessions` row joined with its `session_runtime` row. */
type Row = {
  id: string
  project_id: string
  slug: string
  title: string
  title_source: TitleSource
  isolation: Isolation
  cwd: string
  worktree_root: string | null
  branch: string | null
  base_branch: string | null
  base_commit: string | null
  port_base: number | null
  agent: string
  agent_session_id: string | null
  launch_config: string
  lifecycle: Lifecycle
  end_reason: EndReason | null
  deleted_at: number | null
  snapshot_ref: string | null
  creation_step: string | null
  disk_bytes: number | null
  disk_at: number | null
  sort_order: number
  pinned_order: number
  created_at: number
  archived_at: number | null
  phase: Phase
  attention: string
  background: number
  failure_kind: FailureKind | null
  unread: number
  last_activity_at: number
  model: string | null
  effort: string | null
  permissionMode: string | null
  cost_usd: number | null
  context_pct: number | null
  /** `session_ui.state`'s `color` as stored (colors.ts `COLOR_SQL`); anything but a whole number ≥ 0 reads as 0. */
  color: unknown
}

const SELECT = `SELECT s.id, s.project_id, s.slug, s.title, s.title_source, s.isolation, s.cwd, s.worktree_root, s.branch, s.base_branch, s.base_commit,
  s.port_base, s.agent, s.agent_session_id, s.launch_config, s.lifecycle, s.end_reason, s.deleted_at, s.snapshot_ref, s.creation_step, s.disk_bytes,
  s.disk_at, s.sort_order, s.pinned_order, s.created_at, s.archived_at, r.phase, r.attention, r.background, r.failure_kind, r.unread,
  r.last_activity_at, r.model, r.effort, r.permission_mode AS permissionMode, r.cost_usd, r.context_pct,
  CASE WHEN json_valid(u.state) THEN json_extract(u.state, '$.color') END AS color
  FROM sessions s JOIN session_runtime r ON r.session_id = s.id LEFT JOIN session_ui u ON u.session_id = s.id`
const GET = `${SELECT} WHERE s.id = ?`
const LIST = `${SELECT} ORDER BY s.project_id, s.sort_order, s.created_at`
/**
 * A project's sessions in their stable order, as the sidebar shows it (the index `sessions.move` takes): newest first
 * among equal sort orders.
 */
const BY_PROJECT = `${SELECT} WHERE s.project_id = ? ORDER BY s.sort_order, s.created_at DESC, s.id`

/** Journal values of `sessions.creation_step` beyond `create:<step>`. */
const J = {
  create: (step: CreationStep) => `create:${step}`,
  delete: (mode: 'keep' | 'branch' | 'force') => `delete:${mode}`,
  restore: 'restore',
  /** A restore whose session branch did not exist when it began: a rollback deletes the one it made. */
  restoreNew: 'restore:new',
  /** Auto-clean moving the worktree away. */
  clean: 'clean',
  /** The worktree was removed by auto-clean; the record and branch remain. */
  cleaned: 'cleaned',
} as const

export interface SessionsOptions {
  db: KeaDb
  log: Logger
  home: string
  projects: Projects
  terminals: Terminals
  settings: Pick<SettingsFile, 'values'>
  mutex: RepoMutex
  ports: PortBlocks
  /** Whether git can be run; with the reason when not. */
  git: Promise<{ usable: boolean; missing: string | null }>
  /** The login-shell environment: git runs with it (the user's hooks find their tools), PTYs start from it. */
  env(): Promise<Env>
  now?: () => number
  rng?: () => number
  /** Fault injection (I-WT-3, C-KILL-9): called before each pipeline step and delete stage; a throw fails it there. */
  faults?: (point: string, sessionId: string) => void | Promise<void>
  /** How long the teardown script may run (default L.teardownTimeoutMs; a test shortens it, I-WT-15). */
  teardownTimeoutMs?: number
  /** The agent's command for a start, Resume or Restart; default the `shell` pseudo-agent (`AgentCommand`). */
  agentCommand?: AgentCommand
  /** Whether a session's build folders were removed while it was archived (worktrees/disk.ts); told when setup runs again for it. */
  buildFolders?: { pruned(id: string): boolean; restored(id: string): void }
  /** Told when a move into a worktree root's trash made that `.kea-trash` folder: core marks it for Time Machine. */
  folderMade?: (dir: string) => void
}

/** How an agent PTY starts: a creation's launch, Resume (same conversation) or Restart (a fresh one). */
export type AgentLaunchHow = 'start' | 'resume' | 'restart'

/** What the adapter-neutral agent launch knows about the session it starts an agent for. */
export interface AgentLaunchSession {
  id: string
  agent: string
  cwd: string
  /** `worktree`: `cwd` is a worktree Kea made for the session; `inplace`: the project's own folder. */
  isolation: Isolation
  /** The CLI's own conversation id (Resume continues it); null on a Restart, which starts a fresh conversation. */
  agentSessionId: string | null
  launch: LaunchConfig
  /** The composer's agent (`launch_config.requestedAgent`), while the row still names the shell pseudo-agent. */
  requestedAgent?: string | null
}

/** What an adapter's command gives beyond argv: environment edits and what the row records. */
export interface AgentLaunchCommand {
  argv: string[]
  /** Laid over the PTY environment (the adapter's variables). */
  env?: Record<string, string>
  /** Removed from the PTY environment. */
  unsetEnv?: string[]
  /** Through the user's login shell (`agents.<id>.throughLoginShell`). */
  throughLoginShell?: boolean
  /** The agent the row records (`sessions.agent`); unchanged when absent. */
  agent?: string
  /** The CLI conversation id this launch uses (`sessions.agent_session_id`: pre-assigned, or the resumed one). */
  agentSessionId?: string | null
}

/**
 * The seam where an adapter's commands plug in: the command that starts `s`'s agent `how` — the adapter's resume
 * command for Resume, a fresh conversation for Restart. Null: the `shell` pseudo-agent (`$SHELL -l` in the session's
 * directory). A throw fails the launch with its message (a CLI that is not installed).
 */
export type AgentCommand = (s: AgentLaunchSession, how: AgentLaunchHow) => AgentLaunchCommand | null | Promise<AgentLaunchCommand | null>

class Deferred {
  promise: Promise<void>
  resolve!: () => void
  constructor() {
    this.promise = new Promise((r) => (this.resolve = r))
  }
}

/** The file panel's key in `session_ui.state`: written by `files.saveUi` only (files/service.ts, `$.files`). */
const FILES_UI_KEY = 'files'

/** The title of a teardown's PTY record (a label only: what marks a teardown's terminal is `TEARDOWN_KV`). */
const TEARDOWN_TITLE = 'Teardown'
/**
 * `kv` rows `teardown:<ptyId>` → the session's id: the PTYs `runTeardown` launched whose record may still exist.
 * Written before the PTY's record, deleted once that record has gone. It is what tells a teardown's terminal that
 * outlived its run, or the core that started it, from every other `script` PTY (a setup's, or one that only carries the
 * same title): only a marked one is ever ended and forgotten as a teardown (`endTeardownTerminal`).
 */
export const TEARDOWN_KV = 'teardown:'

const noRuntime = `UPDATE session_runtime SET attention = '[]', background = 0, failure_kind = NULL, phase = 'idle' WHERE session_id = ?`

export class Sessions {
  /** `sessions`: SessionView by id, every session that is not deleted. */
  readonly store = new KeyedStore<SessionView>(SESSIONS_STORE)
  private readonly o: SessionsOptions
  private readonly db: KeaDb
  private readonly log: Logger
  private readonly now: () => number
  // bounded: one entry per session with a creation in progress or failed (≤ sessions; resource row `core.sessions`)
  private readonly creation = new Map<string, CreationState>()
  // bounded: one per session whose setup ran since launch (≤ sessions)
  private readonly setup = new Map<string, SetupState>()
  // bounded: ≤ sessions; a creation waiting for its setup
  private readonly setupGate = new Map<string, Deferred>()
  // bounded: ≤ sessions; setup PTYs that exited, their output on its way to the log
  private readonly setupEnding = new Set<string>()
  // bounded: ≤ sessions; skipped setups still running, captured and released when they end
  private readonly skippedSetups = new Set<string>()
  // bounded: ≤ sessions
  private readonly teardownFailed = new Set<string>()
  // bounded: ≤ sessions; the sessions whose teardown `runTeardown` is waiting on now (it ends that terminal itself)
  private readonly tearingDown = new Set<string>()
  // bounded: ≤ sessions
  private readonly missing = new Set<string>()
  // bounded: ≤ sessions; agents being stopped by the user (their exit is `stopped`)
  private readonly stopping = new Set<string>()
  // bounded: ≤ sessions; each session's call queue (the entry goes when it drains)
  private readonly queues = new Map<string, Promise<unknown>>()
  // bounded: ≤ sessions; the composer's extra variables for a creation in progress
  private readonly extraEnv = new Map<string, Env>()
  // bounded: one list per git project, replaced at each reconciliation
  private readonly orphans = new Map<string, OrphanWorktree[]>()
  /** The git lookup's answer once it has come (plan without git reads it). */
  private gitKnown: { usable: boolean; missing: string | null } | null = null
  /** The login shell's HOME, once its environment has answered (rootProblem). */
  private shellHome: string | null | undefined
  // bounded: ≤ sessions; the rows a previous run left mid-step, read at construction and emptied by start()
  private readonly interrupted: Set<string>
  private createQueue: Promise<unknown> = Promise.resolve()
  private grid: Grid = { cols: L.ptyDefaultCols, rows: L.ptyDefaultRows }
  private readonly offExit: { dispose(): void }
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** Background work (pipelines, trash emptying) still running: awaited by tests and by dispose. */
  // bounded: one per pipeline or trash removal in flight
  private readonly pending = new Set<Promise<unknown>>()

  constructor(o: SessionsOptions) {
    this.o = o
    this.db = o.db
    this.log = o.log
    this.now = o.now ?? Date.now
    this.offExit = o.terminals.exits.event((e) => this.onExit(e))
    void o.git.then((g) => (this.gitKnown = g))
    // core says ready before start() runs: a creation or delete asked in between is in flight, not left behind
    this.interrupted = new Set(this.db.all<{ id: string }>(`SELECT id FROM sessions WHERE lifecycle = 'creating' OR creation_step IS NOT NULL`).map((r) => r.id))
    // sessions made before colours existed get theirs before the store is first read, so none is sent without one
    backfillColors(this.db)
    this.reload()
  }

  // ── the store ─────────────────────────────────────────────────────────────────────────────────

  /** Read every session again (startup, after a reconciliation or a rebuild). */
  reload(): void {
    const next: Record<string, SessionView> = {}
    for (const r of this.db.all<Row>(LIST)) if (r.lifecycle !== 'deleted') next[r.id] = this.view(r)
    this.store.replace(next, (a, b) => JSON.stringify(a) === JSON.stringify(b))
  }

  /** Re-read one session into the store (also after the status batch commits its runtime row). */
  refresh(id: string): Row | undefined {
    const r = this.db.get<Row>(GET, id)
    if (!r || r.lifecycle === 'deleted') {
      this.store.delete(id)
      return r
    }
    const v = this.view(r)
    const cur = this.store.get(id)
    if (!cur || JSON.stringify(cur) !== JSON.stringify(v)) this.store.set(id, v)
    return r
  }

  private view(r: Row): SessionView {
    let attention: AttentionItem[] = []
    try {
      const a = JSON.parse(r.attention) as unknown
      if (Array.isArray(a)) attention = a.filter((x) => zAttentionItem.safeParse(x).success) as AttentionItem[]
    } catch {
      attention = []
    }
    const cfg = this.launchConfig(r)
    const { prompt: _prompt, ...launch } = cfg
    const v: Omit<SessionView, 'glyph' | 'label'> = {
      id: r.id,
      projectId: r.project_id,
      slug: r.slug,
      title: r.title,
      titleSource: r.title_source,
      isolation: r.isolation,
      cwd: r.cwd,
      branch: r.branch,
      baseBranch: r.base_branch,
      baseCommit: r.base_commit,
      portBase: r.port_base,
      agent: r.agent,
      agentSessionId: r.agent_session_id,
      launch,
      lifecycle: r.lifecycle,
      endReason: r.end_reason,
      sortOrder: r.sort_order,
      pinnedOrder: r.pinned_order,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
      diskBytes: r.disk_bytes,
      diskAt: r.disk_at,
      phase: r.phase,
      attention,
      background: r.background !== 0,
      failureKind: r.failure_kind,
      unread: r.unread !== 0,
      lastActivityAt: r.last_activity_at,
      model: r.model,
      effort: r.effort,
      permissionMode: r.permissionMode,
      costUsd: r.cost_usd,
      contextPct: r.context_pct,
      color: typeof r.color === 'number' && Number.isInteger(r.color) && r.color >= 0 ? r.color % L.sessionColors : 0,
      creation: r.lifecycle === 'creating' || r.lifecycle === 'create_failed' ? (this.creation.get(r.id) ?? this.creationFromJournal(r)) : null,
      setup: this.setup.get(r.id) ?? null,
      teardownFailed: this.teardownFailed.has(r.id),
      worktreeMissing: this.missing.has(r.id),
      // its dev server's PTY has not ended (the server service refreshes the row when it starts and ends)
      serverRunning: this.o.terminals.sessionRecords(r.id).some((x) => x.kind === 'server' && x.state === 'running'),
    }
    return { ...v, glyph: sessionGlyph(v), label: attention[0]?.kind ?? null }
  }

  private creationFromJournal(r: Row): CreationState {
    const step = (r.creation_step?.startsWith('create:') ? r.creation_step.slice('create:'.length) : 'git') as CreationStep
    const s: CreationState = {
      step: (CREATION_STEPS as readonly string[]).includes(step) ? step : 'git',
      error: r.lifecycle === 'create_failed' ? 'the creation was interrupted' : null,
      notices: [],
      logBytes: logBytes(this.o.home, r.id),
    }
    this.creation.set(r.id, s)
    return s
  }

  /**
   * What `create` stored beside the LaunchConfig in `launch_config`: the base choice, the branch name asked for (null:
   * an automatic one), the agent asked for, and the add step's journal of whether this creation made its branch (only
   * such a branch is ever deleted by a rollback; null: not known, so never).
   */
  private launchExtras(r: Pick<Row, 'launch_config'>): { base: BaseChoice; branch: string | null; requestedAgent: string | null; madeBranch: boolean | null } {
    try {
      const v = JSON.parse(r.launch_config) as { base?: unknown; branch?: unknown; requestedAgent?: unknown; madeBranch?: unknown }
      return {
        base: parseBaseKey(typeof v.base === 'string' ? v.base : undefined),
        branch: typeof v.branch === 'string' ? v.branch : null,
        requestedAgent: typeof v.requestedAgent === 'string' ? v.requestedAgent : null,
        madeBranch: typeof v.madeBranch === 'boolean' ? v.madeBranch : null,
      }
    } catch {
      return { base: { kind: 'default' }, branch: null, requestedAgent: null, madeBranch: null }
    }
  }

  /** Journal, with the add step, whether this creation makes (made) its branch. */
  private setMadeBranch(id: string, made: boolean): void {
    this.db.tx(() => {
      const r = this.db.get<{ launch_config: string }>('SELECT launch_config FROM sessions WHERE id = ?', id)
      if (!r) return
      let v: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(r.launch_config) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed as Record<string, unknown>
      } catch {
        // rewritten below
      }
      this.db.run('UPDATE sessions SET launch_config = ? WHERE id = ?', JSON.stringify({ ...v, madeBranch: made }), id)
    })
  }

  /** The creation's plan makes a new branch (any base but an existing branch). */
  private plansNewBranch(r: Pick<Row, 'launch_config' | 'branch'>): boolean {
    return r.branch !== null && this.launchExtras(r).base.kind !== 'existing'
  }

  /** The composer's choices a creation was started with, from its row (Retry re-checks them). */
  private planArgs(r: Row): PlanArgs {
    const x = this.launchExtras(r)
    return { prompt: this.launchConfig(r).prompt, isolation: r.isolation, base: x.base, branch: x.branch ?? undefined }
  }

  private launchConfig(r: Pick<Row, 'launch_config'>): LaunchConfig {
    try {
      const p = zLaunchConfig.safeParse(JSON.parse(r.launch_config))
      if (p.success) return p.data
    } catch {
      // falls through
    }
    return { prompt: '' }
  }

  // ── the API ───────────────────────────────────────────────────────────────────────────────────

  handlers(): Handlers<typeof sessionsApi> & Handlers<typeof worktreesApi> {
    return {
      'sessions.create': (a) => this.create(a),
      'sessions.validate': (a) => this.validate(a),
      'sessions.bases': ({ projectId }) => this.bases(projectId),
      'sessions.retry': ({ id, grid }) => this.retry(id, grid),
      'sessions.discard': ({ id }) => this.discard(id),
      'sessions.stop': ({ id }) => this.stop(id),
      'sessions.resume': ({ id, grid }) => this.resume(id, grid),
      'sessions.restart': ({ id, grid }) => this.resume(id, grid, 'restart'),
      'sessions.openShell': ({ id, grid }) => this.openShell(id, grid),
      'sessions.archive': ({ id, confirmed }) => this.archive(id, confirmed === true),
      'sessions.unarchive': ({ id }) => this.unarchive(id),
      'sessions.deletePreview': ({ id }) => this.deletePreview(id),
      'sessions.delete': ({ id, deleteBranch, forceBranch }) => this.delete(id, deleteBranch, forceBranch === true),
      'sessions.listDeleted': ({ projectId }) => this.listDeleted(projectId),
      'sessions.restore': ({ id }) => this.restore(id),
      'sessions.rename': ({ id, title }) => this.rename(id, title),
      'sessions.move': ({ id, index }) => this.move(id, index),
      'sessions.duplicate': ({ id }) => this.duplicate(id),
      'sessions.recreateWorktree': ({ id }) => this.recreateWorktree(id),
      'sessions.retryTeardown': ({ id }) => this.retryTeardown(id),
      'sessions.setup': ({ id, action, grid }) => this.setupAction(id, action, grid),
      'sessions.resyncFiles': ({ id }) => this.resyncFiles(id),
      'sessions.creationLog': ({ id }) => {
        this.require(id, true)
        const { text, truncated } = readLog(this.o.home, id)
        return { text, truncated }
      },
      'sessions.getUi': ({ id }) => this.getUi(id),
      'sessions.setUi': ({ id, state }) => this.setUi(id, state),
      'worktrees.orphans': async ({ projectId, refresh }) => {
        const p = this.project(projectId)
        if (refresh) await this.reconcileProject(p)
        return { orphans: this.orphans.get(projectId) ?? [] }
      },
      // Settings › Projects says when the project's `.worktreeinclude` replaces "Files to copy"
      'worktrees.includeFile': async ({ projectId }) => ({
        exists: await fs.promises.stat(path.join(this.project(projectId).rootPath, WORKTREE_INCLUDE)).then(
          (st) => st.isFile(),
          () => false,
        ),
      }),
      'worktrees.adopt': ({ projectId, path: p }) => this.adoptOrphan(projectId, p),
      'worktrees.remove': ({ projectId, path: p, force }) => this.removeOrphan(projectId, p, force === true),
    }
  }

  // ── create ─────────────────────────────────────────────────────────────────────────────────────

  /** What a creation would make, and the problems Start would hit. */
  async validate(a: { projectId: string; prompt: string; isolation: Isolation; base: BaseChoice; branch?: string | undefined }): Promise<{ slug: string; branch: string | null; problems: ValidationProblem[] }> {
    const p = this.project(a.projectId)
    const plan = await this.plan(p, a)
    return { slug: plan.slug, branch: plan.branch, problems: plan.problems }
  }

  private problem(code: ValidationProblem['code'], message: string, more: Partial<ValidationProblem> = {}): ValidationProblem {
    return { code, hard: true, message, suggestion: null, path: null, sessionId: null, ...more }
  }

  private worktreeRoot(): string {
    const r = this.o.settings.values.get<string | null>('general.worktreeRoot')
    return r ?? path.join(this.o.home, 'worktrees')
  }

  /**
   * Why `root` cannot be a worktree root, which must lie outside every repository, or null: it is the home folder or
   * holds it (its trash, everything), lies inside a registered project, or holds one (the main checkout would sit among
   * Kea's worktrees). Such a root takes no new session and is never searched for orphans or trash.
   */
  private async rootProblem(root: string, wait = true): Promise<string | null> {
    const c = canonicalPath(root)
    // without `wait` (a row before git), the login shell's HOME only if it has answered; confirmPlan checks again
    const homes = new Set([os.homedir(), wait ? (await this.gitEnv()).HOME : this.shellHome].filter((h): h is string => !!h && path.isAbsolute(h)).map((h) => canonicalPath(h)))
    for (const h of homes) if (c === h || isBelow(c, h)) return `The worktree location ${root} is your home folder${c === h ? '' : ' or holds it'}`
    for (const p of this.o.projects.list()) {
      const pr = canonicalPath(p.rootPath)
      if (c === pr || isBelow(pr, c)) return `The worktree location ${root} is inside the project ${p.name}`
      if (isBelow(c, pr)) return `The worktree location ${root} holds the project ${p.name}`
    }
    return null
  }

  /** A path that is a registered project's root or holds one: never an orphan, never removed or adopted. */
  private holdsProject(p: string): boolean {
    const c = canonicalPath(p)
    return this.o.projects.list().some((x) => {
      const pr = canonicalPath(x.rootPath)
      return pr === c || isBelow(c, pr)
    })
  }

  /** The project's directory under a worktree root: its folder's slug, suffixed when an older project has it. */
  private projectDir(p: Project): string {
    const s = projectSlug(p.rootPath)
    const clash = this.o.projects.list().some((q) => q.id !== p.id && projectSlug(q.rootPath) === s && (q.createdAt < p.createdAt || (q.createdAt === p.createdAt && q.id < p.id)))
    return clash ? `${s}-${p.id.slice(-4).toLowerCase()}` : s
  }

  /**
   * What a creation would make and what is wrong with it. `git: false` (create): only what core knows without running
   * git — the database, the disk, the composer's choices — so the row is listed at once; the checks that need git run
   * as the creation's first step (`confirmPlan`). `self`: the session being confirmed, whose own row does not take its
   * name; `slugBase`: the name to start from instead of the prompt's.
   */
  private async plan(
    p: Project,
    a: PlanArgs,
    o: { git?: boolean; self?: string; slugBase?: string } = {},
  ): Promise<{ slug: string; branch: string | null; isolation: Isolation; path: string; root: string | null; problems: ValidationProblem[]; createBranch: boolean }> {
    const withGit = o.git !== false
    const problems: ValidationProblem[] = []
    if (p.missing) problems.push(this.problem('projectMissing', `The project folder ${p.rootPath} is missing`, { path: p.rootPath }))
    // without git nothing waits for the git lookup or the login shell: git not known yet is confirmPlan's to judge
    const gitState = withGit ? await this.o.git : this.gitKnown
    let isolation: Isolation = a.isolation
    if (isolation === 'worktree' && (!p.isGit || (gitState && !gitState.usable))) {
      problems.push(this.problem('notGit', p.isGit ? (gitState?.missing ?? 'git is not available') : 'This project is not a git repository: sessions run in place', { hard: p.isGit }))
      isolation = 'inplace'
    }
    // a bare repository has no working tree to run in; its sessions are worktrees
    if (p.bare && a.isolation === 'inplace') problems.push(this.problem('bareInPlace', 'This project is a bare repository, which has no working tree: its sessions run in worktrees'))
    const prefix = p.settings.branchPrefix ?? this.o.settings.values.get<string>('general.branchPrefix')
    const repo = { env: withGit ? await this.gitEnv() : {} }
    const root = isolation === 'worktree' ? this.worktreeRoot() : null
    const rootWrong = root ? await this.rootProblem(root, withGit) : null
    if (rootWrong) problems.push(this.problem('worktreeRoot', `${rootWrong}: choose another in Settings › General`, { path: root }))
    const projectDir = root ? path.join(root, this.projectDir(p)) : null
    const base = o.slugBase ?? (slugFromPrompt(a.prompt) || randomSlug(this.o.rng))
    const taken = async (s: string) => {
      if (this.db.get('SELECT 1 AS x FROM sessions WHERE project_id = ? AND slug = ? AND id != ?', p.id, s, o.self ?? '')) return true
      if (!projectDir) return false
      if (fs.existsSync(path.join(projectDir, s))) return true
      return withGit && a.base.kind !== 'existing' && !a.branch && (await branchExists(repo, p.rootPath, branchFor(prefix, s)))
    }
    // the worktree path stays under L.worktreePathMaxChars; the slug (with any `-n`) is shortened to fit
    const room = projectDir ? L.worktreePathMaxChars - 1 - projectDir.length - 1 : L.slugMaxChars
    if (projectDir && room < 1) problems.push(this.problem('pathTooLong', `The worktree location ${projectDir} is too long`, { path: projectDir }))
    const slug = await uniqueSlug(base.slice(0, Math.max(1, room)).replace(/-+$/, ''), taken, Math.max(1, room))
    const wtPath = projectDir ? path.join(projectDir, slug) : p.rootPath
    if (isolation === 'inplace') return { slug, branch: null, isolation, path: p.rootPath, root: null, problems, createBranch: false }
    let branch: string
    let createBranch = true
    if (a.base.kind === 'existing') {
      branch = a.base.ref ?? ''
      createBranch = false
      if (!branch || (withGit && !(await branchExists(repo, p.rootPath, branch)))) problems.push(this.problem('baseMissing', `There is no branch ${branch}`))
      else if (withGit) {
        const at = (await checkedOutBranches({ env: repo.env, root: p.rootPath }).catch(() => new Map<string, string>())).get(branch)
        if (at) {
          const owner = this.db.get<{ id: string }>(`SELECT id FROM sessions WHERE cwd = ? AND lifecycle != 'deleted'`, at)
          problems.push(this.problem('branchCheckedOut', `${branch} is already checked out at ${at}`, { path: at, sessionId: owner?.id ?? null }))
        }
      }
    } else {
      branch = a.branch ?? branchFor(prefix, slug)
      if (!withGit) {
        // checked by confirmPlan once the row is listed
      } else if (!(await validBranchName(repo, p.rootPath, branch))) problems.push(this.problem('branchInvalid', `${branch} is not a valid branch name`))
      else if (await branchExists(repo, p.rootPath, branch)) {
        let n = 2
        while (await branchExists(repo, p.rootPath, `${branch}-${n}`)) n++
        problems.push(this.problem('branchExists', `A branch named ${branch} already exists`, { suggestion: `${branch}-${n}` }))
      }
      // nothing is checked out in a bare repository, so "Current HEAD" names no base (known without git)
      if (p.bare && a.base.kind === 'head') problems.push(this.problem('baseMissing', 'A bare repository has no current HEAD to start from: choose a branch'))
      else if (!withGit) {
        // checked by confirmPlan
      } else if (a.base.kind === 'ref' && !(await resolveCommit(repo, p.rootPath, a.base.ref ?? ''))) problems.push(this.problem('baseMissing', `${a.base.ref ?? 'The base'} does not name a commit`))
      else if (a.base.kind !== 'ref' && !(await resolveCommit(repo, p.rootPath, 'HEAD')) && !(await this.defaultBaseExists(p, a.base.kind))) {
        // a repository with no commit yet (`git init` by hand, or "Initialise git…" without a git identity): a worktree
        // has nothing to start from
        problems.push(this.problem('baseMissing', 'The repository has no commit yet: commit once, or turn Worktree off'))
      }
    }
    if (!SLUG_RE.test(slug)) problems.push(this.problem('pathTooLong', `the session name ${slug} is not usable`))
    return { slug, branch, isolation, path: wtPath, root, problems, createBranch }
  }

  async create(a: {
    projectId: string
    prompt: string
    agent: string
    config: Omit<LaunchConfig, 'prompt'>
    isolation: Isolation
    base: BaseChoice
    branch?: string | undefined
    env?: Record<string, string> | undefined
    grid?: Grid | undefined
  }): Promise<{ sessionId: string; slug: string; branch: string | null }> {
    if (a.grid) this.grid = a.grid
    const p = this.project(a.projectId)
    // plan + insert one at a time, so two creations never pick the same slug. The row is listed at once, from what core
    // knows without git; the git checks are the creation's first step (confirmPlan)
    const run = this.createQueue.then(async () => {
      const plan = await this.plan(p, a, { git: false })
      const hard = plan.problems.find((x) => x.hard)
      if (hard) throw new RpcError('invalid_session', hard.message)
      const id = ulid(this.now())
      const minOrder = this.db.get<{ m: number | null }>('SELECT min(sort_order) AS m FROM sessions WHERE project_id = ?', p.id)?.m
      const order = Math.min(-this.now(), (minOrder ?? 0) - 1)
      const now = this.now()
      this.db.tx(() =>
        insertSession(this.db, {
          id,
          projectId: p.id,
          slug: plan.slug,
          title: titleFromSlug(plan.slug).slice(0, L.titleMaxChars),
          titleSource: 'auto',
          isolation: plan.isolation,
          cwd: plan.path,
          worktreeRoot: plan.root,
          branch: plan.branch,
          baseBranch: null,
          baseCommit: null,
          portBase: null,
          agent: SHELL_AGENT, // until the launch records the adapter's agent (launchAgent)
          agentSessionId: null,
          transcriptPath: null,
          // the composer's base, branch and agent ride along (not part of LaunchConfig): Retry checks and resolves the same, Duplicate offers the same agent
          launchConfig: JSON.stringify({ prompt: a.prompt, ...a.config, base: baseKey(a.base), ...(a.branch ? { branch: a.branch } : {}), requestedAgent: a.agent }),
          lifecycle: 'creating',
          endReason: null,
          deletedAt: null,
          snapshotRef: null,
          creationStep: J.create('git'),
          diskBytes: null,
          diskAt: null,
          sortOrder: order,
          pinnedOrder: 0,
          createdAt: now,
          archivedAt: null,
        }),
      )
      this.creation.set(id, { step: 'git', error: null, notices: [], logBytes: 0 })
      if (a.env && Object.keys(a.env).length) this.extraEnv.set(id, a.env)
      this.logTo(id, `create ${plan.isolation === 'worktree' ? `worktree ${plan.path} on ${plan.branch}` : `in place at ${plan.path}`} (agent ${a.agent})`)
      this.refresh(id)
      return { id, plan }
    })
    this.createQueue = run.catch(() => undefined)
    const { id, plan } = await run
    // the full choice set becomes the project's lastLaunch (its Worktree toggle as chosen). This agent's last choices
    // are kept there too: the composer takes them when the agent is changed to it
    await this.o.projects
      .updateSettings(p.id, { lastLaunch: nextLastLaunch(this.o.projects.get(p.id)?.settings.lastLaunch ?? p.settings.lastLaunch, { agent: a.agent, config: a.config, isolation: a.isolation, base: baseKey(a.base) }, L.lastLaunchAgentsMax) }, [])
      .catch((e) => this.log.warn('lastLaunch not saved', { error: String(e) }))
    this.track(this.queued(id, () => this.pipeline(id, a.base, 'git', plan.createBranch, a)))
    return { sessionId: id, slug: plan.slug, branch: plan.branch }
  }

  /**
   * The creation's first step, `git`: the checks that need git, once the row is listed, the same as validation's. An
   * automatic name whose branch exists moves to the next free name, before anything is made under it; any other problem
   * fails the creation here, in place. Runs with the creations' queue, so no two sessions take the same name.
   */
  private async confirmPlan(id: string, a: PlanArgs): Promise<void> {
    const run = this.createQueue.then(async () => {
      const r = this.row(id)
      const p = this.project(r.project_id)
      const plan = await this.plan(p, a, { self: id, slugBase: slugFromPrompt(a.prompt) || r.slug })
      const hard = plan.problems.find((x) => x.hard)
      if (hard) throw new Error(hard.message)
      if (plan.slug === r.slug) return
      const title = r.title_source === 'auto' ? titleFromSlug(plan.slug).slice(0, L.titleMaxChars) : r.title
      this.db.tx(() => this.db.run('UPDATE sessions SET slug = ?, title = ?, cwd = ?, branch = ? WHERE id = ?', plan.slug, title, plan.path, plan.branch, id))
      this.logTo(id, `named ${plan.slug} instead of ${r.slug}: ${r.branch ?? 'its branch'} already exists`)
      this.refresh(id)
    })
    this.createQueue = run.catch(() => undefined)
    await run
  }

  /**
   * Runs the pipeline from `from` (a fresh creation, or Retry from the journaled step). `confirm`: a fresh creation's
   * choices, checked against git at the first step (confirmPlan).
   */
  private async pipeline(id: string, base: BaseChoice | null, from: CreationStep, createBranch: boolean, confirm?: PlanArgs): Promise<void> {
    const steps = CREATION_STEPS.slice(CREATION_STEPS.indexOf(from))
    let step: CreationStep = from
    try {
      for (step of steps) {
        if (this.disposed) return
        this.setStep(id, step)
        await this.o.faults?.(`create:${step}`, id)
        const go = await this.runStep(id, step, base, createBranch, confirm)
        if (go === 'wait') return // setup failed: Retry / Start agent anyway
      }
    } catch (e) {
      // core went (a relaunch decides), or Discard took the row while the pipeline waited
      if (this.disposed || !this.db.get(GET, id)) return
      const msg = (e as Error).message ?? String(e)
      this.log.warn('session creation failed', { sessionId: id, step, error: msg })
      this.logTo(id, `error at ${step}: ${msg}`)
      const c = this.creation.get(id)
      this.creation.set(id, { step, error: msg, notices: c?.notices ?? [], logBytes: logBytes(this.o.home, id) })
      this.transition(id, 'failed')
    }
  }

  private setStep(id: string, step: CreationStep): void {
    this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = ? WHERE id = ?', J.create(step), id))
    const c = this.creation.get(id)
    this.creation.set(id, { step, error: null, notices: c?.notices ?? [], logBytes: logBytes(this.o.home, id) })
    this.logTo(id, `step ${step}`)
  }

  private notice(id: string, text: string): void {
    const c = this.creation.get(id)
    if (c) this.creation.set(id, { ...c, notices: [...c.notices, text].slice(-CREATION_STEPS.length) })
    this.logTo(id, `notice: ${text}`)
  }

  private async runStep(id: string, step: CreationStep, base: BaseChoice | null, createBranch: boolean, confirm?: PlanArgs): Promise<'next' | 'wait'> {
    const r = this.row(id)
    const p = this.project(r.project_id)
    const worktree = r.isolation === 'worktree'
    switch (step) {
      case 'git': {
        if (!worktree) return 'next'
        const g = await this.o.git
        if (!g.usable) throw new Error(g.missing ?? 'git is not available')
        if (confirm) await this.confirmPlan(id, confirm)
        return 'next'
      }
      case 'base': {
        if (worktree && !r.base_commit) {
          const repo = await this.repo(p)
          const choice = base ?? { kind: 'default' as const }
          const def = choice.kind === 'default' || choice.kind === 'existing' ? await this.defaultBranch(p, repo) : null
          const res = await resolveBase(repo, choice, def, false).catch((e) => {
            throw e instanceof BaseError ? e : new Error(`base: ${(e as Error).message}`)
          })
          for (const n of res.notices) this.notice(id, n)
          // the record: base branch and base commit, journaled with this step (the worktree root is in the row already)
          this.db.tx(() => this.db.run('UPDATE sessions SET base_branch = ?, base_commit = ? WHERE id = ?', res.baseBranch, res.commit, id))
          this.logTo(id, `base ${res.baseBranch ?? res.commit.slice(0, 12)} @ ${res.commit.slice(0, 12)}`)
        }
        const port = await this.o.ports.allocate(id)
        if (port === null) this.notice(id, 'no free port block, so KEA_PORT is not set: every block is held by a session or has a port in use')
        return 'next'
      }
      case 'add': {
        if (!worktree) return 'next'
        const repo = await this.repo(p)
        const root = r.worktree_root!
        await fs.promises.mkdir(path.dirname(r.cwd), { recursive: true })
        // the final path is inside the worktree root after realpath
        const realRoot = canonical(root)
        const realParent = canonical(path.dirname(r.cwd))
        if (!`${realParent}/`.startsWith(`${realRoot}/`) || !SLUG_RE.test(path.basename(r.cwd))) throw new Error(`refusing a worktree path outside ${root}`)
        const made = this.launchExtras(r).madeBranch === true
        if (made || fs.existsSync(r.cwd)) {
          // a retry after a partial add: undo it first (only what this creation made)
          await rollbackAdd(repo, { path: r.cwd, branch: r.branch, baseCommit: r.base_commit, createdBranch: made })
        }
        if (createBranch) {
          // journaled before `add -b` makes it; a branch that is already there is someone else's and stays
          if (await branchExists(repo, p.rootPath, r.branch!)) throw new Error(`a branch named ${r.branch} already exists`)
          this.setMadeBranch(id, true)
        } else this.setMadeBranch(id, false)
        const res = await addWorktree(repo, { path: r.cwd, branch: r.branch!, commit: r.base_commit!, existing: !createBranch })
        if (res.output) this.logTo(id, res.output)
        if (res.hookFailed) this.notice(id, 'a git hook failed after the checkout (see the log); the worktree is fine')
        return 'next'
      }
      case 'copy': {
        if (!worktree) return 'next'
        const copied = await this.copyFiles(p, r.cwd, id)
        this.logTo(id, copied.length ? `copied: ${copied.join(', ')}` : 'copied: nothing')
        return 'next'
      }
      case 'submodules': {
        if (!worktree) return 'next'
        const env = await this.gitEnv()
        if (fs.existsSync(path.join(r.cwd, '.gitmodules'))) {
          const s = await git(['submodule', 'update', '--init', '--recursive'], { cwd: r.cwd, env, timeoutMs: L.gitCheckoutTimeoutMs, collect: true })
          this.logTo(id, `${(s.stdout ?? Buffer.alloc(0)).toString('utf8')}${s.stderr}`.trim() || 'submodules initialised')
          if (s.code !== 0) throw new Error(`git submodule update failed: ${s.stderr.trim().split('\n').pop() ?? s.code}`)
        }
        // Git LFS pointers are pulled when the repository uses LFS and git-lfs is installed
        const lfs = await git(['lfs', 'ls-files', '--name-only'], { cwd: r.cwd, env, readOnly: true, collect: true }).catch(() => null)
        if (lfs && lfs.code === 0 && (lfs.stdout ?? Buffer.alloc(0)).length > 0) {
          const pull = await git(['lfs', 'pull'], { cwd: r.cwd, env, timeoutMs: L.gitCheckoutTimeoutMs, collect: true })
          this.logTo(id, `git lfs pull: ${pull.code === 0 ? 'done' : `failed — ${pull.stderr.trim().split('\n').pop() ?? ''}`}`)
          if (pull.code !== 0) this.notice(id, 'git lfs pull failed (see the log)')
        }
        return 'next'
      }
      case 'setup': {
        const started = await this.startScript(id, 'setup', 'create')
        if (!started) {
          await this.excludeBackups(id)
          return 'next'
        }
        if (p.settings.startAgentWithoutWaitingForSetup) return 'next'
        const gate = new Deferred()
        this.setupGate.set(id, gate)
        await gate.promise
        this.setupGate.delete(id)
        if (this.disposed) return 'wait'
        const st = this.setup.get(id)
        if (st?.state === 'failed') return 'wait'
        return 'next'
      }
      case 'launch': {
        await this.launchAgent(id)
        this.creation.delete(id)
        this.extraEnv.delete(id)
        this.logTo(id, 'agent started')
        return 'next'
      }
    }
  }

  /** Retry a failed creation from its journaled step. */
  retry(id: string, grid?: Grid): Promise<{ ok: boolean }> {
    if (grid) this.grid = grid
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.lifecycle !== 'create_failed') throw new RpcError('wrong_state', `the session is ${r.lifecycle}`)
      const journaled = (r.creation_step?.startsWith('create:') ? r.creation_step.slice(7) : 'git') as CreationStep
      const step = (CREATION_STEPS as readonly string[]).includes(journaled) ? journaled : 'git'
      this.transition(id, 'retry')
      const base = this.launchExtras(r).base
      // from the first step its checks run again: an automatic name moves on, any other problem fails here
      this.track(this.queued(id, () => this.pipeline(id, base, step, this.plansNewBranch(r), step === 'git' ? this.planArgs(r) : undefined)))
      return { ok: true }
    })
  }

  /**
   * Discard a failed creation. Teardown runs first if setup had started: this launch saw it, or the journal is at or
   * past the setup step of a project with a setup script, as after a relaunch. Then the rollback undoes what the
   * creation made; the row and its directory go.
   */
  discard(id: string): Promise<{ ok: boolean }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.lifecycle !== 'create_failed' && r.lifecycle !== 'creating') throw new RpcError('wrong_state', `the session is ${r.lifecycle}`)
      const gate = this.setupGate.get(id)
      await this.stopAll(id)
      if (this.setup.has(id) || this.setupJournaled(r)) await this.runTeardown(id, 'delete')
      if (r.isolation === 'worktree' && r.worktree_root) {
        const p = this.project(r.project_id)
        const repo = await this.repo(p)
        const res = await rollbackAdd(repo, { path: r.cwd, branch: r.branch, baseCommit: r.base_commit, createdBranch: this.launchExtras(r).madeBranch === true })
        this.logTo(id, `discarded: worktree removed${res.branchDeleted ? `, branch ${r.branch} deleted` : ''}`)
      }
      gate?.resolve()
      await this.purgeRow(id)
      return { ok: true }
    })
  }

  /** The creation's journal is at or past its setup step and the project has a setup script: setup had started. */
  private setupJournaled(r: Row): boolean {
    const step = r.creation_step?.startsWith('create:') ? r.creation_step.slice('create:'.length) : null
    if (r.isolation !== 'worktree' || !step || CREATION_STEPS.indexOf(step as CreationStep) < CREATION_STEPS.indexOf('setup')) return false
    const p = this.o.projects.get(r.project_id)
    return !!p && hasScript('setup', p.settings, [r.cwd, p.rootPath])
  }

  // ── the agent ───────────────────────────────────────────────────────────────────────────────────

  private async launchAgent(id: string, grid?: Grid, how: AgentLaunchHow = 'start'): Promise<void> {
    const r = this.row(id)
    if (r.isolation === 'worktree' && !fs.existsSync(r.cwd)) throw new RpcError('wrong_state', 'the worktree is missing (Recreate from branch)')
    const env = { ...(await this.ptyEnv(r, { kind: 'agent' })), ...(this.extraEnv.get(id) ?? {}) }
    const shell = userShell(await this.o.env())
    const g = grid ?? this.grid
    const ended = this.o.terminals.sessionRecords(id).filter((x) => x.kind === 'agent' && x.state !== 'running')
    // Resume continues the agent's conversation, Restart starts a fresh one in the same worktree (the adapter's
    // commands, through the seam; the shell pseudo-agent otherwise)
    const session: AgentLaunchSession = { id, agent: r.agent, cwd: r.cwd, isolation: r.isolation, agentSessionId: how === 'restart' ? null : r.agent_session_id, launch: this.launchConfig(r), requestedAgent: this.launchExtras(r).requestedAgent }
    const cmd = (await this.o.agentCommand?.(session, how)) ?? null
    const argv = cmd?.argv ?? shellTabArgv(shell)
    const command = { argv, ...(cmd?.throughLoginShell ? { throughLoginShell: true } : {}) }
    const { ptyId } = await this.o.terminals.launch({ sessionId: id, kind: 'agent', command, cwd: r.cwd, cols: g.cols, rows: g.rows, env: { ...env, ...cmd?.env }, ...(cmd?.unsetEnv?.length ? { unsetEnv: cmd.unsetEnv } : {}) })
    this.log.info('agent launched', { sessionId: id, ptyId, how, agent: r.agent })
    // the new agent takes the session's one Agent tab: the ended agent PTYs it replaces go, files and all
    for (const x of ended) await this.o.terminals.forgetRecord(x.ptyId, { files: true })
    this.transition(id, 'launched', () => {
      this.db.run(`UPDATE sessions SET end_reason = NULL, creation_step = NULL WHERE id = ?`, id)
      // a Restart's conversation is a new one: the old conversation's id and transcript no longer describe it
      if (how === 'restart') this.db.run(`UPDATE sessions SET agent_session_id = NULL, transcript_path = NULL WHERE id = ?`, id)
      // what the adapter's command started: the agent, and the conversation id it pre-assigned or resumed
      if (cmd?.agent) this.db.run(`UPDATE sessions SET agent = ? WHERE id = ?`, cmd.agent, id)
      if (cmd?.agentSessionId !== undefined) this.db.run(`UPDATE sessions SET agent_session_id = ? WHERE id = ?`, cmd.agentSessionId, id)
      // the shell pseudo-agent has no turns: it runs idle; an adapter's agent starts `starting` (the engine's
      // "Agent PTY spawned")
      this.db.run(`UPDATE session_runtime SET phase = ?, attention = '[]', background = 0, failure_kind = NULL, last_activity_at = ? WHERE session_id = ?`, cmd?.agent ? 'starting' : 'idle', this.now(), id)
    })
    // an agent that ended before the session was live (its exit event found the session not live yet) ends it now
    const rec = this.o.terminals.record(ptyId)
    if (rec && rec.state !== 'running') this.onExit({ ptyId, sessionId: id, kind: 'agent', state: rec.state === 'lost' ? 'lost' : 'exited', exitCode: rec.exitCode, exitSignal: rec.exitSignal })
  }

  private onExit(e: TerminalExit): void {
    const st = this.setup.get(e.sessionId)
    if (st && st.ptyId === e.ptyId && st.state === 'running' && !this.setupEnding.has(e.ptyId)) {
      // its output goes to the log first, so whoever sees the setup end finds all of it there; then its holder goes
      // (its last screen stays in checkpoint + ring)
      this.setupEnding.add(e.ptyId)
      this.track(
        this.captureToLog(e.sessionId, e.ptyId, 'setup').finally(() => {
          this.setupEnding.delete(e.ptyId)
          this.setupEnded(e)
          void this.o.terminals.releaseEnded(e.ptyId).catch(() => false)
        }),
      )
    } else if (this.skippedSetups.delete(e.ptyId)) {
      this.track(this.captureToLog(e.sessionId, e.ptyId, 'skipped setup').finally(() => void this.o.terminals.releaseEnded(e.ptyId).catch(() => false)))
    } else if (e.kind === 'script' && !this.tearingDown.has(e.sessionId) && kvGet(this.db, `${TEARDOWN_KV}${e.ptyId}`) !== undefined) {
      // a teardown nobody waits for any more (it outlived its time limit, or the core that started it): see below
      this.track(this.endTeardownTerminal(e.sessionId, e.ptyId))
    }
    if (e.kind !== 'agent') return
    const r = this.db.get<Row>(GET, e.sessionId)
    if (!r || r.lifecycle !== 'live') return
    const running = this.o.terminals.sessionRecords(e.sessionId).some((x) => x.kind === 'agent' && x.state === 'running')
    if (running) return // another agent PTY (Restart) is the live one
    const reason: EndReason = this.stopping.has(e.sessionId) ? 'stopped' : e.state === 'lost' ? 'lost' : e.exitCode === 0 ? 'exited' : 'crashed'
    this.stopping.delete(e.sessionId)
    this.transition(e.sessionId, 'agentEnded', () => {
      this.db.run('UPDATE sessions SET end_reason = ? WHERE id = ?', reason, e.sessionId)
      this.db.run(noRuntime, e.sessionId)
    })
    // an exited agent holds nothing: its holder goes; Resume starts a new PTY
    void this.o.terminals.releaseEnded(e.ptyId).catch(() => false)
  }

  /** A setup script ended and its output is in the log: the run is done or failed, and the creation waiting on it goes on. */
  private setupEnded(e: TerminalExit): void {
    if (this.disposed) return
    const st = this.setup.get(e.sessionId)
    if (!st || st.ptyId !== e.ptyId || st.state !== 'running') return // skipped or run again meanwhile
    const okExit = e.state === 'exited' && e.exitCode === 0
    this.setup.set(e.sessionId, { ...st, state: okExit ? 'done' : 'failed', exitCode: e.exitCode })
    this.logTo(e.sessionId, `setup ${okExit ? 'finished' : `failed (exit ${e.exitCode ?? e.exitSignal ?? 'lost'})`}`)
    if (okExit) void this.excludeBackups(e.sessionId)
    const gate = this.setupGate.get(e.sessionId)
    if (gate) gate.resolve()
    else if (okExit && st.reason === 'create' && this.db.get<Row>(GET, e.sessionId)?.lifecycle === 'creating') {
      // a retried setup succeeded after the pipeline stopped at the failed one: the agent starts now
      this.track(this.queued(e.sessionId, () => this.pipeline(e.sessionId, null, 'launch', false)))
    }
    this.refresh(e.sessionId)
  }

  /**
   * End the agent: SIGTERM to its process group, then SIGKILL after L.stopGraceMs (the `shell` pseudo-agent is hung up
   * instead); the session becomes `detached` with `end_reason = stopped`.
   */
  stop(id: string): Promise<{ ok: boolean }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.lifecycle !== 'live') return { ok: false }
      this.stopping.add(id)
      for (const rec of this.o.terminals.sessionRecords(id)) if (rec.kind === 'agent' && rec.state === 'running') await this.stopAgent(r, rec.ptyId)
      if (this.row(id).lifecycle === 'live') {
        // the exit report did not come (an unreachable holder): the session still ends as stopped
        this.stopping.delete(id)
        this.transition(id, 'agentEnded', () => {
          this.db.run(`UPDATE sessions SET end_reason = 'stopped' WHERE id = ?`, id)
          this.db.run(noRuntime, id)
        })
      }
      return { ok: true }
    })
  }

  /**
   * SIGTERM to the agent's process groups, SIGKILL after L.stopGraceMs. The `shell` pseudo-agent is an interactive
   * shell, which ignores SIGTERM: it is hung up like a closed tab.
   */
  private stopAgent(r: Pick<Row, 'agent'>, ptyId: string): Promise<boolean> {
    return r.agent === SHELL_AGENT ? this.o.terminals.stop(ptyId, 'hangup', L.shellCloseGraceMs) : this.o.terminals.stop(ptyId, 'terminate', L.stopGraceMs)
  }

  /**
   * Resume (the adapter's resume command, the same conversation) or Restart (a fresh conversation), in the session's
   * directory; for the `shell` pseudo-agent, both start a new login shell there (`AgentCommand`).
   */
  resume(id: string, grid?: Grid, how: 'resume' | 'restart' = 'resume'): Promise<{ ok: boolean }> {
    if (grid) this.grid = grid
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.lifecycle !== 'detached') throw new RpcError('wrong_state', `the session is ${r.lifecycle}`)
      await this.launchAgent(id, grid, how)
      return { ok: true }
    })
  }

  /** A shell tab in the session's directory, with the session environment. */
  openShell(id: string, grid?: Grid): Promise<{ ptyId: string }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.lifecycle !== 'live' && r.lifecycle !== 'detached') throw new RpcError('wrong_state', `the session is ${r.lifecycle}`)
      if (!fs.existsSync(r.cwd)) throw new RpcError('wrong_state', 'the worktree is missing (Recreate from branch)')
      const env = await this.ptyEnv(r, { kind: 'shell' })
      const shell = userShell(await this.o.env())
      const g = grid ?? this.grid
      return this.o.terminals.launch({ sessionId: id, kind: 'shell', command: { argv: shellTabArgv(shell) }, cwd: r.cwd, cols: g.cols, rows: g.rows, env })
    })
  }

  // ── archive ───────────────────────────────────────────────────────────────────────────────────

  archive(id: string, confirmed: boolean): Promise<{ archived: boolean; reasons: { kind: 'midTurn' | 'server' | 'shellBusy' | 'shellUnknown'; detail: string }[]; teardownFailed: boolean }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.lifecycle !== 'live' && r.lifecycle !== 'detached') throw new RpcError('wrong_state', `the session is ${r.lifecycle}`)
      const reasons: { kind: 'midTurn' | 'server' | 'shellBusy' | 'shellUnknown'; detail: string }[] = []
      if (!confirmed) {
        if (r.lifecycle === 'live' && (r.phase === 'working' || r.phase === 'starting') && r.agent !== SHELL_AGENT) reasons.push({ kind: 'midTurn', detail: 'the agent is working' })
        for (const rec of this.o.terminals.sessionRecords(id)) {
          if (rec.state !== 'running') continue
          if (rec.kind === 'server') reasons.push({ kind: 'server', detail: '' }) // the sheet's own line says it all
          if (rec.kind === 'shell' || (rec.kind === 'agent' && r.agent === SHELL_AGENT)) {
            // the busy-shell rule, also for what could not be learned (ptyhost had no answer): asked about, never taken
            // for idle, and said as what it is (`shellUnknown`), so the sheet does not claim a program is running
            const fg = await this.o.terminals.foreground(rec.ptyId)
            if (fg.busy) reasons.push({ kind: fg.known ? 'shellBusy' : 'shellUnknown', detail: fg.known ? fg.name : '' })
          }
        }
        if (reasons.length) return { archived: false, reasons, teardownFailed: false }
      }
      await this.stopAll(id)
      const teardownOk = await this.runTeardown(id, 'archive')
      await this.keepCheckpointsOnly(id)
      await this.excludeBackups(id)
      this.o.ports.release(id)
      this.transition(id, 'archive', () => {
        this.db.run(`UPDATE sessions SET archived_at = ?, end_reason = coalesce(end_reason, 'stopped'), port_base = NULL WHERE id = ?`, this.now(), id)
        this.db.run(noRuntime, id)
      })
      return { archived: true, reasons: [], teardownFailed: !teardownOk }
    })
  }

  /**
   * Unarchive: `detached` again with a port block; a worktree auto-clean removed is added back, and setup runs again
   * when what it made may be gone.
   */
  unarchive(id: string): Promise<{ ok: boolean }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.lifecycle !== 'archived') throw new RpcError('wrong_state', `the session is ${r.lifecycle}`)
      if (r.isolation === 'worktree' && !fs.existsSync(r.cwd)) await this.addBack(r)
      await this.o.ports.allocate(id)
      this.transition(id, 'unarchive', () => {
        this.db.run(`UPDATE sessions SET archived_at = NULL, creation_step = NULL WHERE id = ?`, id)
        keepOrRepick(this.db, id, r.project_id)
      })
      this.missing.delete(id)
      const p = this.project(r.project_id)
      // setup runs again when the project has a teardown command (it undid what setup made), the worktree came back, or
      // the session's build folders were removed while it was archived
      const pruned = this.o.buildFolders?.pruned(id) ?? false
      if (hasScript('teardown', p.settings, [r.cwd, p.rootPath]) || r.creation_step === J.cleaned || pruned) await this.startScript(id, 'setup', 'unarchive')
      if (pruned) this.o.buildFolders?.restored(id)
      this.refresh(id)
      return { ok: true }
    })
  }

  // ── delete ───────────────────────────────────────────────────────────────────────────────────

  async deletePreview(id: string): Promise<DeletePreview> {
    const r = this.row(id)
    const p = this.project(r.project_id)
    const retentionDays = this.o.settings.values.get<number>('general.deletedRetentionDays')
    const teardown = r.isolation === 'worktree' && hasScript('teardown', p.settings, [r.cwd, p.rootPath])
    const none = { uncommittedFiles: 0, ownCommits: 0, uniqueCommits: 0, merged: true }
    if (r.isolation !== 'worktree' || !fs.existsSync(r.cwd)) {
      return { isolation: r.isolation, branch: r.branch, ...none, deleteBranchDefault: false, oversize: [], nestedRepos: [], teardown, retentionDays, worktreeMissing: r.isolation === 'worktree' }
    }
    const repo = { env: await this.gitEnv() }
    const { uncommittedFiles, ownCommits, uniqueCommits, merged } = await branchFacts(repo, r.cwd, r.base_branch ?? r.base_commit, r.branch)
    const { oversize, nested } = await unsnapshottable(repo, r.cwd)
    // "delete branch too" starts ticked when deleting it loses nothing: it is merged, or holds no commit of its own
    return { isolation: r.isolation, branch: r.branch, uncommittedFiles, ownCommits, uniqueCommits, merged, deleteBranchDefault: merged || ownCommits === 0, oversize, nestedRepos: nested, teardown, retentionDays, worktreeMissing: false }
  }

  delete(id: string, deleteBranchToo: boolean, force: boolean): Promise<{ deleted: boolean; branchDeleted: boolean; teardownFailed: boolean; log: { text: string; truncated: boolean } | null }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (!nextLifecycle(r.lifecycle, 'delete')) throw new RpcError('wrong_state', `the session is ${r.lifecycle}${r.lifecycle === 'create_failed' ? ' (Discard it)' : ''}`)
      const mode = deleteBranchToo ? (force ? 'force' : 'branch') : 'keep'
      this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = ? WHERE id = ?', J.delete(mode), id))
      let teardownOk = true
      let branchDeleted = false
      let log: { text: string; truncated: boolean } | null = null
      try {
        await this.o.faults?.('delete:stop', id)
        await this.stopAll(id)
        if (r.isolation === 'worktree') {
          await this.o.faults?.('delete:snapshot', id)
          await this.snapshot(this.row(id)) // from here on a killed delete completes
          await this.o.faults?.('delete:teardown', id)
          teardownOk = await this.runTeardown(id, 'delete')
        }
        // the toast's View log shows the failed teardown's output, read before the log goes with the session's
        // directory
        if (!teardownOk) {
          const { text, truncated } = readLog(this.o.home, id)
          log = { text, truncated }
        }
        branchDeleted = await this.finishDelete(id)
      } catch (e) {
        // failed in process (a killed core is disposed: the next launch decides)
        if (!this.disposed) await this.undoDelete(id).catch((u) => this.log.warn('failed delete not undone', { sessionId: id, error: String(u) }))
        throw e
      }
      if (!teardownOk) this.log.warn('teardown failed during delete; the session is deleted all the same', { sessionId: id })
      return { deleted: true, branchDeleted, teardownFailed: !teardownOk, log }
    })
  }

  /**
   * A delete that failed in process. While the worktree is still there the session is left as it was: the journal,
   * `snapshot_ref` and the ref go, so no stale snapshot is ever completed or restored and the next delete snapshots
   * afresh. Once the worktree went to the trash, the journal stays and the next launch completes the delete.
   */
  private async undoDelete(id: string): Promise<void> {
    const r = this.db.get<Row>(GET, id)
    if (!r || r.lifecycle === 'deleted' || !r.creation_step?.startsWith('delete:')) return
    if (r.isolation === 'worktree' && r.snapshot_ref && !fs.existsSync(r.cwd)) return
    await this.dropDeleteJournal(r, 'delete failed: undone, the session is as it was')
  }

  /** The session stays as it was before a delete started: journal, `snapshot_ref` and the snapshot ref cleared. */
  private async dropDeleteJournal(r: Row, why: string): Promise<void> {
    this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = NULL, snapshot_ref = NULL WHERE id = ?', r.id))
    const p = this.o.projects.get(r.project_id)
    if (r.isolation === 'worktree' && p?.isGit && (await this.o.git).usable) await deleteRef({ env: await this.gitEnv(), root: p.rootPath }, snapshotRef(r.id)).catch(() => undefined)
    this.logTo(r.id, why)
    this.refresh(r.id)
  }

  /**
   * The delete snapshot of a worktree session: its uncommitted work as a commit under `refs/kea/deleted/<id>`, recorded
   * in `snapshot_ref`. Always afresh while the worktree is there (the ref is overwritten); when it is gone, an earlier
   * attempt's snapshot stays, else the ref is the branch tip.
   */
  private async snapshot(r: Row): Promise<void> {
    if (r.snapshot_ref && !fs.existsSync(r.cwd)) return
    const p = this.project(r.project_id)
    const repo = await this.repo(p)
    let ref: string | null = null
    if (fs.existsSync(r.cwd)) {
      const s = await writeSnapshot(repo, { wt: r.cwd, sessionId: r.id, slug: r.slug, tmpDir: snapshotTmpDir(this.o.home) })
      ref = s.ref
      this.logTo(r.id, `snapshot ${s.commit.slice(0, 12)}${s.oversize.length ? `; not kept (over the size limit): ${s.oversize.map((f) => f.path).join(', ')}` : ''}${s.nested.length ? `; not kept (repositories of their own): ${s.nested.join(', ')}` : ''}`)
    } else if (r.branch && (await resolveCommit(repo, p.rootPath, `refs/heads/${r.branch}`))) {
      ref = `refs/kea/deleted/${r.id}`
      await git(['update-ref', ref, `refs/heads/${r.branch}`], { cwd: p.rootPath, env: repo.env, collect: true })
    }
    if (ref) this.db.tx(() => this.db.run('UPDATE sessions SET snapshot_ref = ? WHERE id = ?', ref, r.id))
  }

  /**
   * Everything a delete does after the snapshot and teardown, the record included. Also completes an interrupted
   * delete.
   */
  private async finishDelete(id: string): Promise<boolean> {
    const r = this.row(id)
    const mode = r.creation_step?.startsWith('delete:') ? r.creation_step.slice(7) : 'keep'
    let branchDeleted = false
    if (r.isolation === 'worktree' && r.worktree_root) {
      const p = this.project(r.project_id)
      const repo = await this.repo(p)
      if (fs.existsSync(r.cwd)) {
        await stopFsmonitor(repo, r.cwd).catch(() => undefined)
        await this.o.faults?.('delete:trash', id)
        // into the trash of the root recorded on the session (same volume: the rename is instant)
        const moved = await this.toTrash(r.cwd, r.worktree_root)
        this.track(emptyTrashEntry(moved).catch((e) => this.log.warn('trash not emptied', { path: moved, error: String(e) })))
      }
      await this.o.faults?.('delete:prune', id)
      await pruneWorktrees(repo)
      if (mode !== 'keep' && r.branch && (await branchExists(repo, p.rootPath, r.branch))) {
        branchDeleted = await deleteBranch(repo, r.branch, mode === 'force')
        this.log.info(branchDeleted ? 'branch deleted' : 'branch kept: not merged (git branch -d)', { sessionId: id, branch: r.branch })
      }
    }
    this.o.ports.release(id)
    await this.o.terminals.forgetSession(id)
    this.removeStateDir(id)
    this.transition(id, 'delete', () => {
      this.db.run(`UPDATE sessions SET deleted_at = ?, end_reason = coalesce(end_reason, 'stopped'), creation_step = NULL, port_base = NULL WHERE id = ?`, this.now(), id)
      this.db.run(noRuntime, id)
    })
    this.creation.delete(id)
    this.setup.delete(id)
    this.teardownFailed.delete(id)
    this.missing.delete(id)
    return branchDeleted
  }

  /**
   * Move `p` into the trash of the worktree root `root` (same volume: the rename is instant). A move that makes that
   * `.kea-trash` says so (`folderMade`), so core marks it for Time Machine at once (U-HOME-6).
   */
  private toTrash(p: string, root: string): Promise<string> {
    return moveToTrash(p, path.join(root, WORKTREE_TRASH), { made: (dir) => this.o.folderMade?.(dir) })
  }

  /** `<KEA_HOME>/sessions/<id>/` (rings, checkpoints, state files, creation log): gone before the row is. */
  private removeStateDir(id: string): void {
    const dir = path.join(this.o.home, 'sessions', id)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      this.log.warn('session directory not removed', { sessionId: id, error: String(e) })
    }
  }

  /** The row goes for good (Discard, the purge after the retention), its state directory first. */
  private async purgeRow(id: string): Promise<void> {
    await this.o.terminals.forgetSession(id)
    this.removeStateDir(id)
    this.db.tx(() => this.db.run('DELETE FROM sessions WHERE id = ?', id))
    this.creation.delete(id)
    this.setup.delete(id)
    this.teardownFailed.delete(id)
    this.missing.delete(id)
    this.extraEnv.delete(id)
    this.store.delete(id)
  }

  // ── restore ────────────────────────────────────────────────────────────────────────────────────

  async listDeleted(projectId: string): Promise<{ sessions: { id: string; title: string; branch: string | null; isolation: Isolation; deletedAt: number; snapshotFiles: number }[] }> {
    const p = this.project(projectId)
    const since = this.now() - this.retentionMs()
    const rows = this.db.all<Row>(`${SELECT} WHERE s.project_id = ? AND s.lifecycle = 'deleted' AND s.deleted_at >= ? ORDER BY s.deleted_at DESC`, projectId, since)
    const repo = { env: await this.gitEnv(), root: p.rootPath }
    const out = []
    for (const r of rows) {
      const files = r.snapshot_ref && p.isGit ? await snapshotFiles(repo, r.snapshot_ref).catch(() => 0) : 0
      out.push({ id: r.id, title: r.title, branch: r.branch, isolation: r.isolation, deletedAt: r.deleted_at ?? 0, snapshotFiles: files })
    }
    return { sessions: out }
  }

  restore(id: string): Promise<{ ok: boolean; branch: string | null }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.lifecycle !== 'deleted') throw new RpcError('wrong_state', `the session is ${r.lifecycle}`)
      const p = this.project(r.project_id)
      let branch = r.branch
      if (r.isolation === 'worktree') {
        if (!r.snapshot_ref) throw new RpcError('wrong_state', 'nothing to restore: the session has no snapshot')
        if (fs.existsSync(r.cwd)) throw new RpcError('wrong_state', `${r.cwd} exists already`)
        const repo = await this.repo(p)
        const own = r.branch ?? `kea/${r.slug}`
        const had = (await resolveCommit(repo, p.rootPath, `refs/heads/${own}`)) !== null
        this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = ? WHERE id = ?', had ? J.restore : J.restoreNew, id))
        await fs.promises.mkdir(path.dirname(r.cwd), { recursive: true })
        let res: { branch: string; createdBranch: boolean; base: string }
        try {
          await this.o.faults?.('restore:add', id)
          res = await restoreWorktree(repo, { path: r.cwd, branch: own, ref: r.snapshot_ref })
          await this.o.faults?.('restore:copy', id)
          const copied = await this.copyFiles(p, r.cwd, id)
          this.logTo(id, `restored on ${res.branch}; copied: ${copied.join(', ') || 'nothing'}`)
        } catch (e) {
          await this.rollbackRestore(this.row(id)).catch(() => undefined)
          throw new RpcError('git_failed', `restore failed: ${(e as Error).message}`)
        }
        branch = res.branch
        const ref = r.snapshot_ref
        this.transition(id, 'restore', () => {
          this.db.run(`UPDATE sessions SET deleted_at = NULL, snapshot_ref = NULL, creation_step = NULL, branch = ? WHERE id = ?`, res.branch, id)
          keepOrRepick(this.db, id, r.project_id)
        })
        await deleteRef({ env: repo.env, root: p.rootPath }, ref)
      } else {
        this.transition(id, 'restore', () => {
          this.db.run(`UPDATE sessions SET deleted_at = NULL, creation_step = NULL WHERE id = ?`, id)
          keepOrRepick(this.db, id, r.project_id)
        })
      }
      await this.o.ports.allocate(id)
      if (r.isolation === 'worktree') await this.startScript(id, 'setup', 'restore')
      this.refresh(id)
      return { ok: true, branch }
    })
  }

  /** Undo a restore that did not finish: the session stays deleted with its snapshot ref. */
  private async rollbackRestore(r: Row): Promise<void> {
    const p = this.project(r.project_id)
    const repo = await this.repo(p)
    const parent = r.snapshot_ref ? ((await snapshotBase(repo, r.snapshot_ref))?.base ?? null) : null
    const entry = (await listWorktrees(repo).catch(() => [])).find((w) => canonicalPath(w.path) === canonicalPath(r.cwd))
    const own = r.branch ?? `kea/${r.slug}`
    if (entry?.branch && (entry.branch === own || entry.branch.startsWith(`${own}-restored`))) {
      // a branch the restore made sits at the snapshot's parent and goes: a `<branch>-restored[-n]`, or the session's
      // own when it did not exist before (journaled); an own branch that existed is never deleted
      await rollbackAdd(repo, { path: r.cwd, branch: entry.branch, baseCommit: parent, createdBranch: entry.branch !== own || r.creation_step === J.restoreNew })
    }
    if (fs.existsSync(r.cwd)) await rollbackAdd(repo, { path: r.cwd, branch: null, baseCommit: null, createdBranch: false })
    this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = NULL WHERE id = ?', r.id))
    this.logTo(r.id, 'restore rolled back')
  }

  // ── smaller calls ─────────────────────────────────────────────────────────────────────────────

  rename(id: string, title: string): Promise<{ ok: boolean }> {
    return this.queued(id, async () => {
      this.row(id)
      const t = title.trim()
      if (!t) throw new RpcError('invalid_args', 'a title cannot be empty')
      this.db.tx(() => this.db.run(`UPDATE sessions SET title = ?, title_source = 'user' WHERE id = ?`, t, id))
      this.refresh(id)
      return { ok: true }
    })
  }

  /** To `index` of the project's order (fractional sort order; renumbered when out of room). */
  async move(id: string, index: number): Promise<{ ok: boolean }> {
    const r = this.row(id)
    const others = this.db.all<Row>(BY_PROJECT, r.project_id).filter((x) => x.lifecycle !== 'deleted' && x.id !== id)
    const at = Math.max(0, Math.min(index, others.length))
    const before = others[at - 1]?.sort_order
    const after = others[at]?.sort_order
    const order = before === undefined ? (after === undefined ? 0 : after - 1) : after === undefined ? before + 1 : (before + after) / 2
    const renumber = order === before || order === after || !Number.isFinite(order)
    this.db.tx(() => {
      if (renumber) {
        const ids = [...others.slice(0, at).map((x) => x.id), id, ...others.slice(at).map((x) => x.id)]
        ids.forEach((sid, i) => this.db.run('UPDATE sessions SET sort_order = ? WHERE id = ?', i, sid))
      } else this.db.run('UPDATE sessions SET sort_order = ? WHERE id = ?', order, id)
    })
    if (renumber) for (const x of others) this.refresh(x.id)
    this.refresh(id)
    return { ok: true }
  }

  /** The composer's draft, base = this session's branch, its isolation for this draft only. */
  async duplicate(id: string): Promise<{ draft: ComposerDraft }> {
    const r = this.row(id)
    const p = this.project(r.project_id)
    const cfg = this.launchConfig(r)
    const { prompt, ...config } = cfg
    const agent = r.agent === SHELL_AGENT ? (this.launchExtras(r).requestedAgent ?? p.settings.lastLaunch?.agent ?? r.agent) : r.agent
    const base: BaseChoice = r.isolation === 'worktree' && r.branch ? { kind: 'ref', ref: r.branch } : { kind: 'default' }
    return { draft: { projectId: r.project_id, agent, prompt: prompt.slice(0, L.composerDraftMaxBytes), config, isolation: r.isolation, base } }
  }

  /** Recreate from branch: add a missing worktree back. */
  recreateWorktree(id: string): Promise<{ ok: boolean }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.isolation !== 'worktree') throw new RpcError('wrong_state', 'an in-place session has no worktree')
      if (fs.existsSync(r.cwd)) {
        this.missing.delete(id)
        this.refresh(id)
        return { ok: true }
      }
      await this.addBack(r)
      this.missing.delete(id)
      this.refresh(id)
      return { ok: true }
    })
  }

  /** Add a session's worktree back at its path: on its branch when it exists, else a new one at its base commit. */
  private async addBack(r: Row): Promise<void> {
    const p = this.project(r.project_id)
    const repo = await this.repo(p)
    await fs.promises.mkdir(path.dirname(r.cwd), { recursive: true })
    await pruneWorktrees(repo)
    const has = r.branch ? await branchExists(repo, p.rootPath, r.branch) : false
    if (!r.branch || (!has && !r.base_commit)) throw new RpcError('git_failed', 'the branch is gone and there is no base commit to start from')
    await addWorktree(repo, { path: r.cwd, branch: r.branch, commit: r.base_commit ?? '', existing: has })
    const copied = await this.copyFiles(p, r.cwd, r.id)
    this.logTo(r.id, `worktree added back on ${r.branch}; copied: ${copied.join(', ') || 'nothing'}`)
    if (r.creation_step === J.cleaned) this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = NULL WHERE id = ?', r.id))
  }

  retryTeardown(id: string): Promise<{ ok: boolean; teardownFailed: boolean }> {
    return this.queued(id, async () => {
      this.row(id)
      const ok = await this.runTeardown(id, 'archive')
      return { ok: true, teardownFailed: !ok }
    })
  }

  /** The setup controls: Skip, Retry and Start agent anyway. */
  async setupAction(id: string, action: 'skip' | 'retry' | 'startAnyway', grid?: Grid): Promise<{ ok: boolean }> {
    if (grid) this.grid = grid
    const st = this.setup.get(id)
    const r = this.row(id)
    if (action === 'retry') {
      if (!st || st.state === 'running') return { ok: false }
      await this.startScript(id, 'setup', st.reason)
      return { ok: true }
    }
    if (action === 'skip' && st?.state === 'running') {
      this.setup.set(id, { ...st, state: 'skipped' })
      if (st.ptyId) this.skippedSetups.add(st.ptyId)
    }
    const gate = this.setupGate.get(id)
    if (gate) {
      gate.resolve()
      this.refresh(id)
      return { ok: true }
    }
    // Start agent anyway after a failed setup that ended the pipeline's wait
    if (r.lifecycle === 'creating' && st?.state === 'failed') {
      this.setup.set(id, { ...st, state: 'skipped' })
      this.track(this.queued(id, () => this.pipeline(id, null, 'launch', false)))
      return { ok: true }
    }
    return { ok: false }
  }

  resyncFiles(id: string): Promise<{ copied: string[] }> {
    return this.queued(id, async () => {
      const r = this.row(id)
      if (r.isolation !== 'worktree' || !fs.existsSync(r.cwd)) return { copied: [] }
      const copied = await this.copyFiles(this.project(r.project_id), r.cwd, id)
      this.logTo(id, `re-synced: ${copied.join(', ') || 'nothing'}`)
      return { copied }
    })
  }

  getUi(id: string): { state: Record<string, unknown> } {
    const r = this.row(id)
    this.checkMissing(r)
    return { state: this.uiState(id) }
  }

  /** `session_ui.state` as an object; `{}` when it holds anything else. */
  private uiState(id: string): Record<string, unknown> {
    const s = this.db.get<{ state: string }>('SELECT state FROM session_ui WHERE session_id = ?', id)
    try {
      const v = JSON.parse(s?.state ?? '{}') as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /**
   * Save panel state, key by key. Each key given replaces that key's value (null removes it); the keys not given stay,
   * so a caller that writes back an older copy of the row cannot drop what another panel saved since. The `files` key
   * is the file panel's, written by `files.saveUi` alone (files/service.ts), and `color` is core's (colors.ts): given
   * here, they are left out. The cap is on what the row would hold of the other keys afterwards.
   */
  setUi(id: string, state: Record<string, unknown>): { ok: boolean } {
    this.row(id)
    this.db.tx(() => {
      const cur = this.uiState(id)
      const next: Record<string, unknown> = { ...cur }
      for (const [k, v] of Object.entries(state)) {
        if (k === FILES_UI_KEY || k === COLOR_UI_KEY) continue
        if (v === null) delete next[k]
        else next[k] = v
      }
      const { [FILES_UI_KEY]: _files, [COLOR_UI_KEY]: _color, ...own } = next
      if (Buffer.byteLength(JSON.stringify(own)) > L.sessionUiMaxBytes) throw new RpcError('invalid_args', `panel state over ${L.sessionUiMaxBytes} bytes`)
      this.db.run('UPDATE session_ui SET state = ? WHERE session_id = ?', JSON.stringify(next), id)
    })
    return { ok: true }
  }

  /** Flag (or clear) a missing worktree. No automatic action. */
  private checkMissing(r: Row): void {
    if (r.isolation !== 'worktree' || r.lifecycle === 'creating' || r.lifecycle === 'create_failed' || r.lifecycle === 'deleted' || r.creation_step === J.cleaned) return
    const gone = !fs.existsSync(r.cwd)
    if (gone === this.missing.has(r.id)) return
    if (gone) this.missing.add(r.id)
    else this.missing.delete(r.id)
    this.refresh(r.id)
  }

  // ── the bases list ─────────────────────────────────────────────────────────────────────────────

  async bases(projectId: string): Promise<{ defaultBranch: string | null; head: string | null; bare: boolean; refs: { name: string; kind: 'local' | 'remote' | 'tag'; checkedOutAt: string | null }[]; truncated: boolean }> {
    const p = this.project(projectId)
    if (!p.isGit || !(await this.o.git).usable) return { defaultBranch: null, head: null, bare: false, refs: [], truncated: false }
    const repo = await this.repo(p)
    const defaultBranch = await this.defaultBranch(p, repo)
    const head = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: p.rootPath, env: repo.env, readOnly: true, collect: true }).then((r) => (r.code === 0 ? (r.stdout ?? Buffer.alloc(0)).toString('utf8').trim() : null))) || null
    const bare = (await git(['rev-parse', '--is-bare-repository'], { cwd: p.rootPath, env: repo.env, readOnly: true, collect: true }).then((r) => (r.stdout ?? Buffer.alloc(0)).toString('utf8').trim())) === 'true'
    const out = await git(['for-each-ref', '--sort=-committerdate', `--count=${L.baseRefsMax + 1}`, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd: p.rootPath, env: repo.env, readOnly: true, collect: true })
    const names = (out.stdout ?? Buffer.alloc(0)).toString('utf8').split('\n').filter(Boolean)
    const at = await checkedOutBranches(repo).catch(() => new Map<string, string>())
    const refs = names
      .slice(0, L.baseRefsMax)
      .filter((n) => !n.endsWith('/HEAD'))
      .map((n) => {
        if (n.startsWith('refs/heads/')) {
          const name = n.slice(11)
          return { name, kind: 'local' as const, checkedOutAt: at.get(name) ?? null }
        }
        if (n.startsWith('refs/remotes/')) return { name: n.slice(13), kind: 'remote' as const, checkedOutAt: null }
        return { name: n.slice(10), kind: 'tag' as const, checkedOutAt: null }
      })
    // a bare repository's HEAD names its default branch, not a checkout: it is no base, and none is offered
    return { defaultBranch, head: bare ? null : head, bare, refs, truncated: names.length > L.baseRefsMax }
  }

  /**
   * With the main checkout on no commit, whether the default base still names one: the default branch exists, or the
   * project has a remote, fetched only at creation. A HEAD base has none.
   */
  private async defaultBaseExists(p: Project, kind: 'default' | 'head'): Promise<boolean> {
    if (kind === 'head') return false
    const repo = await this.repo(p)
    if (await hasRemote(repo, 'origin')) return true
    const d = await this.defaultBranch(p, repo)
    return d !== null && (await branchExists(repo, p.rootPath, d))
  }

  /** The project's default branch: the override, else detection, cached on the project. */
  private async defaultBranch(p: Project, repo: Repo): Promise<string | null> {
    if (p.settings.baseBranch) return p.settings.baseBranch
    if (p.defaultBranch && (await branchExists(repo, p.rootPath, p.defaultBranch).catch(() => false))) return p.defaultBranch
    const d = await detectDefaultBranch(repo).catch(() => null)
    if (d && d !== p.defaultBranch) this.o.projects.setDefaultBranch(p.id, d)
    return d
  }

  // ── setup and teardown ───────────────────────────────────────────────────────────────────────────

  /** Start the setup script in a `Setup` tab (kind `script`); false when the project has none. */
  private async startScript(id: string, kind: 'setup', reason: SetupState['reason']): Promise<boolean> {
    const r = this.row(id)
    if (r.isolation !== 'worktree') return false
    const p = this.project(r.project_id)
    const env = await this.ptyEnv(r, { kind: 'setup', reason })
    const cmd = scriptCommand(kind, p.settings, [r.cwd, p.rootPath], { ...(await this.o.env()), ...env })
    if (!cmd) return false
    this.logTo(id, `setup (${reason}): ${cmd.label}`)
    const { ptyId } = await this.o.terminals.launch({ sessionId: id, kind: 'script', title: 'Setup', command: { argv: cmd.argv }, cwd: r.cwd, cols: this.grid.cols, rows: this.grid.rows, env })
    const cur = this.setup.get(id)
    if (!cur || cur.ptyId !== ptyId || cur.state === 'running') this.setup.set(id, { state: 'running', ptyId, exitCode: null, reason })
    // the exit may have come while launch was finishing
    const rec = this.o.terminals.record(ptyId)
    if (rec && rec.state !== 'running') this.onExit({ ptyId, sessionId: id, kind: 'script', state: rec.state === 'lost' ? 'lost' : 'exited', exitCode: rec.exitCode, exitSignal: rec.exitSignal })
    this.refresh(id)
    return true
  }

  /**
   * The teardown script, after every other PTY of the session has exited, in a holder (kind `script`, never a tab), at
   * most L.teardownTimeoutMs, then its tree is terminated with L.teardownGraceMs. True when it ran and exited 0, or
   * there is none. Never throws.
   */
  private async runTeardown(id: string, reason: 'archive' | 'delete'): Promise<boolean> {
    this.tearingDown.add(id)
    try {
      const r = this.row(id)
      if (r.isolation !== 'worktree') return true
      const p = this.project(r.project_id)
      const dirs = fs.existsSync(r.cwd) ? [r.cwd, p.rootPath] : [p.rootPath]
      const env = await this.ptyEnv(r, { kind: 'teardown', reason })
      const cmd = scriptCommand('teardown', p.settings, dirs, { ...(await this.o.env()), ...env })
      if (!cmd) {
        this.teardownFailed.delete(id)
        return true
      }
      this.logTo(id, `teardown (${reason}): ${cmd.label}`)
      const cwd = fs.existsSync(r.cwd) ? r.cwd : p.rootPath
      // marked as this session's teardown before its record exists: a core that goes at any point from here leaves
      // either a mark with no record (the next sweep drops it) or a record the next core knows for what it is
      const ptyId = newPtyId()
      kvSet(this.db, `${TEARDOWN_KV}${ptyId}`, id)
      await this.o.terminals.launch({ ptyId, sessionId: id, kind: 'script', title: TEARDOWN_TITLE, command: { argv: cmd.argv }, cwd, cols: this.grid.cols, rows: this.grid.rows, env })
      const limit = this.o.teardownTimeoutMs ?? L.teardownTimeoutMs
      let done = await this.o.terminals.waitExit(ptyId, limit)
      if (!done) {
        this.logTo(id, `teardown timed out after ${limit} ms; terminated`)
        done = await this.o.terminals.stop(ptyId, 'terminate', L.teardownGraceMs)
      }
      await this.captureToLog(id, ptyId, 'teardown')
      const rec = this.o.terminals.record(ptyId)
      const ok = done && rec?.state === 'exited' && rec.exitCode === 0 && rec.exitSignal === null
      await this.o.terminals.stop(ptyId, 'terminate', 0).catch(() => false)
      // never a tab, and its output is in the log: nothing reads its ring or checkpoint again. A holder that could not
      // be released now (it would not die in time, or ptyhost is away) keeps its record: `onExit` or the next
      // reconciliation ends it (`endTeardownTerminal`)
      await this.o.terminals.forgetRecord(ptyId, { files: true })
      this.logTo(id, `teardown ${ok ? 'finished' : `failed (exit ${rec?.exitCode ?? rec?.exitSignal ?? 'timeout'})`}`)
      if (ok) this.teardownFailed.delete(id)
      else this.teardownFailed.add(id)
      this.refresh(id)
      return ok
    } catch (e) {
      this.log.warn('teardown did not run', { sessionId: id, error: String(e) })
      this.teardownFailed.add(id)
      this.refresh(id)
      return false
    } finally {
      this.tearingDown.delete(id)
      // this run's mark goes with its record; and one that ended while this run had the session (an earlier run's,
      // left running): nobody else will end it
      this.sweepTeardowns(id)
    }
  }

  /**
   * A teardown's terminal is never a tab, so once it has ended and its output is in the session log nothing reads its
   * ring, checkpoint or state file again: they go with its record. `runTeardown` does that for the terminal it waits
   * on. This is for one that outlived its run: its script would not die within the grace, ptyhost was away when its
   * holder was to be released, or core went while it ran (the next core finds its record, and its mark in `kv`). Called
   * when such a terminal ends, and after every reconciliation for those that have ended (I-WT-34). One still running is
   * left to end by itself: nothing waits for it, and Settings › Advanced lists it.
   *
   * Its output is read while its holder is still held, and written to the log only once the record has gone, so a
   * terminal that could not be forgotten yet (its holder was not released; before the first reconciliation core does
   * not know which holders exist: `Terminals.forgetRecord` keeps the record then) is logged once, by the call that
   * ends it.
   */
  private endTeardownTerminal(sessionId: string, ptyId: string): Promise<void> {
    return this.queued(sessionId, async () => {
      const rec = this.o.terminals.record(ptyId)
      if (!rec) {
        // its record went before this turn came (a delete, whose turn this waited behind, forgot it with its session):
        // its mark goes too, as the sweep drops one, unless a run of the session's teardown is under way (a run's mark
        // is written before its record exists)
        if (!this.tearingDown.has(sessionId)) kvDelete(this.db, `${TEARDOWN_KV}${ptyId}`)
        return
      }
      if (rec.state === 'running' || this.tearingDown.has(sessionId)) return
      const screen = await this.o.terminals.captureScreen(ptyId).catch(() => null)
      await this.o.terminals.forgetRecord(ptyId, { files: true })
      if (this.o.terminals.record(ptyId)) return // kept: the next reconciliation's sweep comes back for it
      kvDelete(this.db, `${TEARDOWN_KV}${ptyId}`)
      // the log lives in the session's state directory, which a deleted session no longer has (never made again here)
      const r = this.db.get<Row>(GET, sessionId)
      if (!r || r.lifecycle === 'deleted' || !fs.existsSync(path.join(this.o.home, 'sessions', sessionId))) return
      const text = screen?.replace(/\s+$/g, '')
      if (text) this.logTo(sessionId, `teardown output:\n${text}`)
      this.logTo(sessionId, `teardown ended after Kea stopped waiting for it (exit ${rec.exitCode ?? rec.exitSignal ?? rec.state})`)
    })
  }

  /**
   * Every teardown terminal nobody waits for (of one session, or of all), by its mark: one that has ended is ended as
   * above; a mark whose record has gone (forgotten by `runTeardown`, or deleted with its session) goes too.
   */
  private sweepTeardowns(sessionId?: string): void {
    for (const m of this.db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE key LIKE '${TEARDOWN_KV}%'`)) {
      if (this.tearingDown.has(m.value) || (sessionId !== undefined && m.value !== sessionId)) continue
      const ptyId = m.key.slice(TEARDOWN_KV.length)
      const rec = this.o.terminals.record(ptyId)
      if (!rec) kvDelete(this.db, m.key)
      else if (rec.state !== 'running') this.track(this.endTeardownTerminal(m.value, ptyId))
    }
  }

  private async captureToLog(id: string, ptyId: string, what: string): Promise<void> {
    const screen = await this.o.terminals.captureScreen(ptyId).catch(() => null)
    const text = screen?.replace(/\s+$/g, '')
    if (text) this.logTo(id, `${what} output:\n${text}`)
  }

  /** The rebuildable folders at the root and one level below, after setup and on archive. */
  private async excludeBackups(id: string): Promise<void> {
    try {
      // no backup to keep them out of (Linux): the folders are not even looked for
      if (!backupsExcludable() || !this.o.settings.values.get<boolean>('general.excludeBuildDirsFromBackup')) return
      const r = this.row(id)
      if (r.isolation !== 'worktree' || !fs.existsSync(r.cwd)) return
      const p = this.project(r.project_id)
      const targets = await backupTargets(r.cwd, p.settings.rebuildableDirs, await this.gitEnv())
      const n = await excludeFromBackup(r.cwd, targets, this.log)
      if (n) this.logTo(id, `excluded from Time Machine: ${targets.join(', ')}`)
    } catch (e) {
      this.log.warn('Time Machine exclusion skipped', { sessionId: id, error: String(e) })
    }
  }

  /** Stop every PTY of the session: the agent as Stop ends it, shells as closed tabs, scripts ended. */
  private async stopAll(id: string, forQuit = false): Promise<void> {
    const recs = this.o.terminals.sessionRecords(id).filter((r) => r.state === 'running')
    if (recs.some((r) => r.kind === 'agent')) this.stopping.add(id)
    const row = this.row(id)
    await Promise.all(
      recs.map((r) =>
        // a quit terminates shells (and the `shell` pseudo-agent) too: a hangup leaves a `nohup` or disowned job running
        r.kind === 'agent' && !(forQuit && row.agent === SHELL_AGENT)
          ? this.stopAgent(row, r.ptyId)
          : this.o.terminals.stop(r.ptyId, r.kind === 'shell' && !forQuit ? 'hangup' : 'terminate', r.kind === 'shell' && !forQuit ? L.shellCloseGraceMs : L.stopGraceMs),
      ),
    )
    const left = this.o.terminals.sessionRecords(id).filter((r) => r.state === 'running')
    if (left.length) throw new RpcError('refused', `${left.length} terminal(s) of the session could not be stopped`)
    const r = this.row(id)
    if (r.lifecycle === 'live') {
      this.stopping.delete(id)
      this.transition(id, 'agentEnded', () => {
        this.db.run(`UPDATE sessions SET end_reason = coalesce(end_reason, 'stopped') WHERE id = ?`, id)
        this.db.run(noRuntime, id)
      })
    }
  }

  /**
   * An archived session keeps only its checkpoints (and its creation log, which View log reads). Its PTYs have ended
   * (archive stopped them): each agent, script or server PTY's last screen is folded into its checkpoint at its ring's
   * end, then its ring and state file go, so the last screen still shows; an ended shell's tab closes, so shells are
   * forgotten with their files. A PTY whose ring could not be folded keeps it.
   */
  private async keepCheckpointsOnly(id: string): Promise<void> {
    const t = this.o.terminals
    for (const rec of t.sessionRecords(id)) {
      if (rec.state === 'running') continue
      try {
        if (rec.kind === 'shell') await t.forgetRecord(rec.ptyId, { files: true })
        // its holder goes first (an exit's release may still be on its way), so nothing writes the files after the fold
        else if ((await t.releaseEnded(rec.ptyId)) && (await t.foldCheckpoint(rec.ptyId))) this.removePtyFiles(id, rec.ptyId, ['ring', 'json'])
      } catch (e) {
        this.log.warn('archived session keeps more than its checkpoints: its terminal files were not trimmed', { sessionId: id, ptyId: rec.ptyId, error: String(e) })
      }
    }
  }

  /** Remove some of one PTY's files in the session's state directory (regular files only). */
  private removePtyFiles(id: string, ptyId: string, exts: readonly ('ring' | 'json' | 'ckpt')[]): void {
    for (const x of exts) {
      const f = path.join(this.o.home, 'sessions', id, `${ptyId}.${x}`)
      try {
        if (fs.lstatSync(f).isFile()) fs.unlinkSync(f)
      } catch {
        // not there
      }
    }
  }

  /**
   * Stop All and Quit ("On quit: stop all sessions"): every session with a running PTY has them all stopped as archive
   * stops them (agents as Stop does, so live sessions end `detached`, `stopped`; shells are terminated, not hung up).
   * A session being created has its setup script stopped, and its creation offers Retry at the next launch. The shell
   * tabs outside any session are stopped too, and no terminal starts meanwhile.
   */
  async stopEverything(): Promise<void> {
    this.o.terminals.refuseLaunches()
    const ids = this.db.all<{ id: string }>(`SELECT id FROM sessions WHERE lifecycle IN ('live', 'detached')`).map((r) => r.id)
    const running = ids.filter((id) => this.o.terminals.sessionRecords(id).some((r) => r.state === 'running'))
    await Promise.all(running.map((id) => this.queued(id, () => this.stopAll(id, true)).catch((e) => this.log.warn('session not stopped (Stop All and Quit)', { sessionId: id, error: String(e) }))))
    // what is left: a session being created (its setup script), an archived or failed one, the shell tabs outside any session
    await this.o.terminals.stopAllForQuit(L.stopGraceMs)
  }

  // ── launch-time work ────────────────────────────────────────────────────────────────────────────

  /**
   * After the rebuild: interrupted creations, deletes and restores converge; each git project is reconciled; the purge
   * after the retention and auto-clean run, then again every L.autoCleanIntervalMs.
   */
  async start(): Promise<void> {
    await this.o.faults?.('launch', '')
    for (const r of this.db.all<Row>(LIST)) {
      if (!this.interrupted.delete(r.id)) continue
      try {
        if (r.lifecycle === 'creating') {
          this.creation.set(r.id, { ...this.creationFromJournal(r), error: `Kea quit during ${r.creation_step?.slice(7) ?? 'creation'}` })
          this.logTo(r.id, 'interrupted: Kea quit during the creation (Retry or Discard)')
          this.transition(r.id, 'failed')
        } else if (r.creation_step?.startsWith('delete:') && r.lifecycle !== 'deleted') {
          if (r.isolation === 'inplace' || (r.snapshot_ref && (await this.snapshotHolds(r)))) {
            this.log.info('completing an interrupted delete', { sessionId: r.id })
            await this.queued(r.id, () => this.finishDelete(r.id))
          } else {
            // before its ref, or the worktree changed since its snapshot: the session stays as it was (and a ref a kill
            // left before `snapshot_ref` was written goes too)
            await this.dropDeleteJournal(r, 'interrupted delete undone: the session is as it was')
            this.log.info('an interrupted delete left the session as it was', { sessionId: r.id })
          }
        } else if ((r.creation_step === J.restore || r.creation_step === J.restoreNew) && r.lifecycle === 'deleted') {
          await this.rollbackRestore(r)
        } else if (r.creation_step === J.clean) {
          const gone = !fs.existsSync(r.cwd)
          this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = ? WHERE id = ?', gone ? J.cleaned : null, r.id))
        }
      } catch (e) {
        this.log.warn('launch convergence failed', { sessionId: r.id, error: String(e) })
      }
    }
    this.interrupted.clear()
    if ((await this.o.git).usable) for (const p of this.o.projects.list()) if (p.isGit && !p.missing) await this.reconcileProject(p).catch((e) => this.log.warn('worktree reconciliation failed', { projectId: p.id, error: String(e) }))
    await this.emptyStaleTrash()
    await this.maintain()
    this.reload()
    if (!this.disposed && !this.timer) {
      this.timer = setInterval(() => void this.maintain().catch((e) => this.log.warn('maintenance failed', { error: String(e) })), L.autoCleanIntervalMs)
      this.timer.unref?.()
    }
  }

  /** An interrupted delete's snapshot still holds everything: the worktree is gone (moved) or exactly as snapshotted. */
  private async snapshotHolds(r: Row): Promise<boolean> {
    if (!fs.existsSync(r.cwd)) return true
    const repo = await this.repo(this.project(r.project_id))
    return matchesSnapshot(repo, { wt: r.cwd, ref: r.snapshot_ref!, sessionId: r.id, tmpDir: snapshotTmpDir(this.o.home) }).catch(() => false)
  }

  /**
   * Reconcile one project's worktrees with its sessions, comparing canonical paths (git records real paths; a root may
   * be reached through a symlink). An orphan is a linked worktree at `<root>/<project dir>/<slug>` under a usable Kea
   * root that no session owns: never the main worktree (git lists it first) or a bare entry, never a path that is or
   * holds a project root.
   */
  async reconcileProject(p: Project): Promise<void> {
    const repo = await this.repo(p)
    const sessions = this.db.all<Row>(BY_PROJECT, p.id)
    const roots = await this.roots()
    const underRoot = (c: string) => roots.find((r) => path.dirname(path.dirname(c)) === r) ?? null
    const failedPaths = new Set(sessions.filter((s) => s.lifecycle === 'create_failed' || s.lifecycle === 'creating').map((s) => canonicalPath(s.cwd)))
    // only Kea's own interrupted adds: an `initializing` entry elsewhere may be a `git worktree add` the user is running
    const unlocked = await unlockInitializing(repo, (x) => failedPaths.has(canonicalPath(x)) || !underRoot(canonicalPath(x)))
    if (unlocked.length) this.log.info('released the initializing locks an interrupted worktree add left', { projectId: p.id, paths: unlocked })
    const owned = new Set(sessions.filter((s) => s.lifecycle !== 'deleted').map((s) => canonicalPath(s.cwd)))
    const orphans: OrphanWorktree[] = []
    for (const [i, w] of (await listWorktrees(repo)).entries()) {
      if (i === 0 || w.bare) continue
      const c = canonicalPath(w.path)
      const root = underRoot(c)
      if (!root || owned.has(c) || this.holdsProject(c)) continue
      orphans.push({ path: c, root, branch: w.branch, head: w.head, locked: w.locked !== null, prunable: w.prunable !== null })
    }
    this.orphans.set(p.id, orphans)
    if (orphans.length) this.log.info('orphaned worktrees: under a Kea worktree root, with no session', { projectId: p.id, paths: orphans.map((o) => o.path) })
    for (const s of sessions) this.checkMissing(s)
  }

  /**
   * Every usable Kea worktree root, canonical: the setting's and every one recorded on a session. A root that is the
   * home folder, or is in or holds a project, is left out (rootProblem): nothing there is Kea's to list or empty.
   */
  private async roots(): Promise<string[]> {
    const set = new Set<string>([this.worktreeRoot()])
    for (const r of this.db.all<{ worktree_root: string }>('SELECT DISTINCT worktree_root FROM sessions WHERE worktree_root IS NOT NULL')) set.add(r.worktree_root)
    const out = new Set<string>()
    for (const r of set) {
      const why = await this.rootProblem(r)
      if (why) this.log.warn('worktree root not searched for orphaned worktrees', { root: r, why })
      else out.add(canonicalPath(r))
    }
    return [...out]
  }

  /** What a crash left in each root's trash; only the entries Kea moved there (ULID-named, kit's emptyTrash). */
  private async emptyStaleTrash(): Promise<void> {
    for (const r of await this.roots()) {
      const n = await emptyTrash(path.join(r, WORKTREE_TRASH)).catch(() => 0)
      if (n) this.log.info('stale trash emptied', { root: r, entries: n })
    }
  }

  /** The purge after the retention and auto-clean. */
  async maintain(): Promise<void> {
    await this.purgeExpired()
    await this.autoClean()
  }

  private retentionMs(): number {
    return this.o.settings.values.get<number>('general.deletedRetentionDays') * 86_400_000
  }

  /** How many of the project's sessions "Restore Deleted Session…" lists (the project row's `restorable`). */
  restorableCount(projectId: string): number {
    return this.db.get<{ n: number }>(`SELECT count(*) AS n FROM sessions WHERE project_id = ? AND lifecycle = 'deleted' AND deleted_at >= ?`, projectId, this.now() - this.retentionMs())?.n ?? 0
  }

  /** Deleted sessions past the retention: their snapshot refs, state directories and rows go. */
  async purgeExpired(): Promise<number> {
    const cutoff = this.now() - this.retentionMs()
    const expired = this.db.all<Row>(`${SELECT} WHERE s.lifecycle = 'deleted' AND s.deleted_at < ?`, cutoff)
    const gitUsable = (await this.o.git).usable
    for (const r of expired) {
      const p = this.o.projects.get(r.project_id)
      if (r.snapshot_ref && p?.isGit && gitUsable) await deleteRef({ env: await this.gitEnv(), root: p.rootPath }, r.snapshot_ref).catch(() => undefined)
      await this.purgeRow(r.id)
    }
    // refs whose row is gone (the database was lost) go once their snapshot is older than the retention
    if (gitUsable) {
      for (const p of this.o.projects.list()) {
        if (!p.isGit || p.missing) continue
        const repo = { env: await this.gitEnv(), root: p.rootPath }
        for (const [sid, ref] of await deletedRefs(repo).catch(() => new Map<string, string>())) {
          if (this.db.get('SELECT 1 AS x FROM sessions WHERE id = ?', sid)) continue
          const t = await git(['log', '-1', '--format=%ct', ref], { cwd: p.rootPath, env: repo.env, readOnly: true, collect: true })
          const at = Number((t.stdout ?? Buffer.alloc(0)).toString('utf8').trim()) * 1000
          if (Number.isFinite(at) && at > 0 && at < cutoff) await deleteRef(repo, ref)
        }
      }
    }
    // the projects' restorable counts: what expired since the last purge no longer counts
    for (const p of this.o.projects.list()) this.o.projects.refreshRestorable(p.id)
    if (expired.length) this.log.info('deleted sessions purged after the retention period', { sessions: expired.length })
    return expired.length
  }

  /**
   * An archived session archived longer than `general.autoCleanArchivedDays` whose worktree is clean and whose branch
   * is merged or has no commits has its worktree removed; record and branch stay. Never with uncommitted or unpushed
   * work.
   */
  async autoClean(): Promise<string[]> {
    const days = this.o.settings.values.get<number>('general.autoCleanArchivedDays')
    if (!days || !(await this.o.git).usable) return []
    const cutoff = this.now() - days * 86_400_000
    const cleaned: string[] = []
    for (const { id } of this.db.all<{ id: string }>(`SELECT id FROM sessions WHERE lifecycle = 'archived' AND isolation = 'worktree' AND archived_at < ?`, cutoff)) {
      await this.queued(id, async () => {
        // as the session is now, in its turn: an Unarchive or a delete queued before this one has run
        const r = this.db.get<Row>(GET, id)
        if (!r || r.lifecycle !== 'archived' || r.archived_at === null || r.archived_at >= cutoff) return
        if (r.creation_step !== null || !fs.existsSync(r.cwd) || !r.worktree_root) return
        const repo = await this.repo(this.project(r.project_id))
        const f = await branchFacts(repo, r.cwd, r.base_branch ?? r.base_commit)
        // nothing uncommitted; the branch adds nothing to its base, or it was squash-merged and nothing of it is unpushed;
        // a base that no longer resolves (deleted, or a rebuilt session's none) says nothing: not merged
        if (f.uncommittedFiles > 0 || !f.baseResolved) return
        if (!(f.uniqueCommits === 0 || (f.merged && f.unpushedCommits === 0))) return
        this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = ? WHERE id = ?', J.clean, r.id))
        const moved = await this.toTrash(r.cwd, r.worktree_root!)
        await pruneWorktrees(repo)
        this.db.tx(() => this.db.run('UPDATE sessions SET creation_step = ? WHERE id = ?', J.cleaned, r.id))
        this.track(emptyTrashEntry(moved).catch(() => undefined))
        this.logTo(r.id, 'auto-clean: worktree removed (archived, clean and merged); the branch and the session remain')
        cleaned.push(r.id)
      })
    }
    if (cleaned.length) this.log.info('auto-clean removed worktrees', { sessions: cleaned })
    return cleaned
  }

  // ── orphaned worktrees ────────────────────────────────────────────────────────────────────────

  /** The listed orphan at `wtPath` (canonical comparison); never a project root or a folder that holds one. */
  private orphanAt(projectId: string, wtPath: string): OrphanWorktree {
    const c = canonicalPath(wtPath)
    const o = (this.orphans.get(projectId) ?? []).find((x) => x.path === c)
    if (!o) throw new RpcError('not_found', `${wtPath} is not an orphaned worktree of this project`)
    if (this.holdsProject(c)) throw new RpcError('refused', `${wtPath} is a project's folder or holds one`)
    return o
  }

  private async adoptOrphan(projectId: string, wtPath: string): Promise<{ sessionId: string }> {
    const p = this.project(projectId)
    const o = this.orphanAt(projectId, wtPath)
    const slugBase = path.basename(wtPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'adopted'
    const slug = await uniqueSlug(slugBase, (s) => !!this.db.get('SELECT 1 AS x FROM sessions WHERE project_id = ? AND slug = ?', p.id, s))
    const id = ulid(this.now())
    const minOrder = this.db.get<{ m: number | null }>('SELECT min(sort_order) AS m FROM sessions WHERE project_id = ?', p.id)?.m
    this.db.tx(() =>
      insertSession(this.db, {
        id, projectId: p.id, slug, title: titleFromSlug(slug), titleSource: 'auto', isolation: 'worktree', cwd: o.path, worktreeRoot: o.root, branch: o.branch,
        baseBranch: p.defaultBranch, baseCommit: null, portBase: null, agent: SHELL_AGENT, agentSessionId: null, transcriptPath: null,
        launchConfig: JSON.stringify({ prompt: '' }), lifecycle: 'detached', endReason: 'stopped', deletedAt: null, snapshotRef: null, creationStep: null,
        diskBytes: null, diskAt: null, sortOrder: Math.min(-this.now(), (minOrder ?? 0) - 1), pinnedOrder: 0, createdAt: this.now(), archivedAt: null,
      }),
    )
    await this.o.ports.allocate(id)
    this.orphans.set(projectId, (this.orphans.get(projectId) ?? []).filter((x) => x.path !== o.path))
    this.refresh(id)
    return { sessionId: id }
  }

  /**
   * Remove an orphaned worktree, failing closed: uncommitted changes, or a `git status` that fails, refuse it without
   * `force`.
   */
  private async removeOrphan(projectId: string, wtPath: string, force: boolean): Promise<{ removed: boolean; dirty: number; statusFailed: boolean }> {
    const p = this.project(projectId)
    const o = this.orphanAt(projectId, wtPath)
    const repo = await this.repo(p)
    if (fs.existsSync(o.path)) {
      const dirty = await countUncommitted(repo, o.path).catch(() => null)
      if ((dirty === null || dirty > 0) && !force) return { removed: false, dirty: dirty ?? 0, statusFailed: dirty === null } // the UI lists them first
      const moved = await this.toTrash(o.path, o.root)
      this.track(emptyTrashEntry(moved).catch(() => undefined))
    }
    if (o.locked) await repo.mutex.run(repo.commonDir, () => git(['worktree', 'unlock', '--', o.path], { cwd: p.rootPath, env: repo.env, collect: true }))
    await pruneWorktrees(repo)
    this.orphans.set(projectId, (this.orphans.get(projectId) ?? []).filter((x) => x.path !== o.path))
    return { removed: true, dirty: 0, statusFailed: false }
  }

  // ── projects removal and reconciliation ─────────────────────────────────────────────────────────

  /** Why `r` keeps its project from being removed, or null: its worktree is on disk, or its creation runs or failed. */
  private blocksRemoval(r: Row): RemoveBlocker | null {
    if (r.lifecycle === 'deleted') return null
    if (r.lifecycle === 'creating') return 'creating'
    if (r.lifecycle === 'create_failed') return 'createFailed'
    return r.isolation === 'worktree' && r.creation_step !== J.cleaned && fs.existsSync(r.cwd) ? 'worktree' : null
  }

  /**
   * What keeps a project from being removed — every session with a worktree on disk (whatever its lifecycle: the user
   * deletes it, with the delete dialog's listing, or auto-clean removes it) or a creation in progress or failed
   * (Discard rolls it back) — what "Stop and remove" would stop, and how many deleted sessions are still restorable.
   */
  async projectRemoval(projectId: string): Promise<ProjectRemoval> {
    const since = this.now() - this.retentionMs()
    const out: ProjectRemoval = { blocking: [], running: [], restorable: 0 }
    for (const r of this.db.all<Row>(BY_PROJECT, projectId)) {
      if (r.lifecycle === 'deleted') {
        if ((r.deleted_at ?? 0) >= since) out.restorable++
        continue
      }
      const reason = this.blocksRemoval(r)
      if (reason) out.blocking.push({ sessionId: r.id, title: r.title, reason })
      else if (r.lifecycle === 'live' || this.o.terminals.sessionRecords(r.id).some((x) => x.state === 'running')) out.running.push({ sessionId: r.id, title: r.title })
    }
    return out
  }

  /**
   * A removed project's sessions end before its rows go. First every one is checked again and stopped, each in its own
   * queue (a session that now blocks, or whose PTYs could not be stopped, refuses the whole removal and every row
   * stays); then their records, state directories and snapshot refs go — the refs are Kea's own, and nothing else of
   * Kea's is left in the repository.
   */
  async releaseProject(projectId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.queued(id, async () => {
        const r = this.db.get<Row>(GET, id)
        if (!r) return
        const reason = this.blocksRemoval(r)
        if (reason) throw new RpcError('refused', `${r.title} keeps the project: ${reason === 'worktree' ? 'its worktree is on disk' : reason === 'creating' ? 'it is being created' : 'its creation failed (Discard it)'}`)
        await this.stopAll(id)
      })
    }
    const p = this.o.projects.get(projectId)
    const repo = p?.isGit && !p.missing && (await this.o.git).usable ? { env: await this.gitEnv(), root: p.rootPath } : null
    for (const id of ids) {
      await this.queued(id, async () => {
        if (repo) await deleteRef(repo, snapshotRef(id)).catch((e) => this.log.warn('snapshot ref not dropped', { sessionId: id, error: String(e) }))
        await this.o.terminals.forgetSession(id)
        this.removeStateDir(id)
        this.creation.delete(id)
        this.setup.delete(id)
        this.teardownFailed.delete(id)
        this.missing.delete(id)
        this.extraEnv.delete(id)
        this.o.ports.release(id)
        this.store.delete(id)
      })
    }
  }

  /** After each launch reconciliation: sessions whose agent ended while Kea was away are already detached. */
  onReconciled(_plan: ReconcilePlan): void {
    this.reload()
    // teardown terminals that ended while Kea was away, or whose holder the reconciliation has just let go
    this.sweepTeardowns()
  }

  // ── plumbing ──────────────────────────────────────────────────────────────────────────────────

  /** Move the lifecycle by the table (U-SES-3); `also` runs in the same transaction. */
  private transition(id: string, ev: LifecycleEvent['t'], also?: () => void): void {
    const r = this.row(id)
    const to = nextLifecycle(r.lifecycle, ev)
    if (!to) throw new RpcError('wrong_state', `${ev} is not possible while the session is ${r.lifecycle}`)
    this.db.tx(() => {
      this.db.run('UPDATE sessions SET lifecycle = ? WHERE id = ?', to, id)
      also?.()
      if (to !== 'live') this.db.run(`UPDATE session_runtime SET attention = '[]', background = 0 WHERE session_id = ?`, id)
      if (to !== 'detached' && to !== 'archived' && to !== 'deleted') this.db.run('UPDATE sessions SET end_reason = NULL WHERE id = ?', id)
    })
    this.refresh(id)
    // a delete or a restore changes what "Restore Deleted Session…" lists
    if (r.lifecycle === 'deleted' || to === 'deleted') this.o.projects.refreshRestorable(r.project_id)
  }

  private row(id: string): Row {
    const r = this.db.get<Row>(GET, id)
    if (!r) throw new RpcError('not_found', `no session ${id}`)
    return r
  }

  private require(id: string, allowDeleted = false): Row {
    const r = this.row(id)
    if (!allowDeleted && r.lifecycle === 'deleted') throw new RpcError('not_found', `session ${id} is deleted`)
    return r
  }

  private project(id: string): Project {
    const p = this.o.projects.get(id)
    if (!p) throw new RpcError('not_found', `no project ${id}`)
    return p
  }

  private async gitEnv(): Promise<Env> {
    const env = await this.o.env()
    this.shellHome = env.HOME ?? null
    return env
  }

  private async repo(p: Project): Promise<Repo> {
    const env = await this.gitEnv()
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: p.rootPath, env, readOnly: true, collect: true })
    const dir = common.code === 0 ? (common.stdout ?? Buffer.alloc(0)).toString('utf8').trim() : path.join(p.rootPath, '.git')
    let commonDir = dir
    try {
      commonDir = canonical(dir)
    } catch {
      // keep git's answer
    }
    return { root: p.rootPath, commonDir, env, mutex: this.o.mutex }
  }

  /**
   * Copy "Files to copy" into `wt`; an entry refused because the worktree has a symlink on its way is logged, never
   * written.
   */
  private async copyFiles(p: Project, wt: string, sessionId: string): Promise<string[]> {
    // a bare repository has no main checkout, so no untracked files to bring along
    if (p.bare) return []
    const plan = await planCopies(p.rootPath, p.settings.filesToCopy, await this.gitEnv())
    const { copied, refused } = await copyEntries(p.rootPath, wt, plan.entries)
    if (refused.length) {
      this.log.warn('files to copy not copied: a symlink on the way', { sessionId, refused })
      this.logTo(sessionId, `not copied: ${refused.map((x) => `${x.rel} (${x.why})`).join(', ')}`)
    }
    return copied
  }

  /** The session environment for the session's dev-server PTY (`PORT` set). */
  serverEnv(id: string): Promise<Env> {
    return this.ptyEnv(this.row(id), { kind: 'server' })
  }

  /** The session environment for a PTY of `r`. */
  private async ptyEnv(r: Row, purpose: EnvPurpose): Promise<Env> {
    const p = this.project(r.project_id)
    const portBase = this.db.get<{ port_base: number | null }>('SELECT port_base FROM sessions WHERE id = ?', r.id)?.port_base ?? null
    return sessionEnv(
      { id: r.id, slug: r.slug, cwd: r.cwd, branch: r.branch, baseBranch: r.base_branch, portBase, projectRoot: p.rootPath, projectSlug: this.projectDir(p), services: p.settings.services ?? 'shared' },
      purpose,
    )
  }

  private logTo(id: string, text: string): void {
    try {
      const bytes = appendLog(this.o.home, id, text, this.now())
      const c = this.creation.get(id)
      if (!c) return
      this.creation.set(id, { ...c, logBytes: bytes })
      // the pane follows the creation as it happens, its step (setStep logs each one) and its log
      this.refresh(id)
    } catch (e) {
      this.log.warn('creation log not written', { sessionId: id, error: String(e) })
    }
  }

  /**
   * The session's setup script is running and making its build folders: started and not ended, or skipped with its
   * script still going.
   */
  settingUp(id: string): boolean {
    return this.setup.get(id)?.state === 'running' || this.o.terminals.sessionRecords(id).some((x) => x.kind === 'script' && x.state === 'running')
  }

  /**
   * `fn` in the session's own turn, for a feature that changes its worktree (Remove build folders, and the prune of an
   * archived session's build folders).
   */
  exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.queued(id, fn)
  }

  /** Run `fn` after the session's earlier calls (one at a time per session). */
  private queued<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    this.queues.set(id, tail)
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id)
    })
    return run
  }

  private track(p: Promise<unknown>): void {
    const t = p.catch((e) => this.log.warn('session work failed', { error: String(e) })).finally(() => this.pending.delete(t))
    this.pending.add(t)
  }

  /** Background work done (tests: a creation's pipeline, trash emptying). */
  async idle(): Promise<void> {
    while (this.pending.size || this.queues.size) await Promise.all([...this.pending, ...this.queues.values()])
  }

  /**
   * The `core.sessions` gauge: sessions in the store; creations in progress or failed; the other per-session state
   * (setup runs and waits, teardown failures, missing worktrees, stops in progress, the composer's extra variables);
   * per-session call queues; background work in flight; orphaned worktrees listed.
   */
  get resourceCounts(): { sessions: number; creations: number; perSession: number; queues: number; pending: number; orphans: number } {
    return {
      sessions: this.store.size,
      creations: this.creation.size,
      perSession: this.setup.size + this.setupGate.size + this.setupEnding.size + this.skippedSetups.size + this.teardownFailed.size + this.missing.size + this.stopping.size + this.extraEnv.size + this.interrupted.size,
      queues: this.queues.size,
      pending: this.pending.size,
      orphans: [...this.orphans.values()].reduce((n, l) => n + l.length, 0),
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.offExit.dispose()
    for (const g of this.setupGate.values()) g.resolve()
    this.setupGate.clear()
    this.store.dispose()
  }
}
