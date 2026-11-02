// Before main does anything that would close a window's unsaved text (a quit, Keep in Menu Bar, a restart, a window's
// close, Reload Window) it asks the windows to review their unsaved files: a window puts each one on screen in turn and
// asks Save, Don't Save or Cancel. No Electron here: main.ts hands in the windows, the messages and the actions, so the
// rules are unit-tested in Node (U-FV-29).
//
// · Requests queue. Each runs after the one before and asks every window whose page is up, one after another; an answer
//   is never shared between requests. The same quit asked again while one waits its turn (a held `⌘Q`, Dock › Quit
//   pressed again) joins the one waiting rather than queueing once per press. A window with unsaved files is brought
//   forward first (on Wayland a minimized one is rebuilt, and the window made in its place is asked). A cancel ends the
//   request there, and the action does not happen.
// · A window acknowledges a request at once and answers once the user has, with no deadline on the answer. With no
//   acknowledgement within L.windowReviewAckMs, the window unresponsive while asked, or a window that cannot be brought
//   forward (its rebuild failed, or the window made in its place did not take the documents in time), main decides
//   without it: a window whose last unsaved count is 0 counts as proceed (a window that cannot acknowledge cannot type
//   either), one with unsaved files as cancel, and the window is marked as having missed a request until it next
//   acknowledges one. An explicit quit (`⌘Q`, Dock › Quit, the menu-bar item's Quit; never a signal) or the close of a
//   marked window goes ahead without a marked window that misses its deadline, or cannot be shown, again: that window's
//   unsaved text is lost. A late acknowledgement is told what was decided.
// · A window closed, or whose page went away, while it is asked counts as proceed (its unsaved text went with it). A
//   window rebuilt in its place passes the request on; the new window's deadline starts once it has taken the documents.
//   A window's close or reload acts on the window the user answered in, the rebuilt one included.
// · Every window that answered (or was counted) proceed is held by the request's ticket and stays read-only until the
//   action is over: `settle(went)` tells each one once (`went` false: the action did not happen, and the window gives
//   back what its review set aside). A window stays read-only while any ticket holds it, and main does not review again
//   a window that answered proceed when it closes that window for the action.
// · Once Kea is going (quitting, restarting, stopping every terminal to quit), a request answers proceed without asking
//   and tickets tell nothing: the windows go with Kea.
//
// `Leaving` is every way Kea goes, each after the review: a quit (Stop All and Quit first while terminals run), Keep in
// Menu Bar, a restart. `quitting`, `relaunching` and `stoppingAll` are set only once the review answered proceed, so a
// cancel leaves nothing set; a caller that has reviewed passes its ticket on, so no file is asked about twice. Squirrel's
// install keeps Kea going until it quits Kea or reports that it failed (during the install call too). SIGTERM, SIGINT
// and SIGHUP are quits that are not the user's own, which main handles itself in place of Electron's handlers.

import { systemClock, type Clock, type Logger } from '@kea/kit'
import { L, type ReviewReason } from '@kea/protocol'
import type { UpdaterDriver, UpdaterEvents } from './updates/driver.ts'

/** What a window answers, and what main decides for a window it could not ask. */
export type ReviewAnswer = 'proceed' | 'cancel'

/** What main tells a window: a request to review (`kea:review`), what it decided without it, and an action over. */
export type ReviewMessage = { k: 'review'; reqId: number; reason: ReviewReason } | { k: 'decided'; reqId: number; outcome: ReviewAnswer } | { k: 'closeDone'; reqId: number; went: boolean }

/** A request's answer, and the windows it holds read-only until the action is over. */
export interface Ticket {
  /** Every window asked answered proceed (or was counted so): the action may happen. */
  readonly proceed: boolean
  /**
   * A request for one window (`only`): the window it ended in, that one or the one rebuilt in its place to be asked;
   * absent when no window was asked (Kea is going).
   */
  readonly window?: number
  /** The action is over; `went` when it happened (Kea quit, the window closed or reloaded). Only the first call counts. */
  settle(went: boolean): void
}

