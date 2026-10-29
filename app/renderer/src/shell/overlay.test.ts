import { describe, expect, it } from 'vitest'
import { SIZE_PX, SPACE_PX } from '@kea/ui/tokens'
import { DEFAULT_LAYOUT, clampWidth, dragTo, drawn, RANGE, sidebarFloor, sidebarRange, stepWidth } from './layout.ts'
import { followOverlay, type Overlay } from './overlay.ts'

const WIDE = SIZE_PX['window-default-width']

/** A stand-in for `navigator.windowControlsOverlay`: the title-bar area starts at `x`; `move` is the desktop's change. */
function overlay(x: number): Overlay & { move(x: number, visible?: boolean): void; listeners(): number } {
  const target = new EventTarget()
  let left = x
  let shown = true
  let count = 0
  return {
    get visible() {
      return shown
    },
    getTitlebarAreaRect: () => ({ x: left, y: 0, width: 800, height: SIZE_PX['window-controls'] }) as DOMRect,
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      count++
      target.addEventListener(type, fn)
    },
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      count--
      target.removeEventListener(type, fn)
    },
    move(next: number, visible = true) {
      left = next
      shown = visible
      target.dispatchEvent(new Event('geometrychange'))
    },
    listeners: () => count,
  }
}

describe('the sidebar floor under the window controls overlay', () => {
  it('U-PLT-63 · window buttons on the left raise the sidebar minimum to hold them and the header\'s two buttons; on the right, or none, it is the token', () => {
    const header = (x: number) => x + 2 * (SIZE_PX.row + 2 * SPACE_PX[1]) + 2 * SPACE_PX[0] + SIZE_PX.hairline
    expect(sidebarFloor(0)).toBe(RANGE.sidebar.min)
    expect(sidebarFloor(Number.NaN)).toBe(RANGE.sidebar.min)
    // a narrow left area still fits in the token
    expect(sidebarFloor(4)).toBe(Math.max(RANGE.sidebar.min, header(4)))
    // GNOME's three buttons on the left
    expect(sidebarFloor(108)).toBe(header(108))
    expect(sidebarFloor(108.4)).toBe(Math.ceil(header(108.4)))
    // the floor reaches clamping, drawing, dragging, stepping and the divider's range
    const floor = sidebarFloor(108)
    expect(clampWidth('sidebar', RANGE.sidebar.min, floor)).toBe(floor)
    expect(drawn({ ...DEFAULT_LAYOUT, sidebarWidth: RANGE.sidebar.min }, WIDE, floor).sidebar).toBe(floor)
    expect(dragTo(DEFAULT_LAYOUT, 'sidebar', SIZE_PX.sidebar, -1000, WIDE, SIZE_PX['main-min'], floor).sidebarWidth).toBe(floor)
    expect(stepWidth({ ...DEFAULT_LAYOUT, sidebarWidth: floor }, 'sidebar', -1, WIDE, SIZE_PX['main-min'], floor).sidebarWidth).toBe(floor)
    expect(sidebarRange(floor)).toEqual({ min: floor, max: RANGE.sidebar.max })
    expect(sidebarRange(0).min).toBe(RANGE.sidebar.min)
    // the file panel's range is its own
    expect(clampWidth('tree', 0, floor)).toBe(RANGE.tree.min)
  })

  it('U-PLT-63 · the floor follows the overlay: read at once, again on each geometry change, the token while the overlay hides; one listener, removed at the end', () => {
    const o = overlay(0)
    const seen: number[] = []
    const off = followOverlay(o, (f) => seen.push(f))
    expect(seen).toEqual([RANGE.sidebar.min])
    expect(o.listeners()).toBe(1)
    o.move(108)
    expect(seen.at(-1)).toBe(sidebarFloor(108))
    // full screen: the overlay is gone, and so is the reason for the larger floor
    o.move(108, false)
    expect(seen.at(-1)).toBe(RANGE.sidebar.min)
    off()
    expect(o.listeners()).toBe(0)
    o.move(200)
    expect(seen).toHaveLength(3)
    // macOS: no overlay at all
    const mac: number[] = []
    followOverlay(undefined, (f) => mac.push(f))()
    expect(mac).toEqual([RANGE.sidebar.min])
  })
})
