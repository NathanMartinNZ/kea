// Portions ported from xterm.js (MIT, © The xterm.js authors): see THIRD_PARTY_NOTICES.md.
//
// Colour state for the mirror's colour responders and the mode trailer. Semantics follow xterm.js at the pinned commit:
// `parseXColor` is `common/input/XParseColor.ts#parseColor`, replies use `toRgbString` (16 bits per channel), the
// 256-colour table is `browser/Types.ts#DEFAULT_ANSI_COLORS`, and OSC 4/10/11/12/104/110/111/112 slot parsing is
// `common/InputHandler.ts`.

export type Rgb = readonly [number, number, number]

/** xterm.js `SpecialColorIndex`. */
export const FG = 256
export const BG = 257
export const CURSOR = 258
export type ColorIndex = number // 0…255 palette, or FG / BG / CURSOR

/** The colours a terminal starts with: the active theme (`zMirrorConfig`, generated `THEMES`). */
export interface ColorTheme {
  foreground: string
  background: string
  cursor: string
  /** ANSI 0…15 */
  palette: readonly string[]
}

const RGB_REX = /^([\da-f])\/([\da-f])\/([\da-f])$|^([\da-f]{2})\/([\da-f]{2})\/([\da-f]{2})$|^([\da-f]{3})\/([\da-f]{3})\/([\da-f]{3})$|^([\da-f]{4})\/([\da-f]{4})\/([\da-f]{4})$/
const HASH_REX = /^[\da-f]+$/

/** X11 colour spec → RGB (`rgb:h/h/h` in 4–16 bits, `#RGB` … `#RRRRGGGGBBBB`); named colours are not supported, as in xterm.js. */
export function parseXColor(data: string): Rgb | undefined {
  if (!data) return undefined
  let low = data.toLowerCase()
  if (low.startsWith('rgb:')) {
    low = low.slice(4)
    const m = RGB_REX.exec(low)
    if (m) {
      const base = m[1] ? 15 : m[4] ? 255 : m[7] ? 4095 : 65535
      const ch = (a: number) => Math.round((parseInt((m[a] || m[a + 3] || m[a + 6] || m[a + 9]) as string, 16) / base) * 255)
      return [ch(1), ch(2), ch(3)]
    }
  } else if (low.startsWith('#')) {
    low = low.slice(1)
    if (HASH_REX.exec(low) && [3, 6, 9, 12].includes(low.length)) {
      const adv = low.length / 3
      const out: [number, number, number] = [0, 0, 0]
      for (let i = 0; i < 3; ++i) {
        const c = parseInt(low.slice(adv * i, adv * i + adv), 16)
        out[i] = adv === 1 ? c << 4 : adv === 2 ? c : adv === 3 ? c >> 4 : c >> 8
      }
      return out
    }
  }
  return undefined
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0')
}

/** `rgb:rrrr/gggg/bbbb` — the form xterm.js (and xterm) reply with. */
export function toRgbString(c: Rgb): string {
  return `rgb:${hex2(c[0]).repeat(2)}/${hex2(c[1]).repeat(2)}/${hex2(c[2]).repeat(2)}`
}

export function toHex(c: Rgb): string {
  return `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`
}

const CUBE = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]

/** Default colour for palette entries 16…255 (6×6×6 cube, then 24 greys). */
export function xterm256(i: number): Rgb {
  if (i >= 16 && i < 232) {
    const n = i - 16
    return [CUBE[((n / 36) | 0) % 6] as number, CUBE[((n / 6) | 0) % 6] as number, CUBE[n % 6] as number]
  }
  const c = 8 + (i - 232) * 10
  return [c, c, c]
}

