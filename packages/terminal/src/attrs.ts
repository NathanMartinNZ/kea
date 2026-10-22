// Portions ported from xterm.js (MIT, © The xterm.js authors): see THIRD_PARTY_NOTICES.md.
//
// Character attributes (SGR, DECSCA) as xterm.js keeps them, for the mode trailer: a DECSC / SCOSC / 1048 / 1049 saved
// cursor carries the attributes current when it was saved, and DECRC brings them back. xterm.js has no public API for
// either, so the tracker follows every `CSI … m` and `CSI … " q` itself, with xterm.js's own rules
// (`common/InputHandler.ts` `charAttributes`, `_extractColor`, `_processUnderline`, `_processSGR0`, `selectProtected`
// at the pinned commit), and `sgrOf` writes attributes back as one SGR.
//
// The bit layout is xterm.js's `AttributeData` (`common/buffer/Constants.ts`): upstream's format, not Kea numbers.
// Not followed: OSC 8 hyperlinks, which also mark the background "has extended attributes" (the serialize addon drops
// OSC 8 links, so restored links are plain text anyway).

import type { CsiParams } from './xterm.ts'

const CM_MASK = 0x3000000
const CM_P16 = 0x1000000
const CM_P256 = 0x2000000
const CM_RGB = 0x3000000
const RGB_MASK = 0xffffff
const COLOR_BITS = CM_MASK | RGB_MASK

const FG_INVERSE = 0x4000000
const FG_BOLD = 0x8000000
const FG_UNDERLINE = 0x10000000
const FG_BLINK = 0x20000000
const FG_INVISIBLE = 0x40000000
const FG_STRIKETHROUGH = 0x80000000

const BG_ITALIC = 0x4000000
const BG_DIM = 0x8000000
const BG_HAS_EXTENDED = 0x10000000
const BG_PROTECTED = 0x20000000
const BG_OVERLINE = 0x40000000

/** `UnderlineStyle`: NONE 0, SINGLE 1, DOUBLE 2, CURLY 3, DOTTED 4, DASHED 5. */
const UL_SINGLE = 1
const UL_DOUBLE = 2
const UL_MAX = 5

/** One attribute state: xterm.js's `fg` and `bg` words and the two extended fields SGR sets. */
export interface Attrs {
  fg: number
  bg: number
  /** `extended.underlineStyle` */
  ulStyle: number
  /** `extended.underlineColor` (colour mode and value bits) */
  ulColor: number
}

export const DEFAULT_ATTRS: Readonly<Attrs> = Object.freeze({ fg: 0, bg: 0, ulStyle: 0, ulColor: 0 })

/** The same state (fg and bg as 32-bit words: xterm.js's can be negative once bit 31 is set). */
export function sameAttrs(a: Attrs, b: Attrs): boolean {
  return (a.fg | 0) === (b.fg | 0) && (a.bg | 0) === (b.bg | 0) && a.ulStyle === b.ulStyle && a.ulColor === b.ulColor
}

/** Top-level params and each one's sub-params, from the public API's `[38, [2, -1, 1, 2, 3]]` form. */
function split(raw: CsiParams): { v: number[]; sub: (number[] | null)[] } {
  const v: number[] = []
  const sub: (number[] | null)[] = []
  for (const x of raw) {
    if (typeof x === 'number') {
      v.push(x)
      sub.push(null)
    } else if (sub.length > 0) sub[sub.length - 1] = x
  }
  return { v, sub }
}

function updateExtended(a: Attrs): void {
  // `ExtendedAttrs.isEmpty()`: no underline style (and no link, which is not followed)
  if (a.ulStyle === 0) a.bg &= ~BG_HAS_EXTENDED
  else a.bg |= BG_HAS_EXTENDED
}

function processUnderline(a: Attrs, style: number): void {
  if (!~style || style > UL_MAX) style = UL_SINGLE
  a.ulStyle = style
  a.fg |= FG_UNDERLINE
  if (style === 0) a.fg &= ~FG_UNDERLINE
  updateExtended(a)
}

