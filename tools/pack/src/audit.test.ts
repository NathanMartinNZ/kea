import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { asarEntries, asarFile } from './asar.ts'
import { PRUNE_MARK } from '../../../packages/protocol/src/disk.ts'
import { ALLOWED_MODULES, appCodeNames, firstPruneDue, auditApp, auditCsp, auditEntries, auditFeed, auditMacBundles, auditNetLog, auditNodeBundle, auditPage, auditResources, auditResourcesFolder, MAC_BUNDLES, NODE_BUNDLES } from './audit.ts'
import { updateConfigYml } from './installFiles.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type Tree = { [name: string]: Tree | string | { unpacked: string } }

/** Write an asar archive (the layout asar.ts reads) from a tree of text files; `{ unpacked }` files go beside it. */
function writeAsar(file: string, tree: Tree): void {
  const chunks: Buffer[] = []
  let offset = 0
  const node = (t: Tree, dir: string): Record<string, unknown> => {
    const files: Record<string, unknown> = {}
    for (const [name, v] of Object.entries(t)) {
      if (typeof v === 'string') {
        const b = Buffer.from(v, 'utf8')
        files[name] = { size: b.length, offset: String(offset) }
        chunks.push(b)
        offset += b.length
      } else if (typeof v.unpacked === 'string') {
        files[name] = { size: Buffer.byteLength(v.unpacked), unpacked: true }
        fs.mkdirSync(path.join(`${file}.unpacked`, dir), { recursive: true })
        fs.writeFileSync(path.join(`${file}.unpacked`, dir, name), v.unpacked)
      } else files[name] = node(v as Tree, path.join(dir, name))
    }
    return { files }
  }
  const json = Buffer.from(JSON.stringify(node(tree, '')), 'utf8')
  const padded = Math.ceil(json.length / 4) * 4
  const head = Buffer.alloc(16 + padded)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(8 + padded, 4) // the header: its payload size, the JSON's length, the JSON padded to 4 bytes
  head.writeUInt32LE(4 + padded, 8)
  head.writeUInt32LE(json.length, 12)
  json.copy(head, 16)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([head, ...chunks]))
}

const CSP = `const CSP = ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'"].join('; ')`
const CLEAN: Tree = {
  'main.cjs': `const fs = require("node:fs"); const e = require("electron");\n${CSP}`,
  'core.cjs': 'const net = require("node:net"); const db = require("./native_modules/better-sqlite3/lib/index.js"); const s = "general.pruneArchivedBuildDirsDays"',
  'ptyhost.cjs': 'require("node:child_process")',
  'finder-worker.cjs': 'require("node:worker_threads")',
  'preload.cjs': 'require("electron")',
  'package.json': '{"name":"kea"}',
  renderer: { 'index.html': '<script type="module" src="./assets/index.js"></script>' },
  native_modules: { 'better-sqlite3': { prebuilds: { 'darwin-arm64.node': { unpacked: 'mach-o' } } } },
}
/** What the macOS updater's bundle names: Electron's updater, the feed's calls, its session, net.request, and http for its local server. */
const UPDATER = 'const e = require("electron"), h = require("http"); e.autoUpdater.setFeedURL(o); u.checkForUpdates(); const p = "electron-updater"; e.session.fromPartition(p, { cache: false }); e.net.request(r); h.createServer()'
/** A macOS app's archive: the updater's bundle beside the rest. */
const MAC_CLEAN: Tree = { ...CLEAN, 'updater.cjs': UPDATER }
const FEED = 'https://github.com/some-owner/kea/releases/latest/download/'

function fakeApp(tree: Tree, o: { resources?: string[]; files?: Record<string, string> } = {}): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-pack-test-')))
  dirs.push(tmp)
  const app = path.join(tmp, 'Kea.app')
  writeAsar(path.join(app, 'Contents', 'Resources', 'app.asar'), tree)
  for (const r of o.resources ?? []) fs.writeFileSync(path.join(app, 'Contents', 'Resources', r), '')
  for (const [name, text] of Object.entries(o.files ?? {})) fs.writeFileSync(path.join(app, 'Contents', 'Resources', name), text)
  return app
}