export interface ReviewOptions {
  /** Ask this window alone (its own close, Reload Window); default: every window whose page is up. */
  only?: number
  /**
   * An explicit quit (`⌘Q`, Dock › Quit, the menu-bar item's Quit), or the close of a window marked as having missed a
   * request: a marked window that misses this request's deadline too, is unresponsive or cannot be shown, counts as
   * proceed.
   */
  explicit?: boolean
  /** The same request asked again while one waits its turn (a held `⌘Q`, Dock › Quit pressed again) joins it. */
  join?: string
}

export interface ReviewDeps {
  /** Post to a window (its webContents id); false when it cannot be (gone). */
  post(id: number, m: ReviewMessage): boolean
  /**
   * Bring a window with unsaved files forward before it is asked; resolves the window to ask (itself, or the one rebuilt
   * in its place), or null when it cannot be shown, which counts as a window that did not acknowledge.
   */
  forward(id: number): Promise<number | null>
  /** Kea is going: quitting, restarting, or stopping every terminal to quit. */
  going(): boolean
  /** A window's unsaved count changed (macOS's edited dot). */
  counted?(id: number, n: number): void
  clock?: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  log: Pick<Logger, 'info' | 'warn'>
}

/** What main knows of one window. */
interface Win {
  /** Its page has said hello since it last loaded: it is asked. */
  up: boolean
  /** Its last `kea:unsavedCount`. */
  unsaved: number
  /** It missed a request's acknowledgement, and has acknowledged none since. */
  missed: boolean
  /** It answered (or was counted) proceed, and no ticket has given it back since. */
  proceeded: boolean
  /** The requests whose tickets hold it. */
  tickets: Set<number> // bounded: one per request whose action is under way (a quit, close, reload or restart the user asked for)
  /** Its own close: under review, or reviewed and made again (which then closes it unasked). */
  closing: 'asking' | 'reviewed' | null
}

/** The request out to one window. */
interface Ask {
  reqId: number
  /** The window asked: one rebuilt in its place takes the request over. */
  id: number
  reason: ReviewReason
  explicit: boolean
  phase: 'sent' | 'acked'
  timer: unknown
  done(r: { outcome: ReviewAnswer | 'gone'; id: number }): void
}

class RequestTicket implements Ticket {
  readonly reqId: number
  proceed = true
  window: number | undefined = undefined
  settled = false
  /** The windows it holds. */
  readonly windows = new Set<number>() // bounded: one per open window
  private readonly reviews: WindowReviews

  constructor(reqId: number, reviews: WindowReviews) {
    this.reqId = reqId
    this.reviews = reviews
  }

  settle(went: boolean): void {
    if (this.settled) return
    this.settled = true
    this.reviews.release(this, went)
  }
}

/** A request answered without asking (Kea is going): it holds nothing and tells nothing. */
const GOING: Ticket = { proceed: true, settle: () => undefined }

/** A request that joined the same one waiting its turn: that one acts for both, so this one does nothing. */
const JOINED: Ticket = { proceed: false, settle: () => undefined }

export class WindowReviews {
  private readonly d: ReviewDeps
  private readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  private readonly wins = new Map<number, Win>() // bounded: one per open window
  /** Tickets whose action is not over yet, with the windows they hold. */
  private readonly open = new Map<number, RequestTicket>() // bounded: one per request whose action is under way
  private asking: Ask | null = null
  private tail: Promise<unknown> = Promise.resolve()
  /** Requests waiting their turn or under way. */
  private requests = 0
  /** The `join` names of requests waiting their turn (not yet asking). */
  private readonly waiting = new Set<string>() // bounded: one per name callers join by (the ways Kea quits)
  private nextReq = 1

  constructor(d: ReviewDeps) {
    this.d = d
    this.clock = d.clock ?? systemClock
  }

  /** Row `main.reviews`: the windows known, the requests waiting or under way, the tickets holding windows. */
  counts(): { windows: number; requests: number; tickets: number } {
    return { windows: this.wins.size, requests: this.requests, tickets: this.open.size }
  }

