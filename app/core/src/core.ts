// Core assembled: the database, the settings files, projects, sessions, terminals and the services built on them
// (agents, status, files, dev servers, editors, the viewer, disk, diagnostics), their stores and the renderer-facing
// API. main.ts runs it in the utilityProcess; the integration and chaos suites run the same thing under plain Node
// against a real ptyhost.
//
// Startup order: the database opens synchronously (set aside and recreated if unreadable) and the settings file is
// read, so the first subscription is answered from the database alone (P-START-2). Then, in the background, come the
// login-shell environment and git, the rebuild of sessions the holders know and the database does not, and the project
// root check. Then comes the sessions' launch work: interrupted creations and deletes converge, worktrees are
// reconciled, and the purge after the retention and the auto-clean run. The first launch reconciliation waits for the
// rebuild, so a rebuilt session's holders are attached, not listed as orphans. One RepoMutex serves projects and
// sessions.

import path from 'node:path'
import { defaultRegistry, type AdapterRegistry } from '@kea/adapters'
import { resources, setGitBinary, type Logger } from '@kea/kit'
import { coreApi, GHOSTTY_THEME, hintShownKey, RpcPeer, SimpleStoreRegistry, type Channel, type EndReason, type Handlers, type NotificationOp } from '@kea/protocol'
import { colorThemeOf } from '@kea/terminal'
import { AgentService, identifyAgent } from './agents/agents.ts'
import { HelperCopies, type RunningExecutables } from './agents/helper.ts'
import { BackupExclusions, SessionsSeen, type ExcludeWriter } from './platform/backupExclusions.ts'
import { coreOs } from './os/index.ts'
import { Banners, onceForHome, SESSION_MODE_SHOWN_KEY } from './platform/banners.ts'
import { Editors } from './editor/editors.ts'
import type { EditorHost } from './editor/host.ts'
import type { EditorLauncher } from './editor/open.ts'
import type { GitFacts } from './files/facts.ts'
import { FilesService } from './files/service.ts'
import { VisibleSet } from './platform/visible.ts'
import { Diagnostics } from './resources/diagnostics.ts'
import type { WatchService } from './platform/watch/service.ts'
import { Watcher } from './platform/watch/watcher.ts'
import { PortBlocks, portBlocksBanner, type PortProbe } from './server/ports.ts'
import { Servers, type ServersOptions } from './server/servers.ts'
import { Sessions, type AgentCommand } from './sessions/sessions.ts'
import { dbRecords, DiskService, type DiskOptions } from './worktrees/disk.ts'
import { RepoMutex } from './worktrees/mutex.ts'
import { kvGet, kvSet, openDatabase, type KeaDb, type OpenResult } from './platform/db/db.ts'
import { StatusBatch } from './platform/db/batch.ts'
import { checkInvariants } from './platform/db/invariants.ts'
import { sqliteBindingPath } from './platform/db/native.ts'
import type { Migration } from './platform/db/schema.ts'
import { Projects } from './sessions/projects.ts'
import { rebuildFromHolders, type IdentifyAgent, type RebuildResult } from './sessions/rebuild.ts'
import { detachSessions } from './sessions/rows.ts'
import { GhosttyFile } from './settings/ghostty.ts'
import { KeybindingsFile } from './settings/keybindings.ts'
import { SettingsFile } from './settings/settings.ts'
import { DbRecords, RoutedRecords } from './terminal/dbRecords.ts'
import { procsProbe, type ProcessProbe } from './terminal/procs.ts'
import type { ReconcilePlan } from './terminal/reconcile.ts'
import { FileRecords } from './terminal/records.ts'
import type { Env, ShellEnvSource } from './terminal/shellEnv.ts'
import { Terminals } from './terminal/terminals.ts'
import { StatusEngine } from './status/engine.ts'
import { NotificationPolicy } from './status/policy.ts'
import { findGit, type GitProbePaths } from './worktrees/git.ts'
import { ViewerService, type ViewerServiceOptions } from './viewer/service.ts'

