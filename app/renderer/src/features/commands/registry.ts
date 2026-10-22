// The command registry: features bind handlers to the ids of the command table (`@kea/protocol` COMMANDS). Titles,
// bindings and menu placement come from the table only; a feature contributes `run`, and optionally `when`
// (availability), `unavailableReason`, which of the row's titles applies now, what the palette offers in place of an
// unavailable command, and the argument a command asks for there. The menu bar, keybindings, the palette and the
// context menus all read from here.

import { commandById, commandTitle, isCommandId, systemTitle, type MenuState } from '@kea/protocol'
import type { Disposable } from '@kea/terminal'

/** One choice of a command's argument: what the palette lists, and what the command then runs with. */
export interface ArgumentChoice {
  label: string
  /** A quieter second text on the row (a path, a branch). */
  detail?: string
  args: unknown
}

/** A command's argument, asked for in the palette instead of a dialog. */
export interface CommandArgument {
  /** The input's placeholder while the choices show ("Project…"). */
  placeholder: string
  /** The choices now; a promise while core is asked for them. */
  choices(): readonly ArgumentChoice[] | Promise<readonly ArgumentChoice[]>
}

export interface CommandImpl {
  run(args?: unknown): void | Promise<void>
  /**
   * Available now? Unavailable commands stay listed (disabled in menus, dimmed with their reason in the palette).
   * `args` is what a contextual menu runs it with (the row's session or project); without them, the active one.
   */
  when?(args?: unknown): boolean
  unavailableReason?(args?: unknown): string | undefined
  /**
   * Unavailable, it stays in its contextual menus, disabled with its reason, instead of being left out (the table rows
   * whose `surfaceNote` says "disabled with its reason …", such as Restore Deleted Session… in `project ⌃`).
   */
  keepInMenus?: boolean
  /** Which of the row's `titles` applies now (`Stop Dev Server` while one runs); anything else is ignored. */
  title?(args?: unknown): string | undefined
  /**
   * What the palette offers on the row while the command is unavailable ("Set a run command…" where there is no
   * `start.sh` and no run command): `↵` on the dimmed row runs it. Undefined: nothing to offer.
   */
  remedy?(args?: unknown): { label: string; run(): void } | undefined
  /**
   * The command needs an argument when the palette runs it with none: the palette lists the choices and runs the
   * command with the one picked. Undefined: it runs as it is.
   */
  argument?(): CommandArgument | undefined
}

export class CommandRegistry {
  private readonly impls = new Map<string, CommandImpl>() // bounded: one per command id in the table
  private readonly listeners = new Set<() => void>() // bounded: the menu sync and the palette
  /** The keys `keybindings.json` changed, for the menu bar (`bindings.svelte.ts` gives it). */
  private changedKeys: (() => Record<string, string | null>) | null = null

  /** Bind a handler to a table command. Returns its unregistration. */
  register(id: string, impl: CommandImpl): Disposable {
    if (!isCommandId(id)) throw new Error(`${id} is not in the command table (@kea/protocol COMMANDS)`)
    if (this.impls.has(id)) throw new Error(`${id} is already registered`)
    this.impls.set(id, impl)
    this.changed()
    return {
      dispose: () => {
        if (this.impls.get(id) !== impl) return
        this.impls.delete(id)
        this.changed()
      },
    }
  }

  /** Handlers registered (the resource report's `commandHandlers`). */
  get size(): number {
    return this.impls.size
  }

  /** A handler exists (the feature is built). */
  has(id: string): boolean {
    return this.impls.has(id)
  }

  /** A handler exists and its `when` allows it now (for `args`, when a contextual menu gives them). */
  available(id: string, args?: unknown): boolean {
    const c = this.impls.get(id)
    if (!c) return false
    try {
      return c.when?.(args) ?? true
    } catch {
      return false
    }
  }

  /** Listed in a contextual menu for `args`: available, or kept there disabled (`keepInMenus`). */
  inMenus(id: string, args?: unknown): boolean {
    return this.available(id, args) || this.impls.get(id)?.keepInMenus === true
  }

  /** Why the command cannot run now; undefined when it can. */
  reason(id: string, args?: unknown): string | undefined {
    if (!this.impls.has(id)) return commandById(id) ? 'Not available yet' : undefined
    if (this.available(id, args)) return undefined
    try {
      return this.impls.get(id)?.unavailableReason?.(args) ?? 'Not available here'
    } catch {
      return 'Not available here'
    }
  }

  /** The command's title now: the one of the row's `titles` its handler names, else the table's for this system. */
  title(id: string, args?: unknown): string {
    const def = commandById(id)
    if (!def) return id
    if (!def.titles) return systemTitle(def)
    try {
      const t = this.impls.get(id)?.title?.(args)
      return t !== undefined && def.titles.includes(t) ? t : commandTitle(def)
    } catch {
      return commandTitle(def)
    }
  }

  /** What the palette offers on an unavailable command's row; undefined when it is available or offers nothing. */
  remedy(id: string, args?: unknown): { label: string; run(): void } | undefined {
    if (this.available(id, args)) return undefined
    try {
      return this.impls.get(id)?.remedy?.(args)
    } catch {
      return undefined
    }
  }

  /** The argument an available command asks for in the palette; undefined when it runs as it is. */
  argument(id: string): CommandArgument | undefined {
    if (!this.available(id)) return undefined
    try {
      return this.impls.get(id)?.argument?.()
    } catch {
      return undefined
    }
  }

  /** Run if available; false when it was not. A failing handler never escapes (it is logged). */
  run(id: string, args?: unknown): boolean {
    const c = this.impls.get(id)
    if (!c || !this.available(id, args)) return false
    try {
      const r = c.run(args)
      if (r instanceof Promise) r.catch((e: unknown) => console.warn(`command ${id} failed`, e))
    } catch (e) {
      console.warn(`command ${id} failed`, e)
    }
    return true
  }

  /** Who says which keys `keybindings.json` changed: one source per window. */
  setChangedKeys(fn: (() => Record<string, string | null>) | null): void {
    this.changedKeys = fn
    this.changed()
  }

  /**
   * Registered commands with their availability and their title now, and the keys the person changed, for main's menu
   * bar (`kea:menuState`).
   */
  menuState(): MenuState {
    const keys = this.changedKeys?.() ?? {}
    return {
      commands: [...this.impls.keys()].map((id) => {
        const title = this.title(id)
        const def = commandById(id)
        return { id, enabled: this.available(id), ...(def && title !== commandTitle(def) ? { title } : {}) }
      }),
      ...(Object.keys(keys).length > 0 ? { keys } : {}),
    }
  }

  /** Something that availability depends on changed (call after state changes; listeners coalesce). */
  changed(): void {
    for (const l of [...this.listeners]) l()
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

/** The window's registry. */
export const commands = new CommandRegistry()