describe('reading an app.asar (tools/pack/src/asar.ts)', () => {
  it('U-PACK-16 · the archive lists every file with where its bytes are; an unpacked file has none, and its bytes are beside the archive', () => {
    const app = fakeApp(CLEAN)
    const asar = path.join(app, 'Contents', 'Resources', 'app.asar')
    const entries = asarEntries(asar)
    expect(entries.map((e) => e.name).sort()).toEqual(['core.cjs', 'finder-worker.cjs', 'main.cjs', 'native_modules/better-sqlite3/prebuilds/darwin-arm64.node', 'package.json', 'preload.cjs', 'ptyhost.cjs', 'renderer/index.html'])
    expect(asarFile(asar, 'package.json')?.toString()).toBe('{"name":"kea"}')
    expect(asarFile(asar, 'renderer/index.html', entries)?.toString()).toMatch(/assets\/index\.js/)
    expect(entries.find((e) => e.name.endsWith('.node'))).toMatchObject({ unpacked: true, at: null, size: 6 })
    expect(asarFile(asar, 'native_modules/better-sqlite3/prebuilds/darwin-arm64.node')).toBeNull()
    expect(asarFile(asar, 'no-such-file')).toBeNull()
    fs.writeFileSync(asar, 'not an archive at all')
    expect(() => asarEntries(asar)).toThrow(/not an asar archive/)
  })
})

