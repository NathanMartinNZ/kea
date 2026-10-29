// Linux's side of main's OS layer (index.ts): the window under the Window Controls Overlay with the header's menu
// button, the tray only where a StatusNotifierItem host is, notifications and the badge through the freedesktop service
// and LauncherEntry, Wayland's raising rules, the idle source, the renderer sandbox's state and the platform report's
// Linux lines. What Linux lacks says why.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { holdersHidden, rootOnlyFile } from '@kea/kit'
import { L, need, notAvailable, PLATFORM_LINES, type PlatformLine } from '@kea/protocol'
import { GPU_DRIVER_FIX, terminalRendererLine } from '../platformLines.ts'
import { sessionBusPath, watchBusNames, type BusNames } from './dbus.ts'
import type { DesktopServiceState, DisplayServer, IdleSource, MainOs, MenuParts, OpenVia, RaiseHow, ReportInput } from './index.ts'

// ── the platform report's Linux lines ───────────────────────────────────────────────────────

/**
 * The facts the platform report's Linux lines are made of, read once when the report is assembled, with no child
 * process.
 */
export interface LinuxFacts {
  /** A systemd user manager answers: holders go to scopes of their own; otherwise session mode. */
  userManager: boolean
  /** Kea's own systemd unit when it is a service (the last part of its cgroup path), else null. */
  keaService: string | null
  /** Only root can change Kea's executable: holders check their client in full. */
  rootOnly: boolean
  /** `kernel.yama.ptrace_scope`; null without Yama, which leaves ptrace as open as 0. */
  ptraceScope: number | null
  /** `/proc`'s `hidepid` while it hides holders, else null. */
  hidepid: string | null
  /** `/var/lib/systemd/linger/<user>` exists: the user manager outlives the last logout. */
  linger: boolean
}

/** Every line is the full answer unless it carries its one-sentence fix. */
const line = (id: PlatformLine['id'], label: string, value: string, fix: string | null = null): PlatformLine => ({ id, label, value, fix })

/**
 * The platform report's Linux lines, in About's order: how holders detach (with the `ExitType=main` caveat when
 * Kea runs in a service), admission strength (full, ptrace-open, path-only), holder visibility (`hidepid`), and
 * in scope mode only, sessions across a logout (linger).
 */
export function linuxLines(f: LinuxFacts): PlatformLine[] {
  const lines: PlatformLine[] = []
  const service = f.keaService ? ` Kea runs in ${f.keaService}: if that service ends with Kea's main process (ExitType=main), they end when Kea quits.` : ''
  lines.push(
    f.userManager
      ? line('holderDetach', 'Terminals', 'each in a systemd scope of its own, which outlives Kea')
      : line(
          'holderDetach',
          'Terminals',
          `each in a session of its own, as no systemd user manager answers: they outlive Kea quitting or crashing, but may end if your desktop stops Kea.${service}`,
          'Log in to a desktop session that runs a systemd user manager, so each terminal gets a scope of its own.',
        ),
  )
  if (!f.rootOnly) {
    lines.push(line('admission', 'Session isolation', "reduced (Kea's files are writable by your user)", 'Install Kea from its package, which only root can change, for full isolation.'))
  } else if (f.ptraceScope === null || f.ptraceScope === 0) {
    lines.push(line('admission', 'Session isolation', "checked by Kea's executable, but with ptrace_scope 0 any of your processes can trace Kea's terminal process (ptyhost) and reach every terminal through it", 'Run `sudo sysctl -w kernel.yama.ptrace_scope=1`'))
  } else {
    lines.push(line('admission', 'Session isolation', "full: terminals admit Kea's own executable only, and no process of yours can trace them"))
  }
  lines.push(
    f.hidepid === null
      ? line('holderVisibility', 'Terminal processes', 'visible to Kea in /proc')
      : line(
          'holderVisibility',
          'Terminal processes',
          `hidden by /proc's hidepid=${f.hidepid}: Kea tells a running terminal by its socket and cannot show its memory use`,
          "Mount /proc without hidepid, or with gid= set to one of your groups, to show each terminal's memory use.",
        ),
  )
  if (f.userManager) {
    lines.push(
      f.linger
        ? line('logout', 'After you log out', 'sessions keep running (linger is on)')
        : line('logout', 'After you log out', 'sessions end at your last logout, as on macOS', 'Run `loginctl enable-linger` to keep sessions running after you log out'),
    )
  }
  return lines
}

