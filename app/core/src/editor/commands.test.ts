// Editors, terminal apps and opening files where an app is a command (Linux). Pure parts against recorded desktop
// entries (fixtures/os/linux/desktop/) and detection over a temp folder with stand-in commands: both run on every
// system. Nothing is launched: `run` and `launch` are recorders.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { noopLogger } from '@kea/kit'
import { L, settingRows } from '@kea/protocol'
import { darwin as protocolDarwin } from '@kea/protocol/os/darwin'
import { linux as protocolLinux } from '@kea/protocol/os/linux'
import { afterEach, describe, expect, it } from 'vitest'
import { darwin } from '../os/darwin.ts'
import { coreOs } from '../os/index.ts'
import { linux } from '../os/linux.ts'
import { thisSystemsRows } from '../settings/settings.ts'
import { FILE_MANAGER, opensSafely } from '../viewer/openable.ts'
import { linuxLaunchPlan, type LaunchTarget } from './argv.ts'
import { editorDef, LINUX_TERMINAL_APP_DEFS, TERMINAL_APP_DEFS, type EditorDef } from './catalog.ts'
import { detectCommands } from './commands.ts'
import { execProgram, parseDesktopEntry, parseExec } from './desktop.ts'
import { Editors } from './editors.ts'
import type { CommandHost } from './host.ts'

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/os/linux/desktop/', import.meta.url))
const entry = (name: string) => parseDesktopEntry(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
const def = (id: string): EditorDef => editorDef(id) as EditorDef
const at = (file: string | null, line: number | null = null, col: number | null = null): LaunchTarget => ({ dir: '/w/tree', file, line, col })

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tempRoot(): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-editors-linux-')))
  dirs.push(tmp)
  return tmp
}

/** An executable stand-in at `file` (never run here). */
function tool(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
  return file
}

/** A desktop entry `<data>/applications/<id>.desktop` whose `Exec` starts `program`. */
function desktopEntry(data: string, id: string, program: string, more = ''): void {
  fs.mkdirSync(path.join(data, 'applications'), { recursive: true })
  fs.writeFileSync(path.join(data, 'applications', `${id}.desktop`), `[Desktop Entry]\nType=Application\nName=${id}\nExec=${program} %F\n${more}`)
}

/** A command host over `root` (as the harness's, with `searchPath` and `known` to say what else is looked at). */
function hostOver(root: string, o: { searchPath?: boolean; known?: Record<string, string[]> } = {}): CommandHost {
  return { kind: 'commands', searchPath: o.searchPath ?? true, knownPlaces: (c) => o.known?.[c] ?? [], dataDirs: () => [path.join(root, 'share')], open: path.join(root, 'bin', 'xdg-open'), gh: () => null }
}

/** Editors over a command host; every run and every detached launch is recorded, none happens. */
function editorsOver(host: CommandHost, o: { env: Record<string, string>; cwd: string; projects: string[]; fail?: (file: string) => boolean; terminalApp?: string }) {
  const ran: { file: string; args: string[] }[] = []
  const launched: { file: string; args: string[]; cwd: string | undefined }[] = []
  const run = (async (file: string, args: string[]) => {
    ran.push({ file, args: [...args] })
    const code = o.fail?.(file) ? 1 : 0
    return { code, signal: null, stderr: code ? 'it did not start\n' : '', timedOut: false, truncated: false, cancelled: false, stdoutBytes: 0, stdout: Buffer.alloc(0) }
  }) as never
  const launch = (async (file: string, args: string[], lo: { cwd?: string }) => {
    if (o.fail?.(file)) throw new Error(`spawn ${file} failed (ENOENT)`)
    launched.push({ file, args: [...args], cwd: lo.cwd })
    return { pid: 1 }
  }) as never
  const ed = new Editors({ log: noopLogger, host, env: async () => o.env, run, launch })
  const sessions = [{ id: 's0', cwd: o.cwd }]
  ed.bind({
    sessions: { store: { get: (id: string) => sessions.find((x) => x.id === id), values: () => sessions.values() } } as never,
    projects: { get: () => undefined, list: () => o.projects.map((rootPath) => ({ rootPath })) } as never,
    configured: () => 'vscode',
    terminalApp: () => (o.terminalApp ?? 'auto') as never,
  })
  return { ed, ran, launched }
}

