// Portions ported from xterm.js (MIT, © The xterm.js authors): see THIRD_PARTY_NOTICES.md.
//
// Ground-state scanner and the byte-ordered part of the mode trailer.
//
// A checkpoint or snapshot may only be cut where xterm.js's parser is idle: no partial UTF-8 character, no escape
// sequence in progress, no synchronized-output (DEC 2026) block open. `VtScanner` runs the same state machine as
// xterm.js — the transition table below is a port of `common/parser/EscapeSequenceParser.ts#VT500_TRANSITION_TABLE`
// and the decoder of `common/input/TextDecoder.ts#Utf8ToUtf32` at the pinned commit — over the same bytes the mirror
// parses, so the two agree on where every sequence ends.
//
// Character sets (G0–G3 designations, GL shifts incl. SI/SO, and their DECSC/DECRC save slots) are tracked here
// rather than by parser hooks, because SI/SO are C0 controls and xterm.js's public parser API cannot hook C0. Feed the
// scanner each chunk after the mirror has parsed it (its write callback), so scanner state and mirror state always
// describe the same seq.

// ParserState (xterm.js common/parser/Constants.ts)
const GROUND = 0
const ESCAPE = 1
const ESCAPE_INTERMEDIATE = 2
const CSI_ENTRY = 3
const CSI_PARAM = 4
const CSI_INTERMEDIATE = 5
const CSI_IGNORE = 6
const SOS_PM_STRING = 7
const OSC_STRING = 8
const DCS_ENTRY = 9
const DCS_PARAM = 10
const DCS_IGNORE = 11
const DCS_INTERMEDIATE = 12
const DCS_PASSTHROUGH = 13
const APC_ENTRY = 14
const APC_INTERMEDIATE = 15
const APC_PASSTHROUGH = 16
const STATE_LENGTH = 17

// ParserAction
const IGNORE = 0
const ERROR = 1
const PRINT = 2
const EXECUTE = 3
const OSC_START = 4
const OSC_PUT = 5
const OSC_END = 6
const CSI_DISPATCH = 7
const PARAM = 8
const COLLECT = 9
const ESC_DISPATCH = 10
const CLEAR = 11
const DCS_HOOK = 12
const DCS_PUT = 13
const DCS_UNHOOK = 14
const APC_START = 15
const APC_PUT = 16
const APC_END = 17

const NON_ASCII_PRINTABLE = 0xa0
const ACTION_SHIFT = 8
const STATE_MASK = 255
const INDEX_STATE_SHIFT = 8

