// Frame-by-frame observation of the window's terminal rendering, for the e2e and leak suites. Everything here runs in
// the page, on top of the renderer's test probes (app/renderer/src/lib/testProbes.ts) and xterm's public events;
// nothing is changed in the app.
//
// Frames are counted by one requestAnimationFrame loop. A callback registered in one frame runs early in the next,
// before the callbacks registered later (xterm's render debouncer, the view's WebGL reload), so during a frame's
// rendering steps the counter holds that frame's number, and an event between two frames carries the number of the
// frame before it: it is painted, at the earliest, in frame n + 1.
//
// RenderWatch (one terminal): renderer switches seen in its DOM (`dom`: xterm's DOM renderer rows appear; `gl`: a WebGL
//   canvas appears), its full-viewport renders (`render`), and `webglcontextlost` events on its canvas (`lost`).
// GlWatch (the whole window): the most WebGL contexts alive in any frame — the views' own count and the
//   contexts actually alive on their canvases — WebGL canvases that left the page with their context still alive
//   (`loseContext()` first; checked in every frame and at every `Terminal.dispose`), and every
//   `webglcontextlost` on the terminal on screen.

import type { Kea } from './app.ts'

export interface RenderEvent {
  frame: number
  kind: 'dom' | 'gl' | 'render' | 'lost'
}

export interface GlStats {
  frames: number
  /** The most WebGL contexts the views counted in any frame (`renderer.webglContexts`). */
  maxCounted: number
  /** The most contexts alive (not lost) on the live views' canvases in any frame. */
  maxAlive: number
  /** Terminals disposed while the watch ran. */
  disposed: number
  /** WebGL canvases released (removed from the page) while the watch ran, and those whose context was still alive. */
  released: number
  releasedAlive: number
  /** `webglcontextlost` events on the canvas of the terminal on screen. */
  lostOnShown: number
}

type Probe = {
  classes: { Terminal: { prototype: { dispose(): void } } }
  views(): { ptyId: string; webgl: boolean; shown: boolean }[]
  glCanvas(id: string): HTMLCanvasElement | null
  terminal(id: string): { rows: number; element?: HTMLElement; onRender(cb: (e: { start: number; end: number }) => void): { dispose(): void } } | undefined
}
type Perf = { resources(): { 'renderer.webglContexts': number } }
type Page = { frame: number; render: RenderEvent[]; gl: GlStats; stopRender?: () => void; stopGl?: () => void }
const NO_GL: GlStats = { frames: 0, maxCounted: 0, maxAlive: 0, disposed: 0, released: 0, releasedAlive: 0, lostOnShown: 0 }