describe('editors on Linux: desktop entries', () => {
  it('U-PLT-23 · a desktop entry is read as the specification says: the main group only, the first value of a key, no localised keys; Exec as argv with quotes, escapes and field codes; env prefixes skipped; a hidden entry is gone', () => {
    // VS Code's own package: the window binary itself (never run), the action's Exec ignored
    expect(entry('code.desktop')).toEqual({ exec: ['/usr/share/code/code'], tryExec: null, hidden: false, application: true })
    // the snap's: `env NAME=value program …`
    const snap = entry('code_code.desktop')
    expect(snap.exec?.slice(0, 2)).toEqual(['env', 'BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/code_code.desktop'])
    expect(execProgram(snap.exec ?? [])).toBe('/snap/bin/code')
    // Zed's install script: an absolute program in the home folder, with a TryExec
    const zed = entry('dev.zed.Zed.desktop')
    expect(execProgram(zed.exec ?? [])).toBe('/home/HOME___/.local/zed.app/libexec/zed-editor')
    expect(zed.tryExec).toBe('/home/HOME___/.local/zed.app/libexec/zed-editor')
    // quotes keep spaces; \" \$ inside them; a field code alone is dropped, one inside an argument removed; %% is %
    expect(entry('quoted.desktop').exec).toEqual(['/opt/My Editor/editor', '--title', 'a "quoted" $word', '--x=', '100%'])
    expect(entry('hidden.desktop')).toMatchObject({ hidden: true, application: true })
    expect(parseExec('"unclosed --x')).toBeNull()
    expect(parseExec('%F')).toBeNull()
    expect(parseDesktopEntry('[Other Group]\nExec=/x\n').exec).toBeNull()
    expect(execProgram(['env', 'A=1'])).toBeNull()
  })

  it('U-PLT-23 · the OS layer: Linux looks in the XDG data folders (their defaults when unset), in an editor’s known places, and opens with xdg-open; macOS keeps its bundles and open', () => {
    const e = linux.editors
    if (!('kind' in e) || e.kind !== 'commands') throw new Error('Linux finds commands')
    expect(e.dataDirs({}, '/home/HOME___')).toEqual(['/home/HOME___/.local/share', '/usr/local/share', '/usr/share'])
    expect(e.dataDirs({ XDG_DATA_HOME: '/x/data', XDG_DATA_DIRS: '/var/lib/snapd/desktop:relative:/usr/share' }, '/home/HOME___')).toEqual(['/x/data', '/var/lib/snapd/desktop', '/usr/share'])
    expect(e.knownPlaces('code', '/home/HOME___')).toEqual(['/usr/share/code/bin/code', '/snap/bin/code'])
    expect(e.knownPlaces('zed', '/home/HOME___')).toEqual(['/home/HOME___/.local/bin/zed'])
    expect(e.knownPlaces('zeditor', '/home/HOME___')).toEqual(['/usr/bin/zeditor']) // os-ok: test data
    expect(e.open).toBe('/usr/bin/xdg-open') // os-ok: test data
    expect(e.terminalApps).toEqual(LINUX_TERMINAL_APP_DEFS.map((d) => d.id))
    const m = darwin.editors
    if (!('kind' in m) || m.kind !== 'bundles') throw new Error('macOS finds bundles')
    expect(m.open).toBe('/usr/bin/open') // os-ok: test data
    expect(m.terminalApps).toEqual(TERMINAL_APP_DEFS.map((d) => d.id))
  })
})

