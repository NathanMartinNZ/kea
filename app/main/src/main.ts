// Electron main, kept thin: nothing here may block. It scrubs inherited session variables, takes the single-instance
// lock, serves the UI from `kea://`, runs core and ptyhost under one Supervisor each and brokers MessagePorts: the
// control port core ⇄ ptyhost, one RPC port per window to core and one stream port per attached terminal to ptyhost.
// After that, main is not on the data path. It also samples every process's footprint and writes the hourly resource
// report (resources.ts), and runs the memory watchdog's actions (watchdog.ts).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import * as electron from 'electron'
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeTheme, Notification, powerMonitor, protocol, screen, session, shell, Tray, type IpcMainEvent, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'
import { createLogger, installHookHelper, registerSingletonGauge, resources, Supervisor, type Logger } from '@kea/kit'
import { childArgv, childV8Flags, DESKTOP_IDS, EDIT_ROLES, isAvailable, KEA_FILE_SCHEME, L, need, parsePerfBusy, parseRepository, RELEASE_REPOSITORY, releaseUrls, scrubSessionEnv, zMenuState, zPtyId, zResourcesReply, zSessionId, type CollectedResources, type EditRole, type InstallKind, type MenuBarState, type PlatformReport, type ReleaseArch, type ResourceReport, type UpdateState } from '@kea/protocol'
import { COLOR, SIZE_PX } from '@kea/ui/tokens'
import { installFrontGuard } from './frontGuard.ts'
import { keaHome } from './home.ts'
import { serveKeaFile, VisibleDirs } from './keaFile.ts'
import { CoreAvailability, RpcPortHandout, shutdownChildren } from './lifecycle.ts'
import { findMenuItem, menuTemplate, windowMenuState, windowMenuTree, type WindowMenuState } from './menu.ts'
import { BackgroundTray, DockIcon, isQuitChoice, lastWindowAction, markQuitSheetSeen, MenuBarItemRemoval, QuitSheetAnswer, quitAction, quitSheetSeen, trayTemplate, trayTitle, trayTooltip, type QuitChoice } from './menuBar.ts'
import { trayIcon } from './trayIcon.ts'
import { openLink, RecordingOpener, type ExternalOpener } from './external.ts'
import { firstLaunchSize, FolderQueue, PICK_PURPOSES, readWindowState, revealablePath, writeWindowState, type PickPurpose } from './native.ts'
import { Notifier, RecordingSurfaces, type NativeNotification, type NativeSurfaces } from './notifier.ts'
import { mainOs, type DesktopServiceState, type IdleSource, type OpenVia } from './os/index.ts'
import { webglState } from './platformLines.ts'
import { PlatformReports } from './platformReport.ts'
import { RendererLog } from './rendererLog.ts'
import { collectReports, FootprintSampler, nameProcesses, Replies, rendererKey, ResourceLog, type ReportSource, type WatchdogAction, type WatchdogTrigger } from './resources.ts'
import { refusedSwitches } from './switches.ts'
import { WindowHandoff } from './handoff.ts'
import { childHookEnv, childHookPath, installTestApi, updateTestHooks } from './testHooks.ts'
import type { UpdaterDriver, UpdaterEvents } from './updates/driver.ts'
import { checkFeed, updateSessionFetch } from './updates/feed.ts'
import { NOT_FROM_RELEASE } from './updates/how.ts'
import { UpdateManager } from './updates/manager.ts'
import { installUpdateFilters, UPDATE_HEADERS, updateUrlAllowed } from './updates/net.ts'
import { readMarks, takeHandoff, writeHandoff, writeMarks } from './updates/store.ts'
import { asarIdentity, plainStat, relaunchArgs, relaunchedFor, treeVersion, UpgradeGuard } from './updates/upgrade.ts'
import { UtilityChild } from './utility.ts'
import { limitKind, Watchdog } from './watchdog.ts'

// P-START-5: main's own work before its first window: Node's bootstrap → this line (Electron's init and the bundle's
// modules), this line → the end of this file, `ready` → the window. Read by tools/perf under --kea-perf.
const perfMarks = { bootstrap: performance.nodeTiming.bootstrapComplete, script: performance.now(), topLevel: 0, ready: 0, window: 0 }
const scrubbed = scrubSessionEnv(process.env) // before anything reads the environment

const HOME = keaHome({ packaged: app.isPackaged, argv: process.argv, homedir: os.homedir() })

// Packaged builds refuse debugger and perf switches (switches.ts), before the lock and before any child starts.
// `__KEA_PERF_PROBES__` is set by `tools/build.ts --perf-probes` (test builds only).
declare const __KEA_PERF_PROBES__: boolean
const REFUSED = refusedSwitches(process.argv, { packaged: app.isPackaged, perfProbes: typeof __KEA_PERF_PROBES__ === 'boolean' && __KEA_PERF_PROBES__ })
if (REFUSED.length > 0) {
  console.error(`Kea: refusing to start with ${REFUSED.join(' ')} (a packaged build accepts no debugger or perf switches)`)
  try {
    fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true, mode: 0o700 })
    createLogger({ dir: path.join(HOME, 'logs'), process: 'main', level: 'info' }).error('refused to start: debugger or perf switches', { switches: REFUSED })
  } catch {
    // stderr above is enough
  }
  process.exit(1)
}

const DEV = !app.isPackaged
const VERSION = app.getVersion()
const PERF = process.argv.includes('--kea-perf') // tools/perf: exposes window.__keaPerf in the renderer
// tools/perf on a display of its own (Linux's Xvfb), whose clipboard is the run's: the Edit roles run for real there
const PERF_CLIPBOARD = PERF && process.argv.includes('--kea-perf-clipboard')
const DIST = __dirname // dist/app: main.cjs, preload.cjs, core.cjs, ptyhost.cjs, renderer/
const RENDERER_DIR = path.join(DIST, 'renderer')
const HELPER = app.isPackaged ? path.join(process.resourcesPath, 'kea-helper') : path.resolve(DIST, '..', '..', 'native', 'kea-helper', 'target', 'release', 'kea-helper')
// The display server (macOS's own; on Linux Wayland or X11, from Chromium's switch where one was given)
const DISPLAY = mainOs.raise.display(process.env, (name) => app.commandLine.getSwitchValue(name))
/** The desktop file this build runs as on Linux: a dev build has its own id, never the packaged one. */
const DESKTOP_ID = app.isPackaged ? DESKTOP_IDS.packaged : DESKTOP_IDS.dev

// One instance per KEA_HOME: dev, installed and test builds each get their own lock (and userData). A packaged build
// run with another home (`--kea-home`, such as the survival test's runs) must not take the installed app's lock or
// userData.
app.setPath('userData', path.join(app.getPath('appData'), DEV ? `Kea-dev-${fnv(HOME)}` : HOME === keaHome({ packaged: true, argv: [], homedir: os.homedir() }) ? 'Kea' : `Kea-${fnv(HOME)}`))
if (!app.requestSingleInstanceLock({ home: HOME })) {
  app.quit()
  process.exit(0)
}

fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true, mode: 0o700 })
const log: Logger = createLogger({ dir: path.join(HOME, 'logs'), process: 'main', level: DEV ? 'debug' : 'info' })
log.info('starting', { version: VERSION, home: HOME, dev: DEV, scrubbed })

