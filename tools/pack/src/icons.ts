// The icon files of assets/icon/, drawn from the Kea mark (packages/ui/src/mark.ts) and the design tokens with
// no image tool: shapes rasterised here with supersampling, PNG written with node:zlib, the ICNS written chunk by chunk
// (Apple's format: a header, then one image per size), so it runs on either system.
//
//   node tools/pack/src/icons.ts           write assets/icon/
//   node tools/pack/src/icons.ts --check   exit 1 if a file there differs from what this would write, or is not one
//
// "Differs" means a different picture: a PNG (alone or inside the ICNS) is compared by its pixels, since another zlib
// build may compress the same pixels to other bytes; every other file and chunk byte for byte. Only +, −, ×, ÷ and
// comparisons decide a pixel, so every system draws the same one.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { L } from '../../../packages/protocol/src/generated/limits.ts'
import { COLOR } from '../../../packages/ui/src/generated/tokens.ts'
import { insideMark, MARK, MARK_GRID, markBounds, markCoverage } from '../../../packages/ui/src/mark.ts'

/** An image: `width` × `height` pixels, RGBA, straight (not premultiplied) alpha, row by row. */
export interface Image {
  width: number
  height: number
  rgba: Uint8Array
}

/** The app icon's colours. */
export interface AppIconColors {
  face: string
  rim: string
  mark: string
}

/**
 * The body is the terminal's canvas (`--surface-0`) outlined in `--line-strong` as Kea outlines a floating layer, so
 * it reads on a dark Dock as on a light desktop; the K is the one accent, the terminal cursor's colour.
 */
export const APP_ICON: AppIconColors = { face: COLOR['surface-0'], rim: COLOR['line-strong'], mark: COLOR.accent }

/**
 * The PNG sizes of the app icon: the hicolor sizes Kea's Linux packages install
 * (`/usr/share/icons/hicolor/<n>x<n>/apps`) and the grid's own size, L.appIconGridPx.
 */
export const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, L.appIconGridPx] as const

/**
 * The ICNS's images (Apple's icon types since macOS 11, as `iconutil` writes them): 16 and 32 px as ARGB, the rest as
 * PNG; together 16, 32, 128, 256 and 512 pt at 1× and 2×.
 */
export const ICNS_TYPES = [
  { type: 'ic04', px: 16, argb: true },
  { type: 'ic05', px: 32, argb: true },
  { type: 'ic07', px: 128, argb: false },
  { type: 'ic08', px: 256, argb: false },
  { type: 'ic09', px: 512, argb: false },
  { type: 'ic10', px: 1024, argb: false },
  { type: 'ic11', px: 32, argb: false },
  { type: 'ic12', px: 64, argb: false },
  { type: 'ic13', px: 256, argb: false },
  { type: 'ic14', px: 512, argb: false },
] as const

/** Where the files go, from the repository root. */
export const ICON_DIR = 'assets/icon'

// ── the app icon's geometry, on the 1024 px grid ─────────────────────────────────────────────────────────────────────

const GRID = L.appIconGridPx
const BODY_LO = (GRID - L.appIconBodyPx) / 2
const BODY_HI = BODY_LO + L.appIconBodyPx
const MARK_SCALE = L.appIconMarkPx / MARK_GRID
const [MARK_L, MARK_T, MARK_R, MARK_B] = markBounds()
/** The K's box centred on the body, then moved to the nearest multiple of `app_icon_mark_snap_px`, so its straight edges fall on whole pixels. */
const snap = (v: number) => Math.round(v / L.appIconMarkSnapPx) * L.appIconMarkSnapPx
const MARK_X = snap(GRID / 2 - ((MARK_L + MARK_R) / 2) * MARK_SCALE)
const MARK_Y = snap(GRID / 2 - ((MARK_T + MARK_B) / 2) * MARK_SCALE)