describe('editors on Linux: finding them', () => {
  it('U-PLT-23 · an editor is its command on the PATH, in its known places, or its command-line tool beside its desktop entry’s program, never that program; nothing inside a project or a session’s folder is ever used, by place or through a link; a hidden entry or one whose TryExec is gone counts for nothing; the harness’s host never searches the PATH', async () => {
    const root = tempRoot()
    const repo = path.join(root, 'Developer', 'repo')
    const share = path.join(root, 'share')
    const bin = path.join(root, 'usr', 'bin')
    tool(path.join(bin, 'code'))
    // a repository on the PATH (a tool added its node_modules/.bin) and a link in a PATH folder that leads into it
    tool(path.join(repo, 'node_modules', '.bin', 'cursor'))
    fs.mkdirSync(repo, { recursive: true })
    fs.symlinkSync(tool(path.join(repo, 'tools', 'windsurf')), path.join(bin, 'windsurf'))
    // Zed installed by its script: the desktop entry starts libexec/zed-editor; its CLI is bin/zed beside it
    const zedApp = path.join(root, 'home', '.local', 'zed.app')
    tool(path.join(zedApp, 'libexec', 'zed-editor'))
    const zedCli = tool(path.join(zedApp, 'bin', 'zed'))
    desktopEntry(share, 'dev.zed.Zed', path.join(zedApp, 'libexec', 'zed-editor'))
    // VS Code Insiders from a tarball: only the window binary, no bin/code-insiders: not installed (never run the GUI)
    desktopEntry(share, 'code-insiders', tool(path.join(root, 'opt', 'insiders', 'code-insiders')))
    // terminal apps: kitty on the PATH; Konsole by its entry; an entry whose program is not Ptyxis; a hidden one; a gone TryExec
    tool(path.join(bin, 'kitty'))
    desktopEntry(share, 'org.kde.konsole', tool(path.join(root, 'kde', 'konsole')))
    desktopEntry(share, 'org.gnome.Ptyxis', tool(path.join(root, 'flatpak', 'run-something')))
    desktopEntry(share, 'org.gnome.Terminal', tool(path.join(root, 'gt', 'gnome-terminal')), 'Hidden=true\n')
    desktopEntry(share, 'org.wezfurlong.wezterm', tool(path.join(root, 'wz', 'wezterm')), `TryExec=${path.join(root, 'wz', 'gone')}\n`)
    const env = { PATH: [path.join(repo, 'node_modules', '.bin'), bin, 'relative/bin'].join(':') }
    const off = [repo]

    const found = await detectCommands(hostOver(root), env, off)
    expect(found.editors.map((e) => [e.def.id, e.app])).toEqual([
      ['vscode', path.join(bin, 'code')],
      ['zed', zedCli],
    ])
    expect(found.terminalApps.map((t) => [t.def.id, t.app])).toEqual([
      ['kitty', path.join(bin, 'kitty')],
      ['konsole', path.join(root, 'kde', 'konsole')],
    ])
    // a known place is looked at after the PATH
    const known = tool(path.join(root, 'snap', 'bin', 'code-insiders'))
    expect((await detectCommands(hostOver(root, { known: { 'code-insiders': [known] } }), env, off)).editors.map((e) => e.def.id)).toEqual(['vscode', 'vscode-insiders', 'zed'])
    // the harness's host: never the PATH, only its own places
    const sandboxed = await detectCommands(hostOver(root, { searchPath: false, known: { code: [path.join(root, 'nothing', 'code')] } }), env, off)
    expect(sandboxed.editors.map((e) => e.def.id)).toEqual(['zed'])
    expect(sandboxed.terminalApps.map((t) => t.def.id)).toEqual(['konsole'])
  })
})

describe('editors on Linux: desktop entries a same-user process can put in place', () => {
  it('U-PLT-51 · a FIFO, a device or a file over desktop_entry_max_bytes where a desktop entry is looked for never blocks or loads core: each is passed over as not there and the next data folder’s entry is used; an entry that is a link to a regular file (a Flatpak export) is read', () => {
    const root = tempRoot()
    const user = path.join(root, 'home', '.local', 'share')
    const system = path.join(root, 'usr', 'share')
    fs.mkdirSync(path.join(user, 'applications'), { recursive: true })
    // Zed: a FIFO at the user's entry (an agent's mkfifo), the real entry in the system folder
    const zedApp = path.join(root, 'opt', 'zed.app')
    tool(path.join(zedApp, 'libexec', 'zed-editor'))
    const zedCli = tool(path.join(zedApp, 'bin', 'zed'))
    execFileSync('/usr/bin/mkfifo', [path.join(user, 'applications', 'dev.zed.Zed.desktop')]) // os-ok: in /usr/bin on both systems
    desktopEntry(system, 'dev.zed.Zed', path.join(zedApp, 'libexec', 'zed-editor'))
    // Konsole: a file over the cap at the user's entry (sparse: nothing written), the real one in the system folder
    const big = path.join(user, 'applications', 'org.kde.konsole.desktop')
    fs.closeSync(fs.openSync(big, 'w'))
    fs.truncateSync(big, L.desktopEntryMaxBytes + 1)
    desktopEntry(system, 'org.kde.konsole', tool(path.join(root, 'kde', 'konsole')))
    // Ptyxis: the user's entry is a link to a device; WezTerm: a link to a regular entry elsewhere (Flatpak's exports)
    fs.symlinkSync('/dev/zero', path.join(user, 'applications', 'org.gnome.Ptyxis.desktop'))
    const exports = path.join(root, 'flatpak', 'exports', 'share')
    desktopEntry(exports, 'org.wezfurlong.wezterm', tool(path.join(root, 'wz', 'wezterm')))
    fs.symlinkSync(path.join(exports, 'applications', 'org.wezfurlong.wezterm.desktop'), path.join(user, 'applications', 'org.wezfurlong.wezterm.desktop'))
    // in a child: a blocked open would hold its thread for good, so the child's time is bounded from outside
    const script = path.join(root, 'detect.ts')
    const mod = JSON.stringify(fileURLToPath(new URL('./commands.ts', import.meta.url)))
    fs.writeFileSync(
      script,
      `import { detectCommands } from ${mod}
const host = { kind: 'commands', searchPath: false, knownPlaces: () => [], dataDirs: () => ${JSON.stringify([user, system])}, open: '/nowhere/xdg-open', gh: () => null }
const found = await detectCommands(host, { PATH: '' }, [])
process.stdout.write('DONE ' + JSON.stringify({ editors: found.editors.map((e) => [e.def.id, e.app]), terminalApps: found.terminalApps.map((t) => [t.def.id, t.app]) }) + '\\n')
process.exit(0)
`,
    )
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' })
    expect(r.signal, `the child was ${r.signal ? 'killed: an open blocked' : 'done'}\n${r.stderr}`).toBeNull()
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('DONE ') + 5)) as { editors: [string, string][]; terminalApps: [string, string][] }
    expect(out.editors).toEqual([['zed', zedCli]])
    expect(out.terminalApps).toEqual([
      ['wezterm', path.join(root, 'wz', 'wezterm')],
      ['konsole', path.join(root, 'kde', 'konsole')],
    ])
  })
})

