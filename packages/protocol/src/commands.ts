// The command table: every user action's id, title, category, default bindings and the contextual surfaces that
// list it. It is data shared by the renderer's command registry (which binds handlers to ids,
// `app/renderer/src/features/commands`) and main's menu bar, so it lives here: the menu crosses the main ⇄ renderer
// boundary. Where the private specification is in the checkout, `commands.test.ts` compares the rows with its command
// table, row for row and in order.
//
// Bindings are written in the table's notation (`⌘⇧]`, `⌥⌘J`, `F6`; its Linux column `Ctrl+Shift+]`);
// `parseShortcut` turns one into a chord and `toAccelerator` into an Electron accelerator. `systemKeys` gives a
// command's bindings on this system and `systemTitle` its title here (the OS layer, `os/`, picks the column). A binding
// with a `keyScope` applies only in that context. A chord's canonical text (`cmd+shift+]`, `ctrl+shift+]`) is what the
// key router matches and what `keybindings.json` (`keybindings.ts`) resolves to; `chordLabel` and
// `chordAccelerator` show one in a chip and in the menu bar.

import { z } from 'zod'
import { protocolOs, type KeyLabels, type ProtocolOs } from './os/index.ts'

export const CATEGORIES = ['Session', 'Project', 'Terminal', 'Files', 'Viewer', 'Server', 'View', 'App'] as const
export type Category = (typeof CATEGORIES)[number]

/** The contextual menus generated from the table: the surfaces a command is also listed in. */
export const SURFACES = ['session ⌃', 'project ⌃', 'file ⌃', 'files ⌃', 'changes ⋯', 'header ⋯', 'editor ▾', 'terminal ⌃', 'menu-bar item'] as const
export type Surface = (typeof SURFACES)[number]

/** Where a scoped binding applies. Unscoped bindings apply everywhere. */
export const KEY_SCOPES = ['viewer tab', 'diff tab', 'file tab', 'Markdown file', 'file panel', 'detached overlay'] as const
export type KeyScope = (typeof KEY_SCOPES)[number]

export interface CommandDef {
  readonly id: string
  readonly title: string
  /** The title on Linux where it differs by more than Finder's name (`systemTitle`). */
  readonly linuxTitle?: string
  readonly category: Category
  /** Default bindings in the table's notation (macOS); several when one command has more (`F6` / `⇧F6`, `⌘1`…`⌘9`). */
  readonly keys?: readonly string[]
  /** The Linux column: the bindings on Linux, in its notation (`Ctrl+Shift+N`), in the order of `keys`. */
  readonly linuxKeys?: readonly string[]
  /** The argument each binding runs the command with (same order as `keys`, and as `linuxKeys`). */
  readonly keyArgs?: readonly unknown[]
  readonly keyScope?: KeyScope
  /** A pointer gesture instead of (or besides) a key, in words (`double-click the title`). */
  readonly gesture?: string
  /** Contextual menus that list the command, in table order. */
  readonly surfaces?: readonly Surface[]
  /**
   * The command's group in its contextual menus: a menu puts a separator between two neighbours of different groups
   * (`new`, `open`, … in the Files rows). None: the menu has no separators around it.
   */
  readonly menuGroup?: string
  /** A qualifier on the command's surfaces (`in that project`): the command's `when` decides it there. */
  readonly surfaceNote?: string
  /** Other controls that run it (row hover button, detached overlay, Settings › Disk, …). */
  readonly other?: string
  /**
   * The titles it shows by state, where the one `title` names several (`Run / Stop Dev Server`), or the title without
   * the note on it (`Open in… (each detected editor)` → `Open in…`): the handler says which applies now, and the menu
   * bar and the palette show that one. Never a title from outside this list.
   */
  readonly titles?: readonly string[]
}

const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

