// The Kea mark: a K of three polygons on a 16-unit grid, a stem and two arms. One shape everywhere: main draws
// the menu-bar item and the Linux tray icon from it at run time (app/main/src/trayIcon.ts), and tools/pack/src/icons.ts
// draws the app icon and the icon files of assets/icon/ from it. No Node, DOM or Electron API, so main, the tools and
// the tests share it as it is.

import { L } from '@kea/protocol/limits'

export type Point = readonly [number, number]
export type Polygon = readonly Point[]

/** The grid the mark is drawn on: 16 units, so a unit is a point of the 16 pt menu-bar icon. */
export const MARK_GRID = 16

/**
 * The mark: a stem and a chevron (a K). The chevron is two quadrilaterals that share the edge from its point, a little
 * inside the stem, to the crotch between the arms, so the stem and the arms meet without a notch or a seam at any size.
 */
export const MARK: readonly Polygon[] = [
  [
    [3, 2],
    [6, 2],
    [6, 14],
    [3, 14],
  ],
  [
    [5.8, 8.6],
    [11.2, 2],
    [14.6, 2],
    [9.4, 8.4],
  ],
  [
    [9.4, 8.4],
    [14.6, 14],
    [11, 14],
    [5.8, 8.6],
  ],
]

/** Whether (x, y) lies inside `poly` (even-odd crossings). */
export function insidePolygon(poly: Polygon, x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** Whether the grid point (x, y) lies inside the mark. */
export function insideMark(x: number, y: number): boolean {
  return MARK.some((p) => insidePolygon(p, x, y))
}

/** The mark's bounding box on its grid, `[left, top, right, bottom]`. */
export function markBounds(): [number, number, number, number] {
  const xs = MARK.flat().map(([x]) => x)
  const ys = MARK.flat().map(([, y]) => y)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/**
 * The share of each pixel of a `px` × `px` square over the grid that the mark covers, row by row: `L.iconSamples`²
 * samples per pixel, each inside or not, so the share is a whole number of samples over their count (the same on every
 * system).
 */
export function markCoverage(px: number): Float64Array {
  const samples = L.iconSamples
  const out = new Float64Array(px * px)
  const unit = MARK_GRID / px
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      let n = 0
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          if (insideMark((x + (sx + 0.5) / samples) * unit, (y + (sy + 0.5) / samples) * unit)) n++
        }
      out[y * px + x] = n / (samples * samples)
    }
  return out
}