describe('what a packaged Kea must not carry (tools/pack/src/audit.ts)', () => {
  it('U-PACK-17 · a Node-side bundle may load only the listed modules, and names no updater, crash reporter or network client', () => {
    expect(auditNodeBundle('core.cjs', 'var a = require("node:fs"), b = require("node:net"), c = require("electron"), d = require("./native_modules/better-sqlite3/lib/index.js")')).toEqual([])
    for (const mod of ['node:http', 'node:https', 'https', 'node:http2', 'node:tls', 'node:dgram', 'node:dns', 'node:inspector', 'electron-updater', 'undici', './somewhere/else.js']) {
      expect(auditNodeBundle('core.cjs', `x = require("${mod}")`)[0], mod).toMatch(new RegExp(`core\\.cjs loads "${mod.replace(/[./]/g, '\\$&')}"`))
      expect(ALLOWED_MODULES.has(mod)).toBe(false)
    }
    expect(auditNodeBundle('main.cjs', "const m = await import('node:https')")).toHaveLength(1)
    const names: [string, RegExp][] = [
      ['import_electron.autoUpdater.checkForUpdates()', /autoUpdater/],
      ['import_electron.crashReporter.start({ submitURL })', /crashReporter/],
      ['updater.setFeedURL(u)', /update feed/],
      ['const r = await fetch(url)', /fetch call/],
      ['globalThis.x = fetch (u)', /fetch call/],
      ['import_electron.net.request(u)', /net client/],
      ['new XMLHttpRequest()', /XMLHttpRequest/],
      ['new WebSocket(u)', /WebSocket/],
      ['navigator.sendBeacon(u)', /sendBeacon/],
    ]
    for (const [code, what] of names) expect(auditNodeBundle('main.cjs', code).join('\n'), code).toMatch(what)
    // what Kea's own code does say: a git fetch, a method called fetch, the word in a sentence
    expect(auditNodeBundle('core.cjs', 'await git(["fetch", remote]); this.fetch(x); prefetch(y); "could not fetch the branch"')).toEqual([])
    expect(auditCsp(CSP)).toEqual([])
    expect(auditCsp("const CSP = \"default-src 'self'\"")).toHaveLength(1)
    expect(auditPage('<link rel="stylesheet" href="./assets/a.css"><script src="./assets/index.js"></script>')).toEqual([])
    expect(auditPage('<script src="https://cdn.example/x.js"></script><link href=//fonts.example/f.css>')).toHaveLength(2)
  })

  it('U-PACK-18 · the bundle holds no update feed, no updater keys, no notarisation ticket, no node_modules tree, and its native modules are unpacked', () => {
    expect(auditResources(['app.asar', 'app.asar.unpacked', 'kea-helper', 'electron.icns'], ['CFBundleIdentifier', 'ElectronAsarIntegrity'], ['Info.plist', 'MacOS', 'Resources', 'Frameworks', '_CodeSignature'])).toEqual([])
    expect(auditResources(['app.asar', 'app-update.yml'], ['SUFeedURL'], ['CodeResources']).join('\n')).toMatch(/app-update\.yml is an update feed[\s\S]*SUFeedURL[\s\S]*notarisation ticket/)
    const app = fakeApp(MAC_CLEAN)
    const ok = auditApp(app, ['CFBundleIdentifier'], null)
    expect(ok.problems).toEqual([])
    expect(ok.nativeModules).toEqual(['native_modules/better-sqlite3/prebuilds/darwin-arm64.node'])
    expect(ok.summary).toMatch(/no update feed, crash reporter or network client in 6 Node-side bundles/)

    const bad = fakeApp(
      {
        ...(Object.fromEntries(Object.entries(CLEAN).filter(([name]) => name !== 'preload.cjs')) as Tree),
        'core.cjs': 'require("node:https"); import_electron.autoUpdater.checkForUpdates()',
        'main.cjs': 'require("electron")',
        node_modules: { 'electron-updater': { 'index.js': 'x' } },
        native_modules: { watcher: { 'watcher.node': 'packed by mistake' } },
        renderer: { 'index.html': '<script src="https://cdn.example/x.js"></script>' },
      },
      { resources: ['app-update.yml'] },
    )
    const problems = auditApp(bad, ['SUFeedURL'], null).problems.join('\n')
    for (const what of [/core\.cjs loads "node:https"/, /autoUpdater/, /Content-Security-Policy part "connect-src 'self'"/, /app\.asar has no preload\.cjs/, /node_modules tree/, /watcher\.node is packed inside app\.asar/, /index\.html loads https:\/\/cdn\.example/, /app-update\.yml/, /SUFeedURL/]) expect(problems).toMatch(what)
    // a native module marked unpacked but missing beside the archive
    const asar = path.join(app, 'Contents', 'Resources', 'app.asar')
    fs.rmSync(`${asar}.unpacked`, { recursive: true })
    expect(auditEntries(asarEntries(asar), `${asar}.unpacked`).join('\n')).toMatch(/marked unpacked but is not in app\.asar\.unpacked/)
  })

  it('U-PACK-19 · whether an installed build has a piece of code is read from its bundles: true, false, or null when it cannot be read', () => {
    const app = fakeApp(CLEAN)
    expect(appCodeNames(app, 'general.pruneArchivedBuildDirsDays')).toBe(true)
    expect(appCodeNames(app, 'no.such.setting')).toBe(false)
    expect(appCodeNames(path.join(app, 'missing'), 'x')).toBeNull()
    expect(appCodeNames(fakeApp({ 'package.json': '{}' }), 'x')).toBeNull()
  })

  it('U-PACK-27 · the first-prune warning is due when the installed build has no prune, read from the prune’s own words in its code, not from its settings table: a build that only declares the setting gets it, one whose code prunes does not, one that cannot be read gets it', () => {
    const declares = fakeApp(CLEAN) // names `general.pruneArchivedBuildDirsDays`, as older builds' settings tables do
    const prunes = fakeApp({ ...CLEAN, 'core.cjs': `${CLEAN['core.cjs'] as string}; const why = \`archived for \${d} days, ${PRUNE_MARK}\`` })
    expect(firstPruneDue(declares, true), 'declares the setting, has no prune').toBe(true)
    expect(firstPruneDue(prunes, true), 'prunes already').toBe(false)
    expect(firstPruneDue(path.join(declares, 'missing'), true), 'cannot be read: warned').toBe(true)
    expect(firstPruneDue(null, true), 'nothing installed').toBe(false)
    expect(firstPruneDue(declares, false), 'the new build does not prune').toBe(false)
  })

  it('U-PACK-49 · what one bundle may name or load for a reason: main a session of its own and its fetch, the macOS updater its own calls, net.request and http; no other bundle any of them', () => {
    const others = NODE_BUNDLES.filter((b) => b !== 'main.cjs')
    // a session's fetch, however it is reached; a class's own fetch method stays allowed everywhere (U-PACK-17)
    for (const code of ['await ses.fetch(url, { redirect: "follow" })', 'import_electron.session.defaultSession.fetch(u)', 'this.ses.fetch(u)', 'ses?.fetch(u)']) {
      expect(auditNodeBundle('main.cjs', code), code).toEqual([])
      for (const b of [...others, ...MAC_BUNDLES]) expect(auditNodeBundle(b, code).join('\n'), `${b}: ${code}`).toMatch(/a session's fetch/)
    }
    const partition = 'import_electron.session.fromPartition("kea-updates", { cache: false })'
    expect(auditNodeBundle('main.cjs', partition)).toEqual([])
    for (const b of others) expect(auditNodeBundle(b, partition).join('\n'), b).toMatch(/fromPartition/)
    // main names no updater and makes no other request
    for (const code of ['import_electron.autoUpdater.on("x", f)', 'u.checkForUpdates()', 'require("electron-updater")', 'import_electron.net.request(u)', 'import_electron.net.fetch(u)', 'require("http")', 'fetch(u)']) expect(auditNodeBundle('main.cjs', code), code).not.toEqual([])

    // the updater: its own calls, its session, net.request, and http for the server Squirrel.Mac downloads from
    expect(auditNodeBundle('updater.cjs', UPDATER)).toEqual([])
    for (const b of NODE_BUNDLES) expect(auditNodeBundle(b, UPDATER).length, `${b} may name none of it`).toBeGreaterThan(0)
    const refused: [string, RegExp][] = [
      ['require("https")', /loads "https"/],
      ['import_electron.net.fetch(u)', /net\.fetch/],
      ['await fetch(u)', /fetch call/],
      ['import_electron.crashReporter.start({})', /crashReporter/],
      ['new WebSocket(u)', /WebSocket/],
      // graceful-fs's patch of the process's fs, a second copy of Kea's kit, and what the patch takes out
      ['var gracefulQueue = Symbol.for("graceful-fs.queue")', /graceful-fs's patch/],
      ['function createResourceRegistry2() {}', /Kea's kit/],
      ['var child_process_1 = require("child_process")', /a child process/],
      ['client.setRequestHeaders({ "x-user-staging-id": id })', /staging id/],
      ['await this.stagingUserIdPromise.value', /staging id/],
    ]
    for (const [code, what] of refused) expect(auditNodeBundle('updater.cjs', code).join('\n'), code).toMatch(what)
  })

  it('U-PACK-50 · every macOS app carries the updater’s bundle and a Linux app none; app-update.yml only in a release’s macOS app, naming the release feed exactly', () => {
    const entries = (app: string) => asarEntries(path.join(app, 'Contents', 'Resources', 'app.asar'))
    expect(auditMacBundles(entries(fakeApp(MAC_CLEAN)), true)).toEqual([])
    expect(auditMacBundles(entries(fakeApp(CLEAN)), true).join('\n')).toMatch(/app\.asar has no updater\.cjs/)
    expect(auditMacBundles(entries(fakeApp(CLEAN)), false)).toEqual([])
    expect(auditMacBundles(entries(fakeApp(MAC_CLEAN)), false).join('\n')).toMatch(/holds updater\.cjs/)

    // `pnpm kea:install`'s app: the updater's code and no feed, so the updater never runs
    const local = fakeApp(MAC_CLEAN)
    expect(auditApp(local, [], null).problems).toEqual([])
    expect(auditApp(local, [], FEED).problems.join('\n')).toMatch(/app-update\.yml is missing/)
    // a release's app: the feed, exactly as tools/pack writes it
    const release = fakeApp(MAC_CLEAN, { files: { 'app-update.yml': updateConfigYml(FEED) } })
    const audit = auditApp(release, [], FEED)
    expect(audit.problems).toEqual([])
    expect(audit.summary).toMatch(new RegExp(`^the update feed ${FEED.replace(/[./]/g, '\\$&')}; no crash reporter or network client in 6 Node-side bundles`))
    expect(auditApp(release, [], null).problems.join('\n')).toMatch(/app-update\.yml is an update feed/)
    expect(auditFeed(updateConfigYml('https://example.invalid/'), FEED).join('\n')).toMatch(/does not name the feed/)
    expect(auditFeed(null, null)).toEqual([])
    // on macOS the updater's bundle is scanned by its own rules
    expect(auditApp(fakeApp({ ...MAC_CLEAN, 'updater.cjs': `${UPDATER}; require("https")` }), [], null).problems.join('\n')).toMatch(/updater\.cjs loads "https"/)

    // a Linux resources folder: no feed and no updater bundle
    expect(auditResourcesFolder(path.join(fakeApp(CLEAN), 'Contents', 'Resources'), null).problems).toEqual([])
    expect(auditResourcesFolder(path.join(release, 'Contents', 'Resources'), null).problems.join('\n')).toMatch(/holds updater\.cjs[\s\S]*app-update\.yml is an update feed/)
  })

  // The patch is per package version (patches/electron-updater@<version>.patch): a new version fails here until its
  // patch is made again.
  it('U-PACK-51 · the electron-updater the macOS updater bundles is Kea’s patched one: MacUpdater starts no child, AppUpdater sends no staging id and offers every update, the local server can be closed', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..')
    const dir = path.dirname(createRequire(path.join(root, 'app/main/package.json')).resolve('electron-updater/package.json'))
    const version = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version
    expect(fs.existsSync(path.join(root, 'patches', `electron-updater@${version}.patch`)), `a patch for electron-updater ${version}`).toBe(true)
    const read = (f: string) => fs.readFileSync(path.join(dir, 'out', f), 'utf8')
    const mac = read('MacUpdater.js')
    expect(mac).not.toMatch(/child_process|execFileSync/)
    const app = read('AppUpdater.js')
    expect(app).not.toMatch(/x-user-staging-id|stagingUserIdPromise\.value/)
    expect(app).toMatch(/async isStagingMatch\(updateInfo\) \{\s*(?:\/\/[^\n]*\s*)?return true;\s*\}/)
    expect(read('MacUpdater.d.ts')).toMatch(/^\s*closeServerIfExists\(\): void;$/m)
  })
})

describe("the app's sources", () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..')
  /** Every source file that ends up in a Node-side bundle or the window: the processes and the libraries they import. */
  function sources(): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|svelte)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/test-support\.ts$/.test(e.name)) out.push(p)
      }
    }
    for (const top of ['app', 'packages']) for (const pkg of fs.readdirSync(path.join(root, top))) if (fs.existsSync(path.join(root, top, pkg, 'src'))) walk(path.join(root, top, pkg, 'src'))
    return out
  }

  // The few files that may name these, each for its bundle's reason (audit.ts BUNDLE_RULES): the macOS updater's entry
  // and its driver (updater.cjs); main's session for the update check, and the request for the release feed through it.
  const MAY_NAME_UPDATER = ['app/main/src/os/squirrel.ts', 'app/main/src/os/squirrelDriver.ts']
  const MAY_MAKE_SESSION = ['app/main/src/main.ts', 'app/main/src/os/squirrel.ts']
  const MAY_FETCH = ['app/main/src/updates/feed.ts']

  it('U-PACK-20 · no source file of the app imports a network module or names an updater or crash reporter, but the few allowed to for their bundle', () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(200)
    const problems: string[] = []
    const IMPORT = /\bfrom\s+['"]((?:node:)?[a-z_/0-9]+)['"]|\bimport\(\s*['"]((?:node:)?[a-z_/0-9]+)['"]\s*\)|\brequire\(\s*['"]((?:node:)?[a-z_/0-9]+)['"]\s*\)/g
    const NETWORK = new Set(['http', 'https', 'http2', 'tls', 'dgram', 'dns', 'inspector'].flatMap((m) => [m, `node:${m}`]))
    for (const f of files) {
      const rel = path.relative(root, f).split(path.sep).join('/')
      const text = fs.readFileSync(f, 'utf8')
      for (const m of text.matchAll(IMPORT)) {
        const mod = (m[1] ?? m[2] ?? m[3]) as string
        if (NETWORK.has(mod)) problems.push(`${rel} imports ${mod}`)
      }
      if (/\bcrashReporter\b/.test(text)) problems.push(`${rel} names a crash reporter`)
      if (/\b(?:autoUpdater|setFeedURL|checkForUpdates)\b|electron-updater/.test(text) && !MAY_NAME_UPDATER.includes(rel)) problems.push(`${rel} names an updater`)
      if (/\bfromPartition\s*\(/.test(text) && !MAY_MAKE_SESSION.includes(rel)) problems.push(`${rel} makes a session of its own`)
      if (/(?<![\w$.])(?!this\.fetch\b)[\w$]+(?:\??\.[\w$]+)*\??\.fetch\s*\(|(?<![.\w$])fetch\s*\(/.test(text) && !MAY_FETCH.includes(rel)) problems.push(`${rel} fetches`)
    }
    expect(problems).toEqual([])
    // the list the packaged audit holds every bundle to has no network module on it
    for (const m of NETWORK) expect(ALLOWED_MODULES.has(m), m).toBe(false)
    expect([...NODE_BUNDLES]).toEqual(['main.cjs', 'core.cjs', 'ptyhost.cjs', 'finder-worker.cjs', 'preload.cjs'])
    expect([...MAC_BUNDLES]).toEqual(['updater.cjs'])
    // the allowed files exist, so the list never names one that moved
    for (const f of new Set([...MAY_NAME_UPDATER, ...MAY_MAKE_SESSION, ...MAY_FETCH])) expect(fs.existsSync(path.join(root, f)), f).toBe(true)
  })
})

