// Test hooks for the chaos and leak suites. Installed only by a dev build run with `--kea-perf`: a packaged build never
// installs them, a perf-probe build included, so they add no reach to anything signed.
//
// · Core and ptyhost load `tests/support/app-child-hooks.cjs` before their own code, through NODE_OPTIONS (a
//   utilityProcess ignores `--require` in its execArgv, while NODE_OPTIONS works as long as the nodeOptions fuse is on,
//   as in npm's Electron). The hook answers `{ k: 'kea-test' }` messages on parentPort: forced GC, heap
//   statistics, active handles, kit's resource report, live MessagePort count, heap snapshots, stream-port message
//   counts, an injected bug (`fault`: an uncaught exception or unhandled rejection), and core held for good at
//   a fault point of a creation, delete or restore (`hold`, C-KILL-9/10/15), and the status engine driven through its
//   seam (`status`, core only; L-MEM-19), and replies held back behind store deltas (`lateReplies`, C-RACE-7), and a
//   watch over the timers that fire in the process (`timers`, P-CPU-2), and a search of its binary memory for marker
//   strings (`scan`, L-MEM-4), and the child processes it started, by argv (`children`, L-MEM-13). It removes
//   NODE_OPTIONS from its process at once, so nothing the child starts (the login-shell probe, holders, shells)
//   inherits it.
// · Main exposes `globalThis.__keaTest` to the harness (`tests/support/app.ts`, through Playwright's `app.evaluate`):
//   the children's pids, `debug(name, op)` relayed to a child's hook, a supervisor restart, main's own counts and GC,
//   and `resourceLine()`: a footprint sample and a `resources.ndjson` line now (L-MEM-20), instead of on the
//   hour; the menu-bar item's state and a click on one of its items (no test can reach the real menu bar); the
//   notifications and badge main would have shown (a test build records them, notifier.ts, and never posts one), a
//   click on a live one, and a stand-in for the window's keyboard focus (a test window can never take it);
//   the links that would have been opened in the browser (external.ts records them); whether a screen
//   reader runs, as the windows are told (no test starts VoiceOver); the memory watchdog's world (how
//   long the person has been idle, and one interval on a footprint sample in which the processes a test names weigh
//   what it says, so the watchdog's actions run without a byte being allocated); the Wayland rebuild of the window
//   (`rebuildWindow`: a minimized window on Wayland, forced on any system); the update state, a forced "files
//   replaced under Kea", and the restarts Kea would have made for it (recorded, never made).
// · The update check's world comes from main's command line (`updateTestHooks`): a forced install kind, a stand-in
//   feed on 127.0.0.1 (the only http allowed), a short first delay, and the macOS updater left out
//   (`--kea-test-update-command`); the default-home rule is lifted.

import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { ipcMain as IpcMain } from 'electron'
import { INSTALL_KINDS, type InstallKind } from '@kea/protocol'
import type { Recorded } from './notifier.ts'
import type { UtilityChild } from './utility.ts'

export type TestOp = 'gc' | 'heap' | 'handles' | 'kit' | 'ports' | 'snapshot' | 'streams' | 'fault' | 'hold' | 'status' | 'lateReplies' | 'timers' | 'scan' | 'alloc' | 'children'
const OPS: readonly TestOp[] = ['gc', 'heap', 'handles', 'kit', 'ports', 'snapshot', 'streams', 'fault', 'hold', 'status', 'lateReplies', 'timers', 'scan', 'alloc', 'children']

/** The hook file next to the dev build (dist/<name> → tests/support), or null when this checkout has none. */
export function childHookPath(dist: string): string | null {
  const file = path.resolve(dist, '..', '..', 'tests', 'support', 'app-child-hooks.cjs')
  return fs.existsSync(file) ? file : null
}

/** The environment a child gets when hooks are on: main's own plus NODE_OPTIONS loading the hook first. */
export function childHookEnv(hook: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.NODE_OPTIONS = `--require ${JSON.stringify(hook)}`
  return env
}

type Children = Record<'core' | 'ptyhost', { current: UtilityChild | null; sup: { restart(): Promise<void> } }>

/** The menu-bar item as a test sees it: whether it exists, its title, the Dock icon, core's state, the sheet mark. */
export type MenuBarProbe = { item: boolean; background: boolean; trayHost: boolean | null; title: string | null; dock: boolean | null; state: unknown; sheetSeen: boolean }

/** The window's menu as a test sees it: its menus' titles, and each opening the header asked for (none opens under --kea-perf). */
export type MenuProbe = { menus: string[]; opened: { x: number; y: number }[] }

/** The notifications as a test sees them: what was recorded, the tags live now, the badge, the denied flag. */
export type NotificationsProbe = { log: Recorded[]; live: string[]; badge: string; permissionDenied: boolean }