/** Port of VT500_TRANSITION_TABLE: same construction, same order (later rules override earlier ones). */
const TABLE: Uint16Array = (() => {
  const table = new Uint16Array(((STATE_LENGTH - 1) << INDEX_STATE_SHIFT) | (NON_ASCII_PRINTABLE + 1))
  const add = (code: number, state: number, action: number, next: number) => {
    table[(state << INDEX_STATE_SHIFT) | code] = (action << ACTION_SHIFT) | next
  }
  const addMany = (codes: number[], state: number, action: number, next: number) => {
    for (const c of codes) add(c, state, action, next)
  }
  const r = (start: number, end: number): number[] => Array.from({ length: end - start }, (_, i) => start + i)
  const PRINTABLES = r(0x20, 0x7f)
  const EXECUTABLES = [...r(0x00, 0x18), 0x19, ...r(0x1c, 0x20)]
  const states = r(GROUND, STATE_LENGTH)

  table.fill((ERROR << ACTION_SHIFT) | GROUND)
  addMany(PRINTABLES, GROUND, PRINT, GROUND)
  for (const state of states) {
    addMany([0x18, 0x1a, 0x99, 0x9a], state, EXECUTE, GROUND)
    addMany(r(0x80, 0x90), state, EXECUTE, GROUND)
    addMany(r(0x90, 0x98), state, EXECUTE, GROUND)
    add(0x9c, state, IGNORE, GROUND)
    add(0x1b, state, CLEAR, ESCAPE)
    add(0x9d, state, OSC_START, OSC_STRING)
    addMany([0x98, 0x9e], state, IGNORE, SOS_PM_STRING)
    add(0x9f, state, CLEAR, APC_ENTRY)
    add(0x9b, state, CLEAR, CSI_ENTRY)
    add(0x90, state, CLEAR, DCS_ENTRY)
  }
  addMany(EXECUTABLES, GROUND, EXECUTE, GROUND)
  addMany(EXECUTABLES, ESCAPE, EXECUTE, ESCAPE)
  add(0x7f, ESCAPE, IGNORE, ESCAPE)
  addMany(EXECUTABLES, OSC_STRING, IGNORE, OSC_STRING)
  addMany(EXECUTABLES, CSI_ENTRY, EXECUTE, CSI_ENTRY)
  add(0x7f, CSI_ENTRY, IGNORE, CSI_ENTRY)
  addMany(EXECUTABLES, CSI_PARAM, EXECUTE, CSI_PARAM)
  add(0x7f, CSI_PARAM, IGNORE, CSI_PARAM)
  addMany(EXECUTABLES, CSI_IGNORE, EXECUTE, CSI_IGNORE)
  addMany(EXECUTABLES, CSI_INTERMEDIATE, EXECUTE, CSI_INTERMEDIATE)
  add(0x7f, CSI_INTERMEDIATE, IGNORE, CSI_INTERMEDIATE)
  addMany(EXECUTABLES, ESCAPE_INTERMEDIATE, EXECUTE, ESCAPE_INTERMEDIATE)
  add(0x7f, ESCAPE_INTERMEDIATE, IGNORE, ESCAPE_INTERMEDIATE)
  // osc
  add(0x5d, ESCAPE, OSC_START, OSC_STRING)
  addMany(PRINTABLES, OSC_STRING, OSC_PUT, OSC_STRING)
  add(0x7f, OSC_STRING, OSC_PUT, OSC_STRING)
  addMany([0x9c, 0x1b, 0x18, 0x1a, 0x07], OSC_STRING, OSC_END, GROUND)
  addMany(r(0x1c, 0x20), OSC_STRING, IGNORE, OSC_STRING)
  // sos/pm
  addMany([0x58, 0x5e], ESCAPE, IGNORE, SOS_PM_STRING)
  addMany(PRINTABLES, SOS_PM_STRING, IGNORE, SOS_PM_STRING)
  addMany(EXECUTABLES, SOS_PM_STRING, IGNORE, SOS_PM_STRING)
  add(0x9c, SOS_PM_STRING, IGNORE, GROUND)
  add(0x7f, SOS_PM_STRING, IGNORE, SOS_PM_STRING)
  // apc
  add(0x5f, ESCAPE, CLEAR, APC_ENTRY)
  addMany(EXECUTABLES, APC_ENTRY, IGNORE, APC_ENTRY)
  add(0x7f, APC_ENTRY, IGNORE, APC_ENTRY)
  addMany(r(0x20, 0x30), APC_ENTRY, COLLECT, APC_INTERMEDIATE)
  addMany(r(0x30, 0x7f), APC_ENTRY, APC_START, APC_PASSTHROUGH)
  addMany(r(0x30, 0x7f), APC_INTERMEDIATE, APC_START, APC_PASSTHROUGH)
  addMany(EXECUTABLES, APC_INTERMEDIATE, IGNORE, APC_INTERMEDIATE)
  addMany(r(0x20, 0x30), APC_INTERMEDIATE, COLLECT, APC_INTERMEDIATE)
  add(0x7f, APC_INTERMEDIATE, IGNORE, APC_INTERMEDIATE)
  addMany(PRINTABLES, APC_PASSTHROUGH, APC_PUT, APC_PASSTHROUGH)
  addMany(EXECUTABLES, APC_PASSTHROUGH, IGNORE, APC_PASSTHROUGH)
  addMany(r(0x08, 0x0e), APC_PASSTHROUGH, APC_PUT, APC_PASSTHROUGH)
  add(0x7f, APC_PASSTHROUGH, IGNORE, APC_PASSTHROUGH)
  addMany([0x1b, 0x9c, 0x18, 0x1a], APC_PASSTHROUGH, APC_END, GROUND)
  // csi entries
  add(0x5b, ESCAPE, CLEAR, CSI_ENTRY)
  addMany(r(0x40, 0x7f), CSI_ENTRY, CSI_DISPATCH, GROUND)
  addMany(r(0x30, 0x3c), CSI_ENTRY, PARAM, CSI_PARAM)
  addMany([0x3c, 0x3d, 0x3e, 0x3f], CSI_ENTRY, COLLECT, CSI_PARAM)
  addMany(r(0x30, 0x3c), CSI_PARAM, PARAM, CSI_PARAM)
  addMany(r(0x40, 0x7f), CSI_PARAM, CSI_DISPATCH, GROUND)
  addMany([0x3c, 0x3d, 0x3e, 0x3f], CSI_PARAM, IGNORE, CSI_IGNORE)
  addMany(r(0x20, 0x40), CSI_IGNORE, IGNORE, CSI_IGNORE)
  add(0x7f, CSI_IGNORE, IGNORE, CSI_IGNORE)
  addMany(r(0x40, 0x7f), CSI_IGNORE, IGNORE, GROUND)
  addMany(r(0x20, 0x30), CSI_ENTRY, COLLECT, CSI_INTERMEDIATE)
  addMany(r(0x20, 0x30), CSI_INTERMEDIATE, COLLECT, CSI_INTERMEDIATE)
  addMany(r(0x30, 0x40), CSI_INTERMEDIATE, IGNORE, CSI_IGNORE)
  addMany(r(0x40, 0x7f), CSI_INTERMEDIATE, CSI_DISPATCH, GROUND)
  addMany(r(0x20, 0x30), CSI_PARAM, COLLECT, CSI_INTERMEDIATE)
  // esc_intermediate
  addMany(r(0x20, 0x30), ESCAPE, COLLECT, ESCAPE_INTERMEDIATE)
  addMany(r(0x20, 0x30), ESCAPE_INTERMEDIATE, COLLECT, ESCAPE_INTERMEDIATE)
  addMany(r(0x30, 0x7f), ESCAPE_INTERMEDIATE, ESC_DISPATCH, GROUND)
  addMany(r(0x30, 0x50), ESCAPE, ESC_DISPATCH, GROUND)
  addMany(r(0x51, 0x58), ESCAPE, ESC_DISPATCH, GROUND)
  addMany([0x59, 0x5a, 0x5c], ESCAPE, ESC_DISPATCH, GROUND)
  addMany(r(0x60, 0x7f), ESCAPE, ESC_DISPATCH, GROUND)
  // dcs entry
  add(0x50, ESCAPE, CLEAR, DCS_ENTRY)
  addMany(EXECUTABLES, DCS_ENTRY, IGNORE, DCS_ENTRY)
  add(0x7f, DCS_ENTRY, IGNORE, DCS_ENTRY)
  addMany(r(0x20, 0x30), DCS_ENTRY, COLLECT, DCS_INTERMEDIATE)
  addMany(r(0x30, 0x3c), DCS_ENTRY, PARAM, DCS_PARAM)
  addMany([0x3c, 0x3d, 0x3e, 0x3f], DCS_ENTRY, COLLECT, DCS_PARAM)
  addMany(EXECUTABLES, DCS_IGNORE, IGNORE, DCS_IGNORE)
  addMany(r(0x20, 0x80), DCS_IGNORE, IGNORE, DCS_IGNORE)
  addMany(EXECUTABLES, DCS_PARAM, IGNORE, DCS_PARAM)
  add(0x7f, DCS_PARAM, IGNORE, DCS_PARAM)
  addMany(r(0x30, 0x3c), DCS_PARAM, PARAM, DCS_PARAM)
  addMany([0x3c, 0x3d, 0x3e, 0x3f], DCS_PARAM, IGNORE, DCS_IGNORE)
  addMany(r(0x20, 0x30), DCS_PARAM, COLLECT, DCS_INTERMEDIATE)
  addMany(EXECUTABLES, DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE)
  add(0x7f, DCS_INTERMEDIATE, IGNORE, DCS_INTERMEDIATE)
  addMany(r(0x20, 0x30), DCS_INTERMEDIATE, COLLECT, DCS_INTERMEDIATE)
  addMany(r(0x30, 0x40), DCS_INTERMEDIATE, IGNORE, DCS_IGNORE)
  addMany(r(0x40, 0x7f), DCS_INTERMEDIATE, DCS_HOOK, DCS_PASSTHROUGH)
  addMany(r(0x40, 0x7f), DCS_PARAM, DCS_HOOK, DCS_PASSTHROUGH)
  addMany(r(0x40, 0x7f), DCS_ENTRY, DCS_HOOK, DCS_PASSTHROUGH)
  addMany(EXECUTABLES, DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH)
  addMany(PRINTABLES, DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH)
  add(0x7f, DCS_PASSTHROUGH, IGNORE, DCS_PASSTHROUGH)
  addMany([0x1b, 0x9c, 0x18, 0x1a], DCS_PASSTHROUGH, DCS_UNHOOK, GROUND)
  // unicode
  add(NON_ASCII_PRINTABLE, GROUND, PRINT, GROUND)
  add(NON_ASCII_PRINTABLE, OSC_STRING, OSC_PUT, OSC_STRING)
  add(NON_ASCII_PRINTABLE, CSI_IGNORE, IGNORE, CSI_IGNORE)
  add(NON_ASCII_PRINTABLE, DCS_IGNORE, IGNORE, DCS_IGNORE)
  add(NON_ASCII_PRINTABLE, DCS_PASSTHROUGH, DCS_PUT, DCS_PASSTHROUGH)
  add(NON_ASCII_PRINTABLE, APC_PASSTHROUGH, APC_PUT, APC_PASSTHROUGH)
  return table
})()