function processSgr0(a: Attrs): void {
  a.fg = DEFAULT_ATTRS.fg
  a.bg = DEFAULT_ATTRS.bg
  a.ulStyle = 0
  a.ulColor &= ~COLOR_BITS
  updateExtended(a)
}

function updateColor(color: number, mode: number, c1: number, c2: number, c3: number): number {
  if (mode === 2) {
    color |= CM_RGB
    color &= ~RGB_MASK
    color |= ((c1 & 0xff) << 16) | ((c2 & 0xff) << 8) | (c3 & 0xff)
  } else if (mode === 5) {
    color &= ~COLOR_BITS
    color |= CM_P256 | (c1 & 0xff)
  }
  return color
}

/** `_extractColor`: 38 / 48 / 58 in either the `;` or the `:` form. Returns how many params it consumed after `pos`. */
function extractColor(a: Attrs, v: number[], sub: (number[] | null)[], pos: number): number {
  // [target, colour mode, colour space (ignored), value, value, value]
  const accu = [0, 0, -1, 0, 0, 0]
  let cSpace = 0
  let advance = 0
  do {
    accu[advance + cSpace] = v[pos + advance] as number
    const s = sub[pos + advance]
    if (s && s.length > 0) {
      let i = 0
      do {
        if (accu[1] === 5) cSpace = 1
        accu[advance + i + 1 + cSpace] = s[i] as number
      } while (++i < s.length && i + advance + 1 + cSpace < accu.length)
      break
    }
    if ((accu[1] === 5 && advance + cSpace >= 2) || (accu[1] === 2 && advance + cSpace >= 5)) break
    if (accu[1]) cSpace = 1
  } while (++advance + pos < v.length && advance + cSpace < accu.length)
  for (let i = 2; i < accu.length; ++i) if (accu[i] === -1) accu[i] = 0
  const [target, mode, , c1, c2, c3] = accu as [number, number, number, number, number, number]
  if (target === 38) a.fg = updateColor(a.fg, mode, c1, c2, c3)
  else if (target === 48) a.bg = updateColor(a.bg, mode, c1, c2, c3)
  else if (target === 58) a.ulColor = updateColor(a.ulColor, mode, c1, c2, c3) & COLOR_BITS
  return advance
}

/** `CSI … m` applied to `a` (in place), as xterm.js's `charAttributes` does (kitty's 221 / 222 on, its default). */
export function applySgr(a: Attrs, raw: CsiParams): void {
  const { v, sub } = split(raw)
  if (v.length === 0) v.push(0)
  for (let i = 0; i < v.length; i++) {
    const p = v[i] as number
    if (p >= 30 && p <= 37) a.fg = (a.fg & ~COLOR_BITS) | CM_P16 | (p - 30)
    else if (p >= 40 && p <= 47) a.bg = (a.bg & ~COLOR_BITS) | CM_P16 | (p - 40)
    else if (p >= 90 && p <= 97) a.fg = (a.fg & ~COLOR_BITS) | CM_P16 | (p - 90) | 8
    else if (p >= 100 && p <= 107) a.bg = (a.bg & ~COLOR_BITS) | CM_P16 | (p - 100) | 8
    else if (p === 0) processSgr0(a)
    else if (p === 1) a.fg |= FG_BOLD
    else if (p === 3) a.bg |= BG_ITALIC
    else if (p === 4) {
      a.fg |= FG_UNDERLINE
      const s = sub[i]
      processUnderline(a, s && s.length > 0 ? (s[0] as number) : UL_SINGLE)
    } else if (p === 5) a.fg |= FG_BLINK
    else if (p === 7) a.fg |= FG_INVERSE
    else if (p === 8) a.fg |= FG_INVISIBLE
    else if (p === 9) a.fg |= FG_STRIKETHROUGH
    else if (p === 2) a.bg |= BG_DIM
    else if (p === 21) processUnderline(a, UL_DOUBLE)
    else if (p === 22) {
      a.fg &= ~FG_BOLD
      a.bg &= ~BG_DIM
    } else if (p === 23) a.bg &= ~BG_ITALIC
    else if (p === 24) {
      a.fg &= ~FG_UNDERLINE
      processUnderline(a, 0)
    } else if (p === 25) a.fg &= ~FG_BLINK
    else if (p === 27) a.fg &= ~FG_INVERSE
    else if (p === 28) a.fg &= ~FG_INVISIBLE
    else if (p === 29) a.fg &= ~FG_STRIKETHROUGH
    else if (p === 39) a.fg &= ~COLOR_BITS // the default colour's value bits are 0
    else if (p === 49) a.bg &= ~COLOR_BITS
    else if (p === 38 || p === 48 || p === 58) i += extractColor(a, v, sub, i)
    else if (p === 53) a.bg |= BG_OVERLINE
    else if (p === 55) a.bg &= ~BG_OVERLINE
    else if (p === 221) a.fg &= ~FG_BOLD
    else if (p === 222) a.bg &= ~BG_DIM
    else if (p === 59) {
      // xterm.js stores -1 through the colour setter's mask, which reads back as RGB white: kept as it does
      a.ulColor = -1 & COLOR_BITS
      updateExtended(a)
    }
  }
}