/** `x`ⁿ, by multiplication when `n` is whole (so the corner is drawn the same on every system). */
function power(x: number, n: number): number {
  if (!Number.isInteger(n)) return x ** n
  let p = 1
  for (let i = 0; i < n; i++) p *= x
  return p
}

/** A rounded square from `lo` to `hi` on both axes whose corners are quarter superellipses over `c` of each edge. */
type Squircle = { lo: number; hi: number; c: number }

/** The body, and its face: the body made `app_icon_rim_px` smaller on every side, leaving the rim around it. */
const BODY: Squircle = { lo: BODY_LO, hi: BODY_HI, c: L.appIconCornerPx }
const FACE: Squircle = { lo: BODY_LO + L.appIconRimPx, hi: BODY_HI - L.appIconRimPx, c: L.appIconCornerPx - L.appIconRimPx }

/** Whether the grid point (x, y) lies inside `sq`. */
function insideSquircle(sq: Squircle, x: number, y: number): boolean {
  if (x < sq.lo || x > sq.hi || y < sq.lo || y > sq.hi) return false
  const u = Math.max(sq.lo + sq.c - x, x - (sq.hi - sq.c), 0) / sq.c
  const v = Math.max(sq.lo + sq.c - y, y - (sq.hi - sq.c), 0) / sq.c
  return power(u, L.appIconCornerExponent) + power(v, L.appIconCornerExponent) <= 1
}

/** Whether the grid point (x, y) lies inside the body. */
function insideBody(x: number, y: number): boolean {
  return insideSquircle(BODY, x, y)
}

/** Whether the grid point (x, y) lies inside the K. */
function insideAppMark(x: number, y: number): boolean {
  return insideMark((x - MARK_X) / MARK_SCALE, (y - MARK_Y) / MARK_SCALE)
}

/**
 * The share of each grid pixel inside a shape, `icon_samples`² samples per pixel, each inside or not. `settled` gives
 * the share of a pixel no edge crosses (0 or 1), so only the pixels on an edge are sampled: the same numbers as
 * sampling every pixel, in a fraction of the time.
 */
function cover(inside: (x: number, y: number) => boolean, settled: (x: number, y: number) => number | null): Float64Array {
  const s = L.iconSamples
  const out = new Float64Array(GRID * GRID)
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const known = settled(x, y)
      if (known !== null) {
        out[y * GRID + x] = known
        continue
      }
      let n = 0
      for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) if (inside(x + (sx + 0.5) / s, y + (sy + 0.5) / s)) n++
      out[y * GRID + x] = n / (s * s)
    }
  return out
}

/** A squircle's pixels no edge crosses: all four corners on one side (it is convex, and its corners curve over hundreds of pixels). */
function squircleSettled(sq: Squircle): (x: number, y: number) => number | null {
  const side = GRID + 1
  const corner = new Uint8Array(side * side)
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) corner[y * side + x] = insideSquircle(sq, x, y) ? 1 : 0
  return (x, y) => {
    const a = corner[y * side + x]!
    return a === corner[y * side + x + 1] && a === corner[(y + 1) * side + x] && a === corner[(y + 1) * side + x + 1] ? a : null
  }
}

/** The K's pixels no edge crosses: every edge farther from the centre than half the pixel's diagonal. */
function markSettled(): (x: number, y: number) => number | null {
  const edges = MARK.flatMap((p) =>
    p.map((a, i) => {
      const b = p[(i + 1) % p.length]!
      return [MARK_X + a[0] * MARK_SCALE, MARK_Y + a[1] * MARK_SCALE, MARK_X + b[0] * MARK_SCALE, MARK_Y + b[1] * MARK_SCALE] as const
    }),
  )
  return (x, y) => {
    const px = x + 0.5
    const py = y + 0.5
    for (const [ax, ay, bx, by] of edges) {
      const dx = bx - ax
      const dy = by - ay
      const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
      const ex = ax + t * dx - px
      const ey = ay + t * dy - py
      if (ex * ex + ey * ey <= 0.5) return null
    }
    return insideAppMark(px, py) ? 1 : 0
  }
}

