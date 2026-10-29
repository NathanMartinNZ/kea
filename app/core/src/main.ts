// core entry: an Electron utilityProcess. It takes `<KEA_HOME>/run/core.lock`, answers main's heartbeat and
// resource-report requests, serves each window's RPC port (one connection scope per window) and drives ptyhost over the
// control port. What it serves is assembled in core.ts (`createCore`).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger, resources, tryLock } from '@kea/kit'
import { buildMismatch, fromElectronPort, isMainToChild, L, need, parseChildArgv, type ChildToMain, type RpcPeer } from '@kea/protocol'
import { procsExecutables } from './agents/helper.ts'
import { createCore } from './core.ts'
import { sandboxEditorHost, systemEditorHost } from './editor/host.ts'
import { trashToolFor } from './files/discard.ts'
import { installCoreGuard } from './guard.ts'
import { coreOs } from './os/index.ts'
import { followVisibleDirs } from './platform/visibleDirs.ts'
import { Watcher } from './platform/watch/watcher.ts'
import { registerCoreGauges } from './resources/gauges.ts'
import { watchUpdatesSetting } from './settings/updatesSetting.ts'
import { watchMenuBar } from './sessions/lifecycle.ts'
import { offerToTestHook } from './status/seam.ts'
import { fileShellEnv, ShellEnvCache } from './terminal/shellEnv.ts'
import { backupWriter } from './worktrees/backup.ts'

/** The build this bundle belongs to (tools/build.ts defines it); absent when the code runs unbundled. */
declare const __KEA_BUILD_ID__: string | undefined

interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown; ports: unknown[] }) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!parentPort) throw new Error('core must run as an Electron utilityProcess')

const args = parseChildArgv(process.argv)
const send = (m: ChildToMain) => parentPort.postMessage(m)

fs.mkdirSync(path.join(args.home, 'run'), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(args.home, 'logs'), { recursive: true, mode: 0o700 })
// A core from another build than main's (a package manager replaced Kea's files under a running Kea) stops here,
// before it takes the lock or opens anything, with the exit code main reads as "Kea's files changed"
const ownBuild = typeof __KEA_BUILD_ID__ === 'string' ? __KEA_BUILD_ID__ : undefined
if (buildMismatch(ownBuild, args.build)) {
  createLogger({ dir: path.join(args.home, 'logs'), process: 'core', level: 'info' }).warn('started from another build than main: exiting', { build: ownBuild, main: args.build })
  process.exit(L.childBuildMismatchExit)
}
const lockPath = path.join(args.home, 'run', 'core.lock')
let lock: ReturnType<typeof tryLock>
try {
  lock = tryLock(lockPath)
} catch (err) {
  // the lock could not be tried at all (Linux: a run directory that is not the user's alone, no `flock`, a file system
  // without locks): said in this process's own log before it exits, as nothing else would show it
  createLogger({ dir: path.join(args.home, 'logs'), process: 'core', level: 'info' }).error('instance lock not taken', { lock: lockPath, error: String(err) })
  throw err
}
if (!lock) {
  send({ k: 'locked', path: lockPath })
  process.exit(3)
}

const log = createLogger({ dir: path.join(args.home, 'logs'), process: 'core', level: args.dev ? 'debug' : 'info' })
// Anything uncaught is logged and core exits 1, so the Supervisor restarts it (guard.ts)
installCoreGuard(process, log, (code) => process.exit(code))

// better-sqlite3 13.0.3 crashes in `new Database()` below Node-API 10 (better-sqlite3 #1514).
if (Number(process.versions.napi ?? 0) < 10) {
  log.error('Node-API too old for better-sqlite3', { napi: process.versions.napi })
  process.exit(4)
}