/** DECSCA (`CSI Ps " q`): 1 protects the characters written from now on, 0 and 2 stop it. */
export function applyProtected(a: Attrs, raw: CsiParams): void {
  const p = split(raw).v[0] ?? 0
  if (p === 1) a.bg |= BG_PROTECTED
  if (p === 2 || p === 0) a.bg &= ~BG_PROTECTED
}

function colorParams(word: number, base: number, bright: number, extended: number): string[] {
  const c = word & RGB_MASK
  switch (word & CM_MASK) {
    case CM_P16:
      return [String(c < 8 ? base + c : bright + (c & 7))]
    case CM_P256:
      return [`${extended};5;${c & 0xff}`]
    case CM_RGB:
      return [`${extended};2;${(c >>> 16) & 0xff};${(c >>> 8) & 0xff};${c & 0xff}`]
    default:
      return []
  }
}

/**
 * The sequence that sets exactly `a` from any state: SGR 0 and every attribute that is on, then DECSCA when protected.
 * With `extended` false, the underline style and colour are left out (a saved cursor keeps fg and bg, not the extended
 * fields), but an underline is still turned on, which also sets bg's "has extended" bit as it was.
 */
export function sgrOf(a: Attrs, extended = true): string {
  const p = ['0', ...colorParams(a.fg, 30, 90, 38), ...colorParams(a.bg, 40, 100, 48)]
  if (a.fg & FG_BOLD) p.push('1')
  if (a.bg & BG_DIM) p.push('2')
  if (a.bg & BG_ITALIC) p.push('3')
  if (a.fg & FG_BLINK) p.push('5')
  if (a.fg & FG_INVERSE) p.push('7')
  if (a.fg & FG_INVISIBLE) p.push('8')
  if (a.fg & FG_STRIKETHROUGH) p.push('9')
  if (a.bg & BG_OVERLINE) p.push('53')
  if (extended && a.ulColor & CM_MASK) {
    // `58` sets the colour without touching the "has extended" bit; the underline below decides that bit
    const c = a.ulColor & RGB_MASK
    p.push((a.ulColor & CM_MASK) === CM_RGB ? `58:2::${(c >>> 16) & 0xff}:${(c >>> 8) & 0xff}:${c & 0xff}` : `58:5:${c & 0xff}`)
  }
  if (a.fg & FG_UNDERLINE) {
    const style = extended && a.ulStyle ? a.ulStyle : UL_SINGLE
    p.push(style === UL_SINGLE ? '4' : `4:${style}`)
  }
  return `\x1b[${p.join(';')}m${decscaOf(a)}`
}

/** DECSCA for protected attributes (SGR 0 clears it), else nothing. */
export function decscaOf(a: Attrs): string {
  return a.bg & BG_PROTECTED ? '\x1b[1"q' : ''
}