export interface CoreOptions {
  home: string
  version: string
  log: Logger
  /** The login-shell environment. */
  shellEnv: { get(): Promise<Env>; reload?(): Promise<ShellEnvSource> }
  /** Holder liveness. Default: `kea-helper procs` of `helperPath`; without one no holder's pid can be told. */
  probe?: ProcessProbe
  /** Watch settings.json for external edits (default true). */
  watchSettings?: boolean
  /**
   * The Ghostty config "Match Ghostty config" reads. Default: none, so that theme is Kea Dark and no test can
   * read the user's own file; the app's core passes `~/.config/ghostty/config` (main.ts), a test a file of its own.
   */
  ghosttyConfig?: string | null
  /** A corrupt-database error at run time (main: exit, so the next open's integrity check sets the file aside). */
  onCorrupt?: (e: unknown) => void
  /** The agent of a rebuilt session, from its argv. Default: the adapters say (`identifyAgent`). */
  identifyAgent?: IdentifyAgent
  /** Use this git and skip the PATH lookup (tests). */
  gitBinary?: string
  /** The Xcode stub and `xcode-select` to judge; default the system's, and a test passes stand-ins (I-WT-19). */
  gitProbePaths?: GitProbePaths
  /** After each launch reconciliation (tests, the resource report). */
  onReconciled?(plan: ReconcilePlan): void
  /** Default: the schema's migrations; an upgrade test appends one (C-UPD-3). */
  migrations?: readonly Migration[]
  /** The port bind probe (tests inject one). */
  portProbe?: PortProbe
  /** Fault injection into the session pipelines (I-WT-3, C-KILL-9). */
  faults?: (point: string, sessionId: string) => void | Promise<void>
  /** Wall clock (tests advance it past retentions). */
  now?: () => number
  /** Git's environment (default: the login shell's). */
  gitEnv?: () => Promise<Env>
  /** How long the teardown script may run (default L.teardownTimeoutMs; tests shorten it). */
  teardownTimeoutMs?: number
  /** The per-repository mutex; a test passes its own to watch it (I-WT-2). */
  mutex?: RepoMutex
  /** The agent's command for a start, Resume or Restart: default the agent service's, from the adapters. */
  agentCommand?: AgentCommand
  /** The agent adapters: default the ones Kea ships. */
  adapters?: AdapterRegistry
  /** The kea-helper Kea ships (`--helper`): agents' hooks run a per-build copy; without it agents cannot launch. */
  helperPath?: string | null
  /**
   * What lists the executables that run as this user, for removing the kea-helper copies of earlier builds once nothing
   * runs from them (agents/helper.ts). Default: none, so nothing in `<home>/bin` is ever removed and no test lists the
   * machine's processes; the app's core passes `procsExecutables` of its helper (main.ts).
   */
  helperCopies?: RunningExecutables | null
  /**
   * What marks Kea's own folders as excluded from Time Machine (platform/backupExclusions.ts). Default: none, so no
   * test writes the attribute anywhere unless it passes a writer; the app's core passes `excludeFromBackup` on macOS
   * (main.ts), and none on Linux, which has no backup to keep them out of.
   */
  backupExclude?: ExcludeWriter | null
  /** Listen on the hook socket (default true). */
  agentIntake?: boolean
  /** Notifications for main to post or withdraw (core's main.ts sends them on parentPort). Default: none. */
  notify?: (op: NotificationOp) => void
  /**
   * The watch service. Default: the real one (`Watcher`, platform/watch); a test passes a stand-in
   * (`StubWatchService`).
   */
  watch?: WatchService
  /**
   * The git facts. Default: the files service's own; a test passes a stand-in (`StubGitFacts`), and the files service
   * then runs no status and registers no `git:` store.
   */
  gitFacts?: GitFacts
  /** What serves `editor.open`. Default: core's launcher (editor/editors.ts) with `editorHost`; a test passes one. */
  editor?: EditorLauncher
  /**
   * What the editor launcher may look at and run on this machine (editor/host.ts). Default: nothing, so every request
   * answers "unavailable" and no test can launch a real editor; the app's core passes the system's (main.ts).
   */
  editorHost?: EditorHost | null
  /**
   * The tool Discard Changes moves a file to the Trash with (files/discard.ts: macOS's `trash`, GLib's `gio` on Linux).
   * Default: none, so such a discard is refused and no test can reach the real Trash; the app's core passes the
   * system's (main.ts).
   */
  trashTool?: string | null
  /** The dev servers' clock, process runner and liveness check (tests count scans and move time). */
  server?: Partial<Pick<ServersOptions, 'clock' | 'run' | 'alive'>>
  /**
   * The viewer's clock and what opens a file with its default app in place of `editorHost`'s `open` (tests move time
   * and open nothing).
   */
  viewer?: Partial<Pick<ViewerServiceOptions, 'clock' | 'openDefault'>>
  /** The size walk's thread and its cap (tests pass a walker of their own). */
  disk?: Partial<Pick<DiskOptions, 'walker' | 'walkTimeoutMs'>>
}

