// macOS's side of main's OS layer (index.ts).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import type { PlatformLine } from '@kea/protocol'
import type { MakeUpdater } from '../updates/driver.ts'
import { installCommand, NOT_FROM_RELEASE, type UpdateHow } from '../updates/how.ts'
import { terminalRendererLine, updateChannelLine } from '../platformLines.ts'
import type { InstallKind, MainOs, UpdateHowInput } from './index.ts'

const INSTALL_KINDS: readonly InstallKind[] = ['mac', 'deb', 'rpm', 'tarball', 'user']

function readInstallKind(resourcesDir: string): InstallKind | null {
  try {
    const kind = fs.readFileSync(path.join(resourcesDir, 'install-kind'), 'utf8').trim()
    return (INSTALL_KINDS as readonly string[]).includes(kind) ? (kind as InstallKind) : null
  } catch {
    return null
  }
}

/** Where the app bundle is, as the updater needs it: writable by this user with its folder, and not run from App Translocation's copy. */
export interface MacBundle {
  writable: boolean
  translocated: boolean
}

/** The bundle that holds `resourcesDir` (`Kea.app/Contents/Resources`). */
export function macBundle(resourcesDir: string): MacBundle {
  const bundle = path.resolve(resourcesDir, '..', '..')
  const writable = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }
  return { writable: writable(bundle) && writable(path.dirname(bundle)), translocated: bundle.includes('/AppTranslocation/') }
}

/**
 * How a Mac install is updated: Kea's own updater where it can replace the bundle, for the default home; install.sh
 * otherwise, with the reason for About. A build not from a release is updated by nothing.
 */
export function macUpdateHow(o: UpdateHowInput, bundle: MacBundle): UpdateHow {
  if (o.kind !== 'mac' || o.repository === null) return NOT_FROM_RELEASE
  const command = installCommand(o.repository)
  if (!o.defaultHome) return { mode: 'command', auto: false, command, why: 'Kea runs with a home of its own here, so it does not update itself.' }
  if (bundle.translocated) return { mode: 'command', auto: true, command, why: 'macOS runs Kea from a temporary copy: move Kea to Applications to let it update itself.' }
  if (!bundle.writable) return { mode: 'command', auto: true, command, why: 'Kea cannot change the folder it is in, so it does not update itself.' }
  return { mode: 'updater', auto: true, command, why: null }
}

/** The updater's bundle beside main's, loaded once. */
let updater: MakeUpdater | null = null
function loadUpdater(dist: string): MakeUpdater {
  // `__filename` is the bundle (main.cjs); under Node's type stripping `import.meta.url` names this file
  updater ??= (createRequire(typeof __filename === 'string' ? __filename : import.meta.url)(path.join(dist, 'updater.cjs')) as { makeUpdater: MakeUpdater }).makeUpdater
  return updater
}

const line = (id: PlatformLine['id'], label: string, value: string): PlatformLine => ({ id, label, value, fix: null })
const SEP: MenuItemConstructorOptions = { type: 'separator' }

export const darwin: MainOs = {
  system: 'darwin',
  // the traffic lights inside the sidebar header
  windowChrome: {
    options: (o) => ({ titleBarStyle: 'hiddenInset', trafficLightPosition: o.trafficLights }),
    createShown: false,
    restoresPosition: () => true,
    nativeTheme: null,
  },
  raise: { display: () => 'quartz', how: () => 'focus' },
  menu: {
    // the app menu (about, Check for Updates…, Kea's own items, Open Kea with no window, Services, Hide, ⌘Q, ⌥⌘Q), Edit, the categories,
    // Developer, Window, Help; macOS puts its search field first in Help: it finds every item of the menu bar by title
    layout: (p) => [
      {
        label: p.appName,
        submenu: [
          { role: 'about' },
          p.checkUpdates,
          ...(p.app.length ? [SEP, ...p.app] : []),
          ...(p.openKea ? [SEP, p.openKea] : []),
          SEP,
          { role: 'services' },
          SEP,
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          SEP,
          p.closeToMenuBar,
          p.quit,
        ],
      },
      { label: 'Edit', submenu: p.edit },
      ...p.sections.map((s): MenuItemConstructorOptions => ({ label: s.label, submenu: s.items })),
      ...p.dev,
      { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }, SEP, { role: 'front' }] },
      { role: 'help', submenu: p.help },
    ],
    inWindow: false,
  },
  notify: { create: (make, o) => new make({ id: o.id, title: o.title, subtitle: o.subtitle, body: o.body, silent: o.silent }), permission: true },
  badge: { set: (app, text) => app.dock?.setBadge(text) },
  background: {
    dock: (app) => app.dock,
    dockVisible: (app) => app.dock?.isVisible() ?? null,
    setTitle: (tray, title) => tray.setTitle(title),
    title: (tray) => tray.getTitle(),
    templateIcon: true,
    countInMenu: false,
    lastWindow: 'stay',
  },
  // the menu bar and Notification Center are always there; the idle time is the system's own (no monitor to follow)
  desktopServices: {
    watch: (cb) => {
      const state = { trayHost: true, notifications: true, idleMonitor: null }
      cb(state)
      return { now: () => state, dispose: () => undefined }
    },
  },
  front: {
    onActive: (app, cb) => void app.on('did-become-active', cb),
    isActive: (app) => app.isActive(),
    hide: (app) => app.hide(),
  },
  // every helper of a Mac's Electron is in getAppMetrics: no zygote
  zygotes: { of: () => [] },
  power: { onDisplayWake: (electron, cb) => void electron.systemPreferences.subscribeWorkspaceNotification('NSWorkspaceScreensDidWakeNotification', () => cb()) },
  idle: { source: () => 'system' },
  sandboxStatus: { line: () => line('rendererSandbox', 'Window sandbox', 'on') },
  installKind: { read: readInstallKind },
  updates: {
    how: (o) => macUpdateHow(o, macBundle(o.resourcesDir)),
    releaseFile: (kind) => (kind === 'mac' ? 'zip' : null),
    loadUpdater,
  },
  // a Mac app is replaced only by its own updater or by install.sh, each after Kea has quit: nothing to follow
  packageWatch: { watch: () => () => undefined },
  report: {
    platform: (o) => {
      const kind = readInstallKind(o.resourcesDir)
      return {
        system: 'darwin',
        version: `macOS ${o.version}`,
        arch: o.arch,
        lines: [
          line('installKind', 'Installed', kind ?? 'by hand (a dev build or pnpm kea:install): Kea does not update itself'),
          line('holderDetach', 'Terminals', 'each in a process of its own that macOS keeps when Kea quits'),
          line('admission', 'Terminal access', "checked against Kea's code signature"),
          line('rendererSandbox', 'Window sandbox', 'on'),
          terminalRendererLine(o.webgl2, null),
          line('trayHost', 'Background', 'the menu bar'),
          line('notifications', 'Notifications', 'Notification Center'),
          ...(o.updates ? [updateChannelLine(o.updates)] : []),
        ],
      }
    },
  },
}
