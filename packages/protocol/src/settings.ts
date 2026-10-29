// The whole settings surface, stated once. Each key carries its default, allowed values, label, help text and Settings
// section; the General, Terminal, Agents, Notifications and Files sections of the Settings UI are rendered from this
// table (U-SET-3), and the Updates section's rows by Settings › About, which alone draws them.
// Adding a setting is one entry here. Adapters add their own keys through `AgentSettingsExtension`.
import { z } from 'zod'
import { L } from './generated/limits.ts'
import { BUNDLED_THEMES } from './generated/themes.ts'
import { protocolOs, type ProtocolOs } from './os/index.ts'
import { defineApi } from './rpc.ts'

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export type SettingDef = {
  /** Dotted key; for agent keys the path below `agents.<id>.` */
  key: string
  schema: z.ZodType
  default: unknown
  label: string
  help?: string
  section: SettingsSection
  /** Allowed values for select controls, in display order. */
  options?: readonly { value: string; label: string }[]
  /** For a select whose values are only known at run time: the registered adapters. */
  optionsFrom?: 'agents'
  /** Control the generated UI renders. */
  control: SettingControl
  /** One sentence the row shows while the value differs from the default (no scare modal). */
  onNote?: string
}

export const SETTING_CONTROLS = ['toggle', 'select', 'number', 'text', 'path', 'list', 'map', 'none'] as const
export type SettingControl = (typeof SETTING_CONTROLS)[number]
export const SETTINGS_SECTIONS = ['General', 'Terminal', 'Agents', 'Notifications', 'Files', 'Updates', 'file only'] as const

const sel = <const V extends readonly string[]>(values: V, labels: Record<V[number], string>) =>
  values.map((v) => ({ value: v, label: labels[v as V[number]] }))

export const EDITORS = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'zed'] as const
export const ON_QUIT = ['menuBar', 'quit', 'stopAll'] as const
/** The terminal's screen-reader mode on Linux, which tells no change of an assistive technology. */
export const SCREEN_READER = ['auto', 'on', 'off'] as const
export const SESSION_ORDER = ['stable', 'attention'] as const
export const CURSOR_STYLES = ['block', 'bar', 'underline'] as const
export const CLIPBOARD_WRITE = ['focused', 'always', 'never'] as const
export const CHANGES_SCOPE = ['branch', 'uncommitted'] as const
export const ICON_THEMES = ['minimal', 'material'] as const
/**
 * `auto` is the first terminal app found, in the catalog's order (`app/core/src/editor/catalog.ts`): macOS's
 * apps, then the ones only Linux has. One settings file serves both systems, so the setting takes either
 * system's; Settings offers this system's (core's `settings.describe`).
 */
export const TERMINAL_APPS = ['auto', 'ghostty', 'iterm', 'warp', 'kitty', 'wezterm', 'alacritty', 'terminal', 'konsole', 'ptyxis', 'gnome-terminal', 'x-terminal-emulator'] as const
export type TerminalAppChoice = (typeof TERMINAL_APPS)[number]

export { BUNDLED_THEMES }
/** The theme that follows the user's Ghostty config instead of a bundled palette. */
export const GHOSTTY_THEME = 'ghostty'
/** `terminal.theme`: the bundled themes (generated from `constants/tokens.json`), then "Match Ghostty config". */
export const TERMINAL_THEMES = [...BUNDLED_THEMES.map((t) => t.id as string), GHOSTTY_THEME] as unknown as [string, ...string[]]
const THEME_OPTIONS = [...BUNDLED_THEMES.map((t) => ({ value: t.id as string, label: t.label as string })), { value: GHOSTTY_THEME, label: 'Match Ghostty config' }]

const days = z.number().int().min(0).max(L.settingsDaysMax)

/** A branch prefix (`general.branchPrefix`, `ProjectSettings.branchPrefix`): letters, digits and `._/-`. */
export const zBranchPrefix = z.string().max(L.settingsBranchPrefixMaxChars).regex(/^[A-Za-z0-9._/-]*$/)