protocol.registerSchemesAsPrivileged([
  { scheme: 'kea', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  // local images for the viewer; secure so a `kea://` page may show them, and nothing more (no fetch, no CORS)
  { scheme: KEA_FILE_SCHEME, privileges: { standard: true, secure: true } },
])
// each window's working directories, as core says them: all `kea-file://` may ever read from
const keaFileDirs = new VisibleDirs()

/** This bundle's build (`tools/build.ts` defines one per build): a child of another build exits at once. Absent unbundled. */
declare const __KEA_BUILD_ID__: string | undefined
const BUILD = typeof __KEA_BUILD_ID__ === 'string' ? __KEA_BUILD_ID__ : undefined

/**
 * This run's own copy of kea-helper under the home (`bin/<version>-<hash>`), which every helper this run starts comes
 * from: a package manager that replaces Kea's files later leaves it as it is. A checkout without a built helper, or a
 * copy that fails, uses the build's own.
 */
function runHelper(): string {
  if (!fs.existsSync(HELPER)) return HELPER
  try {
    return installHookHelper(HELPER, HOME, VERSION)
  } catch (e) {
    log.warn('helper not copied: using the build’s own', { error: e instanceof Error ? e.message : String(e) })
    return HELPER
  }
}
const RUN_HELPER = runHelper()

// ── supervised children ─────────────────────────────────────────────────────────────

type Child = { sup: Supervisor; current: UtilityChild | null }
const args = childArgv({ home: HOME, version: VERSION, dev: DEV, helper: RUN_HELPER, ...(BUILD ? { build: BUILD } : {}) })
// perf harness only: an injected stall in ptyhost, to measure contention; never honoured without --kea-perf
const PERF_BUSY = PERF ? parsePerfBusy(process.argv.find((a) => a.startsWith('--kea-perf-busy='))?.slice('--kea-perf-busy='.length)) : undefined
const ptyhostArgs = PERF_BUSY ? childArgv({ home: HOME, version: VERSION, dev: DEV, helper: RUN_HELPER, ...(BUILD ? { build: BUILD } : {}), perfBusy: PERF_BUSY }) : args
// test hooks (testHooks.ts): a dev build under --kea-perf only, never a packaged one
const CHILD_HOOK = DEV && PERF ? childHookPath(DIST) : null
const childEnv = CHILD_HOOK ? childHookEnv(CHILD_HOOK) : undefined
const children: Record<'core' | 'ptyhost', Child> = {
  core: makeChild('core', path.join(DIST, 'core.cjs')),
  ptyhost: makeChild('ptyhost', path.join(DIST, 'ptyhost.cjs')),
}

function makeChild(name: 'core' | 'ptyhost', entry: string): Child {
  const c: Child = {
    current: null,
    sup: new Supervisor({
      name,
      logger: log,
      // no child starts from files a package manager replaced under Kea (updates/upgrade.ts)
      beforeRespawn: () => upgrade.mayRespawn(),
      spawn: () => {
        // ptyhost's young generation is capped, and each one's old space at its hard limit
        const u = new UtilityChild(name, entry, name === 'ptyhost' ? ptyhostArgs : args, log, childEnv, childV8Flags(name))
        c.current = u
        u.onReady(() => onChildReady(name))
        // core keeps main's menu-bar state current (what ⌘Q and the menu-bar item need)
        if (name === 'core') u.onMenuBar((st) => menuBarChanged(st))
        // core's notification policy decides, main shows
        if (name === 'core') u.onNotify((op) => notifier.apply(op))
        // the visible set's working directories, for `kea-file://`
        if (name === 'core') u.onVisible((v) => keaFileDirs.set(v.connId, v.dirs))
        // The inotify line's fix while core's watcher holds a limit
        if (name === 'core')
          u.onWatchLimit((held) => {
            watchLimitHeld = held
            platformReports.assemble('watchLimit')
          })
        // whether Kea may check for updates by itself, at core's start and on each change
        if (name === 'core') u.onUpdates((check) => updates.coreSetting(check))
        u.onExit((code) => {
          if (c.current === u) c.current = null
          log.info('child exited', { name, code })
          if (code === L.childBuildMismatchExit) upgrade.childFromOtherBuild()
          if (name === 'core') coreAvailability.exited(u.wasReady)
          if (name === 'core') keaFileDirs.clear() // what it said goes with it; the next core says it again
          if (name === 'core') watchLimitHeld = null
        })
        return u
      },
    }),
  }
  // a refused respawn: the watchdog's restart is over, and Kea restarts into the new files
  c.sup.onRespawnRefused(() => {
    for (const done of readyWaiters[name].splice(0)) done()
    upgrade.respawnRefused()
  })
  return c
}

function ready(name: 'core' | 'ptyhost'): UtilityChild | null {
  const u = children[name].current
  return u?.isReady ? u : null
}

function onChildReady(name: 'core' | 'ptyhost'): void {
  if (name === 'core') coreAvailability.ready() // each window's new RPC port tells it core is back
  if (name === 'core') sendFocus(true) // a new core starts unaware of the window's focus
  if (name === 'core') quitSheet.coreReady() // a first-quit answer given while core was away
  if (name === 'core') {
    // A new core holds no inotify limit yet, and has no platform report
    watchLimitHeld = false
    platformReports.coreReady()
  }
  for (const done of readyWaiters[name].splice(0)) done() // a watchdog restart of it is over
  // a new core or ptyhost: a fresh control port for both sides (the survivor replaces its old one)
  const core = ready('core')
  const ptyhost = ready('ptyhost')
  if (core && ptyhost) {
    const { port1, port2 } = new MessageChannelMain()
    core.post({ k: 'control' }, [port1])
    ptyhost.post({ k: 'control' }, [port2])
  }
  if (name === 'core') {
    // only renderers that have said hello: a window still loading asks with its own hello (one port each, rpcPorts)
    for (const id of rpcPorts.coreReady()) {
      const w = windows.get(id)
      if (w) sendRpcPort(w)
    }
  } else for (const w of windows.values()) w.webContents.send('kea:streamsReset') // every stream port of the old ptyhost is dead
}

// ── windows and their ports ─────────────────────────────────────────────────────────

const windows = new Map<number, BrowserWindow>() // bounded: one per open window
const menuStates = new Map<number, WindowMenuState>() // bounded: one per open window, each ≤ the command table (its commands, and a key per command at most)
/** Connection records: windows whose renderer was handed an RPC port and has not gone since. */
const connections = new Set<number>() // bounded: one per open window
// Windows hear when a ready core exits; their renderer shows "Reconnecting…" only if it stays away long enough
/** Which windows get an RPC port when core becomes ready: those whose renderer said hello. */
const rpcPorts = new RpcPortHandout()
const coreAvailability = new CoreAvailability((id) => {
  for (const [wid, w] of windows) if ((id === undefined || id === wid) && !w.isDestroyed()) w.webContents.send('kea:coreAway')
})

function sendRpcPort(w: BrowserWindow): void {
  const core = ready('core')
  if (!core || w.isDestroyed()) return
  const connId = w.webContents.id
  core.post({ k: 'disconnect', connId }) // drop the window's previous connection scope, if any
  const { port1, port2 } = new MessageChannelMain()
  core.post({ k: 'rpc', connId }, [port1])
  w.webContents.postMessage('kea:rpc', null, [port2])
  connections.add(connId)
}

function fromOurWindow(e: IpcMainEvent): BrowserWindow | null {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || !windows.has(e.sender.id) || e.senderFrame !== e.sender.mainFrame) return null
  return w
}

ipcMain.on('kea:hello', (e) => {
  const w = fromOurWindow(e)
  if (!w) return
  coreAvailability.hello(w.webContents.id) // a window reloaded while core restarts still shows the bar
  handoff.started(w.webContents.id) // a rebuilt window's page has taken what it was handed
  if (rpcPorts.hello(w.webContents.id, ready('core') !== null)) sendRpcPort(w)
  sendScreenReader(w) // a window (a reloaded one too) learns at once whether a screen reader runs
  platformReports.assemble('window') // the window sandbox is read from a renderer
  // a session asked for while the window was being made (the menu-bar item's list) is shown once its renderer is there
  if (pendingShow) {
    w.webContents.send('kea:showSession', { sessionId: pendingShow })
    pendingShow = null
  }
  // Check for Updates… asked for with no window: About opens once the new window's page is there
  if (pendingAbout) {
    w.webContents.send('kea:command', { id: 'app.settings', args: { page: 'about' } })
    pendingAbout = false
  }
  updates.windowLoaded()
})

// The commands the window's renderer can run; the menu bar is rebuilt from the table plus this
ipcMain.on('kea:menuState', (e, state: unknown) => {
  const w = fromOurWindow(e)
  if (!w) return
  const r = zMenuState.safeParse(state)
  if (!r.success) {
    log.warn('menu state refused', { error: r.error.issues[0]?.message })
    return
  }
  menuStates.set(w.webContents.id, windowMenuState(r.data))
  rebuildMenu()
})

ipcMain.on('kea:openStream', (e, req: unknown) => {
  const w = fromOurWindow(e)
  if (!w) return
  const r = req as { ptyId?: unknown; reqId?: unknown }
  if (typeof r?.reqId !== 'number' || !zPtyId.safeParse(r.ptyId).success) return
  const ptyhost = ready('ptyhost')
  if (!ptyhost) {
    w.webContents.send('kea:streamError', { reqId: r.reqId, error: 'ptyhost is not running' })
    return
  }
  const { port1, port2 } = new MessageChannelMain()
  ptyhost.post({ k: 'stream', connId: w.webContents.id, ptyId: r.ptyId as string }, [port1])
  w.webContents.postMessage('kea:stream', { reqId: r.reqId }, [port2])
})

// ── native pieces the UI asks for (native.ts): folder picks, Reveal in Finder, settings.json ─────────

/** Under --kea-perf no dialog ever shows (it would take keyboard focus): the harness queues the next pick's folder. */
const folderQueue = new FolderQueue()

