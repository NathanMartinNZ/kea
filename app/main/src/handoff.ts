// Wayland window rebuild: GNOME's Wayland session brings back no minimized window Kea asks for, so main makes a new
// window in its place. What the old window kept only in its renderer would go with it, so two things are handed over.
// · Its composer drafts (kept per project until a session starts): main asks the old window for them, checks the answer
//   (which counts only from the window asked), and gives it to the window made in its place, whose preload asks for it
//   as it starts (as often as Electron runs that preload while the window loads), until its page has started
//   (`kea:hello`); then it is let go, so a reload later takes nothing. A window that does not answer in
//   L.windowHandoffTimeoutMs is replaced without them. A restart Kea makes itself (Restart to Update, Restart Kea)
//   carries the drafts the same way, through a file the next start reads once (`updates/store.ts`), restored here for
//   its first window.
// · Its unsaved files (`DocumentHandover`), asked for the same way and held in main's memory only, never in a file. A window holding unsaved files that does not hand them over in
//   L.windowHandoffTimeoutMs is not rebuilt. The new window takes them once its page has loaded; the old window stays
//   until it has, and is kept, with its files, when the new window closes or fails to load first, has not taken them
//   L.windowRebuildTakeMs after they were held for it, or when the old one stops responding.
// Other window-lived state (the find bar's query, the switcher's order, a paste waiting for its confirmation, undo
// history) is not handed over.

import { L, zHandedDocuments, zWindowHandoff, type HandedDocuments, type WindowHandoff as Handoff } from '@kea/protocol'

export class WindowHandoff {
  private next = 1
  /** The question out to the old window (one rebuild at a time). */
  private asking: { from: number; reqId: number; done(): void; timer: ReturnType<typeof setTimeout> } | null = null
  /** The old window's answer, held for the new window to take. */
  private kept: Handoff | null = null // bounded: one handoff, from the old window's answer until the new window's page has started
  /** The window made in the old one's place (its webContents id): the only one that may take what was handed over. */
  private target: number | null = null

  /**
   * Ask the old window (`from`: its webContents id) for what it hands over (`send` posts the question with its id).
   * Resolves when it has answered (`answer`), when L.windowHandoffTimeoutMs has passed, or at once when the question
   * cannot be sent.
   */
  ask(from: number, send: (reqId: number) => void): Promise<void> {
    this.finish()
    this.kept = null
    this.target = null
    const reqId = this.next++
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.finish(), L.windowHandoffTimeoutMs)
      this.asking = { from, reqId, done: resolve, timer }
      try {
        send(reqId)
      } catch {
        this.finish()
      }
    })
  }

  /**
   * Window `from`'s answer to question `reqId`: kept when it comes from the window asked, answers the open question and
   * parses. Returns whether it was.
   */
  answer(from: number, reqId: unknown, state: unknown): boolean {
    if (!this.asking || from !== this.asking.from || reqId !== this.asking.reqId) return false
    const parsed = zWindowHandoff.safeParse(state)
    if (parsed.success) this.kept = parsed.data
    this.finish()
    return parsed.success
  }

  /** How many drafts are held for the next window (the log's), null when nothing is. */
  get held(): number | null {
    return this.kept?.drafts.length ?? null
  }

  /** What the old window handed over, for the file a restart Kea makes itself keeps it in; null when nothing is held. */
  get state(): Handoff | null {
    return this.kept
  }

  /** What the window kept for the restart that started this run (`<userData>/handoff.json`), held for the first window. */
  restore(state: Handoff): void {
    this.finish()
    this.kept = state
    this.target = null
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

/**
 * A rebuilt window's unsaved documents, from the old window's answer until the window made in its place takes them.
 * One hand-over at a time.
 */
export class DocumentHandover {
  private next = 1
  /** The question out to the old window. */
  private asking: { from: number; reqId: number; done(d: HandedDocuments | null): void; timer: ReturnType<typeof setTimeout> } | null = null
  /** What is held for the new window, and the rebuild waiting for it to be taken. */
  private held: { target: number; documents: HandedDocuments; done(taken: boolean): void; timer: ReturnType<typeof setTimeout> } | null = null // bounded: one hand-over, until the new window takes it or the rebuild is abandoned

  /**
   * Ask the old window for its unsaved documents (`send` posts the question with its id). Resolves with its answer,
   * checked (no documents: an empty list), or null when it does not answer in L.windowHandoffTimeoutMs, answers what
   * does not parse, or cannot be asked.
   */
  ask(from: number, send: (reqId: number) => void): Promise<HandedDocuments | null> {
    this.finish(null)
    const reqId = this.next++
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(null), L.windowHandoffTimeoutMs)
      this.asking = { from, reqId, done: resolve, timer }
      try {
        send(reqId)
      } catch {
        this.finish(null)
      }
    })
  }

  /** Window `from`'s answer to question `reqId` (null: it holds none). Returns whether it was taken. */
  answer(from: number, reqId: unknown, documents: unknown): boolean {
    if (!this.asking || from !== this.asking.from || reqId !== this.asking.reqId) return false
    if (documents === null) {
      this.finish({ documents: [] })
      return true
    }
    const parsed = zHandedDocuments.safeParse(documents)
    this.finish(parsed.success ? parsed.data : null)
    return parsed.success
  }

  /**
   * Hold `documents` for window `target`; resolves true once it takes them, false when the hand-over is abandoned, which
   * it is when the window has not taken them L.windowRebuildTakeMs from now (its page never started).
   */
  give(target: number, documents: HandedDocuments): Promise<boolean> {
    this.abandon()
    return new Promise((done) => {
      const timer = setTimeout(() => this.abandon(), L.windowRebuildTakeMs)
      this.held = { target, documents, done, timer }
    })
  }

  /** The documents held for `windowId`, once; null for any other window, or when nothing is held. */
  take(windowId: number): HandedDocuments | null {
    const h = this.held
    if (!h || h.target !== windowId) return null
    this.held = null
    clearTimeout(h.timer)
    h.done(true)
    return h.documents
  }

  /** Documents are held for `windowId`, which has not taken them yet. */
  waitsFor(windowId: number): boolean {
    return this.held?.target === windowId
  }

  /** The rebuild is abandoned (the new window closed or failed to load, the old one stopped responding): nothing is held. */
  abandon(): void {
    const h = this.held
    if (!h) return
    this.held = null
    clearTimeout(h.timer)
    h.done(false)
  }

  /** Documents held for a new window (the resource report). */
  get count(): number {
    return this.held?.documents.documents.length ?? 0
  }

  private finish(d: HandedDocuments | null): void {
    const a = this.asking
    if (!a) return
    this.asking = null
    clearTimeout(a.timer)
    a.done(d)
  }
}
