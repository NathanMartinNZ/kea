// macOS's side of main's OS layer (index.ts).
import fs from 'node:fs'
import path from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import type { PlatformLine } from '@kea/protocol'
import { terminalRendererLine } from '../platformLines.ts'
import type { InstallKind, MainOs } from './index.ts'

const INSTALL_KINDS: readonly InstallKind[] = ['mac', 'deb', 'rpm', 'tarball', 'user']

function readInstallKind(resourcesDir: string): InstallKind | null {
  try {
    const kind = fs.readFileSync(path.join(resourcesDir, 'install-kind'), 'utf8').trim()
    return (INSTALL_KINDS as readonly string[]).includes(kind) ? (kind as InstallKind) : null
  } catch {
    return null
  }
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
  },
  raise: { display: () => 'quartz', how: () => 'focus' },
  menu: {
    // the app menu (about, Kea's own items, Open Kea with no window, Services, Hide, ⌘Q, ⌥⌘Q), Edit, the categories,
    // Developer, Window, Help; macOS puts its search field first in Help: it finds every item of the menu bar by title
    layout: (p) => [
      {
        label: p.appName,
        submenu: [
          { role: 'about' },
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
        ],
      }
    },
  },
}