/** Global keys (everything except `agents.*`). */
export const SETTINGS: readonly SettingDef[] = [
  { key: 'general.worktreeRoot', schema: z.string().startsWith('/').nullable(), default: null, label: 'Worktree location', help: 'Where new sessions’ worktrees are created. Empty means <KEA_HOME>/worktrees. Existing sessions keep their paths.', section: 'General', control: 'path' },
  { key: 'general.branchPrefix', schema: zBranchPrefix, default: 'kea/', label: 'Branch prefix', help: 'Prefix for new session branches; per-project override in Projects.', section: 'General', control: 'text' },
  { key: 'general.defaultAgent', schema: z.string().min(1), default: 'claude', label: 'Default agent', section: 'General', control: 'select', optionsFrom: 'agents' },
  { key: 'general.defaultEditor', schema: z.enum(EDITORS), default: 'vscode', label: 'Default editor', section: 'General', control: 'select', options: sel(EDITORS, { vscode: 'VS Code', 'vscode-insiders': 'VS Code Insiders', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed' }) },
  { key: 'general.terminalApp', schema: z.enum(TERMINAL_APPS), default: 'auto', label: 'Terminal app', help: '“Open in Terminal App” opens this one. Automatic: the first one installed, in this order.', section: 'General', control: 'select', options: sel(TERMINAL_APPS, { auto: 'Automatic', ghostty: 'Ghostty', iterm: 'iTerm', warp: 'Warp', kitty: 'kitty', wezterm: 'WezTerm', alacritty: 'Alacritty', terminal: 'Terminal', konsole: 'Konsole', ptyxis: 'Ptyxis', 'gnome-terminal': 'GNOME Terminal', 'x-terminal-emulator': 'The system’s terminal' }) },
  // the first choice and the help in this system's words: the menu bar on macOS, the background with a tray on Linux
  { key: 'general.onQuit', schema: z.enum(ON_QUIT), default: 'menuBar', label: 'On quit', help: protocolOs.words.onQuitHelp, section: 'General', control: 'select', options: sel(ON_QUIT, { menuBar: protocolOs.words.stayRunning, quit: 'Quit completely (sessions keep running)', stopAll: 'Stop all sessions and quit' }) },
  { key: 'general.autoCleanArchivedDays', schema: days, default: 14, label: 'Auto-clean archived sessions after (days)', help: '0 = never. Only clean, merged worktrees are removed.', section: 'General', control: 'number' },
  { key: 'general.deletedRetentionDays', schema: days.min(1), default: 14, label: 'Keep deleted sessions restorable for (days)', section: 'General', control: 'number' },
  { key: 'general.pruneArchivedBuildDirsDays', schema: days, default: 7, label: 'Remove build folders of archived sessions after (days)', help: '0 = never.', section: 'General', control: 'number' },
  { key: 'general.excludeBuildDirsFromBackup', schema: z.boolean(), default: true, label: 'Exclude build folders from Time Machine', section: 'General', control: 'toggle' },
  { key: 'general.sessionOrder', schema: z.enum(SESSION_ORDER), default: 'stable', label: 'Session order', section: 'General', control: 'select', options: sel(SESSION_ORDER, { stable: 'Stable (newest first)', attention: 'Needs me first' }) },

  // the default font is this system's: SF Mono on macOS, JetBrains Mono on Linux
  { key: 'terminal.fontFamily', schema: z.string().min(1).max(L.settingsFontFamilyMaxChars), default: protocolOs.window.terminalFont, label: 'Font', section: 'Terminal', control: 'text' },
  { key: 'terminal.fontSize', schema: z.number().min(L.settingsFontSizeMin).max(L.settingsFontSizeMax), default: 13, label: 'Font size', section: 'Terminal', control: 'number' },
  { key: 'terminal.lineHeight', schema: z.number().min(L.settingsLineHeightMin).max(L.settingsLineHeightMax), default: 1.2, label: 'Line height', section: 'Terminal', control: 'number' },
  { key: 'terminal.theme', schema: z.enum(TERMINAL_THEMES), default: 'kea-dark', label: 'Theme', help: '“Match Ghostty config” reads the colours and the font of ~/.config/ghostty/config, and follows the file as it changes. Kea’s own chrome keeps its colours.', section: 'Terminal', control: 'select', options: THEME_OPTIONS },
  { key: 'terminal.cursorStyle', schema: z.enum(CURSOR_STYLES), default: 'block', label: 'Cursor', section: 'Terminal', control: 'select', options: sel(CURSOR_STYLES, { block: 'Block', bar: 'Bar', underline: 'Underline' }) },
  { key: 'terminal.cursorBlink', schema: z.boolean(), default: false, label: 'Blinking cursor', section: 'Terminal', control: 'toggle' },
  { key: 'terminal.scrollback', schema: z.number().int().min(0).max(L.settingsScrollbackMax), default: 5000, label: 'Scrollback lines', section: 'Terminal', control: 'number' },
  { key: 'terminal.optionIsMeta', schema: z.boolean(), default: true, label: 'Option key is Meta', section: 'Terminal', control: 'toggle' },
  // Linux reports no change of a screen reader, so there the terminal's screen-reader mode follows this (auto: what
  // Electron said at start); macOS follows VoiceOver as it comes and goes, and Settings shows the row on Linux only
  { key: 'terminal.screenReader', schema: z.enum(SCREEN_READER), default: 'auto', label: 'Screen reader support', help: 'Automatic: on when a screen reader was reading the window as Kea started.', section: 'Terminal', control: 'select', options: sel(SCREEN_READER, { auto: 'Automatic', on: 'On', off: 'Off' }) },
  { key: 'terminal.copyOnSelect', schema: z.boolean(), default: false, label: 'Copy on select', section: 'Terminal', control: 'toggle' },
  // Linux's: Ctrl+C and Ctrl+V are the terminal's own there (Ctrl+Shift+C and V copy and paste); macOS hides the row
  { key: 'terminal.ctrlCopyPaste', schema: z.boolean(), default: false, label: 'Ctrl+C copies selected text, Ctrl+V pastes', help: 'Ctrl+C with nothing selected still interrupts. Ctrl+V then no longer reaches programs (vim’s block select, the shell’s quoted insert). Ctrl+Shift+C and Ctrl+Shift+V work either way.', section: 'Terminal', control: 'toggle' },
  { key: 'terminal.confirmMultilinePaste', schema: z.boolean(), default: true, label: 'Confirm multi-line paste into a shell', section: 'Terminal', control: 'toggle' },
  { key: 'terminal.clipboardWrite', schema: z.enum(CLIPBOARD_WRITE), default: 'focused', label: 'Programs may write the clipboard', help: 'OSC 52 from terminal output. Agents print what they read, so this is limited to the focused terminal by default.', section: 'Terminal', control: 'select', options: sel(CLIPBOARD_WRITE, { focused: 'Only the focused terminal', always: 'Always', never: 'Never' }) },
  { key: 'terminal.diskBackedScrollback', schema: z.boolean(), default: true, label: 'Keep scrollback on disk', help: 'Restores screens after a crash or reboot. Scrollback can contain secrets printed in a terminal; files are private to you and deleted with the session.', section: 'Terminal', control: 'toggle' },
  { key: 'terminal.ringBytes', schema: z.number().int().min(L.ringBytesMin).max(L.ringBytesMax), default: L.ringBytesDefault, label: 'Output ring size (bytes)', section: 'file only', control: 'none' },

  { key: 'notifications.needsYou', schema: z.boolean(), default: true, label: 'Needs permission or has a question', section: 'Notifications', control: 'toggle' },
  { key: 'notifications.finished', schema: z.boolean(), default: true, label: 'Finished', section: 'Notifications', control: 'toggle' },
  { key: 'notifications.failed', schema: z.boolean(), default: true, label: 'Failed (and account conditions)', section: 'Notifications', control: 'toggle' },
  { key: 'notifications.sound', schema: z.boolean(), default: false, label: 'Sound for needs-you', section: 'Notifications', control: 'toggle' },
  { key: 'notifications.dockBadge', schema: z.boolean(), default: true, label: protocolOs.words.badge, section: 'Notifications', control: 'toggle' },
  { key: 'notifications.onlyWhenUnfocused', schema: z.boolean(), default: true, label: 'Only when Kea is not focused', section: 'Notifications', control: 'toggle' },

  { key: 'files.showIgnored', schema: z.boolean(), default: false, label: 'Show ignored files', section: 'Files', control: 'toggle' },
  { key: 'files.compactFolders', schema: z.boolean(), default: true, label: 'Compact folders', section: 'Files', control: 'toggle' },
  { key: 'files.changesScope', schema: z.enum(CHANGES_SCOPE), default: 'branch', label: 'Changes scope', section: 'Files', control: 'select', options: sel(CHANGES_SCOPE, { branch: 'Branch (since it branched)', uncommitted: 'Uncommitted' }) },
  { key: 'files.iconTheme', schema: z.enum(ICON_THEMES), default: 'minimal', label: 'File icons', section: 'Files', control: 'select', options: sel(ICON_THEMES, { minimal: 'Minimal', material: 'Material' }) },

  { key: 'updates.check', schema: z.boolean(), default: true, label: 'Check for updates automatically', help: 'Kea asks GitHub for the newest release now and then. It sends no identifier and no cookie.', section: 'Updates', control: 'toggle' },
]

export const zAgentDefaults = z.object({ model: z.string().optional(), effort: z.string().optional(), permissionMode: z.string().optional() })
export type AgentDefaults = z.infer<typeof zAgentDefaults>

/** Keys every adapter gets under `agents.<id>.` (AgentSettings). Defaults for `defaults` come from the adapter. */
export const AGENT_SETTINGS: readonly SettingDef[] = [
  { key: 'command', schema: z.string().startsWith('/').nullable(), default: null, label: 'Binary path override', section: 'Agents', control: 'path' },
  { key: 'defaults', schema: zAgentDefaults, default: {}, label: 'Defaults for new sessions', section: 'Agents', control: 'none' },
  { key: 'allowDangerousModes', schema: z.boolean(), default: false, label: 'Allow bypass-permission modes', help: 'Shows modes that skip permission prompts in the composer. A worktree is not a sandbox.', onNote: 'Modes that skip permission prompts are now offered in the composer for this agent: it can run any command and change any file your account can, inside the worktree and outside it.', section: 'Agents', control: 'toggle' },
  { key: 'extraArgs', schema: z.array(z.string()).max(L.settingsExtraArgsMax), default: [], label: 'Extra arguments', section: 'Agents', control: 'list' },
  { key: 'env', schema: z.record(z.string().regex(/^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]*$/), z.string()), default: {}, label: 'Extra environment', section: 'Agents', control: 'map' },
  { key: 'throughLoginShell', schema: z.boolean(), default: false, label: 'Launch through login shell', section: 'Agents', control: 'toggle' },
]

/** An adapter's own keys (its `settings.ts`) plus its defaults for the shared `defaults` key. */
export type AgentSettingsExtension = { id: string; displayName: string; defaults: AgentDefaults; keys: readonly SettingDef[] }

export type SettingsNotice = { key: string; message: string }
export type AgentSettingValues = { command: string | null; defaults: AgentDefaults; allowDangerousModes: boolean; extraArgs: string[]; env: Record<string, string>; throughLoginShell: boolean } & Record<string, unknown>

/** Parsed settings: flat dotted keys for globals, plus one object per known agent. */
export type SettingsValues = {
  get<T = unknown>(key: string): T
  agent(id: string): AgentSettingValues
  readonly flat: Readonly<Record<string, unknown>>
}

function getPath(obj: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || !(part in cur)) return { found: false, value: undefined }
    cur = (cur as Record<string, unknown>)[part]
  }
  return { found: true, value: cur }
}