/** Every command, in table order; a pair such as Next / Previous Tab is two entries, in that order. */
export const COMMANDS: readonly CommandDef[] = [
  { id: 'session.new', title: 'New Session', category: 'Session', keys: ['⌘N'], linuxKeys: ['Ctrl+Shift+N'], surfaces: ['project ⌃'], surfaceNote: 'in that project' },
  { id: 'session.newInProject', title: 'New Session in Project…', category: 'Session', keys: ['⌘⇧N'], linuxKeys: ['Ctrl+Shift+Alt+N'] },
  { id: 'session.rename', title: 'Rename', category: 'Session', gesture: 'double-click the title', surfaces: ['session ⌃', 'header ⋯'] },
  { id: 'session.openInEditor', title: 'Open in Editor', category: 'Session', keys: ['⌘⇧O'], linuxKeys: ['Ctrl+Shift+Alt+O'], surfaces: ['session ⌃'], other: 'primary click of editor ▾' },
  { id: 'session.reveal', title: 'Reveal Worktree in Finder', category: 'Session', surfaces: ['session ⌃', 'editor ▾'] },
  { id: 'session.copyBranch', title: 'Copy Branch Name', category: 'Session', gesture: 'click the branch chip', surfaces: ['session ⌃'] },
  { id: 'session.copyWorktreePath', title: 'Copy Worktree Path', category: 'Session', surfaces: ['session ⌃', 'editor ▾'] },
  { id: 'session.duplicate', title: 'Duplicate', category: 'Session', surfaces: ['session ⌃'] },
  { id: 'session.stop', title: 'Stop Agent', category: 'Session', surfaces: ['session ⌃'] },
  { id: 'session.resume', title: 'Resume', category: 'Session', keys: ['↵'], linuxKeys: ['Enter'], keyScope: 'detached overlay', surfaces: ['session ⌃', 'header ⋯'], other: 'detached overlay' },
  { id: 'session.restart', title: 'Restart Agent', category: 'Session', keys: ['⌘↵'], linuxKeys: ['Ctrl+Shift+Enter'], keyScope: 'detached overlay', surfaces: ['session ⌃', 'header ⋯'], other: 'detached overlay' },
  { id: 'session.reportStatus', title: 'Report Wrong Status', category: 'Session', keys: ['⌥⌘J'], linuxKeys: ['Ctrl+Shift+Alt+J'], surfaces: ['session ⌃'], other: '"Why this status?" popover' },
  { id: 'session.createPR', title: 'Create Pull Request (gh pr create --web)', category: 'Session', surfaces: ['header ⋯'] },
  { id: 'session.archive', title: 'Archive', category: 'Session', keys: ['⌘⇧⌫'], linuxKeys: ['Ctrl+Shift+Backspace'], surfaces: ['session ⌃', 'header ⋯'], other: 'row hover button' },
  { id: 'session.unarchive', title: 'Unarchive', category: 'Session', surfaces: ['session ⌃'], surfaceNote: 'archived rows' },
  { id: 'session.delete', title: 'Delete…', category: 'Session', surfaces: ['session ⌃', 'header ⋯'], other: 'Settings › Disk' },
  { id: 'session.restoreDeleted', title: 'Restore Deleted Session…', category: 'Session', surfaces: ['project ⌃'], surfaceNote: 'disabled with its reason when none is restorable', other: 'Settings › Disk' },
  { id: 'session.next', title: 'Next Session (most recently used)', category: 'Session', keys: ['⌃Tab'], linuxKeys: ['Ctrl+Tab'] },
  { id: 'session.previous', title: 'Previous Session (most recently used)', category: 'Session', keys: ['⌃⇧Tab'], linuxKeys: ['Ctrl+Shift+Tab'] },
  { id: 'session.jumpNeedsYou', title: 'Jump to Next Needing Me', category: 'Session', keys: ['⌘J'], linuxKeys: ['Ctrl+Shift+J'] },
  { id: 'session.jumpTo', title: 'Jump to Session 1…9', category: 'Session', keys: DIGITS.map((d) => `⌘${d}`), linuxKeys: DIGITS.map((d) => `Ctrl+Shift+${d}`), keyArgs: DIGITS.map((d) => ({ index: d })) },
  { id: 'session.showLaunchConfig', title: 'Show Launch Config', category: 'Session', gesture: 'click the config summary' },
  { id: 'session.whyStatus', title: 'Why This Status?', category: 'Session', other: 'session popover' },
  { id: 'session.resyncFiles', title: 'Re-sync Copied Files', category: 'Session', surfaces: ['session ⌃'] },
  { id: 'session.removeBuildFolders', title: 'Remove Build Folders…', category: 'Session', other: 'Settings › Disk' },
  { id: 'session.retryTeardown', title: 'Retry Teardown', category: 'Session', other: '"Teardown failed" row' },
  { id: 'session.continueAll', title: 'Continue All (account condition)', category: 'Session', other: 'sidebar footer' },
  { id: 'project.add', title: 'Add Project…', category: 'Project', keys: ['⌘O'], linuxKeys: ['Ctrl+Shift+O'] },
  { id: 'project.reveal', title: 'Reveal in Finder', category: 'Project', surfaces: ['project ⌃'] },
  { id: 'project.openInEditor', title: 'Open in Editor', category: 'Project', surfaces: ['project ⌃'] },
  { id: 'project.settings', title: 'Project Settings', category: 'Project', surfaces: ['project ⌃'] },
  { id: 'project.remove', title: 'Remove Project…', category: 'Project', surfaces: ['project ⌃'] },
  { id: 'terminal.newShell', title: 'New Terminal', category: 'Terminal', keys: ['⌘T'], linuxKeys: ['Ctrl+Shift+T'] },
  { id: 'terminal.closeTab', title: 'Close Tab', category: 'Terminal', keys: ['⌘W'], linuxKeys: ['Ctrl+Shift+W'] },
  { id: 'terminal.nextTab', title: 'Next Tab', category: 'Terminal', keys: ['⌘⇧]'], linuxKeys: ['Ctrl+Shift+]'] },
  { id: 'terminal.previousTab', title: 'Previous Tab', category: 'Terminal', keys: ['⌘⇧['], linuxKeys: ['Ctrl+Shift+['] },
  { id: 'terminal.copy', title: 'Copy', category: 'Terminal', keys: ['⌘C'], linuxKeys: ['Ctrl+Shift+C', 'Ctrl+Insert'], surfaces: ['terminal ⌃'], surfaceNote: 'disabled with its reason when nothing is selected' },
  { id: 'terminal.paste', title: 'Paste', category: 'Terminal', keys: ['⌘V'], linuxKeys: ['Ctrl+Shift+V', 'Shift+Insert'], surfaces: ['terminal ⌃'] },
  { id: 'terminal.selectAll', title: 'Select All', category: 'Terminal', surfaces: ['terminal ⌃'] },
  { id: 'terminal.find', title: 'Find', category: 'Terminal', keys: ['⌘F'], linuxKeys: ['Ctrl+Shift+F'], surfaces: ['terminal ⌃'] },
  { id: 'terminal.clear', title: 'Clear Terminal and Scrollback', category: 'Terminal', keys: ['⌘K'], linuxKeys: ['Ctrl+Shift+K'], surfaces: ['terminal ⌃'] },
  { id: 'terminal.jumpToBottom', title: 'Jump to Bottom', category: 'Terminal' },
  { id: 'terminal.fontBigger', title: 'Increase Font Size', category: 'Terminal', keys: ['⌘+'], linuxKeys: ['Ctrl+Shift+='] },
  { id: 'terminal.fontSmaller', title: 'Decrease Font Size', category: 'Terminal', keys: ['⌘−'], linuxKeys: ['Ctrl+Shift+-'] },
  { id: 'terminal.fontReset', title: 'Reset Font Size', category: 'Terminal', keys: ['⌘0'], linuxKeys: ['Ctrl+Shift+0'] },
  { id: 'terminal.resetRendering', title: 'Reset Terminal Rendering', category: 'Terminal' },
  { id: 'terminal.focus', title: 'Focus Terminal', category: 'Terminal', keys: ['⌃`'], linuxKeys: ['Ctrl+`'] },
  { id: 'files.goToFile', title: 'Go to File…', category: 'Files', keys: ['⌘P'], linuxKeys: ['Ctrl+Shift+P'] },
  { id: 'files.togglePanel', title: 'Toggle File Panel', category: 'Files' },
  { id: 'files.showFiles', title: 'Show Files', category: 'Files', keys: ['⌘⇧E'], linuxKeys: ['Ctrl+Shift+E'] },
  { id: 'files.showChanges', title: 'Show Changes', category: 'Files', keys: ['⌘⇧G'], linuxKeys: ['Ctrl+Shift+G'] },
  { id: 'files.newFile', title: 'New File…', category: 'Files', surfaces: ['file ⌃', 'files ⌃'], menuGroup: 'new', other: 'Files bar' },
  { id: 'files.newFolder', title: 'New Folder…', category: 'Files', surfaces: ['file ⌃', 'files ⌃'], menuGroup: 'new', other: 'Files bar' },
  { id: 'files.openInEditor', title: 'Open in Editor', category: 'Files', keys: ['⌘↵'], linuxKeys: ['Ctrl+Shift+Enter'], keyScope: 'file panel', surfaces: ['file ⌃'], menuGroup: 'open' },
  { id: 'files.reveal', title: 'Reveal in Finder', category: 'Files', surfaces: ['file ⌃', 'files ⌃'], menuGroup: 'open' },
  { id: 'files.cut', title: 'Cut File / Cut Folder', category: 'Files', keys: ['⌘X'], keyScope: 'file panel', surfaces: ['file ⌃'], menuGroup: 'clipboard', other: 'list key Ctrl+X on Linux', titles: ['Cut File', 'Cut Folder'] },
  { id: 'files.copy', title: 'Copy File / Copy Folder', category: 'Files', keys: ['⌘C'], keyScope: 'file panel', surfaces: ['file ⌃'], menuGroup: 'clipboard', other: 'list key Ctrl+C on Linux', titles: ['Copy File', 'Copy Folder'] },
  { id: 'files.paste', title: 'Paste', category: 'Files', keys: ['⌘V'], keyScope: 'file panel', surfaces: ['file ⌃', 'files ⌃'], menuGroup: 'clipboard', other: 'list key Ctrl+V on Linux' },
  { id: 'files.copyPath', title: 'Copy Path', category: 'Files', surfaces: ['file ⌃', 'files ⌃'], menuGroup: 'path' },
  { id: 'files.copyRelativePath', title: 'Copy Relative Path', category: 'Files', surfaces: ['file ⌃'], menuGroup: 'path' },
  { id: 'files.rename', title: 'Rename…', category: 'Files', keys: ['F2'], linuxKeys: ['F2'], keyScope: 'file panel', surfaces: ['file ⌃'], menuGroup: 'edit' },
  { id: 'files.trash', title: 'Move to Trash', category: 'Files', keys: ['⌦'], linuxKeys: ['Delete'], keyScope: 'file panel', surfaces: ['file ⌃'], menuGroup: 'edit', other: 'list key ⌘⌫ on macOS' },
  { id: 'files.undo', title: 'Undo Move / Undo Rename', category: 'Files', keys: ['⌘Z'], keyScope: 'file panel', other: 'list key Ctrl+Z on Linux', titles: ['Undo Move', 'Undo Rename'] },
  { id: 'files.discard', title: 'Discard Changes…', category: 'Files', surfaces: ['file ⌃'], surfaceNote: 'changed files', menuGroup: 'discard' },
  { id: 'files.toggleScope', title: 'Toggle Scope (Branch / Uncommitted)', category: 'Files', surfaces: ['changes ⋯'] },
  { id: 'files.copyChangedList', title: 'Copy Changed-File List', category: 'Files', surfaces: ['changes ⋯'] },
  { id: 'files.openAllChanged', title: 'Open All in Editor', category: 'Files', surfaces: ['changes ⋯'] },
  { id: 'files.refresh', title: 'Refresh', category: 'Files', surfaces: ['changes ⋯'] },
  { id: 'files.collapseAll', title: 'Collapse All', category: 'Files', surfaces: ['files ⌃'], menuGroup: 'view', other: 'Files bar' },
  { id: 'files.toggleIgnored', title: 'Toggle Ignored Files', category: 'Files' },
  { id: 'files.revealInTree', title: 'Reveal in File Tree', category: 'Files', gesture: 'click a breadcrumb segment in the viewer header' },
  { id: 'viewer.open', title: 'Open in Viewer', category: 'Viewer', gesture: 'click a file in the file panel' },
  { id: 'viewer.switchFileDiff', title: 'Switch File / Diff', category: 'Viewer', other: 'viewer header' },
  { id: 'viewer.goToLine', title: 'Go to Line…', category: 'Viewer', keys: ['⌃G'], linuxKeys: ['Alt+G'], keyScope: 'viewer tab' },
  { id: 'viewer.find', title: 'Find in File', category: 'Viewer', keys: ['⌘F'], linuxKeys: ['Ctrl+Shift+F'], keyScope: 'viewer tab' },
  { id: 'viewer.toggleWrap', title: 'Toggle Word Wrap', category: 'Viewer', keys: ['⌥Z'], linuxKeys: ['Alt+Z'], keyScope: 'file tab' },
  { id: 'viewer.toggleMarkdownPreview', title: 'Toggle Markdown Preview', category: 'Viewer', keys: ['⇧⌘V'], linuxKeys: ['Ctrl+Shift+Alt+V'], keyScope: 'Markdown file', other: 'viewer header' },
  { id: 'viewer.toggleDiffLayout', title: 'Toggle Unified / Side-by-Side', category: 'Viewer', keys: ['⌘⇧\\'], linuxKeys: ['Ctrl+Shift+\\'], keyScope: 'diff tab', other: 'viewer header' },
  { id: 'viewer.nextChange', title: 'Next Change', category: 'Viewer', keys: ['⌥↓'], linuxKeys: ['Alt+Down'], keyScope: 'viewer tab' },
  { id: 'viewer.previousChange', title: 'Previous Change', category: 'Viewer', keys: ['⌥↑'], linuxKeys: ['Alt+Up'], keyScope: 'viewer tab' },
  { id: 'viewer.nextFile', title: 'Next Changed File', category: 'Viewer', keys: [']'], linuxKeys: [']'], keyScope: 'diff tab' },
  { id: 'viewer.previousFile', title: 'Previous Changed File', category: 'Viewer', keys: ['['], linuxKeys: ['['], keyScope: 'diff tab' },
  { id: 'viewer.sendReference', title: 'Send Reference to Agent', category: 'Viewer', keys: ['⌘L'], linuxKeys: ['Ctrl+Shift+L'], keyScope: 'viewer tab' },
  { id: 'viewer.copyReference', title: 'Copy Reference', category: 'Viewer', keys: ['⌘⇧C'], linuxKeys: ['Ctrl+Shift+Alt+C'], keyScope: 'viewer tab' },
  { id: 'viewer.pinTab', title: 'Pin Tab', category: 'Viewer', gesture: 'double-click the tab, or ↵ in it' },
  { id: 'viewer.openInEditor', title: 'Open in Editor', category: 'Viewer', keys: ['⌘↵'], linuxKeys: ['Ctrl+Shift+Enter'], keyScope: 'viewer tab', other: 'viewer header' },
  { id: 'server.toggle', title: 'Run / Stop Dev Server', category: 'Server', keys: ['⌘R'], linuxKeys: ['Ctrl+Shift+R'], titles: ['Run Dev Server', 'Stop Dev Server'] },
  { id: 'server.restart', title: 'Restart Dev Server', category: 'Server', keys: ['⇧⌘R'], linuxKeys: ['Ctrl+Shift+F5'] },
  { id: 'server.openBrowser', title: 'Open in Browser', category: 'Server', gesture: 'click the port chip' },
  { id: 'server.showLog', title: 'Show Server Log', category: 'Server' },
  { id: 'view.palette', title: 'Command Palette', category: 'View', keys: ['⌘⇧P'], linuxKeys: ['Ctrl+Shift+Alt+P'] },
  { id: 'view.toggleSidebar', title: 'Toggle Sidebar', category: 'View', keys: ['⌘B'], linuxKeys: ['Ctrl+Shift+B'] },
  { id: 'view.cycleFocus', title: 'Next / Previous Region', category: 'View', keys: ['F6', '⇧F6'], linuxKeys: ['F6', 'Shift+F6'], keyArgs: [{ step: 1 }, { step: -1 }] },
  { id: 'view.toggleAgentPane', title: 'Show Agent Beside Terminals / Show Agent as a Tab', category: 'View', titles: ['Show Agent Beside Terminals', 'Show Agent as a Tab'] },
  { id: 'view.focusAgent', title: 'Focus Agent', category: 'View', keys: ['⌘]'], linuxKeys: ['Ctrl+Shift+PageDown'] },
  { id: 'view.focusWork', title: 'Focus Work Pane', category: 'View', keys: ['⌘['], linuxKeys: ['Ctrl+Shift+PageUp'] },
  { id: 'view.openIn', title: 'Open in… (each detected editor)', category: 'View', surfaces: ['editor ▾'], titles: ['Open in…'] },
  { id: 'view.openInTerminalApp', title: 'Open in Terminal App', category: 'View', surfaces: ['editor ▾'] },
  { id: 'app.checkUpdates', title: 'Check for Updates… / Restart to Update / Restart Kea', category: 'App', surfaces: ['menu-bar item'], titles: ['Check for Updates…', 'Restart to Update', 'Restart Kea'] },
  { id: 'app.settings', title: 'Settings', category: 'App', keys: ['⌘,'], linuxKeys: ['Ctrl+Shift+,'] },
  { id: 'app.reloadShellEnv', title: 'Reload Shell Environment', category: 'App', other: 'Settings › Advanced' },
  { id: 'app.copyDiagnostics', title: 'Copy Diagnostics', category: 'App', other: 'Settings › Advanced' },
  { id: 'app.showDisk', title: 'Show Disk Usage', category: 'App' },
  { id: 'app.openReports', title: 'Open Reports Folder', category: 'App', other: 'Settings › Advanced' },
  { id: 'app.shortcuts', title: 'Keyboard Shortcuts', category: 'App' },
  { id: 'app.openKea', title: 'Open Kea', category: 'App', surfaces: ['menu-bar item'] },
  { id: 'app.closeToMenuBar', title: 'Close to Menu Bar (sessions keep running)', linuxTitle: 'Close Kea (sessions keep running)', category: 'App', keys: ['⌘Q'], linuxKeys: ['Ctrl+Shift+Q'] },
  { id: 'app.quit', title: 'Quit Kea Completely', category: 'App', keys: ['⌥⌘Q'], linuxKeys: ['Ctrl+Shift+Alt+Q'], surfaces: ['menu-bar item'] },
]

