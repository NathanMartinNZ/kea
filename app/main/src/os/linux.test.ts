import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { App, MenuItemConstructorOptions, Notification } from 'electron'
import { COMMANDS, need, PLATFORM_LINES, zPlatformReport } from '@kea/protocol'
import { darwin as protocolDarwin } from '@kea/protocol/os/darwin'
import { linux as protocolLinux } from '@kea/protocol/os/linux'
import { afterEach, describe, expect, it } from 'vitest'
import { findMenuItem, menuTemplate, windowMenuTree, type MenuInput } from '../menu.ts'
import { GPU_DRIVER_FIX, terminalRendererLine } from '../platformLines.ts'
import { darwin } from './darwin.ts'
import { desktopFileFound, desktopLines, displayServer, foldSubtitle, GO_COMMANDS, idleSource, inotifyWatches, lingerOn, linux, linuxFacts, linuxLines, linuxVersion, osReleaseName, raiseHow, sandboxedBy, sandboxLine, serviceOf, statParent, zygotePids, type LinuxFacts } from './linux.ts'

const FIXTURES = path.resolve(import.meta.dirname, '../../../../fixtures/os/linux')

/** A stock desktop login: a user manager, Kea in its own app scope, installed by root, Yama at 1, a stock /proc. */
const STOCK: LinuxFacts = { userManager: true, keaService: null, rootOnly: true, ptraceScope: 1, hidepid: null, linger: false }
const byId = (f: LinuxFacts) => new Map(linuxLines(f).map((l) => [l.id, l]))