ipcMain.on('kea:pickFolder', (e, req: unknown) => {
  const w = fromOurWindow(e)
  if (!w) return
  const r = req as { reqId?: unknown; purpose?: unknown }
  if (typeof r?.reqId !== 'number' || !PICK_PURPOSES.includes(r.purpose as PickPurpose)) return
  const reply = (p: string | null) => {
    if (!w.isDestroyed()) w.webContents.send('kea:folder', { reqId: r.reqId, path: p })
  }
  if (PERF) {
    reply(folderQueue.take())
    return
  }
  const title = r.purpose === 'add' ? 'Add Project' : 'Locate Project'
  void dialog
    .showOpenDialog(w, { title, buttonLabel: r.purpose === 'add' ? 'Add' : 'Locate', properties: ['openDirectory', 'createDirectory'] })
    .then((res) => reply(res.canceled ? null : (res.filePaths[0] ?? null)))
    .catch((err: unknown) => {
      log.warn('folder dialog failed', { error: String(err) })
      reply(null)
    })
})

// Reveal (project.reveal, session.reveal): an existing absolute path only (under --kea-perf nothing opens, since the
// file manager or an editor would take keyboard focus: the request is logged instead)
ipcMain.on('kea:reveal', (e, p: unknown) => {
  if (!fromOurWindow(e)) return
  const ok = revealablePath(p)
  if (!ok) return
  if (PERF) log.info('reveal not opened (perf)', { path: ok })
  else shell.showItemInFolder(ok)
})

// the settings banner's "Open settings.json": this home's file, nothing else
ipcMain.on('kea:openSettingsFile', (e) => {
  if (!fromOurWindow(e)) return
  const file = path.join(HOME, 'settings.json')
  if (PERF) log.info('settings file not opened (perf)', { exists: fs.existsSync(file) })
  else if (fs.existsSync(file)) void shell.openPath(file)
  else shell.showItemInFolder(HOME)
})

// "Open keybindings.json" (core has made the file), "Open Reports Folder" and "Open logs folder": these items of this
// home, nothing else. Under --kea-perf nothing opens: the request is logged instead
const HOME_ITEMS: Readonly<Record<string, string>> = { keybindings: 'keybindings.json', reports: 'reports', logs: 'logs' } // `logs`: Settings › Advanced, "Open logs folder"
ipcMain.on('kea:openHomeItem', (e, which: unknown) => {
  if (!fromOurWindow(e)) return
  const name = typeof which === 'string' && Object.hasOwn(HOME_ITEMS, which) ? HOME_ITEMS[which] : undefined
  if (!name) return
  const item = path.join(HOME, name)
  if (PERF) log.info('home item not opened (perf)', { item: name, exists: fs.existsSync(item) })
  else if (fs.existsSync(item)) void shell.openPath(item)
  else shell.showItemInFolder(HOME)
})

// the palette runs main's own commands as their menu items do (every command is in the palette)
ipcMain.on('kea:mainCommand', (e, id: unknown) => {
  if (!fromOurWindow(e)) return
  if (id === 'app.openKea') openKea()
  else if (id === 'app.closeToMenuBar') closeToMenuBar()
  else if (id === 'app.quit') app.quit()
  else if (id === 'app.checkUpdates') checkUpdatesCommand()
})

/**
 * An Edit role on the window's focused element. Under --kea-perf the person's clipboard is never read or written: the
 * request is logged instead, unless the run's display (and so its clipboard) is its own (--kea-perf-clipboard), where
 * the role runs and is logged.
 */
function runEditRole(w: BrowserWindow, role: EditRole): void {
  if (PERF && !PERF_CLIPBOARD) {
    log.info('edit role not run (perf)', { role })
    return
  }
  const wc = w.webContents
  if (role === 'undo') wc.undo()
  else if (role === 'redo') wc.redo()
  else if (role === 'cut') wc.cut()
  else if (role === 'copy') wc.copy()
  else if (role === 'paste') wc.paste()
  else wc.selectAll()
  if (PERF) log.info('edit role run (perf)', { role })
}

const isEditRole = (r: unknown): r is EditRole => typeof r === 'string' && (EDIT_ROLES as readonly string[]).includes(r)

// the palette's Copy and Paste, and Linux's keys for them: the Edit menu's roles on the window's focused element
ipcMain.on('kea:editRole', (e, role: unknown) => {
  const w = fromOurWindow(e)
  if (w && isEditRole(role)) runEditRole(w, role)
})

/**
 * `handoff`: the window is made in place of one rebuilt on Wayland, and its preload asks for what that one handed over.
 */
function createWindow(o: { handoff?: boolean } = {}): BrowserWindow {
  perfMarks.window ||= performance.now()
  // the window comes back where it was (native.ts), else at the first-launch size
  const min = { width: SIZE_PX['window-min-width'], height: SIZE_PX['window-min-height'] }
  const saved = readWindowState(app.getPath('userData'), screen.getAllDisplays().map((d) => d.workArea), min)
  const chrome = need(mainOs.windowChrome)
  // On Wayland a window cannot place itself, so only its size comes back
  const at = saved && chrome.restoresPosition(DISPLAY) ? { x: saved.x, y: saved.y } : {}
  const w = new BrowserWindow({
    ...(saved ? { ...at, width: saved.width, height: saved.height } : firstLaunchSize({ width: SIZE_PX['window-default-width'], height: SIZE_PX['window-default-height'] }, screen.getPrimaryDisplay().workArea, min)),
    minWidth: min.width,
    minHeight: min.height,
    // On Linux the window is made shown, since GNOME's Wayland session may never send `ready-to-show` to a hidden one
    show: chrome.createShown,
    title: 'Kea',
    // the system's title bar (the OS layer's `windowChrome`): on macOS the traffic lights sit inside the sidebar
    // header; on Linux the Window Controls Overlay in the header's colours, above its bottom line
    ...chrome.options({
      trafficLights: { x: SIZE_PX['traffic-light-x'], y: SIZE_PX['traffic-light-y'] },
      overlay: { color: COLOR['surface-1'], symbolColor: COLOR['text-2'], height: SIZE_PX['window-controls'] },
    }),
    backgroundColor: COLOR['surface-0'], // painted before the renderer's first frame
    // the perf and test harnesses type through CDP: their window can never become key, even if macOS activates Kea
    // (e.g. when the app in front quits), so a keystroke meant for another app never reaches a test shell
    ...(PERF ? { focusable: false } : {}),
    webPreferences: {
      preload: path.join(DIST, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: DEV,
      additionalArguments: [`--kea-version=${VERSION}`, ...(PERF ? ['--kea-perf'] : []), ...(o.handoff ? ['--kea-handoff'] : [])],
    },
  })
  const id = w.webContents.id
  windows.set(id, w)
  rebuildMenu()
  // the perf and test harnesses drive the page through CDP: their windows never take keyboard focus from the person at
  // the machine
  if (chrome.createShown) {
    if (saved?.maximized && !PERF) w.maximize()
  } else
    w.once('ready-to-show', () => {
      if (saved?.maximized && !PERF) w.maximize()
      if (PERF) w.showInactive()
      else w.show()
    })
  // bounds persist per window
  w.on('close', () => writeWindowState(app.getPath('userData'), { ...w.getNormalBounds(), maximized: w.isMaximized() }))
  w.webContents.on('render-process-gone', (_e, d) => {
    log.warn('renderer gone', { reason: d.reason })
    disconnect(id)
    if (!w.isDestroyed()) w.webContents.reload() // every terminal reattaches from ptyhost's snapshots
  })
  // A hung renderer is ended (render-process-gone above then reloads it in a new process)
  w.on('unresponsive', () => {
    log.warn('renderer unresponsive: reloading the window')
    if (!w.isDestroyed()) w.webContents.forcefullyCrashRenderer()
  })
  w.webContents.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) disconnect(id) // reload: its connection scopes go
  })
  // the window's warnings and errors are its log, written by main (rendererLog.ts)
  w.webContents.on('console-message', (m) => rendererLog.message(id, m))
  w.on('focus', () => {
    rebuildMenu()
    sendFocus()
  })
  w.on('blur', () => sendFocus())
  // Where the compositor gives no idle time, input to Kea's windows stands for the person's
  if (TRACKS_INPUT)
    w.webContents.on('input-event', () => {
      lastKeaInput = performance.now()
    })
  // Closing destroys the window and its renderer process; core, ptyhost and holders keep running
  w.on('closed', () => {
    windows.delete(id)
    rendererLog.closed(id)
    disconnect(id)
    rebuildMenu()
    sendFocus()
  })
  void w.loadURL('kea://app/index.html')
  return w
}

function disconnect(connId: number): void {
  rpcPorts.gone(connId)
  menuStates.delete(connId)
  connections.delete(connId)
  keaFileDirs.drop(connId)
  rendererReports.cancelFrom(connId) // its renderer will never answer
  ready('core')?.post({ k: 'disconnect', connId })
  ready('ptyhost')?.post({ k: 'disconnect', connId })
}

/** The window the menu bar acts on: the focused one, else the only one. */
function menuWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && windows.has(focused.webContents.id)) return focused
  return [...windows.values()][0] ?? null
}

/**
 * Reopening after the window was closed, or from the menu bar, creates a fresh one that reattaches; the menu-bar item
 * goes and the Dock icon comes back. `sessionId`: show that session (the menu-bar item's list, or a notification's
 * click). `via`: where the request came from, which decides how an open window is raised on Wayland.
 */
