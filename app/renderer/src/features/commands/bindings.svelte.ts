// The window's key bindings: the command table's defaults with the person's `keybindings.json` applied. Core reads and
// validates the file and serves its state as the `keybindings` store; this module follows it, gives the key router the
// bindings to match (`keys.ts`), the menu bar the keys that changed (`registry.ts`), and everything that shows a
// shortcut (the palette's chips, tooltips, menus, Settings › Keyboard) the command's key now.
//
// A runes store: `bindingsState.version` moves once per change; `shortcut(id)` and the other readers read it,
// so what shows a key follows the file live. The data itself is plain module state.

import { COMMANDS, commandById, commandTitle, DEFAULT_BINDINGS, effectiveBindings, KEYBINDINGS_KEY, KEYBINDINGS_STORE, type EffectiveBindings, type KeybindingsState } from '@kea/protocol'
import { subscribe } from '../../lib/rpc.ts'
import { setBindings } from './keys.ts'
import { commands } from './registry.ts'

class BindingsState {
  /** Moves whenever the bindings in use or the file's state change. */
  version = $state(0)
}

export const bindingsState = new BindingsState()

/** The bindings in use; replaced whole on each change of the file. */
let effective: EffectiveBindings = DEFAULT_BINDINGS
/** The file's state as core last said it; null until core answers. */
let file: KeybindingsState | null = null
let installed = false

function apply(next: KeybindingsState | null): void {
  file = next
  effective = next && next.overrides.length > 0 ? effectiveBindings(next.overrides) : DEFAULT_BINDINGS
  setBindings(effective.bindings)
  bindingsState.version++
  // the menu bar shows the keys now; the palette and menus read them when they open
  commands.changed()
}

/** Follow core's `keybindings` store. Once per window. */
export function installBindings(): void {
  if (installed) return
  installed = true
  commands.setChangedKeys(changedKeys)
  subscribe<KeybindingsState>(KEYBINDINGS_STORE, (data) => {
    const next = data.get(KEYBINDINGS_KEY) ?? null
    if (JSON.stringify(next) === JSON.stringify(file)) return
    apply(next)
  })
}

/**
 * The keys that are not the table's, by command: its chord now, or null where it has none (the menu bar's report). A
 * command the file names, and a command that lost its key to one the file names (a conflict's loser).
 */
function changedKeys(): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (effective === DEFAULT_BINDINGS) return out
  const ids = new Set(effective.changed)
  for (const c of effective.conflicts) ids.add(c.loser)
  for (const id of ids) out[id] = effective.bindings.find((b) => b.id === id)?.chord ?? null
  return out
}

/** A command's key now, as a chip shows it (`⇧⌘R`); undefined when it has none. Reactive. */
export function shortcut(id: string): string | undefined {
  void bindingsState.version
  return effective.labels.get(id)?.[0]
}

/** Every key of a command now (`F6`, `⇧F6`). Reactive. */
export function shortcuts(id: string): readonly string[] {
  void bindingsState.version
  return effective.labels.get(id) ?? []
}

/** `Go to File (⌘P)`: a control's accessible name with its command's key now; the title alone when it has none. Reactive. */
export function named(id: string, title?: string): string {
  const def = commandById(id)
  const t = title ?? (def ? commandTitle(def) : id)
  const key = shortcut(id)
  return key ? `${t} (${key})` : t
}

/**
 * What a control's tooltip says of its command (`@kea/ui` Tooltip's `resolve`): the title that applies now and the
 * key now, read when the tip shows. Undefined for an id the table does not have.
 */
export function commandTip(id: string): { title: string; shortcut?: string | undefined } | undefined {
  if (!commandById(id)) return undefined
  return { title: commands.title(id), shortcut: shortcut(id) }
}

/** One row of Settings › Keyboard: a command, its keys now and where they come from. */
export interface KeyboardRow {
  id: string
  title: string
  category: string
  /** The keys now, as chips show them. */
  keys: readonly string[]
  /** Where the keys apply, when not everywhere (`viewer tab`). */
  scope: string | null
  /** A pointer gesture the table names instead of, or besides, a key. */
  gesture: string | null
  /** The binding comes from keybindings.json (it may have taken the key away). */
  changed: boolean
}

/** Every command of the table with its binding now, in table order. Reactive. */
export function keyboardRows(extra: (id: string) => readonly string[] = () => []): KeyboardRow[] {
  void bindingsState.version
  return COMMANDS.map((c) => ({
    id: c.id,
    title: commandTitle(c),
    category: c.category,
    keys: [...(effective.labels.get(c.id) ?? []), ...extra(c.id)],
    scope: c.keyScope ?? null,
    gesture: c.gesture ?? null,
    changed: effective.changed.has(c.id),
  }))
}

/** The file's state and what applying it found (Settings › Keyboard). Reactive. */
export function keybindingsFile(): { state: KeybindingsState | null; conflicts: EffectiveBindings['conflicts'] } {
  void bindingsState.version
  return { state: file, conflicts: effective.conflicts }
}

/** For the resource report: entries of the file in use and notices held (each ≤ `keybindingsMaxEntries`). */
export function bindingsResources(): { keyOverrides: number; keyNotices: number } {
  return { keyOverrides: file?.overrides.length ?? 0, keyNotices: file?.notices.length ?? 0 }
}

/** Tests only: put the bindings as if the file held `state`. */
export function setKeybindingsForTest(state: KeybindingsState | null): void {
  apply(state)
}
