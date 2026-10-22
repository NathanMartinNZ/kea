// main's OS layer: the capabilities that differ by system and that main owns. Callers import this file only;
// `select.ts` picks `darwin.ts` or `linux.ts` once, at start. Nothing here imports Electron at run time (types only),
// so the decisions stay unit-testable: a capability that acts on Electron is handed the object it acts on.
import type { App, BrowserWindowConstructorOptions, MenuItemConstructorOptions, Notification, Tray } from 'electron'
import type { NotAvailable, PlatformLine, PlatformReport, System } from '@kea/protocol'

/** Which display server the window is on: macOS's own, or Linux's Wayland or X11. */
export type DisplayServer = 'quartz' | 'wayland' | 'x11'

/** `windowChrome`: the window's title bar, and how the window is made and placed. */
export interface WindowChrome {
  /**
   * The title-bar options: macOS's traffic lights at `trafficLights` (from the design tokens); Linux's Window Controls
   * Overlay in `overlay`'s colours and height.
   */
  options(o: { trafficLights: { x: number; y: number }; overlay: { color: string; symbolColor: string; height: number } }): Partial<BrowserWindowConstructorOptions>
  /** The window is created shown (on GNOME's Wayland session a window created hidden may never get `ready-to-show`). */
  readonly createShown: boolean
  /** A saved position is restored (on Wayland a window cannot place itself, and `getBounds()` has no real position). */
  restoresPosition(display: DisplayServer): boolean
}

/**
 * Where "Open Kea" comes from: the tray's menu, a notification's click, a second launch, Kea's own menu or palette.
 */
export type OpenVia = 'tray' | 'notification' | 'secondInstance' | 'menu'

/**
 * How "Open Kea" brings back the window that is open: `focus` restores a minimized one, shows and focuses it (macOS,
 * X11); `remap` hides and shows it, which GNOME's Wayland session raises; `rebuild` replaces a minimized one with a
 * window made from its state, the way a closed one is reopened; `none` leaves it to the shell, which focuses the open
 * window itself for a second launch.
 */
export type RaiseHow = 'focus' | 'remap' | 'rebuild' | 'none'

/** `raise`: which display server this run is on, and how "Open Kea" brings back the open window there. */
export interface Raise {
  /** The display server of this run, from the environment and Chromium's switches (`switchValue`: Electron's `app.commandLine.getSwitchValue`). */
  display(env: NodeJS.ProcessEnv, switchValue: (name: string) => string): DisplayServer
  how(o: { display: DisplayServer; minimized: boolean; via: OpenVia }): RaiseHow
}

/** The parts of the menu bar main builds from the command table (menu.ts), for this system to lay out. */
export interface MenuParts {
  appName: string
  /** The App category's commands (Settings, Copy Diagnostics, …), each an item. */
  app: MenuItemConstructorOptions[]
  /** Open Kea, while there is no window; null while there is one. */
  openKea: MenuItemConstructorOptions | null
  /** `app.closeToMenuBar` and `app.quit` (main's own). */
  closeToMenuBar: MenuItemConstructorOptions
  quit: MenuItemConstructorOptions
  /** The Edit menu's roles with Copy and Paste titled from the command table. */
  edit: MenuItemConstructorOptions[]
  /** Copy's and Paste's keys as the command table writes them for this system (`terminal.copy`, `terminal.paste`), shown beside the Edit roles on Linux. */
  editKeys: { copy?: string; paste?: string }
  /** The feature categories' menus in table order (Session, Project, Terminal, Files, Viewer, Server, View), each its items. */
  sections: { category: string; label: string; items: MenuItemConstructorOptions[] }[]
  /** Developer, in dev builds. */
  dev: MenuItemConstructorOptions[]
  /** Help's own items: Keyboard Shortcuts, Copy Diagnostics. */
  help: MenuItemConstructorOptions[]
}

/** `menu`: the menu bar's layout. */
export interface MenuChrome {
  /** The application menu from its parts: macOS's menu bar (app menu, Edit, the categories, Window, Help); Linux's File, Edit, View, Session, Go, Window, Help. */
  layout(p: MenuParts): MenuItemConstructorOptions[]
  /** The header has a menu button, and `Alt` pressed alone opens the menu too; macOS has its menu bar instead. */
  readonly inWindow: boolean
}

/** What a notification shows. */
export type NotificationText = { id: string; title: string; subtitle: string; body: string; silent: boolean }

/** `notify`: a notification through the system's service, made but not shown. */
export interface Notify {
  create(make: typeof Notification, o: NotificationText): Notification
  /** The system keeps a permission for Kea's notifications that Settings can point to; Linux has none. */
  readonly permission: boolean
}

/** `badge`: the count on the app's icon. */
export interface Badge {
  set(app: App, text: string): void
}

