// Plain Ctrl+C in a terminal on Linux, beside the key router's rule (`ctrlKeyRole`, `copyHintDue`): which selection
// is the person's, when a copy made by that key clears it, and the one-time hint shown while the key still interrupts.
// Pure, so the view and the router's installer only wire them.

/** Where a selection lies (xterm's `getSelectionPosition()`), or none. */
export interface SelectionPos {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

/** A selection's place as one comparable value; null for none. */
export function selectionKey(pos: SelectionPos | undefined): string | null {
  return pos ? `${pos.start.y}:${pos.start.x}-${pos.end.y}:${pos.end.x}` : null
}

/**
 * Whether the selection is the person's: there is one, and it is not where the find bar's last search left its match
 * (`findKey`). The find bar keeps its match selected for whoever finds and then copies with Ctrl+Shift+C; plain Ctrl+C
 * over it interrupts.
 */
export function isUserSelection(has: boolean, key: string | null, findKey: string | null): boolean {
  return has && key !== null && key !== findKey
}

/**
 * The selection goes once a copy made by plain Ctrl+C has run, so the next Ctrl+C interrupts (the key was Kea's, so
 * xterm does not clear it). Armed by the router, spent by the terminal's own copy event (xterm fills the clipboard
 * first), dropped when the selection changes before that event comes.
 */
export class ClearOnCopy {
  private armed = false

  arm(): void {
    this.armed = true
  }

  /** The terminal's copy event ran: true when the selection is to be cleared now. */
  copied(): boolean {
    const was = this.armed
    this.armed = false
    return was
  }

  /** The selection changed or went: a copy armed for the old one clears nothing. */
  selectionChanged(): void {
    this.armed = false
  }

  get isArmed(): boolean {
    return this.armed
  }
}

/**
 * The one-time hint: the first time its moment comes in a window, core is asked whether this KEA_HOME has seen it;
 * it shows when core says this is the first time. A window asks at most once.
 */
export class CopyHint {
  private asked = false
  private readonly ask: () => Promise<boolean>
  private readonly show: () => void

  constructor(ask: () => Promise<boolean>, show: () => void) {
    this.ask = ask
    this.show = show
  }

  /** The moment came (Ctrl+C over the person's selection, the key still interrupting). Settles once it is decided. */
  due(): Promise<void> {
    if (this.asked) return Promise.resolve()
    this.asked = true
    return this.ask().then(
      (first) => {
        if (first) this.show()
      },
      (e: unknown) => console.warn('copy hint not asked', e),
    )
  }
}
