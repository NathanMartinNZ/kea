// @kea/protocol's OS layer: the system this code runs on, which the generated limits read for a per-system
// number, and the capabilities that live in protocol: `keys`, `words` and `window`.
// Pure, no I/O: protocol also runs in the renderer, which has no `process` (select.ts).
import type { Chord, CommandDef } from '../commands.ts'
import type { System } from '../platform.ts'

/** Modifiers a word of `keybindings.json` sets. */
export interface KeyMods {
  readonly cmd: boolean
  readonly ctrl: boolean
  readonly shift: boolean
}

/** `keys`: how this system writes a chord, which chords are the app's, and which it keeps for itself. */
export interface KeyLabels {
  /** `{ cmd, shift, key: 'r' }` → `⇧⌘R` on macOS (the table's notation); `{ ctrl, shift, key: 'r' }` → `Ctrl+Shift+R` on Linux. */
  label(chord: Chord): string
  /** A command's default bindings here: the table's `keys` on macOS, its `linuxKeys` on Linux. */
  keysOf(def: CommandDef): readonly string[] | undefined
  /** The chord holds the system's primary modifier: `⌘` on macOS; `Ctrl+Shift` (with or without `Alt`, never Super) on Linux. */
  primary(chord: Chord): boolean
  /**
   * A key the router keeps from the terminal although it runs no command: on macOS every `⌘` key; on Linux a
   * `Ctrl+Shift` key the table binds, and every `Ctrl+Shift` letter, digit or punctuation key, for which xterm sends
   * nothing (or, for `-`, `2` and `6`, the `⌃_`, `⌃@` and `⌃^` that `Ctrl+/`, `Ctrl+Space` and `Ctrl+6` send too). A
   * `Ctrl+Shift` arrow, `Home`, `F`-key and the like still reaches the program, which tells it from the plain one.
   */
  keptFromTerminal(chord: Chord, bound: boolean): boolean
  /** The primary modifier as a message names it: `⌘`, `Ctrl+Shift`; and Alt (`⌥`, `Alt`). */
  readonly primaryName: string
  readonly altName: string
  /** What `primary`, `cmd`, `command` and `⌘` set in `keybindings.json`: `⌘` on macOS, `Ctrl+Shift` on Linux. */
  readonly primaryMods: KeyMods
  /** What `super` and `meta` set, or why they are refused (Linux: the desktop has the Super key). */
  readonly superKey: KeyMods | string
  /** A key as `keybindings.json` writes it, for a message (`cmd+shift+r`). */
  readonly example: string
  /** The starter file: what a shortcut that works everywhere must use, and its example's key (one no command has here). */
  readonly templateRule: string
  readonly templateKey: string
  /**
   * The chords without the primary modifier that the key router intercepts: everywhere, or only while focus is
   * outside the terminal.
   */
  readonly intercepts: Readonly<Record<string, 'always' | 'outsideTerminal'>>
  /** Chords a terminal turns into text-editing bytes for the PTY (macOS only). */
  readonly terminalText: Readonly<Record<string, string>>
  /** Chords no `keybindings.json` entry may use, each with who answers it instead. */
  readonly reserved: Readonly<Record<string, string>>
  /**
   * Copy and paste: `menu` where the Edit menu's own keys run them (macOS, so they reach the focused element as
   * the system's); `router` where the menu registers no key, its `Ctrl+C` would take the terminal's interrupt, and
   * the router asks main for the role (Linux).
   */
  readonly clipboard: 'menu' | 'router'
  /** A click holds the modifier that asks for its other action (a terminal link, a palette or finder row): `⌘` on macOS, `Ctrl` on Linux, where Super belongs to the desktop. */
  modClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean
}

/** `words`: the system's names for its own parts, as Kea's titles and messages write them. */
export interface SystemWords {
  /** The file manager in a title: `Reveal in Finder` on macOS, `Reveal in File Manager` on Linux. */
  readonly fileManager: string
  /** A command's title here: the table's on macOS; on Linux its Linux title where it has one, with the file manager's name for Finder. */
  title(def: CommandDef): string
  /** `notifications.dockBadge`'s label: `Badge count` on the Dock; `Badge` on Linux, where the dock may show it or not. */
  readonly badge: string
  /** `general.onQuit`'s help: the key that closes Kea while sessions run, by its default (`⌘Q`, `Ctrl+Shift+Q`). */
  readonly onQuitHelp: string
  /** `general.onQuit`'s first choice: stay in the menu bar, or keep running in the background with the tray icon. */
  readonly stayRunning: string
}

/** `window`: what the window has of the system's own, as the renderer draws it. */
export interface SystemWindow {
  /** The header has a menu button, and `Alt` pressed alone opens the menu; macOS has its menu bar instead. */
  readonly menuButton: boolean
  /** The system keeps a permission for Kea's notifications that Settings can link to; Linux has none. */
  readonly notificationSettings: boolean
  /** Where Kea keeps running with no window: the menu bar, or the background with a tray icon. */
  readonly background: 'menuBar' | 'tray'
  /** `terminal.fontFamily`'s default: SF Mono; JetBrains Mono, which Kea's Linux packages ship. */
  readonly terminalFont: string
  /** The fonts after the chosen one in the terminal's font stack, as CSS names them: the default first. */
  readonly terminalFontFallbacks: readonly string[]
  /** Settings the person cannot set on this system, so Settings does not show them (Linux: xterm's Option-as-Meta, and the backup exclusion). */
  readonly hiddenSettings: readonly string[]
  /** `general.terminalApp`'s choices on this system after Automatic, as core's catalog has them; the settings file takes both systems'. */
  readonly terminalApps: readonly string[]
}

export interface ProtocolOs {
  readonly system: System
  readonly keys: KeyLabels
  readonly words: SystemWords
  readonly window: SystemWindow
}

export { protocolOs } from './select.ts'
