// The window's terminal views: one registry, plus what spans every view (the atlas refresh on DPR change and wake from
// sleep, the memory watchdog's GPU reset, the tab kinds the paste policy needs, screen-reader mode and the terminals'
// accessible names, and the resource counts).

import { onGpuReset, onScreenReader, onWake } from '../../lib/bridge.ts'
import { call } from '../../lib/rpc.ts'
import type { AtlasCanvas } from './atlas.ts'
import { NO_RESULTS } from './find.ts'
import { prefs } from './prefs.ts'
import { TerminalRegistry } from './registry.ts'
import { ScreenReaderMode } from './screenReader.ts'
import { recallScroll, rememberScroll, scrollMarkCount } from './scrollMarks.ts'
import { streamPorts } from './streams.ts'
import { terminalUi } from './ui.svelte.ts'
import { TerminalView, webglContexts, type ViewState } from './view.ts'

const kinds = new Map<string, string>() // bounded: one per open tab

export const terminals: TerminalRegistry<TerminalView> = new TerminalRegistry<TerminalView>(
  (ptyId) => {
    const v = new TerminalView(ptyId, {
      isShown: (id: string): boolean => terminals.isShown(id),
      isPlainShell: (id: string): boolean => kinds.get(id) === 'shell',
      rememberScroll,
      recallScroll,
      // An ended terminal whose holder is gone shows its last screen, from its checkpoint, on demand
      lastScreen: (id, cols, rows) => call('terminal.lastScreen', { ptyId: id, cols, rows }),
    })
    screenReader.adopt(v)
    return v
  },
  undefined,
  // screen-reader mode is on in the terminal on screen only
  (id) => screenReader.setShown(id),
)

/** xterm's screen-reader mode while a screen reader runs, and each terminal's accessible name (screenReader.ts). */
export const screenReader: ScreenReaderMode<TerminalView> = new ScreenReaderMode<TerminalView>(() => terminals.all())

// Live views that no terminal area hosts (other sessions' warm terminals, every view while the composer shows):
// mounted here, hidden like a warm host (`display: none`, xterm pauses rendering), WebGL kept.
let dock: HTMLDivElement | null = null // bounded: one per window
// the area showing terminals now, and the terminal on screen when the last one went without a successor yet: a session
// switch replaces the pane, and the area that comes keeps that terminal on screen until its own has painted,
// whether it is made before the old one goes or after
let currentArea: object | null = null // bounded: one per window
let handoff: string | null = null

/** A host lets its view go: the view waits in the dock (a disposed one has left the DOM already). */
export function dockView(v: TerminalView, host: HTMLElement): void {
  if (v.el.parentElement !== host) return
  if (!dock) {
    dock = document.createElement('div')
    dock.className = 'terminal-dock'
    dock.setAttribute('aria-hidden', 'true')
    document.body.appendChild(dock)
  }
  dock.appendChild(v.el)
}

/** A terminal area comes: the terminal on screen that it keeps on screen until its own has painted, if any. */
export function enterArea(token: object): string | null {
  const inherited = currentArea !== null ? (terminals.shown()?.ptyId ?? null) : handoff
  handoff = null
  currentArea = token
  return inherited
}

/**
 * A terminal area goes. An area that came meanwhile owns the screen already; if one comes in the same task, it takes
 * the terminal on screen (`enterArea`); if none does (the composer), nothing is on screen any more.
 */
export function leaveArea(token: object): void {
  if (currentArea !== token) return
  currentArea = null
  handoff = terminals.shown()?.ptyId ?? null
  if (handoff === null) return
  queueMicrotask(() => {
    if (handoff === null || currentArea !== null) return
    handoff = null
    // nothing on screen any more (the composer): no view keeps a search, its highlights or its re-search after each
    // write, and the find bar's state is closed
    for (const v of terminals.all()) v.closeFind()
    terminalUi.find({ open: false, results: NO_RESULTS })
    terminals.setShown(null)
  })
}