function parseKey(def: SettingDef, raw: unknown, fullKey: string, notices: SettingsNotice[]): unknown {
  const { found, value } = getPath(raw, fullKey)
  if (!found || value === undefined) return def.default
  const r = def.schema.safeParse(value)
  if (r.success) return r.data
  notices.push({ key: fullKey, message: `${fullKey}: ${r.error.issues[0]?.message ?? 'invalid value'} — using the default` })
  return def.default
}

/**
 * Validate a parsed settings.json document key by key: invalid values fall back to their defaults with a notice;
 * unknown keys are ignored here (and preserved in the file by the comment-preserving editor).
 */
export function parseSettings(raw: unknown, agents: readonly AgentSettingsExtension[]): { values: SettingsValues; notices: SettingsNotice[] } {
  const notices: SettingsNotice[] = []
  const flat: Record<string, unknown> = {}
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    notices.push({ key: '', message: 'settings.json must contain an object — using defaults' })
    raw = {}
  }
  for (const def of SETTINGS) flat[def.key] = parseKey(def, raw, def.key, notices)
  const agentValues = new Map<string, AgentSettingValues>()
  for (const ext of agents) {
    const v: Record<string, unknown> = {}
    for (const def of [...AGENT_SETTINGS, ...ext.keys]) {
      const full = `agents.${ext.id}.${def.key}`
      const d = def.key === 'defaults' ? { ...def, default: ext.defaults } : def
      v[def.key] = parseKey(d, raw, full, notices)
      flat[full] = v[def.key]
    }
    v.defaults = { ...ext.defaults, ...(v.defaults as AgentDefaults) }
    agentValues.set(ext.id, v as AgentSettingValues)
  }
  const fallbackAgent = (id: string): AgentSettingValues => {
    const v: Record<string, unknown> = {}
    for (const def of AGENT_SETTINGS) v[def.key] = parseKey(def, raw, `agents.${id}.${def.key}`, [])
    return v as AgentSettingValues
  }
  return {
    notices,
    values: {
      flat,
      get<T>(key: string): T {
        if (!(key in flat)) throw new Error(`unknown setting ${key}`)
        return flat[key] as T
      },
      agent: (id) => agentValues.get(id) ?? fallbackAgent(id),
    },
  }
}

