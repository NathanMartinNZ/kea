// The numbers of the dev-only performance HUD, pure: frame times from the timestamps of animation frames, and bytes per
// second per terminal from byte counters read at two times. Hud.svelte feeds them while it is shown and drops them when
// it goes; nothing here holds a timer or a listener.

export interface FrameStats {
  frames: number
  /** Mean time between frames, ms (0 with no frame). */
  avgMs: number
  /** Longest time between two frames, ms. */
  maxMs: number
}

/** Frame times since the last `take`. */
export class FrameMeter {
  private last: number | null = null
  private frames = 0
  private sum = 0
  private max = 0

  /** One animation frame, at `t` (ms, the callback's timestamp). */
  frame(t: number): void {
    if (this.last !== null) {
      const d = t - this.last
      this.frames++
      this.sum += d
      if (d > this.max) this.max = d
    }
    this.last = t
  }

  /** The frames since the last call, and start counting again. */
  take(): FrameStats {
    const r: FrameStats = { frames: this.frames, avgMs: this.frames > 0 ? this.sum / this.frames : 0, maxMs: this.max }
    this.frames = 0
    this.sum = 0
    this.max = 0
    return r
  }
}

export interface ByteRate {
  id: string
  bytesPerSec: number
}

/** Bytes per second per terminal, from counters that only grow. */
export class ByteRates {
  // bounded: one per terminal view at the last reading (≤ the views the window holds: `renderer.terminals`); replaced
  // whole at every reading, so a view that is gone leaves with the next one
  private prev = new Map<string, number>()
  private at: number | null = null

  /**
   * The rates since the last reading, busiest first (then by id). A terminal first seen now reads 0: there is nothing
   * to compare it with yet. A counter that went down (a view made again under the same id) counts from 0.
   */
  read(now: number, counters: Iterable<readonly [string, number]>): ByteRate[] {
    const next = new Map<string, number>()
    const secs = this.at === null ? 0 : (now - this.at) / 1000
    const out: ByteRate[] = []
    for (const [id, bytes] of counters) {
      next.set(id, bytes)
      const before = this.prev.get(id)
      const grown = before === undefined ? 0 : bytes >= before ? bytes - before : bytes
      out.push({ id, bytesPerSec: secs > 0 ? grown / secs : 0 })
    }
    this.prev = next
    this.at = now
    return out.sort((a, b) => b.bytesPerSec - a.bytesPerSec || a.id.localeCompare(b.id))
  }
}

/** `0 B/s`, `812 B/s`, `12 kB/s`, `3.4 MB/s`. */
export function rateText(bytesPerSec: number): string {
  const n = Math.max(0, bytesPerSec)
  if (n < 1000) return `${Math.round(n)} B/s`
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)} kB/s`
  return `${n < 10_000_000 ? (n / 1_000_000).toFixed(1) : Math.round(n / 1_000_000)} MB/s`
}

/** `16.7 ms (60 fps), longest 33.4 ms`; `no frames` when none was drawn. */
export function framesText(f: FrameStats): string {
  if (f.frames === 0) return 'no frames'
  return `${f.avgMs.toFixed(1)} ms (${Math.round(1000 / f.avgMs)} fps), longest ${f.maxMs.toFixed(1)} ms`
}