function openKea(o: { sessionId?: string } = {}, via: OpenVia = 'menu'): void {
  leaveMenuBar()
  const w = menuWindow()
  // the perf and test harnesses' windows never take keyboard focus (a second instance in I-HLD-25 lands here)
  const how = w && !PERF ? mainOs.raise.how({ display: DISPLAY, minimized: w.isMinimized(), via }) : null
  if (o.sessionId && zSessionId.safeParse(o.sessionId).success) {
    if (w && how !== 'rebuild' && connections.has(w.webContents.id)) w.webContents.send('kea:showSession', { sessionId: o.sessionId })
    else pendingShow = o.sessionId
  }
  if (!w) {
    createWindow()
    return
  }
  if (PERF) {
    w.showInactive()
    return
  }
  if (how === 'none') return // the shell raises Kea itself (a second launch)
  if (how === 'remap') {
    // GNOME's Wayland session raises a window that is mapped again, and nothing else Kea can call
    w.hide()
    w.show()
    return
  }
  if (how === 'rebuild') {
    void rebuildWindow(w)
    return
  }
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

/** What the old window hands the one rebuilt in its place (its composer drafts, handoff.ts). */
const handoff = new WindowHandoff()
/** A rebuild under way: a second request meanwhile (a double click in the shell) makes no second window. */
let rebuilding: Promise<void> | null = null

/**
 * A minimized window on Wayland, which nothing Kea calls brings back, is replaced by a window made from its state,
 * the way a closed one is reopened (sessions, terminals and the settings live outside the window). The old
 * window's composer drafts are handed to the new one (`WindowHandoff`; its other window-lived state is not). The new
 * one is made before the old one goes, so Kea is never without a window (`window-all-closed`), and comes up focused,
 * made in answer to the person's click in the shell.
 */
function rebuildWindow(old: BrowserWindow): Promise<void> {
  rebuilding ??= (async () => {
    writeWindowState(app.getPath('userData'), { ...old.getNormalBounds(), maximized: old.isMaximized() })
    await handoff.ask((reqId) => old.webContents.send('kea:handoffAsk', { reqId }))
    log.info('window rebuilt (minimized on Wayland)', { drafts: handoff.held })
    handoff.giveTo(createWindow({ handoff: true }).webContents.id)
    if (!old.isDestroyed()) old.destroy()
  })().finally(() => (rebuilding = null))
  return rebuilding
}

// The old window's answer, and the new window's preload asking for it as it starts (answered at once, from memory)
ipcMain.on('kea:handoff', (e, msg: unknown) => {
  if (!fromOurWindow(e)) return
  const m = msg as { reqId?: unknown; state?: unknown } | null
  if (!handoff.answer(m?.reqId, m?.state)) log.warn('window handoff refused')
})
ipcMain.on('kea:takeHandoff', (e) => {
  e.returnValue = fromOurWindow(e) ? handoff.take(e.sender.id) : null
})

let lastMenu = ''
/** The menu last built, which the header's menu button opens. */
let menuNow: MenuItemConstructorOptions[] = []
function rebuildMenu(): void {
  if (!app.isReady()) return
  const w = menuWindow()
  const state = w ? (menuStates.get(w.webContents.id) ?? null) : null
  const key = JSON.stringify([!!w, state ? [[...state.commands], state.keys] : null, updates.title])
  if (key === lastMenu) return
  lastMenu = key
  const template = menuTemplate({
    appName: app.name,
    renderer: state,
    hasWindow: !!w,
    dev: DEV,
    send: (id, args) => {
      const target = menuWindow()
      if (target && !target.isDestroyed()) target.webContents.send('kea:command', { id, ...(args !== undefined ? { args } : {}) })
    },
    main: { openKea: () => openKea(), closeToMenuBar: () => closeToMenuBar(), quit: () => app.quit(), checkUpdates: () => checkUpdatesCommand(), reload: () => menuWindow()?.webContents.reload() },
    updateTitle: updates.title,
  })
  menuNow = template
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** What a test sees of the header's menu: the menus' titles, and where each opening was asked for (none opens under --kea-perf). */
const menuOpenings: { x: number; y: number }[] = [] // bounded: the newest L.logMemoryEntries openings (an in-memory log for tests)

// The header's menu button and `Alt` pressed alone open the window's menu under the button: the window draws it
// (Kea's own menu, so it has the window's type and colours), from the items of the menu bar's template, sent now so
// they say what is available now. Under --kea-perf each opening is recorded too
ipcMain.on('kea:openMenu', (e, at: unknown) => {
  const w = fromOurWindow(e)
  if (!w || !isAvailable(mainOs.menu) || !mainOs.menu.inWindow) return
  const p = (at ?? {}) as { x?: unknown; y?: unknown }
  const coord = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0)
  const x = coord(p.x)
  const y = coord(p.y)
  if (PERF) {
    menuOpenings.push({ x, y })
    if (menuOpenings.length > L.logMemoryEntries) menuOpenings.shift()
  }
  w.webContents.send('kea:windowMenu', { at: { x, y }, items: windowMenuTree(menuNow) })
})

// A pick in the window's menu: its item, found again in the template as it is now; a disabled one does nothing
ipcMain.on('kea:menuPick', (e, id: unknown) => {
  const w = fromOurWindow(e)
  if (!w || typeof id !== 'string' || !isAvailable(mainOs.menu) || !mainOs.menu.inWindow) return
  const item = findMenuItem(menuNow, id)
  if (!item || item.enabled === false) return
  if (isEditRole(item.role)) runEditRole(w, item.role)
  else if (item.role === 'toggleDevTools') w.webContents.toggleDevTools()
  else item.click?.(undefined as never, w, undefined as never)
})

// ── notifications and the badge (notifier.ts) ──────────────────────────────────────────────

/** The system's surfaces (the OS layer's `notify` and `badge`). A dev build run with `--kea-perf` records instead: no test ever posts a real notification. */
const electronSurfaces: NativeSurfaces = {
  create: (o) => need(mainOs.notify).create(Notification, o) as unknown as NativeNotification,
  setBadge: (text) => need(mainOs.badge).set(app, text),
}
const recorder = DEV && PERF ? new RecordingSurfaces() : null
// Where a link goes (external.ts). Under `--kea-perf` it is recorded, never opened: a browser would take the keyboard,
// as the file manager would for a reveal.
const openedLinks = PERF ? new RecordingOpener() : null
const browser: ExternalOpener = openedLinks ?? { open: (url) => void shell.openExternal(url) }
/** A click activates Kea (reopening the window from the menu bar) on that session's Agent tab. */
const notifier = new Notifier({ native: recorder ?? electronSurfaces, log, onClick: (sessionId) => openKea(sessionId ? { sessionId } : {}, 'notification') })

// Settings › Notifications: whether a notification failed to show since the last one that did, and macOS's own pane,
// where they are allowed. Under --kea-perf the pane never opens (System Settings would take the keyboard): the request
// is logged instead
const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
ipcMain.on('kea:notificationState', (e, req: unknown) => {
  const w = fromOurWindow(e)
  const reqId = (req as { reqId?: unknown } | null)?.reqId
  if (!w || typeof reqId !== 'number') return
  w.webContents.send('kea:notificationState', { reqId, denied: notifier.permissionDenied })
})
ipcMain.on('kea:openNotificationSettings', (e) => {
  if (!fromOurWindow(e)) return
  if (PERF) log.info('notification settings not opened (perf)')
  else void shell.openExternal(NOTIFICATION_SETTINGS_URL)
})

/**
 * Whether a screen reader runs, for the windows' terminals. The system's answer is Electron's accessibility
 * support (`app.accessibilitySupportEnabled` and its change event): VoiceOver turns it on, and so does any other
 * assistive technology that reads the window. A test run (`--kea-perf`) never takes the system's answer, so what runs
 * on the person's machine cannot change a test: it starts off, and the harness says (`__keaTest.screenReader`).
 */
let screenReaderOverride: boolean | null = PERF ? false : null
function sendScreenReader(to?: BrowserWindow): void {
  const on = screenReaderOverride ?? app.accessibilitySupportEnabled
  for (const w of to ? [to] : windows.values()) if (!w.isDestroyed()) w.webContents.send('kea:screenReader', { on })
}
app.on('accessibility-support-changed', () => sendScreenReader())

/** The harness's stand-in for keyboard focus (its windows can never take it): null follows the real windows. */
let focusOverride: boolean | null = null
let focusSent: boolean | null = null
/** Tell core whether a Kea window has keyboard focus, on each change (`force`: a core that just started). */
function sendFocus(force = false): void {
  const focused = focusOverride ?? [...windows.values()].some((w) => !w.isDestroyed() && w.isFocused())
  if (!force && focused === focusSent) return
  const core = ready('core')
  if (!core) return
  focusSent = focused
  core.post({ k: 'focus', focused })
}

// ── ⌘Q and menu-bar mode (menuBar.ts) ───────────────────────────────────────────────────────

/** Core's last menu-bar state (null until core has sent one); kept across a core restart. */
let menuBarState: MenuBarState | null = null
/**
 * Kea with no window, from the menu bar (macOS) or the tray (Linux), and its item: made only while a host shows
 * it (one, while Kea runs in the background).
 */
const background = new BackgroundTray<Tray>({
  make: () => new Tray(trayIcon(need(mainOs.background).templateIcon)),
  made: () => {
    updateTray()
    updateBadge()
  },
})
/** The desktop's services as main last heard: the tray host, notifications, the idle monitor. */
let services: DesktopServiceState = { trayHost: null, notifications: null, idleMonitor: null }
/** Main's watch of them (Linux: its one session-bus connection), from `ready` to quit. */
let servicesWatch: { now(): DesktopServiceState; dispose(): void } | null = null
/** A session to show once the window being made has its renderer (openKea). */
let pendingShow: string | null = null
/** Settings › About to show once the window being made has its renderer (Check for Updates… with no window). */
let pendingAbout = false
let stoppingAll = false
/**
 * The Dock icon's show and hide: a hide that Electron ignores, just after a show, is made again later (menuBar.ts).
 */
const dockIcon = new DockIcon({ dock: isAvailable(mainOs.background) ? mainOs.background.dock(app) : undefined, now: () => performance.now(), waitMs: L.dockRehideAfterShowMs })
/** The item's removal when Kea leaves the menu bar: its title cleared first, the item removed once that is drawn. */
const menuBarItemRemoval = new MenuBarItemRemoval({ waitMs: L.menuBarItemRemoveMs })

function menuBarChanged(st: MenuBarState): void {
  menuBarState = st
  updateTray()
  updateBadge()
}

/** On the Dock icon while it is shown; in the menu bar the item's title carries the count (updateTray). */
function updateBadge(): void {
  notifier.badge(menuBarState, !background.background)
}

/** A tray host came or went (BackgroundTray makes the tray when one comes while Kea is in the background). */
function servicesChanged(s: DesktopServiceState): void {
  if (s.trayHost !== services.trayHost) log.info('tray host', { present: s.trayHost })
  services = s
  background.host(s.trayHost)
  platformReports.assemble('services') // the tray host's and notification service's lines
}

/** The item as the menu-bar removal sees it: a Linux tray has no title, so it goes at once. */
function trayItem(t: Tray) {
  const bg = need(mainOs.background)
  return { getTitle: () => bg.title(t), setTitle: (title: string) => bg.setTitle(t, title), destroy: () => t.destroy() }
}

/** `⌘Q` (`app.closeToMenuBar`): quit, stop all and quit, the menu bar, or the first-quit sheet (menuBar.ts). */
function closeToMenuBar(): void {
  const w = menuWindow()
  const canAsk = !!w && !w.isDestroyed() && connections.has(w.webContents.id)
  // On Linux Kea can run in the background only while a tray host is there to reopen it from
  const canBackground = background.canRunInBackground
  const action = quitAction({ state: menuBarState, sheetSeen: quitSheetSeen(app.getPath('userData')), canAsk, background: canBackground })
  log.info('quit asked', { action, live: menuBarState?.live ?? null, background: canBackground })
  if (action === 'sheet') w!.webContents.send('kea:quitSheet', { live: menuBarState?.live ?? 0, background: canBackground })
  else runQuitChoice(action)
}

function runQuitChoice(c: QuitChoice): void {
  if (c === 'menuBar') enterMenuBar()
  else if (c === 'stopAll') void stopAllAndQuit()
  else app.quit()
}

// the first-quit sheet's answer: never shown again once answered; Esc answers nothing. Keep in Menu Bar and
// Quit Completely become the "On quit" setting: core writes it, and a quit's `shutdown` waits for that write. An
// answer core cannot take yet (away) waits for it, and the sheet counts as answered once core has it (menuBar.ts)
const quitSheet = new QuitSheetAnswer({
  post: (onQuit) => {
    const core = ready('core')
    core?.post({ k: 'onQuit', onQuit })
    return !!core
  },
  markSeen: () => markQuitSheetSeen(app.getPath('userData')),
})
ipcMain.on('kea:quitChoice', (e, choice: unknown) => {
  if (!fromOurWindow(e) || !isQuitChoice(choice)) return
  quitSheet.answer(choice)
  runQuitChoice(choice)
})

/** Stop All and Quit: core stops every session (at most L.quitStopAllTimeoutMs), then a full quit. */
async function stopAllAndQuit(): Promise<void> {
  if (stoppingAll) return
  stoppingAll = true
  await ready('core')
    ?.stopAll(L.quitStopAllTimeoutMs)
    .catch(() => undefined)
  app.quit()
}

/**
 * The window closes (its renderer exits), the Dock icon hides, and the menu-bar item stays; core, ptyhost and the
 * holders keep running.
 */
function enterMenuBar(): void {
  if (background.background) return
  background.enter()
  for (const w of [...windows.values()]) if (!w.isDestroyed()) w.close()
  dockIcon.hide() // made again once Electron allows it, when Kea was reopened just before
  rebuildMenu()
  log.info('menu-bar mode')
}

/** Back from the menu bar (openKea): the item goes and the Dock icon comes back. */
function leaveMenuBar(): void {
  if (!background.background) return
  const tray = background.leave()
  if (tray) menuBarItemRemoval.remove(trayItem(tray)) // a title on show is cleared first, the item removed once that is drawn
  dockIcon.show()
  updateBadge()
  log.info('menu-bar mode left')
}

/** The item's actions: Open Kea, a session, Quit Kea Completely (the tray's menu, its `click` never comes on Linux). */
const trayActions = { openKea: () => openKea({}, 'tray'), showSession: (id: string) => openKea({ sessionId: id }, 'tray'), quit: () => app.quit(), restart: () => updates.restart() }
/** The tray's restart item while an update waits for a restart (Restart to Update, Restart Kea); null otherwise. */
const trayRestart = (): string | null => (updates.title === 'Check for Updates…' ? null : updates.title)

/** The item's title (the needs-you count; on Linux, which shows none, the first line of its menu) and its menu, from core's state. */
function updateTray(): void {
  const tray = background.tray
  if (!tray) return
  const bg = need(mainOs.background)
  bg.setTitle(tray, trayTitle(menuBarState))
  tray.setToolTip(trayTooltip(menuBarState))
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(menuBarState, trayActions, { countLine: bg.countInMenu, restart: trayRestart() })))
}