/** Every setting definition, global and per agent, as the Settings UI lists them (U-SET-3). */
export function allSettingDefs(agents: readonly AgentSettingsExtension[]): (SettingDef & { fullKey: string; agent?: string })[] {
  const out: (SettingDef & { fullKey: string; agent?: string })[] = SETTINGS.map((d) => ({ ...d, fullKey: d.key }))
  for (const ext of agents) {
    for (const d of [...AGENT_SETTINGS, ...ext.keys]) out.push({ ...d, fullKey: `agents.${ext.id}.${d.key}`, agent: ext.id })
  }
  return out
}

// ── rows: a setting as the Settings UI draws it ─────────────────────────────────────────────────────────

/**
 * A setting's row as it crosses to the window: a `SettingDef` without its schema (which cannot cross a process
 * boundary), plus the bounds its control shows. The window draws the General, Terminal, Agents, Notifications and Files
 * sections from these and nothing else, so a key added to the schema appears with no UI work (U-SET-6). Validation
 * stays with the schema, in core: `settings.set` refuses a value with the schema's message.
 */
export const zSettingRow = z.object({
  fullKey: z.string(),
  /** The key below `agents.<id>.` for an agent's key; else the full key. */
  key: z.string(),
  /** The adapter this key belongs to (its card in the Agents section). */
  agent: z.string().optional(),
  label: z.string(),
  help: z.string().optional(),
  onNote: z.string().optional(),
  section: z.enum(SETTINGS_SECTIONS),
  control: z.enum(SETTING_CONTROLS),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  optionsFrom: z.enum(['agents']).optional(),
  default: z.unknown(),
  /** A number's bounds and whether it is whole; a text's longest value. */
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
  maxLength: z.number().optional(),
  /** Emptying the control means "no value": the key is reset (a path override that is `null` by default). */
  nullable: z.boolean().optional(),
})
export type SettingRow = z.infer<typeof zSettingRow>