const BY_ID: ReadonlyMap<string, CommandDef> = new Map(COMMANDS.map((c) => [c.id, c]))

export function commandById(id: string): CommandDef | undefined {
  return BY_ID.get(id)
}

export function isCommandId(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id)
}

/** The command's title on this system: the table's on macOS; on Linux `Reveal in File Manager`, `Close Kea …`. */
export function systemTitle(def: CommandDef, os: ProtocolOs = protocolOs): string {
  return os.words.title(def)
}

/**
 * The title a menu or the palette shows while nothing says which of the row's `titles` applies: the row's one shown
 * title where it has just one (`Open in…`), else the table's for this system (`Run / Stop Dev Server`).
 */
export function commandTitle(def: CommandDef, os: ProtocolOs = protocolOs): string {
  return def.titles?.length === 1 ? (def.titles[0] as string) : systemTitle(def, os)
}

/** The command's default bindings on this system, in the table's notation: `⌘⇧P` on macOS, `Ctrl+Shift+Alt+P` on Linux. */
export function systemKeys(def: CommandDef, keys: KeyLabels = protocolOs.keys): readonly string[] {
  return keys.keysOf(def) ?? []
}

/**
 * The Edit menu's Select All in a terminal: the item keeps its native role (⌘A in a field the page does not draw), and
 * the router sends the system's Select All key in a terminal to this command instead (`KeyLabels.terminalSelectAll`).
 */