/** Present while systemd is the init system (`sd_booted`). */
const SYSTEMD_BOOTED = '/run/systemd/system'
/** Where logind keeps a file per user whose manager outlives the last logout. */
const LINGER_DIR = '/var/lib/systemd/linger'

/**
 * Whether a systemd user manager answers, tested as the helper tests it (`os::linux::user_manager`): systemd
 * runs and the user manager's socket is the user's.
 */
function userManager(env: NodeJS.ProcessEnv = process.env): boolean {
  const rt = env.XDG_RUNTIME_DIR
  if (!rt || !path.isAbsolute(rt)) return false
  try {
    const sock = fs.lstatSync(path.join(rt, 'systemd', 'private'))
    return fs.lstatSync(SYSTEMD_BOOTED).isDirectory() && sock.isSocket() && sock.uid === process.getuid?.()
  } catch {
    return false
  }
}

/** The unit this process runs in, when it is a service: the last part of its cgroup v2 path (`0::/…/x.service`). */
export function serviceOf(cgroup: string): string | null {
  const unit = cgroup.split('\n').find((l) => l.startsWith('0::'))?.split('/').pop() ?? ''
  return unit.endsWith('.service') ? unit : null
}

/** Is the user's linger file there (`dir/<user>`)? */
export function lingerOn(user: string, dir: string = LINGER_DIR): boolean {
  try {
    return fs.statSync(path.join(dir, user)).isFile()
  } catch {
    return false
  }
}

/** `/proc/<pid>/stat`'s parent pid (field 4, after the name in parentheses, which may hold anything); null for no line. */
export function statParent(stat: string): number | null {
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  return Number.isInteger(ppid) ? ppid : null
}

/**
 * main's descendants whose command line says `--type=zygote`: Chromium's zygotes, which `getAppMetrics()` does not
 * list, and the set-uid sandbox's helper that starts the sandboxed one (its own arguments name the zygote's). Their
 * children (renderers, the GPU process) are listed already and are not named again here. `cmdline` is read only for
 * main's descendants: NUL-separated words, or Chromium's one rewritten title.
 */
export function zygotePids(parents: ReadonlyMap<number, number>, mainPid: number, cmdline: (pid: number) => string): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of parents) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  const out: number[] = []
  const queue = [mainPid]
  const seen = new Set(queue)
  while (queue.length) {
    for (const c of children.get(queue.shift() as number) ?? []) {
      if (seen.has(c)) continue
      seen.add(c)
      queue.push(c)
      if (cmdline(c).split(/[\0 ]/).includes('--type=zygote')) out.push(c)
    }
  }
  return out
}

/** Every process's parent, from `/proc/<pid>/stat` (readable for every process). */
function procParents(): Map<number, number> {
  const out = new Map<number, number>()
  for (const name of readOr(() => fs.readdirSync('/proc'), [] as string[])) {
    if (!/^\d+$/.test(name)) continue
    const ppid = statParent(readOr(() => fs.readFileSync(`/proc/${name}/stat`, 'utf8'), ''))
    if (ppid !== null) out.set(Number(name), ppid)
  }
  return out
}

function readOr<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** What the report's Linux lines are made from, read now. `userName` may throw (a uid with no passwd entry): no linger file then. */
export function linuxFacts(userName: () => string = () => os.userInfo().username): LinuxFacts {
  const scope = readOr(() => Number(fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim()), Number.NaN)
  return {
    userManager: userManager(),
    keaService: readOr(() => serviceOf(fs.readFileSync('/proc/self/cgroup', 'utf8')), null),
    rootOnly: rootOnlyFile(process.execPath),
    ptraceScope: Number.isInteger(scope) ? scope : null,
    hidepid: holdersHidden(),
    linger: readOr(() => lingerOn(userName()), false),
  }
}