  /**
   * Ask the windows (`o.only`: one) to review their unsaved files before `reason`'s action. Resolves once every window
   * has answered, or the first cancel: the ticket says which, and its `settle` must run once the action is over.
   */
  prepare(reason: ReviewReason, o: ReviewOptions = {}): Promise<Ticket> {
    if (this.d.going()) return Promise.resolve(GOING)
    const join = o.join
    if (join !== undefined) {
      if (this.waiting.has(join)) return Promise.resolve(JOINED)
      this.waiting.add(join)
    }
    this.requests++
    const run = this.tail.then(async (): Promise<Ticket> => {
      if (join !== undefined) this.waiting.delete(join)
      const t = new RequestTicket(this.nextReq++, this)
      try {
        return await this.run(t, reason, o)
      } catch (e) {
        // what the windows before the failure set aside is given back, and nothing is left out to a window
        this.d.log.warn('review failed: nothing is closed', { reason, error: e instanceof Error ? e.message : String(e) })
        const a = this.asking
        if (a?.reqId === t.reqId) {
          this.asking = null
          this.clock.clearTimeout(a.timer)
        }
        return this.cancel(t)
      } finally {
        this.requests--
      }
    })
    this.tail = run
    return run
  }

  // ── what the windows say ─────────────────────────────────────────────────────────────────────────────────────────

  /** A window's page is up (`kea:hello`): requests ask it. */
  hello(id: number): void {
    this.win(id).up = true
  }

  /** A window's unsaved count (`kea:unsavedCount`). */
  setUnsaved(id: number, n: number): void {
    const w = this.win(id)
    if (w.unsaved === n) return
    w.unsaved = n
    this.d.counted?.(id, n)
  }

  /** A window acknowledged request `reqId`. A late one is told what main decided without it. */
  ack(id: number, reqId: number): void {
    const w = this.wins.get(id)
    if (!w) return
    w.missed = false
    const a = this.asking
    if (a && a.id === id && a.reqId === reqId) {
      if (a.phase === 'sent') {
        a.phase = 'acked'
        this.clock.clearTimeout(a.timer)
      }
      return
    }
    this.d.post(id, { k: 'decided', reqId, outcome: w.tickets.has(reqId) ? 'proceed' : 'cancel' })
  }

  /** A window's answer to request `reqId`; ignored when main has decided without it. */
  answer(id: number, reqId: number, answer: ReviewAnswer): void {
    const a = this.asking
    if (!a || a.id !== id || a.reqId !== reqId) return
    const w = this.wins.get(id)
    if (w) w.missed = false
    this.end(a, answer)
  }

  /**
   * Electron reports the window unresponsive: a request out to it is decided without it. True: it holds nothing unsaved,
   * and main ends its renderer (the window reloads in a new one); false: it is left to recover, since ending it would
   * lose its unsaved files.
   */
  unresponsive(id: number): boolean {
    const a = this.asking
    if (a && a.id === id) this.decideWithout(a, 'unresponsive')
    return this.unsaved(id) === 0
  }

  /** The window's page went away (a reload, its renderer gone, the window closed): what it held goes with it. */
  gone(id: number): void {
    const w = this.wins.get(id)
    if (!w) return
    w.up = false
    w.missed = false
    w.proceeded = false
    for (const reqId of w.tickets) this.open.get(reqId)?.windows.delete(id)
    w.tickets.clear()
    this.setUnsaved(id, 0)
    const a = this.asking
    if (a && a.id === id) this.end(a, 'gone')
  }

  /** The window closed. */
  closed(id: number): void {
    this.gone(id)
    this.wins.delete(id)
  }

  /**
   * A window rebuilt on Wayland took `documents` unsaved documents from the one it replaces (`old`): its count is that
   * until it reports its own, and a request out to the old window is asked of it now, its deadline starting now.
   */
  replaced(old: number, id: number, documents: number): void {
    this.win(id).up = true
    this.setUnsaved(id, documents)
    const a = this.asking
    if (!a || a.id !== old) return
    this.clock.clearTimeout(a.timer)
    a.id = id
    this.send(a)
  }

  // ── what main reads ──────────────────────────────────────────────────────────────────────────────────────────────

  /** The window's last unsaved count. */
  unsaved(id: number): number {
    return this.wins.get(id)?.unsaved ?? 0
  }

  /** Some window has unsaved files. */
  anyUnsaved(): boolean {
    for (const w of this.wins.values()) if (w.unsaved > 0) return true
    return false
  }

  /** The window missed a request and has acknowledged none since. */
  hasMissed(id: number): boolean {
    return this.wins.get(id)?.missed === true
  }

  /**
   * The window can be asked a question of main's own (the first-quit sheet): its page is up, and it has not missed a
   * request (on Linux, with no Dock, a hung window asked could otherwise never be closed nor Kea quit).
   */
  canAsk(id: number): boolean {
    const w = this.wins.get(id)
    return w?.up === true && !w.missed
  }

