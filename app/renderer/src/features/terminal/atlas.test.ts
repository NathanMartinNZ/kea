import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GHOSTTY_THEME, L, noGhosttyConfig } from '@kea/protocol'
import { applyAppearance, resolveTheme, themeOf, type Appearance } from '@kea/terminal'
import { AtlasGuard, followAtlas, type AtlasCanvas, type AtlasClearReason, type AtlasEvents } from './atlas.ts'

const page = (side: number) => ({ width: side, height: side })
const bytes = (side: number) => side * side * 4
/** xterm's first and newest atlas pages are this size (`TextureAtlas._textureSize`). */
const FRESH = 512

/** The guard's deferred clears, run when the test says (in the app: a microtask after the add event). */
function laterQueue(): { defer: (fn: () => void) => void; flush: () => void; readonly size: number } {
  const q: (() => void)[] = []
  return {
    defer: (fn) => q.push(fn),
    flush: () => {
      for (let fn = q.shift(); fn; fn = q.shift()) fn()
    },
    get size() {
      return q.length
    },
  }
}

/**
 * The patched `TextureAtlas` as the guards see it, shared by several terminals as xterm shares one atlas between
 * terminals with the same font and colours: every page added or removed is reported to each guard, and
 * `clearTexture()` evicts every page and starts again from one fresh page. A page must still be in the atlas when its
 * add event returns, since xterm draws the glyph that asked for it there next.
 */
class SharedAtlas {
  readonly pages: AtlasCanvas[] = []
  readonly guards: AtlasGuard[] = []
  clears = 0
  private glyphs = 0

  add(side: number): AtlasCanvas {
    const p = page(side)
    this.pages.push(p)
    for (const g of this.guards) g.added(p)
    expect(this.pages, 'a page is still in the atlas when its add event returns').toContain(p)
    this.glyphs++
    return p
  }

  clearTexture(): void {
    if (this.pages.length === 1 && this.glyphs === 0) return
    this.clears++
    for (const p of this.pages.splice(0)) for (const g of this.guards) g.removed(p)
    this.glyphs = 0
    const fresh = page(FRESH)
    this.pages.push(fresh)
    for (const g of this.guards) g.added(fresh)
  }

  get bytes(): number {
    return this.pages.reduce((n, p) => n + p.width * p.height * 4, 0)
  }
}

