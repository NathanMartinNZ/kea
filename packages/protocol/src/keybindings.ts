// `<KEA_HOME>/keybindings.json`: the person's own key bindings, as they cross from core, which reads
// and validates the file, to the window, which routes keys by them and shows them (the menu bar, the palette,
// tooltips, Settings › Keyboard).
//
//   [
//     { "command": "terminal.jumpToBottom", "key": "cmd+alt+b" },     // the command's binding is now ⌥⌘B
//     { "command": "session.archive", "key": null }                   // the command has no binding
//   ]
//
// · An entry replaces the bindings its command had (the table's default, or an earlier entry's).
// · A key is written `cmd+shift+r` (modifiers `cmd`, `ctrl`, `alt`, `shift` in any order, then the key), or as the
//   command table writes it (`⇧⌘R`, `Ctrl+Shift+R`). One file serves both systems: `primary` is the system's
//   modifier, `⌘` on macOS and `Ctrl+Shift` on Linux, where `cmd` (and `⌘`) reads as `ctrl+shift` too and `super` is
//   refused (the desktop has it).
// · The key router's rule holds for the file too: a command that applies everywhere must use the primary
//   modifier (or be one of the router's few other chords), so no entry can take a key from a program in a terminal; a
//   command of one context (a viewer tab, the file panel) may use any key, as its default may. The Mac text-editing
//   keys, copy and paste (native menu roles) and the chords the system, its desktop or the menu bar itself
//   answers cannot be bound.
// · An entry that breaks a rule is left out and reported (`notices`); the others apply. Two commands on one chord in
//   one context: the entry wins, the other command loses that key, and the pair is reported (`conflicts`).
//
// Everything here is pure. Core's reader is `app/core/src/settings/keybindings.ts`; the window's copy is
// `app/renderer/src/features/commands/bindings.svelte.ts`.

import { z } from 'zod'
import { bindings, chordLabel, chordText, COMMANDS, commandById, isChordKey, MAIN_COMMANDS, NATIVE_ROLES, parseShortcut, systemKeys, systemTitle, type Binding, type Chord, type CommandDef, type KeyScope } from './commands.ts'
import { L } from './generated/limits.ts'
import { protocolOs, type KeyLabels, type KeyMods } from './os/index.ts'
import { defineApi } from './rpc.ts'

export const KEYBINDINGS_FILE = 'keybindings.json'
/** Core's store of the file's state: one row, `KEYBINDINGS_KEY`. */
export const KEYBINDINGS_STORE = 'keybindings'
export const KEYBINDINGS_KEY = 'file'

/** One valid entry: the command's binding as a canonical chord text (`cmd+shift+r`), or null when it has none. */
export interface KeyOverride {
  command: string
  chord: string | null
}

/** An entry that was left out, and why. `index` is its place in the file's array (0-based); -1 for the file as a whole. */
export interface KeybindingNotice {
  index: number
  command: string | null
  key: string | null
  message: string
}

export interface KeybindingsError {
  message: string
  line: number
  column: number
}

/** The `keybindings` store's row. */
export interface KeybindingsState {
  path: string
  exists: boolean
  /** The file does not parse, is not an array or cannot be read: the bindings in use stay the last good ones. */
  error: KeybindingsError | null
  /** The valid entries, in the file's order, one per command (a command's last entry). */
  overrides: KeyOverride[]
  notices: KeybindingNotice[]
}

export const NO_KEYBINDINGS: Pick<KeybindingsState, 'overrides' | 'notices'> = { overrides: [], notices: [] }

// The key router's lists (the text-editing keys a terminal translates, the intercepts without the primary modifier, the
// reserved chords) are each system's own: the OS layer's `keys` (`os/darwin.ts`, `os/linux.ts`).

type ModWord = 'primary' | 'super' | 'ctrl' | 'alt' | 'shift'