/** `background`: running with no window, from the menu bar or a tray. */
export interface Background {
  /** The Dock icon's show and hide; undefined when there is none to show. */
  dock(app: App): { show(): unknown; hide(): void } | undefined
  /** Whether the Dock icon shows; null when there is none. */
  dockVisible(app: App): boolean | null
  /** The item's title (the needs-you count) and what it shows now; a Linux tray shows none. */
  setTitle(tray: Tray, title: string): void
  title(tray: Tray): string
  /** The icon is a template image the system tints (macOS); else a coloured one (Linux: a template is drawn black). */
  readonly templateIcon: boolean
  /** The item's menu says the count in its first line, since no title shows it. */
  readonly countInMenu: boolean
  /**
   * Closing the last window: Kea stays as it is (macOS: in the Dock), or it goes to the background when it can
   * (a tray host and live sessions) and quits otherwise (Linux).
   */
  readonly lastWindow: 'stay' | 'backgroundOrQuit'
}

/** What main follows of the desktop's services; null where it has no answer yet. */
export type DesktopServiceState = {
  /** A tray host: a StatusNotifierItem watcher on Linux, the menu bar on macOS. */
  trayHost: boolean | null
  /** The notification service. */
  notifications: boolean | null
  /** mutter's idle monitor, which Chromium reads for the idle time on GNOME's Wayland session. */
  idleMonitor: boolean | null
}

/** `desktopServices`: the desktop's services Kea uses (`DesktopServiceState`), followed as they come and go. */
export interface DesktopServices {
  /** Calls `cb` with the state whenever a service comes or goes (and with the first answers). */
  watch(cb: (s: DesktopServiceState) => void): { now(): DesktopServiceState; dispose(): void }
}

/**
 * A test build's front guard (frontGuard.ts): which app the system puts in front. macOS only: on Linux a test build
 * draws on the harness's own X server, which no key of the person's reaches.
 */
export interface Front {
  onActive(app: App, cb: () => void): void
  isActive(app: App): boolean
  /** Gives the front back to the app that had it. */
  hide(app: App): void
}

/**
 * `zygotes`: Chromium's processes that `app.getAppMetrics()` does not list, which the footprint sampler adds as their
 * own role. macOS has none.
 */
export interface Zygotes {
  /** The pids of main's descendants whose command line says `--type=zygote` (and so the set-uid sandbox's helper that starts one). */
  of(mainPid: number): number[]
}

/** `idle`, `power`: what the system says about its display and the person's input. */
export interface Power {
  /** `electron` is Electron's module: the system's own settings API is reached through it, and only here. */
  onDisplayWake(electron: typeof import('electron'), cb: () => void): void
}

/**
 * Where the watchdog's idle time comes from: the system's count, or input to Kea's own windows where it has none.
 */
export type IdleSource = 'system' | 'kea'

/** `idle`: which idle count the watchdog trusts. */
export interface Idle {
  /**
   * Which count to trust, given what this run knows: the display server, whether mutter's idle monitor is on the bus,
   * and whether the system's count has ever read above 0 (a compositor without an idle protocol reads 0 for ever).
   */
  source(o: { display: DisplayServer; mutterIdleMonitor: boolean | null; systemSeenAboveZero: boolean }): IdleSource
}

/** `sandboxStatus`: whether the renderer's sandbox runs, and how. */
export interface SandboxStatus {
  /** `rendererPid`: a window's renderer, whose own process says whether it is sandboxed (Linux); null when there is no window. */
  line(o: { rendererPid: number | null; execPath: string }): PlatformLine
}

/** How Kea was installed: what `resources/install-kind` records. */
export type InstallKind = 'mac' | 'deb' | 'rpm' | 'tarball' | 'user'

/** `installKind`: how this build was installed. */
export interface InstallKindReader {
  /** What `<resources>/install-kind` says; null when there is none (a dev build, `pnpm kea:install`). */
  read(resourcesDir: string): InstallKind | null
}

/** What main knows when it assembles the platform report, gathered at the time it is asked for. */
export interface ReportInput {
  version: string
  arch: string
  resourcesDir: string
  execPath: string
  /** Chromium's WebGL2 state from `app.getGPUFeatureStatus()` (`webglState`): WebGL2 or not, and why. */
  webgl2: string
  /** A tray host is there; null when the bus has not answered. */
  trayHost: boolean | null
  /** The freedesktop notification service is there; null when the bus has not answered. */
  notificationService: boolean | null
  rendererPid: number | null
  corePid: number | null
  idle: IdleSource
  /** Core's watcher holds an inotify limit (`core.watch.limitHeld`), when core answered. */
  watchLimitHeld: boolean | null
  /** This run's display server (the desktop is the OS layer's own to read). */
  display: DisplayServer
  /** The desktop file's id this build runs as (`DESKTOP_IDS`), which a notification's click activates. */
  desktopId: string
}

/** The platform report, as main assembles it. */
export interface Report {
  platform(o: ReportInput): PlatformReport
}

export interface MainOs {
  readonly system: System
  readonly windowChrome: WindowChrome | NotAvailable
  readonly raise: Raise
  readonly menu: MenuChrome | NotAvailable
  readonly notify: Notify | NotAvailable
  readonly badge: Badge | NotAvailable
  readonly background: Background | NotAvailable
  readonly desktopServices: DesktopServices
  readonly front: Front | NotAvailable
  readonly zygotes: Zygotes
  readonly power: Power | NotAvailable
  readonly idle: Idle
  readonly sandboxStatus: SandboxStatus | NotAvailable
  readonly installKind: InstallKindReader | NotAvailable
  readonly report: Report | NotAvailable
}

export { mainOs } from './select.ts'