export const SELECT_ALL_COMMAND = 'terminal.selectAll'

/** Commands whose action is a native menu role, so the browser's own clipboard events reach the focused element. */
export const NATIVE_ROLES: Readonly<Record<string, 'copy' | 'paste'>> = { 'terminal.copy': 'copy', 'terminal.paste': 'paste' }

/** Commands main runs itself: they must work with no window (quit, reopen, the update check, whose state is main's). */
export const MAIN_COMMANDS: readonly string[] = ['app.openKea', 'app.closeToMenuBar', 'app.quit', 'app.checkUpdates']

// ── shortcuts ──────────────────────────────────────────────────────────────────────────────────────

/** A key chord. `key` is canonical: `a`…`z`, `0`…`9`, punctuation as typed unshifted (`[`, `=`, `-`, `` ` ``), or a name. */
export interface Chord {
  cmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

const GLYPH_KEYS: Readonly<Record<string, string>> = {
  '↵': 'enter',
  '⌫': 'backspace',
  '⌦': 'delete',
  '←': 'left',
  '→': 'right',
  '↑': 'up',
  '↓': 'down',
  Tab: 'tab',
  '+': '=', // ⌘+ is the = key on a Mac keyboard, as in every Mac app
  '−': '-', // U+2212, as the table writes `⌘−`
}

/** The Linux column's modifier and key names (`Ctrl+Shift+Alt+Enter`); a one-character key is itself (`Ctrl+Shift+]`). */
const NAMED_MODS: Readonly<Record<string, 'cmd' | 'ctrl' | 'alt' | 'shift'>> = { Ctrl: 'ctrl', Shift: 'shift', Alt: 'alt', Super: 'cmd' }
const NAMED_KEYS: Readonly<Record<string, string>> = { Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Esc: 'escape', Left: 'left', Right: 'right', Up: 'up', Down: 'down', Space: 'space', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown' }

/**
 * A binding as the table writes it → its chord: `⌘⇧]` → `{ cmd, shift, key: ']' }`, and the Linux column's
 * `Ctrl+Shift+]` → `{ ctrl, shift, key: ']' }`. Null for anything that is not a single chord.
 */
export function parseShortcut(s: string): Chord | null {
  return parseGlyphs(s.trim()) ?? parseNamed(s.trim())
}

/** The Linux column's notation: names joined by `+`, then the key (`Ctrl+Shift+Alt+N`, `Shift+F6`, `Enter`). */
function parseNamed(s: string): Chord | null {
  const c: Chord = { cmd: false, ctrl: false, alt: false, shift: false, key: '' }
  const parts = s.split('+')
  const last = parts.pop() as string
  for (const p of parts) {
    const m = Object.hasOwn(NAMED_MODS, p) ? NAMED_MODS[p] : undefined
    if (!m || c[m]) return null
    c[m] = true
  }
  if (/^F([1-9]|1[0-9])$/.test(last)) c.key = last.toLowerCase()
  else if (Object.hasOwn(NAMED_KEYS, last)) c.key = NAMED_KEYS[last] as string
  else if ([...last].length === 1 && isChordKey(last.toLowerCase())) c.key = last.toLowerCase()
  else return null
  return c
}

/** The table's macOS notation: modifier glyphs, then the key (`⌘⇧]`, `⇧F6`, `↵`). */
function parseGlyphs(s: string): Chord | null {
  const c: Chord = { cmd: false, ctrl: false, alt: false, shift: false, key: '' }
  let rest = s
  for (;;) {
    const m = rest[0]
    if (m === '⌘') c.cmd = true
    else if (m === '⇧') c.shift = true
    else if (m === '⌥') c.alt = true
    else if (m === '⌃') c.ctrl = true
    else break
    rest = rest.slice(1)
  }
  if (!rest) return null
  if (/^F([1-9]|1[0-9])$/.test(rest)) c.key = rest.toLowerCase()
  else if (GLYPH_KEYS[rest]) c.key = GLYPH_KEYS[rest] as string
  else if ([...rest].length === 1) c.key = rest.toLowerCase()
  else return null
  return c
}

/** Canonical text of a chord: modifiers in a fixed order, then the key (`cmd+shift+]`). */
export function chordText(c: Chord): string {
  return `${c.cmd ? 'cmd+' : ''}${c.ctrl ? 'ctrl+' : ''}${c.alt ? 'alt+' : ''}${c.shift ? 'shift+' : ''}${c.key}`
}

/** An Electron accelerator for a table binding, in either column (`⌘⇧]` → `Cmd+Shift+]`, `Ctrl+Shift+]` → `Ctrl+Shift+]`), or null if it has none. */
export function toAccelerator(s: string): string | null {
  const c = parseShortcut(s)
  return c ? chordAccelerator(chordText(c)) : null
}

/** A chord's named keys (everything that is not one character), as `chordText` writes them. */
const CHORD_KEY_NAMES: readonly string[] = ['enter', 'backspace', 'tab', 'escape', 'left', 'right', 'up', 'down', 'space', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown']
/** The one-character keys a chord may name: letters, digits and the unshifted punctuation of a Mac keyboard. */
const CHORD_KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789[]\\,./;'`-="

/** A key as a chord names it: `a`…`z`, `0`…`9`, unshifted punctuation, `f1`…`f19`, or one of the named keys. */
export function isChordKey(key: string): boolean {
  return (key.length === 1 && CHORD_KEY_CHARS.includes(key)) || CHORD_KEY_NAMES.includes(key) || /^f([1-9]|1[0-9])$/.test(key)
}

/** A canonical chord text (`cmd+shift+]`, as `chordText` writes it) back as a chord; null for anything else. */
export function parseChord(text: string): Chord | null {
  const m = /^(cmd\+)?(ctrl\+)?(alt\+)?(shift\+)?(.+)$/.exec(text)
  if (!m || !isChordKey(m[5] as string)) return null
  return { cmd: !!m[1], ctrl: !!m[2], alt: !!m[3], shift: !!m[4], key: m[5] as string }
}

const CHORD_ACCEL_KEYS: Readonly<Record<string, string>> = { enter: 'Enter', backspace: 'Backspace', tab: 'Tab', escape: 'Esc', left: 'Left', right: 'Right', up: 'Up', down: 'Down', space: 'Space', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', '=': 'Plus' }

/** An Electron accelerator for a canonical chord text (`cmd+shift+]` → `Cmd+Shift+]`); null if it is not one. */
export function chordAccelerator(text: string): string | null {
  const c = parseChord(text)
  if (!c) return null
  const key = CHORD_ACCEL_KEYS[c.key] ?? c.key.toUpperCase()
  return `${c.cmd ? 'Cmd+' : ''}${c.ctrl ? 'Ctrl+' : ''}${c.alt ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${key}`
}

/**
 * A canonical chord text as a chip shows it, in this system's notation (`keys`): the table's glyphs on macOS
 * (`cmd+shift+r` → `⇧⌘R`), its Linux column's on Linux (`ctrl+shift+r` → `Ctrl+Shift+R`). A default binding is shown
 * as the table writes it; this is for a binding from `keybindings.json` and for keys written in a component.
 */
export function chordLabel(text: string, keys: KeyLabels = protocolOs.keys): string {
  const c = parseChord(text)
  return c ? keys.label(c) : text
}

export interface Binding {
  chord: string
  id: string
  scope: KeyScope | null
  args?: unknown
}

/** Every default binding in the table on this system (`keys`): `chord text` → its command. */
export function bindings(table: readonly CommandDef[] = COMMANDS, keys: KeyLabels = protocolOs.keys): Binding[] {
  const out: Binding[] = []
  for (const c of table) {
    for (const [i, k] of systemKeys(c, keys).entries()) {
      const chord = parseShortcut(k)
      if (!chord) throw new Error(`${c.id}: cannot parse binding ${k}`)
      out.push({ chord: chordText(chord), id: c.id, scope: c.keyScope ?? null, ...(c.keyArgs ? { args: c.keyArgs[i] } : {}) })
    }
  }
  return out
}

// ── menus ──────────────────────────────────────────────────────────────────────────────────────────

/** A contextual menu: the commands of the table marked with `surface`, in table order, filtered by `include`. */
export function surfaceMenu(surface: Surface, include: (id: string) => boolean = () => true, table: readonly CommandDef[] = COMMANDS): string[] {
  return table.filter((c) => c.surfaces?.includes(surface) && include(c.id)).map((c) => c.id)
}

/** The menu bar's sections: one per category, in category order, each listing its included commands in table order. */
export function menuSections(include: (id: string) => boolean, table: readonly CommandDef[] = COMMANDS): { category: Category; ids: string[] }[] {
  return CATEGORIES.map((category) => ({ category, ids: table.filter((c) => c.category === category && include(c.id)).map((c) => c.id) })).filter((s) => s.ids.length > 0)
}

// ── renderer ⇄ main messages ───────────────────────────────────────────────────────────────────────

/**
 * Renderer → main (`kea:menuState`): the commands the renderer has handlers for, with their availability. Main builds the
 * menu bar from the table plus this; a click comes back as a `CommandInvocation`.
 *
 * `title`: the one of the row's `titles` that applies now (`Stop Dev Server`); nothing else is accepted, so no text of
 * the renderer's own reaches the menu bar. `keys`: the commands whose binding `keybindings.json` changed, each
 * with its key now as a canonical chord text, or null where the file took it away; for every other command the
 * table's default stands.
 */
export const zMenuState = z.object({
  commands: z
    .array(
      z
        .object({ id: z.string().refine(isCommandId, 'unknown command'), enabled: z.boolean(), title: z.string().optional() })
        .refine((c) => c.title === undefined || commandById(c.id)?.titles?.includes(c.title) === true, 'not a title of the command'),
    )
    .max(COMMANDS.length),
  keys: z
    .record(
      z.string().refine(isCommandId, 'unknown command'),
      z
        .string()
        .refine((k) => parseChord(k) !== null, 'not a chord')
        .nullable(),
    )
    .optional(),
})
export type MenuState = z.infer<typeof zMenuState>

/**
 * Main → renderer (`kea:windowMenu`, Linux): the application menu as the window draws it, from the same template as
 * the hidden menu bar. `id` is what a pick sends back (`kea:menuPick`): a command's id, `role:<name>` for an Edit
 * role, or one of main's own items' (`window.minimize`); a submenu is `menu:<place>`, a separator `sep:<place>`.
 * `shortcut` is the key as the item shows it.
 */
export interface WindowMenuNode {
  id: string
  label: string
  enabled: boolean
  shortcut?: string | undefined
  separator?: boolean | undefined
  submenu?: WindowMenuNode[] | undefined
}
export const zWindowMenuNode: z.ZodType<WindowMenuNode> = z.lazy(() =>
  z.object({ id: z.string(), label: z.string(), enabled: z.boolean(), shortcut: z.string().optional(), separator: z.boolean().optional(), submenu: z.array(zWindowMenuNode).optional() }),
)

/** The Edit roles main runs on the window's focused element (`kea:editRole`, and the window menu's Edit items). */
export const EDIT_ROLES = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const
export type EditRole = (typeof EDIT_ROLES)[number]

/** Main → renderer (`kea:command`): run a command chosen from the menu bar. */
export type CommandInvocation = { id: string; args?: unknown }