// ── resources (resources.ts) ────────────────────────────────────────────────────────

// A window's renderer answers `kea:resources` through the preload with its report (validated: zResourcesReply)
const rendererReports = new Replies<ResourceReport>()
ipcMain.on('kea:resources', (e, msg: unknown) => {
  const w = fromOurWindow(e)
  if (!w) return
  const r = zResourcesReply.safeParse(msg)
  if (!r.success) {
    log.warn('resource report refused', { error: r.error.issues[0]?.message })
    return
  }
  rendererReports.answer(r.data.reqId, r.data.report, w.webContents.id)
})

function reportSources(): ReportSource[] {
  const child = (name: 'core' | 'ptyhost'): ReportSource => {
    const u = ready(name)
    return u ? { name, ask: () => u.report(L.resourceReportTimeoutMs) } : { name, absent: 'not running' }
  }
  const renderers = [...windows.entries()].map(([id, w], i): ReportSource => {
    const name = rendererKey(i, id)
    if (w.isDestroyed()) return { name, absent: 'not running' }
    return { name, ask: () => rendererReports.ask((reqId) => w.webContents.send('kea:resources', { reqId }), L.resourceReportTimeoutMs, id) }
  })
  // A closed window holds no renderer; the line says so rather than leaving it out
  if (renderers.length === 0) renderers.push({ name: 'renderer', absent: 'no window' })
  return [{ name: 'main', ask: () => Promise.resolve(resources.report()) }, child('core'), child('ptyhost'), ...renderers]
}

/**
 * Kea's processes for the footprint sampler: those `app.getAppMetrics()` lists and, on Linux, Chromium's zygotes, which
 * it does not; each named from what main knows.
 */
function processPids() {
  const known = new Map<number, string>([[process.pid, 'main']])
  for (const name of ['core', 'ptyhost'] as const) {
    const pid = children[name].current?.pid
    if (pid) known.set(pid, name)
  }
  ;[...windows.entries()].forEach(([id, w], i) => {
    if (!w.isDestroyed()) known.set(w.webContents.getOSProcessId(), rendererKey(i, id))
  })
  return nameProcesses([...app.getAppMetrics(), ...mainOs.zygotes.of(process.pid).map((pid) => ({ pid, type: 'Zygote' }))], known)
}