describe('atlas guard', () => {
  it('U-TERM-1 · sums page bytes from add / remove events and clears only when an added page crosses the threshold', () => {
    const cleared: AtlasClearReason[] = []
    const later = laterQueue()
    const g = new AtlasGuard({ limitBytes: L.atlasGuardBytes, clear: (r) => cleared.push(r), defer: later.defer })
    // 4096² × 4 = 64 MiB per page: two pages sit exactly at `L.atlasGuardBytes`, which is not above the threshold
    const a = page(4096)
    const b = page(4096)
    g.added(a)
    g.added(b)
    expect(g.bytes).toBe(2 * bytes(4096))
    expect(g.bytes).toBe(L.atlasGuardBytes)
    later.flush()
    expect(cleared).toEqual([])
    // a small page more crosses it
    const c = page(FRESH)
    g.added(c)
    later.flush()
    expect(cleared).toEqual(['guard'])
    // this clear callback evicts nothing: the sum stays, and nothing clears again until another page is added
    expect(g.bytes).toBe(L.atlasGuardBytes + bytes(FRESH))
    // a merge removes four pages and adds one; evicted pages leave the sum
    g.removed(a)
    g.removed(b)
    expect(g.bytes).toBe(bytes(FRESH))
    g.removed(c)
    g.removed(c) // an unknown or repeated removal is ignored
    expect(g.bytes).toBe(0)
    expect(g.pageCount).toBe(0)
    g.added(page(4096))
    g.added(page(4096))
    later.flush()
    expect(cleared).toEqual(['guard'])
    g.added(page(1024))
    later.flush()
    expect(cleared).toEqual(['guard', 'guard'])
    expect(g.clears.guard).toBe(2)
  })

  it('U-TERM-1 · a clear on demand (whatever the reason; the real triggers are L-TERM-8’s) is counted by its reason and reaches the addon; losing the addon resets the sum', () => {
    const cleared: AtlasClearReason[] = []
    const g = new AtlasGuard({ limitBytes: L.atlasGuardBytes, clear: (r) => cleared.push(r) })
    g.added(page(2048))
    g.clear('dpr')
    g.clear('font')
    g.clear('wake')
    g.clear('reset')
    expect(cleared).toEqual(['dpr', 'font', 'wake', 'reset'])
    expect(g.bytes).toBe(bytes(2048))
    g.reset()
    expect(g.bytes).toBe(0)
    expect(g.pageCount).toBe(0)
  })

  it('U-TERM-27 · a guard clear runs after the add event that crossed the threshold, evicts every page and leaves one fresh page in the sum', () => {
    const later = laterQueue()
    const atlas = new SharedAtlas()
    const g = new AtlasGuard({ limitBytes: L.atlasGuardBytes, clear: () => atlas.clearTexture(), defer: later.defer })
    atlas.guards.push(g)
    atlas.add(FRESH)
    // pages until the sum passes the threshold: the add event that crosses it must not clear (the patched clear evicts
    // the page being added, which xterm is about to draw into); the clear is queued once, however many pages follow
    while (g.bytes <= L.atlasGuardBytes) atlas.add(4096)
    atlas.add(FRESH)
    expect(atlas.clears).toBe(0)
    expect(later.size).toBe(1)
    later.flush()
    expect(atlas.clears).toBe(1)
    expect(g.clears.guard).toBe(1)
    // the memory came back: one fresh page, in the atlas and in the guard's sum
    expect(atlas.pages).toHaveLength(1)
    expect(atlas.bytes).toBe(bytes(FRESH))
    expect(g.bytes).toBe(atlas.bytes)
    expect(g.pageCount).toBe(1)
    // and it keeps coming back: the sum never stays above the threshold once the queued clear has run
    for (let round = 0; round < 3; round++) {
      while (g.bytes <= L.atlasGuardBytes) atlas.add(2048)
      later.flush()
      expect(g.bytes).toBeLessThanOrEqual(L.atlasGuardBytes)
      expect(g.bytes).toBe(atlas.bytes)
    }
    expect(g.clears.guard).toBe(4)
  })

  it('U-TERM-27 · by default the clear is queued with the window’s own queueMicrotask, called unbound as the browser requires', async () => {
    // Chromium's queueMicrotask throws "Illegal invocation" unless called on the window (or unbound); Node's does not
    // check, so the stand-in checks it as the browser does
    const real = globalThis.queueMicrotask
    const strict = function (this: unknown, fn: () => void): void {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      real(fn)
    }
    globalThis.queueMicrotask = strict
    try {
      const cleared: AtlasClearReason[] = []
      const g = new AtlasGuard({ limitBytes: L.atlasGuardBytes, clear: (r) => cleared.push(r) })
      g.added(page(4096))
      g.added(page(4096))
      expect(() => g.added(page(FRESH))).not.toThrow()
      expect(cleared).toEqual([])
      await Promise.resolve()
      expect(cleared).toEqual(['guard'])
      // and the next crossing queues again
      g.added(page(FRESH))
      await Promise.resolve()
      expect(cleared).toEqual(['guard', 'guard'])
    } finally {
      globalThis.queueMicrotask = real
    }
  })

  it('U-TERM-27 · terminals sharing one atlas: every guard follows the eviction, and a queued clear that finds the sum back under the threshold does nothing', () => {
    const later = laterQueue()
    const atlas = new SharedAtlas()
    const guards = [0, 1, 2, 3].map(() => new AtlasGuard({ limitBytes: L.atlasGuardBytes, clear: () => atlas.clearTexture(), defer: later.defer }))
    atlas.guards.push(...guards)
    atlas.add(FRESH)
    while (atlas.bytes <= L.atlasGuardBytes) atlas.add(4096)
    expect(later.size).toBe(guards.length)
    later.flush()
    expect(atlas.clears).toBe(1)
    expect(guards.map((g) => g.clears.guard)).toEqual([1, 0, 0, 0])
    expect(guards.map((g) => g.bytes)).toEqual(guards.map(() => bytes(FRESH)))
    // the window's resource report counts the shared pages once (views.ts `terminalResources`)
    expect(new Set(guards.flatMap((g) => [...g.pageSizes.keys()]))).toEqual(new Set(atlas.pages))
    // a guard whose addon went away before its queued clear ran clears nothing
    while (atlas.bytes <= L.atlasGuardBytes) atlas.add(4096)
    guards[0]!.reset()
    atlas.guards.splice(0, 1)
    later.flush()
    expect(atlas.clears).toBe(2)
    expect(guards.map((g) => g.clears.guard)).toEqual([1, 1, 0, 0])
  })
})

