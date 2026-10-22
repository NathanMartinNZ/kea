// Mode trailer: state that `@xterm/addon-serialize` does not capture, tracked by parser hooks on the mirror and written
// around the serialized screen so that a fresh terminal — a renderer attaching, or a mirror rebuilt from a checkpoint —
// ends up in the same state.
//
//   snapshot = prefix + serialized (its `CSI ? 1049 h CSI H` replaced by altSwitch when the alternate screen is
//              active) + suffix
//
// Saved cursors (DECSC / SCOSC / 1048 / 1049, one slot per screen) are tracked as xterm.js keeps them: column, absolute
// row, the attributes' fg and bg words, origin mode, auto-wrap, and (in the charset tracker) the G0–G3 table and GL
// level. A slot is rebuilt on the fresh terminal by setting all of that, moving to the position and DECSC, then putting
// back what the next part expects. Known losses: a cursor saved in the pending-wrap column comes back on the last column
// (where DECRC puts it anyway, unless the terminal is widened first); the charset table can come back longer than it
// was (a DECRC then also resets the extra, undesignated G sets); a resize that pulls lines back from scrollback can
// leave the saved row off by the lines pulled; current attributes a DECRC left inconsistent (xterm.js restores the
// saved colours and flags but keeps the current underline style and colour) come back as SGR can set them, since
// rebuilding them takes a DECRC from a slot holding the current colours, and both slots are taken. The package README
// lists the other known losses.
//
// Tab stops (HTS `ESC H`, TBC `CSI g`) are tracked per screen as xterm.js keeps them (`Buffer.tabs`): a resize lays new
// stops from the last one left of the new width, leaving the alternate screen resets its stops, RIS resets both. A
// screen whose stops left of the right margin are the default ones (every `tabStopWidth` columns) needs nothing;
// otherwise its stops are cleared and set again one by one. Known losses: a stop set by the 8-bit C1 HTS (U+0088), an
// execute no parser hook sees, and stops at or past the right margin (set in the pending-wrap column, or left by a
// narrowing), which matter only once the terminal is widened. LNM (`CSI 20 h`) is xterm.js's `convertEol` option, which
// neither RIS nor `Terminal.reset()` clears, so the trailer always states it: a renderer reusing its terminal may still
// have it on.
//
// prefix    — the main screen's tab stops when the alternate screen is active, kitty keyboard flag stacks of the
//             screen(s) that are not active at the end, and, when the main screen is active, the alternate screen's
//             saved cursor (built on the fresh terminal before the serialized content switches screens). The alternate
//             screen's stops need nothing while the main screen is active: leaving the alternate screen resets them.
// altSwitch — when the alternate screen is active: the main screen's saved cursor, default attributes (the serializer
//             writes the alternate screen as if from defaults, and the switch fills it with the current background),
//             the main screen's scroll region, then `CSI ? 1047 h CSI H` (the serializer's 1049 would save the cursor
//             over the slot just built). Leaving moves the main cursor to the alternate screen's, so the main cursor
//             itself is never seen again.
// suffix    — the active screen's kitty stack, tab stops and saved cursor, colour overrides, cursor style, title, DEC
//             modes (incl. SGR mouse encoding 1006/1016) and LNM, then DECSTBM → DECOM → cursor last, because each of the first two
//             homes the cursor and the serializer can leave it one column off (xterm.js #6165), then character sets
//             (after any reprinted row, which must not go through them) and the current attributes in full (SGR and
//             DECSCA: the serializer restores only what shows in a cell). A cursor in the pending-wrap state
//             (just past the last column) cannot be reached with CUP; on the main screen its row is reprinted through
//             the serializer, which leaves the cursor pending and restores the current attributes. On the alternate
//             screen, or in origin mode, it is restored to the last column (known loss: the next character overwrites
//             the last cell instead of wrapping; full-screen programs position the cursor before drawing). Origin mode
//             is excluded because xterm.js adds the region top to relative cursor moves there.
//
// Hooks return false: they observe, xterm.js still applies every sequence. Semantics mirror xterm.js at the pinned
// commit (`common/InputHandler.ts`): kitty set/push/pop/stack eviction and the main/alt flag swap, DECSCUSR, DECSTBM,
// SGR and DECSCA (attrs.ts), DECSC / DECRC and their DECSET forms, HTS / TBC and `Buffer.setupTabStops`, DECSTR and RIS
// resets, and the alternate buffer's scroll region and tab stops being reset when it is left.

