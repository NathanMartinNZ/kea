// The editors and terminal apps Kea knows how to launch: data only. Bundle ids and CLI paths are confirmed against what
// is installed by the contract test K-ED-1. Each has a Linux column too: the commands that run it and its desktop
// entries' ids; where those are looked for is the OS layer's (`editors`), how they are found is `commands.ts`.

import type { EDITORS, TerminalAppChoice } from '@kea/protocol'

export type EditorId = (typeof EDITORS)[number]

export interface AppDef {
  /** As the menus name it. */
  name: string
  bundleId: string
  /** The bundle's folder name, for the lookup by name in the applications folders (when Spotlight does not find it). */
  appName: string
}

/** The catalog's Linux column: how an app is found on Linux. */
export interface LinuxAppDef {
  /** The commands that run it, looked for on the login PATH and in the system's known places, in this order. */
  commands: readonly string[]
  /** Its desktop entries' ids (`<id>.desktop` in an XDG data folder's `applications`), in this order. */
  desktopIds: readonly string[]
}

export interface LinuxEditorDef extends LinuxAppDef {
  /**
   * Where the command-line tool lies, relative to the folder of a desktop entry's `Exec` program. That program is the
   * editor's window process itself, which may stay running for as long as the editor does, so it is never what Kea runs.
   */
  cliFromExec: readonly string[]
}

export interface EditorDef extends AppDef {
  id: EditorId
  /** The command-line tool inside the bundle. */
  cli: string
  /** How it takes a position: `--goto file:line:col` (the VS Code family), or the file argument's own suffix (Zed). */
  position: 'goto' | 'suffix'
  /** Strategy 3's URL scheme: `<scheme>://file/<path>:<line>:<col>`. */
  scheme: string
  linux: LinuxEditorDef
}

const CODE_CLI = 'Contents/Resources/app/bin'

