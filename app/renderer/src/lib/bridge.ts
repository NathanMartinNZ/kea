// The page side of the preload bridge: `rpc` (the port to core, replaced when core restarts), `openStream(ptyId)` (a
// port to ptyhost for one terminal), the menu bar (the renderer reports which commands it can run, main sends back the
// one chosen), the wake signal after sleep, the memory watchdog's request for the GPU process's memory back
// (`gpuReset`), core going away (main's `coreAway`; the next RPC port means it is back) and main's requests for this
// renderer's resource report, answered by the reporter `setResourceReporter` installs, and the window's own question
// for every process's report (`resourceReports`: Copy diagnostics and the dev HUD); the native pieces of the window's
// UI: the folder picker (`pickFolder`), `reveal`, `openSettingsFile` and `pathForFile` for dropped files; the
// first-quit sheet main asks for and its answer, and a session main asks the window to show. Ports and main's messages
// arrive by window.postMessage from the preload, because contextBridge cannot carry MessagePorts.

import { asCollectedResources, isCommandId, zWindowHandoff, type CollectedResources, type CommandInvocation, type MenuState, type ResourceReport, type WindowHandoff } from '@kea/protocol'

interface PreloadApi {
  platform: { version: string; arch: string; perf: boolean }
  handedOver: unknown
  handOver(reqId: number, state: WindowHandoff): void
  hello(): void
  requestStream(ptyId: string, reqId: number): void
  setMenuState(state: MenuState): void
  sendResources(reqId: number, report: ResourceReport): void
  askResourceReports(reqId: number): void
  pickFolder(reqId: number, purpose: 'add' | 'locate'): void
  reveal(path: string): void
  openSettingsFile(): void
  openHomeItem(which: 'keybindings' | 'reports' | 'logs'): void
  askNotificationState(reqId: number): void
  openNotificationSettings(): void
  mainCommand(id: string): void
  editRole(role: 'copy' | 'paste'): void
  pathForFile(file: File): string
  quitChoice(choice: string): void
  openMenu(x: number, y: number): void
}

declare global {
  interface Window {
    kea: PreloadApi
  }
}

type Pending = { resolve(p: MessagePort): void; reject(e: Error): void }