/** Start the window's frame counter (once per page load); the watches below need it. */
async function frames(kea: Kea): Promise<void> {
  await (await kea.page()).evaluate(() => {
    const w = window as unknown as { __keaRender?: Page }
    if (w.__keaRender) return
    const st: Page = { frame: 0, render: [], gl: { frames: 0, maxCounted: 0, maxAlive: 0, disposed: 0, released: 0, releasedAlive: 0, lostOnShown: 0 } }
    w.__keaRender = st
    const tick = () => {
      st.frame++
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** Watch one terminal's renderer switches, renders and context losses until `stopRenderWatch`. */
export async function startRenderWatch(kea: Kea, ptyId: string): Promise<void> {
  await frames(kea)
  await (await kea.page()).evaluate((id) => {
    const st = (window as unknown as { __keaRender: Page }).__keaRender
    const probe = (window as unknown as { __keaProbe: Probe }).__keaProbe
    const t = probe.terminal(id)
    const host = document.querySelector(`.terminal-host[data-pty="${id}"]`)
    if (!t || !host) throw new Error(`no view of ${id}`)
    st.render = []
    const log = (kind: RenderEvent['kind']) => st.render.push({ frame: st.frame, kind })
    const sub = t.onRender((e) => {
      if (e.start === 0 && e.end === t.rows - 1) log('render')
    })
    const mo = new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue
          if (n.classList.contains('xterm-rows')) log('dom')
          else if (n instanceof HTMLCanvasElement && n.className === '' && n.parentElement?.classList.contains('xterm-screen')) log('gl')
        }
    })
    mo.observe(host, { childList: true, subtree: true })
    const onLost = (e: Event) => {
      if (host.contains(e.target as Node)) log('lost')
    }
    window.addEventListener('webglcontextlost', onLost, true)
    st.stopRender = () => {
      sub.dispose()
      mo.disconnect()
      window.removeEventListener('webglcontextlost', onLost, true)
    }
  }, ptyId)
}

export async function stopRenderWatch(kea: Kea): Promise<RenderEvent[]> {
  return (await kea.page()).evaluate(() => {
    const st = (window as unknown as { __keaRender: Page }).__keaRender
    st.stopRender?.()
    st.stopRender = undefined
    return st.render
  })
}

/** The page's current frame number. */
export async function frameNow(kea: Kea): Promise<number> {
  return (await kea.page()).evaluate(() => (window as unknown as { __keaRender: Page }).__keaRender.frame)
}

/** Watch WebGL contexts and terminal disposal across the window until `stopGlWatch`. */
export async function startGlWatch(kea: Kea): Promise<void> {
  await frames(kea)
  await (await kea.page()).evaluate((none) => {
    const st = (window as unknown as { __keaRender: Page }).__keaRender
    const probe = (window as unknown as { __keaProbe: Probe }).__keaProbe
    const perf = (window as unknown as { __keaPerf: Perf }).__keaPerf
    st.gl = { ...none }
    let on = true
    // the canvases holding a WebGL2 context: the live views' now, and every one created from here on
    const known = new Set<HTMLCanvasElement>() // bounded: WebGL canvases of one test, dropped once released
    for (const v of probe.views()) {
      const c = v.webgl ? probe.glCanvas(v.ptyId) : null
      if (c) known.add(c)
    }
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const ctx = (getContext as (this: HTMLCanvasElement, t: string, ...r: unknown[]) => unknown).call(this, type, ...rest)
      if (type === 'webgl2' && ctx) known.add(this)
      return ctx
    } as typeof getContext
    // a canvas that left the page must have lost its context first: @xterm/addon-webgl never calls
    // `loseContext()` on dispose, and Chromium counts a context not yet collected towards its cap
    const released = () => {
      for (const c of known) {
        if (c.isConnected) continue
        known.delete(c)
        st.gl.released++
        const gl = getContext.call(c, 'webgl2') as WebGL2RenderingContext | null
        if (gl && !gl.isContextLost()) st.gl.releasedAlive++
      }
    }
    const alive = () => {
      let n = 0
      for (const c of known) {
        const gl = c.isConnected ? (getContext.call(c, 'webgl2') as WebGL2RenderingContext | null) : null
        if (gl && !gl.isContextLost()) n++
      }
      return n
    }
    const sample = () => {
      if (!on) return
      st.gl.frames++
      st.gl.maxCounted = Math.max(st.gl.maxCounted, perf.resources()['renderer.webglContexts'])
      st.gl.maxAlive = Math.max(st.gl.maxAlive, alive())
      released()
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    const proto = probe.classes.Terminal.prototype
    const dispose = proto.dispose
    proto.dispose = function (this: unknown) {
      st.gl.disposed++
      released()
      return dispose.call(this)
    }
    const onLost = (e: Event) => {
      if (document.querySelector('.terminal-host.shown')?.contains(e.target as Node)) st.gl.lostOnShown++
    }
    window.addEventListener('webglcontextlost', onLost, true)
    st.stopGl = () => {
      on = false
      released()
      proto.dispose = dispose
      HTMLCanvasElement.prototype.getContext = getContext
      window.removeEventListener('webglcontextlost', onLost, true)
    }
  }, NO_GL)
}

export async function stopGlWatch(kea: Kea): Promise<GlStats> {
  return (await kea.page()).evaluate(() => {
    const st = (window as unknown as { __keaRender: Page }).__keaRender
    st.stopGl?.()
    st.stopGl = undefined
    return st.gl
  })
}

/** Lose the WebGL context of `ptyId`'s view, as a GPU reset would (`WEBGL_lose_context`). */
export async function loseWebglContext(kea: Kea, ptyId: string): Promise<void> {
  await (await kea.page()).evaluate((id) => {
    const probe = (window as unknown as { __keaProbe: Probe }).__keaProbe
    const c = probe.glCanvas(id)
    const gl = c ? (c.getContext('webgl2') as WebGL2RenderingContext | null) : null
    const ext = gl?.getExtension('WEBGL_lose_context')
    if (!ext) throw new Error(`${id} has no WebGL context to lose`)
    ext.loseContext()
  }, ptyId)
}