/** One pass of a box blur of radius `r` along a line of `n` values `step` apart from `start`; outside the grid is 0. */
function boxLine(src: Float64Array, dst: Float64Array, start: number, step: number, n: number, r: number): void {
  let sum = 0
  for (let i = 0; i <= r && i < n; i++) sum += src[start + i * step]!
  for (let i = 0; i < n; i++) {
    dst[start + i * step] = sum / (2 * r + 1)
    if (i + r + 1 < n) sum += src[start + (i + r + 1) * step]!
    if (i - r >= 0) sum -= src[start + (i - r) * step]!
  }
}

/** The body's coverage blurred by three box passes each way: close to a Gaussian, with no `exp`. */
function blur(src: Float64Array, r: number): Float64Array {
  let a = src.slice()
  let b = new Float64Array(a.length)
  for (const [step, lineStep] of [
    [1, GRID],
    [GRID, 1],
  ] as const)
    for (let pass = 0; pass < 3; pass++) {
      for (let line = 0; line < GRID; line++) boxLine(a, b, line * lineStep, step, GRID, r)
      ;[a, b] = [b, a]
    }
  return a
}

/** `#rrggbb` as three channels from 0 to 1. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

/** The app icon at the grid's size, premultiplied, channels from 0 to 1: the shadow, the body over it, the K over that. */
export interface Drawing {
  /** r, g, b, a per pixel, the colour premultiplied by a. */
  px: Float64Array
}

export function drawAppIcon(colors: AppIconColors = APP_ICON): Drawing {
  const body = cover(insideBody, squircleSettled(BODY))
  const face = cover((x, y) => insideSquircle(FACE, x, y), squircleSettled(FACE))
  const mark = cover(insideAppMark, markSettled())
  const shade = blur(body, L.appIconShadowRadiusPx)
  const dy = L.appIconShadowOffsetPx
  const [fr, fg, fb] = rgb(colors.face)
  const [rr, rg, rb] = rgb(colors.rim)
  const [mr, mg, mb] = rgb(colors.mark)
  const px = new Float64Array(GRID * GRID * 4)
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const i = y * GRID + x
      const s = y >= dy ? shade[i - dy * GRID]! * L.appIconShadowOpacity : 0
      const b = body[i]!
      const f = face[i]!
      const m = mark[i]!
      // the K over the face, the face inside the rim, the body over the shadow (black); premultiplied
      px[i * 4] = m * mr + (1 - m) * (f * fr + (b - f) * rr)
      px[i * 4 + 1] = m * mg + (1 - m) * (f * fg + (b - f) * rg)
      px[i * 4 + 2] = m * mb + (1 - m) * (f * fb + (b - f) * rb)
      px[i * 4 + 3] = m + (1 - m) * (b + (1 - b) * s)
    }
  return { px }
}

/** For each of `dst` pixels, the `src` pixels it averages and their weights (their share of its width, exact). */
function weights(src: number, dst: number): { from: number; w: number[] }[] {
  const out: { from: number; w: number[] }[] = []
  for (let i = 0; i < dst; i++) {
    // in units of 1/dst of a source pixel: this pixel spans [i·src, (i+1)·src), source pixel j spans [j·dst, (j+1)·dst)
    const lo = i * src
    const hi = lo + src
    const from = Math.floor(lo / dst)
    const w: number[] = []
    for (let j = from; j * dst < hi; j++) w.push((Math.min(hi, (j + 1) * dst) - Math.max(lo, j * dst)) / src)
    out.push({ from, w })
  }
  return out
}

