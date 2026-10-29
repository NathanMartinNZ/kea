// One terminal view: `@xterm/xterm` with WebGL, attached to its PTY over a stream port. Views live in the registry
// (`views.ts`), never in component or rune state (`$state`).
//
// Attach: open a stream → the first message is a snapshot at the mirror's size → write it → live chunks follow
// from `snapshot.seq`; each written chunk returns its credit → fit to the pane → resize the PTY if the grid
// changed. Queries in the output are swallowed here: only the ptyhost mirror answers them.
//
// Input: `onData` / `onBinary` go to the PTY unbatched. App shortcuts are routed before xterm sees them
// (`commands/keys.ts`); no `⌘` key reaches xterm's encoder; `⇧↵` sends `\n` while the program has not enabled the kitty
// keyboard protocol. Output is untrusted: OSC 52 writes go through `osc52.ts`, links through `links.ts`, titles through
// `text.ts`.
//
// The terminal menu opens on a right-click (`contextMenu.ts` decides whether the program that captures the mouse keeps
// the button) and on the keyboard's Menu key, at the text cursor.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { L, fromDomPort, protocolOs, type Channel, type StreamToRenderer } from '@kea/protocol'
import { applyAppearance, createTerminalOptions, installRendererSwallow, ModeTracker, rendererTerminalOptions, type Disposable } from '@kea/terminal'
import { COLOR } from '@kea/ui/tokens'
import { onStreamsReset, openExternal, openStream } from '../../lib/bridge.ts'
import { modClick, terminalKeyOverride } from '../commands/keys.ts'
import { AtlasGuard, followAtlas, type AtlasCanvas, type AtlasClearReason } from './atlas.ts'
import { cursorPoint, listenForMenu } from './contextMenu.ts'
import { ClearOnCopy, isUserSelection, selectionKey } from './ctrlCopy.ts'
import { disposeParts } from './dispose.ts'
import { blend, FindSession, type FindToggles } from './find.ts'
import { installFileLinks, openFileUrl } from './fileLinks.ts'
import { linkAction, linkHoverText } from './links.ts'
import { osc52Decision, parseOsc52 } from './osc52.ts'
import { IMAGE_PASTE_KEY, pasteDecision } from './paste.ts'
import { prefs } from './prefs.ts'
import { closeStream, holdStream } from './streams.ts'
import { terminalUi } from './ui.svelte.ts'

export type ViewState = {
  title: string | null
  exited: { code: number | null; signal: number | null } | null
  gone: boolean
  /** The viewport is above the bottom. */
  scrolledUp: boolean
}

/** What a view needs to know about its place in the window. */
export interface ViewHost {
  /** The terminal is the one on screen: OSC 52 clipboard writes apply only then. */
  isShown(ptyId: string): boolean
  /** A plain shell tab (multi-line paste asks first). */
  isPlainShell(ptyId: string): boolean
  /** A view the registry released leaves its scroll mark (null: at the bottom) for the PTY's next view. */
  rememberScroll?(ptyId: string, mark: ScrollMark | null): void
  /** Where an earlier view of this PTY was scrolled to when it was released, taken once. */
  recallScroll?(ptyId: string): ScrollMark | null
  /**
   * The last screen of an ended terminal whose holder is gone, rendered from its checkpoint on demand: what a
   * view shows when its stream finds no terminal; null when none was kept.
   */
  lastScreen?(ptyId: string, cols: number, rows: number): Promise<{ cols: number; rows: number; data: string } | null>
  /** The tab's agent captures the mouse but has nothing on the right button, which then opens Kea's menu. */
  rightButtonMenu?(ptyId: string): boolean
}

/**
 * Where a view was scrolled to, away from the bottom (restored on return, also when the view is rebuilt from a
 * snapshot). `top` is the first visible line, `fromBottom` its distance from the bottom, `length` the buffer's lines.
 */
export interface ScrollMark {
  top: number
  fromBottom: number
  length: number
}

/** Live WebGL contexts in this window (the resource report, L-TERM-2). */
let liveContexts = 0
export function webglContexts(): number {
  return liveContexts
}

const listen = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false): Disposable => {
  el.addEventListener(type, fn, capture)
  return { dispose: () => el.removeEventListener(type, fn, capture) }
}

