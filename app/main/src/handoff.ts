// Wayland window rebuild: GNOME's Wayland session brings back no minimized window Kea asks for, so main makes a new
// window in its place. What the old window kept only in its renderer would go with it; its composer drafts (kept per
// project until a session starts) are handed over: main asks the old window for them, checks the answer, and gives it
// to the window made in its place, whose preload asks for it as it starts (as often as Electron runs that preload while
// the window loads), until its page has started (`kea:hello`); then it is let go, so a reload later takes nothing. A
// window that does not answer in L.windowHandoffTimeoutMs is replaced without them. Other window-lived state (the find
// bar's query, the switcher's order, a paste waiting for its confirmation) is not handed over.

import { L, zWindowHandoff, type WindowHandoff as Handoff } from '@kea/protocol'

export class WindowHandoff {
  private next = 1
  /** The question out to the old window (one rebuild at a time). */
  private asking: { reqId: number; done(): void; timer: ReturnType<typeof setTimeout> } | null = null
  /** The old window's answer, held for the new window to take. */
  private kept: Handoff | null = null // bounded: one handoff, from the old window's answer until the new window's page has started
  /** The window made in the old one's place (its webContents id): the only one that may take what was handed over. */
  private target: number | null = null

  /**
   * Ask the old window for what it hands over (`send` posts the question with its id). Resolves when it has answered
   * (`answer`), when L.windowHandoffTimeoutMs has passed, or at once when the question cannot be sent.
   */
  ask(send: (reqId: number) => void): Promise<void> {
    this.finish()
    this.kept = null
    this.target = null
    const reqId = this.next++
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.finish(), L.windowHandoffTimeoutMs)
      this.asking = { reqId, done: resolve, timer }
      try {
        send(reqId)
      } catch {
        this.finish()
      }
    })
  }

  /** The old window's answer to question `reqId`: kept when it is the open question's and parses. Returns whether it was. */
  answer(reqId: unknown, state: unknown): boolean {
    if (!this.asking || reqId !== this.asking.reqId) return false
    const parsed = zWindowHandoff.safeParse(state)
    if (parsed.success) this.kept = parsed.data
    this.finish()
    return parsed.success
  }

  /** How many drafts are held for the next window (the log's), null when nothing is. */
  get held(): number | null {
    return this.kept?.drafts.length ?? null
  }

  /** The window made in the old one's place (`windowId`: its webContents id), which alone may take what was handed over. */
  giveTo(windowId: number): void {
    this.target = windowId
  }

  /** What the old window handed over, for the window made in its place (`windowId`); null for any other, or when there is nothing. */
  take(windowId: number): Handoff | null {
    return this.target === windowId ? this.kept : null
  }

  /** `windowId`'s page has started: what it was handed is let go. */
  started(windowId: number): void {
    if (this.target !== windowId) return
    this.kept = null
    this.target = null
  }

  private finish(): void {
    const a = this.asking
    if (!a) return
    this.asking = null
    clearTimeout(a.timer)
    a.done()
  }
}