/** The drawing averaged down to `size` × `size` (each pixel the mean of the grid area it covers), as 8-bit RGBA. */
export function appIconImage(drawing: Drawing, size: number): Image {
  const ws = weights(GRID, size)
  // rows first: GRID rows of `size` pixels
  const rows = new Float64Array(GRID * size * 4)
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < size; x++) {
      const { from, w } = ws[x]!
      for (let c = 0; c < 4; c++) {
        let v = 0
        for (let k = 0; k < w.length; k++) v += drawing.px[(y * GRID + from + k) * 4 + c]! * w[k]!
        rows[(y * size + x) * 4 + c] = v
      }
    }
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const { from, w } = ws[y]!
      const p = [0, 0, 0, 0]
      for (let c = 0; c < 4; c++) for (let k = 0; k < w.length; k++) p[c]! += rows[((from + k) * size + x) * 4 + c]! * w[k]!
      const a = Math.round(p[3]! * 255)
      const i = (y * size + x) * 4
      if (a === 0) continue
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.round((p[c]! / p[3]!) * 255))
      rgba[i + 3] = a
    }
  return { width: size, height: size, rgba }
}

/** The mark at `px` × `px` as main draws it: black and alpha (a template image), or `color` and alpha. */
export function markImage(px: number, color?: string): Image {
  const [r, g, b] = color ? rgb(color).map((c) => Math.round(c * 255)) : [0, 0, 0]
  const cov = markCoverage(px)
  const rgba = new Uint8Array(px * px * 4)
  for (let i = 0; i < px * px; i++) {
    const a = Math.round(cov[i]! * 255)
    if (a === 0) continue
    rgba.set([r!, g!, b!, a], i * 4)
  }
  return { width: px, height: px, rgba }
}

// ── the vector app icon ──────────────────────────────────────────────────────────────────────────────────────────────

/** Points per corner curve in the SVG: each straight piece is under a tenth of a pixel from the curve at 1024 px. */
const SVG_CORNER_STEPS = 32

/** A coordinate as the SVG writes it: at most two decimals, no trailing zeros. */
function num(v: number): string {
  return String(Number(v.toFixed(2)))
}

/** The x in [0, 1] where `f`, rising, reaches `target`: bisection to the last bit, with multiplication only. */
function solve(f: (x: number) => number, target: number): number {
  let lo = 0
  let hi = 1
  while (true) {
    const mid = (lo + hi) / 2
    if (mid === lo || mid === hi) return mid
    if (f(mid) < target) lo = mid
    else hi = mid
  }
}

/** One corner curve uⁿ + vⁿ = 1, from (0, 1) to (1, 0): `SVG_CORNER_STEPS` pieces, even in u up to where u = v, then in v. */
function cornerCurve(): [number, number][] {
  const n = L.appIconCornerExponent
  const other = (t: number) => solve((x) => power(x, n), 1 - power(t, n))
  const meet = solve((x) => 2 * power(x, n), 1)
  const half = SVG_CORNER_STEPS / 2
  const pts: [number, number][] = []
  for (let i = 0; i <= half; i++) pts.push([(meet * i) / half, other((meet * i) / half)])
  for (let i = half - 1; i >= 0; i--) pts.push([other((meet * i) / half), (meet * i) / half])
  return pts
}

/** A squircle's outline as an SVG path, clockwise from the top edge: a corner's point (u, v) lies c·u across and c·v up from its zone's inner point. */
function squirclePath(sq: Squircle): string {
  const { lo, hi, c } = sq
  const curve = cornerCurve()
  const pts: [number, number][] = []
  for (const k of [
    { x: hi - c, y: lo + c, sx: 1, sy: -1, reverse: false },
    { x: hi - c, y: hi - c, sx: 1, sy: 1, reverse: true },
    { x: lo + c, y: hi - c, sx: -1, sy: 1, reverse: false },
    { x: lo + c, y: lo + c, sx: -1, sy: -1, reverse: true },
  ]) {
    for (const [u, v] of k.reverse ? [...curve].reverse() : curve) pts.push([k.x + k.sx * c * u, k.y + k.sy * c * v])
  }
  return `M${pts.map(([x, y]) => `${num(x)} ${num(y)}`).join('L')}Z`
}