/** xterm.js `Params`: at most 32 params, values clamped to 2^31 − 1. */
const MAX_PARAMS = 32
const MAX_PARAM_VALUE = 0x7fffffff
/**
 * xterm.js keeps the private prefix and intermediates in one 32-bit int, so only the last 4 survive; keeping the same
 * last 4 bounds `collect` against a flood of intermediates without changing what dispatches.
 */
const MAX_COLLECT = 4

/** Sequences the scanner dispatches (only what the charset tracker and the 2026 tracker need). */
export interface VtListener {
  execute?(code: number): void
  /** `collect` = intermediates (0x20–0x2f) */
  esc?(collect: string, final: string): void
  /** `collect` = private prefix (`<=>?`) followed by intermediates; params as xterm.js reports them (empty → [0]) */
  csi?(collect: string, params: readonly number[], final: string): void
}

export class VtScanner {
  private state = GROUND
  // UTF-8 decoder (Utf8ToUtf32): pending continuation bytes
  private need = 0
  private len = 0
  private cp = 0
  // sequence being collected
  private collect = '' // bounded: MAX_COLLECT chars (xterm.js's 32-bit collect)
  private params: number[] = [] // bounded: MAX_PARAMS (xterm.js Params)
  private inSubParam = false
  private sync = false
  private readonly listeners: VtListener[] = [] // bounded: fixed at construction (the charset and 2026 trackers)

