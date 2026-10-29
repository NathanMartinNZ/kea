// The application menu the window draws on Linux (WindowMenu.svelte): the opening on screen, as main sent it, and
// whether the keyboard was in a terminal when it opened (Edit › Select All then selects the terminal's text). Small
// values only: labels and ids. An opening is asked of main and drawn when its items arrive; the button or `Alt` alone
// pressed again in between cancels it, so a quick second press closes the menu rather than asking main twice.

import type { WindowMenuOpening } from '../lib/bridge.ts'

class WindowMenuUi {
  open = $state.raw<(WindowMenuOpening & { inTerminal: boolean }) | null>(null)
  /** An opening asked of main whose items have not arrived. */
  private asked = false

  /** The button or `Alt` alone: closes the menu, or cancels the opening asked for; otherwise true, to ask main. */
  toggle(): boolean {
    if (this.open || this.asked) {
      this.open = null
      this.asked = false
      return false
    }
    this.asked = true
    return true
  }

  /** Main's items for an opening: drawn when one was asked for and not cancelled since. */
  arrived(m: WindowMenuOpening, inTerminal: boolean): void {
    if (!this.asked) return
    this.asked = false
    this.open = { ...m, inTerminal }
  }
}

export const windowMenuUi = new WindowMenuUi()