import { applyProtected, applySgr, DEFAULT_ATTRS, sameAttrs, sgrOf, type Attrs } from './attrs.ts'
import { charsetSequence, type CharsetState, type CharsetTracker } from './scanner.ts'
import type { ColorState } from './colors.ts'
import { disposeAll, nums, p0, type Disposable, type TerminalApi } from './xterm.ts'

/** xterm.js evicts the oldest kitty stack entry beyond this (upstream DoS guard, not a Kea limit). */
const KITTY_STACK_MAX = 16

export type MouseEncoding = 'default' | 'sgr' | 'sgrPixels'
export type CursorShape = 'block' | 'underline' | 'bar'

export interface KittyState {
  flags: number
  mainFlags: number
  altFlags: number
  mainStack: number[]
  altStack: number[]
}

/** [top, bottom], 0-based inclusive; null = the whole screen. */
export type Region = readonly [number, number] | null

/**
 * A saved cursor as xterm.js keeps it (`Buffer.saved*`): the column, the absolute row (scrollback base + viewport row),
 * the attributes' fg and bg words (not the extended ones: DECRC keeps the current underline style and colour), origin
 * mode and auto-wrap.
 */
export interface SavedCursor {
  x: number
  absY: number
  fg: number
  bg: number
  origin: boolean
  wrap: boolean
}

/** A saved cursor as DECRC would restore it now: a viewport position instead of the absolute row. */
export interface SavedView {
  x: number
  y: number
  fg: number
  bg: number
  origin: boolean
  wrap: boolean
}

export interface TrackedModes {
  kitty: KittyState
  mouseEncoding: MouseEncoding
  cursor: { shape: CursorShape | undefined; blink: boolean | undefined }
  region: { normal: Region; alt: Region }
  title: string
  /** Each screen's saved cursor, as DECRC would restore it now. */
  saved: { normal: SavedView; alt: SavedView }
  /** The current character attributes (SGR, DECSCA). */
  attrs: Attrs
  /** Each screen's tab stops left of the right margin (what a snapshot restores), ascending. */
  tabs: { normal: number[]; alt: number[] }
  /** LNM (`CSI 20 h`): a line feed also returns the carriage (xterm.js's `convertEol`). */
  lnm: boolean
}

export interface TrailerSources {
  charsets?: CharsetTracker
  colors?: ColorState
  serializeNormalRow?: (absoluteRow: number) => string
}

export interface Trailer {
  prefix: string
  suffix: string
  /** Replaces the serializer's switch to the alternate screen (`SERIALIZED_ALT_SWITCH`) when it is active. */
  altSwitch?: string
}

/** What a slot block leaves behind for the caller to undo: the character sets and attributes it set. */
interface SlotBlock {
  seq: string
  charsets: CharsetState
  sgr: boolean
}

const freshKitty = (): KittyState => ({ flags: 0, mainFlags: 0, altFlags: 0, mainStack: [], altStack: [] })
/** A slot as a new buffer has it (xterm.js `Buffer`), and as RIS leaves both. */
const FRESH_SLOT: SavedCursor = Object.freeze({ x: 0, absY: 0, fg: 0, bg: 0, origin: false, wrap: true })
const NO_CHARSETS: CharsetState = Object.freeze({ charsets: [], glevel: 0 })

export class ModeTracker {
  private readonly term: TerminalApi
  private readonly hooks: Disposable[] = [] // bounded: fixed set of hooks registered in the constructor
  private kitty: KittyState = freshKitty()
  private mouseEncoding: MouseEncoding = 'default'
  private cursor: TrackedModes['cursor'] = { shape: undefined, blink: undefined }
  private region: { normal: Region; alt: Region } = { normal: null, alt: null }
  private title = ''
  private saved: { normal: SavedCursor; alt: SavedCursor } = { normal: FRESH_SLOT, alt: FRESH_SLOT }
  private attrs: Attrs = { ...DEFAULT_ATTRS }
  // bounded: one column each, at most the widest the terminal has been plus one, as xterm.js's own `Buffer.tabs`; it
  // lives and dies with its terminal
  private tabs: { normal: Set<number>; alt: Set<number> }

