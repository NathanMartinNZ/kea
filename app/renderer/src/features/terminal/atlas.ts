// The glyph-atlas guard: bytes, not pages. The WebGL addon reports each atlas page it adds and removes;
// pages are 512² to 4096² (Kea's patch of the addon caps merges at 4096²), so counting additions is too coarse.
// The guard sums width × height × 4 over the live pages and clears the atlas when an added page takes the sum above
// `L.atlasGuardBytes`.
//
// With Kea's addon patch a clear evicts every page and starts again from one fresh page: each evicted page leaves
// the sum through its remove event, so after a clear the sum is that one page, and every WebGL context on the atlas,
// warm ones included, drops its texture of the page on that same event. (Unpatched, xterm.js wipes the pages in
// place and keeps them all, so a clear frees nothing.) The clear runs after the add event that crossed the threshold
// has returned (a microtask), never inside it: xterm adds a page in the middle of drawing a glyph and draws the glyph
// into it next, so evicting it there would leave the glyph pointing at a page that is gone. Terminals with the same
// font and colours share one atlas (xterm's atlas cache), so every guard on it sees the same events: the first queued
// clear evicts, and the others find the sum back under the threshold and do nothing.
//
// A guard hears of the pages already there whenever its addon starts using an atlas (`followAtlas`): the renderer
// acquires its atlas in its constructor, before `WebglAddon.activate` has forwarded its events, so the patched
// `activate` tells them again once it has (`onChangeTextureAtlas` with the first page, an add event for each other
// page); a renderer that switches to another atlas later (a font or colour change, a joined shared atlas) does the
// same from `_refreshCharAtlas`. So a guard's pages are always exactly its atlas's: for the terminal that created the
// atlas, for one that joins it, and for one whose WebGL was reloaded after a context loss (U-TERM-29, L-TERM-7).

export interface AtlasCanvas {
  readonly width: number
  readonly height: number
}

/** The atlas events of `WebglAddon` the guard follows. */
export interface AtlasEvents {
  onChangeTextureAtlas(cb: (c: AtlasCanvas) => void): { dispose(): void }
  onAddTextureAtlasCanvas(cb: (c: AtlasCanvas) => void): { dispose(): void }
  onRemoveTextureAtlasCanvas(cb: (c: AtlasCanvas) => void): { dispose(): void }
}

export interface AtlasGuardOptions {
  limitBytes: number
  /** `WebglAddon.clearTextureAtlas()` */
  clear(reason: AtlasClearReason): void
  /** Run the guard's clear once the add event has returned (default: a microtask). */
  defer?(fn: () => void): void
}

/** `watchdog`: main found the GPU process over its hard limit (views.ts `resetGpu`). */
export type AtlasClearReason = 'guard' | 'dpr' | 'font' | 'wake' | 'reset' | 'watchdog'

export class AtlasGuard {
  private readonly pages = new Map<AtlasCanvas, number>() // bounded: one atlas's live pages
  private sum = 0
  private queued = false
  private readonly opts: AtlasGuardOptions
  private readonly defer: (fn: () => void) => void
  /** Clears done, by reason (the resource report, L-TERM-3). */
  readonly clears: Record<AtlasClearReason, number> = { guard: 0, dpr: 0, font: 0, wake: 0, reset: 0, watchdog: 0 }

  constructor(opts: AtlasGuardOptions) {
    this.opts = opts
    // unbound: the browser's queueMicrotask throws when called on anything but the window
    this.defer = opts.defer ?? ((fn) => queueMicrotask(fn))
  }

  get bytes(): number {
    return this.sum
  }

  get pageCount(): number {
    return this.pages.size
  }

  /** The live pages and their bytes (the resource report counts a shared atlas's pages once). */
  get pageSizes(): ReadonlyMap<AtlasCanvas, number> {
    return this.pages
  }

  /** `onAddTextureAtlasCanvas` */
  added(c: AtlasCanvas): void {
    const size = c.width * c.height * 4
    this.sum += size - (this.pages.get(c) ?? 0)
    this.pages.set(c, size)
    if (this.sum <= this.opts.limitBytes || this.queued) return
    this.queued = true
    this.defer(() => {
      this.queued = false
      // another terminal on the same atlas may have cleared it first, or this one lost its addon (`reset`)
      if (this.sum > this.opts.limitBytes) this.clear('guard')
    })
  }

  /** `onRemoveTextureAtlasCanvas` */
  removed(c: AtlasCanvas): void {
    const size = this.pages.get(c)
    if (size === undefined) return
    this.pages.delete(c)
    this.sum -= size
  }

  /** Clear the atlas now (DPR change, font change, wake from sleep, "Reset Terminal Rendering"). */
  clear(reason: AtlasClearReason): void {
    this.clears[reason]++
    this.opts.clear(reason)
  }

  /** The WebGL addon went away (evicted, context lost): its pages are gone with it. */
  reset(): void {
    this.pages.clear()
    this.sum = 0
  }
}

/**
 * Follow a WebGL addon's atlas with a guard; subscribe before the addon is loaded. A changed atlas (or the patch's
 * replay of the current one) starts the sum again from its first page; the other pages follow as add events.
 */
export function followAtlas(guard: AtlasGuard, gl: AtlasEvents): { dispose(): void }[] {
  return [
    gl.onChangeTextureAtlas((c) => {
      guard.reset()
      guard.added(c)
    }),
    gl.onAddTextureAtlasCanvas((c) => guard.added(c)),
    gl.onRemoveTextureAtlasCanvas((c) => guard.removed(c)),
  ]
}