/**
 * A view's state, while it is on screen, drives "Jump to bottom". Made here, so the closure holds the id alone: one made
 * inside a switch would keep that switch's views (the one it left, the one it made) reachable for as long as the view
 * lives — a disposed terminal among them (L-TERM-6).
 */
export function followScroll(id: string): (s: ViewState) => void {
  return (s) => {
    if (terminals.isShown(id)) terminalUi.scrolledUp(s.scrolledUp)
  }
}

/** The open tabs of the context on screen and their PTY kinds (the terminals store). */
export function setTabKinds(tabs: Iterable<[string, string]>): void {
  kinds.clear()
  for (const [id, kind] of tabs) kinds.set(id, kind)
}

/** The open tabs' accessible names (`terminalName`: session, then tab). */
export function setTerminalNames(names: Iterable<readonly [string, string]>): void {
  screenReader.setNames(names)
}

/** The view whose terminal has keyboard focus, if any. */
export function focusedView(): TerminalView | undefined {
  for (const v of terminals.all()) if (v.hasFocus()) return v
  return undefined
}

/** The view on screen, else the one being switched to (perf probes, commands). */
export function activeView(): TerminalView | undefined {
  return terminals.shown() ?? terminals.visible()
}

/** Clear every WebGL terminal's atlas (DPR change, wake, "Reset Terminal Rendering"; the watchdog's GPU reset). */
export function clearAllAtlases(reason: 'dpr' | 'wake' | 'reset' | 'watchdog'): void {
  for (const v of terminals.all()) v.clearAtlas(reason)
}

/**
 * main's watchdog found the GPU process over its hard limit. Every glyph atlas is cleared (the atlas guard's clear:
 * each page evicted, each context's textures of it released), then every WebGL renderer is made anew by the way a lost
 * context already is. Terminals, their buffers and their streams are not touched.
 */
export function resetGpu(): void {
  clearAllAtlases('watchdog')
  for (const v of terminals.all()) v.recreateWebgl()
}

/**
 * Live counts for the resource report and the leak tests. The atlas rows count each page once: terminals with
 * the same font and colours share one atlas (xterm's atlas cache), and each of their guards sees it.
 */
export function terminalResources(): Record<string, number> {
  const pages = new Map<AtlasCanvas, number>() // bounded: the window's live atlas pages (the atlas guard caps them)
  let searches = 0
  for (const v of terminals.all()) {
    for (const [c, bytes] of v.atlasPages()) pages.set(c, bytes)
    if (v.findOpen) searches++
  }
  let atlasBytes = 0
  for (const b of pages.values()) atlasBytes += b
  return { terminals: terminals.size, webglContexts: webglContexts(), atlasBytes, atlasPages: pages.size, streamPorts: streamPorts(), searchAddons: searches, scrollMarks: scrollMarkCount() }
}

// DPR changes (moving the window to another display): one media query, re-armed at each new ratio
let dprQuery: MediaQueryList | null = null // bounded: one per window
function watchDpr(): void {
  dprQuery?.removeEventListener('change', onDpr)
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprQuery.addEventListener('change', onDpr)
}
function onDpr(): void {
  clearAllAtlases('dpr')
  watchDpr()
}
watchDpr()
onWake(() => clearAllAtlases('wake'))
onGpuReset(resetGpu)
// main says when a screen reader starts or stops (Electron's accessibility support; VoiceOver turns it on).
// Linux tells no change, so `terminal.screenReader` can say on or off there; auto follows main
let systemScreenReader = false
function applyScreenReader(): void {
  const mode = prefs.get().screenReader
  screenReader.setRunning(mode === 'on' ? true : mode === 'off' ? false : systemScreenReader)
}
onScreenReader((on) => {
  systemScreenReader = on
  applyScreenReader()
})
prefs.subscribe(applyScreenReader)
