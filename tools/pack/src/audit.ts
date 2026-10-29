// What a packaged Kea may reach: no crash reporter, no telemetry, and no network client but the two that look for and
// download updates, each held to its own bundle. Checked on the packaged app itself, in the install's verify step, so
// a dependency or a default that brings one in fails the build instead of shipping.
//
// · Node-side code (main, core, ptyhost, the finder's worker, the preload, and on macOS the updater) is bundled: every
//   module it loads is named in a `require("…")`. Each must be on ALLOWED_MODULES, a list without an HTTP, TLS, DNS or
//   datagram client. `node:net` is on it for the unix sockets (holders, the hook socket) and the dev servers' local
//   port probe: what it connects to cannot be read from the bundle, so that stays a review rule.
// · No bundle names an API that phones home (Electron's `autoUpdater` and `crashReporter`, `electron-updater`, a fetch
//   or socket client, a session of its own), but for what one bundle may name for a reason (BUNDLE_RULES): main asks
//   the release feed through a session of its own, and the updater's bundle, which only the macOS app carries, is
//   electron-updater and Squirrel.Mac. The window's code is not scanned: it runs sandboxed under main's
//   Content-Security-Policy (`default-src 'self'`, `connect-src 'self'`), which this audit checks is in the packaged main.
// · Nothing electron-builder or Electron would add for updates is in the bundle: Sparkle's keys in Info.plist, a
//   `node_modules` tree in the asar; `app-update.yml` only in a release's macOS app, naming the release feed (an app
//   from `pnpm kea:install` has none, so its updater never runs). Native modules are unpacked, where their signatures
//   can be read.
// · And once, at run time (C-UPD-1): Chromium's own net log of a packaged Kea's launch, a terminal and a quit holds
//   no request, name lookup or connection (`auditNetLog`).

import fs from 'node:fs'
import path from 'node:path'
import { PRUNE_MARK } from '../../../packages/protocol/src/disk.ts'
import { asarEntries, asarFile, type AsarEntry } from './asar.ts'
import { UPDATE_CONFIG_FILE, updateConfigYml } from './installFiles.ts'

/** The bundles that run with Node's reach on both systems (tools/build.ts). */
export const NODE_BUNDLES = ['main.cjs', 'core.cjs', 'ptyhost.cjs', 'finder-worker.cjs', 'preload.cjs'] as const
/**
 * The bundles only the macOS app carries: the updater (electron-updater and Squirrel.Mac), which main loads when it
 * makes one. Every macOS app has it, `pnpm kea:install`'s too (with no feed, its updater never runs); a Linux app never.
 */
export const MAC_BUNDLES = ['updater.cjs'] as const

const BUILTINS = ['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'fs/promises', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'readline', 'stream', 'string_decoder', 'timers', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib']
/** Every module a Node-side bundle may load: these built-ins (with or without `node:`) and `electron`. */
export const ALLOWED_MODULES: ReadonlySet<string> = new Set(['electron', ...BUILTINS, ...BUILTINS.map((m) => `node:${m}`)])
/** Files a bundle loads from beside itself: core's native packages (tools/build.ts `native_modules/`). */
const SHIPPED_BESIDE = /^\.\/native_modules\//

type Call = 'autoUpdater' | 'crashReporter' | 'feed' | 'electronUpdater' | 'fetch' | 'objectFetch' | 'partition' | 'netRequest' | 'netFetch' | 'xhr' | 'webSocket' | 'eventSource' | 'beacon'