// the hourly line rides on the sampler's interval, written whether or not that interval's sample succeeded
// (and so does the watchdog, with the same sample)
const sampler = new FootprintSampler({
  helper: RUN_HELPER,
  pids: processPids,
  log,
  onInterval: (s) => {
    resourceLog.tick(s)
    if (!watchdogFed) watchdog.tick(s)
  },
})
const resourceLog = new ResourceLog({ dir: path.join(HOME, 'logs'), collect: () => collectReports(reportSources()), sampler })

// ── the memory watchdog (watchdog.ts) ───────────────────────────────────────────────

/**
 * The watchdog's "no input": how long the person has given the machine none, in any app (the system's idle
 * time: keyboard, mouse and trackpad). Input to Kea counts, and so does work in the app beside it, where a window
 * reloading in view would be seen. A test stands in for it (`__keaTest.watchdogIdle`), so no test waits
 * L.watchdogIdleMs with nobody at the machine.
 */
let idleOverride: number | null = null
/** The system's idle count has read above 0 in this run, so the compositor gives Chromium one. */
let systemIdleSeen = false
/** The last input to one of Kea's windows: the idle time where the system has none. */
let lastKeaInput = performance.now()
/** Kea follows input to its own windows only where the system's count may be missing (Linux's Wayland compositors). */
const TRACKS_INPUT = mainOs.idle.source({ display: DISPLAY, mutterIdleMonitor: null, systemSeenAboveZero: false }) === 'kea'

function idleSource(): IdleSource {
  return mainOs.idle.source({ display: DISPLAY, mutterIdleMonitor: services.idleMonitor, systemSeenAboveZero: systemIdleSeen })
}

/** The watchdog's idle time: the system's, or the time since the last input to Kea's windows where it has none. */
function idleMs(): number {
  if (idleOverride !== null) return idleOverride
  const system = powerMonitor.getSystemIdleTime() * 1000
  if (system > 0) systemIdleSeen = true
  return idleSource() === 'system' ? system : performance.now() - lastKeaInput
}
/** A test feeds the watchdog its samples (`__keaTest.watchdogFeed`): from the first one on, the sampler's own intervals no longer reach it. */
let watchdogFed = false
/** Told when core or ptyhost is next ready (`onChildReady`): a watchdog restart of it is under way until then. */
const readyWaiters: Record<'core' | 'ptyhost', (() => void)[]> = { core: [], ptyhost: [] } // bounded: one per restart under way, so at most one per child (never a second action while one is under way)

const watchdog = new Watchdog({
  log,
  idleMs,
  line: (triggers, s) => resourceLog.write('watchdog', { footprint: s, watchdog: triggers }),
  act: watchdogAct,
  // a renderer is followed by its window (its webContents id), whatever place it has among the windows when it is
  // sampled: `rendererKey` names the first one `renderer`, and which one is first changes when a window closes. One
  // whose window has gone since the sample is nobody's: it keeps a role of its own until the next sample drops it
  role: (name, pid) => {
    if (limitKind(name) !== 'renderer') return name
    for (const [id, w] of windows) if (!w.isDestroyed() && w.webContents.getOSProcessId() === pid) return `window:${id}`
    return `renderer-pid:${pid}`
  },
})

/**
 * The watchdog's actions, each by the way a crash of that process is already met, never a second one; resolves when the
 * action is over. The trigger names the process the sample measured: one that has gone since is left to its
 * replacement.
 */
function watchdogAct(t: WatchdogTrigger & { action: WatchdogAction }): Promise<void> {
  if (quitting) return Promise.resolve()
  if (t.action === 'restart') {
    // core, ptyhost: the Supervisor's restart (kill, then a new one at once, no backoff); the windows follow as after a
    // crash (a new RPC port; `kea:streamsReset`). Over once the new one is ready
    const name = t.process === 'core' || t.process === 'ptyhost' ? t.process : null
    if (!name || children[name].current?.pid !== t.pid) return Promise.resolve()
    return new Promise((resolve) => {
      readyWaiters[name].push(resolve)
      void children[name].sup.restart()
    })
  }
  if (t.action === 'reload') {
    // the window whose renderer was measured: reloaded as Developer › Reload Window does, so its connection scopes go
    // (`did-start-navigation`) and every terminal reattaches from ptyhost's snapshots, as after a renderer crash. Over
    // once it has loaded, failed to, or closed
    const w = [...windows.values()].find((x) => !x.isDestroyed() && x.webContents.getOSProcessId() === t.pid)
    if (!w) return Promise.resolve()
    return new Promise((resolve) => {
      const wc = w.webContents
      const ended = (how: 'loaded' | 'failed' | 'closed') => (): void => {
        wc.removeListener('did-finish-load', loaded)
        wc.removeListener('did-fail-load', failed)
        w.removeListener('closed', closed)
        log.debug('watchdog: window reload over', { how })
        resolve()
      }
      const loaded = ended('loaded')
      const failed = ended('failed')
      const closed = ended('closed')
      wc.on('did-finish-load', loaded)
      wc.on('did-fail-load', failed)
      w.on('closed', closed)
      wc.reload()
    })
  }
  // the GPU process: every window clears its glyph atlases, then makes its WebGL renderers anew
  for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send('kea:gpuReset')
  return Promise.resolve()
}

// Copy diagnostics and the dev HUD: a window asks for what the hourly line holds, every process's report and the newest
// footprint sample. Asks that arrive while a collection is under way share it, so there is never more than one for the
// windows; it ends at the processes' own deadline (L.resourceReportTimeoutMs).
let collectingForWindows: Promise<CollectedResources | null> | null = null
function collectForWindows(): Promise<CollectedResources | null> {
  collectingForWindows ??= collectReports(reportSources())
    .then(
      (c): CollectedResources => {
        const s = sampler.latest
        return { ...c, footprint: s ? { t: new Date(s.t).toISOString(), bytes: s.bytes, ...(s.errors ? { errors: s.errors } : {}) } : null }
      },
      () => null,
    )
    .finally(() => {
      collectingForWindows = null
    })
  return collectingForWindows
}
ipcMain.on('kea:resourceReports', (e, req: unknown) => {
  const w = fromOurWindow(e)
  const reqId = (req as { reqId?: unknown } | null)?.reqId
  if (!w || typeof reqId !== 'number') return
  const wc = w.webContents
  void collectForWindows().then((collected) => {
    if (!wc.isDestroyed()) wc.send('kea:resourceReports', { reqId, collected })
  })
})

// ── the platform report ─────────────────────────────────────────────────────────────

/** Core's watcher holds an inotify limit (core's `watchLimit` message); null while no core is ready. */
let watchLimitHeld: boolean | null = null

/**
 * The report now: this system's lines (the OS layer's `report`), from what main knows (the display server, the
 * desktop's services, the idle source, Chromium's WebGL2) and what core and the window say (core's watcher holds an
 * inotify limit; the window's renderer is sandboxed). Null where the system has none.
 */
function buildPlatformReport(): PlatformReport | null {
  if (!isAvailable(mainOs.report)) return null
  const held = watchLimitHeld
  const w = menuWindow()
  const gpu = app.getGPUFeatureStatus() as unknown as Record<string, string | undefined>
  return mainOs.report.platform({
    version: process.getSystemVersion(),
    arch: process.arch,
    resourcesDir: process.resourcesPath,
    execPath: process.execPath,
    webgl2: webglState(gpu),
    trayHost: services.trayHost,
    notificationService: services.notifications,
    rendererPid: w && !w.isDestroyed() ? w.webContents.getOSProcessId() : null,
    corePid: children.core.current?.pid ?? null,
    idle: idleSource(),
    watchLimitHeld: held,
    display: DISPLAY,
    desktopId: DESKTOP_ID,
    displayScale: app.isReady() ? screen.getPrimaryDisplay().scaleFactor : null,
    updates: UPDATE_HOW,
  })
}

/** The report kept and handed to core (platformReport.ts): at each core's start, a window's start, and each change. */
const platformReports = new PlatformReports({
  build: buildPlatformReport,
  send: (report) => {
    const core = ready('core')
    if (!core) return false
    core.post({ k: 'platform', report })
    return true
  },
  log,
})
// Whether Chromium has WebGL2 can change after the start (the GPU process starting, failing, or given up on)
app.on('gpu-info-update', () => void platformReports.assemble('gpu'))
app.on('child-process-gone', (_e, d) => {
  if (d.type === 'GPU') platformReports.assemble('gpu')
})

// the windows' log, `<KEA_HOME>/logs/renderer.log` (rendererLog.ts)
const rendererLogFile = createLogger({ dir: path.join(HOME, 'logs'), process: 'renderer', level: 'warn' })
const rendererLog = new RendererLog(rendererLogFile)

