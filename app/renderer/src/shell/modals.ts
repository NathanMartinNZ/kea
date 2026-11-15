// The window's modals: every confirmation and Settings (SheetFrame.svelte) is drawn centred over the whole window in
// one host, on one backdrop, and nothing behind it takes a pointer, a key or a command until it closes. This keeps the
// open modals (newest last, the only one that takes input), the window's parts behind them, which are `inert` while
// the host is open, and the holds: a sequence of questions (a review's, Settings › Disk's actions) holds the backdrop
// between its steps, so the window neither flashes nor fades in again and the keyboard does not visit it in between.
// The window wires it to the page (`installModals`, App.svelte); the command gate reads the top (modalGate.ts).

/** The class the window's root carries while the host is open: headers stop dragging the window (window.css). */
export const MODAL_OPEN_CLASS = 'kea-modal-open'

/** Settings, or any other modal (a confirmation, a list, a log). */
export type ModalKind = 'settings' | 'confirm'

/** An element the keyboard can go back to. */
export interface FocusTarget {
  readonly isConnected: boolean
  focus(options?: FocusOptions): void
}

/** A part of the window behind the modals, or a modal's layer: `inert` while covered. */
export interface Coverable {
  inert: boolean
}

/** A modal's layer: covered by a newer one; where its default control is. */
export interface ModalLayer extends Coverable {
  contains(node: unknown): boolean
  querySelector(selector: string): FocusTarget | null
}

/** What the registry needs of the page. */
export interface ModalPage {
  /** The window's root, which carries `MODAL_OPEN_CLASS`. */
  readonly root: { classList: { toggle(name: string, force: boolean): void } }
  /** Where the window's keys arrive (Esc that nothing handled reaches the top modal). */
  readonly keys: { addEventListener(type: 'keydown', l: (e: KeyboardEvent) => void): void; removeEventListener(type: 'keydown', l: (e: KeyboardEvent) => void): void }
  /** The element with the keyboard now. */
  active(): FocusTarget | null
  /** A modal opens: what floats above the window closes (menus, the palette, the session popover). */
  opening(): void
  /** The host opens (it fades in as it appears) or closes. */
  shown(open: boolean): void
  /** A modal opened or closed: what reads the top (the command gate, the menu bar) looks again. */
  changed(): void
}

interface Modal {
  readonly kind: ModalKind
  readonly layer: ModalLayer
  readonly cancel: () => void
  /** Where the keyboard goes back to when it closes. */
  readonly before: FocusTarget | null
}

/** The control a modal gives the keyboard to (its safe default), else the box (`tabindex="-1"`). */
const DEFAULT_CONTROL = '[data-default]'
const BOX = '[aria-modal="true"]'

export class Modals {
  private readonly stack: Modal[] = [] // bounded: one per kind of sheet open at once (the window has 14)
  private readonly holds = new Set<{ cancel: () => void; release: () => void }>() // bounded: one per sequence running (a review, Settings › Disk's actions)
  private readonly covered = new Set<Coverable>() // bounded: the window's columns, its dividers, its toast and HUD layers
  /** Where the keyboard goes back to when the last hold ends: taken as the first one begins. */
  private holdReturn: FocusTarget | null = null
  private isShown = false
  private page: ModalPage | null = null
  /** The element the modals' layers draw in (App.svelte's `.modal-host`). */
  host: HTMLElement | null = null

  private readonly onKey = (e: KeyboardEvent): void => {
    // an Esc a modal's own controls or a menu over it did not handle (the keyboard on `body`, after a button disabled
    // itself); not while an input method composes, whose Esc ends the composition
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
    const top = this.stack.at(-1)
    e.preventDefault()
    // between a sequence's steps (a save still running), Esc ends the sequence and its backdrop
    if (top) top.cancel()
    else this.cancelAll()
  }

  /** The page this registry draws on (once per window). */
  install(page: ModalPage | null): void {
    this.page = page
  }

  /** A modal or a hold is on: the backdrop is drawn and the window behind it takes nothing. */
  get open(): boolean {
    return this.stack.length > 0 || this.holds.size > 0
  }