const pending = new Map<number, Pending>() // bounded: one per stream request in flight
const rpcListeners = new Set<(port: MessagePort) => void>() // bounded: the app's one RPC client
const resetListeners = new Set<() => void>() // bounded: one per attached terminal view
const commandListeners = new Set<(c: CommandInvocation) => void>() // bounded: the command registry
const wakeListeners = new Set<() => void>() // bounded: the terminal views module
const gpuResetListeners = new Set<() => void>() // bounded: the terminal views module
const screenReaderListeners = new Set<(on: boolean) => void>() // bounded: the terminal views module
/** Whether a screen reader runs, as main last said; false until it says. */
let screenReaderOn = false
const coreListeners = new Set<(up: boolean) => void>() // bounded: the Reconnecting bar, the viewing report and the editor list
const folderPicks = new Map<number, (path: string | null) => void>() // bounded: folder picks in flight, one dialog at a time
const reportAsks = new Map<number, (c: CollectedResources | null) => void>() // bounded: questions to main for every process's report that it has not answered yet; main answers each by its own deadline for the processes
const quitSheetListeners = new Set<(live: number, background: boolean) => void>() // bounded: the window's one quit-sheet installer
const showSessionListeners = new Set<(sessionId: string) => void>() // bounded: the window's one installer
let nextReq = 1
let lastRpc: MessagePort | null = null
let reporter: (() => ResourceReport) | null = null
/** What this window hands the one main rebuilds in its place (the composer's drafts). */
let handoffSource: (() => WindowHandoff) | null = null
/** Settings › Notifications' question to main, while it is out (one at a time: a newer one replaces it). */
let notificationAsk: { reqId: number; done(denied: boolean): void } | null = null

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.origin !== window.location.origin) return
  const d = e.data as { kea?: string; reqId?: number; error?: string; id?: unknown; args?: unknown } | null
  if (!d || typeof d.kea !== 'string') return
  switch (d.kea) {
    case 'rpc': {
      const port = e.ports[0]
      if (!port) return
      lastRpc = port
      for (const l of rpcListeners) l(port)
      for (const l of [...coreListeners]) l(true)
      return
    }
    case 'coreAway':
      for (const l of [...coreListeners]) l(false)
      return
    case 'stream': {
      const p = pending.get(d.reqId ?? -1)
      const port = e.ports[0]
      if (!p || !port) return
      pending.delete(d.reqId!)
      p.resolve(port)
      return
    }
    case 'streamError': {
      const p = pending.get(d.reqId ?? -1)
      if (!p) return
      pending.delete(d.reqId!)
      p.reject(new Error(d.error ?? 'stream unavailable'))
      return
    }
    case 'streamsReset':
      for (const l of [...resetListeners]) l()
      return
    case 'command': {
      if (!isCommandId(d.id)) return
      const c: CommandInvocation = d.args === undefined ? { id: d.id } : { id: d.id, args: d.args }
      for (const l of [...commandListeners]) l(c)
      return
    }
    case 'wake':
      for (const l of [...wakeListeners]) l()
      return
    case 'gpuReset':
      for (const l of [...gpuResetListeners]) l()
      return
    case 'screenReader': {
      const on = (d as { on?: unknown }).on === true
      if (on === screenReaderOn) return
      screenReaderOn = on
      for (const l of [...screenReaderListeners]) l(on)
      return
    }
    case 'folder': {
      const done = folderPicks.get(d.reqId ?? -1)
      if (!done) return
      folderPicks.delete(d.reqId!)
      const p = (d as { path?: unknown }).path
      done(typeof p === 'string' ? p : null)
      return
    }
    case 'notificationState': {
      const ask = notificationAsk
      if (!ask || ask.reqId !== d.reqId) return
      notificationAsk = null
      ask.done((d as { denied?: unknown }).denied === true)
      return
    }
    case 'resourceReports': {
      const done = reportAsks.get(d.reqId ?? -1)
      if (!done) return
      reportAsks.delete(d.reqId!)
      done(asCollectedResources((d as { collected?: unknown }).collected))
      return
    }
    case 'quitSheet': {
      const { live, background } = d as { live?: unknown; background?: unknown }
      if (typeof live === 'number') for (const l of [...quitSheetListeners]) l(live, background !== false)
      return
    }
    case 'showSession': {
      const id = (d as { sessionId?: unknown }).sessionId
      if (typeof id === 'string') for (const l of [...showSessionListeners]) l(id)
      return
    }
    case 'handoffAsk': {
      // main rebuilds this window (minimized on Wayland) and asks what to hand the new one first
      if (typeof d.reqId === 'number' && handoffSource) window.kea.handOver(d.reqId, handoffSource())
      return
    }
    case 'resources': {
      // a gauge that throws costs only its own rows (NaN, features/resources/rows.ts); only a reporter that is missing or
      // fails as a whole sends nothing, and main lists this renderer as missing (`no answer`) after its deadline
      if (typeof d.reqId !== 'number' || !reporter) return
      let report: ResourceReport
      try {
        report = reporter()
      } catch (err) {
        console.warn('resource report failed', err)
        return
      }
      window.kea.sendResources(d.reqId, report)
      return
    }
  }
})

export const platform = window.kea.platform

/** Called with the RPC port now (if one has arrived) and on every replacement. Returns an unsubscribe function. */
export function onRpcPort(cb: (port: MessagePort) => void): () => void {
  rpcListeners.add(cb)
  if (lastRpc) cb(lastRpc)
  else window.kea.hello()
  return () => rpcListeners.delete(cb)
}

export function openStream(ptyId: string): Promise<MessagePort> {
  const reqId = nextReq++
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    window.kea.requestStream(ptyId, reqId)
  })
}

/** ptyhost restarted: every stream port is dead; attached views reopen theirs. */
export function onStreamsReset(cb: () => void): () => void {
  resetListeners.add(cb)
  return () => resetListeners.delete(cb)
}

/** A command chosen from the menu bar. Returns an unsubscribe function. */
export function onCommand(cb: (c: CommandInvocation) => void): () => void {
  commandListeners.add(cb)
  return () => commandListeners.delete(cb)
}

/** The machine woke from sleep. Returns an unsubscribe function. */
export function onWake(cb: () => void): () => void {
  wakeListeners.add(cb)
  return () => wakeListeners.delete(cb)
}

/**
 * Main's memory watchdog found the GPU process over its hard limit: the window gives back what it holds there. Returns
 * an unsubscribe function.
 */
export function onGpuReset(cb: () => void): () => void {
  gpuResetListeners.add(cb)
  return () => gpuResetListeners.delete(cb)
}

/**
 * A screen reader started or stopped (main's `screenReader`, sent with the window's first port and at every change).
 * `cb` is told the state now, if one runs already, then each change. Returns an unsubscribe function.
 */
export function onScreenReader(cb: (on: boolean) => void): () => void {
  screenReaderListeners.add(cb)
  if (screenReaderOn) cb(true)
  return () => screenReaderListeners.delete(cb)
}

/**
 * Core went away (false: main's `coreAway`) or is back (true: a new RPC port, the first one included). Unlike
 * `onRpcPort` it never asks main for a port. Returns an unsubscribe function.
 */
