// The link layer of a viewer document: a CodeMirror view plugin that finds the web address under the pointer while the
// link modifier is held, underlines it (its own decoration, never the document's state, so no state kept by the tab
// cache or the unsaved registry comes back underlined), takes a modifier press on it from the document and opens the
// address when the button comes up near it. The gesture's rules are `linkGesture.ts`'s, the finding `links.ts`'s.
//
// It reaches the window only through its owner's hooks (`LinkHooks`, which `editor.ts`'s `EditorHooks` carry): opening
// an address, the text menu and the tip. A press follows the pointer with listeners on the document from the press to
// its release. One tracker for the window (`watchLinkModifier`, made by the viewer's commands) passes on the modifier
// pressed or released while the pointer rests, and the window's blur; nothing here touches the window when it loads.

import { Annotation, Facet, Prec, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { protocolOs } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import type { TextLink } from '../commands/textMenu.ts'
import { idleGesture, linkModifier, sameLink, stepGesture, underlined, type Flags, type GestureEvent, type GestureLink, type GestureState, type GestureStep } from './linkGesture.ts'
import { linkTipWords, scanWindow, urlAt, type FoundUrl } from './links.ts'

/** What a document is, for its links: its session (none outside one), its path, its language id and which side it is. */
export interface LinkContext {
  sessionId: string | null
  path: string
  lang: string | null
  side: 'file' | 'new' | 'old'
}

/** The document's context, set by `fileState` and the diff's sides. */
export const linkContext = Facet.define<LinkContext, LinkContext | null>({ combine: (v) => v[0] ?? null })

/** The tip of the link under the pointer: its words and where the pointer was; `key` changes with the link, so the tip is drawn anew (and its delay starts again). */
export interface LinkTip {
  target: string
  action: string
  x: number
  y: number
  key: string
}

/** What the layer asks of the document's owner. Each is optional: a document with no owner has links that do nothing. */
export interface LinkHooks {
  /** Open a web address the link policy allows. */
  openLink?(url: string): void
  /** The text menu with a link's items alone, at a point, for the document `el` is in. */
  linkMenu?(el: Element, at: { x: number; y: number }, link: TextLink): void
  /** Show the tip, or hide it (null). */
  linkTip?(tip: LinkTip | null): void
}

/** A web address in document positions. */
export interface DocLink extends FoundUrl, GestureLink {}

/** An empty transaction that only redraws the underline. */
const linkHover = Annotation.define<true>()
const MARK = Decoration.mark({ class: 'cm-link-active' })
const point = (x: number, y: number) => ({ x, y })

/** The web address that covers `pos` (the character after it) in `state`, reading only the line's part around it. */
export function linkAt(state: EditorState, pos: number): DocLink | null {
  if (pos < 0 || pos >= state.doc.length) return null
  const line = state.doc.lineAt(pos)
  const w = scanWindow(line.from, line.to, pos)
  const u = urlAt({ text: state.doc.sliceString(w.from, w.to), cutStart: w.from > line.from, cutEnd: w.to < line.to }, pos - w.from)
  return u ? { ...u, from: w.from + u.from, to: w.from + u.to, opens: u.action.open } : null
}

/** The address that holds the main cursor or ends at it: what Follow Link and the keyboard's menu act on. */
export function linkAtCursor(state: EditorState): DocLink | null {
  const head = state.selection.main.head
  return linkAt(state, head) ?? (head > state.doc.lineAt(head).from ? linkAt(state, head - 1) : null)
}

/** A link as the text menu takes it. */
export function textLinkOf(l: DocLink): TextLink {
  return { kind: 'url', text: l.text, url: l.action.open ? l.action.url : null }
}

/** The elements of a line that are not its text: the unified diff's removed lines, a fold's `⋯`, a collapsed region. */
const NOT_TEXT = '.cm-deletedChunk, .cm-foldPlaceholder, .cm-collapsedLines, .cm-widgetBuffer'

/**
 * The address under the point `(x, y)` in `view`, `el` being the element there: only over a line's text, the character
 * whose box holds the point (so the space right of a line's end is on nothing).
 */
export function linkAtPoint(view: EditorView, x: number, y: number, el: Element | null): DocLink | null {
  if (!el || !view.contentDOM.contains(el) || !el.closest('.cm-line') || el.closest(NOT_TEXT)) return null
  const pos = view.posAtCoords({ x, y })
  if (pos === null) return null
  for (const c of [pos, pos - 1]) {
    if (c < 0 || c >= view.state.doc.length) continue
    const r = view.coordsForChar(c)
    if (r && x >= r.left && x < r.right && y >= r.top && y < r.bottom) return linkAt(view.state, c)
  }
  return null
}

/** Where a menu for the main cursor opens: under it, or at the text's top left while it is out of view. */
export function cursorPoint(view: EditorView): { x: number; y: number } {
  const r = view.coordsAtPos(view.state.selection.main.head)
  if (r) return point(r.left, r.bottom)
  const box = view.scrollDOM.getBoundingClientRect()
  return point(box.left, box.top)
}

const flagsOf = (e: MouseEvent | KeyboardEvent): Flags => ({ metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey })
const elementOf = (t: EventTarget | null): Element | null => (t instanceof Element ? t : null)

// bounded: the viewer's documents on screen, at most three (the file view, and a diff's one or two sides)
const layers = new Set<LinkLayer>()

class LinkLayer {
  deco: DecorationSet = Decoration.none
  private readonly view: EditorView
  private readonly hooks: () => LinkHooks | null
  private g: GestureState<DocLink> = idleGesture<DocLink>()
  /** The pointer's last place over the text, so a modifier pressed while it rests finds what is under it. */
  private at: { x: number; y: number } | null = null
  /** The link drawn now, and the tip out for it (its key). */
  private shown: DocLink | null = null
  private tipOut = false
  private tipKey: string | null = null
  private gone = false
  /** Ends a press's listeners on the document. */
  private endPress: (() => void) | null = null

  constructor(view: EditorView, hooks: () => LinkHooks | null) {
    this.view = view
    this.hooks = hooks
    layers.add(this)
  }

  update(u: ViewUpdate): void {
    if (!u.docChanged) return
    // positions moved: what was found goes, and a press ends (drawn at the next move)
    this.stopListening()
    this.g = { ...this.g, over: null, press: null }
    this.shown = null
    this.deco = Decoration.none
    this.tip(null)
  }

  destroy(): void {
    this.gone = true
    layers.delete(this)
    this.stopListening()
    this.tip(null)
  }

  private linkUnder(x: number, y: number, el: Element | null): DocLink | null {
    return linkAtPoint(this.view, x, y, el)
  }

  /** What is under the resting pointer now (the text may have scrolled under it). */
  private linkAtRest(): DocLink | null {
    const at = this.at
    if (!at) return null
    return this.linkUnder(at.x, at.y, this.view.root.elementFromPoint(at.x, at.y))
  }

  private step(e: GestureEvent<DocLink>): GestureStep<DocLink> {
    const s = stepGesture(this.g, e, protocolOs.system, L.viewerLinkClickSlopPx)
    this.g = s.state
    const u = underlined(this.g)
    if (!sameLink(u, this.shown)) {
      this.shown = u
      this.deco = u ? Decoration.set([MARK.range(u.from, u.to)]) : Decoration.none
      // a plugin's decorations are read in a view update; none is made while an input method composes
      if (!this.view.composing) this.view.dispatch({ annotations: linkHover.of(true) })
    }
    this.tip(u && !this.g.press ? u : null)
    if (s.effect?.do === 'open' && s.effect.link.action.open) this.hooks()?.openLink?.(s.effect.link.action.url)
    else if (s.effect?.do === 'menu') this.hooks()?.linkMenu?.(this.view.contentDOM, point(s.effect.x, s.effect.y), textLinkOf(s.effect.link))
    return s
  }

  private tip(l: DocLink | null): void {
    const key = l ? `${l.from}:${l.to}:${l.text}` : null
    if (!l || !this.at) {
      if (this.tipOut) this.hooks()?.linkTip?.(null)
      this.tipOut = false
      this.tipKey = null
      return
    }
    if (key === this.tipKey) return
    this.tipKey = key
    this.tipOut = true
    this.hooks()?.linkTip?.({ ...linkTipWords(l, protocolOs.system), x: this.at.x, y: this.at.y, key: key as string })
  }

  move(e: MouseEvent): void {
    // a press follows the pointer from the document
    if (this.g.press) return
    this.at = point(e.clientX, e.clientY)
    const flags = flagsOf(e)
    // without the modifier nothing is looked for
    const link = linkModifier(flags, protocolOs.system) ? this.linkUnder(e.clientX, e.clientY, elementOf(e.target)) : null
    this.step({ kind: 'move', x: e.clientX, y: e.clientY, flags, link })
  }

  leave(): void {
    if (this.g.press) return
    this.at = null
    this.step({ kind: 'leave' })
  }

  /** A press: true when it is the link's, which the document then never sees. */
  press(e: MouseEvent): boolean {
    const flags = flagsOf(e)
    const link = linkModifier(flags, protocolOs.system) ? this.linkUnder(e.clientX, e.clientY, elementOf(e.target)) : null
    this.at = point(e.clientX, e.clientY)
    const s = this.step({ kind: 'press', x: e.clientX, y: e.clientY, button: e.button, detail: e.detail, flags, link })
    if (!s.take) return false
    e.preventDefault()
    this.listen()
    return true
  }

  /** The modifier pressed or released, from the window's tracker. */
  key(e: KeyboardEvent): void {
    if (!this.at || this.g.press) return
    const flags = flagsOf(e)
    if (linkModifier(flags, protocolOs.system) === this.g.mod) return
    this.step({ kind: 'key', flags, link: linkModifier(flags, protocolOs.system) ? this.linkAtRest() : null })
  }

  /** The text scrolled under a resting pointer: looked at again once the scroll's own handling is over. */
  scrolled(): void {
    if (!this.at || !this.g.mod || this.g.press) return
    queueMicrotask(() => {
      if (!this.gone && this.at && this.g.mod && !this.g.press) this.step({ kind: 'key', flags: this.modFlags(), link: this.linkAtRest() })
    })
  }

  blur(): void {
    this.stopListening()
    this.step({ kind: 'blur' })
  }

  /** Flags that say the modifier is still held. */
  private modFlags(): Flags {
    const darwin = protocolOs.system === 'darwin'
    return { metaKey: darwin, ctrlKey: !darwin, altKey: false, shiftKey: false }
  }

  /** From the press to its release: the pointer's moves and release, and `Esc`, on the document. */
  private listen(): void {
    this.stopListening()
    const doc = this.view.dom.ownerDocument
    const move = (e: MouseEvent): void => {
      const flags = flagsOf(e)
      this.at = point(e.clientX, e.clientY)
      this.step({ kind: 'move', x: e.clientX, y: e.clientY, flags, link: linkModifier(flags, protocolOs.system) ? this.linkUnder(e.clientX, e.clientY, elementOf(e.target)) : null })
      if (!this.g.press) this.stopListening()
    }
    const up = (e: MouseEvent): void => {
      if (e.button !== 0) return
      this.stopListening()
      this.step({ kind: 'release', x: e.clientX, y: e.clientY, button: e.button, link: this.linkUnder(e.clientX, e.clientY, elementOf(e.target)) })
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      this.stopListening()
      this.step({ kind: 'cancel' })
    }
    doc.addEventListener('mousemove', move, true)
    doc.addEventListener('mouseup', up, true)
    doc.addEventListener('keydown', key, true)
    this.endPress = () => {
      doc.removeEventListener('mousemove', move, true)
      doc.removeEventListener('mouseup', up, true)
      doc.removeEventListener('keydown', key, true)
    }
  }

  private stopListening(): void {
    this.endPress?.()
    this.endPress = null
  }
}

/**
 * The link layer, for every text document of the viewer. Of the highest precedence: its press is looked at before the
 * document's own, and its underline is the innermost mark, so it is drawn in each token's own colour.
 */
export function linkLayer(hooks: () => LinkHooks | null): Extension {
  return Prec.highest(
    ViewPlugin.define((view) => new LinkLayer(view, hooks), {
      decorations: (p) => p.deco,
      eventHandlers: {
        mousemove(e) {
          this.move(e)
        },
        mouseleave() {
          this.leave()
        },
        mousedown(e) {
          return this.press(e)
        },
        scroll() {
          this.scrolled()
        },
      },
    }),
  )
}

/**
 * The window's tracker of the link modifier (one per window, from the viewer's commands): a press or release of a key
 * while the pointer rests, and the window's blur, reach every document's layer. The result removes its listeners.
 */
export function watchLinkModifier(win: Window): () => void {
  const key = (e: KeyboardEvent): void => {
    for (const l of [...layers]) l.key(e)
  }
  const blur = (): void => {
    for (const l of [...layers]) l.blur()
  }
  win.addEventListener('keydown', key, true)
  win.addEventListener('keyup', key, true)
  win.addEventListener('blur', blur)
  return () => {
    win.removeEventListener('keydown', key, true)
    win.removeEventListener('keyup', key, true)
    win.removeEventListener('blur', blur)
  }
}
