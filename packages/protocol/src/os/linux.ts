// Linux's side of protocol's OS layer (index.ts), and the system files Kea's Linux packages and install.sh write
// outside the app's folder, which the packages and main's update check both name from here.
import type { Chord } from '../commands.ts'
import { LINUX_NAME } from '../release.ts'
import type { ProtocolOs } from './index.ts'

/** The files that say whether Kea's repository is set up: apt's source and the deb's switch, dnf's and zypper's repository files. */
export const LINUX_REPO_FILES = {
  aptSource: `/etc/apt/sources.list.d/${LINUX_NAME}.sources`,
  /** `add_repository=no` here keeps the deb from adding its apt source (install.sh `--no-repo`). */
  defaults: `/etc/default/${LINUX_NAME}`,
  rpmRepo: `/etc/yum.repos.d/${LINUX_NAME}.repo`,
  zypperRepo: `/etc/zypp/repos.d/${LINUX_NAME}.repo`,
} as const

/** The keys a chord names by word, as a Linux label writes them; any other key is its character, upper-cased. */
const KEY_NAMES: Readonly<Record<string, string>> = { enter: 'Enter', backspace: 'Backspace', tab: 'Tab', escape: 'Esc', left: 'Left', right: 'Right', up: 'Up', down: 'Down', space: 'Space', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' }

/** The chords without `Ctrl+Shift` that the key router intercepts, as on macOS. */
const INTERCEPTS = {
  'ctrl+tab': 'always',
  'ctrl+shift+tab': 'always',
  f6: 'always',
  'shift+f6': 'always',
  'ctrl+`': 'outsideTerminal',
} as const

const ARROWS = ['left', 'right', 'up', 'down'] as const
/** The function keys a text console takes with Ctrl+Alt, and the ones KDE's desktops take with Ctrl. */
const CONSOLE_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const
const DESKTOP_KEYS = ['f1', 'f2', 'f3', 'f4'] as const

/**
 * Chords no keybindings.json entry may use, each with who answers it instead: Kea's own (text fields' editing
 * keys, the terminal's copy and paste, the commands main runs) and the defaults of GNOME, KDE Plasma and IBus.
 * Super is refused as a whole (`superKey`).
 */
const RESERVED: Readonly<Record<string, string>> = {
  'ctrl+c': 'is Copy in a text field',
  'ctrl+v': 'is Paste in a text field',
  'ctrl+x': 'is Cut in a text field',
  'ctrl+a': 'is Select All in a text field',
  'ctrl+z': 'is Undo in a text field',
  'ctrl+shift+z': 'is Redo in a text field',
  'ctrl+shift+c': 'is Copy in a terminal',
  'ctrl+shift+v': 'is Paste in a terminal',
  'ctrl+insert': 'is Copy in a terminal',
  'shift+insert': 'is Paste in a terminal',
  'ctrl+shift+q': 'closes Kea',
  'ctrl+alt+shift+q': 'quits Kea completely',
  'ctrl+shift+u': 'types a character by its Unicode code (IBus)',
  'alt+tab': 'switches windows (the desktop)',
  'alt+shift+tab': 'switches windows (the desktop)',
  'alt+`': 'switches the windows of one app (GNOME)',
  'alt+escape': 'switches windows directly (GNOME)',
  'alt+space': 'opens the window menu (the desktop)',
  'alt+f1': 'opens the overview or the app launcher (GNOME, KDE)',
  'alt+f2': 'runs a command (GNOME, KDE)',
  'alt+f3': 'opens the window menu (KDE)',
  'alt+f4': 'closes the window (the desktop)',
  'alt+f7': 'moves the window (GNOME)',
  'alt+f8': 'resizes the window (GNOME, KDE)',
  'alt+f10': 'maximises the window (GNOME)',
  'ctrl+escape': 'shows the running processes (KDE)',
  'ctrl+alt+t': 'opens a terminal (Ubuntu, KDE)',
  'ctrl+alt+l': 'locks the screen (Ubuntu, KDE)',
  'ctrl+alt+delete': 'logs out (GNOME, KDE)',
  'ctrl+alt+backspace': 'stops the display server (X11, where enabled)',
  'ctrl+alt+escape': 'closes a window by force (KDE)',
  'ctrl+alt+tab': 'moves the keyboard to the desktop’s panels (GNOME)',
  'ctrl+alt+shift+r': 'records the screen (GNOME)',
  'ctrl+alt+shift+delete': 'logs out without asking (KDE)',
  'ctrl+alt+shift+pageup': 'restarts the computer without asking (KDE)',
  'ctrl+alt+shift+pagedown': 'shuts the computer down without asking (KDE)',
  ...Object.fromEntries(ARROWS.map((a) => [`ctrl+alt+${a}`, 'switches workspaces (GNOME, KDE)'])),
  ...Object.fromEntries(ARROWS.map((a) => [`ctrl+alt+shift+${a}`, 'moves the window to another workspace (GNOME)'])),
  ...Object.fromEntries(DESKTOP_KEYS.map((f) => [`ctrl+${f}`, 'switches virtual desktops (KDE)'])),
  ...Object.fromEntries(CONSOLE_KEYS.map((f) => [`ctrl+alt+${f}`, 'switches to a text console (the system)'])),
}

/** `Ctrl+Shift`, with or without `Alt`; never with Super, which the desktop has. */
const primary = (c: Chord): boolean => c.ctrl && c.shift && !c.cmd

export const linux: ProtocolOs = {
  system: 'linux',
  window: {
    menuButton: true,
    notificationSettings: false,
    background: 'tray',
    terminalFont: 'JetBrains Mono',
    terminalFontFallbacks: ['"JetBrains Mono"', '"DejaVu Sans Mono"', '"Noto Sans Mono"', 'monospace'],
    // `Alt` is Meta on Linux, always; no Linux backup honours a marker; `terminal.screenReader` is Linux's own
    hiddenSettings: ['terminal.optionIsMeta', 'general.excludeBuildDirsFromBackup'],
    terminalApps: ['ghostty', 'kitty', 'wezterm', 'alacritty', 'konsole', 'ptyxis', 'gnome-terminal', 'x-terminal-emulator'],
  },
  words: {
    fileManager: 'File Manager',
    title: (def) => (def.linuxTitle ?? def.title).replace(/\bFinder\b/, 'File Manager'),
    badge: 'Badge',
    onQuitHelp: 'What Ctrl+Shift+Q (Close Kea) does while terminals run. Without a tray on the desktop it stops them all and quits.',
    stayRunning: 'Stay in the tray',
    machine: 'this computer',
  },
  keys: {
    // Ctrl, Shift, Alt (so the primary modifier, Ctrl+Shift, always leads), then the key
    label: (c: Chord) => `${c.ctrl ? 'Ctrl+' : ''}${c.shift ? 'Shift+' : ''}${c.alt ? 'Alt+' : ''}${c.cmd ? 'Super+' : ''}${KEY_NAMES[c.key] ?? c.key.toUpperCase()}`,
    keysOf: (def) => def.linuxKeys,
    primary,
    // a one-character key (a letter, a digit or punctuation; `chordText` names every other key by a word): xterm sends
    // nothing for it with Ctrl+Shift but for `-`, `2`, `6`, whose bytes plain Ctrl keys send too
    keptFromTerminal: (c, bound) => primary(c) && (bound || [...c.key].length === 1),
    primaryName: 'Ctrl+Shift',
    altName: 'Alt',
    primaryMods: { cmd: false, ctrl: true, shift: true },
    superKey: 'uses Super, which the desktop keeps on Linux: write primary or ctrl+shift instead',
    templateRule: 'ctrl+shift (or primary: ctrl+shift here, cmd on macOS)',
    example: 'ctrl+shift+r',
    templateKey: 'ctrl+shift+alt+b',
    intercepts: INTERCEPTS,
    terminalText: {},
    reserved: RESERVED,
    clipboard: 'router',
    terminalSelectAll: null,
    modClick: (e) => e.ctrlKey,
    listKeys: { 'ctrl+x': 'files.cut', 'ctrl+c': 'files.copy', 'ctrl+v': 'files.paste', 'ctrl+z': 'files.undo' },
    dragCopy: (e) => e.ctrlKey,
  },
}