/**
 * The system's name from os-release(5) (`/etc/os-release`, else `/usr/lib/os-release`): `PRETTY_NAME`, else `NAME`
 * and `VERSION_ID`; null when it names none. Values are shell-quoted, double-quoted ones with backslash escapes.
 */
export function osReleaseName(text: string): string | null {
  const kv = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const eq = line.indexOf('=')
    if (line.startsWith('#') || eq <= 0) continue
    kv.set(line.slice(0, eq), unquoteValue(line.slice(eq + 1)))
  }
  const pretty = kv.get('PRETTY_NAME')
  if (pretty) return pretty
  const name = kv.get('NAME')
  if (!name) return null
  const version = kv.get('VERSION_ID')
  return version ? `${name} ${version}` : name
}

function unquoteValue(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

/** The report's version: the system's name and its kernel, or the kernel alone when os-release names nothing. */
export function linuxVersion(name: string | null, kernel: string): string {
  return name ? `${name} (Linux ${kernel})` : `Linux ${kernel}`
}

function osRelease(): string | null {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    const text = readOr<string | null>(() => fs.readFileSync(file, 'utf8'), null)
    if (text !== null) return osReleaseName(text)
  }
  return null
}

// ── the desktop's services on the session bus ──────────────────────────────────────────────────

/** The names main follows: the tray host (the AppIndicator extension on Ubuntu, Plasma's own), the notification service, mutter's idle monitor. */
export const BUS_NAMES = { trayHost: 'org.kde.StatusNotifierWatcher', notifications: 'org.freedesktop.Notifications', idleMonitor: 'org.gnome.Mutter.IdleMonitor' } as const

/** The one session-bus connection of main, made the first time it is needed. */
let bus: BusNames | null = null
function sessionBus(): BusNames {
  bus ??= watchBusNames(Object.values(BUS_NAMES), { path: sessionBusPath(process.env), uid: process.getuid?.() ?? -1, warn: (m, d) => console.warn(m, d ?? '') })
  return bus
}

function serviceState(b: BusNames): DesktopServiceState {
  return { trayHost: b.has(BUS_NAMES.trayHost), notifications: b.has(BUS_NAMES.notifications), idleMonitor: b.has(BUS_NAMES.idleMonitor) }
}

// ── the window and its menu ───────────────────────────────────────────────────────────────────

/** Which display server Chromium runs on: `--ozone-platform` (or its hint) when it names one, else Wayland where a compositor is (Electron's default since 38.2). */
export function displayServer(env: NodeJS.ProcessEnv, ozonePlatform: string): DisplayServer {
  if (ozonePlatform === 'x11' || ozonePlatform === 'wayland') return ozonePlatform
  return env.WAYLAND_DISPLAY ? 'wayland' : 'x11'
}

/**
 * On Wayland nothing takes focus without the person, so the tray's Open Kea raises an open window by hiding and
 * showing it, and replaces a minimized one, which no call brings back, with a window rebuilt from its state. On X11
 * `restore()` and `focus()` work.
 */
export function raiseHow(o: { display: DisplayServer; minimized: boolean; via: OpenVia }): RaiseHow {
  if (o.display !== 'wayland') return 'focus'
  // Kea's own menu or palette runs in the window that has focus already
  if (o.via === 'menu') return 'focus'
  // for a second launch the shell focuses the open window itself
  if (o.via === 'secondInstance') return 'none'
  // the tray's "Open Kea" and a notification's click (GNOME 46 raises nothing itself for either): an open
  // window is mapped again, which GNOME raises; a minimized one is rebuilt, which comes up focused
  return o.minimized ? 'rebuild' : 'remap'
}

