# app/preload

The sandboxed window's only bridge to the rest of Kea. It exposes `window.kea`, a small typed API, and nothing else: no
Node, no `ipcRenderer`, no file system.

`contextBridge` cannot carry MessagePorts, so the ports main hands the window (the RPC port to core, one stream port per
terminal to ptyhost) are forwarded to the page with `window.postMessage(data, location.origin, ports)`. Main's other
messages (menu commands, wake after sleep, a screen reader starting or stopping, core going away, the first-quit sheet)
travel the same way, so the page never registers a listener across the bridge. The page's side is
`app/renderer/src/lib/bridge.ts`.

`window.kea` holds two values: `platform` (version, architecture, perf build) and `handedOver` (the composer drafts a
window rebuilt in place of another on Wayland takes over). `pathForFile` gives a dropped file's path. Everything else
asks main for something: `hello`, `requestStream`, `setMenuState`, `pickFolder`, `reveal`, `openSettingsFile`,
`askNotificationState`, `openNotificationSettings`, `openHomeItem`, `mainCommand`, `editRole`, `openMenu` (Linux),
`quitChoice`, `askResourceReports`, `sendResources` and `handOver`. Main validates what each one sends; `mainCommand`,
`editRole` and `openHomeItem` send a name that main checks against its own list, never a path. `src/preload.ts`
documents each member.

It is built as one CommonJS bundle (`preload.cjs`, by `tools/build.ts`), since a sandboxed preload cannot be an ES
module.
