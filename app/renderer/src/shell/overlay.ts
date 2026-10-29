// The sidebar's minimum where the window's own buttons sit on the left of a Linux title bar: read from the Window
// Controls Overlay (`titlebar-area-x`) now and again whenever the desktop moves the buttons or the overlay hides (full
// screen). macOS has no overlay, and the token is the minimum there.

import { sidebarFloor } from './layout.ts'

/** What the layout reads of `navigator.windowControlsOverlay`. */
export type Overlay = Pick<WindowControlsOverlay, 'visible' | 'getTitlebarAreaRect' | 'addEventListener' | 'removeEventListener'>

/** Report the floor now and on every `geometrychange`; the returned function stops listening. */
export function followOverlay(overlay: Overlay | undefined, set: (floor: number) => void): () => void {
  const read = () => set(sidebarFloor(overlay?.visible ? overlay.getTitlebarAreaRect().x : 0))
  overlay?.addEventListener('geometrychange', read)
  read()
  return () => overlay?.removeEventListener('geometrychange', read)
}