// ── the guard against the addon's event order ──────────────────────────────────────────────────────────────────────
//
// A model of the patched `@xterm/addon-webgl`, reduced to what decides which atlas events a guard hears and when:
//
//   - xterm's atlas cache (`acquireTextureAtlas` / `removeTerminalFromCache`): terminals whose config (font, colours,
//     DPR) is the same share one atlas; the last owner to leave disposes it.
//   - `WebglRenderer`: its constructor already acquires the atlas when the terminal is open (`_initializeWebGLState` →
//     `handleCharSizeChanged` → `handleResize` → `_refreshCharAtlas`), and `_refreshCharAtlas` runs again whenever the
//     config changes. On a new atlas it fires `onChangeTextureAtlas` with page 0, forwards the atlas's add / remove
//     events, and (the patch) fires an add event for each of its other pages.
//   - `WebglAddon.activate`: constructs the renderer, then forwards the renderer's events to the addon's own, which are
//     the ones Kea subscribes to. Anything the renderer fired in its constructor is gone by then; the patch replays the
//     atlas after the forwards (the fidelity case below checks the bundled addon still has that order).

type Sub = { dispose(): void }
class Emitter<T> {
  private readonly listeners = new Set<(e: T) => void>()
  readonly event = (l: (e: T) => void): Sub => {
    this.listeners.add(l)
    return { dispose: () => this.listeners.delete(l) }
  }
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e)
  }
}

/** `TextureAtlas` with the patch: `clearTexture()` evicts every page and starts again from one fresh page. */
class Atlas {
  readonly pages: AtlasCanvas[] = [page(FRESH)]
  readonly onAdd = new Emitter<AtlasCanvas>()
  readonly onRemove = new Emitter<AtlasCanvas>()
  disposed = false
  add(side: number): void {
    const p = page(side)
    this.pages.push(p)
    this.onAdd.fire(p)
  }
  /** `_mergePages`: four pages out, one twice as wide in. */
  merge(): void {
    const four = this.pages.splice(1, 4)
    for (const p of four) this.onRemove.fire(p)
    this.add(four[0]!.width * 2)
  }
  clearTexture(): void {
    for (const p of this.pages.splice(0)) this.onRemove.fire(p)
    this.add(FRESH)
  }
}

class AtlasCache {
  private readonly entries: { config: string; atlas: Atlas; owners: Set<object> }[] = []
  /** The atlases alive. */
  get size(): number {
    return this.entries.length
  }
  acquire(term: object, config: string): Atlas {
    const mine = this.entries.find((e) => e.owners.has(term))
    if (mine?.config === config) return mine.atlas
    if (mine) this.release(term)
    const shared = this.entries.find((e) => e.config === config)
    if (shared) {
      shared.owners.add(term)
      return shared.atlas
    }
    const atlas = new Atlas()
    this.entries.push({ config, atlas, owners: new Set([term]) })
    return atlas
  }
  release(term: object): void {
    const i = this.entries.findIndex((e) => e.owners.has(term))
    if (i < 0) return
    const e = this.entries[i]!
    e.owners.delete(term)
    if (e.owners.size === 0) {
      e.atlas.disposed = true
      this.entries.splice(i, 1)
    }
  }
}