/** A modifier as the file writes it. `primary`, `cmd` and `command` are the system's modifier; `super` and `meta` the Super (⌘) key. */
const MODIFIERS: Readonly<Record<string, ModWord>> = {
  primary: 'primary',
  cmd: 'primary',
  command: 'primary',
  meta: 'super',
  super: 'super',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
}

type Mod = 'cmd' | 'ctrl' | 'alt' | 'shift'
const setMods = (m: KeyMods): Mod[] => (['cmd', 'ctrl', 'shift'] as const).filter((k) => m[k])

/** The modifiers a word sets here, or null where the system refuses it (`super` on Linux). */
function modsOf(w: ModWord, keys: KeyLabels): Mod[] | null {
  if (w === 'primary') return setMods(keys.primaryMods)
  if (w === 'super') return typeof keys.superKey === 'string' ? null : setMods(keys.superKey)
  return [w]
}

/** `primary` with `ctrl` or `shift` written too: on Linux they overlap (`cmd+shift+b` is `ctrl+shift+b`), which is no repeat. */
const overlap = (a: ModWord, b: ModWord): boolean => (a === 'primary' && (b === 'ctrl' || b === 'shift')) || (b === 'primary' && (a === 'ctrl' || a === 'shift'))

/** The key names the Super key (`super`, `meta`) where this system refuses it. */
function usesRefusedSuper(text: string, keys: KeyLabels): boolean {
  return typeof keys.superKey === 'string' && text.toLowerCase().split('+').some((p) => Object.hasOwn(MODIFIERS, p.trim()) && MODIFIERS[p.trim()] === 'super')
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  return: 'enter',
  esc: 'escape',
  del: 'delete',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  pgup: 'pageup',
  pgdn: 'pagedown',
  plus: '=',
  minus: '-',
  '+': '=',
  '−': '-',
  '↵': 'enter',
  '⌫': 'backspace',
  '⌦': 'delete',
  '←': 'left',
  '→': 'right',
  '↑': 'up',
  '↓': 'down',
  backquote: '`',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
}

/**
 * A key as `keybindings.json` writes it → its chord on this system (`keys`): `cmd+shift+r`, `Cmd+Shift+R`, `ctrl+tab`,
 * `cmd+plus`, `primary+k`, `⇧⌘R`, `Ctrl+Shift+R`. On Linux `primary`, `cmd` and `⌘` read as `ctrl+shift`. Null for
 * anything that is not one chord with one key, and for a modifier the system refuses.
 */
export function parseKeyText(text: string, keys: KeyLabels = protocolOs.keys): Chord | null {
  const s = text.trim()
  if (s === '') return null
  if (/[⌘⇧⌥⌃]/.test(s)) {
    const c = parseShortcut(s)
    if (!c || !isChordKey(c.key)) return null
    if (!c.cmd) return c
    c.cmd = false
    for (const m of setMods(keys.primaryMods)) c[m] = true
    return c
  }
  // `cmd++` names the + key: the last part is then empty
  const parts = s.toLowerCase().split('+')
  if (parts.length >= 2 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, '+')
  const c: Chord = { cmd: false, ctrl: false, alt: false, shift: false, key: '' }
  const last = (parts.pop() as string).trim()
  // the word that set each modifier: a modifier written twice is no chord
  const by: Partial<Record<Mod, ModWord>> = {}
  // the person's words are looked up as own names only: `constructor` is no modifier and no key
  for (const p of parts) {
    const name = p.trim()
    const w = Object.hasOwn(MODIFIERS, name) ? MODIFIERS[name] : undefined
    const mods = w ? modsOf(w, keys) : null
    if (!w || !mods) return null
    for (const m of mods) {
      const was = by[m]
      if (was !== undefined && !overlap(was, w)) return null
      by[m] = w
      c[m] = true
    }
  }
  const key = (Object.hasOwn(KEY_ALIASES, last) ? KEY_ALIASES[last] : undefined) ?? last
  if (!isChordKey(key)) return null
  c.key = key
  return c
}