const LOADS = /\b(?:require|import)\(\s*(["'`])([^"'`\n]+)\1\s*\)/g
const PHONES_HOME: readonly { id: Call; what: string; re: RegExp }[] = [
  { id: 'autoUpdater', what: "Electron's autoUpdater", re: /\bautoUpdater\b/ },
  { id: 'crashReporter', what: "Electron's crashReporter", re: /\bcrashReporter\b/ },
  { id: 'feed', what: 'an update feed (setFeedURL / checkForUpdates)', re: /\b(?:setFeedURL|checkForUpdates)\b/ },
  { id: 'electronUpdater', what: 'electron-updater', re: /electron-updater/ },
  { id: 'fetch', what: 'a fetch call', re: /(?<![.\w$])fetch\s*\(/ },
  // a session's fetch, or any other object's (`ses.fetch(`, `session.defaultSession.fetch(`); a class's own method stays
  { id: 'objectFetch', what: "a session's fetch", re: /(?<![\w$.])(?!this\.fetch\b)[\w$]+(?:\??\.[\w$]+)*\??\.fetch\s*\(/ },
  { id: 'partition', what: 'a session of its own (fromPartition)', re: /\bfromPartition\s*\(/ },
  { id: 'netRequest', what: "Electron's net client (net.request)", re: /\bnet\.request\s*\(/ },
  { id: 'netFetch', what: "Electron's net client (net.fetch)", re: /\bnet\.fetch\s*\(/ },
  { id: 'xhr', what: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { id: 'webSocket', what: 'a WebSocket', re: /\bnew\s+WebSocket\b/ },
  { id: 'eventSource', what: 'an EventSource', re: /\bnew\s+EventSource\b/ },
  { id: 'beacon', what: 'sendBeacon', re: /\bsendBeacon\b/ },
]

/**
 * What one bundle may name or load that the others may not, each for a reason. main.cjs asks the release feed for its
 * `SHA256SUMS` through a session of its own (`fromPartition`, the session's fetch), which its request filter holds to
 * GitHub. updater.cjs is electron-updater's MacUpdater and Squirrel.Mac, which main drives once it has found an update:
 * it names Electron's autoUpdater and the feed's calls, makes the session electron-updater requests through, downloads
 * with Electron's net.request, and loads `http` for the server on 127.0.0.1 that hands Squirrel.Mac the downloaded zip.
 * It must not carry graceful-fs's patch of the process's fs (tools/build.ts gives it Node's own fs instead), nor Kea's
 * kit, whose second copy would keep a resource registry of its own (main hands the updater all it needs), nor what
 * Kea's patch of electron-updater takes out: the children MacUpdater would start, the id AppUpdater would send.
 */
const BUNDLE_RULES: Readonly<Record<string, { names: readonly Call[]; loads: readonly string[]; never?: readonly { what: string; re: RegExp }[] }>> = {
  'main.cjs': { names: ['objectFetch', 'partition'], loads: [] },
  'updater.cjs': {
    names: ['autoUpdater', 'feed', 'electronUpdater', 'netRequest', 'partition'],
    loads: ['http'],
    never: [
      { what: "graceful-fs's patch of the process's fs", re: /graceful-fs\.queue|\bgracefulQueue\b/ },
      { what: "Kea's kit (its resource registry)", re: /\bcreateResourceRegistry/ },
      // what Kea's patch of electron-updater takes out (patches/): a child of its own, an identifier sent with a check
      { what: 'a child process (Kea starts children only through its own runner)', re: /\brequire\(\s*["'](?:node:)?child_process["']\s*\)/ },
      { what: "electron-updater's staging id", re: /x-user-staging-id|stagingUserIdPromise\.value/ },
    ],
  },
}

/** What is wrong with the Node-side bundle `name`: a module off the list, or a name that phones home, beyond what `name` may. */
export function auditNodeBundle(name: string, text: string): string[] {
  const rules = BUNDLE_RULES[name]
  const problems: string[] = []
  const off = new Set<string>()
  for (const m of text.matchAll(LOADS)) {
    const mod = m[2] as string
    if (!ALLOWED_MODULES.has(mod) && !SHIPPED_BESIDE.test(mod) && !rules?.loads.includes(mod)) off.add(mod)
  }
  for (const mod of [...off].sort()) problems.push(`${name} loads "${mod}", which is not on the list of modules a packaged Kea may load (tools/pack/src/audit.ts)`)
  for (const p of PHONES_HOME) if (!rules?.names.includes(p.id) && p.re.test(text)) problems.push(`${name} names ${p.what}: only the update check and the macOS updater reach the network, each from its own bundle (tools/pack/src/audit.ts)`)
  for (const n of rules?.never ?? []) if (n.re.test(text)) problems.push(`${name} carries ${n.what} (tools/pack/src/audit.ts)`)
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

/** What is wrong with the macOS-only bundles in an archive: missing from a macOS app (`mac`), or there in a Linux one. */
export function auditMacBundles(entries: readonly AsarEntry[], mac: boolean): string[] {
  const problems: string[] = []
  for (const b of MAC_BUNDLES) {
    const has = entries.some((e) => e.name === b)
    if (mac && !has) problems.push(`app.asar has no ${b}: every macOS app carries the updater`)
    if (!mac && has) problems.push(`app.asar holds ${b}, the macOS updater: Linux's packages leave it out (tools/pack/src/config.ts)`)
  }
  return problems
}

const UPDATE_FILES = [UPDATE_CONFIG_FILE, 'dev-app-update.yml']
const UPDATE_PLIST_KEYS = ['SUFeedURL', 'SUPublicEDKey', 'SUPublicDSAKeyFile', 'SUEnableAutomaticChecks', 'SUScheduledCheckInterval']

/**
 * What is wrong with the bundle's resources: an update feed file where none belongs, Sparkle's keys, or a notarisation
 * ticket. `feed`: the release feed a release's macOS app names in `app-update.yml` (then `auditFeed` checks that
 * file), or null for an app that carries none.
 */
export function auditResources(resourceNames: readonly string[], plistKeys: readonly string[], contentsNames: readonly string[], feed: string | null = null): string[] {
  const problems: string[] = []
  for (const f of UPDATE_FILES) if (resourceNames.includes(f) && !(f === UPDATE_CONFIG_FILE && feed !== null)) problems.push(`Contents/Resources/${f} is an update feed: only a release's macOS app carries one`)
  for (const k of UPDATE_PLIST_KEYS) if (plistKeys.includes(k)) problems.push(`Info.plist has ${k}, Sparkle's key: Kea's macOS updater is Squirrel.Mac, which reads none`)
  if (contentsNames.includes('CodeResources')) problems.push('Contents/CodeResources is a stapled notarisation ticket: Kea is not notarised')
  return problems
}

/**
 * What is wrong with a release's macOS app's `app-update.yml` (`yml`, null when missing): it names `feed` exactly as
 * tools/pack/src/installFiles.ts writes it. electron-updater reads its cache folder from that file even with the feed set
 * in code, so without it the updater cannot download. Nothing to check when `feed` is null (auditResources refuses the file).
 */
export function auditFeed(yml: string | null, feed: string | null): string[] {
  if (feed === null) return []
  if (yml === null) return [`Contents/Resources/${UPDATE_CONFIG_FILE} is missing: the updater reads its cache folder from it`]
  return yml === updateConfigYml(feed) ? [] : [`Contents/Resources/${UPDATE_CONFIG_FILE} does not name the feed ${feed} as tools/pack/src/installFiles.ts writes it:\n${yml}`]
}

export interface AppAudit {
  problems: string[]
  /** What was looked at, for the build's summary. */
  summary: string
  /** The archive's unpacked native modules. */
  nativeModules: string[]
}

/**
 * Run every check above on the packaged macOS app at `app`. `plistKeys`: the keys of its Info.plist; `feed`: the release
 * feed its `app-update.yml` must name (`pnpm package`), or null for an app that carries none (`pnpm kea:install`).
 */
export function auditApp(app: string, plistKeys: readonly string[], feed: string | null): AppAudit {
  return auditResourcesFolder(path.join(app, 'Contents', 'Resources'), { plistKeys, contentsNames: fs.readdirSync(path.join(app, 'Contents')), feed })
}

/**
 * The same checks on an app's resources folder on either system: `bundle` adds a macOS bundle's Info.plist keys, the
 * names in its `Contents` and the feed it names (null for none), and the macOS-only bundles; null on Linux, which has
 * none of them.
 */
export function auditResourcesFolder(resources: string, bundle: { plistKeys: readonly string[]; contentsNames: readonly string[]; feed: string | null } | null): AppAudit {
  const asar = path.join(resources, 'app.asar')
  const entries = asarEntries(asar)
  const feed = bundle?.feed ?? null
  const names = fs.readdirSync(resources)
  const yml = names.includes(UPDATE_CONFIG_FILE) ? fs.readFileSync(path.join(resources, UPDATE_CONFIG_FILE), 'utf8') : null
  const problems = [...auditEntries(entries, `${asar}.unpacked`), ...auditMacBundles(entries, bundle !== null), ...auditResources(names, bundle?.plistKeys ?? [], bundle?.contentsNames ?? [], feed), ...auditFeed(yml, feed)]
  let scanned = 0
  for (const b of [...NODE_BUNDLES, ...(bundle !== null ? MAC_BUNDLES : [])]) {
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
  const reach = feed === null ? 'no update feed, crash reporter or network client' : `the update feed ${feed}; no crash reporter or network client`
  return { problems, summary: `${reach} in ${scanned} Node-side bundles beyond each one's own allowance; the window's Content-Security-Policy is set; ${nativeModules.length} native module(s) unpacked`, nativeModules }
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
 * What Chromium's own record of a run (`--log-net-log=<file>`) says Kea asked of the network: nothing, for a run
 * that checks for no update (the check is Kea's one request of its own). It covers everything that goes through
 * Chromium's network service (the window, Electron's `net`, an updater or crash uploader built on it); Node-side
 * sockets are `auditNodeBundle`'s. A log cut short (Kea killed) is read as far as it goes.
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
