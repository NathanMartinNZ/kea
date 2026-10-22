// inotify's limits as the watch service meets them. Linux only: the OS layer's `watcher.limits`; where
// the system has none (FSEvents) this guard is inert.
//
//   watches     a subscription that fails with ENOSPC (`max_user_watches`), or a stream that ends with it (a directory
//               made later that the patched watcher could not watch). Known by the error's message: it has no `code`.
//   instances   the backend could not start (`max_user_instances`): the patched watcher rejects at once; the
//               prebuild would hang core's thread inside `subscribe`, so with it no first subscription is made while
//               this user's instances are at the limit (`firstSubscription`).
//
// While a limit is held no subscription is made: the worktree is in poll mode, refreshed at the refresh triggers, and
// one banner per launch names the limit, how many watches Kea holds and the `sysctl` that raises it. The limit is read
// again at those refreshes (`recheck`): `max_user_watches` above what it was when it was met, or this user's instances
// below `max_user_instances`, lets the streams start again.

import type { Logger } from '@kea/kit'
import type { BannerKind } from '@kea/protocol'
import type { WatchLimitKind, WatchLimits } from '../../os/index.ts'

/** Where the banner goes (core's `Banners`). */
export interface LimitBanners {
  set(b: { kind: BannerKind; source: 'watch'; severity: 'warning'; message: string; fix: string | null }): void
  clear(kind: BannerKind): void
}

/** What a reader of the limit is told: the limit held, the value it had when it was met, and Kea's own watches then. */
export interface HeldLimit {
  kind: WatchLimitKind
  /** The limit's value when it was met (null: it could not be read). */
  max: number | null
}

/** The banner's words for a limit met: the limit, Kea's own watches, and the setting that raises it. */
export function limitBanner(held: HeldLimit, ownWatches: number, setting: string, fix: string): { message: string; fix: string } {
  const at = held.max === null ? setting : `${setting} = ${held.max}`
  const message =
    held.kind === 'watches'
      ? `Live updates of the file tree stopped at the system’s inotify watch limit (${at}); Kea holds ${ownWatches} watches. Files and changes still refresh when Kea comes to the front or a session is shown.`
      : `Live updates of the file tree are off: this user’s inotify instances are at the system’s limit (${at}). Files and changes still refresh when Kea comes to the front or a session is shown.`
  return { message, fix }
}

export class WatchLimitGuard {
  private readonly limits: WatchLimits | null
  private readonly log: Logger | undefined
  private banners: LimitBanners | null = null
  /** Told each time a limit comes to be held or is let go (core tells main: the platform report's inotify line). */
  private heldChanged: ((held: boolean) => void) | null = null
  /** The limit met, while it holds. */
  private held: HeldLimit | null = null
  /** The banner was shown in this launch: one per launch. */
  private shown = false
  /** A look at the limit under way (one at a time). */
  private looking: Promise<boolean> | null = null
  /** Times a limit was met, and first subscriptions not made at the instance limit, since start. */
  met = 0
  guarded = 0

  constructor(o: { limits: WatchLimits | null; log?: Logger }) {
    this.limits = o.limits
    this.log = o.log
  }

  bindBanners(b: LimitBanners): void {
    this.banners = b
  }

  /** One listener (core's `watchLimit` message to main), told when a limit comes to be held and when it is let go. */
  onHeldChange(cb: (held: boolean) => void): void {
    this.heldChanged = cb
  }

  /** The system has inotify's limits (Linux). */
  get applies(): boolean {
    return this.limits !== null
  }

  /** A limit is held: no subscription is made until it is raised. */
  get blocked(): boolean {
    return this.held !== null
  }

  get holding(): HeldLimit | null {
    return this.held
  }

  /**
   * Before a subscription that would start the backend, with a binding that is not Kea's patch: false, and the
   * instance limit held, when this user's inotify instances are at `max_user_instances`.
   */
  async firstSubscription(): Promise<boolean> {
    const l = this.limits
    if (!l) return true
    const [max, used] = await Promise.all([l.max(), l.userInstances()])
    if (!max || used < max.instances) return true
    this.guarded++
    this.log?.warn('watch: no first subscription at the inotify instance limit', { used, max: max.instances })
    this.hold({ kind: 'instances', max: max.instances })
    return false
  }

  /** A subscription failed, or its stream ended, with `message`: the limit it names is held now. Null: no limit of inotify's. */
  failed(message: string): WatchLimitKind | null {
    const kind = this.limits?.limitOf(message) ?? null
    if (kind === null) return null
    if (this.held) return kind
    this.held = { kind, max: null }
    this.heldChanged?.(true)
    const held = this.held
    void this.limits?.max().then((m) => {
      if (this.held === held && m) held.max = kind === 'watches' ? m.watches : m.instances
      this.show(held)
    })
    return kind
  }

  private hold(h: HeldLimit): void {
    if (this.held) return
    this.held = h
    this.heldChanged?.(true)
    this.show(h)
  }

  /** The banner, once per launch, with Kea's own watches at that moment. */
  private show(h: HeldLimit): void {
    this.met++
    const l = this.limits
    if (!l || this.shown || this.held !== h) return
    this.shown = true
    void l.ownWatches().then((own) => {
      const text = limitBanner(h, own, l.setting(h.kind), l.fix(h.kind))
      this.log?.warn('watch: inotify limit met', { kind: h.kind, max: h.max, ownWatches: own })
      if (this.held === h) this.banners?.set({ kind: 'watchLimit', source: 'watch', severity: 'warning', message: text.message, fix: text.fix })
    })
  }

  /**
   * At each refresh trigger: read the limit held again. True when it no longer holds (the limit was raised, or
   * this user's instances fell below theirs): it is let go and its banner cleared, and the caller starts its streams
   * again.
   */
  recheck(): Promise<boolean> {
    const l = this.limits
    const h = this.held
    if (!l || !h) return Promise.resolve(false)
    this.looking ??= (async () => {
      try {
        const max = await l.max()
        if (!max) return false
        // a limit whose value could not be read when it was met is measured from now on
        if (h.kind === 'watches' && h.max === null) {
          h.max = max.watches
          return false
        }
        const raised = h.kind === 'watches' ? max.watches > (h.max as number) : (await l.userInstances()) < max.instances
        if (!raised || this.held !== h) return false
        this.held = null
        this.heldChanged?.(false)
        this.banners?.clear('watchLimit')
        this.log?.info('watch: inotify limit no longer met', { kind: h.kind, was: h.max, now: h.kind === 'watches' ? max.watches : max.instances })
        return true
      } catch (e) {
        this.log?.debug('watch: the inotify limit could not be read', { error: String(e) })
        return false
      } finally {
        this.looking = null
      }
    })()
    return this.looking
  }
}