/** May `keybindings.json` change this command's binding? If not, why. */
export function rebindable(def: CommandDef, keys: KeyLabels = protocolOs.keys): string | null {
  if (MAIN_COMMANDS.includes(def.id)) return 'is run by the menu bar itself, so that it works with no window; its key cannot be changed'
  if (NATIVE_ROLES[def.id]) return 'is the system’s own copy or paste; its key cannot be changed'
  if (systemKeys(def, keys).length > 1) return 'has several keys, one per place or direction; they cannot be changed'
  return null
}

/** One entry as the file writes it. */
const zEntry = z.strictObject({ command: z.string(), key: z.string().nullable() })

/**
 * The file's document → the entries that apply and the ones that do not. `raw` is the parsed JSON; a document
 * that is not an array is the caller's error (it has the text and so the position).
 */
export function readKeybindings(raw: readonly unknown[], table: readonly CommandDef[] = COMMANDS, keys: KeyLabels = protocolOs.keys): { overrides: KeyOverride[]; notices: KeybindingNotice[] } {
  const notices: KeybindingNotice[] = []
  const byCommand = new Map<string, { index: number; chord: string | null }>() // bounded: one per command of the table
  const byId = new Map(table.map((c) => [c.id, c]))
  const entries = raw.slice(0, L.keybindingsMaxEntries)
  if (raw.length > entries.length) notices.push({ index: -1, command: null, key: null, message: `Only the first ${L.keybindingsMaxEntries} entries are read; ${raw.length - entries.length} more are ignored.` })
  for (const [index, e] of entries.entries()) {
    const r = zEntry.safeParse(e)
    const loose = typeof e === 'object' && e !== null ? (e as { command?: unknown; key?: unknown }) : {}
    const command = typeof loose.command === 'string' ? loose.command : null
    const key = typeof loose.key === 'string' ? loose.key : null
    const refuse = (message: string) => notices.push({ index, command, key, message })
    if (!r.success) {
      const issue = r.error.issues[0]
      const extra = issue?.code === 'unrecognized_keys' ? issue.keys[0] : undefined
      refuse(extra !== undefined ? `Unknown field "${extra}": an entry has "command" and "key" only.` : 'An entry is { "command": "<id>", "key": "<key>" } (or "key": null for no shortcut).')
      continue
    }
    const def = byId.get(r.data.command)
    if (!def) {
      refuse(`No command "${r.data.command}".`)
      continue
    }
    const title = systemTitle(def)
    const fixed = rebindable(def, keys)
    if (fixed !== null) {
      refuse(`${title} ${fixed}.`)
      continue
    }
    let chord: string | null = null
    if (r.data.key !== null && r.data.key.trim() !== '') {
      const c = parseKeyText(r.data.key, keys)
      if (!c) {
        refuse(usesRefusedSuper(r.data.key, keys) ? `"${r.data.key}" ${keys.superKey as string}.` : `"${r.data.key}" is not a key: write it like "${keys.example}".`)
        continue
      }
      chord = chordText(c)
      const reserved = keys.reserved[chord]
      if (reserved !== undefined) {
        refuse(`${chordLabel(chord, keys)} ${reserved}; it cannot be bound.`)
        continue
      }
      // Only a context's own command may use a key without the primary modifier (⌘; Ctrl+Shift on Linux)
      if (!def.keyScope && !keys.primary(c) && keys.intercepts[chord] === undefined) {
        const p = keys.primaryName
        refuse(`${chordLabel(chord, keys)} has no ${p}: a shortcut that works everywhere must use ${p}, so it never takes a key from a program in a terminal.`)
        continue
      }
    }
    const earlier = byCommand.get(def.id)
    if (earlier) notices.push({ index: earlier.index, command: def.id, key: earlier.chord, message: `Replaced by a later entry for ${title}.` })
    byCommand.set(def.id, { index, chord })
  }
  // the file's order, a command at the place of its last entry
  const overrides = [...byCommand].sort((a, b) => a[1].index - b[1].index).map(([command, v]) => ({ command, chord: v.chord }))
  notices.sort((a, b) => a.index - b.index)
  return { overrides, notices }
}