class Renderer {
  readonly onChange = new Emitter<AtlasCanvas>()
  readonly onAdd = new Emitter<AtlasCanvas>()
  readonly onRemove = new Emitter<AtlasCanvas>()
  charAtlas: Atlas | undefined
  private forwards: Sub[] = []
  private readonly cache: AtlasCache
  private readonly term: object

  constructor(cache: AtlasCache, term: object, config: string) {
    this.cache = cache
    this.term = term
    this.refreshCharAtlas(config) // the terminal is open: Kea loads WebGL after `term.open()`
  }

  refreshCharAtlas(config: string): void {
    const t = this.cache.acquire(this.term, config)
    if (this.charAtlas !== t) {
      this.onChange.fire(t.pages[0]!)
      for (const f of this.forwards.splice(0)) f.dispose()
      this.forwards.push(
        t.onAdd.event((c) => this.onAdd.fire(c)),
        t.onRemove.event((c) => this.onRemove.fire(c)),
      )
      for (const p of t.pages.slice(1)) this.onAdd.fire(p) // the patch: a joined atlas's other pages
    }
    this.charAtlas = t
  }

  dispose(): void {
    for (const f of this.forwards.splice(0)) f.dispose()
    this.cache.release(this.term)
  }
}

class WebglAddon implements AtlasEvents {
  private readonly change = new Emitter<AtlasCanvas>()
  private readonly add = new Emitter<AtlasCanvas>()
  private readonly remove = new Emitter<AtlasCanvas>()
  readonly onChangeTextureAtlas = this.change.event
  readonly onAddTextureAtlasCanvas = this.add.event
  readonly onRemoveTextureAtlasCanvas = this.remove.event
  renderer: Renderer | undefined
  private forwards: Sub[] = []

  activate(cache: AtlasCache, term: object, config: string): void {
    const r = new Renderer(cache, term, config)
    this.renderer = r
    this.forwards = [r.onChange.event((c) => this.change.fire(c)), r.onAdd.event((c) => this.add.fire(c)), r.onRemove.event((c) => this.remove.fire(c))]
    // the patch (`_replayTextureAtlas`): what the renderer acquired in its constructor, told again now that it is heard
    const atlas = r.charAtlas
    if (atlas) {
      this.change.fire(atlas.pages[0]!)
      for (const p of atlas.pages.slice(1)) this.add.fire(p)
    }
  }

  clearTextureAtlas(): void {
    this.renderer?.charAtlas?.clearTexture()
  }

  dispose(): void {
    for (const f of this.forwards.splice(0)) f.dispose()
    this.renderer?.dispose()
    this.renderer = undefined
  }
}

/** A terminal view's WebGL part as `view.ts` does it: subscribe (`followAtlas`), load, and on context loss drop and reload. */
class View {
  readonly term = {}
  readonly guard: AtlasGuard
  gl: WebglAddon | null = null
  private subs: Sub[] = []
  private readonly cache: AtlasCache
  config: string

  constructor(cache: AtlasCache, config: string, later: ReturnType<typeof laterQueue>) {
    this.cache = cache
    this.config = config
    this.guard = new AtlasGuard({ limitBytes: L.atlasGuardBytes, clear: () => this.gl?.clearTextureAtlas(), defer: later.defer })
  }

  loadWebgl(): void {
    const gl = new WebglAddon()
    this.subs = followAtlas(this.guard, gl)
    gl.activate(this.cache, this.term, this.config)
    this.gl = gl
  }