  /** The window answered proceed for the action under way: main closes it without asking again. */
  mayClose(id: number): boolean {
    return this.wins.get(id)?.proceeded === true
  }

  // ── what main asks for one window ────────────────────────────────────────────────────────────────────────────────

  /**
   * Electron's `close` of window `id` (its close button, the shell's ×). True: it closes now, since it answered proceed
   * for the action under way (Keep in Menu Bar, Squirrel's install, the last window's quit), Kea is going, or its own
   * review allowed this close. False: the close is held while the window reviews its unsaved files, and on proceed
   * `again` closes the window the user answered in (false when it is gone): this one, or on Wayland the window rebuilt in
   * place of this minimized one to be asked. The close of a window marked as having missed a request goes ahead as an
   * explicit quit does; a close while its review is out asks nothing more.
   */
  close(id: number, again: (id: number) => boolean): boolean {
    if (this.d.going()) return true
    const w = this.win(id)
    if (w.closing === 'reviewed' || w.proceeded) return true
    if (w.closing === 'asking') return false
    w.closing = 'asking'
    void this.forWindow('close', id, w.missed, (target) => {
      const x = this.wins.get(target)
      if (x) x.closing = 'reviewed'
      return again(target)
    }).finally(() => {
      const x = this.wins.get(id)
      if (x?.closing === 'asking') x.closing = null
    })
    return false
  }

  /** Developer › Reload Window: the window reviews its unsaved files first; `reload` answers false when it is gone. */
  reload(id: number, reload: (id: number) => boolean): Promise<void> {
    return this.forWindow('reload', id, false, reload)
  }

  /**
   * Review window `id` alone, then `act` on the window the review ended in (`act` answers whether the action happened);
   * the ticket settles once either way.
   */
  private async forWindow(reason: 'close' | 'reload', id: number, explicit: boolean, act: (id: number) => boolean): Promise<void> {
    const t = await this.prepare(reason, { only: id, explicit })
    let went = false
    try {
      if (t.proceed) went = act(t.window ?? id)
    } catch (e) {
      this.d.log.warn('review: the action after it failed', { reason, error: e instanceof Error ? e.message : String(e) })
    } finally {
      t.settle(went)
    }
  }