export class TerminalView {
  readonly ptyId: string
  readonly el: HTMLDivElement
  private readonly host: ViewHost
  private readonly term: Terminal
  private readonly fit = new FitAddon()
  private readonly unicode = new Unicode11Addon()
  private readonly links: WebLinksAddon
  private modes: ModeTracker
  private webgl: WebglAddon | null = null
  private glCanvas: HTMLCanvasElement | null = null
  private readonly glSubs: Disposable[] = [] // bounded: the current WebGL addon's four listeners
  private wantGl = false
  private readonly atlas: AtlasGuard
  private search: FindSession | null = null
  /** Where the find bar's last search left its match selected (`selectionKey`): that selection is not the person's. */
  private findSelection: string | null = null
  /** A plain Ctrl+C copy clears the selection once the terminal's own copy event has run. */
  private readonly clearOnCopy = new ClearOnCopy()
  private ch: Channel | null = null
  private opened = false
  private disposed = false
  private readonly ds: Disposable[] = [] // bounded: fixed set of listeners and hooks for this view
  private resizeObs: ResizeObserver | null = null
  private lastGrid = { cols: 0, rows: 0, xpx: 0, ypx: 0 }
  private attachSeq = 0
  /** The current stream has delivered a snapshot (a `gone` before any means the terminal ended and was let go). */
  private snapshotSeen = false
  state: ViewState = { title: null, exited: null, gone: false, scrolledUp: false }
  onState: (s: ViewState) => void = () => {}
  /** The first snapshot has been written (the perf harness and the no-blank-frame switch wait on it). */
  attached: Promise<void>
  /** Bytes of output this view has been sent since it was made: a count, never content (the dev HUD's bytes/s). */
  bytesIn = 0
  /** `attached` has resolved: switching to this view can show it at once (a warm switch, P-TERM-7). */
  isAttached = false
  /** What assistive technology reads for this terminal ("<session>, <tab> terminal"); null until it is told. */
  private accessibleName: string | null = null
  private resolveAttached!: () => void

