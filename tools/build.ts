// `pnpm build`: bundle every process into dist/app (the directory Electron runs, and the one packaging ships).
//   main.cjs, core.cjs, ptyhost.cjs  esbuild, CommonJS for Node 24 (electron and native modules external)
//   preload.cjs                      esbuild, CommonJS: a sandboxed preload cannot be an ES module
//   renderer/                        Vite (app/renderer/vite.config.ts)
// CommonJS everywhere keeps utility processes and the preload on Electron's best-trodden path; sources stay ESM.
//   native_modules/<name>/           the runtime files of core's native packages: esbuild leaves them out of
//                                    core.cjs, which loads them from here; packaging unpacks the `.node` from the asar
//                                    (tools/pack/src/config.ts). Only lib/, package.json, LICENSE and this platform's
//                                    prebuild ship. A folder of its own, not node_modules/, which electron-builder
//                                    would drop.
//   agent-files/<adapter>/           files an adapter's launches name in argv (Command Code's kea-mod.ts), as they are
// `--release` sets NODE_ENV=production (drops dev-only checks such as the listener-leak warning).
// `--perf-probes` (only via `pnpm kea:install --perf-probes`: test builds, never installed for use) sets
// `__KEA_PERF_PROBES__`, so a packaged main accepts `--kea-perf*` (app/main/src/switches.ts).
// `--svelte-production` compiles the renderer's Svelte without its dev mode, as the installed app has it, and changes
// nothing else (NODE_ENV, Vite's mode and the checks they guard stay the dev build's): the memory suite's build, where
// dev Svelte's error stacks of often-written signals would keep closed views alive. Vitest's NODE_ENV (`test`)
// otherwise gives a test build dev Svelte (app/renderer/vite.config.ts).
// `--packages-out <file>` writes the folders of the npm packages the bundles hold (esbuild's and Vite's inputs, and the
// native packages), for the licences file a package carries (tools/pack/src/licences.ts).
// `--out dist/<name>` builds elsewhere (the chaos and memory suites use dist/test-app-<tag>, so a `pnpm dev` or `pnpm perf`
// rebuilding dist/app never pulls files from under a running test). It must sit two levels below the repo root, as
// dist/app does: a dev main finds the release kea-helper at `../../native/kea-helper/target/release`.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { need } from '../packages/protocol/src/platform.ts'
import { appPackageJson } from './pack/src/appPackage.ts'
import { packOs } from './pack/src/os/index.ts'

const root = path.resolve(import.meta.dirname, '..')
const outArg = process.argv.indexOf('--out')
const out = outArg >= 0 ? path.resolve(root, process.argv[outArg + 1] ?? '') : path.join(root, 'dist', 'app')
if (path.dirname(path.dirname(out)) !== root) throw new Error(`--out must be dist/<name> (two levels below the repo root), got ${out}`)
const release = process.argv.includes('--release')
const perfProbes = process.argv.includes('--perf-probes')
const packagesArg = process.argv.indexOf('--packages-out')
const packagesOut = packagesArg >= 0 ? path.resolve(root, process.argv[packagesArg + 1] ?? '') : null
const svelteProduction = process.argv.includes('--svelte-production')
// app/renderer/vite.config.ts reads it: Vite loads that config in this process
if (svelteProduction) process.env.KEA_SVELTE_PRODUCTION = '1'

type EsbuildApi = { build(o: Record<string, unknown>): Promise<{ warnings: unknown[]; metafile?: { inputs: Record<string, unknown> } }> }
type ViteApi = { build(o: Record<string, unknown>): Promise<unknown> }
const esbuild = createRequire(path.join(root, 'app/main/package.json'))('esbuild') as EsbuildApi
const vite = (await import(createRequire(path.join(root, 'app/renderer/package.json')).resolve('vite'))) as ViteApi

const common = {
  bundle: true,
  format: 'cjs',
  sourcemap: 'linked',
  legalComments: 'none',
  metafile: packagesOut !== null,
  logLevel: 'warning',
  // kit reads import.meta.url only to trim its own frames from leak stacks; in a bundle it is absent, by design
  logOverride: { 'empty-import-meta': 'silent' },
  absWorkingDir: root,
  define: { 'process.env.NODE_ENV': JSON.stringify(release ? 'production' : 'development'), __KEA_PERF_PROBES__: JSON.stringify(perfProbes) },
}
const node = { ...common, platform: 'node', target: 'node24' }
const jsoncEsm = path.join(path.dirname(createRequire(path.join(root, 'app/core/package.json')).resolve('jsonc-parser/package.json')), 'lib/esm/main.js')

/**
 * Core's native packages and the runtime files each needs. `via`: the package is a dependency of that one, not of core,
 * and core loads its `.node` by path (app/core/src/platform/watch/native.ts), so no import is rewritten.
 */
