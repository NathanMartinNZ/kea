// The width of a terminal cell at the saved font settings (`terminal.fontSize`, `terminal.fontFamily`; never the zoom,
// which is not saved), as the WebGL renderer lays it out: the advance of `W` in the terminal font, rounded down to
// device pixels. The split's minimums are columns, and this turns them into px. Measured once the face has loaded
// (`document.fonts.ready` does not wait for a face nothing has asked for yet); kept in the window's layout so a
// window's first frame uses the last measurement.

import { terminalFontStack } from '@kea/terminal'

export interface CellFont {
  fontFamily: string
  fontSize: number
}

function font(f: CellFont): string {
  return `${f.fontSize}px ${terminalFontStack(f.fontFamily)}`
}

/** The cell width now, with whichever face the canvas has (null: no canvas, or nothing measured). */
export function measureCellNow(f: CellFont, dpr: number = window.devicePixelRatio || 1): number | null {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  ctx.font = font(f)
  const w = ctx.measureText('W').width
  return w > 0 ? Math.floor(w * dpr) / dpr : null
}

/** The cell width once the terminal font's face has loaded. */
export async function measureCell(f: CellFont): Promise<number | null> {
  try {
    await document.fonts.load(font(f))
  } catch (e) {
    console.warn('terminal font not loaded for the cell width', e)
  }
  return measureCellNow(f)
}