  constructor(ptyId: string, host: ViewHost) {
    this.ptyId = ptyId
    this.host = host
    this.el = document.createElement('div')
    this.el.className = 'kea-terminal'
    const p = prefs.get()
    const core = createTerminalOptions({ side: 'renderer', cols: 80, rows: 24, scrollback: p.scrollback })
    this.term = new Terminal({
      ...rendererTerminalOptions(core, prefs.appearance()),
      allowTransparency: false,
      // no `scrollbar.width`: it also turns on xterm's overview ruler, which asks for another frame after every render;
      // a keystroke typed while that frame is pending has its echo held back a frame by Chromium (P-TERM-1).
      // The slider is drawn at the design width in styles.css instead.
      // OSC 8 links: non-web schemes reach the handler, which never opens them
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (e, text) => this.onLink(e, text),
        hover: (e, text) => terminalUi.linkHover({ ptyId: this.ptyId, x: e.clientX, y: e.clientY, text: linkHoverText(text) }),
        leave: () => terminalUi.linkLeave(this.ptyId),
      },
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.unicode)
    this.term.unicode.activeVersion = '11'
    this.links = new WebLinksAddon((e, uri) => this.onLink(e, uri), {
      hover: (e, text) => terminalUi.linkHover({ ptyId: this.ptyId, x: e.clientX, y: e.clientY, text: linkHoverText(text) }),
      leave: () => terminalUi.linkLeave(this.ptyId),
    })
    this.term.loadAddon(this.links)
    // File references printed in a session's terminal are links that open in the editor (fileLinks.ts)
    this.ds.push(installFileLinks(this.term, this.ptyId))
    this.atlas = new AtlasGuard({ limitBytes: L.atlasGuardBytes, clear: () => this.webgl?.clearTextureAtlas() })
    this.modes = new ModeTracker(this.term as never)
    this.ds.push(installRendererSwallow(this.term as never))
    // registered after the swallow hooks, so it runs first: OSC 52 writes are policed, reads swallowed
    this.ds.push(
      this.term.parser.registerOscHandler(52, (data) => {
        this.onOsc52(data)
        return true
      }),
    )
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e))
    this.ds.push(this.term.onData((d) => this.ch?.send({ k: 'in', d })))
    this.ds.push(this.term.onBinary((d) => this.ch?.send({ k: 'inb', d: binary(d) })))
    this.ds.push(this.term.onScroll(() => this.updateScroll()))
    this.ds.push(this.term.onWriteParsed(() => this.updateScroll()))
    this.ds.push({ dispose: onStreamsReset(() => void this.attach()) })
    this.ds.push({ dispose: prefs.subscribe(() => this.applyPrefs()) })
    this.ds.push(listen(this.el, 'paste', (e) => this.onPaste(e), true))
    // the left button's release: a right-click that opens the menu copies nothing
    this.ds.push(listen(this.el, 'mouseup', (e) => e.button === 0 && this.copyOnSelect()))
    this.ds.push(
      listenForMenu(this.el, {
        system: protocolOs.system,
        tracking: () => this.term.modes.mouseTrackingMode !== 'none',
        // the find bar's match, which stays selected after it closes, is not the person's: it keeps no button from a program
        hasSelection: () => this.userSelection(),
        agentGivesButton: () => this.host.rightButtonMenu?.(this.ptyId) ?? false,
        focus: () => this.focus(),
        open: (at) => terminalUi.openMenu({ ptyId: this.ptyId, at }),
      }),
    )
    // bubbling, so xterm's own handler on its textarea has filled the clipboard first
    this.ds.push(
      listen(this.el, 'copy', () => {
        if (this.clearOnCopy.copied()) this.term.clearSelection()
      }),
    )
    this.ds.push(this.term.onSelectionChange(() => this.clearOnCopy.selectionChanged()))
    this.attached = new Promise((r) => (this.resolveAttached = r))
  }

  private markAttached(): void {
    this.isAttached = true
    this.resolveAttached()
  }

  /** Put the view in the DOM (first time: open xterm, load WebGL if wanted, attach). */
  mount(parent: HTMLElement): void {
    if (this.disposed) return
    if (this.el.parentElement !== parent) parent.appendChild(this.el)
    if (!this.opened) {
      this.opened = true
      this.term.open(this.el)
      this.labelParts()
      this.loadWebgl()
      this.resizeObs = new ResizeObserver(() => this.refit())
      this.resizeObs.observe(this.el)
      void this.attach()
    }
    this.refit()
  }

  focus(): void {
    this.term.focus()
  }

  /** xterm's screen-reader mode, live (screenReader.ts decides: a screen reader runs and this terminal is on screen). */
  setScreenReader(on: boolean): void {
    if (this.disposed || this.term.options.screenReaderMode === on) return
    this.term.options.screenReaderMode = on
  }

  /** Whether xterm's screen-reader mode is on (the resource report and the tests). */
  get screenReader(): boolean {
    return this.term.options.screenReaderMode === true
  }

  /** The terminal's accessible name: its group's, and its input's (the element that has the keyboard). */
  setAccessibleName(name: string): void {
    if (this.accessibleName === name) return
    this.accessibleName = name
    this.labelParts()
  }

  private labelParts(): void {
    const name = this.accessibleName
    if (name === null) return
    this.el.setAttribute('role', 'group')
    this.el.setAttribute('aria-label', name)
    // xterm names its input "Terminal input": with several terminals in a window that says too little
    this.term.textarea?.setAttribute('aria-label', name)
  }

  blur(): void {
    this.term.blur()
  }

  hasFocus(): boolean {
    return !!this.term.textarea && document.activeElement === this.term.textarea
  }

  /** The xterm instance, for the perf harness only (`lib/perf.ts`). */
  get xterm(): Terminal {
    return this.term
  }

  /** The current grid, used as the spawn size of the next shell. */
  grid(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows }
  }

  /** Input on the user's behalf from a key the app translated (image paste): like typing, it scrolls down. */
  input(data: string): void {
    this.term.input(data, true)
  }

  /** Confirmed paste: bracketed when the program enabled bracketed paste. */
  paste(text: string): void {
    this.term.paste(text)
  }

  /** `⌘K`: this terminal's screen and scrollback; the caller clears the mirror. */
  clear(): void {
    this.term.clear()
  }

  /** The registry released this view (it is disposed next): its scroll mark stays for the PTY's next view. */
  released(): void {
    if (this.isAttached) this.host.rememberScroll?.(this.ptyId, this.scrollMark())
  }

  /** Where the user has scrolled to, or null at the bottom. */
  scrollMark(): ScrollMark | null {
    const b = this.term.buffer.active
    if (b.type !== 'normal' || b.viewportY >= b.baseY) return null
    return { top: b.viewportY, fromBottom: b.baseY - b.viewportY, length: b.length }
  }

  /**
   * Back to a scroll mark after a snapshot. While the buffer has never dropped a line to the scrollback limit,
   * line numbers are stable (output since only appends), so the same first line comes back; once lines are dropped,
   * the same distance from the bottom.
   */
  private restoreScroll(m: ScrollMark | null): void {
    if (!m) return
    const b = this.term.buffer.active
    if (b.type !== 'normal') return
    const cap = (this.term.options.scrollback ?? 0) + this.term.rows
    const line = m.length < cap && b.length < cap ? m.top : b.baseY - m.fromBottom
    this.term.scrollToLine(Math.max(0, Math.min(b.baseY, line)))
  }

  scrollToBottom(): void {
    this.term.scrollToBottom()
  }

  // ── WebGL ─────────────────────────────────────────────────────────────────────────────────────

  /** Hold a WebGL context or not (the registry decides); without one the DOM renderer draws. */
  setWebgl(on: boolean): void {
    this.wantGl = on
    if (on) this.loadWebgl()
    else this.releaseWebgl()
  }

  get hasWebgl(): boolean {
    return this.webgl !== null
  }

  /** Clear the glyph atlas (DPR change, font change, wake, "Reset Terminal Rendering"). */
  clearAtlas(reason: AtlasClearReason): void {
    if (this.webgl) this.atlas.clear(reason)
    this.term.refresh(0, this.term.rows - 1)
  }

  atlasStats(): { bytes: number; pages: number } {
    return { bytes: this.atlas.bytes, pages: this.atlas.pageCount }
  }

  /** This view's live atlas pages (its atlas may be shared with other views). */
  atlasPages(): ReadonlyMap<AtlasCanvas, number> {
    return this.atlas.pageSizes
  }

  private loadWebgl(): void {
    if (this.disposed || !this.opened || this.webgl || !this.wantGl || liveContexts >= L.webglContextsMax) return
    const before = new Set(this.el.querySelectorAll('canvas'))
    let gl: WebglAddon
    try {
      gl = new WebglAddon()
    } catch {
      return // no WebGL2: the DOM renderer draws
    }
    // before `loadAddon`: the patched addon tells these of the atlas's pages as soon as it has a renderer
    this.glSubs.push(...followAtlas(this.atlas, gl), gl.onContextLoss(() => this.contextLost(gl)))
    try {
      this.term.loadAddon(gl)
    } catch {
      for (const s of this.glSubs.splice(0)) s.dispose()
      return
    }
    this.webgl = gl
    liveContexts++
    this.glCanvas = [...this.el.querySelectorAll('canvas')].find((c) => !before.has(c) && !/-layer\b/.test(c.className)) ?? null
    // On context loss, the DOM renderer takes over at once and WebGL comes back on the next frame
    const canvas = this.glCanvas
    if (canvas) {
      const onLost = () => this.contextLost(gl)
      canvas.addEventListener('webglcontextlost', onLost)
      this.glSubs.push({ dispose: () => canvas.removeEventListener('webglcontextlost', onLost) })
    }
  }

  /**
   * The watchdog's GPU reset: this view's WebGL renderer goes and comes back as after a lost context. The DOM renderer
   * draws at once, WebGL again on the next frame, with a new context and what the old one held released. A view that
   * holds no WebGL has nothing to give back.
   */
  recreateWebgl(): void {
    if (this.webgl) this.contextLost(this.webgl)
  }

  private contextLost(gl: WebglAddon): void {
    if (this.webgl !== gl) return
    // the frame callback is asked for before the DOM renderer's render, so in the next frame WebGL is back before
    // xterm's render callback runs, and that one render (asked for by both renderers) paints with WebGL: the
    // terminal is painted in the next frame whatever the layout (E-TERM-4). Asked for after it, the new
    // renderer would paint a frame later, unless its canvas's device-pixel size happened to need a synchronous redraw
    requestAnimationFrame(() => this.loadWebgl())
    this.releaseWebgl()
  }

  /** The disposal order of the WebGL part: its listeners off, `loseContext()`, then the addon. */
  private releaseWebgl(): void {
    const gl = this.webgl
    if (!gl) return
    this.webgl = null
    liveContexts--
    for (const s of this.glSubs.splice(0)) s.dispose()
    loseContext(this.glCanvas)
    this.glCanvas = null
    try {
      gl.dispose()
    } catch {
      // Disposing a lost context can throw
    }
    this.atlas.reset()
  }

  // ── find ──────────────────────────────────────────────────────────────────────────────────────

  /** Open the find bar's session: the search addon exists only while it is open. */
  openFind(): FindSession {
    if (this.search?.isOpen) return this.search
    const css = getComputedStyle(document.documentElement)
    const alpha = Number.parseFloat(css.getPropertyValue('--opacity-find-match')) || 0
    const match = blend(COLOR.warn, COLOR['surface-0'], alpha)
    this.search = new FindSession({
      load: () => {
        const a = new SearchAddon({ highlightLimit: L.searchHighlightsMax })
        this.term.loadAddon(a)
        return a
      },
      decorations: { matchBackground: match, matchOverviewRuler: COLOR.warn, activeMatchBackground: match, activeMatchBorder: COLOR.warn, activeMatchColorOverviewRuler: COLOR.warn },
      // Registering a decoration makes xterm apply the removals it holds. This one goes by its marker, whose
      // line is then below every other's, so its own removal cannot hide another
      settle: () => {
        const marker = this.term.registerMarker(0)
        this.term.registerDecoration({ marker })
        marker.dispose()
      },
      cap: L.searchHighlightsMax,
      onResults: (results) => terminalUi.findResults(this.ptyId, results),
    })
    return this.search
  }

  find(query: string, t: FindToggles, dir: 'incremental' | 'next' | 'previous'): void {
    this.openFind().search(query, t, dir)
    this.findSelection = selectionKey(this.term.getSelectionPosition())
  }

  /** Text the person selected is selected here: not the find bar's match, which stays selected after it closes. */
  userSelection(): boolean {
    return isUserSelection(this.term.hasSelection(), selectionKey(this.term.getSelectionPosition()), this.findSelection)
  }

  /** The text cursor's place in the window: under its cell, from the buffer and the screen's size. */
  private textCursorPoint(): { x: number; y: number } {
    const screen = this.term.element?.querySelector('.xterm-screen') ?? this.el
    const r = screen.getBoundingClientRect()
    const b = this.term.buffer.active
    return cursorPoint({ cursorX: b.cursorX, cursorY: b.cursorY, baseY: b.baseY, viewportY: b.viewportY, cols: this.term.cols, rows: this.term.rows }, { left: r.left, top: r.top, width: r.width, height: r.height })
  }

  /** Select All: every line the terminal holds, scrollback included. */
  selectAll(): void {
    this.term.selectAll()
  }

  /** A copy is about to run from plain Ctrl+C: the selection goes once the terminal's copy event has run. */
  clearSelectionAfterCopy(): void {
    this.clearOnCopy.arm()
  }

  closeFind(): void {
    this.search?.close()
    this.search = null
  }

  get findOpen(): boolean {
    return !!this.search?.isOpen
  }

  // ── stream ────────────────────────────────────────────────────────────────────────────────────

  /** (Re)open the stream; the snapshot repaints the whole terminal. */
  async attach(): Promise<void> {
    const n = ++this.attachSeq
    closeStream(this.ch)
    this.ch = null
    this.snapshotSeen = false
    let port: MessagePort
    try {
      port = await openStream(this.ptyId)
    } catch {
      // ptyhost is not running: the view shows what it has (a restarted ptyhost resets the streams, then it attaches)
      this.markAttached()
      return
    }
    if (this.disposed || n !== this.attachSeq) {
      port.close()
      return
    }
    const ch = holdStream(fromDomPort(port as never))
    this.ch = ch
    ch.onMessage((m) => this.onMessage(ch, m as StreamToRenderer))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.wantGl = false
    const gl = this.webgl
    if (gl) {
      this.webgl = null
      liveContexts--
    }
    const canvas = this.glCanvas
    this.glCanvas = null
    const ch = this.ch
    this.ch = null
    const search = this.search
    this.search = null
    // The shared glyph atlas parks its hidden scratch canvas in the last terminal it drew a glyph for; left in
    // a disposed one, it keeps that terminal's elements alive until the atlas next draws elsewhere (it is put back on
    // the atlas's next draw)
    for (const c of this.el.querySelectorAll<HTMLCanvasElement>(ATLAS_SCRATCH_CANVAS)) c.remove()
    disposeParts(
      {
        loseContext: () => {
          for (const s of this.glSubs.splice(0)) s.dispose()
          loseContext(canvas)
        },
        webgl: gl,
        addons: [{ dispose: () => search?.close() }, this.links, this.unicode, this.fit],
        terminal: this.term,
        observers: [{ dispose: () => this.resizeObs?.disconnect() }, this.modes, ...this.ds.splice(0)],
        port: ch && { send: (m) => ch.send(m), close: () => closeStream(ch) },
      },
      (step, e) => console.warn(`terminal ${this.ptyId}: dispose ${step} failed`, e),
    )
    this.resizeObs = null
    this.atlas.reset()
    this.el.remove()
  }

  private onMessage(ch: Channel, m: StreamToRenderer): void {
    if (ch !== this.ch) return
    switch (m.k) {
      case 'snapshot': {
        // where the user was scrolled to: this view's place (a re-attach), else an earlier view's (rebuilt)
        const mark = this.isAttached ? this.scrollMark() : (this.host.recallScroll?.(this.ptyId) ?? null)
        this.snapshotSeen = true
        // a fresh terminal state: the mode tracker starts over and sees the snapshot's trailer (kitty flags)
        this.modes.dispose()
        this.term.reset()
        this.modes = new ModeTracker(this.term as never)
        if (m.cols !== this.term.cols || m.rows !== this.term.rows) this.term.resize(m.cols, m.rows)
        const cost = m.data.length
        this.term.write(m.data, () => {
          ch.send({ k: 'credit', n: cost })
          this.restoreScroll(mark)
          this.markAttached()
        })
        this.lastGrid = { cols: m.cols, rows: m.rows, xpx: 0, ypx: 0 }
        this.setState({ ...this.state, title: m.title, exited: m.exited, gone: false })
        this.refit()
        return
      }
      case 'data': {
        const n = m.b.byteLength
        this.bytesIn += n
        this.term.write(m.b, () => ch.send({ k: 'credit', n }))
        return
      }
      case 'exit':
        this.setState({ ...this.state, exited: { code: m.code, signal: m.signal } })
        return
      case 'title':
        this.setState({ ...this.state, title: m.title })
        return
      case 'gone':
        this.setState({ ...this.state, gone: true })
        // a terminal that ended and was let go: its last screen, from its checkpoint, before anything shows
        if (!this.snapshotSeen && this.host.lastScreen) void this.showLastScreen(ch)
        else this.markAttached() // nothing more will paint; let a pending switch go ahead
        return
    }
  }

  /**
   * An ended terminal's last screen, rendered from its checkpoint (core asks ptyhost, nothing is kept) and
   * written like a snapshot; the data is dropped once written. A switch to this view waits for it.
   */
  private async showLastScreen(ch: Channel): Promise<void> {
    const n = this.attachSeq
    const s = await this.host.lastScreen!(this.ptyId, this.term.cols, this.term.rows).catch(() => null)
    if (this.disposed || n !== this.attachSeq || ch !== this.ch) return
    if (!s) {
      this.markAttached() // none kept (a corrupt ring, C-COR-3): the view stays empty
      return
    }
    this.modes.dispose()
    this.term.reset()
    this.modes = new ModeTracker(this.term as never)
    if (s.cols !== this.term.cols || s.rows !== this.term.rows) this.term.resize(s.cols, s.rows)
    this.term.write(s.data, () => {
      if (this.disposed) return
      this.markAttached()
      this.refit()
    })
  }

  private setState(s: ViewState): void {
    this.state = s
    this.onState(s)
  }

  // ── input and output policy ───────────────────────────────────────────────────────────────────

  /** xterm's key hook: false keeps the key from xterm's encoder. */
  private onKey(e: KeyboardEvent): boolean {
    // ⌘ keys are routed before they get here; none of them may be encoded for the PTY (with the kitty protocol, ⌘
    // would be sent as the super modifier)
    if (e.metaKey) return false
    // the keyboard's Menu key opens the terminal menu at the text cursor; Shift+F10 stays the program's
    if (e.key === 'ContextMenu' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      if (e.type === 'keydown') {
        e.preventDefault()
        terminalUi.openMenu({ ptyId: this.ptyId, at: this.textCursorPoint() })
      }
      return false
    }
    const data = terminalKeyOverride(e, this.modes.state().kitty.flags)
    if (data === null) return true
    if (e.type === 'keydown') {
      e.preventDefault() // no keypress follows
      this.input(data)
    }
    return false
  }

  /** OSC 52: applied only while visible and focused (setting), within the size cap; otherwise dropped. */
  private onOsc52(data: string): void {
    const parsed = parseOsc52(data, L.osc52MaxBytes)
    const d = osc52Decision({ parsed, policy: prefs.get().clipboardWrite, visible: this.host.isShown(this.ptyId), windowFocused: document.hasFocus() })
    if (d.apply) {
      navigator.clipboard.writeText(d.text).then(
        () => terminalUi.copiedByTerminal(this.ptyId),
        (e: unknown) => console.warn(`terminal ${this.ptyId}: OSC 52 clipboard write failed`, e),
      )
    } else if (d.reason !== 'read') {
      console.warn(`terminal ${this.ptyId}: OSC 52 clipboard write dropped (${d.reason})`)
    }
  }

  /** `⌘`-click (Ctrl+click on Linux) on a link: web and mail links open; anything else offers "Copy link". */
  private onLink(e: MouseEvent, target: string): void {
    if (!modClick(e)) return
    const a = linkAction(target)
    if (a.open) return openExternal(a.url)
    // A `file:` target opens in the editor when it is a file of this session's worktree (fileLinks.ts)
    const at = { x: e.clientX, y: e.clientY }
    void openFileUrl(this.ptyId, target).then((opened) => {
      if (!opened) terminalUi.linkMenu({ ptyId: this.ptyId, ...at, target })
    })
  }

  /** An image-only clipboard sends the image-paste key; multi-line text into a shell asks first. */
  private onPaste(e: ClipboardEvent): void {
    const dt = e.clipboardData
    if (!dt) return
    const text = dt.getData('text/plain')
    const hasImage = [...dt.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'))
    const d = pasteDecision({ text, hasImage, plainShell: this.host.isPlainShell(this.ptyId), confirmMultiline: prefs.get().confirmMultilinePaste })
    if (d.do === 'default') return
    e.preventDefault()
    e.stopPropagation()
    if (d.do === 'imageKey') this.input(IMAGE_PASTE_KEY)
    else terminalUi.askPaste(this.ptyId, d.lines, text)
  }

  /** Copy-on-select (setting, off by default): the selection is copied when the mouse is released. */
  private copyOnSelect(): void {
    if (!prefs.get().copyOnSelect || !this.term.hasSelection()) return
    navigator.clipboard.writeText(this.term.getSelection()).catch((e: unknown) => console.warn('copy on select failed', e))
  }

  private updateScroll(): void {
    const b = this.term.buffer.active
    const up = b.viewportY < b.baseY
    if (up !== this.state.scrolledUp) this.setState({ ...this.state, scrolledUp: up })
  }

  /** Settings or zoom changed: applied in place; a font change refits and clears the atlas. */
  private applyPrefs(): void {
    if (this.disposed) return
    const { fontChanged } = applyAppearance(this.term, prefs.appearance())
    const scrollback = prefs.get().scrollback
    if (this.term.options.scrollback !== scrollback) this.term.options.scrollback = scrollback
    if (fontChanged) {
      this.clearAtlas('font')
      this.refit()
    }
  }

  /** Fit the grid to the pane and tell ptyhost (which debounces). */
  private refit(): void {
    if (!this.opened || this.disposed || !this.el.isConnected) return
    // a hidden tab has no size: keep its grid (and its PTY's) as it was
    if (this.el.clientWidth === 0 || this.el.clientHeight === 0) return
    const d = this.fit.proposeDimensions()
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return
    const cols = Math.max(d.cols, L.ptyMinCols)
    const rows = Math.max(d.rows, L.ptyMinRows)
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows)
    const xpx = Math.round(this.el.clientWidth)
    const ypx = Math.round(this.el.clientHeight)
    const g = this.lastGrid
    if (g.cols === cols && g.rows === rows && g.xpx === xpx && g.ypx === ypx) return
    this.lastGrid = { cols, rows, xpx, ypx }
    this.ch?.send({ k: 'resize', cols, rows, xpx: Math.min(xpx, 65535), ypx: Math.min(ypx, 65535) })
  }
}

/** `@xterm/addon-webgl`'s TextureAtlas scratch canvas (`_tmpCanvas`): the one class-less canvas under the terminal's element. */
const ATLAS_SCRATCH_CANVAS = '.xterm > canvas:not([class])'

function loseContext(canvas: HTMLCanvasElement | null): void {
  try {
    // the canvas already has its WebGL2 context, so this returns it (it never creates one on a WebGL canvas)
    ;(canvas?.getContext('webgl2') as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // the context may already be gone
  }
}

function binary(s: string): Uint8Array {
  // onBinary data is a binary string (one char per byte)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