  constructor(term: TerminalApi) {
    this.term = term
    const p = term.parser
    const isAlt = () => term.buffer.active.type === 'alternate'
    this.tabs = { normal: this.defaultTabs(), alt: this.defaultTabs() }
    const activeTabs = () => this.tabs[isAlt() ? 'alt' : 'normal']

    this.hooks.push(
      p.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => this.decset(nums(params), true)),
      p.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => this.decset(nums(params), false)),
      // kitty keyboard: set / push / pop
      p.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
        const n = nums(params)
        const flags = n[0] ?? 0
        const mode = n.length > 1 ? n[1] || 1 : 1
        if (mode === 1) this.kitty.flags = flags
        else if (mode === 2) this.kitty.flags |= flags
        else if (mode === 3) this.kitty.flags &= ~flags
        return false
      }),
      p.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
        const stack = isAlt() ? this.kitty.altStack : this.kitty.mainStack
        if (stack.length >= KITTY_STACK_MAX) stack.shift()
        stack.push(this.kitty.flags)
        this.kitty.flags = p0(params) || 0
        return false
      }),
      p.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
        const count = Math.max(1, p0(params) || 1)
        const stack = isAlt() ? this.kitty.altStack : this.kitty.mainStack
        for (let i = 0; i < count && stack.length > 0; i++) this.kitty.flags = stack.pop() as number
        if (stack.length === 0) this.kitty.flags = 0
        return false
      }),
      // DECSCUSR
      p.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
        const ps = p0(params, 0, 1)
        if (ps === 0) this.cursor = { shape: undefined, blink: undefined }
        else {
          const shape: CursorShape | undefined = ps <= 2 ? 'block' : ps <= 4 ? 'underline' : ps <= 6 ? 'bar' : this.cursor.shape
          this.cursor = { shape, blink: ps % 2 === 1 }
        }
        return false
      }),
      // DECSTBM
      p.registerCsiHandler({ final: 'r' }, (params) => {
        const n = nums(params)
        const rows = term.rows
        const top = n[0] || 1
        const b = n[1]
        const bottom = n.length < 2 || b === undefined || b > rows || b === 0 ? rows : b
        if (bottom > top) this.region[isAlt() ? 'alt' : 'normal'] = top === 1 && bottom === rows ? null : [top - 1, bottom - 1]
        return false
      }),
      // SGR and DECSCA: the attributes a DECSC saves
      p.registerCsiHandler({ final: 'm' }, (params) => {
        applySgr(this.attrs, params)
        return false
      }),
      p.registerCsiHandler({ intermediates: '"', final: 'q' }, (params) => {
        applyProtected(this.attrs, params)
        return false
      }),
      // DECSC, SCOSC save the active screen's cursor; DECRC, SCORC restore its attributes from there
      p.registerEscHandler({ final: '7' }, () => this.saveCursor()),
      p.registerCsiHandler({ final: 's' }, () => this.saveCursor()),
      p.registerEscHandler({ final: '8' }, () => this.restoreAttrs(isAlt())),
      p.registerCsiHandler({ final: 'u' }, () => this.restoreAttrs(isAlt())),
      // DECSTR: scroll region of the active buffer, DEC private modes (cursor style), kitty state, attributes, and the
      // saved cursor's position and attributes (xterm.js leaves its origin and wrap flags, and its charsets)
      p.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
        const b = term.buffer.active
        const which = isAlt() ? 'alt' : 'normal'
        this.saved[which] = { ...this.saved[which], x: 0, absY: b.baseY, fg: 0, bg: 0 }
        this.region[which] = null
        this.kitty = freshKitty()
        this.cursor = { shape: undefined, blink: undefined }
        this.attrs = { ...DEFAULT_ATTRS }
        return false
      }),
      // RIS (new buffers: both screens' tab stops back to the default; LNM is an option, which RIS keeps)
      p.registerEscHandler({ final: 'c' }, () => {
        this.kitty = freshKitty()
        this.mouseEncoding = 'default'
        this.cursor = { shape: undefined, blink: undefined }
        this.region = { normal: null, alt: null }
        this.saved = { normal: FRESH_SLOT, alt: FRESH_SLOT }
        this.attrs = { ...DEFAULT_ATTRS }
        this.tabs = { normal: this.defaultTabs(), alt: this.defaultTabs() }
        return false
      }),
      // HTS sets a stop at the cursor's column (the pending-wrap column too); TBC 0 clears it there, TBC 3 clears all
      p.registerEscHandler({ final: 'H' }, () => {
        activeTabs().add(term.buffer.active.cursorX)
        return false
      }),
      p.registerCsiHandler({ final: 'g' }, (params) => {
        const ps = p0(params)
        if (ps === 0) activeTabs().delete(term.buffer.active.cursorX)
        else if (ps === 3) activeTabs().clear()
        return false
      }),
      p.registerOscHandler(0, (data) => {
        this.title = data
        return false
      }),
      p.registerOscHandler(2, (data) => {
        this.title = data
        return false
      }),
      term.onResize(({ cols }) => {
        this.region = { normal: null, alt: null }
        const clamp = (s: SavedCursor) => (s.x > cols - 1 ? { ...s, x: cols - 1 } : s)
        this.saved = { normal: clamp(this.saved.normal), alt: clamp(this.saved.alt) }
        layTabs(this.tabs.normal, cols, this.tabWidth())
        layTabs(this.tabs.alt, cols, this.tabWidth())
      }),
    )
  }

  /**
   * The cursor as xterm.js saves it (`saveCursor`), into a screen's slot. `at` overrides what the terminal shows for
   * a save inside a DECSET whose earlier params already moved the cursor or changed the modes (they apply after hooks).
   */
  private saveCursor(at: { alt?: boolean; x?: number; y?: number; origin?: boolean; wrap?: boolean } = {}): boolean {
    const b = this.term.buffer.active
    const m = this.term.modes
    const alt = at.alt ?? b.type === 'alternate'
    const base = alt ? 0 : this.term.buffer.normal.baseY
    const { fg, bg } = this.attrs
    this.saved[alt ? 'alt' : 'normal'] = { x: at.x ?? b.cursorX, absY: base + (at.y ?? b.cursorY), fg, bg, origin: at.origin ?? m.originMode, wrap: at.wrap ?? m.wraparoundMode }
    return false
  }

  /** DECRC's attribute half (`restoreCursor`): fg and bg come back from the slot, the extended attributes stay. */
  private restoreAttrs(alt: boolean): boolean {
    const s = this.saved[alt ? 'alt' : 'normal']
    this.attrs.fg = s.fg
    this.attrs.bg = s.bg
    return false
  }

  private decset(params: number[], set: boolean): boolean {
    let alt = this.term.buffer.active.type === 'alternate'
    // xterm.js applies the params in order, after this hook: origin, auto-wrap and the cursor as each param finds them
    let origin = this.term.modes.originMode
    let wrap = this.term.modes.wraparoundMode
    let at: { x: number; y: number } | null = null
    const save = () => this.saveCursor({ alt, origin, wrap, ...at })
    const restore = () => {
      this.restoreAttrs(alt)
      const v = this.savedView(alt ? 'alt' : 'normal')
      origin = v.origin
      wrap = v.wrap
      at = { x: v.x, y: v.y }
    }
    for (const p of params) {
      switch (p) {
        case 6:
          // DECOM homes the cursor: to the region's top row when it turns on
          origin = set
          at = { x: 0, y: set ? (this.region[alt ? 'alt' : 'normal']?.[0] ?? 0) : 0 }
          break
        case 7:
          wrap = set
          break
        case 1048:
          if (set) save()
          else restore()
          break
        case 47:
        case 1047:
        case 1049:
          // 1049 saves the cursor first, into the screen still active (xterm.js: saveCursor, then the switch)
          if (set && p === 1049) save()
          // xterm.js swaps unconditionally, even when the buffer does not change
          if (set) {
            this.kitty.mainFlags = this.kitty.flags
            this.kitty.flags = this.kitty.altFlags
            alt = true
          } else {
            this.kitty.altFlags = this.kitty.flags
            this.kitty.flags = this.kitty.mainFlags
            // the alt buffer is cleared when it is left: its scroll region and its tab stops
            if (alt) {
              this.region.alt = null
              this.tabs.alt = this.defaultTabs()
            }
            alt = false
            // 1049 restores the main screen's cursor after the switch
            if (p === 1049) restore()
          }
          break
        case 1006:
          this.mouseEncoding = set ? 'sgr' : 'default'
          break
        case 1016:
          this.mouseEncoding = set ? 'sgrPixels' : 'default'
          break
      }
    }
    return false
  }

  /** Current tracked state (a copy). */
  state(): TrackedModes {
    const k = this.kitty
    return {
      kitty: { ...k, mainStack: [...k.mainStack], altStack: [...k.altStack] },
      mouseEncoding: this.mouseEncoding,
      cursor: { ...this.cursor },
      region: { ...this.region },
      title: this.title,
      saved: { normal: this.savedView('normal'), alt: this.savedView('alt') },
      attrs: { ...this.attrs },
      tabs: { normal: this.visibleTabs('normal'), alt: this.visibleTabs('alt') },
      lnm: this.term.options.convertEol === true,
    }
  }

  private tabWidth(): number {
    return this.term.options.tabStopWidth
  }

  /** A new buffer's stops (`Buffer.setupTabStops()`): every `tabStopWidth` columns from the first. */
  private defaultTabs(): Set<number> {
    const tabs = new Set<number>()
    const w = this.tabWidth()
    for (let x = 0; x < this.term.cols; x += w) tabs.add(x)
    return tabs
  }

  /** A screen's stops left of the right margin, ascending. */
  private visibleTabs(which: 'normal' | 'alt'): number[] {
    return [...this.tabs[which]].filter((x) => x < this.term.cols).sort((a, b) => a - b)
  }

  /**
   * Sets a screen's stops left of the right margin on the fresh terminal, where they are the default ones; empty when
   * they are the default ones already. Moves the cursor along its row and back to the first column.
   */
  private tabsBlock(which: 'normal' | 'alt'): string {
    const stops = this.visibleTabs(which)
    const w = this.tabWidth()
    if (stops.length === Math.ceil(this.term.cols / w) && stops.every((x, i) => x === i * w)) return ''
    return `\x1b[3g${stops.map((x) => `\x1b[${x + 1}G\x1bH`).join('')}\r`
  }

  /**
   * A screen's saved cursor as DECRC would restore it now: xterm.js clamps the row at the top of the viewport, and the
   * column (and the row, below) to the screen.
   */
  private savedView(which: 'normal' | 'alt'): SavedView {
    const s = this.saved[which]
    const base = which === 'normal' ? this.term.buffer.normal.baseY : 0
    return { x: Math.min(s.x, this.term.cols - 1), y: Math.min(Math.max(s.absY - base, 0), this.term.rows - 1), fg: s.fg, bg: s.bg, origin: s.origin, wrap: s.wrap }
  }

  /**
   * Rebuilds a screen's saved cursor on the fresh terminal (on that screen, with no scroll region set yet or one that
   * is set again later): its modes, character sets and attributes, then the position and DECSC. `now` is the state the
   * fresh terminal is in at that point: its attributes and origin / auto-wrap modes (its character sets are the
   * defaults). The modes are put back; the character sets and attributes are the caller's to undo (`SlotBlock`).
   * Null when the slot is what a new buffer has.
   */
  private slotBlock(which: 'normal' | 'alt', charsets: CharsetTracker | undefined, now: { attrs: Attrs; origin: boolean; wrap: boolean }): SlotBlock | null {
    const v = this.savedView(which)
    const cs = charsets ? charsets.saved(which) : NO_CHARSETS
    if (v.x === 0 && v.y === 0 && v.fg === 0 && v.bg === 0 && !v.origin && v.wrap && cs.charsets.length === 0 && cs.glevel === 0) return null
    const sgr = (v.fg | 0) !== (now.attrs.fg | 0) || (v.bg | 0) !== (now.attrs.bg | 0)
    // with origin mode on, CUP is relative to the region and clamped to it: the whole screen for the save
    let seq = v.origin ? `\x1b[r${now.origin ? '' : '\x1b[?6h'}` : now.origin ? '\x1b[?6l' : ''
    if (v.wrap !== now.wrap) seq += v.wrap ? '\x1b[?7h' : '\x1b[?7l'
    seq += charsetSequence(cs)
    if (sgr) seq += sgrOf({ ...DEFAULT_ATTRS, fg: v.fg, bg: v.bg }, false)
    seq += `\x1b[${v.y + 1};${v.x + 1}H\x1b7`
    if (v.origin !== now.origin) seq += now.origin ? '\x1b[?6h' : '\x1b[?6l'
    if (v.wrap !== now.wrap) seq += now.wrap ? '\x1b[?7h' : '\x1b[?7l'
    return { seq, charsets: cs, sgr }
  }

  get currentTitle(): string {
    return this.title
  }

  /**
   * Trailer for the current state. `charsets` and `colors` are the mirror's byte-ordered charset tracker and colour
   * state (the mirror's colour responders own colour sets); `serializeNormalRow` is the serializer's range mode
   * for one row of the main screen (absolute line index). All are optional for terminals that do not track them.
   */
  trailer(extra: TrailerSources = {}): Trailer {
    const term = this.term
    const m = term.modes
    const altActive = term.buffer.active.type === 'alternate'
    const k = this.kitty
    const cs = extra.charsets
    const fresh = { attrs: DEFAULT_ATTRS, origin: false, wrap: true }
    /** Back to the default character sets after a slot block designated some. */
    const charsetsBack = (b: SlotBlock) => charsetSequence(NO_CHARSETS, b.charsets.charsets.length, b.charsets.glevel !== 0)

    let prefix = ''
    let suffix = ''
    let altSwitch: string | undefined
    // The active screen's flags slot (mainFlags on the main screen, altFlags on the alternate) is what a switch away
    // overwrites, but a leave without an enter reads it (xterm.js swaps unconditionally): it is rebuilt too, by a switch
    // with those flags current.
    if (altActive) {
      // the main screen's tab stops, while the fresh terminal is on it
      prefix += this.tabsBlock('normal')
      // the alternate screen's slot: leaving the alternate screen with those flags current stores them there
      if (k.altFlags) prefix += `\x1b[?47h\x1b[=${k.altFlags};1u\x1b[?47l\x1b[H`
      prefix += kittyBuild(k.mainStack, k.mainFlags)
      // after the main content, whose last SGR set the current attributes
      const slot = this.slotBlock('normal', cs, { ...fresh, attrs: this.attrs })
      const main = this.region.normal
      altSwitch = `${slot ? slot.seq + charsetsBack(slot) : ''}\x1b[0m${main ? `\x1b[${main[0] + 1};${main[1] + 1}r` : ''}\x1b[?1047h\x1b[H`
      suffix += kittyBuild(k.altStack, k.flags, k.altFlags !== 0)
    } else {
      const alt = kittyBuild(k.altStack, k.altFlags)
      const slot = this.slotBlock('alt', cs, fresh)
      // build the alternate screen's stack and saved cursor on the fresh terminal, then come back (alt is empty there,
      // nothing lost) with the defaults the serialized content starts from, and home the cursor: leaving copies the
      // alternate screen's cursor to the main one, and the serialized content starts at the top left. Entering with the
      // main screen's slot flags current stores them there.
      const mainSlot = k.mainFlags ? `\x1b[=${k.mainFlags};1u` : ''
      if (alt || slot || mainSlot) prefix += `${mainSlot}\x1b[?47h${alt}${slot ? slot.seq + charsetsBack(slot) + (slot.sgr ? '\x1b[0m' : '') : ''}\x1b[?47l\x1b[H`
      prefix += kittyBuild(k.mainStack, k.flags, k.mainFlags !== 0)
    }

    // the active screen's tab stops (the cursor is placed below), then its saved cursor, after the serialized content:
    // its attributes, modes and scroll region are the current ones (the region is set again below)
    suffix += this.tabsBlock(altActive ? 'alt' : 'normal')
    const slot = this.slotBlock(altActive ? 'alt' : 'normal', cs, { attrs: this.attrs, origin: m.originMode, wrap: m.wraparoundMode })
    if (slot) suffix += slot.seq + charsetsBack(slot)

    if (extra.colors) suffix += extra.colors.trailer()
    const style = cursorStyleParam(this.cursor)
    if (style !== undefined) suffix += `\x1b[${style} q`
    if (this.title) suffix += `\x1b]2;${this.title}\x1b\\`

    if (m.applicationCursorKeysMode) suffix += '\x1b[?1h'
    if (m.applicationKeypadMode) suffix += '\x1b='
    if (m.bracketedPasteMode) suffix += '\x1b[?2004h'
    if (m.insertMode) suffix += '\x1b[4h'
    suffix += term.options.convertEol ? '\x1b[20h' : '\x1b[20l'
    if (m.reverseWraparoundMode) suffix += '\x1b[?45h'
    if (m.sendFocusMode) suffix += '\x1b[?1004h'
    if (!m.wraparoundMode) suffix += '\x1b[?7l'
    const mouse = { none: '', x10: '\x1b[?9h', vt200: '\x1b[?1000h', drag: '\x1b[?1002h', any: '\x1b[?1003h' }[m.mouseTrackingMode]
    suffix += mouse
    if (this.mouseEncoding === 'sgr') suffix += '\x1b[?1006h'
    else if (this.mouseEncoding === 'sgrPixels') suffix += '\x1b[?1016h'
    if (!m.showCursor) suffix += '\x1b[?25l'

    // DECSTBM → DECOM → CUP: each of the first two homes the cursor, so the explicit position comes last
    const region = this.region[altActive ? 'alt' : 'normal']
    if (region) suffix += `\x1b[${region[0] + 1};${region[1] + 1}r`
    if (m.originMode) suffix += '\x1b[?6h'
    const buf = term.buffer.active
    const row = m.originMode ? buf.cursorY - (region ? region[0] : 0) + 1 : buf.cursorY + 1
    // (not in origin mode: xterm.js offsets relative moves by the region top there, and the row uses CUF for gaps)
    if (buf.cursorX >= term.cols && !altActive && !m.originMode && extra.serializeNormalRow) {
      // pending wrap: reprint the row from its first column with default attributes (and insert mode off); the range
      // serializer ends on the last cell and restores the current attributes
      const insertOff = m.insertMode ? '\x1b[4l' : ''
      const insertOn = m.insertMode ? '\x1b[4h' : ''
      suffix += `\x1b[${row};1H${insertOff}\x1b[0m${extra.serializeNormalRow(buf.baseY + buf.cursorY)}${insertOn}`
    } else {
      suffix += `\x1b[${row};${Math.min(buf.cursorX, term.cols - 1) + 1}H`
    }
    // last: the serialized text, and any reprinted row, are what the cells hold, not what to translate; and the
    // current attributes in full: the serializer restores only what shows in a cell (an underline colour set before
    // the underline is not), and writes no DECSCA
    if (cs) suffix += cs.trailer()
    if (slot?.sgr || !sameAttrs(this.attrs, DEFAULT_ATTRS)) suffix += sgrOf(this.attrs)
    return { prefix, suffix, altSwitch }
  }

  dispose(): void {
    disposeAll(this.hooks.splice(0))
  }
}

/**
 * Sequences that leave the active screen with `stack` below and `flags` on top, starting from an empty stack and, unless
 * `force`, zero flags.
 */
function kittyBuild(stack: readonly number[], flags: number, force = false): string {
  if (stack.length === 0) return flags || force ? `\x1b[=${flags};1u` : ''
  let s = `\x1b[=${stack[0]};1u`
  for (let i = 1; i < stack.length; i++) s += `\x1b[>${stack[i]}u`
  return s + `\x1b[>${flags}u`
}

function cursorStyleParam(c: TrackedModes['cursor']): number | undefined {
  if (c.shape === undefined && c.blink === undefined) return undefined
  const steady = c.blink ? 0 : 1
  switch (c.shape) {
    case 'block':
      return 1 + steady
    case 'underline':
      return 3 + steady
    case 'bar':
      return 5 + steady
    default:
      // blink set without a shape (xterm.js accepts DECSCUSR 7+ that way): 7 blinks, 8 does not
      return 7 + steady
  }
}

/**
 * A resize's stops (`Buffer.setupTabStops(cols)`): unless the new width is itself a stop, from the nearest stop left of
 * it (`prevStop`, or the first column) every `width` columns up to the new width. Stops past it stay.
 */
function layTabs(tabs: Set<number>, cols: number, width: number): void {
  let i = cols
  if (!tabs.has(i)) {
    i = cols - 1
    while (i > 0 && !tabs.has(i)) i--
  }
  for (; i < cols; i += width) tabs.add(i)
}

/** What `@xterm/addon-serialize` writes before the alternate screen's content. */
export const SERIALIZED_ALT_SWITCH = '\x1b[?1049h\x1b[H'

/**
 * The full snapshot string, for checkpoints, a stream's skip-ahead and a renderer attaching. Write it into a fresh
 * terminal.
 */
export function composeSnapshot(serialized: string, trailer: Trailer): string {
  let body = serialized
  if (trailer.altSwitch !== undefined) {
    const at = serialized.lastIndexOf(SERIALIZED_ALT_SWITCH)
    if (at >= 0) body = serialized.slice(0, at) + trailer.altSwitch + serialized.slice(at + SERIALIZED_ALT_SWITCH.length)
  }
  return trailer.prefix + body + trailer.suffix
}