// The login-shell environment, resolved once per launch and again on "Reload shell environment"; until the
// launch's resolution finishes, new PTYs get the last run's.
const shellEnv = new ShellEnvCache(
  undefined,
  (r) => {
    if (r.error) log.warn('shell environment fallback', { source: r.source, error: r.error })
    else log.info('shell environment resolved', { source: r.source, vars: Object.keys(r.env).length })
  },
  { store: fileShellEnv(path.join(args.home, 'shell-env.json')), shell: process.env.SHELL ?? need(coreOs.shellDefaults).shell },
)
void shellEnv.get()

/**
 * The chaos suite's seam (tests/support/app-child-hooks.cjs `hold`, loaded only by a dev build run with `--kea-perf`):
 * a function it sets on this symbol is told of every fault point a creation, delete or restore passes (the kill tests
 * in tests/chaos/app-sessions.test.ts).
 * Nothing else sets it, so it is a no-op otherwise.
 */
const TEST_FAULTS = Symbol.for('kea.test.faults')
const testFaults = (point: string, sessionId: string): void | Promise<void> => {
  const f = (globalThis as Record<symbol, unknown>)[TEST_FAULTS]
  return typeof f === 'function' ? (f as (p: string, id: string) => void | Promise<void>)(point, sessionId) : undefined
}

/**
 * What the editor launcher may look at and run. The harness's hook (tests/support/app-child-hooks.cjs, loaded only by a
 * dev build run with `--kea-perf`) sets this symbol to the run's own folder: editors, `open` and `gh` are then looked
 * for only there, so a test never starts the user's own editor, browser or terminal app (editor/host.ts).
 */
const TEST_EDITOR = Symbol.for('kea.test.editor')
const editorSandbox = (globalThis as Record<symbol, unknown>)[TEST_EDITOR]

const core = createCore({
  home: args.home,
  version: args.version,
  log,
  shellEnv,
  helperPath: args.helper ?? null,
  // an earlier build's kea-helper copy goes once nothing runs from it; the shipped helper lists the processes
  helperCopies: args.helper ? procsExecutables(args.helper) : null,
  // Kea's own folders stay out of Time Machine, marked by the backup writer (worktrees/backup.ts; never `tmutil`);
  // none on Linux
  backupExclude: backupWriter(log),
  // The user's Ghostty config, under this process's HOME (a harness gives Kea a HOME of the run's own)
  ghosttyConfig: path.join(os.homedir(), '.config', 'ghostty', 'config'),
  editorHost: typeof editorSandbox === 'string' && path.isAbsolute(editorSandbox) ? sandboxEditorHost(editorSandbox) : systemEditorHost(),
  // Discard Changes moves a file to the Trash with the system's tool; under the harness only with the run's own
  trashTool: trashToolFor(typeof editorSandbox === 'string' && path.isAbsolute(editorSandbox) ? editorSandbox : null),
  faults: testFaults,
  // the notification policy decides, main shows
  notify: (op) => send({ k: 'notify', ...op }),
  // A corrupt database at run time ends core; the restart's open runs the integrity check and sets it aside
  onCorrupt: (e) => {
    log.error('database corrupt; core restarts', { error: String(e) })
    process.exit(1)
  },
})
const connections = new Map<number, RpcPeer>() // bounded: one per open window
registerCoreGauges({ connections, terminals: core.terminals, db: core.db, statusBatch: core.statusBatch, projects: core.projects, settings: core.settings, keybindings: core.keybindings, ghostty: core.ghostty, sessions: core.sessions, banners: core.banners, status: core.status, notifications: core.notifications, agents: core.agents, visible: core.visible, viewer: core.viewer, servers: core.servers, editors: core.editors, watch: core.watch instanceof Watcher ? core.watch : undefined, files: core.files, disk: core.disk, sessionsSeen: core.sessionsSeen })
// main's `kea-file://` handler serves a window only what lies in its visible set's working
// directories: told when a window shows another session and when the shown session's directory changes
followVisibleDirs({ visible: core.visible, sessions: core.sessions.store, connections, send: (connId, dirs) => send({ k: 'visible', connId, dirs }) })
// main's platform report carries the inotify line's sysctl fix while the watcher holds a limit
if (core.watch instanceof Watcher) core.watch.onLimitHeld((held) => send({ k: 'watchLimit', held }))
offerToTestHook(core.status) // the leak suite's seam (L-MEM-19): a no-op unless its hook is loaded
/** The first-quit sheet's answer being written to settings.json; settled when nothing is. */
let quitSetting: Promise<void> = Promise.resolve()