const addons = need(packOs.nativeAddons) // this system's native files (the OS layer's `nativeAddons`)
const NATIVE: { name: string; files: string[]; via?: string; optional?: boolean }[] = [
  { name: 'better-sqlite3', files: ['package.json', 'LICENSE', 'lib', addons.sqlitePrebuild(process.arch)] },
  { name: addons.watcherPackage(process.arch), via: '@parcel/watcher', files: ['package.json', 'LICENSE', 'watcher.node'] },
  // Kea's patched watcher where pnpm built it (both systems): core loads it first, the prebuild when it is missing
  ...(addons.watcherPatchedBuild ? [{ name: '@parcel/watcher', files: [addons.watcherPatchedBuild], optional: true }] : []),
]
const NATIVE_DIR = 'native_modules' // app/core/src/platform/db/native.ts reads the same name
const coreRequire = createRequire(path.join(root, 'app/core/package.json'))
/** Where a native package is installed. */
function nativeDir(n: { name: string; via?: string }): string {
  const from = n.via ? createRequire(coreRequire.resolve(`${n.via}/package.json`)) : coreRequire
  return path.dirname(from.resolve(`${n.name}/package.json`))
}
type Plugin = { name: string; setup(b: { onResolve(o: { filter: RegExp }, cb: (a: { path: string }) => { path: string; external: boolean }): void }): void }
/** `import … from 'better-sqlite3'` in core becomes `require('./native_modules/better-sqlite3/lib/index.js')`. */
const nativeModules: Plugin = {
  name: 'native-modules',
  setup(b) {
    for (const n of NATIVE) {
      if (n.via) continue
      const main = (JSON.parse(fs.readFileSync(coreRequire.resolve(`${n.name}/package.json`), 'utf8')) as { main?: string }).main ?? 'index.js'
      const escaped = n.name.replace(/[.*+?^${}()|[\]\\/]/g, (c) => `\\${c}`)
      b.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: `./${NATIVE_DIR}/${n.name}/${main.replace(/^\.\//, '')}`, external: true }))
    }
  },
}

function copyNativeModules(): void {
  for (const n of NATIVE) {
    const src = nativeDir(n)
    const dst = path.join(out, NATIVE_DIR, n.name)
    for (const f of n.files) {
      if (n.optional && !fs.existsSync(path.join(src, f))) {
        console.warn(`${n.name}: ${f} was not built (pnpm install's patch build); the build carries the prebuild only`)
        continue
      }
      if (!fs.existsSync(path.join(src, f))) throw new Error(`${n.name}: ${f} is missing: core's bundle loads it from ${NATIVE_DIR}/ beside it`)
      fs.cpSync(path.join(src, f), path.join(dst, f), { recursive: true, dereference: true })
    }
  }
}

/**
 * Files an adapter's launches name in argv (its `launchFiles`: Command Code's session mod), shipped as they are beside
 * core.cjs: the adapter reads its own from `agent-files/<adapter id>/` (packages/adapters), and core writes them into
 * KEA_HOME before a launch.
 */
const AGENT_FILES: { adapter: string; source: string }[] = [{ adapter: 'commandcode', source: 'packages/adapters/src/commandcode/kea-mod.ts' }]
function copyAgentFiles(): void {
  for (const f of AGENT_FILES) {
    const dst = path.join(out, 'agent-files', f.adapter, path.basename(f.source))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(path.join(root, f.source), dst)
  }
}

const started = performance.now()
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const built = await Promise.all([
  esbuild.build({ ...node, entryPoints: ['app/main/src/main.ts'], outfile: path.join(out, 'main.cjs'), external: ['electron'] }),
  esbuild.build({ ...common, platform: 'browser', target: 'chrome140', entryPoints: ['app/preload/src/preload.ts'], outfile: path.join(out, 'preload.cjs'), external: ['electron'] }),
  // jsonc-parser's `main` is a UMD build whose require() calls esbuild cannot follow (a bundle without ./impl/*): its ESM build
  esbuild.build({ ...node, entryPoints: ['app/core/src/main.ts'], outfile: path.join(out, 'core.cjs'), external: ['electron', '@parcel/watcher'], plugins: [nativeModules], alias: { 'jsonc-parser': jsoncEsm } }),
  // the finder's worker thread: its own bundle beside core.cjs, which core reads and starts (files/finder.ts)
  esbuild.build({ ...node, entryPoints: ['app/core/src/files/finder-worker.ts'], outfile: path.join(out, 'finder-worker.cjs') }),
  esbuild.build({ ...node, entryPoints: ['app/ptyhost/src/main.ts'], outfile: path.join(out, 'ptyhost.cjs'), external: ['electron'] }),
  vite.build({ configFile: path.join(root, 'app/renderer/vite.config.ts'), logLevel: 'warn', mode: release ? 'production' : 'development', build: { outDir: path.join(out, 'renderer') } }),
])

copyNativeModules()
copyAgentFiles()

if (packagesOut) {
  // every module the bundles were made of (esbuild's inputs are relative to the repo; Vite's chunks list absolute ids)
  const inputs: string[] = []
  for (const r of built) {
    const meta = (r as { metafile?: { inputs: Record<string, unknown> } } | null)?.metafile
    if (meta) inputs.push(...Object.keys(meta.inputs).map((i) => path.resolve(root, i)))
    else for (const o of [r].flat() as { output?: { modules?: Record<string, unknown> }[] }[]) for (const c of o?.output ?? []) inputs.push(...Object.keys(c.modules ?? {}))
  }
  const dirs = new Set(NATIVE.map((n) => fs.realpathSync(nativeDir(n))))
  for (const id of inputs) {
    // the package a module belongs to: the last `node_modules/<name>` (or `@scope/name`) on its path
    const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id.replace(/^\0+/, '').replace(/\?.*$/, ''))
    if (m) dirs.add(fs.realpathSync(m[1] as string))
  }
  fs.writeFileSync(packagesOut, `${JSON.stringify([...dirs].sort(), null, 2)}\n`)
}

const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
// with `desktopName`, the dev build's own app id on Linux (appPackage.ts)
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(appPackageJson(version), null, 2)}\n`)

console.log(`built ${path.relative(root, out)} in ${Math.round(performance.now() - started)} ms${release ? ' (release)' : ''}${perfProbes ? ' (perf probes)' : ''}${svelteProduction ? ' (Svelte production)' : ''}`)