/** Two commands on one chord in one context: the entry of `winner` took it, `loser` lost that key. */
export interface KeyConflict {
  chord: string
  scope: KeyScope | null
  winner: string
  loser: string
}

/** The bindings in use: the table's defaults with the file's entries applied. */
export interface EffectiveBindings {
  /** What the key router matches. */
  bindings: Binding[]
  /** Each command's keys now, as a chip shows them (the table's notation), in the order the router lists them. */
  labels: ReadonlyMap<string, readonly string[]>
  /** Commands whose binding comes from the file (those it left with no key included). */
  changed: ReadonlySet<string>
  conflicts: KeyConflict[]
}

/** The table's defaults on this system (`keys`) with `overrides` applied in order. */
export function effectiveBindings(overrides: readonly KeyOverride[] = [], table: readonly CommandDef[] = COMMANDS, keys: KeyLabels = protocolOs.keys): EffectiveBindings {
  const byId = new Map(table.map((c) => [c.id, c]))
  // each default with the label the table writes for it
  let list: (Binding & { label: string })[] = []
  for (const c of table) {
    const own = bindings([c], keys)
    for (const [i, b] of own.entries()) list.push({ ...b, label: systemKeys(c, keys)[i] as string })
  }
  const changed = new Set<string>()
  const conflicts: KeyConflict[] = []
  for (const o of overrides) {
    const def = byId.get(o.command)
    if (!def) continue
    changed.add(def.id)
    list = list.filter((b) => b.id !== def.id)
    if (o.chord === null) continue
    const scope = def.keyScope ?? null
    const chord = o.chord
    for (const b of list) if (b.chord === chord && b.scope === scope) conflicts.push({ chord, scope, winner: def.id, loser: b.id })
    list = list.filter((b) => !(b.chord === chord && b.scope === scope))
    list.push({ chord, id: def.id, scope, label: chordLabel(chord, keys) })
  }
  const labels = new Map<string, string[]>()
  for (const b of list) {
    const l = labels.get(b.id)
    if (l) l.push(b.label)
    else labels.set(b.id, [b.label])
  }
  return { bindings: list.map(({ label: _, ...b }) => b), labels, changed, conflicts }
}

/** The bindings with nothing changed. */
export const DEFAULT_BINDINGS: EffectiveBindings = effectiveBindings()

/** A conflict in words, for Settings › Keyboard: `⇧⌘R is now Run / Stop Dev Server; Restart Dev Server has lost it.` */
export function conflictText(c: KeyConflict): string {
  const title = (id: string) => {
    const def = commandById(id)
    return def ? systemTitle(def) : id
  }
  return `${chordLabel(c.chord)} is now ${title(c.winner)}${c.scope ? ` (${c.scope})` : ''}; ${title(c.loser)} has lost it.`
}

/**
 * A starter file: what "Open keybindings.json" creates when there is none. Its example is one to copy: a command with
 * no key of its own, on a key no command has on this system (a unit test reads it as the file is read and finds no
 * conflict, U-KB-10): `cmd+shift+b` on macOS, `ctrl+shift+alt+b` on Linux, where Ctrl+Shift+B is Toggle Sidebar.
 */
export function keybindingsTemplate(keys: KeyLabels = protocolOs.keys): string {
  return `// Kea key bindings. One entry per command: its id (Settings › Keyboard lists them all) and the key.
// A shortcut that works everywhere must use ${keys.templateRule}; "key": null takes a command's shortcut away.
//
//   { "command": "terminal.jumpToBottom", "key": "${keys.templateKey}" }
//
// The file is read again whenever it is saved.
[
]
`
}

export const KEYBINDINGS_TEMPLATE = keybindingsTemplate()

export const keybindingsApi = defineApi({
  /** "Open keybindings.json": make sure the file is there (a starter file when it is not), and say where it is. */
  'keybindings.ensureFile': { args: z.object({}), result: z.object({ path: z.string(), created: z.boolean() }) },
})