  addListener(l: VtListener): void {
    this.listeners.push(l)
  }

  /**
   * True when a checkpoint or snapshot may be cut after the bytes fed so far: no partial UTF-8 character, parser in
   * GROUND, and no synchronized-output block open.
   */
  get atGround(): boolean {
    return this.need === 0 && this.state === GROUND && !this.sync
  }
  /** The parser state alone (for tests and diagnostics). */
  get parserIdle(): boolean {
    return this.need === 0 && this.state === GROUND
  }
  get syncOpen(): boolean {
    return this.sync
  }

  feed(data: Uint8Array): void {
    const n = data.length
    for (let i = 0; i < n; i++) {
      const b = data[i] as number
      if (this.need === 0) {
        if (b < 0x80) {
          // ASCII fast path in GROUND: printables never change state
          if (this.state === GROUND && b >= 0x20 && b < 0x7f) continue
          this.step(b)
        } else if ((b & 0xe0) === 0xc0) {
          this.need = 1
          this.len = 2
          this.cp = b & 0x1f
        } else if ((b & 0xf0) === 0xe0) {
          this.need = 2
          this.len = 3
          this.cp = b & 0x0f
        } else if ((b & 0xf8) === 0xf0) {
          this.need = 3
          this.len = 4
          this.cp = b & 0x07
        }
        // else: illegal byte, skipped (as xterm.js does)
        continue
      }
      if ((b & 0xc0) !== 0x80) {
        // wrong continuation: the pending bytes are dropped and this byte starts afresh
        this.need = 0
        i--
        continue
      }
      this.cp = (this.cp << 6) | (b & 0x3f)
      if (--this.need > 0) continue
      const cp = this.cp
      // overlong, surrogate, BOM and out-of-range codepoints are dropped, as xterm.js does
      if (this.len === 2 && cp < 0x80) continue
      if (this.len === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfeff)) continue
      if (this.len === 4 && (cp < 0x10000 || cp > 0x10ffff)) continue
      this.step(cp)
    }
  }

  /** As after RIS on a fresh terminal. */
  reset(): void {
    this.state = GROUND
    this.need = 0
    this.collect = ''
    this.params = []
    this.sync = false
  }

  private step(code: number): void {
    if (code < 0x18 && this.state <= CSI_IGNORE) {
      this.execute(code)
      return
    }
    let t = TABLE[(this.state << INDEX_STATE_SHIFT) | (code < NON_ASCII_PRINTABLE ? code : NON_ASCII_PRINTABLE)] as number
    switch (t >> ACTION_SHIFT) {
      case EXECUTE:
        this.execute(code)
        break
      case CSI_DISPATCH:
        this.dispatchCsi(String.fromCharCode(code))
        break
      case ESC_DISPATCH:
        this.dispatchEsc(String.fromCharCode(code))
        break
      case PARAM:
        this.param(code)
        break
      case COLLECT:
        this.collect = this.collect.length < MAX_COLLECT ? this.collect + String.fromCharCode(code) : this.collect.slice(1) + String.fromCharCode(code)
        break
      case CLEAR:
        this.collect = ''
        this.params = []
        this.inSubParam = false
        break
      case OSC_END:
      case DCS_UNHOOK:
      case APC_END:
        if (code === 0x1b) t |= ESCAPE
        this.collect = ''
        this.params = []
        break
      // PRINT, IGNORE, ERROR, OSC_START/PUT, DCS_HOOK/PUT, APC_START/PUT: no state of interest
    }
    this.state = t & STATE_MASK
  }

  private param(code: number): void {
    if (this.params.length === 0) this.params.push(0)
    if (code === 0x3b) {
      this.inSubParam = false
      if (this.params.length < MAX_PARAMS) this.params.push(0)
      return
    }
    if (code === 0x3a) {
      this.inSubParam = true
      return
    }
    if (this.inSubParam) return
    const last = this.params.length - 1
    this.params[last] = Math.min((this.params[last] as number) * 10 + (code - 0x30), MAX_PARAM_VALUE)
  }

  private execute(code: number): void {
    for (const l of this.listeners) l.execute?.(code)
  }

  private dispatchEsc(final: string): void {
    const collect = this.collect
    if (collect === '' && final === 'c') this.sync = false // RIS
    for (const l of this.listeners) l.esc?.(collect, final)
  }

  private dispatchCsi(final: string): void {
    const collect = this.collect
    const params = this.params.length ? this.params : [0]
    if (collect === '?' && (final === 'h' || final === 'l')) {
      for (const p of params) if (p === 2026) this.sync = final === 'h'
    } else if (collect === '!' && final === 'p') this.sync = false // DECSTR resets DEC private modes
    for (const l of this.listeners) l.csi?.(collect, params, final)
    this.inSubParam = false
  }
}

