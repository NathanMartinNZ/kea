// The renderer's whole bridge: its RPC port to core, one stream port per attached terminal to ptyhost, the menu bar's
// state and choices, the wake signal after sleep, whether a screen reader runs, core going away, main's requests
// for the renderer's resource report and the window's own question for every process's (`askResourceReports`: Copy
// diagnostics and the dev HUD), the native pieces of the window's UI (the folder picker, Reveal in the file manager,
// opening settings.json, the path of a dropped file), the first-quit sheet and its answer and a session to show, what
// a window rebuilt in this one's place handed over and this window's own answer when main asks (the composer drafts,
// on Wayland), and platform facts. Nothing else crosses: no Node, no ipcRenderer, no fs.
//
// contextBridge cannot carry MessagePorts, so ports reach the page by `window.postMessage` with the port transferred
// (`{ kea: 'rpc' }`, `{ kea: 'stream', reqId }`); main's other messages travel the same way (`{ kea: 'command', id }`,
// `{ kea: 'wake' }`, `{ kea: 'coreAway' }`, `{ kea: 'resources', reqId }`, `{ kea: 'quitSheet', live }`,
// `{ kea: 'showSession', sessionId }`, `{ kea: 'screenReader', on }`, `{ kea: 'gpuReset' }`: the memory watchdog asks
// for the GPU process's memory back), so the page never registers a listener across the bridge, where Electron cannot
// remove one by identity. The renderer's `lib/bridge.ts` turns these into `openStream(ptyId):
// Promise<MessagePort>`, `onCommand`, `onWake`, `onCoreConnection` and the answer to a resource-report request
// (`sendResources`).

import { contextBridge, ipcRenderer, webUtils } from 'electron'

const version = process.argv.find((a) => a.startsWith('--kea-version='))?.slice('--kea-version='.length) ?? '0.0.0'
const perf = process.argv.includes('--kea-perf')
// A window made in place of a minimized one on Wayland asks main once, as it starts, for what that one handed over
// (answered at once from main's memory); every other window starts without asking
const handedOver: unknown = process.argv.includes('--kea-handoff') ? takeHandoff() : null

function takeHandoff(): unknown {
  try {
    return ipcRenderer.sendSync('kea:takeHandoff') as unknown
  } catch {
    return null
  }
}

function toPage(data: Record<string, unknown>, ports: MessagePort[]): void {
  window.postMessage(data, window.location.origin, ports)
}

ipcRenderer.on('kea:rpc', (e) => {
  const port = e.ports[0]
  if (port) toPage({ kea: 'rpc' }, [port])
})
ipcRenderer.on('kea:stream', (e, msg: { reqId: number }) => {
  const port = e.ports[0]
  if (port && typeof msg?.reqId === 'number') toPage({ kea: 'stream', reqId: msg.reqId }, [port])
})
ipcRenderer.on('kea:streamError', (_e, msg: { reqId: number; error: string }) => {
  if (typeof msg?.reqId === 'number') toPage({ kea: 'streamError', reqId: msg.reqId, error: String(msg.error) }, [])
})
ipcRenderer.on('kea:streamsReset', () => toPage({ kea: 'streamsReset' }, []))
ipcRenderer.on('kea:command', (_e, msg: { id: unknown; args?: unknown }) => {
  if (typeof msg?.id === 'string') toPage({ kea: 'command', id: msg.id, ...(msg.args !== undefined ? { args: msg.args } : {}) }, [])
})
ipcRenderer.on('kea:wake', () => toPage({ kea: 'wake' }, []))
ipcRenderer.on('kea:gpuReset', () => toPage({ kea: 'gpuReset' }, []))
ipcRenderer.on('kea:screenReader', (_e, msg: { on: unknown }) => toPage({ kea: 'screenReader', on: msg?.on === true }, []))
ipcRenderer.on('kea:folder', (_e, msg: { reqId: unknown; path: unknown }) => {
  if (typeof msg?.reqId === 'number') toPage({ kea: 'folder', reqId: msg.reqId, path: typeof msg.path === 'string' ? msg.path : null }, [])
})
ipcRenderer.on('kea:coreAway', () => toPage({ kea: 'coreAway' }, []))
ipcRenderer.on('kea:notificationState', (_e, msg: { reqId: unknown; denied: unknown }) => {
  if (typeof msg?.reqId === 'number') toPage({ kea: 'notificationState', reqId: msg.reqId, denied: msg.denied === true }, [])
})
ipcRenderer.on('kea:resources', (_e, msg: { reqId: unknown }) => {
  if (typeof msg?.reqId === 'number') toPage({ kea: 'resources', reqId: msg.reqId }, [])
})
ipcRenderer.on('kea:resourceReports', (_e, msg: { reqId: unknown; collected: unknown }) => {
  if (typeof msg?.reqId === 'number') toPage({ kea: 'resourceReports', reqId: msg.reqId, collected: msg.collected ?? null }, [])
})
ipcRenderer.on('kea:quitSheet', (_e, msg: { live: unknown; background?: unknown }) => {
  if (typeof msg?.live === 'number') toPage({ kea: 'quitSheet', live: msg.live, background: msg.background !== false }, [])
})
ipcRenderer.on('kea:showSession', (_e, msg: { sessionId: unknown }) => {
  if (typeof msg?.sessionId === 'string') toPage({ kea: 'showSession', sessionId: msg.sessionId }, [])
})
ipcRenderer.on('kea:handoffAsk', (_e, msg: { reqId: unknown }) => {
  if (Number.isInteger(msg?.reqId)) toPage({ kea: 'handoffAsk', reqId: msg.reqId }, [])
})