describe('editors on Linux: launching', () => {
  it('U-PLT-23 · the argv: the command-line tool with the folder, a file, a position (`--goto` for the VS Code family, a suffix for Zed), then the editor’s URL through xdg-open; a name a position parser would misread gets no position and no URL, and Zed gets the folder alone', () => {
    const o = { cli: '/u/bin/code', open: '/u/bin/xdg-open' }
    expect(linuxLaunchPlan(def('vscode'), o, at(null))).toEqual([
      { strategy: 'cli', file: '/u/bin/code', args: ['/w/tree'] },
      { strategy: 'url', file: '/u/bin/xdg-open', args: ['vscode://file/w/tree'] },
    ])
    expect(linuxLaunchPlan(def('vscode'), o, at('/w/tree/src/a b.ts', 42, 7))).toEqual([
      { strategy: 'cli', file: '/u/bin/code', args: ['/w/tree', '--goto', '/w/tree/src/a b.ts:42:7'] },
      { strategy: 'url', file: '/u/bin/xdg-open', args: ['vscode://file/w/tree/src/a%20b.ts:42:7'] },
    ])
    expect(linuxLaunchPlan(def('zed'), { cli: '/z/zed', open: '/x' }, at('/w/tree/x.rs', 3)).at(0)).toEqual({ strategy: 'cli', file: '/z/zed', args: ['/w/tree', '/w/tree/x.rs:3:1'] })
    // a name a position parser would misread (`a:1`)
    expect(linuxLaunchPlan(def('cursor'), { cli: '/c/cursor', open: '/x' }, at('/w/tree/a:1', 9))).toEqual([{ strategy: 'cli', file: '/c/cursor', args: ['/w/tree', '/w/tree/a:1'] }])
    expect(linuxLaunchPlan(def('zed'), { cli: '/z/zed', open: '/x' }, at('/w/tree/a:1'))).toEqual([{ strategy: 'cli', file: '/z/zed', args: ['/w/tree'] }])
  })

  it('U-PLT-24 · Editors over a command host: the editor is run with argv and its URL is tried when it fails; a terminal app is started detached in the folder with its folder argument, never through runProcess; an app that will not start says why; Automatic is the first found', async () => {
    const root = tempRoot()
    const cwd = path.join(root, 'Developer', 'repo')
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'src', 'main.ts'), '')
    const bin = path.join(root, 'bin')
    const code = tool(path.join(bin, 'code'))
    const ghostty = tool(path.join(bin, 'ghostty'))
    tool(path.join(bin, 'gnome-terminal'))
    const host = hostOver(root, { searchPath: false, known: { code: [code], ghostty: [ghostty], 'gnome-terminal': [path.join(bin, 'gnome-terminal')] } })
    let failing: string | null = null
    const { ed, ran, launched } = editorsOver(host, { env: { PATH: '' }, cwd, projects: [cwd], fail: (f) => f === failing })
    expect(await ed.list(true)).toMatchObject({ editors: [{ id: 'vscode', name: 'VS Code' }], default: 'vscode', terminalApp: { name: 'Ghostty' } })
    expect(await ed.open({ target: 'session', id: 's0', path: 'src/main.ts', line: 4, col: 2 })).toEqual({ ok: true, editor: 'vscode', reason: null, message: null })
    expect(ran).toEqual([{ file: code, args: [cwd, '--goto', `${path.join(cwd, 'src', 'main.ts')}:4:2`] }])
    // the CLI fails: the URL goes to xdg-open
    failing = code
    ran.length = 0
    expect((await ed.open({ target: 'session', id: 's0' })).ok).toBe(true)
    expect(ran).toEqual([
      { file: code, args: [cwd] },
      { file: host.open, args: [`vscode://file${cwd}`] },
    ])
    // the terminal app: detached, in the folder, with its folder argument; nothing through runProcess
    failing = null
    ran.length = 0
    expect(await ed.openTerminalApp('session', 's0')).toEqual({ ok: true, reason: null, message: null })
    expect(launched).toEqual([{ file: ghostty, args: [`--working-directory=${cwd}`], cwd }])
    expect(ran).toEqual([])
    // one that will not start: why
    failing = ghostty
    expect(await ed.openTerminalApp('session', 's0')).toEqual({ ok: false, reason: 'failed', message: `spawn ${ghostty} failed (ENOENT)` })
    ed.dispose()
  })

  it('U-PLT-24 · on Linux the viewer never hands a desktop entry, an AppImage, a .run, a package or a Flatpak to xdg-open and names the file manager; Settings offers Automatic and this system’s terminal apps and hides the backup exclusion, which nothing on Linux honours; macOS keeps every other row', () => {
    const linuxOnly = ['desktop', 'appimage', 'run', 'deb', 'rpm', 'snap', 'flatpak', 'flatpakref']
    const l = linux.editors
    const m = darwin.editors
    if (!('kind' in l) || !('kind' in m)) throw new Error('both systems have editors')
    expect(l.neverOpened).toEqual(linuxOnly)
    expect(m.neverOpened).toEqual([])
    expect([l.fileManager, m.fileManager]).toEqual(['File Manager', 'Finder'])
    const here = coreOs.editors
    if (!('kind' in here)) throw new Error('editors')
    for (const t of linuxOnly) expect(opensSafely(`thing.${t.toUpperCase()}`), t).toBe(here.kind === 'bundles')
    expect(opensSafely('notes.txt')).toBe(true)
    expect(FILE_MANAGER).toBe(here.fileManager)

    // protocol's rows offer each system's own terminal apps before core answers (U-PLT-56); core's catalog is the same list
    expect(m.terminalApps).toEqual(protocolDarwin.window.terminalApps)
    expect(l.terminalApps).toEqual(protocolLinux.window.terminalApps)
    const [macRows, linuxRows] = [settingRows([], protocolDarwin), settingRows([], protocolLinux)]
    const offered = (rows: ReturnType<typeof settingRows>, apps: readonly string[]) => thisSystemsRows(rows, apps).find((r) => r.key === 'general.terminalApp')?.options?.map((o) => o.value)
    expect(offered(macRows, m.terminalApps)).toEqual(['auto', 'ghostty', 'iterm', 'warp', 'kitty', 'wezterm', 'alacritty', 'terminal'])
    expect(offered(linuxRows, l.terminalApps)).toEqual(['auto', 'ghostty', 'kitty', 'wezterm', 'alacritty', 'konsole', 'ptyxis', 'gnome-terminal', 'x-terminal-emulator'])
    // every other row as it was, but on Linux the backup exclusion, which nothing there honours
    expect(thisSystemsRows(macRows, m.terminalApps, true).filter((r) => r.key !== 'general.terminalApp')).toEqual(macRows.filter((r) => r.key !== 'general.terminalApp'))
    // Linux's rows leave it out already (protocol's hiddenSettings); core's filter is the second guard
    expect(macRows.some((r) => r.key === 'general.excludeBuildDirsFromBackup')).toBe(true)
    expect(linuxRows.some((r) => r.key === 'general.excludeBuildDirsFromBackup')).toBe(false)
    expect(thisSystemsRows(macRows, m.terminalApps, false).filter((r) => r.key !== 'general.terminalApp')).toEqual(macRows.filter((r) => r.key !== 'general.terminalApp' && r.key !== 'general.excludeBuildDirsFromBackup'))
  })
})
