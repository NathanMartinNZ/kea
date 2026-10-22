// Notifications and the badge: core's policy decides, main shows. Pure: the native surfaces come in as an interface, so
// this is unit-tested without Electron and the test builds swap in a recorder (`RecordingSurfaces`: no test ever posts
// a real notification).
//
//   post       one live notification per tag: a post with a live tag closes the old one first, then shows the new
//   withdraw   closed and forgotten
//   click      the session it names is shown (main reopens the window from the menu bar if need be), and it is
//              forgotten; a notification the person closes is forgotten too
//   TTL        forgotten (and closed) L.notificationTtlMs after it was shown, on the monotonic clock: a sleep or a
//              wall-clock jump expires nothing early. One timer, while any is live
//   permission the first post makes macOS ask; a post that fails to show (denied, unsigned) marks the permission
//              denied — the badge does not depend on it — until one shows again
//   badge      core's count on the Dock icon while it is shown (the menu-bar item's title says it otherwise,
//              menuBar.ts), nothing at zero or with `notifications.dockBadge` off

import { BoundedQueue, type Logger } from '@kea/kit'
import { L, type MenuBarState, type NotificationOp } from '@kea/protocol'

export interface NativeNotification {
  show(): void
  close(): void
  on(event: 'click' | 'close' | 'show', cb: () => void): void
  on(event: 'failed', cb: (e: unknown, error: string) => void): void
}

/** What main shows through: Electron's `Notification` and `app.dock`, or the test builds' recorder. */
export interface NativeSurfaces {
  /** `silent`: no sound. `id`: the tag, macOS's identifier for it. */
  create(o: { id: string; title: string; subtitle: string; body: string; silent: boolean }): NativeNotification
  setBadge(text: string): void
}

type Live = { n: NativeNotification; sessionId: string | null; at: number }

export class Notifier {
  // bounded: one per tag (≤ the sessions, the account conditions, the burst and the summary: core's policy), each gone
  // when clicked, closed, withdrawn or after L.notificationTtlMs
  private readonly live = new Map<string, Live>()
  private readonly native: NativeSurfaces
  private readonly onClick: (sessionId: string | null) => void
  private readonly mono: () => number
  private readonly log: Logger | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private badgeText = ''
  private denied = false
  private disposed = false

  constructor(o: { native: NativeSurfaces; onClick(sessionId: string | null): void; mono?: () => number; log?: Logger }) {
    this.native = o.native
    this.onClick = o.onClick
    this.mono = o.mono ?? (() => performance.now())
    this.log = o.log
  }

  apply(op: NotificationOp): void {
    if (this.disposed) return
    if (op.op === 'withdraw') {
      this.forget(op.tag, true)
      return
    }
    this.forget(op.tag, true)
    const n = this.native.create({ id: op.tag, title: op.title, subtitle: op.subtitle, body: op.body, silent: !op.sound })
    const entry: Live = { n, sessionId: op.sessionId, at: this.mono() }
    this.live.set(op.tag, entry)
    // a listener acts only for the notification it was added to: a replaced one's late events change nothing
    const mine = () => this.live.get(op.tag) === entry
    n.on('click', () => {
      if (!mine()) return
      this.forget(op.tag, false)
      this.onClick(entry.sessionId)
    })
    n.on('close', () => {
      if (mine()) this.forget(op.tag, false)
    })
    n.on('show', () => {
      this.denied = false
    })
    n.on('failed', (_e, error) => {
      if (!this.denied) this.log?.warn('notification not shown (permission denied, or the build is not signed)', { error: String(error) })
      this.denied = true
      if (mine()) this.forget(op.tag, false)
    })
    n.show()
    this.arm()
  }

  /** Core's count as the Dock badge while the Dock icon is shown; nothing at zero, with the switch off, or in the menu bar. */
  badge(s: MenuBarState | null, dockShown: boolean): void {
    const text = dockShown && s && s.badge && s.count > 0 ? String(s.count) : ''
    if (text === this.badgeText) return
    this.badgeText = text
    this.native.setBadge(text)
  }

