import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { L } from '../../../packages/protocol/src/generated/limits.ts'
import { COLOR, SIZE_PX } from '../../../packages/ui/src/generated/tokens.ts'
import { insideMark, MARK, markCoverage } from '../../../packages/ui/src/mark.ts'
import { APP_ICON, decodeArgb, decodePng, encodePng, ICNS_TYPES, ICON_DIR, iconFiles, PNG_SIZES, readIcns, sameIcon } from './icons.ts'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
const committed = (name: string) => fs.readFileSync(path.join(root, ICON_DIR, name))
const files = iconFiles()
const named = (name: string) => files.find((f) => f.name === name)!.bytes
const hex = (rgba: Uint8Array, i: number) => `#${[...rgba.subarray(i * 4, i * 4 + 3)].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`

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

  it('U-PACK-29 · each PNG is 8-bit RGBA at the size its name says; the ICNS has 16–512 pt at 1× and 2× (ARGB at 16 and 32 px, PNG above) with the PNGs’ own pixels; the SVG draws the same body, rim, K and shadow', () => {
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
    expect(svg.match(/<path /g)).toHaveLength(4) // shadow, rim, face, K
    for (const c of [APP_ICON.rim, APP_ICON.face, APP_ICON.mark]) expect(svg).toContain(`fill="${c}"`)
    expect(svg).toContain(`translate(0 ${L.appIconShadowOffsetPx})`)
    // the K is one path of the mark's polygons, all wound the same way, so their overlaps add instead of cancelling
    const area = (p: (typeof MARK)[number]) => p.reduce((s, [x, y], i) => s + x * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * y, 0)
    expect(new Set(MARK.map((p) => Math.sign(area(p)))).size).toBe(1)
    expect(svg.match(/M/g)?.length).toBe(3 + MARK.length) // shadow, rim, face, then one subpath per polygon
  })

  it('U-PACK-30 · the menu-bar template is the shape main draws, in black and alpha only, and the tray icon the same in the accent; the app icon is the K in the accent on the face, clear at its corners', () => {
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
    expect(hex(big.rgba, at(L.appIconGridPx / 2, corner + L.appIconRimPx + 20))).toBe(APP_ICON.face.toUpperCase()) // above the K
    expect(hex(big.rgba, at(L.appIconGridPx / 2, corner + L.appIconRimPx / 2))).toBe(APP_ICON.rim.toUpperCase())
    // the K, 40 % of the way down the grid
    const row = Math.round(L.appIconGridPx * 0.4)
    let accent = 0
    for (let x = 0; x < big.width; x++) if (hex(big.rgba, at(x, row)) === APP_ICON.mark.toUpperCase()) accent++
    expect(accent).toBeGreaterThan(0)
  })
})
