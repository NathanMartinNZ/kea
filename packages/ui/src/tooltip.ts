// The tooltip as logic: when it shows, where it goes and what it says. `Tooltip.svelte` is the one element;
// nothing here touches the DOM, so the timing is unit-tested with fake timers.
//
// A control says it has a tooltip with attributes, not with a listener of its own:
//
//   data-tip="Add project"            the text
//   data-command="session.new"        on a button: the command it runs. The tooltip names the command's key,
//                                     and its title where there is no `data-tip`
//   data-tip-key="⇧↵"                 a key that is not a command's (a find bar's, a field's): shown as the key chip
//
// One delay for the window (`--motion-tooltip-delay`), on one timer: the pointer resting on a control, or the keyboard
// arriving on one, starts it; leaving, pressing a key or a button, or scrolling ends it and hides what shows.

/** What a tooltip says: its text and, where its control runs a command that has one, the key now. */
export interface Tip {
  text: string
  shortcut?: string
}

export interface TipTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** The window's one tooltip delay: at most one target waits or shows at a time, on at most one timer. */
export class TooltipDelay<T> {
  private readonly o: { delayMs(): number; show(target: T): void; hide(): void; timers: TipTimers }
  private target: T | null = null
  private timer: unknown = null
  private visible = false

  constructor(o: { delayMs(): number; show(target: T): void; hide(): void; timers: TipTimers }) {
    this.o = o
  }

  /** The pointer or the keyboard is on a control that has a tip. The same control again changes nothing. */
  enter(target: T): void {
    if (this.target === target) return
    this.leave()
    this.target = target
    this.timer = this.o.timers.set(() => {
      this.timer = null
      if (this.target !== target) return
      this.visible = true
      this.o.show(target)
    }, this.o.delayMs())
  }

  /** It left, or something was pressed: nothing waits and nothing shows. */
  leave(): void {
    if (this.timer !== null) {
      this.o.timers.clear(this.timer)
      this.timer = null
    }
    this.target = null
    if (this.visible) {
      this.visible = false
      this.o.hide()
    }
  }

  /** The control the delay is on, waiting or showing. */
  get current(): T | null {
    return this.target
  }

  /** Timers waiting: 0 or 1. */
  get waiting(): number {
    return this.timer === null ? 0 : 1
  }

  get showing(): boolean {
    return this.visible
  }
}

/** A CSS duration as milliseconds (`500ms`, `0.5s`); null for anything else. */
export function cssDurationMs(text: string): number | null {
  const m = /^\s*(\d*\.?\d+)(ms|s)\s*$/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return m[2] === 's' ? n * 1000 : n
}

/**
 * What a control's tooltip says, from its attributes: `tip` is its `data-tip`, `command` its `data-command`, `resolve`
 * the window's answer for a command (its title and key now). Null: it has nothing to say.
 */
export function tipOf(a: { tip: string | null; command: string | null; key?: string | null }, resolve: (command: string) => { title: string; shortcut?: string | undefined } | undefined): Tip | null {
  const cmd = a.command ? resolve(a.command) : undefined
  const text = a.tip || cmd?.title || ''
  if (text === '') return null
  // a command's key now comes first: `data-tip-key` is for a control whose key no command owns
  const shortcut = cmd?.shortcut ?? (a.key || undefined)
  return { text, ...(shortcut ? { shortcut } : {}) }
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the tooltip goes: centred under its control, `gap` away; above it when there is no room below; never past an
 * edge of the window (`gap` kept from each).
 */
export function tipPlace(anchor: Box, tip: { width: number; height: number }, view: { width: number; height: number }, gap: number): { left: number; top: number } {
  const centred = anchor.left + anchor.width / 2 - tip.width / 2
  const left = Math.max(gap, Math.min(centred, view.width - tip.width - gap))
  const below = anchor.top + anchor.height + gap
  const top = below + tip.height + gap <= view.height ? below : Math.max(gap, anchor.top - gap - tip.height)
  return { left: Math.round(left), top: Math.round(top) }
}