type Bounds = { minValue?: number | null; maxValue?: number | null; isInt?: boolean; maxLength?: number | null; unwrap?: () => z.ZodType }

/** Every setting's row, global and per agent, in the schema's order (`allSettingDefs`). */
export function settingRows(agents: readonly AgentSettingsExtension[], os: ProtocolOs = protocolOs): SettingRow[] {
  // a setting this system has no use for is not shown (Linux: Option-as-Meta; macOS: the screen-reader mode), though
  // the one settings file both systems read may hold it; nor is another system's terminal app
  const hidden = os.window.hiddenSettings
  const apps = os.window.terminalApps
  return allSettingDefs(agents).filter((d) => !hidden.includes(d.fullKey)).map((d) => {
    const nullable = d.schema.safeParse(null).success
    // the bounds are read off the schema, so the control and the validation cannot disagree
    const inner = (nullable ? ((d.schema as Bounds).unwrap?.() ?? d.schema) : d.schema) as Bounds
    const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const row: SettingRow = { fullKey: d.fullKey, key: d.key, label: d.label, section: d.section, control: d.control, default: d.key === 'defaults' && d.agent ? (agents.find((a) => a.id === d.agent)?.defaults ?? d.default) : d.default }
    if (d.agent !== undefined) row.agent = d.agent
    if (d.help !== undefined) row.help = d.help
    if (d.onNote !== undefined) row.onNote = d.onNote
    if (d.options) row.options = d.options.filter((o) => d.fullKey !== 'general.terminalApp' || o.value === 'auto' || apps.includes(o.value)).map((o) => ({ value: o.value, label: o.label }))
    if (d.optionsFrom) row.optionsFrom = d.optionsFrom
    if (d.control === 'number') {
      const [min, max] = [num(inner.minValue), num(inner.maxValue)]
      if (min !== undefined) row.min = min
      if (max !== undefined) row.max = max
      if (inner.isInt) row.integer = true
    }
    if (d.control === 'text' || d.control === 'path') {
      const maxLength = num(inner.maxLength)
      if (maxLength !== undefined) row.maxLength = maxLength
    }
    if (nullable) row.nullable = true
    return row
  })
}

