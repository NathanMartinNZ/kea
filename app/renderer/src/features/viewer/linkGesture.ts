// The link gesture in a viewer document, as a reducer: the link modifier, the pointer's moves, a press and its release,
// the pointer leaving and the window's blur come in; what to underline, whether a press is the link's, and what a click
// does (open the link, offer to copy an address that is not opened, or open a file reference once core says it leads
// to a file) come out. A file reference whose answer is not known yet is never underlined and its press stays the
// document's, so a modifier-click on text that is no file still places the caret. It holds no view and no DOM:
// `linkView.ts` finds the link under the pointer and draws what this decides. Given the system, which says which flag
// is the link modifier (`⌘` on macOS, `Ctrl` on Linux, as `modClick` reads them).

import type { System } from '@kea/protocol'

/** The modifier flags a mouse or key event carries. */
export interface Flags {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * A link in document positions (`to` exclusive); `opens`: false for an address the link policy will not open;
 * `pending`: a file reference whose answer from core is not known yet.
 */
export interface GestureLink {
  from: number
  to: number
  opens: boolean
  pending?: boolean
}

export interface GestureState<T extends GestureLink> {
  /** The link modifier is held, as the last event said. */
  mod: boolean
  /** The link under the pointer, as the last move found it; null when there is none or the pointer is away. */
  over: T | null
  /**
   * A press on a link and where the button went down; `taken`: the link took it (the document never saw it), else it
   * is a file reference not known yet, whose press the document has.
   */
  press: { link: T; x: number; y: number; taken: boolean } | null
}

export type GestureEvent<T extends GestureLink> =
  | { kind: 'move'; x: number; y: number; flags: Flags; link: T | null }
  /** The modifier pressed or released while the pointer rests; `link` is what is under it now. */
  | { kind: 'key'; flags: Flags; link: T | null }
  | { kind: 'press'; x: number; y: number; button: number; detail: number; flags: Flags; link: T | null }
  | { kind: 'release'; x: number; y: number; button: number; link: T | null }
  /** The pointer left the document's text. */
  | { kind: 'leave' }
  /** `Esc` during a press. */
  | { kind: 'cancel' }
  /** The window lost the focus: nothing is held any more. */
  | { kind: 'blur' }

/**
 * What a click on a link does: open it; (an address that is not opened) the text menu with Copy Link alone, at the
 * pointer; or (a file reference not known at the press) open it if core's answer says it is a file.
 */
export type GestureEffect<T extends GestureLink> = { do: 'open'; link: T } | { do: 'menu'; link: T; x: number; y: number } | { do: 'late'; link: T }

export interface GestureStep<T extends GestureLink> {
  state: GestureState<T>
  /** The event is the link's: the document must not see it. */
  take: boolean
  effect: GestureEffect<T> | null
}

export function idleGesture<T extends GestureLink>(): GestureState<T> {
  return { mod: false, over: null, press: null }
}

/** The link modifier is down: `⌘` on macOS, `Ctrl` on Linux; the other flag is ignored. */
export function linkModifier(f: Flags, system: System): boolean {
  return system === 'darwin' ? f.metaKey : f.ctrlKey
}

export function sameLink(a: GestureLink | null, b: GestureLink | null): boolean {
  return a === b || (!!a && !!b && a.from === b.from && a.to === b.to)
}

/**
 * The link drawn underlined: the pressed one while a press it took lasts, else the one under the pointer while the
 * modifier is held. A file reference not known yet is never underlined.
 */
export function underlined<T extends GestureLink>(s: GestureState<T>): T | null {
  if (s.press) return s.press.taken ? s.press.link : null
  return s.mod && s.over && !s.over.pending ? s.over : null
}

const within = (p: { x: number; y: number }, x: number, y: number, slop: number): boolean => Math.hypot(x - p.x, y - p.y) <= slop

/**
 * One event of the gesture. A press is the link's only with the modifier, without `⌥` (cursors), with the left button,
 * as the first click of a series, on a link that is known (an address, or a file reference core said is a file); on
 * macOS a `⌃`-press is the text menu's and never the link's. `⇧` does not matter. The click is made when the button
 * comes up within `slop` px of the press over the same link. The same press on a file reference not known yet stays
 * the document's; its release within the slop over the same reference is a late click (`late`).
 */
export function stepGesture<T extends GestureLink>(s: GestureState<T>, e: GestureEvent<T>, system: System, slop: number): GestureStep<T> {
  const step = (state: GestureState<T>, take = false, effect: GestureEffect<T> | null = null): GestureStep<T> => ({ state, take, effect })
  switch (e.kind) {
    case 'move': {
      const press = s.press && within(s.press, e.x, e.y, slop) ? s.press : null
      return step({ mod: linkModifier(e.flags, system), over: e.link, press })
    }
    case 'key':
      return step({ ...s, mod: linkModifier(e.flags, system), over: e.link })
    case 'press': {
      const mod = linkModifier(e.flags, system)
      const menuClick = system === 'darwin' && e.flags.ctrlKey
      if (mod && !e.flags.altKey && !menuClick && e.button === 0 && e.detail === 1 && e.link) {
        const taken = !e.link.pending
        return step({ mod, over: e.link, press: { link: e.link, x: e.x, y: e.y, taken } }, taken)
      }
      return step({ mod, over: e.link, press: null })
    }
    case 'release': {
      const p = s.press
      if (!p || e.button !== 0) return step(s)
      const state = { ...s, over: e.link, press: null }
      const click = within(p, e.x, e.y, slop) && sameLink(e.link, p.link)
      if (!p.taken) return step(state, false, click ? { do: 'late', link: p.link } : null)
      if (!click) return step(state, true)
      return step(state, true, p.link.opens ? { do: 'open', link: p.link } : { do: 'menu', link: p.link, x: e.x, y: e.y })
    }
    case 'leave':
      return step({ ...s, over: null })
    case 'cancel':
      return step({ ...s, press: null })
    case 'blur':
      return step(idleGesture<T>())
  }
}