  /** The top modal's kind; null with none open (a hold between its steps). */
  get top(): ModalKind | null {
    return this.stack.at(-1)?.kind ?? null
  }

  /** Open modals and holds (the resource report's `modals`). */
  get count(): number {
    return this.stack.length + this.holds.size
  }

  /** A part of the window behind the modals (an attachment's body): `inert` at once while the host is open. */
  cover(el: Coverable): () => void {
    this.covered.add(el)
    if (this.isShown) el.inert = true
    return () => {
      this.covered.delete(el)
      el.inert = false
    }
  }

  /**
   * A modal opened: `layer` is drawn in the host, `cancel` is its Esc, `before` where the keyboard was. Returns its
   * closing, which gives the keyboard back unless a hold is on or a modal under it is still open elsewhere.
   */
  opened(kind: ModalKind, layer: ModalLayer, cancel: () => void, before: FocusTarget | null): () => void {
    const m: Modal = { kind, layer, cancel, before: this.holds.size > 0 ? this.holdReturn : before }
    this.page?.opening()
    for (const under of this.stack) under.layer.inert = true
    this.stack.push(m)
    this.show()
    this.page?.changed()
    return () => this.closed(m)
  }

  /**
   * A sequence of modals begins: until the returned release, the backdrop stays between its steps, no step fades in
   * and none gives the keyboard back. `cancel` ends the sequence (a session shown from outside, Esc between steps),
   * which also releases it. The keyboard goes back, at the last release, to where it was before the sequence's first
   * modal.
   */
  hold(cancel: () => void): () => void {
    const release = (): void => {
      if (!this.holds.delete(h) || this.holds.size > 0) return
      const back = this.holdReturn
      this.holdReturn = null
      // a modal still open keeps the keyboard (Settings back on Disk)
      if (this.stack.length > 0) return
      this.hide()
      if (back?.isConnected) back.focus({ preventScroll: true })
      this.page?.changed()
    }
    const h = { cancel, release }
    if (this.holds.size === 0) this.holdReturn = this.stack.at(-1)?.before ?? this.page?.active() ?? null
    this.holds.add(h)
    this.show()
    return release
  }

  /** Cancel everything open: the holds first, so a sequence knows before its step answers, then each modal, top down. */
  cancelAll(): void {
    for (const h of [...this.holds]) {
      h.cancel()
      h.release()
    }
    for (const m of [...this.stack].reverse()) m.cancel()
  }

  private closed(m: Modal): void {
    const i = this.stack.indexOf(m)
    if (i < 0) return
    const wasTop = i === this.stack.length - 1
    this.stack.splice(i, 1)
    const top = this.stack.at(-1)
    if (top) top.layer.inert = false
    if (!this.open) this.hide()
    // the keyboard goes back once nothing covers its place: the backdrop gone, or into the modal now on top
    if (this.holds.size === 0 && wasTop) {
      const back = m.before
      if (!top) {
        if (back?.isConnected) back.focus({ preventScroll: true })
      } else if (back?.isConnected && top.layer.contains(back)) back.focus({ preventScroll: true })
      else (top.layer.querySelector(DEFAULT_CONTROL) ?? top.layer.querySelector(BOX))?.focus({ preventScroll: true })
    }
    this.page?.changed()
  }

  private show(): void {
    if (this.isShown) return
    this.isShown = true
    for (const el of this.covered) el.inert = true
    this.page?.root.classList.toggle(MODAL_OPEN_CLASS, true)
    this.page?.keys.addEventListener('keydown', this.onKey)
    this.page?.shown(true)
  }

  private hide(): void {
    if (!this.isShown) return
    this.isShown = false
    // `inert` comes off before the keyboard goes back: focus() on an inert element does nothing
    for (const el of this.covered) el.inert = false
    this.page?.root.classList.toggle(MODAL_OPEN_CLASS, false)
    this.page?.keys.removeEventListener('keydown', this.onKey)
    this.page?.shown(false)
  }
}

/** The window's modals. */
export const modals = new Modals()