parentPort.on('message', (e) => {
  const m = e.data
  if (!isMainToChild(m)) return
  switch (m.k) {
    case 'ping':
      send({ k: 'pong', n: m.n })
      return
    case 'control': {
      const port = e.ports[0]
      if (port) core.terminals.setControl(fromElectronPort(port as never))
      return
    }
    case 'rpc': {
      const port = e.ports[0]
      if (!port) return
      connections.get(m.connId)?.dispose()
      const peer = core.serve(fromElectronPort(port as never), `renderer:${m.connId}`, (err) => log.warn('rpc error', { connId: m.connId, error: String(err) }))
      connections.set(m.connId, peer)
      return
    }
    case 'disconnect':
      connections.get(m.connId)?.dispose()
      connections.delete(m.connId)
      // a window that goes (closed, reloading, crashed) views nothing any more
      if (connections.size === 0) core.status.setViewing(null)
      return
    case 'focus':
      // Whether a Kea window has keyboard focus
      core.notifications.setAppFocused(m.focused)
      if (m.focused) {
        // The watcher is a hint; on focus every visible session's tree and status are read again, and a project
        // whose folder was moved or deleted meanwhile is marked missing
        core.files.focus()
        void core.projects.checkRoots().catch((e: unknown) => log.warn('project root check failed', { error: String(e) }))
      }
      return
    case 'platform':
      // The report main assembled, at this core's start and each time it changed (About, Copy Diagnostics)
      core.diagnostics.setPlatform(m.report)
      return
    case 'onQuit':
      // The first-quit sheet's answer becomes the "On quit" setting (a quit's shutdown follows: it waits for this)
      quitSetting = core.settings.set('general.onQuit', m.onQuit).catch((e: unknown) => log.warn('"On quit" not saved', { error: String(e) }))
      return
    case 'shutdown':
      // the sheet's answer is written first; main's shutdown grace bounds the wait
      void quitSetting.finally(() => {
        for (const c of connections.values()) c.dispose()
        connections.clear()
        core.dispose()
        log.info('shutdown')
        lock.dispose()
        process.exit(0)
      })
      return
    case 'report':
      // main's collection (the hourly resources.ndjson line, watchdog triggers)
      send({ k: 'report', id: m.id, report: resources.report() })
      return
    case 'stopAll':
      // Stop All and Quit: main quits once this answers, or at its own deadline
      void core.sessions.stopEverything().finally(() => send({ k: 'stoppedAll', id: m.id }))
      return
    case 'stream':
      return
  }
})

// What ⌘Q and the menu-bar item need, kept current in main (sent now, then on each change)
watchMenuBar({
  sessions: core.sessions.store,
  // the attention set and the account conditions, the badge switch, the agents' names
  conditions: core.status.conditions.store,
  agentName: (agent) => core.agents.store.get(agent)?.displayName ?? agent,
  badge: () => core.settings.values.get('notifications.dockBadge'),
  onQuit: () => core.settings.values.get('general.onQuit'),
  onSettings: (cb) => core.settings.onChange(cb),
  send: (s) => send({ k: 'menuBar', ...s }),
})

log.info('started', { pid: process.pid, home: args.home, version: args.version })
send({ k: 'ready' })

// Whether main may check for updates by itself (sent now, then on each change of the switch)
watchUpdatesSetting({
  check: () => core.settings.values.get('updates.check'),
  onSettings: (cb) => core.settings.onChange(cb),
  send: (check) => send({ k: 'updates', check }),
})