/** The K's outline on the grid, one subpath per polygon (all wound the same way, so they add). */
function markPath(): string {
  return MARK.map((p) => `M${p.map(([x, y]) => `${num(MARK_X + x * MARK_SCALE)} ${num(MARK_Y + y * MARK_SCALE)}`).join('L')}Z`).join('')
}

/** The app icon as an SVG on the 1024 grid: the same shadow, body, rim and K as the PNGs (the shadow a true Gaussian of the same spread). */
export function appIconSvg(colors: AppIconColors = APP_ICON): string {
  const r = L.appIconShadowRadiusPx
  // three box passes of radius r have a variance of r(r + 1)
  const sigma = Math.sqrt(r * (r + 1))
  const body = squirclePath(BODY)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID}" height="${GRID}" viewBox="0 0 ${GRID} ${GRID}">`,
    `<filter id="shadow" x="-0.2" y="-0.2" width="1.4" height="1.4" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${num(sigma)}"/></filter>`,
    `<path d="${body}" transform="translate(0 ${L.appIconShadowOffsetPx})" fill="#000" fill-opacity="${L.appIconShadowOpacity}" filter="url(#shadow)"/>`,
    `<path d="${body}" fill="${colors.rim}"/>`,
    `<path d="${squirclePath(FACE)}" fill="${colors.face}"/>`,
    `<path d="${markPath()}" fill="${colors.mark}"/>`,
    '</svg>',
    '',
  ].join('\n')
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(head.subarray(4))), 0)
  return Buffer.concat([head, data, crc])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Filter `type` (PNG's 0–4) applied to byte `i` of a row, given the bytes left (`a`), above (`b`) and above-left (`c`). */
function predict(type: number, a: number, b: number, c: number): number {
  return type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c)
}

/** An 8-bit RGBA PNG tagged sRGB; each row with the filter whose bytes sum smallest as signed values (the PNG spec's advice). */
export function encodePng(img: Image): Buffer {
  const stride = img.width * 4
  const raw = Buffer.alloc(img.height * (stride + 1))
  const zero = new Uint8Array(stride)
  for (let y = 0; y < img.height; y++) {
    const row = img.rgba.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? img.rgba.subarray((y - 1) * stride, y * stride) : zero
    let best = 0
    let bestCost = Infinity
    for (let type = 0; type < 5; type++) {
      let cost = 0
      for (let i = 0; i < stride; i++) {
        const v = (row[i]! - predict(type, i >= 4 ? row[i - 4]! : 0, up[i]!, i >= 4 ? up[i - 4]! : 0)) & 0xff
        cost += v < 128 ? v : 256 - v
      }
      if (cost < bestCost) [best, bestCost] = [type, cost]
    }
    const at = y * (stride + 1)
    raw[at] = best
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = (row[i]! - predict(best, i >= 4 ? row[i - 4]! : 0, up[i]!, i >= 4 ? up[i - 4]! : 0)) & 0xff
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8 bits, RGBA, deflate, adaptive filters, not interlaced
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('sRGB', Uint8Array.of(0)), // perceptual: the tokens are sRGB
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}

/** The pixels of a PNG this file writes (8-bit RGBA, not interlaced); throws on anything else or a bad checksum. */
export function decodePng(buf: Uint8Array): Image {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  for (let p = 8; p < b.length; ) {
    const len = b.readUInt32BE(p)
    const type = b.toString('ascii', p + 4, p + 8)
    const data = b.subarray(p + 8, p + 8 + len)
    if (zlib.crc32(data, zlib.crc32(b.subarray(p + 4, p + 8))) !== b.readUInt32BE(p + 8 + len)) throw new Error(`PNG chunk ${type}: bad CRC`)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('PNG: not 8-bit RGBA, non-interlaced')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 4
  if (raw.length !== height * (stride + 1)) throw new Error('PNG: wrong data length')
  const rgba = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]!
    if (type > 4) throw new Error(`PNG: filter ${type}`)
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4]! : 0
      const up = y > 0 ? rgba[(y - 1) * stride + i]! : 0
      const c = i >= 4 && y > 0 ? rgba[(y - 1) * stride + i - 4]! : 0
      rgba[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + predict(type, a, up, c)) & 0xff
    }
  }
  return { width, height, rgba }
}

