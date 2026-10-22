// What a packaged Kea must not carry, since it makes no network request of its own: no update feed, no crash
// reporter, no telemetry, no network client. Checked on the packaged app itself, in the install's verify step, so a
// dependency or a default that brings one in fails the build instead of shipping.
//
// · Node-side code (main, core, ptyhost, the finder's worker, the preload) is bundled: every module it loads is named
//   in a `require("…")`. Each must be on ALLOWED_MODULES, a list without an HTTP, TLS, DNS or datagram client.
//   `node:net` is on it for the unix sockets (holders, the hook socket) and the dev servers' local port probe:
//   what it connects to cannot be read from the bundle, so that stays a review rule.
// · No bundle names an API that phones home: Electron's `autoUpdater` and `crashReporter`, `electron-updater`, a fetch
//   or socket client. The window's code is not scanned for those: it runs sandboxed under main's Content-Security-
//   Policy (`default-src 'self'`, `connect-src 'self'`), which this audit checks is in the packaged main.
// · Nothing electron-builder or Electron would add for updates is in the bundle: `app-update.yml`, Sparkle keys in
//   Info.plist, a `node_modules` tree in the asar; native modules are unpacked, where their signatures can be read.
// · And once, at run time (C-UPD-1): Chromium's own net log of a packaged Kea's launch, a terminal and a quit holds
//   no request, name lookup or connection (`auditNetLog`).

import fs from 'node:fs'
import path from 'node:path'
import { PRUNE_MARK } from '../../../packages/protocol/src/disk.ts'
import { asarEntries, asarFile, type AsarEntry } from './asar.ts'

/** The bundles that run with Node's reach (tools/build.ts). */
export const NODE_BUNDLES = ['main.cjs', 'core.cjs', 'ptyhost.cjs', 'finder-worker.cjs', 'preload.cjs'] as const

const BUILTINS = ['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'fs/promises', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'readline', 'stream', 'string_decoder', 'timers', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib']
/** Every module a Node-side bundle may load: these built-ins (with or without `node:`) and `electron`. */
export const ALLOWED_MODULES: ReadonlySet<string> = new Set(['electron', ...BUILTINS, ...BUILTINS.map((m) => `node:${m}`)])
/** Files a bundle loads from beside itself: core's native packages (tools/build.ts `native_modules/`). */
const SHIPPED_BESIDE = /^\.\/native_modules\//