/** Relative luminance (WCAG), for the dark/light answer to `CSI ? 996 n`. */
export function luminance(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

export type ColorRequest = { type: 'report' | 'restore'; index: ColorIndex } | { type: 'set'; index: ColorIndex; rgb: Rgb } | { type: 'restoreAll' }

/** OSC 4 payload → requests, exactly as xterm.js slices it (pairs of `index;spec`, `?` = report). */
export function parseOsc4(data: string): ColorRequest[] {
  const out: ColorRequest[] = []
  const slots = data.split(';')
  while (slots.length > 1) {
    const idx = slots.shift() as string
    const spec = slots.shift() as string
    if (!/^\d+$/.test(idx)) continue
    const index = parseInt(idx, 10)
    if (index < 0 || index >= 256) continue
    if (spec === '?') out.push({ type: 'report', index })
    else {
      const rgb = parseXColor(spec)
      if (rgb) out.push({ type: 'set', index, rgb })
    }
  }
  return out
}

/** OSC 10/11/12 payload: slots continue to the next special colour (`OSC 10;?;?` asks for fg and bg). */
export function parseOscSpecial(ident: 10 | 11 | 12, data: string): ColorRequest[] {
  const out: ColorRequest[] = []
  const slots = data.split(';')
  let offset = ident - 10
  for (let i = 0; i < slots.length; ++i, ++offset) {
    if (offset >= 3) break
    const index = FG + offset
    if (slots[i] === '?') out.push({ type: 'report', index })
    else {
      const rgb = parseXColor(slots[i] as string)
      if (rgb) out.push({ type: 'set', index, rgb })
    }
  }
  return out
}

/** OSC 104 payload: empty restores the whole palette; otherwise each valid index. */
export function parseOsc104(data: string): ColorRequest[] {
  if (!data) return [{ type: 'restoreAll' }]
  const out: ColorRequest[] = []
  for (const s of data.split(';')) {
    if (!/^\d+$/.test(s)) continue
    const index = parseInt(s, 10)
    if (index >= 0 && index < 256) out.push({ type: 'restore', index })
  }
  return out
}

/** OSC sequence that reports a colour, as xterm.js formats it (ST-terminated). */
export function colorReport(index: ColorIndex, rgb: Rgb): string {
  const ident = index === FG ? '10' : index === BG ? '11' : index === CURSOR ? '12' : `4;${index}`
  return `\x1b]${ident};${toRgbString(rgb)}\x1b\\`
}

/**
 * The theme plus whatever the program changed with OSC 4/10/11/12 (and undid with 104/110/111/112).
 * bounded: at most 259 overrides.
 */
export class ColorState {
  private theme: Map<ColorIndex, Rgb> = new Map()
  private readonly overrides = new Map<ColorIndex, Rgb>()

  constructor(theme: ColorTheme) {
    this.setTheme(theme)
  }

  setTheme(theme: ColorTheme): void {
    const t = new Map<ColorIndex, Rgb>()
    const must = (s: string | undefined, what: string): Rgb => {
      const c = s ? parseXColor(s) : undefined
      if (!c) throw new Error(`theme colour ${what} is not a colour: ${String(s)}`)
      return c
    }
    for (let i = 0; i < 16; i++) t.set(i, must(theme.palette[i], `palette[${i}]`))
    for (let i = 16; i < 256; i++) t.set(i, xterm256(i))
    t.set(FG, must(theme.foreground, 'foreground'))
    t.set(BG, must(theme.background, 'background'))
    t.set(CURSOR, must(theme.cursor, 'cursor'))
    this.theme = t
  }

  get(index: ColorIndex): Rgb {
    return this.overrides.get(index) ?? (this.theme.get(index) as Rgb)
  }

  /** Apply sets and restores in order; returns each report with the colour current at that point in the sequence. */
  apply(reqs: readonly ColorRequest[]): { index: ColorIndex; rgb: Rgb }[] {
    const reports: { index: ColorIndex; rgb: Rgb }[] = []
    for (const r of reqs) {
      if (r.type === 'set') this.overrides.set(r.index, r.rgb)
      else if (r.type === 'restore') this.overrides.delete(r.index)
      else if (r.type === 'restoreAll') {
        for (const k of [...this.overrides.keys()]) if (k < 256) this.overrides.delete(k)
      } else reports.push({ index: r.index, rgb: this.get(r.index) })
    }
    return reports
  }

  /** OSC sequences that re-apply every override (part of the mode trailer). */
  trailer(): string {
    let s = ''
    for (const [index, rgb] of [...this.overrides].sort((a, b) => a[0] - b[0])) {
      const spec = toRgbString(rgb)
      if (index < 256) s += `\x1b]4;${index};${spec}\x1b\\`
      else s += `\x1b]${10 + index - FG};${spec}\x1b\\`
    }
    return s
  }

  get overrideCount(): number {
    return this.overrides.size
  }
}