export interface Core {
  readonly db: KeaDb
  readonly opened: OpenResult
  readonly settings: SettingsFile
  /** `keybindings.json`, read and followed; the `keybindings` store. */
  readonly keybindings: KeybindingsFile
  /** The user's Ghostty config, read while `terminal.theme` is `ghostty`; the `settings.ghostty` store. */
  readonly ghostty: GhosttyFile
  readonly projects: Projects
  readonly sessions: Sessions
  readonly banners: Banners
  readonly terminals: Terminals
  readonly statusBatch: StatusBatch
  /** Each live session's phase, attention set and journal; account conditions; status reports. */
  readonly status: StatusEngine
  /** Agent detection (the `agents` store), launch commands, hook intake and the signals of live agent sessions. */
  readonly agents: AgentService
  /** The notification policy (N1…N5 → main's posts and withdrawals); main tells it the window's focus. */
  readonly notifications: NotificationPolicy
  /** The session each window shows; what "visible" means everywhere in core (platform/visible.ts). */
  readonly visible: VisibleSet
  /** The one watch service (platform/watch/service.ts). */
  readonly watch: WatchService
  /** A session's scope, comparison base and status entries, for core code outside the scheduler (files/facts.ts). */
  readonly git: GitFacts
  /** The file tree, git status and the finder; `git` above unless a test passed its own facts (files/service.ts). */
  readonly files: FilesService
  /** Each session's dev server (server/servers.ts). */
  readonly servers: Servers
  /** Editor detection and launch, the terminal app, `gh pr create` (editor/editors.ts). */
  readonly editors: Editors
  /** File and diff reads for the viewer, and the one file each window follows (viewer/service.ts). */
  readonly viewer: ViewerService
  /** Worktree sizes, rebuildable folders and the prune of archived sessions; the `disk` store (worktrees/disk.ts). */
  readonly disk: DiskService
  /** Core's part of Copy Diagnostics, and the platform report main sent (resources/diagnostics.ts). */
  readonly diagnostics: Diagnostics
  /** Kea's own folders kept out of Time Machine; null without a writer (platform/backupExclusions.ts). */
  readonly backupExclusions: BackupExclusions | null
  /** The sessions those exclusions know of (row `core.sessionsSeen`); null without a writer, as above. */
  readonly sessionsSeen: SessionsSeen | null
  readonly stores: SimpleStoreRegistry
  /** Git can be run (otherwise projects open as non-git, and a banner says how to fix it). */
  readonly gitReady: Promise<boolean>
  /** The rebuild of sessions the holders know and the database does not; null if it failed. */
  readonly rebuilt: Promise<RebuildResult | null>
  /** Startup work done: the rebuild (if any), the first root check and the sessions' launch work. */
  readonly started: Promise<void>
  handlers(): Handlers<typeof coreApi>
  /** Serve a window's RPC port: one connection scope. */
  serve(ch: Channel, name: string, onError?: (e: unknown) => void): RpcPeer
  /** Clean shutdown: the database is closed (its open marker cleared). */
  dispose(): void
}

