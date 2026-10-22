// The window's menu on Linux: the header's menu button opens the application menu under it (main's `Menu.popup()`,
// built from the same registry as the menu bar), and so does `Alt` pressed and released alone, the habit of Linux apps
// whose menu is hidden; with the Window Controls Overlay there is no menu bar for `Alt` to reveal. `Alt` held with
// another key, or with a click, is that chord's, not the menu's. macOS has its menu bar and no button
// (`protocolOs.window.menuButton`).

import { protocolOs } from '@kea/protocol'
import { openWindowMenu } from '../lib/bridge.ts'

/** What the detector reads of a key event. */
export type KeyLike = { key: string; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; repeat: boolean; isComposing?: boolean }

/**
 * `Alt` pressed and released with nothing else between: a press of `Alt` with no other modifier arms it; any other key,
 * a click, a lost focus or a composition disarms it; its release while armed is the menu's.
 */
export class AltAlone {
  private armed = false

  down(e: KeyLike): void {
    if (e.key === 'Alt') {
      // held down, the key repeats: still alone
      if (!e.repeat) this.armed = !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.isComposing
      return
    }
    this.armed = false
  }

  /** True when this release opens the menu. */
  up(e: KeyLike): boolean {
    const open = this.armed && e.key === 'Alt'
    this.armed = false
    return open
  }

  /** A click, the window losing focus: `Alt` was not pressed alone. */
  reset(): void {
    this.armed = false
  }
}

/** Where the menu opens: under the header's menu button (its bottom-left corner, in the window's coordinates). */
export function menuAnchor(button: { getBoundingClientRect(): { left: number; bottom: number } } | null): { x: number; y: number } {
  if (!button) return { x: 0, y: 0 }
  const r = button.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.bottom) }
}

/** Opens the menu under the header's button (the leftmost visible header holds it: WindowMenuButton.svelte). */
export function openMenuUnderButton(): void {
  const { x, y } = menuAnchor(document.querySelector<HTMLElement>('[data-window-menu]'))
  openWindowMenu(x, y)
}

let installed = false

/** `Alt` alone opens the menu: the window's listeners, installed once for its lifetime. */
export function installWindowMenu(): void {
  if (installed || !protocolOs.window.menuButton) return
  installed = true
  const alt = new AltAlone()
  window.addEventListener('keydown', (e) => alt.down(e), true)
  window.addEventListener(
    'keyup',
    (e) => {
      if (alt.up(e)) openMenuUnderButton()
    },
    true,
  )
  window.addEventListener('pointerdown', () => alt.reset(), true)
  window.addEventListener('blur', () => alt.reset())
}