  // ── a request ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async run(t: RequestTicket, reason: ReviewReason, o: ReviewOptions): Promise<Ticket> {
    if (this.d.going()) return GOING
    const asked = new Set<number>() // bounded: one per open window, gone with the request
    t.window = o.only
    for (let id = this.nextToAsk(o.only, asked); id !== null; id = this.nextToAsk(o.only, asked)) {
      asked.add(id)
      let target: number | null = id
      if (this.unsaved(id) > 0) {
        target = await this.d.forward(id).catch(() => null)
        if (target === null) {
          // it could not be asked, as one that does not acknowledge: decided without it
          if (this.decide(id, o.explicit === true, 'not shown') === 'cancel') return this.cancel(t)
          this.hold(t, id)
          continue
        }
        asked.add(target)
        if (o.only !== undefined) t.window = target
        if (!this.wins.get(target)?.up) continue // made in its place with nothing handed over
      }
      const r = await this.ask(t.reqId, target, reason, o.explicit === true)
      if (r.outcome === 'cancel') return this.cancel(t)
      if (r.outcome === 'proceed') this.hold(t, r.id)
      asked.add(r.id)
      if (o.only !== undefined) t.window = r.id // rebuilt while it was asked: the window that answered
    }
    return t
  }

  private nextToAsk(only: number | undefined, asked: ReadonlySet<number>): number | null {
    if (only !== undefined) return !asked.has(only) && this.wins.get(only)?.up ? only : null
    for (const [id, w] of this.wins) if (w.up && !asked.has(id)) return id
    return null
  }

  private ask(reqId: number, id: number, reason: ReviewReason, explicit: boolean): Promise<{ outcome: ReviewAnswer | 'gone'; id: number }> {
    return new Promise((done) => {
      const a: Ask = { reqId, id, reason, explicit, phase: 'sent', timer: null, done }
      this.asking = a
      this.send(a)
    })
  }

  /** Post the request to the window it is out to, its acknowledgement's deadline starting now. */
  private send(a: Ask): void {
    a.phase = 'sent'
    if (!this.wins.get(a.id)?.up) return this.end(a, 'gone')
    a.timer = this.clock.setTimeout(() => this.decideWithout(a, 'no acknowledgement'), L.windowReviewAckMs)
    if (!this.d.post(a.id, { k: 'review', reqId: a.reqId, reason: a.reason })) this.end(a, 'gone')
  }

  private decideWithout(a: Ask, why: 'no acknowledgement' | 'unresponsive'): void {
    if (this.asking !== a) return
    const outcome = this.decide(a.id, a.explicit, why)
    const acked = a.phase === 'acked'
    this.end(a, outcome)
    // a window that acknowledged is reviewing: it hears now (a window that did not hears when it acknowledges)
    if (acked) this.d.post(a.id, { k: 'decided', reqId: a.reqId, outcome })
  }

  /**
   * Main decides for a window it could not ask (no acknowledgement, unresponsive, or it could not be brought forward):
   * proceed when it holds nothing unsaved, or for an explicit request when it had missed one already; cancel otherwise.
   * Either way it is marked as having missed a request.
   */
  private decide(id: number, explicit: boolean, why: 'no acknowledgement' | 'unresponsive' | 'not shown'): ReviewAnswer {
    const w = this.wins.get(id)
    const unsaved = w?.unsaved ?? 0
    const wasMarked = w?.missed === true
    if (w) w.missed = true
    const outcome: ReviewAnswer = unsaved === 0 || (explicit && wasMarked) ? 'proceed' : 'cancel'
    if (unsaved === 0) this.d.log.info('review: a window with nothing unsaved did not answer, and counts as proceed', { why })
    else if (outcome === 'proceed') this.d.log.warn('review: going ahead without a window that did not answer again: its unsaved files are lost', { why, unsaved })
    else this.d.log.warn('review: a window with unsaved files did not answer, so nothing is closed', { why, unsaved })
    return outcome
  }

  private end(a: Ask, outcome: ReviewAnswer | 'gone'): void {
    if (this.asking !== a) return
    this.asking = null
    this.clock.clearTimeout(a.timer)
    a.done({ outcome, id: a.id })
  }

  private hold(t: RequestTicket, id: number): void {
    const w = this.wins.get(id)
    if (!w) return
    t.windows.add(id)
    w.tickets.add(t.reqId)
    w.proceeded = true
    this.open.set(t.reqId, t)
  }

  /** A cancel: the windows that answered proceed before it get their documents back. */
  private cancel(t: RequestTicket): Ticket {
    t.proceed = false
    t.settle(false)
    return t
  }

  /** A ticket settled: each window it holds is told once, unless Kea is going. */
  release(t: RequestTicket, went: boolean): void {
    this.open.delete(t.reqId)
    const quiet = this.d.going()
    for (const id of t.windows) {
      const w = this.wins.get(id)
      if (!w || !w.tickets.delete(t.reqId)) continue
      if (!quiet) this.d.post(id, { k: 'closeDone', reqId: t.reqId, went })
      if (!went && w.tickets.size === 0) w.proceeded = false
    }
    t.windows.clear()
  }

  private win(id: number): Win {
    let w = this.wins.get(id)
    if (!w) this.wins.set(id, (w = { up: false, unsaved: 0, missed: false, proceeded: false, tickets: new Set(), closing: null }))
    return w
  }
}

// ── how Kea goes ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The signals main handles itself as a quit that is not the user's own: SIGTERM (an install replacing Kea, a service
 * manager, a Linux session ending), SIGINT (⌃C in the terminal Kea was started from) and SIGHUP (that terminal closed).
 */
export const QUIT_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const
export type QuitSignal = (typeof QUIT_SIGNALS)[number]

export interface LeavingDeps {
  review(reason: ReviewReason, o?: ReviewOptions): Promise<Ticket>
  /** Electron's `app.quit()`: main's `before-quit` shuts the children down once Kea is going. */
  quit(): void
  /** Restart Kea into the files on disk for `target` (`app.relaunch()`), then quit. */
  relaunch(target: string): void
  /** Core stops every session; resolves once it has, failed or ran out of time (at once when core is away). */
  stopAll(): Promise<void>
  /** Keep the window's composer drafts for the next start. */
  keepDrafts(): Promise<void>
  /** The windows close and Kea stays in the menu bar or the tray. */
  enterMenuBar(): void
  /** How many terminals run now. */
  running(): number
  /** A test build (`--kea-perf`): a restart is recorded here and never made. */
  recordRelaunch: ((target: string) => void) | null
  log: Pick<Logger, 'info' | 'warn'>
}

