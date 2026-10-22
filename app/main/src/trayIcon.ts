// The menu-bar item's icon: a monochrome template image of the Kea mark at the icon size (`SIZE_PX.icon`), drawn at 1×
// and 2× from the mark's polygons (`@kea/ui/mark`, the shape the icon files of assets/icon/ are drawn from too), so no
// image file has to be read. A template image is black with alpha; macOS tints it to the menu bar's appearance (light,
// dark, highlighted). A Linux tray draws a template as it is, black, which is lost on a dark panel, so there the mark
// is drawn in Kea's accent, which reads on light and dark panels.

import { nativeImage, type NativeImage } from 'electron'
import { markCoverage } from '@kea/ui/mark'
import { COLOR, SIZE_PX } from '@kea/ui/tokens'

/** `#rrggbb` as its three channels. */
function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** BGRA pixels of the mark at `px` × `px`: black (a template), or `color` (`#rrggbb`), premultiplied by the coverage. */
export function markBitmap(px: number, color?: string): Buffer {
  const [r, g, b] = color ? channels(color) : [0, 0, 0]
  const coverage = markCoverage(px)
  const out = Buffer.alloc(px * px * 4)
  for (let p = 0; p < px * px; p++) {
    // the coverage as alpha, the colour premultiplied by it (black stays black)
    const a = coverage[p]!
    const i = p * 4
    out[i] = Math.round(b * a)
    out[i + 1] = Math.round(g * a)
    out[i + 2] = Math.round(r * a)
    out[i + 3] = Math.round(a * 255)
  }
  return out
}

/** The template image (or, `template` false, the mark in the accent), with its 2× representation for Retina menu bars and HiDPI panels. */
export function trayIcon(template = true): NativeImage {
  const pt = SIZE_PX.icon
  const color = template ? undefined : COLOR.accent
  const img = nativeImage.createFromBitmap(markBitmap(pt, color), { width: pt, height: pt, scaleFactor: 1 })
  img.addRepresentation({ scaleFactor: 2, width: pt * 2, height: pt * 2, buffer: markBitmap(pt * 2, color) })
  if (template) img.setTemplateImage(true)
  return img
}