// main's rows of the resource report, beside kit's own (`kit.children.*` counts the footprint runs)
registerSingletonGauge('main.windows', () => windows.size)
registerSingletonGauge('main.connections', () => connections.size)
registerSingletonGauge('main.menuStates', () => {
  let entries = 0
  for (const m of menuStates.values()) entries += m.commands.size + Object.keys(m.keys).length
  return { windows: menuStates.size, entries }
})
registerSingletonGauge('main.metricsSamples', () => sampler.size)
registerSingletonGauge('main.reportRequests', () => rendererReports.size + (children.core.current?.pendingReports ?? 0) + (children.ptyhost.current?.pendingReports ?? 0))
registerSingletonGauge('main.menuBarItem', () => (background.tray ? 1 : 0))
registerSingletonGauge('main.notifications', () => notifier.size)
registerSingletonGauge('main.keaFileDirs', () => keaFileDirs.size)
registerSingletonGauge('main.watchdog', () => watchdog.counts())
registerSingletonGauge('main.updates', () => updates.counts())
registerSingletonGauge('main.packageWatch', () => (packageWatch ? 1 : 0))

// ── updates (updates/) ──────────────────────────────────────────────────────────────

/** The update check's world under the test hooks (a dev build under --kea-perf only): an install kind, a stand-in feed, a delay. */
const UPDATE_HOOKS = DEV && PERF ? updateTestHooks(process.argv) : null
/** This run uses the default home, where automatic checks may run: no `--kea-home`, no `--kea-perf`. */
const DEFAULT_HOME = HOME === keaHome({ packaged: app.isPackaged, argv: [], homedir: os.homedir() }) && !PERF
const REPO = RELEASE_REPOSITORY ? parseRepository(RELEASE_REPOSITORY) : null
const INSTALL_KIND: InstallKind | null = UPDATE_HOOKS?.kind ?? (isAvailable(mainOs.installKind) ? mainOs.installKind.read(process.resourcesPath) : null)
/** How this install is updated (the OS layer's `updates`), worked out once at start; the test hooks may leave the macOS updater out. */
const UPDATE_HOW = ((how) => (UPDATE_HOOKS?.command && how.mode === 'updater' ? { ...how, mode: 'command' as const } : how))(
  REPO ? mainOs.updates.how({ kind: INSTALL_KIND, repository: RELEASE_REPOSITORY, defaultHome: DEFAULT_HOME || !!UPDATE_HOOKS, resourcesDir: process.resourcesPath }) : NOT_FROM_RELEASE,
)
const RELEASE_ARCH: ReleaseArch | null = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : null
/** The newest release's files: GitHub's, or the stand-in's under the test hooks. */
const FEED_BASE = UPDATE_HOOKS?.feed ?? (RELEASE_REPOSITORY ? releaseUrls(RELEASE_REPOSITORY).latest : null)
const allowedUpdateUrl = REPO ? updateUrlAllowed(REPO, UPDATE_HOOKS?.feed ? new URL(UPDATE_HOOKS.feed).origin : null) : () => false
/** The update check's session: in memory (no `persist:`), so no cookie jar or cache on disk; made at the first check. */
let updateSession: Session | null = null

function updateFetch() {
  if (!updateSession) {
    updateSession = session.fromPartition('kea-updates')
    installUpdateFilters(updateSession, allowedUpdateUrl, UPDATE_HEADERS, (url) => log.warn('update request refused', { url: url.split('?')[0] }))
  }
  return updateSessionFetch(updateSession)
}

/** The macOS updater, from its own bundle; under the test hooks it reads the stand-in feed from a file it is given. */
function makeUpdaterDriver(on: UpdaterEvents): UpdaterDriver {
  const make = mainOs.updates.loadUpdater(DIST)
  if (!make || !FEED_BASE) throw new Error('this build has no updater')
  let testConfigPath: string | undefined
  if (UPDATE_HOOKS?.feed) {
    testConfigPath = path.join(HOME, 'test-app-update.yml')
    fs.writeFileSync(testConfigPath, `provider: generic\nurl: ${UPDATE_HOOKS.feed}\nupdaterCacheDirName: kea-updater-test\n`, { mode: 0o600 })
  }
  return make({
    url: FEED_BASE,
    allowed: allowedUpdateUrl,
    headers: UPDATE_HEADERS,
    fetchTimeoutMs: L.updateFetchTimeoutMs,
    stallMs: L.updateStallMs,
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
    on,
    ...(testConfigPath ? { testConfigPath } : {}),
  })
}

/** The update state changed: the windows are told, and the menu and the tray say Restart to Update or Restart Kea. */
function updateStateChanged(state: UpdateState): void {
  for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send('kea:updateState', { state })
  rebuildMenu()
  updateTray()
  platformReports.assemble('updates')
}

const updates = new UpdateManager({
  version: VERSION,
  how: UPDATE_HOW,
  autoAllowed: DEFAULT_HOME || !!UPDATE_HOOKS,
  ...(UPDATE_HOOKS?.delayMs != null ? { firstDelayMs: UPDATE_HOOKS.delayMs } : {}),
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
  },
  marks: { load: () => readMarks(app.getPath('userData')), save: (m) => writeMarks(app.getPath('userData'), m) },
  feed: () => {
    const kind = mainOs.updates.releaseFile(INSTALL_KIND)
    if (!kind || !RELEASE_ARCH || !FEED_BASE) return Promise.resolve(null)
    return checkFeed({ fetch: updateFetch(), url: `${FEED_BASE}SHA256SUMS`, kind, arch: RELEASE_ARCH, timeoutMs: L.updateFetchTimeoutMs, maxBytes: L.updateFeedMaxBytes })
  },
  makeDriver: UPDATE_HOW.mode === 'updater' ? makeUpdaterDriver : null,
  changed: (state) => updateStateChanged(state),
  beforeRestart: () => keepDrafts(),
  // Restart Kea, asked for by the person: whatever restarts this run already made
  relaunch: () => void relaunchKea(treeVersion(process.resourcesPath) ?? 'unknown'),
  log,
})
// where Kea updates itself: did the version Squirrel had ready install?
updates.checkInstalled()

/**
 * Check for Updates…: Restart to Update or Restart Kea while one is offered; otherwise Kea opens (with no window),
 * Settings › About shows, and a check starts.
 */
function checkUpdatesCommand(): void {
  if (updates.title !== 'Check for Updates…') {
    updates.restart()
    return
  }
  const w = menuWindow()
  if (w && !background.background && connections.has(w.webContents.id)) w.webContents.send('kea:command', { id: 'app.settings', args: { page: 'about' } })
  else pendingAbout = true
  openKea()
  updates.checkNow()
}

ipcMain.on('kea:updateState', (e) => {
  const w = fromOurWindow(e)
  if (w) w.webContents.send('kea:updateState', { state: updates.state })
})
// About's Check Now and Try Again: a check, nothing else
ipcMain.on('kea:checkUpdates', (e) => {
  if (fromOurWindow(e)) updates.checkNow()
})
ipcMain.on('kea:restartToUpdate', (e) => {
  if (fromOurWindow(e)) updates.restart()
})
// the line saying Kea checks for updates was in view, or About's Updates block was opened
ipcMain.on('kea:updateNoticeShown', (e) => {
  if (fromOurWindow(e)) updates.noticeShown()
})