// ── character sets (G0–G3, GL, DECSC slots) ────────────────────────────────────────────────────────────────

/** Designation finals xterm.js knows (`CHARSETS`); `B` (US ASCII) is the default. */
const CHARSET_FINALS = new Set(['0', 'A', 'B', '4', 'C', '5', 'R', 'Q', 'K', 'Y', 'E', '6', 'Z', 'H', '7', '='])
/** xterm.js `GLEVEL` (`/` is accepted and ignored) */
const GLEVEL: Record<string, number> = { '(': 0, ')': 1, '*': 2, '+': 3, '-': 1, '.': 2 }
const DESIGNATOR = ['(', ')', '*', '+']

type Charsets = (string | undefined)[]
interface SavedCharsets {
  charsets: Charsets
  glevel: number
}

/** A charset table with its exact length (xterm.js's `CharsetService.charsets` or a DECSC slot's copy) and GL level. */
export interface CharsetState {
  charsets: (string | undefined)[]
  glevel: number
}

export interface CharsetSnapshot {
  /** Designation final per G0…G3; undefined = default (US ASCII) */
  charsets: readonly (string | undefined)[]
  glevel: number
}

/**
 * Mirrors xterm.js's CharsetService plus the per-buffer DECSC slots that save it (`Buffer.savedCharsets/savedGlevel`).
 * The live table goes into the trailer; the DECSC slots go into the trailer's saved-cursor restore.
 */
export class CharsetTracker implements VtListener {
  private charsets: Charsets = []
  private glevel = 0
  private alt = false
  private slots: { main: SavedCharsets; alt: SavedCharsets } = { main: { charsets: [], glevel: 0 }, alt: { charsets: [], glevel: 0 } }

