// The Window Controls Overlay API (Chromium): where a frameless window's own buttons leave its title bar free. It is
// missing from TypeScript's DOM library; the layout reads it where the overlay draws the window's buttons (Linux).
export {}

declare global {
  interface WindowControlsOverlay extends EventTarget {
    readonly visible: boolean
    getTitlebarAreaRect(): DOMRect
  }

  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay
  }
}