const LOADS = /\b(?:require|import)\(\s*(["'`])([^"'`\n]+)\1\s*\)/g
const PHONES_HOME: readonly { what: string; re: RegExp }[] = [
  { what: "Electron's autoUpdater", re: /\bautoUpdater\b/ },
  { what: "Electron's crashReporter", re: /\bcrashReporter\b/ },
  { what: 'an update feed (setFeedURL / checkForUpdates)', re: /\b(?:setFeedURL|checkForUpdates)\b/ },
  { what: 'electron-updater', re: /electron-updater/ },
  { what: 'a fetch call', re: /(?<![.\w$])fetch\s*\(/ },
  { what: "Electron's net client", re: /\bnet\.(?:request|fetch)\s*\(/ },
  { what: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { what: 'a WebSocket', re: /\bnew\s+WebSocket\b/ },
  { what: 'an EventSource', re: /\bnew\s+EventSource\b/ },
  { what: 'sendBeacon', re: /\bsendBeacon\b/ },
]

/** What is wrong with the Node-side bundle `name`: a module off the list, or a name that phones home. */
export function auditNodeBundle(name: string, text: string): string[] {
  const problems: string[] = []
  const off = new Set<string>()
  for (const m of text.matchAll(LOADS)) {
    const mod = m[2] as string
    if (!ALLOWED_MODULES.has(mod) && !SHIPPED_BESIDE.test(mod)) off.add(mod)
  }
  for (const mod of [...off].sort()) problems.push(`${name} loads "${mod}", which is not on the list of modules a packaged Kea may load (tools/pack/src/audit.ts)`)
  for (const p of PHONES_HOME) if (p.re.test(text)) problems.push(`${name} names ${p.what}: Kea makes no network request of its own`)
  return problems
}

const CSP_PARTS = ["default-src 'self'", "connect-src 'self'"]

/** The window's guard is in the packaged main: its Content-Security-Policy keeps every request on `kea://`. */
export function auditCsp(mainText: string): string[] {
  return CSP_PARTS.filter((p) => !mainText.includes(p)).map((p) => `main.cjs does not set the window's Content-Security-Policy part "${p}"`)
}

/** The window's page loads nothing from another origin. */
export function auditPage(html: string): string[] {
  const remote = [...html.matchAll(/\b(?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi)].map((m) => m[1] as string)
  return remote.map((u) => `renderer/index.html loads ${u}: the window loads only kea://`)
}

/** What is wrong with the archive's contents: a dependency tree, or a native module left inside it. */
export function auditEntries(entries: readonly AsarEntry[], unpackedDir: string | null): string[] {
  const problems: string[] = []
  const modules = entries.filter((e) => e.name.split('/').includes('node_modules'))
  if (modules.length) problems.push(`app.asar holds a node_modules tree (${modules.length} files, e.g. ${modules[0]!.name}): everything Kea runs is bundled`)
  for (const e of entries.filter((x) => x.name.endsWith('.node'))) {
    if (!e.unpacked) problems.push(`${e.name} is packed inside app.asar: native modules are unpacked, where their signatures can be read`)
    else if (unpackedDir && !fs.existsSync(path.join(unpackedDir, e.name))) problems.push(`${e.name} is marked unpacked but is not in app.asar.unpacked`)
  }
  for (const b of NODE_BUNDLES) if (!entries.some((e) => e.name === b)) problems.push(`app.asar has no ${b}`)
  return problems
}

const UPDATE_FILES = ['app-update.yml', 'dev-app-update.yml']
const UPDATE_PLIST_KEYS = ['SUFeedURL', 'SUPublicEDKey', 'SUPublicDSAKeyFile', 'SUEnableAutomaticChecks', 'SUScheduledCheckInterval']

/** What is wrong with the bundle's resources: an updater's feed file or keys, or a notarisation ticket. */
export function auditResources(resourceNames: readonly string[], plistKeys: readonly string[], contentsNames: readonly string[]): string[] {
  const problems: string[] = []
  for (const f of UPDATE_FILES) if (resourceNames.includes(f)) problems.push(`Contents/Resources/${f} is an update feed: Kea has none`)
  for (const k of UPDATE_PLIST_KEYS) if (plistKeys.includes(k)) problems.push(`Info.plist has ${k}, an updater's key: Kea has no auto-update`)
  if (contentsNames.includes('CodeResources')) problems.push('Contents/CodeResources is a stapled notarisation ticket: Kea is not notarised')
  return problems
}

export interface AppAudit {
  problems: string[]
  /** What was looked at, for the build's summary. */
  summary: string
  /** The archive's unpacked native modules. */
  nativeModules: string[]
}

/** Run every check above on the packaged app at `app`. `plistKeys`: the keys of its Info.plist. */
export function auditApp(app: string, plistKeys: readonly string[]): AppAudit {
  return auditResourcesFolder(path.join(app, 'Contents', 'Resources'), { plistKeys, contentsNames: fs.readdirSync(path.join(app, 'Contents')) })
}

/**
 * The same checks on an app's resources folder on either system: `bundle` adds a macOS bundle's Info.plist
 * keys and the names in its `Contents`; null on Linux, which has neither.
 */
export function auditResourcesFolder(resources: string, bundle: { plistKeys: readonly string[]; contentsNames: readonly string[] } | null): AppAudit {
  const asar = path.join(resources, 'app.asar')
  const entries = asarEntries(asar)
  const problems = [...auditEntries(entries, `${asar}.unpacked`), ...auditResources(fs.readdirSync(resources), bundle?.plistKeys ?? [], bundle?.contentsNames ?? [])]
  let scanned = 0
  for (const b of NODE_BUNDLES) {
    const text = asarFile(asar, b, entries)?.toString('utf8')
    if (text === undefined) continue
    scanned++
    problems.push(...auditNodeBundle(b, text))
    if (b === 'main.cjs') problems.push(...auditCsp(text))
  }
  const page = asarFile(asar, 'renderer/index.html', entries)?.toString('utf8')
  if (page === undefined) problems.push('app.asar has no renderer/index.html')
  else problems.push(...auditPage(page))
  const nativeModules = entries.filter((e) => e.unpacked && e.name.endsWith('.node')).map((e) => e.name)
  return { problems, summary: `no update feed, crash reporter or network client in ${scanned} Node-side bundles; the window's Content-Security-Policy is set; ${nativeModules.length} native module(s) unpacked`, nativeModules }
}

/** Whether the packaged app at `app` runs code that names `needle` (its Node-side bundles); null when that cannot be read. */
export function appCodeNames(app: string, needle: string): boolean | null {
  try {
    const asar = path.join(app, 'Contents', 'Resources', 'app.asar')
    const entries = asarEntries(asar)
    let read = 0
    for (const b of NODE_BUNDLES) {
      const text = asarFile(asar, b, entries)
      if (!text) continue
      read++
      if (text.includes(needle)) return true
    }
    return read > 0 ? false : null
  } catch {
    return null
  }
}

/**
 * Whether the install shows the first-prune notice: the build being installed prunes and the installed one, at
 * `installed`, does not. Read from the prune's own words in the installed code (`PRUNE_MARK`), not from the setting's
 * name, which older builds declared without a prune; an installed app that cannot be read gets the notice. False with
 * nothing installed.
 */
export function firstPruneDue(installed: string | null, prunes: boolean): boolean {
  return installed !== null && prunes && appCodeNames(installed, PRUNE_MARK) !== true
}

// ── a run's net log ─────────────────────────────────────────────────────────────────────────────────

/** Net log sources that mean something left, or tried to leave, the process: a request, a name lookup, a connection. */
const NETWORK_SOURCE = /REQUEST|SOCKET|CONNECT|RESOLVER|DNS|STREAM|SESSION$|PROXY|TRANSACTION|DOWNLOAD|CERT_VERIFIER/
const REMOTE_URL = /^(?:https?|wss?|ftp):/i

export interface NetLogAudit {
  /** Events in the log (0 means the log says nothing: the switch was not honoured). */
  events: number
  /** One line per request, lookup or connection the log holds, or why the log proves nothing. */
  problems: string[]
}

/**
 * What Chromium's own record of a run (`--log-net-log=<file>`) says Kea asked of the network: nothing, for a Kea that
 * makes no request of its own. It covers everything that goes through Chromium's network service (the window,
 * Electron's `net`, an updater or crash uploader built on it); Node-side sockets are `auditNodeBundle`'s. A log cut
 * short (Kea killed) is read as far as it goes.
 */
export function auditNetLog(text: string): NetLogAudit {
  type Log = { constants?: { logSourceType?: Record<string, number>; logEventTypes?: Record<string, number> }; events?: { type: number; source?: { type: number }; params?: Record<string, unknown> }[] }
  let log: Log | null = null
  for (const candidate of [text, `${text.trimEnd().replace(/,$/, '')}]}`]) {
    try {
      log = JSON.parse(candidate) as Log
      break
    } catch {
      // not whole: try it closed
    }
  }
  const sources = log?.constants?.logSourceType
  const types = log?.constants?.logEventTypes
  if (!log || !sources || !types || !Array.isArray(log.events)) return { events: 0, problems: ['the net log cannot be read'] }
  if (log.events.length === 0) return { events: 0, problems: ['the net log holds no event: it proves nothing'] }
  const nameOf = (map: Record<string, number>) => new Map(Object.entries(map).map(([k, v]) => [v, k]))
  const sourceName = nameOf(sources)
  const typeName = nameOf(types)
  const problems = new Set<string>()
  for (const e of log.events) {
    const source = sourceName.get(e.source?.type ?? -1) ?? `source ${e.source?.type}`
    const what = typeName.get(e.type) ?? `event ${e.type}`
    const named = ['url', 'original_url', 'host', 'hostname', 'group_id', 'address'].flatMap((k) => (typeof e.params?.[k] === 'string' ? [e.params[k] as string] : []))
    if (NETWORK_SOURCE.test(source)) problems.add(`${source}: ${what}${named.length ? ` ${named[0]}` : ''}`)
    else for (const n of named) if (REMOTE_URL.test(n)) problems.add(`${source}: ${what} ${n}`)
  }
  return { events: log.events.length, problems: [...problems].sort() }
}