export class Leaving {
  private readonly d: LeavingDeps
  private quittingNow = false
  private relaunchingNow = false
  private stopping = false
  /** A second request came while every terminal was being stopped: Kea quits without waiting. */
  private forced = false
  /** The review of a restart the update state offers, until the restart is made or given up. */
  private restartTicket: Ticket | null = null
  /** Squirrel accepted the install: Kea is going until it quits Kea, or until the updater reports a failure. */
  private installing = false

  constructor(d: LeavingDeps) {
    this.d = d
  }

  get quitting(): boolean {
    return this.quittingNow
  }

  get relaunching(): boolean {
    return this.relaunchingNow
  }

  get stoppingAll(): boolean {
    return this.stopping
  }

  /** Kea is going: a quit or a restart was reviewed and is under way. */
  get going(): boolean {
    return this.quittingNow || this.relaunchingNow || this.stopping
  }

  /**
   * Electron's `before-quit`. True: Kea is going, and main shuts down now. False: a quit that reached it unasked (Dock ›
   * Quit, the app switcher, a macOS logout) is held while the windows review, and made again on proceed. It counts as
   * the user's own (explicit): Electron says nothing of where it came from, and on macOS a logout's quit arrives as Dock
   * › Quit's does. A quit signal reaches it only once reviewed (`listen`).
   */
  beforeQuit(): boolean {
    if (this.going) {
      this.quittingNow = true
      return true
    }
    void this.quitUnasked('unasked')
    return false
  }

  /**
   * A quit signal (QUIT_SIGNALS): a quit reviewed as one that reaches `before-quit` unasked, but not the user's own, so
   * a window that does not answer its request is never quit past.
   */
  terminate(): void {
    void this.quitUnasked('signal')
  }

  /**
   * Handle each of QUIT_SIGNALS with `terminate` (`on`: `process.on`). Main registers them once `app.whenReady()` has
   * run, after Electron's own handlers, which they replace: Electron's would quit as the user's own quit does, going
   * past a window that misses its request, and put the default action back after the first signal, so a second one
   * during the review would end Kea.
   */
  listen(on: (signal: QuitSignal, handler: () => void) => void): void {
    for (const s of QUIT_SIGNALS) on(s, () => this.terminate())
  }

  /**
   * Every quit the user asks for (Quit Kea Completely, the palette, the last window closing with nowhere to keep Kea):
   * with a terminal running they are all stopped first, so nothing is left running. `reviewed`: a caller's own review.
   */
  async quit(reviewed?: Ticket): Promise<void> {
    const t = reviewed ?? (await this.d.review('quit', { explicit: true, join: 'quit' }))
    if (this.d.running() > 0) return this.stopAllAndQuit(t)
    let went = false
    try {
      if (!t.proceed) return
      this.quitNow()
      went = true
    } finally {
      t.settle(went)
    }
  }

  /** `⌘Q`'s choice (menuBar.ts `quitAction`, or the first-quit sheet's answer), made after the review. */
  async choose(c: 'menuBar' | 'stopAll' | 'quit'): Promise<void> {
    const t = await this.d.review(c === 'menuBar' ? 'menuBar' : 'quit', { explicit: true, join: `choose ${c}` })
    if (c === 'stopAll') return this.stopAllAndQuit(t)
    let went = false
    try {
      if (!t.proceed) return
      if (c === 'menuBar') this.d.enterMenuBar()
      else this.quitNow()
      went = true
    } finally {
      t.settle(went)
    }
  }

  /** Stop All and Quit: core stops every session, then a full quit. `reviewed`: a caller's own review. */
  async stopAllAndQuit(reviewed?: Ticket): Promise<void> {
    const t = reviewed ?? (await this.d.review('quit', { explicit: true, join: 'stopAll' }))
    let went = false
    try {
      if (!t.proceed) return
      if (this.stopping) {
        // a second request while the first waits: quit now
        this.forced = true
        this.d.quit()
      } else {
        this.stopping = true
        await this.d.stopAll().catch((e: unknown) => this.d.log.warn('stop all did not finish before the quit', { error: String(e) }))
        if (!this.forced) this.d.quit()
      }
      went = true
    } finally {
      t.settle(went)
    }
  }