describe('a run’s net log', () => {
  /** A net log as Chromium writes it: the constants map names to numbers, each event names its source and type by number. */
  function netLog(events: { source: string; type: string; params?: Record<string, unknown> }[]): string {
    const logSourceType = { NONE: 0, URL_REQUEST: 1, HOST_RESOLVER_IMPL_JOB: 2, SOCKET: 3, COOKIE_STORE: 4, HTTP_SERVER_PROPERTIES: 5, QUIC_SESSION_POOL: 6, NETWORK_QUALITY_ESTIMATOR: 7, TRANSPORT_CONNECT_JOB: 8 }
    const logEventTypes = { REQUEST_ALIVE: 1, URL_REQUEST_START_JOB: 2, HOST_RESOLVER_MANAGER_JOB: 3, SOCKET_ALIVE: 4, COOKIE_STORE_ALIVE: 5, HTTP_SERVER_PROPERTIES_INITIALIZATION: 6, QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS: 7, NETWORK_QUALITY_CHANGED: 8 }
    return JSON.stringify({
      constants: { logSourceType, logEventTypes },
      events: events.map((e, i) => ({ time: String(i), phase: 0, type: logEventTypes[e.type as keyof typeof logEventTypes], source: { id: i, type: logSourceType[e.source as keyof typeof logSourceType] }, ...(e.params ? { params: e.params } : {}) })),
    })
  }
  /** What a packaged Kea's launch, one terminal and a quit leave in the log (taken from a real run: no request at all). */
  const QUIET = [
    { source: 'COOKIE_STORE', type: 'COOKIE_STORE_ALIVE' },
    { source: 'HTTP_SERVER_PROPERTIES', type: 'HTTP_SERVER_PROPERTIES_INITIALIZATION' },
    { source: 'NETWORK_QUALITY_ESTIMATOR', type: 'NETWORK_QUALITY_CHANGED' },
    { source: 'QUIC_SESSION_POOL', type: 'QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS' },
  ]

  it('U-PACK-21 · a net log with no request, lookup or connection passes; each one it holds is named; an empty or unreadable log proves nothing; a log cut short is read as far as it goes', () => {
    expect(auditNetLog(netLog(QUIET))).toEqual({ events: 4, problems: [] })
    const busy = auditNetLog(
      netLog([
        ...QUIET,
        { source: 'URL_REQUEST', type: 'URL_REQUEST_START_JOB', params: { url: 'https://updates.example.invalid/feed.json' } },
        { source: 'URL_REQUEST', type: 'URL_REQUEST_START_JOB', params: { url: 'https://updates.example.invalid/feed.json' } },
        { source: 'HOST_RESOLVER_IMPL_JOB', type: 'HOST_RESOLVER_MANAGER_JOB', params: { host: 'updates.example.invalid:443' } },
        { source: 'TRANSPORT_CONNECT_JOB', type: 'SOCKET_ALIVE' },
        { source: 'SOCKET', type: 'SOCKET_ALIVE' },
        // a source this list does not know, naming a remote address all the same
        { source: 'NONE', type: 'REQUEST_ALIVE', params: { url: 'wss://telemetry.example.invalid/' } },
        // Kea's own scheme is not the network
        { source: 'NONE', type: 'REQUEST_ALIVE', params: { url: 'kea://app/index.html' } },
      ]),
    )
    expect(busy.events).toBe(11)
    expect(busy.problems).toEqual([
      'HOST_RESOLVER_IMPL_JOB: HOST_RESOLVER_MANAGER_JOB updates.example.invalid:443',
      'NONE: REQUEST_ALIVE wss://telemetry.example.invalid/',
      'SOCKET: SOCKET_ALIVE',
      'TRANSPORT_CONNECT_JOB: SOCKET_ALIVE',
      'URL_REQUEST: URL_REQUEST_START_JOB https://updates.example.invalid/feed.json',
    ])
    expect(auditNetLog(netLog([]))).toEqual({ events: 0, problems: ['the net log holds no event: it proves nothing'] })
    for (const junk of ['', 'not json', '{}', '{"constants":{},"events":[]}']) expect(auditNetLog(junk), junk).toEqual({ events: 0, problems: ['the net log cannot be read'] })
    // Kea was killed while it wrote: the list of events is not closed
    const whole = netLog([...QUIET, { source: 'URL_REQUEST', type: 'URL_REQUEST_START_JOB', params: { url: 'http://example.invalid/' } }])
    const cut = `${whole.slice(0, -2)},\n`
    expect(() => JSON.parse(cut)).toThrow()
    expect(auditNetLog(cut)).toEqual({ events: 5, problems: ['URL_REQUEST: URL_REQUEST_START_JOB http://example.invalid/'] })
  })
})