/** The command table's navigation commands, gathered in Linux's Go menu from their categories. */
export const GO_COMMANDS: readonly string[] = ['session.next', 'session.previous', 'session.jumpNeedsYou', 'session.jumpTo', 'terminal.nextTab', 'terminal.previousTab', 'terminal.focus', 'files.goToFile', 'files.revealInTree', 'view.cycleFocus']
/** The App commands Linux shows in Help only (macOS has them in the app menu as well). */
const HELP_COMMANDS: ReadonlySet<string> = new Set(['app.shortcuts', 'app.copyDiagnostics'])
/** The Edit roles' keys as shown (text fields have them natively; nothing is registered, so no `Ctrl+<letter>` is ever the menu's). */
const EDIT_KEYS: Readonly<Record<string, string>> = { undo: 'Ctrl+Z', redo: 'Ctrl+Shift+Z', cut: 'Ctrl+X', selectAll: 'Ctrl+A' }
const SEP: MenuItemConstructorOptions = { type: 'separator' }

/**
 * File, Edit, View, Session, Go, Window, Help; no app-name menu, no Services or Hide; Quit in File. File has the
 * Project commands and the App ones (Settings, …), then Open Kea with no window, Close Kea and Quit Kea Completely;
 * View has View's own, then Terminal, Files and Viewer as submenus; Session has Session's and Server's; Go gathers the
 * navigation commands. The Edit roles register no key, so `Ctrl+C`, `Ctrl+V`, `Ctrl+Z` reach the terminal; the Window
 * menu's items are plain ones, since Electron's roles bring `Ctrl+M`, `Ctrl+W` and `F11` with them.
 */
export function linuxMenu(p: MenuParts): MenuItemConstructorOptions[] {
  const section = (category: string) => p.sections.find((s) => s.category === category)?.items ?? []
  const notGo = (i: MenuItemConstructorOptions) => !GO_COMMANDS.includes(String(i.id))
  const every = p.sections.flatMap((s) => s.items)
  const go = GO_COMMANDS.flatMap((id) => every.filter((i) => i.id === id))
  const joined = (...groups: MenuItemConstructorOptions[][]) => groups.filter((g) => g.length > 0).flatMap((g, k) => (k > 0 ? [SEP, ...g] : g))
  const sub = (label: string, items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => (items.length ? [{ label, submenu: items }] : [])
  const editKey = (role: string): string | undefined => (role === 'copy' ? p.editKeys.copy : role === 'paste' ? p.editKeys.paste : EDIT_KEYS[role])
  const edit = p.edit.map((i): MenuItemConstructorOptions => {
    if (!i.role) return i
    const key = editKey(i.role)
    return { ...i, ...(key ? { accelerator: key } : {}), registerAccelerator: false }
  })
  return [
    { label: 'File', submenu: joined(section('Project'), p.app.filter((i) => !HELP_COMMANDS.has(String(i.id))), p.openKea ? [p.openKea] : [], [p.closeToMenuBar, p.quit]) },
    { label: 'Edit', submenu: edit },
    { label: 'View', submenu: joined(section('View').filter(notGo), [...sub('Terminal', section('Terminal').filter(notGo)), ...sub('Files', section('Files').filter(notGo)), ...sub('Viewer', section('Viewer'))]) },
    { label: 'Session', submenu: joined(section('Session').filter(notGo), section('Server')) },
    { label: 'Go', submenu: go },
    ...p.dev,
    {
      label: 'Window',
      submenu: [
        { id: 'window.minimize', label: 'Minimize', click: (_m, w) => w?.minimize() },
        { id: 'window.maximize', label: 'Maximize', click: (_m, w) => (w?.isMaximized() ? w.unmaximize() : w?.maximize()) },
        { id: 'window.fullScreen', label: 'Full Screen', click: (_m, w) => w?.setFullScreen(!w.isFullScreen()) },
      ],
    },
    { label: 'Help', submenu: p.help },
  ]
}

// ── notifications ─────────────────────────────────────────────────────────────────────────────

/** Electron drops `subtitle` on Linux: Kea folds it into the body itself, as its first line. */
export function foldSubtitle(subtitle: string, body: string): string {
  if (!subtitle) return body
  return body ? `${subtitle}\n${body}` : subtitle
}

/** Where the desktop looks for desktop entries (`$XDG_DATA_HOME`, then `$XDG_DATA_DIRS`, with their defaults). */
function applicationDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((d) => path.isAbsolute(d))
  return [dataHome, ...dataDirs].map((d) => path.join(d, 'applications'))
}