  releaseWebgl(): void {
    for (const s of this.subs.splice(0)) s.dispose()
    this.gl?.dispose()
    this.gl = null
    this.guard.reset()
  }

  /** The guard's pages and the pages its renderer's atlas holds. */
  pages(): { guard: AtlasCanvas[]; real: AtlasCanvas[] } {
    return { guard: [...this.guard.pageSizes.keys()], real: [...(this.gl?.renderer?.charAtlas?.pages ?? [])] }
  }
}

const pageIds = new Map<AtlasCanvas, number>()
/** Pages by identity (pages of one size are equal as values). */
function ids(pages: AtlasCanvas[]): number[] {
  return pages
    .map((p) => {
      if (!pageIds.has(p)) pageIds.set(p, pageIds.size + 1)
      return pageIds.get(p)!
    })
    .sort((x, y) => x - y)
}

function expectExact(views: View[], when: string): void {
  for (const [i, v] of views.entries()) {
    const { guard, real } = v.pages()
    expect(ids(guard), `${when}: view ${i}'s guard counts exactly its atlas's pages`).toEqual(ids(real))
    expect(v.guard.bytes, `${when}: view ${i}'s sum`).toBe(real.reduce((n, p) => n + bytes(p.width), 0))
  }
}

describe('atlas guard against the addon', () => {
  it('U-TERM-29 · a guard counts exactly its atlas’s pages: for the terminal that created the atlas, a second one joining it, one whose WebGL is reloaded after a context loss, and one moved to another atlas', () => {
    const later = laterQueue()
    const cache = new AtlasCache()
    const a = new View(cache, 'font 13', later)
    a.loadWebgl()
    const atlas = a.gl!.renderer!.charAtlas!
    for (let i = 0; i < 6; i++) atlas.add(FRESH)
    expectExact([a], 'the view that created the atlas')
    // a second terminal with the same font and colours joins the atlas while it has pages
    const b = new View(cache, 'font 13', later)
    b.loadWebgl()
    expect(b.gl!.renderer!.charAtlas, 'the atlas is shared').toBe(atlas)
    expectExact([a, b], 'a second view joining the atlas')
    // both follow merges and new pages
    atlas.merge()
    atlas.add(2048)
    expectExact([a, b], 'after a merge and a new page')
    // b's context is lost: its addon goes, the DOM renderer draws, WebGL is loaded again the next frame
    b.releaseWebgl()
    expect(b.guard.bytes).toBe(0)
    atlas.add(FRESH)
    b.loadWebgl()
    expect(b.gl!.renderer!.charAtlas, 'the reloaded renderer joins the same atlas').toBe(atlas)
    expectExact([a, b], 'after b’s context-loss reload')
    // the view that created the atlas goes; the atlas lives on with b
    a.releaseWebgl()
    atlas.add(1024)
    expectExact([b], 'after the creator left')
    // b's font changes: a new atlas (b was its last owner, so the old one is disposed)
    b.config = 'font 14'
    b.gl!.renderer!.refreshCharAtlas(b.config)
    expect(atlas.disposed).toBe(true)
    b.gl!.renderer!.charAtlas!.add(FRESH)
    expectExact([b], 'after moving to another atlas')
    // with exact sums, the guard's clear keeps the atlas within the threshold
    const now = b.gl!.renderer!.charAtlas!
    while (now.pages.reduce((n, p) => n + bytes(p.width), 0) <= L.atlasGuardBytes) now.add(4096)
    later.flush()
    expect(b.guard.clears.guard).toBe(1)
    expect(now.pages).toHaveLength(1)
    expectExact([b], 'after the guard’s clear')
  })

  it('U-TERM-29 · the bundled addon replays its renderer’s atlas once activate has forwarded the renderer’s events, in both builds (the model above follows this order)', () => {
    const lib = path.dirname(createRequire(import.meta.url).resolve('@xterm/addon-webgl'))
    for (const file of ['addon-webgl.mjs', 'addon-webgl.js']) {
      const src = fs.readFileSync(path.join(lib, file), 'utf8')
      const activate = src.slice(src.indexOf('activate('), src.indexOf('get textureAtlas(){return this._renderer?.textureAtlas}'))
      const forwarded = activate.indexOf('forward(this._renderer.onRemoveTextureAtlasCanvas,this._onRemoveTextureAtlasCanvas)')
      const replayed = activate.indexOf('this._replayTextureAtlas()')
      expect(forwarded, `${file}: activate forwards the renderer's atlas events`).toBeGreaterThan(0)
      expect(replayed, `${file}: activate replays the atlas after forwarding (Kea's xterm.js patch)`).toBeGreaterThan(forwarded)
      expect(src, `${file}: the replay tells of page 0 and every other page`).toMatch(/_replayTextureAtlas\(\)\{(?:let|const) (\w)=this\._renderer\?\._charAtlas;\1&&\(this\._onChangeTextureAtlas\.fire\(\1\.pages\[0\]\.canvas\),\1\.pages\.slice\(1\)\.forEach\(/)
    }
  })

  it('U-TERM-51 · a theme change moves every terminal, on screen or warm, to the new theme’s atlas: the old atlas is disposed when its last terminal has left, each guard counts the new atlas’s pages only, and switching back and forth leaves one atlas', () => {
    const later = laterQueue()
    const cache = new AtlasCache()
    // xterm's atlas config holds the font and the theme's colours: terminals of one window share an atlas per theme
    const config = (theme: string) => `font 13 · ${theme}`
    const views = [0, 1, 2].map(() => new View(cache, config('kea-dark'), later))
    for (const v of views) v.loadWebgl()
    const dark = views[0]!.gl!.renderer!.charAtlas!
    for (let i = 0; i < 5; i++) dark.add(FRESH)
    dark.add(2048)
    expect(cache.size).toBe(1)
    expectExact(views, 'before the switch')
    const darkPages = new Set(dark.pages)
    /** The settings change reaches each view in turn (`applyPrefs`): xterm's colours change, and the renderer takes the atlas of its new config. */
    const move = (v: View, theme: string) => {
      v.config = config(theme)
      v.gl?.renderer?.refreshCharAtlas(v.config)
    }
    // the first to move starts the light atlas; the dark one lives while a terminal still draws from it
    move(views[0]!, 'kea-light')
    const light = views[0]!.gl!.renderer!.charAtlas!
    expect(light).not.toBe(dark)
    expect(dark.disposed, 'two terminals still draw from the dark atlas').toBe(false)
    expect(cache.size).toBe(2)
    expectExact(views, 'one view moved')
    move(views[1]!, 'kea-light')
    expect(dark.disposed).toBe(false)
    move(views[2]!, 'kea-light')
    // the last one out releases it: nothing keeps the old theme's pages
    expect(dark.disposed, 'the old atlas is released with its last terminal').toBe(true)
    expect(cache.size).toBe(1)
    for (const v of views) {
      expect(v.gl!.renderer!.charAtlas, 'every terminal shares the new theme’s atlas').toBe(light)
      for (const p of v.guard.pageSizes.keys()) expect(darkPages.has(p), 'no guard still counts a page of the old atlas').toBe(false)
      expect(v.guard.bytes).toBe(bytes(FRESH))
    }
    expectExact(views, 'after the switch')
    // pages the old atlas adds or drops after a view left it are not that view's any more (its forwards went with the move)
    dark.add(4096)
    expectExact(views, 'the old atlas speaks after everyone left')
    // a terminal whose WebGL is not loaded at the switch (evicted to the warm set's DOM-less state, or its context
    // lost) joins the new theme's atlas when it loads, never the old one
    views[2]!.releaseWebgl()
    for (const v of views) move(v, 'kea-dark')
    views[2]!.loadWebgl()
    expect(cache.size).toBe(1)
    expect(views[2]!.gl!.renderer!.charAtlas).toBe(views[0]!.gl!.renderer!.charAtlas)
    expectExact(views, 'a view loaded after the switch')
    // back and forth, with glyphs drawn in between: one atlas at any rest, and every atlas left behind was disposed
    const left: Atlas[] = []
    for (let i = 0; i < 50; i++) {
      const before = views[0]!.gl!.renderer!.charAtlas!
      before.add(FRESH)
      before.add(1024)
      for (const v of views) move(v, i % 2 === 0 ? 'kea-light' : 'kea-dark')
      left.push(before)
      expect(cache.size, `switch ${i}`).toBe(1)
      for (const v of views) expect(v.guard.pageCount, `switch ${i}: a guard holds the new atlas's first page only`).toBe(1)
    }
    expect(left.every((a) => a.disposed)).toBe(true)
    expectExact(views, 'after 50 switches')
    expect(later.size, 'no switch asked the guard for a clear').toBe(0)
  })

  it('U-TERM-51 · a theme change sets the terminal’s colours and nothing else (no font clear, no refit); the same theme applied again, bundled or read from Ghostty, sets nothing, so no atlas is made twice', () => {
    const base: Appearance = { fontFamily: 'Menlo', fontSize: 13, lineHeight: 1.2, theme: 'kea-dark', cursorStyle: 'block', cursorBlink: false, optionIsMeta: true }
    const term = { options: {} as Record<string, unknown> }
    applyAppearance(term, base)
    expect(term.options.theme).toBe(themeOf('kea-dark'))
    expect(applyAppearance(term, { ...base, theme: 'kea-light' })).toEqual({ changed: ['theme'], fontChanged: false })
    expect(term.options.theme).toBe(themeOf('kea-light'))
    expect(applyAppearance(term, { ...base, theme: 'kea-light' }).changed).toEqual([])
    // "Match Ghostty config": the colours core read, resolved once and passed by identity (settings/store.ts ThemeMemo)
    const colors = resolveTheme(GHOSTTY_THEME, { ...noGhosttyConfig('/x/config'), found: true, background: '#fdf6e3', foreground: '#657b83' })
    expect(colors.background).toBe('#fdf6e3')
    expect(applyAppearance(term, { ...base, theme: GHOSTTY_THEME, colors }).changed).toEqual(['theme'])
    expect(term.options.theme).toBe(colors)
    expect(applyAppearance(term, { ...base, theme: GHOSTTY_THEME, colors }).changed).toEqual([])
  })

  it('U-TERM-51 · the bundled addon takes its config’s atlas when the colours change, releases the one it leaves (the last terminal out disposes it), and a context drops its textures of an atlas it no longer draws from, in both builds', () => {
    const lib = path.dirname(createRequire(import.meta.url).resolve('@xterm/addon-webgl'))
    for (const file of ['addon-webgl.mjs', 'addon-webgl.js']) {
      const src = fs.readFileSync(path.join(lib, file), 'utf8')
      expect(src, `${file}: the renderer follows the theme service's colour changes`).toContain('this._themeService.onChangeColors(()=>this._handleColorChange())')
      expect(src, `${file}: a colour change takes the atlas of the new config`).toContain('_handleColorChange(){this._refreshCharAtlas()')
      // `acquireTextureAtlas`: a terminal that owned an atlas of another config leaves it; its last owner disposes it
      expect(src, `${file}: the atlas cache releases the atlas a terminal leaves`).toMatch(/(?:(\w)\.ownedBy\.length===1|1===(\w)\.ownedBy\.length)\?\((?:\1|\2)\.atlas\.dispose\(\),\w+\.splice\(\w,1\)\):(?:\1|\2)\.ownedBy\.splice\(\w,1\)/)
      // the patch: the glyph renderer deletes its textures of the old atlas's pages when it is given another
      expect(src, `${file}: a context releases its textures of the atlas it leaves`).toContain('setAtlas(t){this._atlas!==t&&this._releaseAtlasPages()')
    }
  })
})