contextBridge.exposeInMainWorld('kea', {
  platform: { version, arch: process.arch, perf },
  /** What the window this one was made in place of handed over (its composer drafts); null for every other window. */
  handedOver,
  /** This window's answer to main's question `reqId` (`{ kea: 'handoffAsk', reqId }`); main checks it (zWindowHandoff). */
  handOver: (reqId: number, state: unknown): void => {
    if (Number.isInteger(reqId) && typeof state === 'object' && state !== null) ipcRenderer.send('kea:handoff', { reqId, state })
  },
  /** Ask main for the RPC port (again after a reload); it arrives as `{ kea: 'rpc' }`. */
  hello: (): void => ipcRenderer.send('kea:hello'),
  /** Ask for a stream port to one terminal; it arrives as `{ kea: 'stream', reqId }` or `{ kea: 'streamError', reqId }`. */
  requestStream: (ptyId: string, reqId: number): void => {
    if (typeof ptyId === 'string' && Number.isInteger(reqId)) ipcRenderer.send('kea:openStream', { ptyId, reqId })
  },
  /** The commands this window can run and whether each is available now; main validates it and rebuilds the menu bar. */
  setMenuState: (state: unknown): void => {
    if (typeof state === 'object' && state !== null) ipcRenderer.send('kea:menuState', state)
  },
  /**
   * A folder from the native picker, for Add Project or for Locate… on a project whose folder is missing; it arrives
   * as `{ kea: 'folder', reqId, path }`.
   */
  pickFolder: (reqId: number, purpose: string): void => {
    if (Number.isInteger(reqId) && typeof purpose === 'string') ipcRenderer.send('kea:pickFolder', { reqId, purpose })
  },
  /** Reveal a project root or worktree in the file manager (main checks the path). */
  reveal: (p: string): void => {
    if (typeof p === 'string') ipcRenderer.send('kea:reveal', p)
  },
  /** Open this home's settings.json, from the banner shown while it is invalid. */
  openSettingsFile: (): void => ipcRenderer.send('kea:openSettingsFile'),
  /** Settings › Notifications: ask main whether a notification failed to show; it answers `{ kea: 'notificationState', reqId, denied }`. */
  askNotificationState: (reqId: number): void => {
    if (Number.isInteger(reqId)) ipcRenderer.send('kea:notificationState', { reqId })
  },
  /** Open macOS's notification settings. */
  openNotificationSettings: (): void => ipcRenderer.send('kea:openNotificationSettings'),
  /** Open one item of this home: `keybindings` (keybindings.json), `reports` (the reports folder) or `logs`. Main checks the name. */
  openHomeItem: (which: string): void => {
    if (typeof which === 'string') ipcRenderer.send('kea:openHomeItem', which)
  },
  /** Run one of main's own commands from the palette (`MAIN_COMMANDS`: they work with no window). Main checks it. */
  mainCommand: (id: string): void => {
    if (typeof id === 'string') ipcRenderer.send('kea:mainCommand', id)
  },
  /** Copy or paste in the focused element, as the Edit menu's roles do (the palette's Copy and Paste). Main checks the role. */
  editRole: (role: string): void => {
    if (typeof role === 'string') ipcRenderer.send('kea:editRole', role)
  },
  /** The path of a file or folder dropped on the window; empty when it has none. */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  /**
   * The window's menu under the header's menu button, at `x`, `y` in the window (only Linux's header has the button);
   * main checks both.
   */
  openMenu: (x: number, y: number): void => {
    if (Number.isFinite(x) && Number.isFinite(y)) ipcRenderer.send('kea:openMenu', { x, y })
  },
  /** The first-quit sheet's answer: `menuBar`, `quit` or `stopAll`; main validates it. */
  quitChoice: (choice: string): void => {
    if (typeof choice === 'string') ipcRenderer.send('kea:quitChoice', choice)
  },
  /**
   * Copy diagnostics and the dev HUD: ask main for every process's resource report; it answers
   * `{ kea: 'resourceReports', reqId, collected }`.
   */
  askResourceReports: (reqId: number): void => {
    if (Number.isInteger(reqId)) ipcRenderer.send('kea:resourceReports', { reqId })
  },
  /** The answer to main's resource-report request `reqId`; main validates it (zResourcesReply). */
  sendResources: (reqId: number, report: unknown): void => {
    if (Number.isInteger(reqId) && typeof report === 'object' && report !== null) ipcRenderer.send('kea:resources', { reqId, report })
  },
})