  /**
   * Restart Kea into the files on disk (`target`: their version), the drafts kept; nothing while it goes. `reviewed`:
   * the update state's Restart Kea, whose review (and drafts) `beforeRestart` has done.
   */
  async relaunch(target: string, o: { reviewed?: boolean } = {}): Promise<void> {
    const given = o.reviewed ? this.takeRestartTicket() : null
    if (this.quittingNow || this.relaunchingNow) {
      given?.settle(false)
      return
    }
    const t = given ?? (await this.d.review('restart'))
    let mine = false
    let went = false
    try {
      if (!t.proceed || this.quittingNow || this.relaunchingNow) return
      this.relaunchingNow = mine = true
      if (!given) await this.keepDrafts()
      if (this.d.recordRelaunch) {
        this.d.log.info('restart not made (perf)', { target })
        this.d.recordRelaunch(target)
        return
      }
      this.d.log.info('restarting Kea', { target })
      this.d.relaunch(target)
      went = true
    } finally {
      if (mine && !went) this.relaunchingNow = false
      t.settle(went)
    }
  }

  /** The update state's `beforeRestart`: the review, then the drafts kept. True: the restart goes ahead. */
  async beforeRestart(): Promise<boolean> {
    const t = await this.d.review('restart')
    if (!t.proceed) {
      t.settle(false)
      return false
    }
    this.takeRestartTicket()?.settle(false)
    this.restartTicket = t
    await this.keepDrafts()
    return true
  }

  /** The update state's `afterRestart`: whether the restart `beforeRestart` allowed was made. */
  afterRestart(started: boolean): void {
    this.takeRestartTicket()?.settle(started)
  }

  /**
   * The macOS updater (`make`, its events `on`), its install made through `install`: Squirrel closes every window, then
   * quits Kea. A failure it reports while or after accepting the install (ShipIt not started, the update gone) means Kea
   * stays, so Kea is going no more and a close or a quit reviews again; the failure is passed on to `on`.
   */
  updater(make: (on: UpdaterEvents) => UpdaterDriver, on: UpdaterEvents): UpdaterDriver {
    const driver = make({
      ...on,
      failed: (reason, step) => {
        this.installFailed(reason)
        on.failed(reason, step)
      },
    })
    return { ...driver, install: () => this.install(() => driver.install()) }
  }

  /**
   * Squirrel's quit and install, after the review: Kea is going while it runs, unless nothing was ready to install or
   * the updater reported a failure before `run` returned (then the install did not start, and answers false).
   */
  install(run: () => boolean): boolean {
    if (this.quittingNow || this.relaunchingNow) return false
    this.relaunchingNow = true
    // set before the call: a failure the updater reports inside it ends the install it would otherwise miss
    this.installing = true
    let started = false
    try {
      started = run() && this.installing
    } finally {
      if (!started) {
        this.installing = false
        this.relaunchingNow = false
      }
    }
    return started
  }

  /** The updater reported a failure: an install it had accepted does not go ahead, and Kea is going no more. */
  private installFailed(reason: string): void {
    if (!this.installing) return
    this.installing = false
    this.relaunchingNow = false
    this.d.log.warn('update not installed: Kea stays', { reason })
  }

  private takeRestartTicket(): Ticket | null {
    const t = this.restartTicket
    this.restartTicket = null
    return t
  }

  /** A quit once reviewed; Kea already quitting is not asked to again (main's shutdown is under way). */
  private quitNow(): void {
    if (this.quittingNow) return
    this.quittingNow = true
    this.d.quit()
  }

  private async keepDrafts(): Promise<void> {
    try {
      await this.d.keepDrafts()
    } catch (e) {
      this.d.log.warn('drafts not kept for the restart', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async quitUnasked(from: 'unasked' | 'signal'): Promise<void> {
    const t = await this.d.review('quit', { explicit: from === 'unasked', join: from })
    let went = false
    try {
      if (!t.proceed) return
      this.quitNow()
      went = true
    } finally {
      t.settle(went)
    }
  }
}