// ── ICNS ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The ICNS run-length code of one channel: a byte n < 128 copies the next n + 1 bytes; n ≥ 128 repeats the next one n − 125 times. */
function packBits(bytes: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < bytes.length; ) {
    let run = 1
    while (i + run < bytes.length && run < 130 && bytes[i + run] === bytes[i]) run++
    if (run >= 3) {
      out.push(0x80 + run - 3, bytes[i]!)
      i += run
      continue
    }
    let j = i
    while (j < bytes.length && j - i < 128 && !(bytes[j] === bytes[j + 1] && bytes[j] === bytes[j + 2])) j++
    if (j === i) j++
    out.push(j - i - 1, ...bytes.subarray(i, j))
    i = j
  }
  return out
}

/** An `ARGB` image as macOS 11+ stores 16 and 32 px icons: the alpha plane, then red, green and blue, each run-length coded. */
export function encodeArgb(img: Image): Buffer {
  const n = img.width * img.height
  const out: number[] = [...Buffer.from('ARGB', 'ascii')]
  for (const c of [3, 0, 1, 2]) {
    const plane = new Uint8Array(n)
    for (let i = 0; i < n; i++) plane[i] = img.rgba[i * 4 + c]!
    out.push(...packBits(plane))
  }
  return Buffer.from(out)
}

/** The pixels of an `ARGB` chunk of `px` × `px`. */
export function decodeArgb(buf: Uint8Array, px: number): Image {
  if (Buffer.from(buf.subarray(0, 4)).toString('ascii') !== 'ARGB') throw new Error('not an ARGB chunk')
  const planes: number[] = []
  for (let p = 4; p < buf.length; ) {
    const h = buf[p++]!
    if (h < 0x80) for (let i = 0; i <= h; i++) planes.push(buf[p++]!)
    else planes.push(...new Array<number>(h - 0x80 + 3).fill(buf[p++]!))
  }
  const n = px * px
  if (planes.length !== 4 * n) throw new Error(`ARGB: ${planes.length} bytes for ${px} px`)
  const rgba = new Uint8Array(4 * n)
  for (let i = 0; i < n; i++) rgba.set([planes[n + i]!, planes[2 * n + i]!, planes[3 * n + i]!, planes[i]!], i * 4)
  return { width: px, height: px, rgba }
}

/** An ICNS file: `icns`, its length, then each chunk as its type, its length (header included) and its data. */
export function encodeIcns(chunks: readonly { type: string; data: Uint8Array }[]): Buffer {
  const parts = chunks.map(({ type, data }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([head, data])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4)
  return Buffer.concat([head, ...parts])
}

/** The chunks of an ICNS file; throws when its lengths do not add up. */
export function readIcns(buf: Uint8Array): { type: string; data: Buffer }[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.toString('ascii', 0, 4) !== 'icns' || b.readUInt32BE(4) !== b.length) throw new Error('not an ICNS file')
  const out: { type: string; data: Buffer }[] = []
  for (let p = 8; p < b.length; ) {
    const len = b.readUInt32BE(p + 4)
    if (len < 8 || p + len > b.length) throw new Error(`ICNS: bad length at ${p}`)
    out.push({ type: b.toString('ascii', p, p + 4), data: b.subarray(p + 8, p + len) })
    p += len
  }
  return out
}