/** Keep the window's composer drafts for the next start (a restart Kea makes itself), as the Wayland rebuild hands them over. */
async function keepDrafts(): Promise<void> {
  const w = menuWindow()
  if (!w || w.isDestroyed() || !connections.has(w.webContents.id)) return
  await handoff.ask((reqId) => w.webContents.send('kea:handoffAsk', { reqId }))
  const state = handoff.state
  if (!state || state.drafts.length === 0) return
  try {
    writeHandoff(app.getPath('userData'), state, Date.now())
  } catch (e) {
    log.warn('drafts not kept for the restart', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** The restarts Kea would have made under the test hooks, which record them instead. */
const relaunchRequests: string[] = [] // bounded: the newest L.logMemoryEntries (an in-memory log for tests)
let relaunching = false

/** Restart Kea into the files on disk (`target`: their version), the drafts kept; nothing while it quits. */
async function relaunchKea(target: string): Promise<void> {
  if (quitting || relaunching) return
  relaunching = true
  await keepDrafts()
  if (PERF) {
    log.info('restart not made (perf)', { target })
    relaunchRequests.push(target)
    if (relaunchRequests.length > L.logMemoryEntries) relaunchRequests.shift()
    relaunching = false
    return
  }
  log.info('restarting Kea', { target })
  app.relaunch({ args: relaunchArgs(process.argv, target) })
  app.quit()
}

/** Kea's files replaced or removed under it (Linux packages; a rebuilt dev tree): see updates/upgrade.ts. */
const upgrade = new UpgradeGuard({
  running: VERSION,
  relaunchedFor: relaunchedFor(process.argv),
  identity: (() => {
    const stat = plainStat()
    return () => asarIdentity(process.resourcesPath, stat)
  })(),
  treeVersion: () => treeVersion(process.resourcesPath),
  upgraded: (version) => {
    stopPackageWatch()
    updates.upgraded(version)
  },
  removed: () => {
    stopPackageWatch()
    updates.removed()
  },
  relaunch: (target) => void relaunchKea(target),
  log,
})

/** The package watch (deb and rpm): `resources/` followed, `app.asar` compared once a change settles. */
let packageWatch: (() => void) | null = null
function stopPackageWatch(): void {
  packageWatch?.()
  packageWatch = null
}
function startPackageWatch(): void {
  if (!isAvailable(mainOs.packageWatch) || (INSTALL_KIND !== 'deb' && INSTALL_KIND !== 'rpm')) return
  packageWatch = mainOs.packageWatch.watch(
    process.resourcesPath,
    () => upgrade.check(),
    (e) => {
      // a respawn and a child of another build still find it
      log.warn('package watch not running', { error: e instanceof Error ? e.message : String(e) })
      packageWatch = null
    },
  )
}

// ── security ────────────────────────────────────────────────────────────────────────

const CSP = ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: kea-file:", "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-src 'none'"].join('; ')

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json' }

function serveUi(req: Request): Response {
  const url = new URL(req.url)
  if (url.host !== 'app') return new Response('not found', { status: 404 })
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  const file = path.resolve(RENDERER_DIR, rel)
  if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('forbidden', { status: 403 })
  try {
    const body = fs.readFileSync(file)
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

app.on('web-contents-created', (_e, contents: WebContents) => {
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith('kea://app/')) e.preventDefault()
  })
  contents.on('will-attach-webview', (e) => e.preventDefault())
  // links from the terminal: only http, https and mailto reach the system; no window ever opens
  contents.setWindowOpenHandler(({ url }) => {
    if (openLink(url, browser) === null) log.warn('link not opened', { scheme: url.slice(0, url.indexOf(':') + 1).slice(0, 32) })
    return { action: 'deny' }
  })
})

// ── lifecycle ───────────────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  log.info('second instance')
  openKea({}, 'secondInstance')
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  background.dispose()
  servicesWatch?.dispose()
  servicesWatch = null
  menuBarItemRemoval.dispose()
  dockIcon.dispose()
  coreAvailability.quit()
  notifier.dispose()
  sampler.dispose()
  rendererReports.dispose()
  resourceLog.dispose()
  rendererLogFile.dispose()
  updates.dispose()
  stopPackageWatch()
  void shutdownChildren([children.ptyhost, children.core]).finally(() => app.exit(0)) // lifecycle.ts
})

// On macOS the window closing never quits Kea; it stays in the Dock and reopens on activate. On Linux, with no Dock,
// Kea goes to the background while sessions run and a tray host is there to reopen it from, and quits otherwise (its
// sessions keep running in their holders)
app.on('window-all-closed', () => {
  rebuildMenu()
  if (quitting || background.background || !isAvailable(mainOs.background)) return
  const action = lastWindowAction({ lastWindow: mainOs.background.lastWindow, background: background.canRunInBackground, live: menuBarState?.live ?? 0 })
  if (action === 'stay') return
  log.info('last window closed', { action })
  if (action === 'background') enterMenuBar()
  else app.quit()
})

void app.whenReady().then(() => {
  perfMarks.ready = performance.now()
  // what Electron draws itself in the system's colours (Linux: dark, as the window is)
  const theme = isAvailable(mainOs.windowChrome) ? mainOs.windowChrome.nativeTheme : null
  if (theme) nativeTheme.themeSource = theme
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
  protocol.handle('kea', serveUi)
  protocol.handle(KEA_FILE_SCHEME, (req) => serveKeaFile(req, keaFileDirs.all(), (why, status) => log.warn('kea-file refused', { why, status })))
  if (DEV && PERF)
    installTestApi({
      children,
      windows: () => windows.size,
      ipcMain,
      resourceLine: () => resourceLog.write('test', { sample: true }),
      // The watchdog in a test's hands: the person's idle time, and one interval on a sample the test weighs
      watchdogIdle: (ms) => void (idleOverride = ms),
      watchdogFeed: async (bytes) => {
        const s = await sampler.sample()
        if (!s) throw new Error('no footprint sample')
        for (const name of Object.keys(bytes)) if (!(name in s.pids)) throw new Error(`no process named ${name} in the sample (${Object.keys(s.pids).join(', ')})`)
        watchdogFed = true
        const tick = watchdog.tick({ ...s, bytes: { ...s.bytes, ...bytes } })
        await tick.done
        return tick.triggers
      },
      queueFolder: (p) => folderQueue.push(p),
      // The menu-bar item as a test sees it (no test can click the real menu bar), and a click on one of its items
      menuBar: () => ({ item: background.tray !== null, background: background.background, trayHost: services.trayHost, title: background.tray ? need(mainOs.background).title(background.tray) : null, dock: isAvailable(mainOs.background) ? mainOs.background.dockVisible(app) : null, state: menuBarState, sheetSeen: quitSheetSeen(app.getPath('userData')) }),
      clickMenuBarItem: (id) => {
        const t = trayTemplate(menuBarState, trayActions, { countLine: isAvailable(mainOs.background) && mainOs.background.countInMenu, restart: trayRestart() }).find((x) => x.id === id)
        if (!background.tray || !t?.click) return false
        ;(t.click as () => void)()
        return true
      },
      // what would have reached the system, and a click on a live notification
      notifications: () => ({ log: [...recorder!.log], live: notifier.liveTags(), badge: recorder!.badge, permissionDenied: notifier.permissionDenied }),
      clickNotification: (tag) => recorder!.click(tag),
      opened: () => [...openedLinks!.log],
      focus: (v) => {
        focusOverride = v
        sendFocus()
      },
      // The harness says whether a screen reader runs (no test starts VoiceOver)
      screenReader: (v) => {
        screenReaderOverride = v
        sendScreenReader()
      },
      // The harness says whether a post shows (the recorder answers as the system would)
      denyNotifications: (v) => void (recorder!.denied = v),
      // The platform report as Settings › About shows it, and the window's menu with where it was asked to open
      platformReport: () => Promise.resolve(platformReports.assemble('test')),
      menu: () => ({ menus: menuNow.map((m) => String(m.label ?? m.role ?? '')), opened: [...menuOpenings] }),
      // The Wayland rebuild of a minimized window, forced (the Linux harness's Xvfb never takes that path)
      rebuildWindow: async () => {
        const w = menuWindow()
        if (!w) return false
        await rebuildWindow(w)
        return true
      },
      // The update check, the restarts Kea would have made, and Kea's files replaced under it
      updates: () => ({ state: updates.state, title: updates.title, relaunches: [...relaunchRequests], core: updates.coreSwitch, timers: updates.counts().timers }),
      checkUpdates: () => checkUpdatesCommand(),
      upgraded: (version) => upgrade.replaced(version),
    })
  children.ptyhost.sup.start()
  children.core.sup.start()
  sampler.start()
  // The tray host, the notification service and the idle monitor, followed as they come and go
  servicesWatch = mainOs.desktopServices.watch((st) => servicesChanged(st))
  rebuildMenu()
  // the drafts a restart Kea made itself kept for this start go to its first window
  const kept = takeHandoff(app.getPath('userData'), Date.now())
  if (kept) {
    handoff.restore(kept)
    handoff.giveTo(createWindow({ handoff: true }).webContents.id)
    log.info('drafts restored after a restart', { drafts: kept.drafts.length })
  } else createWindow()
  // a package manager replacing Kea's files under it (deb, rpm)
  startPackageWatch()
  // the Dock icon clicked, or Kea opened again from Finder while it runs from the menu bar
  app.on('activate', () => {
    if (windows.size === 0) openKea()
  })
  // The glyph atlases are refreshed after sleep; an update check that came due while asleep, or failed, runs
  powerMonitor.on('resume', () => {
    for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send('kea:wake')
    updates.resume()
  })
  // a test build never stays the frontmost app (frontGuard.ts): made active (as macOS may when the display wakes), it
  // hides at once and says so; nothing is installed without --kea-perf, nor where the system has no app in front (Linux:
  // a test build draws on the harness's own X server)
  installFrontGuard(
    PERF && isAvailable(mainOs.front),
    {
      onActive: (cb) => need(mainOs.front).onActive(app, cb),
      onWake: (cb) => {
        need(mainOs.power).onDisplayWake(electron, () => cb('display'))
        powerMonitor.on('unlock-screen', () => cb('unlock'))
        powerMonitor.on('resume', () => cb('resume'))
      },
      isActive: () => need(mainOs.front).isActive(app),
      hide: () => need(mainOs.front).hide(app),
      now: () => performance.now(),
    },
    log,
  )
})

perfMarks.topLevel = performance.now()
if (PERF) (globalThis as Record<string, unknown>).__keaPerfMain = perfMarks

function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16)
}
