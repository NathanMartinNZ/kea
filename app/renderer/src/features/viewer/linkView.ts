// The link layer of a viewer document: a CodeMirror view plugin that finds the web address or the file reference under
// the pointer while the link modifier is held, underlines it (its own decoration, never the document's state, so no
// state kept by the tab cache or the unsaved registry comes back underlined), takes a modifier press on it from the
// document and opens it when the button comes up near it. The gesture's rules are `linkGesture.ts`'s, the finding
// `links.ts`'s and `fileRefs.ts`'s.
//
// A file reference is a link only once core has said it leads to a file: the layer asks (the references of the slice
// around the pointer, at once) and underlines it when the answer comes, if the pointer is still there and the text has
// not changed since it asked. Its press is taken only when the answer is already known; otherwise the document has the
// press, and a release over the same reference opens it if the answer that comes says it is a file, within
// L.viewerLinkListBudgetMs of the release. References are found only in a document of a session, and not on a diff's
// old side (its files are what was).
//
// It reaches the window only through its owner's hooks (`LinkHooks`, which `editor.ts`'s `EditorHooks` carry): opening
// an address or a file, core's answers, the text menu and the tip. A press follows the pointer with listeners on the
// document from the press to its release. One tracker for the window (`watchLinkModifier`, made by the viewer's
// commands) passes on the modifier pressed or released while the pointer rests, and the window's blur; nothing here
// touches the window when it loads.

