// macOS's side of protocol's OS layer (index.ts).
import type { Chord } from '../commands.ts'
import type { ProtocolOs } from './index.ts'

/** The keys a chord names by word, as a Mac label draws them; any other key is its character, upper-cased. */
const KEY_GLYPHS: Readonly<Record<string, string>> = { enter: '↵', backspace: '⌫', tab: 'Tab', escape: 'Esc', left: '←', right: '→', up: '↑', down: '↓', space: 'Space', delete: '⌦', insert: 'Ins', home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn', '=': '+', '-': '−' }

/** The chords without `⌘` the key router intercepts: everywhere, or only while focus is outside the terminal. */
const INTERCEPTS = {
  'ctrl+tab': 'always',
  'ctrl+shift+tab': 'always',
  f6: 'always',
  'shift+f6': 'always',
  'ctrl+`': 'outsideTerminal',
} as const

/** The Mac text-editing keys a terminal turns into `⌃A`, `⌃E`, `⌃U`. They are never app bindings. */
const TERMINAL_TEXT: Readonly<Record<string, string>> = { 'cmd+left': '\x01', 'cmd+right': '\x05', 'cmd+backspace': '\x15' }

/** Chords no keybindings.json entry may use, each with who answers it instead. */
const RESERVED: Readonly<Record<string, string>> = {
  'cmd+left': 'moves to the start of the line in a terminal',
  'cmd+right': 'moves to the end of the line in a terminal',
  'cmd+backspace': 'deletes to the start of the line in a terminal',
  'cmd+c': 'is Copy',
  'cmd+v': 'is Paste',
  'cmd+x': 'is Cut',
  'cmd+a': 'is Select All',
  'cmd+z': 'is Undo',
  'cmd+shift+z': 'is Redo',
  'cmd+q': 'quits Kea or moves it to the menu bar',
  'cmd+alt+q': 'quits Kea completely',
  'cmd+h': 'hides Kea (macOS)',
  'cmd+alt+h': 'hides the other apps (macOS)',
  'cmd+m': 'minimises the window (macOS)',
  'cmd+ctrl+f': 'toggles full screen (macOS)',
  'cmd+tab': 'switches apps (macOS)',
  'cmd+space': 'is Spotlight (macOS)',
  'cmd+`': 'cycles windows (macOS)',
}

const CMD = { cmd: true, ctrl: false, shift: false } as const

export const darwin: ProtocolOs = {
  system: 'darwin',
  window: {
    menuButton: false,
    notificationSettings: true,
    background: 'menuBar',
    terminalFont: 'SF Mono',
    terminalFontFallbacks: ['"SF Mono"', 'ui-monospace', 'Menlo', 'monospace'],
    // VoiceOver's state reaches Kea from the system, so there is no screen-reader setting to show
    hiddenSettings: ['terminal.screenReader'],
    terminalApps: ['ghostty', 'iterm', 'warp', 'kitty', 'wezterm', 'alacritty', 'terminal'],
  },
  words: { fileManager: 'Finder', title: (def) => def.title, badge: 'Badge count', onQuitHelp: 'What ⌘Q does while sessions run.', stayRunning: 'Stay in the menu bar' },
  keys: {
    // the modifiers in macOS's order (⌃ ⌥ ⇧ ⌘), then the key
    label: (c: Chord) => `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.cmd ? '⌘' : ''}${KEY_GLYPHS[c.key] ?? c.key.toUpperCase()}`,
    keysOf: (def) => def.keys,
    primary: (c) => c.cmd,
    keptFromTerminal: (c) => c.cmd,
    primaryName: '⌘',
    altName: '⌥',
    primaryMods: CMD,
    superKey: CMD,
    templateRule: 'cmd',
    example: 'cmd+shift+r',
    templateKey: 'cmd+shift+b',
    intercepts: INTERCEPTS,
    terminalText: TERMINAL_TEXT,
    reserved: RESERVED,
    clipboard: 'menu',
    modClick: (e) => e.metaKey,
  },
}