describe("the platform report's Linux lines", () => {
  // The logout line is scope mode's alone: with the linger file it is the full answer, without it the line says
  // sessions end at the last logout and carries its fix; in session mode there is none. The lines come in About's
  // order and make a valid report.
  it('U-PLT-10 · the logout line: scope mode with the linger file (no fix) and without it (the line and its fix); session mode (no line)', () => {
    const lines = linuxLines(STOCK)
    expect(zPlatformReport.parse({ system: 'linux', version: 'Linux 6.8.0', arch: 'arm64', lines }).lines).toEqual(lines)
    const ids = lines.map((l) => l.id)
    expect(ids).toEqual(PLATFORM_LINES.filter((id) => ids.includes(id)))
    expect(ids).toEqual(['holderDetach', 'admission', 'holderVisibility', 'logout'])
    expect(byId(STOCK).get('logout')).toEqual({ id: 'logout', label: 'After you log out', value: 'sessions end at your last logout, as on macOS', fix: 'Run `loginctl enable-linger` to keep sessions running after you log out' })
    expect(byId({ ...STOCK, linger: true }).get('logout')).toMatchObject({ value: 'sessions keep running (linger is on)', fix: null })
    expect(byId({ ...STOCK, userManager: false }).has('logout'), 'session mode').toBe(false)
    expect(byId({ ...STOCK, userManager: false, linger: true }).has('logout')).toBe(false)
  })

  // The other terminal lines: the detach mode (a scope is the full answer; session mode says what it risks, with the
  // ExitType=main caveat when Kea runs in a service, and its fix), admission (full; ptrace-open under ptrace_scope 0 or
  // no Yama, with the sysctl fix; path-only when Kea's files are the user's) and holder visibility (hidepid).
  it('U-PLT-10 · the detach, admission and visibility lines, each the full answer or with its one-sentence fix', () => {
    const stock = byId(STOCK)
    expect(stock.get('holderDetach')).toMatchObject({ value: 'each in a systemd scope of its own, which outlives Kea', fix: null })
    expect(stock.get('admission')).toMatchObject({ label: 'Session isolation', fix: null })
    expect(stock.get('admission')!.value).toMatch(/^full/)
    expect(stock.get('holderVisibility')).toMatchObject({ value: 'visible to Kea in /proc', fix: null })

    const session = byId({ ...STOCK, userManager: false }).get('holderDetach')!
    expect(session.value).toMatch(/^each in a session of its own.*may end if your desktop stops Kea\.$/)
    expect(session.fix).toMatch(/systemd user manager/)
    const service = byId({ ...STOCK, userManager: false, keaService: 'app-kea@0f1e.service' }).get('holderDetach')!
    expect(service.value).toMatch(/Kea runs in app-kea@0f1e\.service: if that service ends with Kea's main process \(ExitType=main\), they end when Kea quits\.$/)

    for (const ptraceScope of [0, null]) {
      expect(byId({ ...STOCK, ptraceScope }).get('admission'), `ptrace_scope ${ptraceScope}`).toMatchObject({ fix: 'Run `sudo sysctl -w kernel.yama.ptrace_scope=1`' })
      // the remaining risk: ptyhost can be traced, and through it every terminal reached
      expect(byId({ ...STOCK, ptraceScope }).get('admission')!.value).toMatch(/ptrace_scope 0 any of your processes can trace Kea's terminal process \(ptyhost\) and reach every terminal through it$/)
    }
    for (const ptraceScope of [2, 3]) expect(byId({ ...STOCK, ptraceScope }).get('admission')!.fix).toBeNull()
    expect(byId({ ...STOCK, rootOnly: false, ptraceScope: 0 }).get('admission'), 'path-only first').toMatchObject({ value: "reduced (Kea's files are writable by your user)" })

    const hidden = byId({ ...STOCK, hidepid: 'invisible' }).get('holderVisibility')!
    expect(hidden.value).toMatch(/^hidden by \/proc's hidepid=invisible: /)
    expect(hidden.fix).toMatch(/^Mount \/proc without hidepid/)
    for (const l of linuxLines({ ...STOCK, userManager: false, rootOnly: false, ptraceScope: 0, hidepid: '2' })) if (l.fix) expect(l.fix, l.id).toMatch(/^[A-Z]/)
  })

  it("U-PLT-10 · the facts: Kea's unit is a service only when its cgroup path ends in one; the linger file is the user's own file", () => {
    expect(serviceOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.kde.kea@4f2c.service\n')).toBe('app-org.kde.kea@4f2c.service')
    expect(serviceOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-kea-4242.scope\n')).toBeNull()
    expect(serviceOf('0::/\n')).toBeNull()
    expect(serviceOf('')).toBeNull()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-plt-10-'))
    try {
      fs.writeFileSync(path.join(dir, 'ana'), '')
      fs.mkdirSync(path.join(dir, 'bo'))
      expect([lingerOn('ana', dir), lingerOn('bo', dir), lingerOn('cy', dir)]).toEqual([true, false, false])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the platform report's facts that may not be there", () => {
  it('U-PLT-53 · a user with no passwd entry (a container, some CI): os.userInfo() throws, and the facts still come, the linger file read as absent, so the report is assembled rather than lost for the run', () => {
    const facts = linuxFacts(() => {
      throw new Error('ENOENT: no such file or directory, uv_os_get_passwd')
    })
    expect(facts.linger).toBe(false)
    expect(zPlatformReport.safeParse({ system: 'linux', version: 'Linux 6.8.0', arch: 'arm64', lines: linuxLines(facts) }).success).toBe(true)
  })

  it('U-PLT-54 · the system is named by os-release (PRETTY_NAME, else NAME and VERSION_ID; quoted or not, with its escapes) and the kernel follows it; with no os-release the kernel alone', () => {
    const recorded = fs.readFileSync(path.join(FIXTURES, 'os-release'), 'utf8')
    expect(osReleaseName(recorded)).toBe('Ubuntu 24.04.5 LTS')
    expect(osReleaseName('NAME=Fedora Linux\nVERSION_ID=41\n')).toBe('Fedora Linux 41')
    expect(osReleaseName("NAME='Arch Linux'\nID=arch\n")).toBe('Arch Linux')
    expect(osReleaseName('PRETTY_NAME="A \\"quoted\\" name"\n# a comment\n')).toBe('A "quoted" name')
    expect(osReleaseName('')).toBeNull()
    expect(osReleaseName('ID=nameless\n')).toBeNull()
    expect(linuxVersion('Ubuntu 24.04.5 LTS', '6.8.0-45-generic')).toBe('Ubuntu 24.04.5 LTS (Linux 6.8.0-45-generic)')
    expect(linuxVersion(null, '6.8.0-45-generic')).toBe('Linux 6.8.0-45-generic')
  })
})

// ── the window, its menu and the desktop ────────────────────────────────────────────────────────

type Item = MenuItemConstructorOptions
const sub = (m: Item | undefined): Item[] => (m?.submenu as Item[] | undefined) ?? []
const every = (items: Item[]): Item[] => items.flatMap((i) => [i, ...every(sub(i))])

function linuxMenuInput(o: Partial<MenuInput> = {}): MenuInput & { sent: string[] } {
  const sent: string[] = []
  return { appName: 'Kea', renderer: null, hasWindow: true, dev: false, send: (id) => sent.push(id), main: { openKea: () => sent.push('main:openKea'), closeToMenuBar: () => sent.push('main:closeToMenuBar'), quit: () => sent.push('main:quit'), reload: () => undefined }, chrome: need(linux.menu), system: protocolLinux, sent, ...o }
}

describe('the window on Linux', () => {
  // The menu the header's button and `Alt` open is the registry's: File, Edit, View, Session, Go, Window, Help,
  // each command once, in the table's order within its menu; Go gathers the navigation commands. No item registers a
  // key the terminal needs: the renderer's items and the Edit roles are shown, not registered, and the Window menu has
  // no role (Electron's bring Ctrl+M, Ctrl+W, F11). Main's own items keep their registered keys, which fire with no
  // window. macOS keeps its menu bar and has no button. The button and `Alt` alone are the renderer's (windowMenu.test.ts).
  it('U-PLT-17 · the Linux menu: File … Help from the registry, Go gathering navigation, no key taken from the terminal; macOS has no button', () => {
    const input = linuxMenuInput()
    const t = menuTemplate(input)
    expect(t.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Session', 'Go', 'Window', 'Help'])
    const menu = (label: string) => t.find((m) => m.label === label)
    const ids = (label: string) => every(sub(menu(label))).flatMap((i) => (i.id ? [i.id] : []))
    expect(ids('Go')).toEqual(GO_COMMANDS)
    // File: the Project commands, the App ones but Help's, then Close Kea and Quit Kea Completely
    expect(ids('File').slice(-2)).toEqual(['app.closeToMenuBar', 'app.quit'])
    expect(sub(menu('File')).find((i) => i.id === 'app.closeToMenuBar')).toMatchObject({ label: 'Close Kea (sessions keep running)', accelerator: 'Ctrl+Shift+Q' })
    expect(ids('File')).not.toContain('app.shortcuts')
    expect(ids('Help')).toEqual(['help:app.shortcuts', 'help:app.copyDiagnostics'])
    expect(ids('File'), 'Open Kea only with no window').not.toContain('app.openKea')
    expect(every(menuTemplate(linuxMenuInput({ hasWindow: false }))).some((i) => i.id === 'app.openKea')).toBe(true)
    // every command of the table is in the menu once, but main's own with a window and Help's two (also in File on macOS)
    const all = every(t).flatMap((i) => (i.id ? [i.id.replace(/^help:/, '')] : []))
    expect(new Set(all).size, 'no command twice').toBe(all.length)
    for (const c of COMMANDS) if (c.id !== 'app.openKea') expect(all, c.id).toContain(c.id)
    // within a menu and each of its submenus, the table's order
    const order = new Map(COMMANDS.map((c, i) => [c.id, i]))
    const lists = [...['File', 'View', 'Session'].map((l) => sub(menu(l))), ...sub(menu('View')).filter((i) => i.submenu).map((i) => sub(i))]
    for (const list of lists) {
      const got = list.flatMap((i) => (i.id && order.has(i.id) && !i.id.startsWith('app.') ? [i.id] : []))
      expect(got).toEqual([...got].sort((a, b) => order.get(a)! - order.get(b)!))
    }
    // no key the terminal needs: every role and every renderer item is shown, not registered; the Window menu has no role
    for (const i of every(t)) {
      if (i.role) expect(i.registerAccelerator, `${i.role} registers no key`).toBe(false)
      if (i.accelerator && i.id && !['app.closeToMenuBar', 'app.quit', 'app.openKea'].includes(i.id)) expect(i.registerAccelerator, i.id).toBe(false)
      if (i.accelerator && i.registerAccelerator !== false) expect(i.accelerator, `${i.id ?? i.label}: never a plain Ctrl+<letter>`).toMatch(/^Ctrl\+(Shift|Alt)\+/)
    }
    expect(every(sub(menu('Window'))).filter((i) => i.role || i.accelerator)).toEqual([])
    expect(sub(menu('Edit')).find((i) => i.role === 'copy')).toMatchObject({ accelerator: 'Ctrl+Shift+C', registerAccelerator: false })
    // a renderer item goes to the renderer; main's run in main (the accelerators' path)
    ;(every(t).find((i) => i.id === 'session.next')!.click as () => void)()
    ;(sub(menu('File')).find((i) => i.id === 'app.closeToMenuBar')!.click as () => void)()
    expect(input.sent).toEqual(['session.next', 'main:closeToMenuBar'])
    // macOS: the menu bar, no button
    expect([need(linux.menu).inWindow, need(darwin.menu).inWindow]).toEqual([true, false])
    expect([protocolLinux.window.menuButton, protocolDarwin.window.menuButton]).toEqual([true, false])
    expect(menuTemplate({ ...input, chrome: need(darwin.menu), system: protocolDarwin }).map((m) => m.label ?? m.role)).toEqual(['Kea', 'Edit', 'Session', 'Project', 'Terminal', 'Files', 'Viewer', 'Server', 'View', 'window', 'help'])
  })

  // The window draws that menu itself (WindowMenu.svelte, a drill-down): main hands it the template as plain items,
  // and a pick comes back by id, found again in the template
  it('U-PLT-59 · the Linux menu as plain items: File … Help as submenus, Linux keys, the Edit roles by id, separators; every pick finds its item', () => {
    const input = linuxMenuInput({ dev: true })
    const t = menuTemplate(input)
    const tree = windowMenuTree(t)
    expect(tree.map((n) => n.label)).toEqual(['File', 'Edit', 'View', 'Session', 'Go', 'Developer', 'Window', 'Help'])
    for (const n of tree) expect(n.submenu, n.label).toBeDefined()
    const menu = (label: string) => tree.find((n) => n.label === label)!.submenu!
    // Edit: the roles by id, Copy and Paste by their commands, with the keys Linux shows
    expect(menu('Edit').map((n) => (n.separator ? '—' : n.id))).toEqual(['role:undo', 'role:redo', '—', 'role:cut', 'terminal.copy', 'terminal.paste', 'terminal.selectAll'])
    expect(menu('Edit').map((n) => n.label)).toEqual(['Undo', 'Redo', '', 'Cut', 'Copy', 'Paste', 'Select All'])
    expect(menu('Edit').find((n) => n.id === 'terminal.copy')).toMatchObject({ shortcut: 'Ctrl+Shift+C', enabled: true })
    expect(menu('Edit').find((n) => n.id === 'role:undo')?.shortcut).toBe('Ctrl+Z')
    // Select All keeps the field's Ctrl+A: in a terminal that key is the shell's, and the window runs the command instead
    expect(menu('Edit').find((n) => n.id === 'terminal.selectAll')?.shortcut).toBe('Ctrl+A')
    expect(menu('Window').map((n) => n.id)).toEqual(['window.minimize', 'window.maximize', 'window.fullScreen'])
    expect(menu('File').find((n) => n.id === 'app.closeToMenuBar')).toMatchObject({ label: 'Close Kea (sessions keep running)', shortcut: 'Ctrl+Shift+Q' })
    // a command the renderer has not reported is there, disabled
    expect(menu('Go').find((n) => n.id === 'session.next')).toMatchObject({ enabled: false })
    // View's own submenus drill further; separators are lines, never picked
    expect(menu('View').some((n) => n.submenu && n.label === 'Terminal')).toBe(true)
    const flat = (ns: typeof tree): typeof tree => ns.flatMap((n) => [n, ...flat(n.submenu ?? [])])
    const nodes = flat(tree)
    expect(new Set(nodes.map((n) => n.id)).size, 'no two items share an id').toBe(nodes.length)
    for (const n of nodes.filter((x) => x.separator)) expect(n).toMatchObject({ enabled: false, label: '' })
    // every leaf's id finds its own item again; a submenu, a separator or an unknown id finds none
    for (const n of nodes.filter((x) => !x.submenu && !x.separator)) {
      const i = findMenuItem(t, n.id)
      expect(i, n.id).not.toBeNull()
      expect(i?.label ?? n.label, n.id).toBe(n.label)
    }
    expect(findMenuItem(t, 'menu:1')).toBeNull()
    expect(findMenuItem(t, nodes.find((x) => x.separator)!.id)).toBeNull()
    expect(findMenuItem(t, 'no.such.item')).toBeNull()
    // a pick runs what the native menu ran
    ;(findMenuItem(t, 'session.next')!.click as () => void)()
    ;(findMenuItem(t, 'app.closeToMenuBar')!.click as () => void)()
    expect(input.sent).toEqual(['session.next', 'main:closeToMenuBar'])
    expect(findMenuItem(t, 'terminal.selectAll')?.role).toBe('selectAll')
  })

  // On Wayland the tray's Open Kea hides and shows an open window (GNOME raises one mapped again) and replaces a
  // minimized one with a window rebuilt from its state; a notification's click and a second launch are the desktop's
  // to raise; Kea's own menu runs in its focused window. On X11 and macOS restore() and focus() work. No window: a new
  // one, whatever asked (main.ts openKea, before any raise).
  it('U-PLT-18 · Open Kea: on Wayland the tray and a notification hide and show an open window and rebuild a minimized one; on X11 restore and focus', () => {
    const how = (display: 'wayland' | 'x11', minimized: boolean, via: 'tray' | 'notification' | 'secondInstance' | 'menu') => raiseHow({ display, minimized, via })
    expect(how('wayland', false, 'tray')).toBe('remap')
    expect(how('wayland', true, 'tray')).toBe('rebuild')
    // a notification's click: GNOME 46 neither raises a window behind another app nor restores a minimized one, so Kea
    // raises it as the tray does
    expect([how('wayland', false, 'notification'), how('wayland', true, 'notification')]).toEqual(['remap', 'rebuild'])
    // a second launch: the shell focuses the open window itself
    expect(how('wayland', false, 'secondInstance')).toBe('none')
    expect(how('wayland', false, 'menu')).toBe('focus')
    for (const via of ['tray', 'notification', 'secondInstance', 'menu'] as const) for (const m of [false, true]) expect(how('x11', m, via), `x11 ${via}`).toBe('focus')
    expect(darwin.raise.how({ display: 'quartz', minimized: true, via: 'tray' })).toBe('focus')
    // the display server: Chromium's switch when it names one, else Wayland where a compositor is
    expect(displayServer({ WAYLAND_DISPLAY: 'wayland-0' }, '')).toBe('wayland')
    expect(displayServer({ WAYLAND_DISPLAY: 'wayland-0' }, 'x11')).toBe('x11')
    expect(displayServer({ DISPLAY: ':0' }, 'auto')).toBe('x11')
    expect(displayServer({}, 'wayland')).toBe('wayland')
    // a saved position comes back on X11, never on Wayland, where a window cannot place itself
    const chrome = need(linux.windowChrome)
    expect([chrome.restoresPosition('x11'), chrome.restoresPosition('wayland'), chrome.createShown]).toEqual([true, false, true])
    expect(chrome.options({ trafficLights: { x: 1, y: 2 }, overlay: { color: '#111210', symbolColor: '#A3A79A', height: 43 } })).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#111210', symbolColor: '#A3A79A', height: 43 }, autoHideMenuBar: true })
  })
})

describe('notifications, the badge and the platform report on Linux', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-plt-'))
    dirs.push(d)
    return d
  }

  // Electron drops `subtitle` on Linux: Kea folds it into the body as its first line. Linux keeps no permission for an
  // app's notifications, so Settings has no link; the badge is `setBadgeCount` (Unity's LauncherEntry).
  it('U-PLT-20 · notifications: the subtitle folded into the body; no permission and no settings link; the badge through setBadgeCount', () => {
    expect(foldSubtitle('kea/fix-login · Claude', 'Wants to run git push')).toBe('kea/fix-login · Claude\nWants to run git push')
    expect([foldSubtitle('', 'Body'), foldSubtitle('Sub', '')]).toEqual(['Body', 'Sub'])
    const made: Record<string, unknown>[] = []
    const Fake = function (this: unknown, o: Record<string, unknown>) {
      made.push(o)
    } as unknown as typeof Notification
    need(linux.notify).create(Fake, { id: 's:1', title: 'Fix login', subtitle: 'kea/fix-login', body: 'Needs you', silent: true })
    expect(made).toEqual([{ title: 'Fix login', body: 'kea/fix-login\nNeeds you', silent: true }])
    expect([need(linux.notify).permission, need(darwin.notify).permission]).toEqual([false, true])
    expect([protocolLinux.window.notificationSettings, protocolDarwin.window.notificationSettings]).toEqual([false, true])
    const counts: number[] = []
    const app = { setBadgeCount: (n: number) => counts.push(n) > 0 } as unknown as App
    for (const text of ['3', '', '12']) need(linux.badge).set(app, text)
    expect(counts).toEqual([3, 0, 12])
    // the setting reads "Badge" here
    expect([protocolLinux.words.badge, protocolDarwin.words.badge]).toEqual(['Badge', 'Badge count'])
  })

  // WebGL where Chromium has WebGL2, else xterm's DOM renderer, with why and the fix. Kea never asks for WebGL in
  // software: no source file passes `--enable-unsafe-swiftshader`.
  it('U-PLT-21 · the terminal renderer line: WebGL, or the DOM renderer with its reason; --enable-unsafe-swiftshader is never passed', () => {
    expect(terminalRendererLine('enabled', GPU_DRIVER_FIX)).toEqual({ id: 'terminalRenderer', label: 'Terminal drawing', value: 'WebGL, on the GPU', fix: null })
    expect(terminalRendererLine('enabled_readback', GPU_DRIVER_FIX).fix).toBeNull()
    const off = terminalRendererLine('unavailable_off', GPU_DRIVER_FIX)
    expect(off.value).toMatch(/^xterm's DOM renderer, as Chromium has no WebGL2 here \(unavailable_off\)/)
    expect(off.fix).toMatch(/GPU driver/)
    const root = path.resolve(import.meta.dirname, '..', '..', '..', '..')
    const flag = ['--enable', 'unsafe', 'swiftshader'].join('-')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'target' || e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (p !== import.meta.filename && /\.(ts|svelte|js|cjs|mjs|rs|sh|json|toml)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(flag)) hits.push(path.relative(root, p))
      }
    }
    for (const top of ['app', 'packages', 'tools', 'native', 'constants']) walk(path.join(root, top))
    expect(hits).toEqual([])
  })

  // The desktop line carries the primary display's scale, which tells a page drawn at the desktop's scale from one the
  // desktop's text scaling enlarged; a fractional scale is shown to two places, and none is shown before it is known.
  it('U-PLT-62 · the desktop line names the primary display’s scale', () => {
    const at = (scale: number | null) => desktopLines({ desktop: 'ubuntu:GNOME', display: 'wayland', scale, trayHost: true, notifications: true, desktopFile: { id: 'dev.kea.app', found: true }, idle: 'system', webgl2: 'enabled', watches: 1, watchLimit: 2, watchLimitHeld: false }).find((l) => l.id === 'desktop')!
    expect(at(1).value).toBe('ubuntu:GNOME, Wayland, primary display at scale 1')
    expect(at(1.25).value).toBe('ubuntu:GNOME, Wayland, primary display at scale 1.25')
    expect(at(4 / 3).value).toBe('ubuntu:GNOME, Wayland, primary display at scale 1.33')
    expect(at(null).value).toBe('ubuntu:GNOME, Wayland')
    expect(at(1.25).fix).toBeNull()
  })

  // The platform report's desktop lines: the desktop and session, the terminal renderer, the tray host (with the
  // AppIndicator fix), notifications (the service, and the desktop file a click needs), the idle source and Kea's
  // inotify watches (with the sysctl fix once core holds a limit); a report in About's order that the schema takes.
  it("U-PLT-33 · the report's desktop lines: each the full answer or with its fix, in About's order", () => {
    const base: Parameters<typeof desktopLines>[0] = { desktop: 'ubuntu:GNOME', display: 'wayland', scale: null, trayHost: true, notifications: true, desktopFile: { id: 'dev.kea.app.dev', found: true }, idle: 'system', webgl2: 'enabled', watches: 120, watchLimit: 65536, watchLimitHeld: false }
    const byLine = (o: Partial<typeof base>) => new Map(desktopLines({ ...base, ...o }).map((l) => [l.id, l]))
    const ok = byLine({})
    expect(ok.get('desktop')!.value).toBe('ubuntu:GNOME, Wayland')
    expect([...ok.values()].map((l) => l.fix)).toEqual([null, null, null, null, null, null])
    expect(ok.get('inotify')!.value).toBe('Kea holds 120 inotify watches of this user’s 65536 (fs.inotify.max_user_watches)')
    expect(byLine({ trayHost: false }).get('trayHost')!.fix).toMatch(/AppIndicator/)
    expect(byLine({ desktopFile: { id: 'dev.kea.app.dev', found: false } }).get('notifications')!.fix).toMatch(/pnpm dev/)
    // without the desktop file the dock has no icon of Kea's to badge
    expect(byLine({ desktopFile: { id: 'dev.kea.app.dev', found: false } }).get('notifications')!.value).toMatch(/badge/)
    expect(byLine({ desktopFile: { id: 'dev.kea.app', found: false } }).get('notifications')!.fix).toMatch(/package/)
    expect(byLine({ notifications: false }).get('notifications')!.fix).not.toBeNull()
    expect(byLine({ idle: 'kea' }).get('idle')!.fix).toMatch(/idle protocol/)
    expect(byLine({ display: 'x11' }).get('idle')!.value).toMatch(/X server/)
    expect(byLine({ watchLimitHeld: true }).get('inotify')!.fix).toMatch(/^Raise it: sudo sysctl fs\.inotify\.max_user_watches=\d+/)
    expect(byLine({ watches: null, watchLimit: null }).get('inotify')!.value).toBe('Kea holds an unknown number of inotify watches')
    // the whole report: Linux's own lines with these, in About's order
    const lines = [...linuxLines(STOCK), sandboxLine('userns', '/opt/Kea/kea-app'), ...desktopLines(base)]
    const sorted = [...lines].sort((a, b) => PLATFORM_LINES.indexOf(a.id) - PLATFORM_LINES.indexOf(b.id))
    expect(zPlatformReport.parse({ system: 'linux', version: 'Linux 6.8.0', arch: 'arm64', lines: sorted }).lines.map((l) => l.id)).toEqual(['desktop', 'holderDetach', 'admission', 'holderVisibility', 'logout', 'rendererSandbox', 'terminalRenderer', 'trayHost', 'notifications', 'idle', 'inotify'])
    // the desktop file is looked for where the desktop looks: $XDG_DATA_HOME, then $XDG_DATA_DIRS
    const home = tmp()
    const data = tmp()
    fs.mkdirSync(path.join(data, 'applications'), { recursive: true })
    fs.writeFileSync(path.join(data, 'applications', 'dev.kea.app.desktop'), '[Desktop Entry]\n')
    expect(desktopFileFound('dev.kea.app', { XDG_DATA_DIRS: data }, home)).toBe(true)
    expect(desktopFileFound('dev.kea.app.dev', { XDG_DATA_DIRS: data }, home)).toBe(false)
  })

  // The renderer's sandbox read from its own process: seccomp in filter mode in a pid namespace of its own; a
  // user namespace maps ids, the set-uid helper's processes stay in the first one. Off, the line says how to fix it.
  // The idle source, and the watches counted from a process's inotify descriptors.
  it('U-PLT-34 · the sandbox, idle and inotify facts: read from /proc as Linux writes them', () => {
    const status = (seccomp: string, nspid: string) => `Name:\tkea\nNSpid:\t${nspid}\nSeccomp:\t${seccomp}\n`
    expect(sandboxedBy(status('2', '4321 1'), '         0       1000          1\n')).toBe('userns')
    expect(sandboxedBy(status('2', '4321 7'), '         0          0 4294967295\n')).toBe('setuid')
    expect(sandboxedBy(status('0', '4321'), null)).toBe('none')
    expect(sandboxedBy(status('2', '4321'), null), 'no pid namespace of its own').toBe('none')
    expect(sandboxLine('none', '/opt/Kea/kea-app').fix).toBe('Start Kea without --no-sandbox; if Chromium cannot start its sandbox, run sudo chown root:root /opt/Kea/chrome-sandbox and sudo chmod 4755 /opt/Kea/chrome-sandbox.')
    expect(sandboxLine('userns', '/x').fix).toBeNull()
    expect(sandboxLine(null, '/x').value).toMatch(/^not known/)
    // the idle time: the system's on X11, under mutter's monitor and once it has read above 0; else Kea's own windows'
    expect(idleSource({ display: 'x11', mutterIdleMonitor: null, systemSeenAboveZero: false })).toBe('system')
    expect(idleSource({ display: 'wayland', mutterIdleMonitor: true, systemSeenAboveZero: false })).toBe('system')
    expect(idleSource({ display: 'wayland', mutterIdleMonitor: false, systemSeenAboveZero: true })).toBe('system')
    expect(idleSource({ display: 'wayland', mutterIdleMonitor: false, systemSeenAboveZero: false })).toBe('kea')
    expect(darwin.idle.source({ display: 'quartz', mutterIdleMonitor: null, systemSeenAboveZero: false })).toBe('system')
    // inotify: the `inotify wd:` lines of the descriptors that are inotify instances, in a /proc laid out as Linux's
    const proc = tmp()
    fs.mkdirSync(path.join(proc, '42', 'fd'), { recursive: true })
    fs.mkdirSync(path.join(proc, '42', 'fdinfo'), { recursive: true })
    const fixture = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'os', 'linux', 'inotify-fdinfo'), 'utf8')
    const wd = fixture.split('\n').filter((l) => l.startsWith('inotify wd:')).length
    fs.symlinkSync('anon_inode:inotify', path.join(proc, '42', 'fd', '7'))
    fs.writeFileSync(path.join(proc, '42', 'fdinfo', '7'), fixture)
    fs.symlinkSync('/dev/null', path.join(proc, '42', 'fd', '3'))
    fs.writeFileSync(path.join(proc, '42', 'fdinfo', '3'), 'pos:\t0\ninotify wd:1 ino:2\n')
    expect(wd).toBeGreaterThan(0)
    expect(inotifyWatches(42, proc)).toBe(wd)
    expect(inotifyWatches(43, proc), 'a process that is gone').toBeNull()
  })
})

describe('Chromium’s zygotes for the footprint sampler', () => {
  // The tree a dev build had in an Ubuntu 24.04 VM under the set-uid sandbox: the unsandboxed zygote and the sandbox's
  // helper are main's children, the sandboxed zygote the helper's, its forked zygote that one's; the GPU process is the
  // first zygote's child, the renderer the last one's. Chromium rewrites each title into one string.
  const E = '/x/electron/dist/electron'
  const titles = new Map<number, string>([
    [100, `${E} --inspect=0 --kea-home=/tmp/h --kea-perf`],
    [101, `${E} --type=zygote --no-zygote-sandbox`],
    [102, ['/x/electron/dist/chrome-sandbox', E, '--type=zygote'].join('\0')],
    [103, `${E} --type=zygote`],
    [104, `${E} --type=zygote`],
    [105, `${E} --type=gpu-process --user-data-dir=/u`],
    [106, `${E} --type=renderer --user-data-dir=/u`],
    [107, `${E} --type=utility --utility-sub-type=node.mojom.NodeService`],
    [200, '/usr/bin/zsh'], // os-ok: test data
    [201, `${E} --type=zygote`], // another app's zygote
  ])
  const parents = new Map<number, number>([
    [100, 1],
    [101, 100],
    [102, 100],
    [103, 102],
    [104, 103],
    [105, 101],
    [106, 104],
    [107, 100],
    [200, 107],
    [201, 1],
  ])

  it('U-PLT-47 · main’s descendants whose command line says --type=zygote, the sandbox’s helper among them; not their children, nor another app’s; the parent from a stat line whose name holds spaces and parentheses', () => {
    const read: number[] = []
    const cmdline = (pid: number) => {
      read.push(pid)
      return titles.get(pid) ?? ''
    }
    expect(zygotePids(parents, 100, cmdline)).toEqual([101, 102, 103, 104])
    expect(read.includes(201), 'only main’s descendants are read').toBe(false)
    expect(zygotePids(parents, 999, cmdline), 'a main with no children').toEqual([])
    expect(statParent('4268 (ele) ctron (x)) S 4265 4265 4192 0 -1 4194560 3 0 0 0 0 0 0 0 20 0 1 0 33132')).toBe(4265)
    expect(statParent('')).toBeNull()
    expect(linux.zygotes, 'Linux names its zygotes').toBeDefined()
    expect(darwin.zygotes.of(process.pid), 'a Mac has none').toEqual([])
  })
})