/** Is `<id>.desktop` installed where the desktop finds it (the badge, the notifications' name and Kea's dock icon go by it)? */
export function desktopFileFound(id: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): boolean {
  return applicationDirs(env, home).some((d) => fs.existsSync(path.join(d, `${id}.desktop`)))
}

// ── idle ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The watchdog's idle time: the system's count on X11 and where mutter's idle monitor answers (GNOME's Wayland
 * session), and on another Wayland compositor once its count has read above 0 (it then has an idle protocol); until
 * then, input to Kea's own windows (a fallback macOS does without; here it is the only one left).
 */
export function idleSource(o: { display: DisplayServer; mutterIdleMonitor: boolean | null; systemSeenAboveZero: boolean }): IdleSource {
  return o.display === 'x11' || o.mutterIdleMonitor === true || o.systemSeenAboveZero ? 'system' : 'kea'
}

// ── the renderer sandbox ─────────────────────────────────────────────────────────────────────

/** A process's `status` fields the sandbox shows in: seccomp mode 2 (filter) and a pid namespace of its own (two NSpid values). */
export function sandboxedBy(status: string, uidMap: string | null): 'userns' | 'setuid' | 'none' {
  const seccomp = /^Seccomp:\s*(\d+)/m.exec(status)?.[1]
  const nspid = /^NSpid:\s*(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? []
  if (seccomp !== '2' || nspid.length < 2) return 'none'
  // a user namespace maps its ids onto the user's; the set-uid helper's processes stay in the first one
  const identity = uidMap === null || /^\s*0\s+0\s+4294967295\s*$/.test(uidMap)
  return identity ? 'setuid' : 'userns'
}

export function sandboxLine(by: 'userns' | 'setuid' | 'none' | null, execPath: string): PlatformLine {
  if (by === 'userns') return line('rendererSandbox', 'Window sandbox', "on (Chromium's sandbox in user namespaces)")
  if (by === 'setuid') return line('rendererSandbox', 'Window sandbox', "on (Chromium's sandbox through its set-uid helper, chrome-sandbox)")
  if (by === null) return line('rendererSandbox', 'Window sandbox', 'not known: no window is open to read it from')
  const helper = path.join(path.dirname(execPath), 'chrome-sandbox')
  return line('rendererSandbox', 'Window sandbox', 'off: the window runs without Chromium’s sandbox', `Start Kea without --no-sandbox; if Chromium cannot start its sandbox, run sudo chown root:root ${helper} and sudo chmod 4755 ${helper}.`)
}

// ── the platform report's other Linux lines ─────────────────────────────────────────────────

/** Kea's watches in a process: the `inotify wd:` lines of its inotify descriptors' `fdinfo`. Null when they cannot be read. */
export function inotifyWatches(pid: number, proc = '/proc'): number | null {
  try {
    let n = 0
    for (const fd of fs.readdirSync(path.join(proc, String(pid), 'fd'))) {
      let target = ''
      try {
        target = fs.readlinkSync(path.join(proc, String(pid), 'fd', fd))
      } catch {
        continue
      }
      if (target !== 'anon_inode:inotify') continue
      const info = fs.readFileSync(path.join(proc, String(pid), 'fdinfo', fd), 'utf8')
      for (const l of info.split('\n')) if (l.startsWith('inotify wd:')) n++
    }
    return n
  } catch {
    return null
  }
}

/** The lower of the two watch limits (the first user namespace's sysctl and this user namespace's own). */
function watchLimit(): number | null {
  const read = (f: string) => readOr(() => Number(fs.readFileSync(f, 'utf8').trim()), Number.NaN)
  const vals = [read('/proc/sys/fs/inotify/max_user_watches'), read('/proc/sys/user/max_inotify_watches')].filter((v) => Number.isInteger(v) && v > 0)
  return vals.length ? Math.min(...vals) : null
}

/** The lines main adds to the terminal lines, in About's order once merged (`PLATFORM_LINES`). */
export function desktopLines(o: { desktop: string | null; display: DisplayServer; scale: number | null; trayHost: boolean | null; notifications: boolean | null; desktopFile: { id: string; found: boolean }; idle: IdleSource; webgl2: string; watches: number | null; watchLimit: number | null; watchLimitHeld: boolean | null }): PlatformLine[] {
  const session = o.display === 'wayland' ? 'Wayland' : 'X11'
  // the scale tells a page drawn too small or too large from one the desktop's text scaling enlarged
  const scale = o.scale === null ? '' : `, primary display at scale ${Math.round(o.scale * 100) / 100}`
  const lines: PlatformLine[] = [line('desktop', 'Desktop', `${o.desktop ?? 'unknown desktop'}, ${session}${scale}`)]
  lines.push(terminalRendererLine(o.webgl2, GPU_DRIVER_FIX))
  lines.push(
    o.trayHost === true
      ? line('trayHost', 'Background', 'a tray icon in the desktop’s panel: Kea can keep running in the background')
      : o.trayHost === false
        ? line('trayHost', 'Background', 'no tray on this desktop: quitting Kea or closing its last window quits it, and sessions keep running in their terminals', 'Install your desktop’s AppIndicator support (on GNOME, the AppIndicator extension) to keep Kea running in the background with a tray icon.')
        : line('trayHost', 'Background', 'not known: the session bus has not answered'),
  )
  if (o.notifications === false) lines.push(line('notifications', 'Notifications', 'no notification service on the session bus: Kea cannot notify you', 'Log in to a desktop session, whose notification service Kea posts to.'))
  else if (!o.desktopFile.found) lines.push(line('notifications', 'Notifications', `the desktop’s notification service, but ${o.desktopFile.id}.desktop is not installed, so the dock shows no badge and the desktop may not name Kea’s notifications or bring Kea to the front for one`, o.desktopFile.id.endsWith('.dev') ? 'Run pnpm dev, which installs the dev build’s desktop file.' : 'Reinstall Kea’s package, which installs its desktop file.'))
  else lines.push(line('notifications', 'Notifications', 'the desktop’s notification service'))
  lines.push(
    o.idle === 'system'
      ? line('idle', 'Idle time', o.display === 'x11' ? 'the X server’s' : 'the desktop’s (on GNOME, mutter’s idle monitor)')
      : line('idle', 'Idle time', 'input to Kea’s own windows, as this compositor gives Chromium no idle time: the memory watchdog may act while you work in another app', 'Use a compositor with an idle protocol (GNOME, KDE Plasma, Sway) so Kea knows when you are away.'),
  )
  const watches = o.watches === null ? 'an unknown number of' : String(o.watches)
  const limit = o.watchLimit === null ? '' : ` of this user’s ${o.watchLimit} (fs.inotify.max_user_watches)`
  lines.push(
    o.watchLimitHeld
      ? line('inotify', 'File watching', `Kea holds ${watches} inotify watches${limit} and has reached a limit: worktrees refresh when shown`, `Raise it: sudo sysctl fs.inotify.max_user_watches=${L.inotifyWatchesSuggested} (or fs.inotify.max_user_instances=${L.inotifyInstancesSuggested} if the banner named instances), and add that line to a file in /etc/sysctl.d to keep it.`)
      : line('inotify', 'File watching', `Kea holds ${watches} inotify watches${limit}`),
  )
  return lines
}

export const linux: MainOs = {
  system: 'linux',
  windowChrome: {
    // the overlay in the header's colours and height; no menu bar under it (the header's menu button opens the menu)
    options: (o) => ({ titleBarStyle: 'hidden', titleBarOverlay: o.overlay, autoHideMenuBar: true }),
    createShown: true,
    restoresPosition: (display) => display !== 'wayland',
    // the page sets its own colours (it reads no `prefers-color-scheme`); GTK's dialogs and menus follow this
    nativeTheme: 'dark',
  },
  // Chromium's own switch, else its hint, else the environment: Electron runs on Wayland where the session has one
  raise: { display: (env, sw) => displayServer(env, sw('ozone-platform') || sw('ozone-platform-hint')), how: raiseHow },
  menu: { layout: linuxMenu, inWindow: true },
  notify: { create: (make, o) => new make({ title: o.title, body: foldSubtitle(o.subtitle, o.body), silent: o.silent }), permission: false },
  // Unity's LauncherEntry for the desktop file (Electron sends it); 0 clears it
  badge: { set: (app, text) => void app.setBadgeCount(Number.parseInt(text, 10) || 0) },
  background: {
    dock: () => undefined,
    dockVisible: () => null,
    // a Linux tray shows no title: the count is in its tooltip and its menu
    setTitle: () => undefined,
    title: () => '',
    templateIcon: false,
    countInMenu: true,
    lastWindow: 'backgroundOrQuit',
  },
  desktopServices: {
    watch: (cb) => {
      const b = sessionBus()
      const off = b.onChange(() => cb(serviceState(b)))
      cb(serviceState(b))
      return {
        now: () => serviceState(b),
        // main's one watch: its end closes the connection (at quit)
        dispose: () => {
          off()
          b.dispose()
          if (bus === b) bus = null
        },
      }
    },
  },
  // a test build draws on the harness's own X server (Xvfb), which nobody types into and where, with no window manager,
  // the window may take the server's focus: no app is in front to give back
  front: notAvailable('Linux has no app in front, and a test build draws on the harness’s own X server (Xvfb), which no key of the person’s reaches.'),
  zygotes: { of: (mainPid) => zygotePids(procParents(), mainPid, (pid) => readOr(() => fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1'), '')) },
  // resume and unlock come from logind through powerMonitor; Linux has no display-wake signal of its own
  power: { onDisplayWake: () => undefined },
  idle: { source: idleSource },
  sandboxStatus: {
    line: (o) => {
      if (o.rendererPid === null) return sandboxLine(null, o.execPath)
      const status = readOr(() => fs.readFileSync(`/proc/${o.rendererPid}/status`, 'utf8'), '')
      const uidMap = readOr<string | null>(() => fs.readFileSync(`/proc/${o.rendererPid}/uid_map`, 'utf8'), null)
      return sandboxLine(status ? sandboxedBy(status, uidMap) : null, o.execPath)
    },
  },
  installKind: notAvailable('Kea does not yet tell how it was installed on Linux (deb, rpm, tarball or --user).'),
  // The desktop, the terminal lines, the sandbox, the terminal renderer, the tray host, notifications, idle and
  // inotify; there is no install or update line yet
  report: {
    platform: (o: ReportInput) => {
      const extra = desktopLines({
        desktop: process.env.XDG_CURRENT_DESKTOP || null,
        display: o.display,
        scale: o.displayScale,
        trayHost: o.trayHost,
        notifications: o.notificationService,
        desktopFile: { id: o.desktopId, found: desktopFileFound(o.desktopId) },
        idle: o.idle,
        webgl2: o.webgl2,
        watches: o.corePid === null ? null : inotifyWatches(o.corePid),
        watchLimit: watchLimit(),
        watchLimitHeld: o.watchLimitHeld,
      })
      const sandbox = need(linux.sandboxStatus).line({ rendererPid: o.rendererPid, execPath: o.execPath })
      return { system: 'linux', version: linuxVersion(osRelease(), o.version), arch: o.arch, lines: inAboutOrder([...linuxLines(linuxFacts()), sandbox, ...extra]) }
    },
  },
}

/** The report's lines in `PLATFORM_LINES`' order (Settings › About's). */
function inAboutOrder(lines: PlatformLine[]): PlatformLine[] {
  return [...lines].sort((a, b) => PLATFORM_LINES.indexOf(a.id) - PLATFORM_LINES.indexOf(b.id))
}