  snapshot(): CharsetSnapshot {
    return { charsets: [0, 1, 2, 3].map((g) => this.charsets[g]), glevel: this.glevel }
  }

  /** The live table as xterm.js holds it: one entry per G set designated since the last reset (its length matters to DECRC). */
  state(): CharsetState {
    return { charsets: Array.from(this.charsets), glevel: this.glevel }
  }

  /** A screen's DECSC slot: the table and GL level a DECRC on that screen brings back. */
  saved(which: 'normal' | 'alt'): CharsetState {
    const s = this.slots[which === 'normal' ? 'main' : 'alt']
    return { charsets: Array.from(s.charsets), glevel: s.glevel }
  }

  /** Sequences that put a fresh terminal into this charset state. */
  trailer(): string {
    return charsetSequence(this.state())
  }

  execute(code: number): void {
    if (code === 0x0e) this.glevel = 1 // SO
    else if (code === 0x0f) this.glevel = 0 // SI
  }

  esc(collect: string, final: string): void {
    if (collect === '') {
      switch (final) {
        case 'c':
          this.reset()
          return
        case '7':
          this.save()
          return
        case '8':
          this.restore()
          return
        case 'n':
        case '}':
          this.glevel = 2
          return
        case 'o':
        case '|':
          this.glevel = 3
          return
        case '~':
          this.glevel = 1
          return
      }
      return
    }
    if (collect === '%' && (final === '@' || final === 'G')) {
      this.glevel = 0
      this.charsets[0] = undefined
      return
    }
    if (collect.length === 1 && collect in GLEVEL && CHARSET_FINALS.has(final)) {
      this.charsets[GLEVEL[collect] as number] = final === 'B' ? undefined : final
    }
  }

  csi(collect: string, params: readonly number[], final: string): void {
    if (collect === '') {
      if (final === 's') this.save()
      else if (final === 'u') this.restore()
      return
    }
    if (collect === '!' && final === 'p') {
      // DECSTR: CharsetService.reset(); the DECSC slots are left alone (only `savedCharset` changes in xterm.js)
      this.charsets = []
      this.glevel = 0
      return
    }
    if (collect === '?' && (final === 'h' || final === 'l')) {
      for (const p of params) {
        if (p === 2 && final === 'h') {
          // DECANM set: xterm.js designates the default set into G0–G3
          for (let g = 0; g < DESIGNATOR.length; g++) this.charsets[g] = undefined
          continue
        }
        if (p === 1048) {
          // save / restore cursor without a screen switch (xterm.js: saveCursor / restoreCursor)
          if (final === 'h') this.save()
          else this.restore()
          continue
        }
        if (p !== 47 && p !== 1047 && p !== 1049) continue
        if (final === 'h') {
          if (p === 1049) this.save()
          this.alt = true
        } else {
          this.alt = false
          if (p === 1049) this.restore()
        }
      }
    }
  }

  private save(): void {
    this.slots[this.alt ? 'alt' : 'main'] = { charsets: this.charsets.slice(), glevel: this.glevel }
  }

  private restore(): void {
    const s = this.slots[this.alt ? 'alt' : 'main']
    for (let i = 0; i < s.charsets.length; i++) this.charsets[i] = s.charsets[i]
    this.glevel = s.glevel
  }

  private reset(): void {
    this.charsets = []
    this.glevel = 0
    this.alt = false
    this.slots = { main: { charsets: [], glevel: 0 }, alt: { charsets: [], glevel: 0 } }
  }
}

/**
 * Designations for the first `max(table length, cover)` G sets (`B`, the default, where nothing is designated) and the
 * GL shift: on a fresh terminal this gives the same table, length included. `cover` resets G sets a sequence written
 * before designated; `shift` writes SI even for G0 (after a sequence that may have shifted).
 */
export function charsetSequence(state: CharsetState, cover = 0, shift = false): string {
  let s = ''
  for (let g = 0; g < Math.max(state.charsets.length, cover); g++) s += `\x1b${DESIGNATOR[g]}${state.charsets[g] ?? 'B'}`
  if (state.glevel === 1) s += '\x0e'
  else if (state.glevel === 2) s += '\x1bn'
  else if (state.glevel === 3) s += '\x1bo'
  else if (shift) s += '\x0f'
  return s
}