  /** A notification failed to show since the last one that did (Settings says how to allow them). */
  get permissionDenied(): boolean {
    return this.denied
  }

  get badgeShown(): string {
    return this.badgeText
  }

  /** Live notifications (the `main.notifications` row, L-MEM-7). */
  get size(): number {
    return this.live.size
  }

  liveTags(): string[] {
    return [...this.live.keys()]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.live.clear()
  }

  private forget(tag: string, close: boolean): void {
    const l = this.live.get(tag)
    if (!l) return
    this.live.delete(tag)
    if (close) {
      try {
        l.n.close()
      } catch {
        // gone already
      }
    }
    if (this.live.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** One timer, for the oldest live notification's time-to-live. */
  private arm(): void {
    if (this.timer || this.live.size === 0 || this.disposed) return
    let oldest = Number.POSITIVE_INFINITY
    for (const l of this.live.values()) oldest = Math.min(oldest, l.at)
    this.timer = setTimeout(
      () => {
        this.timer = null
        const now = this.mono()
        for (const [tag, l] of [...this.live]) if (now - l.at >= L.notificationTtlMs) this.forget(tag, true)
        this.arm()
      },
      Math.max(0, oldest + L.notificationTtlMs - this.mono()),
    )
    this.timer.unref?.()
  }
}

/** One thing the recorder saw: a notification shown or closed, or the badge set. */
export type Recorded =
  | { k: 'show'; id: string; title: string; subtitle: string; body: string; silent: boolean }
  | { k: 'close'; id: string }
  | { k: 'badge'; text: string }

/**
 * The test builds' surfaces (a dev build run with `--kea-perf`): nothing reaches the system; what would have is
 * recorded for the harness (`__keaTest.notifications()`), which can click a live one
 * (`__keaTest.clickNotification(tag)`).
 */
export class RecordingSurfaces implements NativeSurfaces {
  // bounded: the newest L.logMemoryEntries records (an in-memory log for tests)
  readonly log = new BoundedQueue<Recorded>({ cap: L.logMemoryEntries, overflow: 'drop-oldest' })
  // bounded: one per live tag (the Notifier's own cap); a closed one leaves
  private readonly shown = new Map<string, { click(): void }>()
  badge = ''
  /**
   * A test's stand-in for the system denying Kea's notifications: while true a post fails to show, as the system
   * reports it.
   */
  denied = false

  create(o: { id: string; title: string; subtitle: string; body: string; silent: boolean }): NativeNotification {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
    const fire = (event: string) => {
      for (const cb of handlers[event] ?? []) cb()
    }
    const rec = this
    const n: NativeNotification = {
      show() {
        if (rec.denied) {
          // nothing reached the screen: no record of a notification shown, and the notifier hears `failed`
          for (const cb of handlers.failed ?? []) cb({}, 'notifications are not allowed (a test said so)')
          return
        }
        rec.log.push({ k: 'show', ...o })
        rec.shown.set(o.id, { click: () => fire('click') })
        fire('show')
      },
      close() {
        rec.shown.delete(o.id)
        rec.log.push({ k: 'close', id: o.id })
      },
      on(event: string, cb: (...a: never[]) => void) {
        ;(handlers[event] ??= []).push(cb as (...a: unknown[]) => void)
      },
    } as NativeNotification
    return n
  }

  setBadge(text: string): void {
    this.badge = text
    this.log.push({ k: 'badge', text })
  }

  /** A click on the live notification `tag`; false when none is live. */
  click(tag: string): boolean {
    const s = this.shown.get(tag)
    if (!s) return false
    this.shown.delete(tag)
    s.click()
    return true
  }

  liveIds(): string[] {
    return [...this.shown.keys()]
  }
}
