// The grid a new shell is spawned at: the terminal area's size in cells, measured with the terminal font
// before any terminal exists to ask. The view refits once attached and resizes the PTY if the estimate was off.

import { L } from '@kea/protocol'
import { terminalFontStack, type Appearance } from '@kea/terminal'

export function estimateGrid(area: HTMLElement | null, a: Appearance): { cols: number; rows: number } {
  const min = { cols: L.ptyMinCols, rows: L.ptyMinRows }
  if (!area) return min
  const host = area.querySelector<HTMLElement>('.terminal-host') ?? area
  const style = getComputedStyle(host)
  const width = host === area ? area.clientWidth - 2 * parseFloat(style.getPropertyValue('--size-terminal-pad-x')) : host.clientWidth
  const height = host === area ? area.clientHeight - 2 * parseFloat(style.getPropertyValue('--size-terminal-pad-y')) : host.clientHeight
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx || !(width > 0) || !(height > 0)) return min
  ctx.font = `${a.fontSize}px ${terminalFontStack(a.fontFamily)}`
  const cell = ctx.measureText('W').width
  if (!(cell > 0)) return min
  return { cols: Math.max(min.cols, Math.floor(width / cell)), rows: Math.max(min.rows, Math.floor(height / Math.ceil(a.fontSize * a.lineHeight))) }
}