/** The update check's world under the test hooks, from main's command line; null when none of it is given. */
export type UpdateTestHooks = { kind: InstallKind | null; feed: string | null; delayMs: number | null; command: boolean }

export function updateTestHooks(argv: readonly string[]): UpdateTestHooks | null {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const kind = get('kea-test-install-kind')
  const feed = get('kea-test-update-feed')
  const delay = get('kea-test-update-delay')
  // the macOS updater left out, so a Mac run takes the check that reads the release's list of files
  const command = argv.includes('--kea-test-update-command')
  if (kind === undefined && feed === undefined && delay === undefined && !command) return null
  // the stand-in is on this machine, over http, and nowhere else
  const local = feed !== undefined && /^http:\/\/127\.0\.0\.1:\d+\/.*\/$/.test(feed) ? feed : null
  const ms = delay === undefined ? Number.NaN : Number(delay)
  return { kind: (INSTALL_KINDS as readonly string[]).includes(kind ?? '') ? (kind as InstallKind) : null, feed: local, delayMs: Number.isInteger(ms) && ms >= 0 ? ms : null, command }
}

/** The update check as a test sees it: main's state, the menu item's title, the restarts Kea would have made, core's switch as main last heard it, the timers it holds. */
export type UpdatesProbe = { state: unknown; title: string; relaunches: string[]; core: boolean | null; timers: number }

