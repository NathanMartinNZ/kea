// The app's banners: one `banners` store, keyed by kind, for every app-level banner except the settings error
// (`settings.status`). Each banner's source sets and clears it: git missing from the git lookup at
// launch; ptyhost's `pty.banner` notes for as long as that ptyhost is connected — a new control port clears them, and
// the new ptyhost says again whatever still holds — or until it sends `pty.bannerCleared` (a checkpoint written again,
// after a full disk). The session-mode banner is shown once per KEA_HOME (`onceForHome`).

import { BANNERS_STORE, KeyedStore, type Banner, type BannerKind } from '@kea/protocol'

/** The key-value row that records the session-mode banner as shown in this KEA_HOME. */
export const SESSION_MODE_SHOWN_KEY = 'banner.sessionMode.shown'

/** The database's key-value table, as far as `onceForHome` uses it (`kvGet` / `kvSet`). */
export interface Kv {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

/** True the first time it is asked for `key` in this KEA_HOME (the answer is recorded, with when), false ever after. */
export function onceForHome(kv: Kv, key: string, now: number): boolean {
  if (kv.get(key) !== undefined) return false
  kv.set(key, String(now))
  return true
}

export class Banners {
  /** bounded: at most one entry per BANNER_KINDS value. */
  readonly store = new KeyedStore<Banner>(BANNERS_STORE)
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  set(b: Omit<Banner, 'at'>): void {
    const cur = this.store.get(b.kind)
    if (cur && cur.message === b.message && cur.fix === b.fix && cur.severity === b.severity && cur.source === b.source) return
    this.store.set(b.kind, { ...b, at: this.now() })
  }

  clear(kind: BannerKind): void {
    this.store.delete(kind)
  }

  /** Every banner of a source (a new ptyhost connection clears ptyhost's). */
  clearSource(source: Banner['source']): void {
    for (const [k, b] of [...this.store.entries()]) if (b.source === source) this.store.delete(k)
  }

  dispose(): void {
    this.store.dispose()
  }
}