export function onCoreConnection(cb: (up: boolean) => void): () => void {
  coreListeners.add(cb)
  return () => coreListeners.delete(cb)
}

/** Tell main which commands this window can run now; it rebuilds the menu bar. */
export function setMenuState(state: MenuState): void {
  window.kea.setMenuState(state)
}

/** The function that answers main's resource-report requests; one per window. */
export function setResourceReporter(fn: () => ResourceReport): void {
  reporter = fn
}

/**
 * Every process's resource report and the newest footprint sample, as main collects them for the hourly line:
 * what Copy diagnostics and the dev HUD show. Null when main has none to give.
 */
export function resourceReports(): Promise<CollectedResources | null> {
  const reqId = nextReq++
  return new Promise((resolve) => {
    reportAsks.set(reqId, resolve)
    window.kea.askResourceReports(reqId)
  })
}

/** Questions of `resourceReports` waiting for main's answer (the resource report). */
export function resourceReportAsks(): number {
  return reportAsks.size
}

/** Folder picks waiting for main's answer (the resource report). */
export function folderPicksPending(): number {
  return folderPicks.size
}

/** The native folder picker (Add Project, Locate…): the folder chosen, or null when cancelled. */
export function pickFolder(purpose: 'add' | 'locate'): Promise<string | null> {
  const reqId = nextReq++
  return new Promise((resolve) => {
    folderPicks.set(reqId, resolve)
    window.kea.pickFolder(reqId, purpose)
  })
}

/** Reveal a folder in the file manager (project.reveal, session.reveal). */
export function reveal(path: string): void {
  window.kea.reveal(path)
}

/** Open settings.json (from the banner that shows its parse error). */
export function openSettingsFile(): void {
  window.kea.openSettingsFile()
}

/** Open keybindings.json, the reports folder or the logs folder of this home; main opens nothing else. */
export function openHomeItem(which: 'keybindings' | 'reports' | 'logs'): void {
  window.kea.openHomeItem(which)
}

/**
 * Has a notification failed to show since the last one that did (macOS denies them, or the build is unsigned)?
 * Main knows; Settings › Notifications asks when it opens. An ask a newer one replaces answers false.
 */
export function notificationsDenied(): Promise<boolean> {
  return new Promise((resolve) => {
    notificationAsk?.done(false)
    const reqId = nextReq++
    notificationAsk = { reqId, done: resolve }
    window.kea.askNotificationState(reqId)
  })
}

/** Open macOS's notification settings. */
export function openNotificationSettings(): void {
  window.kea.openNotificationSettings()
}

/** Run one of main's own commands (Open Kea, Close to Menu Bar, Quit Kea Completely), as its menu item does. */
export function runMainCommand(id: string): void {
  window.kea.mainCommand(id)
}

/** Copy or paste in the focused element, as the Edit menu's role does (the clipboard events reach it). */
export function editRole(role: 'copy' | 'paste'): void {
  window.kea.editRole(role)
}

/** The path of a dropped or pasted file or folder; empty when it has none. */
export function pathForFile(file: File): string {
  return window.kea.pathForFile(file)
}

/**
 * Main asks for the first-quit sheet, with how many sessions keep running and whether Kea can keep running in
 * the background (on Linux only while a tray host is there). Returns an unsubscribe function.
 */
export function onQuitSheet(cb: (live: number, background: boolean) => void): () => void {
  quitSheetListeners.add(cb)
  return () => quitSheetListeners.delete(cb)
}

/** The first-quit sheet's answer: stay in the menu bar, quit completely, or stop all sessions and quit. */
export function quitChoice(choice: 'menuBar' | 'quit' | 'stopAll'): void {
  window.kea.quitChoice(choice)
}

/** The window's menu, opened under the header's menu button (Linux only) at `x`, `y` in the window. */
export function openWindowMenu(x: number, y: number): void {
  window.kea.openMenu(x, y)
}

/** What the window this one was rebuilt in place of handed over, checked; null for every other window. */
export function handedOver(): WindowHandoff | null {
  const r = zWindowHandoff.safeParse(window.kea.handedOver)
  return r.success ? r.data : null
}

/** What this window hands the one main rebuilds in its place, read when main asks (one source: the composer's drafts). */
export function setHandoffSource(source: () => WindowHandoff): void {
  handoffSource = source
}

/** Main asks the window to show a session (the menu-bar item's list). Returns an unsubscribe function. */
export function onShowSession(cb: (sessionId: string) => void): () => void {
  showSessionListeners.add(cb)
  return () => showSessionListeners.delete(cb)
}

/** Open a link in the default browser. Main opens only http, https and mailto and denies the window itself. */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}