/** The editors, in the order they are listed and offered. */
export const EDITOR_DEFS: readonly EditorDef[] = [
  { id: 'vscode', name: 'VS Code', bundleId: 'com.microsoft.VSCode', appName: 'Visual Studio Code.app', cli: `${CODE_CLI}/code`, position: 'goto', scheme: 'vscode', linux: { commands: ['code'], desktopIds: ['code', 'code_code'], cliFromExec: ['bin/code'] } },
  { id: 'vscode-insiders', name: 'VS Code Insiders', bundleId: 'com.microsoft.VSCodeInsiders', appName: 'Visual Studio Code - Insiders.app', cli: `${CODE_CLI}/code`, position: 'goto', scheme: 'vscode-insiders', linux: { commands: ['code-insiders'], desktopIds: ['code-insiders', 'code-insiders_code-insiders'], cliFromExec: ['bin/code-insiders'] } },
  { id: 'cursor', name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', appName: 'Cursor.app', cli: `${CODE_CLI}/cursor`, position: 'goto', scheme: 'cursor', linux: { commands: ['cursor'], desktopIds: ['cursor'], cliFromExec: ['bin/cursor'] } },
  { id: 'windsurf', name: 'Windsurf', bundleId: 'com.exafunction.windsurf', appName: 'Windsurf.app', cli: `${CODE_CLI}/windsurf`, position: 'goto', scheme: 'windsurf', linux: { commands: ['windsurf'], desktopIds: ['windsurf'], cliFromExec: ['bin/windsurf'] } },
  { id: 'zed', name: 'Zed', bundleId: 'dev.zed.Zed', appName: 'Zed.app', cli: 'Contents/MacOS/cli', position: 'suffix', scheme: 'zed', linux: { commands: ['zed', 'zeditor'], desktopIds: ['dev.zed.Zed', 'zed'], cliFromExec: ['../bin/zed'] } },
]

export function editorDef(id: string): EditorDef | undefined {
  return EDITOR_DEFS.find((d) => d.id === id)
}

/** A terminal app's id: a value of the `general.terminalApp` setting other than `auto`. */
export type TerminalAppId = Exclude<TerminalAppChoice, 'auto'>

export interface TerminalAppDef extends AppDef {
  id: TerminalAppId
}

/** A terminal app on Linux: found as an editor is, by command or desktop entry, and started with a folder. */
export interface LinuxTerminalAppDef extends LinuxAppDef {
  id: TerminalAppId
  name: string
  /** The arguments that open a window in `dir`; the app is also started with `dir` as its working directory. */
  dirArgs(dir: string): string[]
}

/**
 * The terminal apps looked for, in the order the setting's Automatic takes the first found: the ones a person
 * installs on purpose before the one every Mac has. The setting's values are these ids, in this order (U-ED-7).
 */
export const TERMINAL_APP_DEFS: readonly TerminalAppDef[] = [
  { id: 'ghostty', name: 'Ghostty', bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty.app' },
  { id: 'iterm', name: 'iTerm', bundleId: 'com.googlecode.iterm2', appName: 'iTerm.app' },
  { id: 'warp', name: 'Warp', bundleId: 'dev.warp.Warp-Stable', appName: 'Warp.app' },
  { id: 'kitty', name: 'kitty', bundleId: 'net.kovidgoyal.kitty', appName: 'kitty.app' },
  { id: 'wezterm', name: 'WezTerm', bundleId: 'com.github.wez.wezterm', appName: 'WezTerm.app' },
  { id: 'alacritty', name: 'Alacritty', bundleId: 'org.alacritty', appName: 'Alacritty.app' },
  { id: 'terminal', name: 'Terminal', bundleId: 'com.apple.Terminal', appName: 'Terminal.app' },
]

/**
 * The terminal apps looked for on Linux, in Automatic's order: the ones a person installs on purpose, then the
 * desktops' own, then Debian's alternative (whatever terminal the system names; it takes no folder argument, so it gets
 * the working directory only). Every app here stays in front of the person until its window closes, so it is started
 * detached (kit's `launchDetached`), never waited for.
 */
export const LINUX_TERMINAL_APP_DEFS: readonly LinuxTerminalAppDef[] = [
  { id: 'ghostty', name: 'Ghostty', commands: ['ghostty'], desktopIds: ['com.mitchellh.ghostty'], dirArgs: (dir) => [`--working-directory=${dir}`] },
  { id: 'kitty', name: 'kitty', commands: ['kitty'], desktopIds: ['kitty'], dirArgs: (dir) => ['--directory', dir] },
  { id: 'wezterm', name: 'WezTerm', commands: ['wezterm'], desktopIds: ['org.wezfurlong.wezterm'], dirArgs: (dir) => ['start', '--cwd', dir] },
  { id: 'alacritty', name: 'Alacritty', commands: ['alacritty'], desktopIds: ['Alacritty', 'com.alacritty.Alacritty'], dirArgs: (dir) => ['--working-directory', dir] },
  { id: 'konsole', name: 'Konsole', commands: ['konsole'], desktopIds: ['org.kde.konsole'], dirArgs: (dir) => ['--workdir', dir] },
  { id: 'ptyxis', name: 'Ptyxis', commands: ['ptyxis'], desktopIds: ['org.gnome.Ptyxis'], dirArgs: (dir) => ['--new-window', `--working-directory=${dir}`] },
  { id: 'gnome-terminal', name: 'GNOME Terminal', commands: ['gnome-terminal'], desktopIds: ['org.gnome.Terminal'], dirArgs: (dir) => [`--working-directory=${dir}`] },
  { id: 'x-terminal-emulator', name: 'The system’s terminal', commands: ['x-terminal-emulator'], desktopIds: [], dirArgs: () => [] },
]

/**
 * The terminal app "Open in Terminal App" opens, of the ones found (in the catalog's order). Automatic: the first
 * found. A named app: that one when it is installed, else none: the person chose an app that is not here, and no other
 * is opened in its place (as for a chosen editor: `defaultEditor`).
 */
export function terminalAppFor<T extends { def: { id: TerminalAppId } }>(choice: TerminalAppChoice, found: readonly T[]): T | null {
  return (choice === 'auto' ? found[0] : found.find((f) => f.def.id === choice)) ?? null
}

/**
 * The editor the primary click opens. The setting when that editor is installed; while the setting still has its
 * initial value (VS Code) and VS Code is not installed, the first detected editor; otherwise none: the person chose an
 * editor that is not here, and the button says so.
 */
export function defaultEditor(configured: EditorId, installed: readonly EditorId[], initial: EditorId): EditorId | null {
  if (installed.includes(configured)) return configured
  return configured === initial ? (installed[0] ?? null) : null
}