// ── the files ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every file of assets/icon/, by its path there. */
export function iconFiles(): { name: string; bytes: Buffer }[] {
  const drawing = drawAppIcon()
  const sizes = [...new Set([...PNG_SIZES, ...ICNS_TYPES.map((t) => t.px)])]
  const images = new Map(sizes.map((px) => [px, appIconImage(drawing, px)]))
  const pngs = new Map(sizes.map((px) => [px, encodePng(images.get(px)!)]))
  const pt = MARK_GRID
  return [
    { name: 'kea.icns', bytes: encodeIcns(ICNS_TYPES.map((t) => ({ type: t.type, data: t.argb ? encodeArgb(images.get(t.px)!) : pngs.get(t.px)! }))) },
    { name: 'kea.svg', bytes: Buffer.from(appIconSvg()) },
    ...PNG_SIZES.map((px) => ({ name: `png/${px}x${px}.png`, bytes: pngs.get(px)! })),
    { name: 'trayTemplate.png', bytes: encodePng(markImage(pt)) },
    { name: 'trayTemplate@2x.png', bytes: encodePng(markImage(pt * 2)) },
    { name: 'trayAccent.png', bytes: encodePng(markImage(pt, COLOR.accent)) },
    { name: 'trayAccent@2x.png', bytes: encodePng(markImage(pt * 2, COLOR.accent)) },
  ]
}

function samePixels(a: Image, b: Image): boolean {
  return a.width === b.width && a.height === b.height && Buffer.from(a.rgba).equals(Buffer.from(b.rgba))
}

/** Whether a committed file holds what the generator writes: the same pixels for a PNG and each PNG chunk, else the same bytes. */
export function sameIcon(name: string, committed: Uint8Array, generated: Uint8Array): boolean {
  try {
    if (name.endsWith('.png')) return samePixels(decodePng(committed), decodePng(generated))
    if (name.endsWith('.icns')) {
      const a = readIcns(committed)
      const b = readIcns(generated)
      return a.length === b.length && a.every((c, i) => c.type === b[i]!.type && (c.data.subarray(0, 8).equals(PNG_SIGNATURE) ? samePixels(decodePng(c.data), decodePng(b[i]!.data)) : c.data.equals(b[i]!.data)))
    }
  } catch {
    return false
  }
  return Buffer.from(committed).equals(Buffer.from(generated))
}

/** Every file under `dir`, relative to it, `/`-separated. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort()
}

function main(): void {
  const root = path.resolve(import.meta.dirname, '..', '..', '..')
  const dir = path.join(root, ICON_DIR)
  const check = process.argv.includes('--check')
  const files = iconFiles()
  const names = new Set(files.map((f) => f.name))
  const stray = filesUnder(dir).filter((f) => !names.has(f))
  const stale: string[] = []
  for (const f of files) {
    const at = path.join(dir, f.name)
    const current = fs.existsSync(at) ? fs.readFileSync(at) : null
    if (current && sameIcon(f.name, current, f.bytes)) continue
    if (check) stale.push(f.name)
    else {
      fs.mkdirSync(path.dirname(at), { recursive: true })
      fs.writeFileSync(at, f.bytes)
      console.log(`wrote ${ICON_DIR}/${f.name}`)
    }
  }
  if (check) {
    for (const f of stray) stale.push(`${f} (not one of the generator's files)`)
    if (stale.length > 0) {
      console.error(`icons: ${ICON_DIR} differs from what the generator writes (run \`node tools/pack/src/icons.ts\`):\n  ${stale.join('\n  ')}`)
      process.exit(1)
    }
    console.log(`icons: ${ICON_DIR} is what the generator writes (${files.length} files)`)
    return
  }
  // the folder is the generator's own: a file it no longer writes goes
  for (const f of stray) {
    fs.rmSync(path.join(dir, f))
    console.log(`removed ${ICON_DIR}/${f}`)
  }
}

if (import.meta.main) main()
