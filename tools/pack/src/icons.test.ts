import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { L } from '../../../packages/protocol/src/generated/limits.ts'
import { COLOR, SIZE_PX } from '../../../packages/ui/src/generated/tokens.ts'
import { insideMark, markCoverage } from '../../../packages/ui/src/mark.ts'
import { APP_ICON, ART_DIR, ART_LARGE, ART_SMALL, decodeArgb, decodePng, drawAppIcon, encodePng, ICNS_TYPES, ICON_DIR, iconFiles, placeArt, PNG_SIZES, readArt, readIcns, sameIcon } from './icons.ts'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
const committed = (name: string) => fs.readFileSync(path.join(root, ICON_DIR, name))
const files = iconFiles()
const named = (name: string) => files.find((f) => f.name === name)!.bytes
const hex = (rgba: Uint8Array, i: number) => `#${[...rgba.subarray(i * 4, i * 4 + 3)].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`
const art = readArt()
/** The face's edges on the grid: the body made the rim smaller on every side. */
const FACE_LO = (L.appIconGridPx - L.appIconBodyPx) / 2 + L.appIconRimPx
const FACE_HI = L.appIconGridPx - FACE_LO

describe('the icon files of assets/icon/ (tools/pack/src/icons.ts)', () => {
  it('U-PACK-28 · assets/icon/ holds exactly what the generator writes, a second run writes the same bytes, and a file differs only when its pixels do', () => {
    const onDisk = fs.readdirSync(path.join(root, ICON_DIR), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    expect(onDisk.map((e) => path.relative(path.join(root, ICON_DIR), path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort()).toEqual(files.map((f) => f.name).sort())
    for (const f of files) expect(sameIcon(f.name, committed(f.name), f.bytes), `${f.name} is stale: run node tools/pack/src/icons.ts`).toBe(true)
    // deterministic: the same bytes again
    const again = iconFiles()
    for (const [i, f] of files.entries()) expect(again[i]!.bytes.equals(f.bytes), f.name).toBe(true)
    // the comparison: other compression, same picture → same; one pixel changed → differs
    const png = decodePng(named('png/32x32.png'))
    const recompressed = Buffer.from(encodePng(png))
    const at = recompressed.indexOf('IDAT') - 4
    const idat = zlib.deflateSync(zlib.inflateSync(recompressed.subarray(at + 8, at + 8 + recompressed.readUInt32BE(at))), { level: 1 })
    const head = Buffer.alloc(8)
    head.writeUInt32BE(idat.length, 0)
    head.write('IDAT', 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(idat, zlib.crc32(head.subarray(4))), 0)
    const other = Buffer.concat([recompressed.subarray(0, at), head, idat, crc, recompressed.subarray(at + 12 + recompressed.readUInt32BE(at))])
    expect(other.equals(named('png/32x32.png'))).toBe(false)
    expect(sameIcon('png/32x32.png', other, named('png/32x32.png'))).toBe(true)
    const changed = { ...png, rgba: png.rgba.slice() }
    const centre = (16 * 32 + 16) * 4
    changed.rgba[centre] = changed.rgba[centre]! ^ 1
    expect(sameIcon('png/32x32.png', encodePng(changed), named('png/32x32.png'))).toBe(false)
    expect(sameIcon('kea.svg', Buffer.from(named('kea.svg').toString().replace('<path', '<path ')), named('kea.svg'))).toBe(false)
  })

  it('U-PACK-29 · each PNG is 8-bit RGBA at the size its name says; the ICNS has 16–512 pt at 1× and 2× (ARGB at 16 and 32 px, PNG above) with the PNGs’ own pixels; the SVG draws the same body, rim and shadow and the large sprite clipped to the face, pixel for pixel', () => {
    for (const px of PNG_SIZES) {
      const img = decodePng(named(`png/${px}x${px}.png`))
      expect([img.width, img.height]).toEqual([px, px])
    }
    expect(Math.min(...PNG_SIZES)).toBe(16)
    expect(Math.max(...PNG_SIZES)).toBe(L.appIconGridPx)

    const icns = named('kea.icns')
    expect(icns.toString('ascii', 0, 4)).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const chunks = readIcns(icns)
    expect(chunks.map((c) => c.type)).toEqual(['ic04', 'ic05', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14'])
    // Apple's types: ic04/ic05 16/32 px; ic07…ic10 128…1024; ic11…ic14 the 2× of 16, 32, 128, 256 pt
    expect(ICNS_TYPES.map((t) => t.px)).toEqual([16, 32, 128, 256, 512, 1024, 32, 64, 256, 512])
    for (const [i, t] of ICNS_TYPES.entries()) {
      const data = chunks[i]!.data
      const img = t.argb ? decodeArgb(data, t.px) : decodePng(data)
      expect([img.width, img.height], t.type).toEqual([t.px, t.px])
      expect(Buffer.from(img.rgba).equals(Buffer.from(decodePng(named(`png/${t.px}x${t.px}.png`)).rgba)), t.type).toBe(true)
    }

    const svg = named('kea.svg').toString()
    expect(svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${L.appIconGridPx}" height="${L.appIconGridPx}" viewBox="0 0 ${L.appIconGridPx} ${L.appIconGridPx}">`))
    for (const c of [APP_ICON.rim, APP_ICON.face]) expect(svg).toContain(`fill="${c}"`)
    expect(svg).toContain(`translate(0 ${L.appIconShadowOffsetPx})`)
    // the bird: one path per sprite colour inside a group clipped to the face, kept square and seamless at any scale
    const group = /<g clip-path="url\(#face\)" shape-rendering="crispEdges">\n([\s\S]*)\n<\/g>/.exec(svg)
    expect(group).not.toBeNull()
    expect(svg).toContain('<clipPath id="face"><path d="M')
    const { sprite, scale, left, top } = placeArt(art, L.appIconGridPx)
    const colours = new Set<string>()
    for (let i = 0; i < sprite.width * sprite.height; i++) if (sprite.rgba[i * 4 + 3] === 255) colours.add(hex(sprite.rgba, i))
    const paths = [...group![1]!.matchAll(/<path d="([^"]*)" fill="(#[0-9A-F]{6})"\/>/g)]
    expect(paths.map((m) => m[2]).sort()).toEqual([...colours].sort())
    expect(svg.match(/<path /g)).toHaveLength(4 + colours.size) // the clip, shadow, rim and face, then the sprite's colours
    // the runs drawn back onto the sprite's grid: every opaque pixel once, in its colour, and nothing else
    const drawn = new Map<number, string>()
    for (const [, d, colour] of paths) {
      const runs = [...d!.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g)]
      expect(runs.map((r) => r[0]).join('')).toBe(d)
      for (const [, x, y, w, h, back] of runs) {
        expect([Number(h), Number(back)]).toEqual([scale, Number(w)])
        const sy = (Number(y) - top) / scale
        for (let sx = (Number(x) - left) / scale; sx < (Number(x) - left + Number(w)) / scale; sx++) {
          expect(drawn.has(sy * sprite.width + sx), `sprite pixel ${sx}, ${sy} twice`).toBe(false)
          drawn.set(sy * sprite.width + sx, colour!)
        }
      }
    }
    for (let i = 0; i < sprite.width * sprite.height; i++) expect(drawn.get(i), `sprite pixel ${i % sprite.width}, ${Math.floor(i / sprite.width)}`).toBe(sprite.rgba[i * 4 + 3] === 255 ? hex(sprite.rgba, i) : undefined)
  })

  it('U-PACK-30 · the menu-bar template is the shape main draws, in black and alpha only, and the tray icon the same in the accent; the app icon’s body is the face in its rim, clear at its corners', () => {
    for (const [name, px, color] of [
      ['trayTemplate.png', SIZE_PX.icon, '#000000'],
      ['trayTemplate@2x.png', SIZE_PX.icon * 2, '#000000'],
      ['trayAccent.png', SIZE_PX.icon, COLOR.accent],
      ['trayAccent@2x.png', SIZE_PX.icon * 2, COLOR.accent],
    ] as const) {
      const img = decodePng(named(name))
      expect([img.width, img.height], name).toEqual([px, px])
      // main's tray icon (app/main/src/trayIcon.ts) has the same coverage, from the same polygons
      const coverage = markCoverage(px)
      const colours = new Set<string>()
      for (let i = 0; i < px * px; i++) {
        expect(img.rgba[i * 4 + 3], `${name} pixel ${i}`).toBe(Math.round(coverage[i]! * 255))
        if (img.rgba[i * 4 + 3]! > 0) colours.add(hex(img.rgba, i))
      }
      expect([...colours], name).toEqual([color.toUpperCase()])
    }

    // the chevron meets the stem with no notch between them (a notch there shows at 1024 px)
    for (let y = 8.35; y < 8.8; y += 0.05) expect(insideMark(6.05, y), `(6.05, ${y.toFixed(2)}) on the mark's grid`).toBe(true)

    const big = decodePng(named(`png/${L.appIconGridPx}x${L.appIconGridPx}.png`))
    const at = (x: number, y: number) => y * big.width + x
    expect(big.rgba[at(0, 0) * 4 + 3]).toBe(0) // outside the body and its shadow
    expect(big.rgba[at(L.appIconGridPx - 1, 0) * 4 + 3]).toBe(0)
    const corner = (L.appIconGridPx - L.appIconBodyPx) / 2
    expect(big.rgba[at(corner + 2, corner + 2) * 4 + 3]).toBeLessThan(255) // the body's corner is rounded off
    expect(hex(big.rgba, at(L.appIconGridPx / 2, corner + L.appIconRimPx + 20))).toBe(APP_ICON.face.toUpperCase()) // above the bird
    expect(hex(big.rgba, at(L.appIconGridPx / 2, corner + L.appIconRimPx / 2))).toBe(APP_ICON.rim.toUpperCase())
  })

  it('U-PACK-55 · the bird at every size: the hand-drawn sprite at 16, 24, 32 and 48 px one pixel a sprite pixel, the large one a whole number of pixels a sprite pixel from 64 px; a sprite pixel keeps its exact colour wherever the face covers the pixel, and each sprite runs past the face’s left and bottom edges', () => {
    expect([...ART_SMALL.keys()]).toEqual([16, 24, 32, 48])
    const G = L.appIconGridPx
    const { face } = drawAppIcon()
    // the face covers the whole pixel: every grid pixel under it lies wholly inside
    const covered = (size: number, x: number, y: number) => {
      const f = G / size
      for (let gy = Math.floor(y * f); gy < Math.ceil((y + 1) * f); gy++) for (let gx = Math.floor(x * f); gx < Math.ceil((x + 1) * f); gx++) if (face[gy * G + gx] !== 1) return false
      return true
    }
    for (const size of PNG_SIZES) {
      const { sprite, scale, left, top } = placeArt(art, size)
      expect(sprite, `${size} px`).toBe(art.small.get(size) ?? art.large)
      expect(scale, `${size} px`).toBe(art.small.has(size) ? 1 : (L.appIconArtPx * size) / G)
      expect(Number.isInteger(scale) && scale >= 1, `${size} px`).toBe(true)
      // the bird is cut off at its left and bottom: its sprite reaches both edges and is placed past the face's
      const opaque = (sx: number, sy: number) => sprite.rgba[(sy * sprite.width + sx) * 4 + 3] === 255
      expect(Array.from({ length: sprite.height }, (_, sy) => opaque(0, sy)).some(Boolean), `${size} px: the left column`).toBe(true)
      expect(Array.from({ length: sprite.width }, (_, sx) => opaque(sx, sprite.height - 1)).some(Boolean), `${size} px: the bottom row`).toBe(true)
      expect(left, `${size} px`).toBeLessThanOrEqual((FACE_LO * size) / G)
      expect(top + sprite.height * scale, `${size} px`).toBeGreaterThanOrEqual((FACE_HI * size) / G)
      const img = decodePng(named(`png/${size}x${size}.png`))
      let checked = 0
      const wrong: string[] = []
      for (let sy = 0; sy < sprite.height; sy++)
        for (let sx = 0; sx < sprite.width; sx++) {
          if (!opaque(sx, sy)) continue
          const colour = hex(sprite.rgba, sy * sprite.width + sx)
          for (let y = top + sy * scale; y < top + (sy + 1) * scale; y++)
            for (let x = left + sx * scale; x < left + (sx + 1) * scale; x++) {
              if (!covered(size, x, y)) continue
              checked++
              if (hex(img.rgba, y * size + x) !== colour || img.rgba[(y * size + x) * 4 + 3] !== 255) wrong.push(`${x}, ${y}`)
            }
        }
      expect(wrong, `${size} px`).toEqual([])
      expect(checked, `${size} px`).toBeGreaterThan((sprite.width * sprite.height * scale * scale) / 3)
    }
    // a size with no sprite of its own where the large one falls between pixels is refused, naming the file to draw
    expect(() => placeArt(art, 40)).toThrow(`draw ${ART_DIR}/bird-40.png`)
    // a sprite with a pixel partly clear is refused, naming it
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-icon-art-'))
    try {
      fs.mkdirSync(path.join(temp, ART_DIR), { recursive: true })
      for (const name of [ART_LARGE, ...ART_SMALL.values()]) fs.copyFileSync(path.join(root, ART_DIR, name), path.join(temp, ART_DIR, name))
      const partly = decodePng(fs.readFileSync(path.join(temp, ART_DIR, 'bird-16.png')))
      partly.rgba[3] = 128
      fs.writeFileSync(path.join(temp, ART_DIR, 'bird-16.png'), encodePng(partly))
      expect(() => readArt(temp)).toThrow(`${ART_DIR}/bird-16.png has a pixel neither opaque nor clear`)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
})