/** `globalThis.__keaTest` for the harness. */
export function installTestApi(o: {
  children: Children
  windows: () => number
  ipcMain: typeof IpcMain
  resourceLine: () => Promise<unknown>
  watchdogIdle: (ms: number | null) => void
  watchdogFeed: (bytes: Record<string, number>) => Promise<unknown>
  queueFolder: (p: string) => void
  menuBar: () => MenuBarProbe
  clickMenuBarItem: (id: string) => boolean
  notifications: () => NotificationsProbe
  clickNotification: (tag: string) => boolean
  opened: () => string[]
  focus: (focused: boolean | null) => void
  screenReader: (on: boolean) => void
  denyNotifications: (on: boolean) => void
  platformReport: () => Promise<unknown>
  menu: () => MenuProbe
  rebuildWindow: () => Promise<boolean>
  updates: () => UpdatesProbe
  checkUpdates: () => void
  upgraded: (version: string | null) => void
}): void {
  let next = 1
  let gc: ((options?: unknown) => void) | null = null
  const api = {
    pids(): Record<'core' | 'ptyhost', number | null> {
      return { core: o.children.core.current?.pid ?? null, ptyhost: o.children.ptyhost.current?.pid ?? null }
    },
    /** One op in a child's hook (app-child-hooks.cjs); rejects when the child exits first. A stopped child answers once it is
     *  continued: the harness puts its own deadline on the call. */
    debug(name: 'core' | 'ptyhost', op: TestOp, arg?: string): Promise<unknown> {
      const u = o.children[name]?.current
      if (!u) return Promise.reject(new Error(`${name} is not running`))
      if (!OPS.includes(op)) return Promise.reject(new Error(`unknown op ${op}`))
      const id = next++
      return new Promise((resolve, reject) => {
        const off = u.onTestReply((m) => {
          if (m.id !== id) return
          if (m.ok) done(null, m.value)
          else done(new Error(`${name} ${op}: ${String(m.error)}`))
        })
        const exited = u.onExit(() => done(new Error(`${name} exited`)))
        function done(e: Error | null, v?: unknown): void {
          off.dispose()
          exited.dispose()
          if (e) reject(e)
          else resolve(v)
        }
        u.postTest({ k: 'kea-test', id, op, arg })
      })
    },
    /** The supervisor's restart (kill, then respawn without backoff: the memory watchdog's path), for L-MEM-8. */
    restart(name: 'core' | 'ptyhost'): Promise<void> {
      return o.children[name].sup.restart()
    },
    /** Main's own counts (L-MEM-5): windows, listeners on main's IPC channels, handles, heap. */
    counts(): Record<string, number> {
      const out: Record<string, number> = { windows: o.windows() }
      for (const ch of o.ipcMain.eventNames()) out[`ipc:${String(ch)}`] = o.ipcMain.listenerCount(ch)
      for (const r of process.getActiveResourcesInfo()) out[`handle:${r}`] = (out[`handle:${r}`] ?? 0) + 1
      const h = v8.getHeapStatistics()
      out.heapUsed = h.used_heap_size
      return out
    },
    /** A fresh footprint sample, then one `resources.ndjson` line (trigger `test`); resolves with the line's fields. */
    resourceLine(): Promise<unknown> {
      return o.resourceLine()
    },
    /**
     * How long the person has given no input, as the memory watchdog takes it (hard limits act only when idle);
     * null goes back to the system's own idle time.
     */
    watchdogIdle(ms: number | null): void {
      if (ms !== null && !(typeof ms === 'number' && ms >= 0)) throw new Error('watchdogIdle takes milliseconds or null')
      o.watchdogIdle(ms)
    },
    /**
     * One watchdog interval now, on a fresh footprint sample in which each process named in `bytes`
     * (`core`, `ptyhost`, `renderer`, `gpu`, as the sample names them) weighs that much; the others weigh what they do.
     * From the first call on, the sampler's own intervals no longer reach the watchdog, so an episode ends only when a
     * test's next sample says so. Resolves with the interval's triggers once its line is written and its actions are over.
     */
    watchdogFeed(bytes: Record<string, number>): Promise<unknown> {
      if (typeof bytes !== 'object' || bytes === null || Object.values(bytes).some((b) => typeof b !== 'number')) return Promise.reject(new Error('watchdogFeed takes bytes by process name'))
      return o.watchdogFeed(bytes)
    },
    /**
     * The folder the next folder pick returns (Add Project ⌘O, Locate…): under --kea-perf no native
     * dialog is shown, so the harness says what the person would have picked (native.ts). One call per pick.
     */
    queueFolder(p: string): void {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('queueFolder takes an absolute path')
      o.queueFolder(p)
    },
    /** The menu-bar item: no test can see or click the real menu bar, so it reads main's state. */
    menuBar(): MenuBarProbe {
      return o.menuBar()
    },
    /** Click an item of the menu-bar item's menu by id (`app.openKea`, `app.quit`, `session:<id>`); false when absent. */
    clickMenuBarItem(id: string): boolean {
      if (typeof id !== 'string') throw new Error('clickMenuBarItem takes an item id')
      return o.clickMenuBarItem(id)
    },
    /** What main would have shown: recorded posts, closes and badges, the live tags, the badge. */
    notifications(): NotificationsProbe {
      return o.notifications()
    },
    /** A click on the live notification `tag` (`s:<sessionId>`, `c:<agent>`, `burst`, `summary`); false when none is live. */
    clickNotification(tag: string): boolean {
      if (typeof tag !== 'string') throw new Error('clickNotification takes a tag')
      return o.clickNotification(tag)
    },
    /** The links main would have handed to the system browser (recorded under --kea-perf, external.ts), oldest first. */
    opened(): string[] {
      return o.opened()
    },
    /** Whether core is told a Kea window has keyboard focus; null goes back to the real windows' focus. */
    focus(focused: boolean | null): void {
      if (focused !== null && typeof focused !== 'boolean') throw new Error('focus takes a boolean or null')
      o.focus(focused)
    },
    /** Whether a screen reader runs, as the windows are told (a test never starts VoiceOver, and never follows the system's own answer). */
    screenReader(on: boolean): void {
      if (typeof on !== 'boolean') throw new Error('screenReader takes a boolean')
      o.screenReader(on)
    },
    /**
     * Whether the system shows Kea's notifications, as the recorder answers a post (no test changes the system's
     * own setting).
     */
    denyNotifications(on: boolean): void {
      if (typeof on !== 'boolean') throw new Error('denyNotifications takes a boolean')
      o.denyNotifications(on)
    },
    /** The platform report as main assembles it now: null where this system has none. */
    platformReport(): Promise<unknown> {
      return o.platformReport()
    },
    /** The window's menu: the menus in order, and where the header's button or `Alt` asked it to open. */
    menu(): MenuProbe {
      return o.menu()
    },
    /**
     * The Wayland rebuild of a minimized window, on any system: the Linux harness draws on X11 (Xvfb),
     * which never takes that path. Resolves false when there is no window; true once the new one is made.
     */
    rebuildWindow(): Promise<boolean> {
      return o.rebuildWindow()
    },
    /** The update state as main holds it, the update item's title, and the restarts Kea would have made (oldest first). */
    updates(): UpdatesProbe {
      return o.updates()
    },
    /** Check for Updates… as the menu item runs it. */
    checkUpdates(): void {
      o.checkUpdates()
    },
    /** Kea's files replaced under it, as the package watch would find (`version`: the new tree's, or null). */
    upgraded(version: string | null): void {
      if (version !== null && !(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version))) throw new Error('upgraded takes a version or null')
      o.upgraded(version)
    },
    /**
     * Forced GC in main, twice (`--expose-gc` at runtime, then `gc` from a fresh context). `reduce`: then V8's
     * memory-reducing collection as well, which also gives back the free pages V8 keeps for later (L-TERM-5 reads main's
     * footprint after it: those pages come and go by megabytes with no window involved).
     */
    gc(how?: { reduce?: boolean }): void {
      if (!gc) {
        v8.setFlagsFromString('--expose-gc')
        gc = vm.runInNewContext('gc') as (options?: unknown) => void
      }
      gc()
      gc()
      if (how?.reduce) gc({ type: 'major', execution: 'sync', flavor: 'last-resort' })
    },
  }
  ;(globalThis as Record<string, unknown>).__keaTest = api
}
