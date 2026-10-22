// The disk-full banner: a checkpoint the disk refuses for lack of space (ENOSPC, or the user's quota, EDQUOT)
// raises it once, as a `pty.banner` note; the next checkpoint written means space is back and clears it
// (`pty.bannerCleared`). A write that fails for another reason is only logged (Pty.checkpoint). Terminals keep working
// either way: the ring still holds everything after the last checkpoint. A new ptyhost starts with no banner
// (core clears ptyhost's on a new control port) and raises it again at its first refused write.

import type { PtyhostNote } from '@kea/protocol'

/** What the banner says (one line; core adds no separate fix for ptyhost's banners). */
export const DISK_FULL_MESSAGE = 'The disk is full: terminals keep working, but what they show is not saved for a restart until some space is freed.'

/** A write refused because the volume (or the user's quota on it) has no room. */
export function isDiskFull(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'ENOSPC' || code === 'EDQUOT'
}

export class DiskFullBanner {
  private readonly notify: (n: PtyhostNote) => void
  private raised = false

  constructor(notify: (n: PtyhostNote) => void) {
    this.notify = notify
  }

  /** Whether the banner is up. */
  get isRaised(): boolean {
    return this.raised
  }

  /** A checkpoint write failed with `e`. */
  failed(e: unknown): void {
    if (this.raised || !isDiskFull(e)) return
    this.raised = true
    this.notify({ m: 'pty.banner', a: { kind: 'diskFull', message: DISK_FULL_MESSAGE } })
  }

  /** A checkpoint was written. */
  written(): void {
    if (!this.raised) return
    this.raised = false
    this.notify({ m: 'pty.bannerCleared', a: { kind: 'diskFull' } })
  }
}