import { Annotation, Facet, Prec, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { protocolOs, type RefAnswer, type RefFile } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import type { TextLink } from '../commands/textMenu.ts'
import { refsAround, refsIn, targetText, type FoundRef } from './fileRefs.ts'
import { idleGesture, linkModifier, sameLink, stepGesture, underlined, type Flags, type GestureEvent, type GestureLink, type GestureState, type GestureStep } from './linkGesture.ts'
import { clickWords, linkTipWords, scanWindow, urlAt, type FoundUrl, type LineSlice } from './links.ts'

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

/** The document a file reference is in: its session and its path in the worktree. */
export interface RefDoc {
  sessionId: string
  path: string
}

/** What the layer asks of the document's owner. Each is optional: a document with no owner has links that do nothing. */
export interface LinkHooks {
  /** Open a web address the link policy allows. */
  openLink?(url: string): void
  /** The text menu with a link's items alone, at a point, for the document `el` is in. */
  linkMenu?(el: Element, at: { x: number; y: number }, link: TextLink): void
  /** Show the tip, or hide it (null). */
  linkTip?(tip: LinkTip | null): void
  /** Core's answer for a file reference of `doc`, while it is remembered: its file, null (none), or undefined (not known). */
  refAnswer?(doc: RefDoc, ref: FoundRef): RefFile | null | undefined
  /** Ask core about references of `doc` (those not known and not asked already); one answer each, undefined for one not asked. */
  askRefs?(doc: RefDoc, refs: FoundRef[]): Promise<(RefAnswer | undefined)[]>
  /** Open a reference's file in the viewer, from `doc`. */
  openRef?(doc: RefDoc, target: RefFile): void
}

/** A web address in document positions. */
export interface DocUrl extends FoundUrl, GestureLink {
  kind: 'url'
}

/**
 * A file reference in document positions, with core's answer: its file, null (known to lead to none), or undefined
 * (not known yet: `pending`, never underlined). `refs`: the references of the slice it was found in, for one question.
 */
export interface DocFile extends GestureLink {
  kind: 'file'
  text: string
  ref: FoundRef
  refs: readonly FoundRef[]
  answer: RefFile | null | undefined
}

export type DocLink = DocUrl | DocFile

/** Core's answers for a document's file references, as the layer reads them. */
export type RefLookup = (ref: FoundRef) => RefFile | null | undefined
const UNKNOWN: RefLookup = () => undefined

/** An empty transaction that only redraws the underline. */
const linkHover = Annotation.define<true>()
const MARK = Decoration.mark({ class: 'cm-link-active' })
const point = (x: number, y: number) => ({ x, y })

/** The part of the line around `pos` the links are looked for in, and where it starts in the document. */
function sliceAt(state: EditorState, pos: number): { slice: LineSlice; at: number } {
  const line = state.doc.lineAt(pos)
  const w = scanWindow(line.from, line.to, pos)
  return { slice: { text: state.doc.sliceString(w.from, w.to), cutStart: w.from > line.from, cutEnd: w.to < line.to }, at: w.from }
}

/** The web address that covers `pos` (the character after it) in `state`, reading only the line's part around it. */
export function linkAt(state: EditorState, pos: number): DocUrl | null {
  if (pos < 0 || pos >= state.doc.length) return null
  const { slice, at } = sliceAt(state, pos)
  const u = urlAt(slice, pos - at)
  return u ? { ...u, kind: 'url', from: at + u.from, to: at + u.to, opens: u.action.open } : null
}

/** The document `state` is, for its file references: none outside a session, and none on a diff's old side. */
export function refDocOf(state: EditorState): RefDoc | null {
  const c = state.facet(linkContext)
  return c && c.sessionId !== null && c.side !== 'old' ? { sessionId: c.sessionId, path: c.path } : null
}

/** The file reference that covers `pos` in `state`, with what `answer` says of it; null where there is none. */
export function refLinkAt(state: EditorState, pos: number, answer: RefLookup = UNKNOWN): DocFile | null {
  if (pos < 0 || pos >= state.doc.length) return null
  const c = state.facet(linkContext)
  if (!refDocOf(state) || !c) return null
  const { slice, at } = sliceAt(state, pos)
  const refs = refsIn(slice, { lang: c.lang, path: c.path }).map((r) => ({ ...r, from: at + r.from, to: at + r.to }))
  const ref = refs.find((r) => pos >= r.from && pos < r.to)
  if (!ref) return null
  const a = answer(ref)
  return { kind: 'file', from: ref.from, to: ref.to, text: ref.text, ref, refs, answer: a, opens: !!a, ...(a === undefined ? { pending: true } : {}) }
}

/** The address, else the file reference, that covers `pos`. */
export function anyLinkAt(state: EditorState, pos: number, answer: RefLookup = UNKNOWN): DocLink | null {
  return linkAt(state, pos) ?? refLinkAt(state, pos, answer)
}

/**
 * The address or file reference that holds the main cursor or ends at it: what Follow Link and the keyboard's menu act
 * on. A reference is given whatever is known of it (none included: Follow Link then says so).
 */
export function linkAtCursor(state: EditorState, answer: RefLookup = UNKNOWN): DocLink | null {
  const head = state.selection.main.head
  return anyLinkAt(state, head, answer) ?? (head > state.doc.lineAt(head).from ? anyLinkAt(state, head - 1, answer) : null)
}

/** A link as the text menu takes it: an address, or a file reference with its answer (pending while it is out). */
export function textLinkOf(l: DocLink): TextLink {
  if (l.kind === 'url') return { kind: 'url', text: l.text, url: l.action.open ? l.action.url : null }
  return { kind: 'file', text: l.text, answer: l.answer === undefined ? 'pending' : l.answer === null ? 'none' : l.answer }
}

/** The elements of a line that are not its text: the unified diff's removed lines, a fold's `⋯`, a collapsed region. */
const NOT_TEXT = '.cm-deletedChunk, .cm-foldPlaceholder, .cm-collapsedLines, .cm-widgetBuffer'

/** The character under the point `(x, y)` in `view`, `el` being the element there: only over a line's text. */
function charAtPoint(view: EditorView, x: number, y: number, el: Element | null): number | null {
  if (!el || !view.contentDOM.contains(el) || !el.closest('.cm-line') || el.closest(NOT_TEXT)) return null
  const pos = view.posAtCoords({ x, y })
  if (pos === null) return null
  for (const c of [pos, pos - 1]) {
    if (c < 0 || c >= view.state.doc.length) continue
    const r = view.coordsForChar(c)
    if (r && x >= r.left && x < r.right && y >= r.top && y < r.bottom) return c
  }
  return null
}

/**
 * The address or file reference under the point `(x, y)` in `view`, `el` being the element there: only over a line's
 * text, the character whose box holds the point (so the space right of a line's end is on nothing). A reference
 * carries what core answered for it, as far as the window remembers.
 */
export function linkAtPoint(view: EditorView, x: number, y: number, el: Element | null): DocLink | null {
  const c = charAtPoint(view, x, y, el)
  return c === null ? null : anyLinkAt(view.state, c, layerOf(view)?.lookup ?? UNKNOWN)
}

/** The link at the main cursor of `view`, with what the window remembers of a reference's answer. */
export function cursorLink(view: EditorView): DocLink | null {
  return linkAtCursor(view.state, layerOf(view)?.lookup ?? UNKNOWN)
}

/** Ask core about a file reference of `view` (with its slice's others): its answer, or undefined when it was not asked. */
export async function askRef(view: EditorView, link: DocFile): Promise<RefAnswer | undefined> {
  return (await layerOf(view)?.ask(link))?.[0]
}

/** Open a reference's file from `view`'s document, as its click does. */
export function openRef(view: EditorView, target: RefFile): void {
  layerOf(view)?.openFile(target)
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

function layerOf(view: EditorView): LinkLayer | undefined {
  for (const l of layers) if (l.view === view) return l
  return undefined
}

class LinkLayer {
  deco: DecorationSet = Decoration.none
  readonly view: EditorView
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

  /** What the window remembers of core's answer for a reference of this document. */
  readonly lookup: RefLookup = (ref) => {
    const doc = refDocOf(this.view.state)
    return doc ? this.hooks()?.refAnswer?.(doc, ref) : undefined
  }

  /** Ask core about `link` and the references of its slice, the one under the pointer first. */
  ask(link: DocFile): Promise<(RefAnswer | undefined)[]> | undefined {
    const doc = refDocOf(this.view.state)
    const ask = this.hooks()?.askRefs
    return doc && ask ? ask(doc, refsAround(link.refs, link.ref)).then((answers) => [answers[0]]) : undefined
  }

  openFile(target: RefFile): void {
    const doc = refDocOf(this.view.state)
    if (doc) this.hooks()?.openRef?.(doc, target)
  }

  /**
   * The link under `(x, y)`: an address, or a file reference not known to lead to none. One not known yet is asked
   * about (unless `ask` is false), and looked at again when the answer comes.
   */
  private linkUnder(x: number, y: number, el: Element | null, ask = true): DocLink | null {
    const l = linkAtPoint(this.view, x, y, el)
    if (!l || l.kind === 'url') return l
    if (l.answer === null) return null
    if (l.answer === undefined && ask) this.askFor(l)
    return l
  }

  /** Ask about the references around `l`; when the answer comes, the resting pointer is looked at again, if the text is as it was. */
  private askFor(l: DocFile): void {
    const doc = this.view.state.doc
    void this.ask(l)?.then(() => {
      if (this.gone || this.view.state.doc !== doc || !this.at || !this.g.mod || this.g.press) return
      this.step({ kind: 'key', flags: this.modFlags(), link: this.linkAtRest(false) })
    })
  }

  /** What is under the resting pointer now (the text may have scrolled under it). */
  private linkAtRest(ask = true): DocLink | null {
    const at = this.at
    if (!at) return null
    return this.linkUnder(at.x, at.y, this.view.root.elementFromPoint(at.x, at.y), ask)
  }

  /** A click on a reference not known at its press: it opens if the answer, when it comes, says it is a file, within L.viewerLinkListBudgetMs. */
  private lateClick(link: DocFile): void {
    const known = this.lookup(link.ref)
    if (known) return this.openFile(known)
    if (known === null) return
    const released = performance.now()
    void this.ask(link)?.then(([a]) => {
      if (this.gone || performance.now() - released > L.viewerLinkListBudgetMs) return
      if (a && a !== 'unknown') this.openFile(a)
    })
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
    const fx = s.effect
    if (fx?.do === 'open') {
      const l = fx.link
      if (l.kind === 'url' && l.action.open) this.hooks()?.openLink?.(l.action.url)
      else if (l.kind === 'file' && l.answer) this.openFile(l.answer)
    } else if (fx?.do === 'menu') this.hooks()?.linkMenu?.(this.view.contentDOM, point(fx.x, fx.y), textLinkOf(fx.link))
    else if (fx?.do === 'late' && fx.link.kind === 'file') this.lateClick(fx.link)
    return s
  }

  private tip(l: DocLink | null): void {
    const key = l ? `${l.from}:${l.to}:${l.text}:${l.kind === 'file' && l.answer ? targetText(l.answer) : ''}` : null
    if (!l || !this.at) {
      if (this.tipOut) this.hooks()?.linkTip?.(null)
      this.tipOut = false
      this.tipKey = null
      return
    }
    if (key === this.tipKey) return
    this.tipKey = key
    this.tipOut = true
    const words = l.kind === 'url' ? linkTipWords(l, protocolOs.system) : { target: l.answer ? targetText(l.answer) : l.text, action: clickWords(protocolOs.system) }
    this.hooks()?.linkTip?.({ ...words, x: this.at.x, y: this.at.y, key: key as string })
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

  /**
   * A press: true when it is the link's, which the document then never sees. A press on a reference not known yet is
   * the document's, and its release is still followed, for a late click.
   */
  press(e: MouseEvent): boolean {
    const flags = flagsOf(e)
    const link = linkModifier(flags, protocolOs.system) ? this.linkUnder(e.clientX, e.clientY, elementOf(e.target)) : null
    this.at = point(e.clientX, e.clientY)
    const s = this.step({ kind: 'press', x: e.clientX, y: e.clientY, button: e.button, detail: e.detail, flags, link })
    if (this.g.press) this.listen()
    if (!s.take) return false
    e.preventDefault()
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
      // a release on the document's own press is the document's too
      this.step({ kind: 'release', x: e.clientX, y: e.clientY, button: e.button, link: this.linkUnder(e.clientX, e.clientY, elementOf(e.target)) })
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // only a press the link took is the link's to cancel
      if (this.g.press?.taken) {
        e.preventDefault()
        e.stopPropagation()
      }
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