/** `settings.describe`: the rows, and the registered adapters in registry order (one card each in Agents). */
export const zSettingsDescription = z.object({
  rows: z.array(zSettingRow),
  agents: z.array(z.object({ id: z.string(), displayName: z.string() })),
})
export type SettingsDescription = z.infer<typeof zSettingsDescription>

/** The subset of settings the terminal renderer and mirror use (createTerminalOptions). */
export type TerminalSettings = {
  fontFamily: string
  fontSize: number
  lineHeight: number
  theme: string
  cursorStyle: (typeof CURSOR_STYLES)[number]
  cursorBlink: boolean
  scrollback: number
  optionIsMeta: boolean
}

export function terminalSettings(v: SettingsValues): TerminalSettings {
  return {
    fontFamily: v.get('terminal.fontFamily'),
    fontSize: v.get('terminal.fontSize'),
    lineHeight: v.get('terminal.lineHeight'),
    theme: v.get('terminal.theme'),
    cursorStyle: v.get('terminal.cursorStyle'),
    cursorBlink: v.get('terminal.cursorBlink'),
    scrollback: v.get('terminal.scrollback'),
    optionIsMeta: v.get('terminal.optionIsMeta'),
  }
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = terminalSettings(parseSettings({}, []).values)

// ── the settings stores and calls ──────────────────────────────────────────────────────────────────────

/** Every setting's effective value by its full dotted key (`terminal.fontSize`, `agents.claude.defaults`). */
export const SETTINGS_STORE = 'settings'
/** One entry, key `SETTINGS_STATUS_KEY`: the file's state for the banner and the per-key notices. */
export const SETTINGS_STATUS_STORE = 'settings.status'
export const SETTINGS_STATUS_KEY = 'file'

/** Where `settings.json` failed to parse (jsonc-parser), 1-based line and column. */
export const zSettingsParseError = z.object({ message: z.string(), line: z.number().int().min(1), column: z.number().int().min(1), offset: z.number().int().min(0) })
export type SettingsParseError = z.infer<typeof zSettingsParseError>

export const zSettingsNotice = z.object({ key: z.string(), message: z.string() })

/** `settings.status`: what the banner shows. */
export const zSettingsStatus = z.object({
  /** `<KEA_HOME>/settings.json` ("Open settings.json"). */
  path: z.string(),
  exists: z.boolean(),
  /** The file does not parse: the values are the last good ones (defaults at launch). */
  error: zSettingsParseError.nullable(),
  /** Values that failed validation and fell back to their defaults, one per key. */
  notices: z.array(zSettingsNotice),
})
export type SettingsStatus = z.infer<typeof zSettingsStatus>

// ── "Match Ghostty config" ─────────────────────────────────────────────────────────────────────────────

/** What core read from the user's Ghostty config, as the `settings.ghostty` store's one entry (`SETTINGS_GHOSTTY_KEY`). */
export const SETTINGS_GHOSTTY_STORE = 'settings.ghostty'
export const SETTINGS_GHOSTTY_KEY = 'config'

const zHexColour = z.string().regex(/^#[0-9a-f]{6}$/)

/**
 * The six things Kea takes from `~/.config/ghostty/config`, each null when the file does not state it (or
 * states something Kea cannot use), plus the selection and cursor-text colours when the file gives them. Colours are
 * `#rrggbb`. `found` is false while the file is missing, unreadable, or not being followed (another theme is chosen):
 * everything is then null and the terminal shows Kea Dark.
 */
export const zGhosttyConfig = z.object({
  path: z.string(),
  found: z.boolean(),
  fontFamily: z.string().nullable(),
  fontSize: z.number().nullable(),
  background: zHexColour.nullable(),
  foreground: zHexColour.nullable(),
  cursor: zHexColour.nullable(),
  cursorText: zHexColour.nullable(),
  selectionBackground: zHexColour.nullable(),
  selectionForeground: zHexColour.nullable(),
  /** ANSI 0…15 */
  palette: z.array(zHexColour.nullable()).length(16),
})
export type GhosttyConfig = z.infer<typeof zGhosttyConfig>

/** Nothing read: the file is missing or not followed. */
export function noGhosttyConfig(path: string): GhosttyConfig {
  return { path, found: false, fontFamily: null, fontSize: null, background: null, foreground: null, cursor: null, cursorText: null, selectionBackground: null, selectionForeground: null, palette: Array.from({ length: 16 }, () => null) }
}

/** A full dotted settings key. */
export const zSettingKey = z.string().regex(/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/)

/** The codes of the RpcErrors these calls fail with. */
export const SETTINGS_ERRORS = [
  /** No such key in the schema (or the agent is not registered). */
  'unknown_key',
  /** The value fails the key's schema. */
  'invalid_value',
  /** settings.json does not parse: it is never edited until it is fixed. */
  'file_invalid',
] as const

/** Methods core serves to the renderer for settings. Each changes exactly one key in the file and applies live. */
export const settingsApi = defineApi({
  'settings.set': { args: z.object({ key: zSettingKey, value: z.unknown() }), result: z.object({ ok: z.boolean() }) },
  /** Reset to the default: the key is removed from the file. */
  'settings.reset': { args: z.object({ key: zSettingKey }), result: z.object({ ok: z.boolean() }) },
  /** The rows the Settings UI draws its generated sections from, and the adapters in registry order. */
  'settings.describe': { args: z.object({}), result: zSettingsDescription },
})