export function createCore(o: CoreOptions): Core {
  const { log, home } = o
  const opened = openDatabase({ file: path.join(home, 'kea.db'), log, ...(o.onCorrupt ? { onCorrupt: o.onCorrupt } : {}), ...(o.migrations ? { migrations: o.migrations } : {}) })
  const db = opened.db
  log.info('database open', { binding: sqliteBindingPath(), fresh: opened.fresh, setAside: opened.setAside, integrityChecked: opened.integrityChecked, fromVersion: opened.fromVersion })
  for (const v of checkInvariants(db)) log.error('database invariant violated', { ...v })

  // built first, so every service below can be given them: the visible set, the watch service, the git facts and the
  // editor launcher (a test can pass its own of the last three)
  const visible = new VisibleSet(log)
  // the one watch service; every file core follows is asked of it (the settings file and the agents' files below)
  const watcher = o.watch ? null : new Watcher({ log })
  const watch: WatchService = o.watch ?? (watcher as Watcher)
  // the file tree, git status and the finder (files/service.ts). It is core's git facts unless a test passes its own;
  // its stores, sessions and projects are bound below, once they exist
  const files = new FilesService({ log, db, visible, watcher, env: () => (o.gitEnv ?? (() => o.shellEnv.get()))(), facts: !o.gitFacts, trashTool: o.trashTool ?? null })
  const git: GitFacts = o.gitFacts ?? files
  // editors, the terminal app and `gh`; sessions, projects and the default-editor setting are bound below
  const editors = new Editors({ log, host: o.editorHost ?? null, env: () => o.shellEnv.get() })
  const editor: EditorLauncher = o.editor ?? editors

  const registry = o.adapters ?? defaultRegistry()
  const settings = new SettingsFile({ home, log, watch: o.watchSettings !== false, watcher: watch, agents: registry.settingsExtensions() })
  // "Match Ghostty config" follows the file only while that theme is chosen. Before the terminals are built, so
  // a change of theme has the file read by the time they ask for the mirror's colours
  const ghostty = new GhosttyFile({ path: o.ghosttyConfig ?? null, log, ...(o.watchSettings !== false ? { watcher: watch } : {}) })
  const followGhostty = () => ghostty.follow(settings.values.get('terminal.theme') === GHOSTTY_THEME)
  settings.onChange(followGhostty)
  followGhostty()
  // keybindings.json, followed as settings.json is
  const keybindings = new KeybindingsFile({ home, log, watch: o.watchSettings !== false, watcher: watch })
  const banners = new Banners(o.now)
  // inotify's limits met by the watch service
  watcher?.bindBanners(banners)

  const gitState: Promise<{ usable: boolean; missing: string | null }> = (async () => {
    if (o.gitBinary) {
      setGitBinary(o.gitBinary)
      return { usable: true, missing: null }
    }
    const env = await o.shellEnv.get()
    const g = await findGit(env.PATH, o.gitProbePaths)
    if (g.binary) {
      setGitBinary(g.binary)
      log.info('git', { binary: g.binary })
      return { usable: true, missing: null }
    }
    log.warn('git unavailable: projects open as non-git', { why: g.missing })
    return { usable: false, missing: g.missing }
  })().catch((e) => {
    log.warn('git lookup failed: projects open as non-git', { error: String(e) })
    return { usable: false, missing: `git could not be found: ${String(e)}` }
  })
  const gitReady = gitState.then((g) => g.usable)
  // The banner says how to fix it
  void gitState.then((g) => {
    if (!g.usable) banners.set({ kind: 'gitMissing', source: 'git', severity: 'warning', message: 'Git is not available: projects open without worktrees or the git views.', fix: g.missing })
  })

  // Which holders are alive, asked of the helper Kea ships
  const probe = o.probe ?? procsProbe(o.helperPath ?? null)
  const rebuilt: Promise<RebuildResult | null> = rebuildFromHolders({
    home,
    db,
    log,
    gitUsable: () => gitReady,
    probe,
    identifyAgent: o.identifyAgent ?? ((argv) => identifyAgent(registry, argv)),
  }).catch((e) => {
    log.error('rebuild from the holders failed', { error: String(e) })
    return null
  })

  let sessionsRef: Sessions | null = null
  let serversRef: Servers | null = null
  let diskRef: DiskService | null = null
  let helperCopiesRef: HelperCopies | null = null
  // a folder kept out of Time Machine that its maker made mid-run (a worktree root's trash, reports/)
  // is looked at as it is made; the exclusions are built below, and startup's own look comes after them
  let backupsRef: BackupExclusions | null = null
  const folderMade = (): void => void backupsRef?.look()
  const records = new RoutedRecords(FileRecords.open(home, log), new DbRecords(db), log)
  const terminals: Terminals = new Terminals({
    version: o.version,
    log,
    env: () => o.shellEnv.get(),
    ...(o.shellEnv.reload ? { reloadEnv: () => o.shellEnv.reload!() } : {}),
    home,
    records,
    probe,
    ready: rebuilt,
    visible, // the shell tabs of a session on screen are titled with their foreground process
    settings: {
      mirror: () => {
        const theme = settings.values.get<string>('terminal.theme')
        // The mirror answers colour and colour-scheme queries from the theme in force, the Ghostty config's included
        return { theme, colors: colorThemeOf(theme, ghostty.config), scrollback: settings.values.get('terminal.scrollback'), diskBackedScrollback: settings.values.get('terminal.diskBackedScrollback') }
      },
      ringBytes: () => settings.values.get('terminal.ringBytes'),
      onChange: (cb) => {
        // a settings change, and a change of the Ghostty config the theme follows
        const offs = [settings.onChange(cb), ghostty.onChange(cb)]
        return () => {
          for (const off of offs) off()
        }
      },
    },
    onBanner: (b) => {
      // The session-mode banner once per KEA_HOME, the first time a ptyhost reports it
      if (b.kind === 'sessionMode' && !onceForHome({ get: (k) => kvGet(db, k), set: (k, v) => kvSet(db, k, v) }, SESSION_MODE_SHOWN_KEY, (o.now ?? Date.now)())) return
      banners.set({ kind: b.kind, source: 'ptyhost', severity: b.kind === 'helperMissing' ? 'error' : 'warning', message: b.message, fix: null })
    },
    onBannerCleared: (kind) => banners.clear(kind),
    onConnect: () => banners.clearSource('ptyhost'),
    // tier 3 (the adapters' `Tier3` heuristics): ptyhost's activity notes go to the agent service (built below; notes
    // come once ptyhost is connected)
    onActivity: (n) => {
      agents.activity(n)
      // a dev server's output is read when it starts or pauses
      serversRef?.activity(n)
    },
    onReconciled: (plan) => {
      // A session whose agent PTY ended while Kea was away is detached (its row says why)
      const ends = plan.ended.filter((r) => r.kind === 'agent').map((r) => ({ sessionId: r.sessionId, reason: (r.state === 'exited' ? 'exited' : 'lost') as EndReason }))
      try {
        const detached = detachSessions(db, ends)
        if (detached.length) log.info('sessions detached at reconciliation', { sessions: detached })
      } catch (e) {
        log.warn('sessions not detached', { error: String(e) })
      }
      sessionsRef?.onReconciled(plan)
      // the dev servers that run are taken up again
      serversRef?.reconciled()
      // what runs is known now, so the helper copies of earlier builds that nothing uses can go
      void helperCopiesRef?.prune()
      o.onReconciled?.(plan)
    },
  })

  const mutex = o.mutex ?? new RepoMutex()
  // git as the user runs it: the login shell's environment (their identity for "Initialise git…", sessions' git)
  const gitEnv = o.gitEnv ?? (() => o.shellEnv.get())
  const projects = new Projects({
    db,
    log,
    gitReady,
    mutex,
    gitEnv,
    // Sessions decide what blocks a removal, and end what a removal ends
    removal: (projectId) => sessions.projectRemoval(projectId),
    releaseSessions: (projectId, ids) => sessions.releaseProject(projectId, ids),
    // 0 until sessions exist (the reload below counts them)
    restorable: (projectId) => sessionsRef?.restorableCount(projectId) ?? 0,
  })
  // the sessions' port blocks, in the system's range; when fewer than L.portBlocksMin fit below Linux's ephemeral
  // ports, a banner says so once, at start
  const ports = new PortBlocks({ db, log, ...(o.portProbe ? { probe: o.portProbe } : {}) })
  const portsShort = portBlocksBanner(ports.range, coreOs.portRange.cut())
  if (portsShort) banners.set(portsShort)
  const sessions: Sessions = new Sessions({
    db,
    log,
    home,
    projects,
    terminals,
    settings,
    mutex,
    ports,
    git: gitState,
    env: gitEnv,
    ...(o.now ? { now: o.now } : {}),
    ...(o.faults ? { faults: o.faults } : {}),
    ...(o.teardownTimeoutMs !== undefined ? { teardownTimeoutMs: o.teardownTimeoutMs } : {}),
    agentCommand: o.agentCommand ?? ((s, how) => agents.command(s, how)),
    // The disk service (built below) knows whose build folders went while archived
    buildFolders: { pruned: (id) => diskRef?.pruned(id) ?? false, restored: (id) => diskRef?.restored(id) },
    folderMade,
  })
  sessionsRef = sessions
  projects.reload()

  // the sessions store re-reads the runtime rows each commit wrote (the status engine writes through the batch)
  const statusBatch = new StatusBatch(db, {
    onError: (e) => log.error('status batch not written', { error: String(e) }),
    onCommit: (ids) => {
      for (const id of ids) sessions.refresh(id)
    },
  })
  // the agent service is built after the engine it feeds, and drains the spools of restored sessions into the engine
  // while it is being built: what the engine asks of it then goes through this, null until the service stands
  let agentsRef: AgentService | null = null
  const status = new StatusEngine({
    db,
    batch: statusBatch,
    log,
    sessions: sessions.store,
    projects,
    projectChanged: () => projects.reload(),
    home,
    version: o.version,
    ...(o.now ? { now: o.now } : {}),
    // The adapters say which agents hold their hooks back until the folder is trusted, and a launch that can
    // report nothing (Command Code without its mod) gets no trust window: nothing could end it. A restored session's
    // launch is not a silent one's question any more (it gets no window), so before the service stands the adapter answers
    trustGated: (agent, id) => (agentsRef?.silentLaunch(id) ? false : (registry.get(agent)?.trustGated ?? false)),
    // The spawn is placed at the agent's launch, so hooks it fires before the session turns live follow it
    launchedAt: (id) => agentsRef?.launchedAt(id) ?? null,
    report: {
      cliVersion: (agent) => agents.cliVersion(agent),
      statusFile: (id) => agents.statusFilePath(id),
      agentPty: (id) => terminals.sessionRecords(id).filter((r) => r.kind === 'agent').at(-1)?.ptyId ?? null,
      screen: (ptyId) => terminals.captureScreen(ptyId),
      resources: () => resources.report(),
      // The platform report main sent, scrubbed as Copy Diagnostics' text is (Diagnostics is made below; asked
      // only when a report is written)
      platform: () => diagnostics.scrubbedPlatform(),
      folderMade,
    },
    // Continue all types into the agent and presses Enter, only from the footer's click
    input: (id, text) => terminals.sendText(id, text, { submit: true }),
  })

  // the engine's notices become main's notifications
  const notifications = new NotificationPolicy({
    notices: (cb) => status.notices.event(cb),
    sessions: sessions.store,
    conditions: status.conditions.store,
    projectName: (id) => projects.get(id)?.name ?? null,
    // the agents store names every agent, the `shell` pseudo-agent included (it is built below; notices come later)
    agentName: (agent) => agentsRef?.store.get(agent)?.displayName ?? registry.get(agent)?.displayName ?? agent,
    settings: () => ({
      needsYou: settings.values.get('notifications.needsYou'),
      finished: settings.values.get('notifications.finished'),
      failed: settings.values.get('notifications.failed'),
      sound: settings.values.get('notifications.sound'),
      onlyWhenUnfocused: settings.values.get('notifications.onlyWhenUnfocused'),
    }),
    viewing: () => status.viewingId,
    exitOf: (id) => {
      const r = terminals.sessionRecords(id).filter((x) => x.kind === 'agent').at(-1)
      return r ? { code: r.exitCode, signal: r.exitSignal } : null
    },
    out: (op) => o.notify?.(op),
  })

  // detection, the hook socket, the spools and the signals of live agent sessions
  const agents: AgentService = new AgentService({
    home,
    version: o.version,
    log,
    db,
    registry,
    settings,
    env: () => o.shellEnv.get(),
    helperSource: o.helperPath ?? null,
    sessions: sessions.store,
    terminals: terminals.store,
    runningArgvs: () => terminals.runningArgvs(),
    status,
    batch: statusBatch,
    watch,
    ...(o.agentIntake === false ? { intake: false } : {}),
    ...(o.now ? { now: o.now } : {}),
  })
  agentsRef = agents
  void agents.start().catch((e) => log.warn('agent service start failed', { error: String(e) }))

  // an earlier build's kea-helper copy goes once nothing runs from it. Looked at after each launch reconciliation
  // (above) and when a terminal has ended or gone
  // (the copy the agents' hooks were last handed is kept too: a launch it went to may have no terminal yet, U-HLD-16)
  const helperCopies = o.helperCopies ? new HelperCopies({ home, version: o.version, source: o.helperPath ?? null, executables: o.helperCopies, argvs: () => terminals.runningArgvs(), helperPaths: (argv) => registry.helperPaths(argv), handedOut: () => agents.hookHelperPath(), log }) : null
  helperCopiesRef = helperCopies
  const offHelperCopies = helperCopies
    ? terminals.store.onDelta((d) => {
        if (d.del?.length || Object.values(d.set ?? {}).some((v) => v.state !== 'running')) void helperCopies.prune()
      })
    : null

  // worktree sizes and build folders. It follows the sessions only once the launch work is done (below), so nothing
  // of it stands between a launch and the first window
  const disk = new DiskService({
    home,
    log,
    records: dbRecords(db),
    sessions,
    projects,
    pruneDays: () => settings.values.get<number>('general.pruneArchivedBuildDirsDays'),
    onSettings: (cb) => settings.onChange(cb),
    visible,
    env: gitEnv,
    ...(o.now ? { now: o.now } : {}),
    ...o.disk,
    folderMade,
  })
  diskRef = disk

  // Kea's own folders stay out of Time Machine. Looked at once startup has settled (below), then whenever a folder may
  // have appeared, and only then: the worktree root moved (settings), a session was made or deleted (its trash), the
  // first terminal started (`sessions/` and `bin/` appear with it), and a folder's maker made it (a worktree root's
  // trash by a removal, an orphan's Remove or auto-clean; reports/ by the first report: `folderMade`)
  const backupExclusions = o.backupExclude
    ? new BackupExclusions({
        home,
        db,
        log,
        write: o.backupExclude,
        roots: () => [
          settings.values.get<string | null>('general.worktreeRoot') ?? path.join(home, 'worktrees'),
          ...db.all<{ worktree_root: string }>('SELECT DISTINCT worktree_root FROM sessions WHERE worktree_root IS NOT NULL').map((r) => r.worktree_root),
        ],
      })
    : null
  backupsRef = backupExclusions
  const lookAtBackups = () => void backupExclusions?.look()
  // a session new to the store or gone from it; a row that only changed (its status, with every hook) makes no folder
  const sessionsSeen = new SessionsSeen(sessions.store.keys())
  const offBackups = backupExclusions
    ? [
        settings.onChange(lookAtBackups),
        sessions.store.onDelta((d) => {
          if (sessionsSeen.changed(d)) lookAtBackups()
        }),
        terminals.store.onDelta(() => {
          if (backupExclusions.awaitsFirstTerminal) lookAtBackups()
        }),
      ]
    : []

  const started = rebuilt
    .then(async (r) => {
      if (r?.sessions) {
        projects.reload()
        sessions.reload()
      }
      await projects.checkRoots()
      await sessions.start()
      disk.start()
    })
    .catch((e) => log.warn('startup project check failed', { error: String(e) }))
    .then(lookAtBackups)
  // One summary at most of what changed while Kea was closed, once startup has settled
  notifications.settleAfter(started)

  const stores = new SimpleStoreRegistry()
  stores.add(terminals.store)
  stores.add(terminals.orphans)
  stores.add(projects.store)
  stores.add(sessions.store)
  stores.add(banners.store)
  stores.add(settings.store)
  stores.add(settings.statusStore)
  stores.add(keybindings.store)
  stores.add(ghostty.store)
  stores.add(status.store)
  stores.add(status.conditions.store)
  stores.add(agents.store)
  stores.add(disk.store)

  // the dev servers; their `server:<sessionId>` stores come and go with the visible set
  const servers = new Servers({ db, log, terminals, sessions, projects, visible, watch, stores, env: () => o.shellEnv.get(), helperPath: o.helperPath ?? null, ...o.server })
  serversRef = servers
  editors.bind({ sessions, projects, configured: () => settings.values.get('general.defaultEditor'), terminalApp: () => settings.values.get('general.terminalApp') })

  // `tree:<sessionId>` and `git:<sessionId>` come and go with the visible set; a finished tool may have written files,
  // so the files service hears of each one
  files.bind({
    sessions: sessions.store,
    projects: projects.store,
    stores,
    gitUsable: gitReady,
    // the composer's Worktree switch follows a folder made a repository in a session's terminal, without a focus
    repository: () => void projects.checkRoots().catch((e: unknown) => log.warn('project root check failed', { error: String(e) })),
  })
  const toolFinished = status.toolFinished.event((id) => files.toolFinished(id))

  // the viewer reads a visible session's files and follows the one each window has open. "Open with default app" runs
  // the editor host's `open`: none without a host, and the harness's own under a test
  const viewer = new ViewerService({ log, cwd: (id) => sessions.store.get(id)?.cwd ?? null, visible, watch, git, gitEnv, openTool: o.editorHost?.open ?? null, ...o.viewer })

  // core's part of "Copy diagnostics". It reads states, ids and the processes' logs: never a title, a
  // prompt or a screen
  let gitUsable: boolean | null = null
  void gitReady.then((ok) => (gitUsable = ok))
  const diagnostics = new Diagnostics({
    home,
    version: o.version,
    log,
    ...(o.now ? { now: o.now } : {}),
    database: { fresh: opened.fresh, setAside: opened.setAside !== null, fromVersion: opened.fromVersion },
    git: () => gitUsable,
    agents: () => [...agents.store.values()],
    sessions: () => [...sessions.store.values()],
    terminals: () => [...terminals.store.values()],
    holders: () => terminals.holders(),
    banners: () => [...banners.store.values()],
    conditions: () => [...status.conditions.store.values()],
    // what a text without paths must not name: every project, every session's folder and the folder worktrees are made in
    roots: () => {
      const wt = settings.values.get<string | null>('general.worktreeRoot')
      const cwds = [...sessions.store.values()].flatMap((s) => (s.isolation === 'worktree' ? [s.cwd, path.dirname(path.dirname(s.cwd))] : [s.cwd]))
      return [...[...projects.store.values()].map((p) => p.rootPath), ...cwds, ...(wt ? [wt] : [])]
    },
    // a branch Kea made is a title's slug: git's errors quote it
    names: () => [...sessions.store.values()].flatMap((s) => (s.isolation === 'worktree' && s.branch ? [s.branch] : [])),
  })

  const handlers = (): Handlers<typeof coreApi> => ({
    ...terminals.handlers(),
    ...projects.handlers(),
    ...sessions.handlers(),
    ...settings.handlers(),
    ...keybindings.handlers(),
    ...status.handlers(),
    ...agents.handlers(),
    ...servers.handlers(),
    ...viewer.handlers(),
    ...files.handlers(),
    ...diagnostics.handlers(),
    ...disk.handlers(),
    // a window's one-time hint, once per KEA_HOME, kept with the banners' own
    'hints.once': ({ hint }) => ({ show: onceForHome({ get: (k) => kvGet(db, k), set: (k, v) => kvSet(db, k, v) }, hintShownKey(hint), (o.now ?? Date.now)()) }),
    // the window's connection scope (its peer) carries the session it shows
    'visible.set': ({ sessionId }, { peer }) => {
      visible.set(peer, sessionId)
      return { ok: true }
    },
    ...editors.handlers(editor),
  })
  let disposed = false

  return {
    db,
    opened,
    settings,
    keybindings,
    ghostty,
    projects,
    sessions,
    banners,
    terminals,
    statusBatch,
    status,
    agents,
    notifications,
    visible,
    watch,
    git,
    files,
    servers,
    editors,
    viewer,
    disk,
    diagnostics,
    backupExclusions,
    sessionsSeen: backupExclusions ? sessionsSeen : null,
    stores,
    gitReady,
    rebuilt,
    started,
    handlers,
    serve: (ch, name, onError) => {
      const peer = new RpcPeer(ch, { name, api: coreApi, handlers: handlers(), stores, ...(onError ? { onError } : {}) })
      // A window that goes shows nothing (the peer is disposed with its channel)
      ch.onClose(() => visible.drop(peer))
      ch.onClose(() => terminals.windowGone(peer)) // and none of its terminals (the shells pane is on screen only while a window shows it)
      // Sizes are measured on a schedule only while a window is open
      disk.window(1)
      ch.onClose(() => disk.window(-1))
      return peer
    },
    dispose() {
      if (disposed) return
      disposed = true
      disk.dispose()
      viewer.dispose()
      toolFinished.dispose()
      files.dispose()
      servers.dispose()
      editors.dispose()
      offHelperCopies?.()
      helperCopies?.dispose()
      for (const off of offBackups) off()
      backupExclusions?.dispose()
      agents.dispose()
      notifications.dispose()
      status.dispose()
      statusBatch.dispose()
      sessions.dispose()
      terminals.dispose()
      projects.dispose()
      banners.dispose()
      settings.dispose()
      keybindings.dispose()
      ghostty.dispose()
      watcher?.dispose()
      db.close()
    },
  }
}
