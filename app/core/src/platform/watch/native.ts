// `@parcel/watcher`'s native binding, loaded directly. The package's JavaScript wrapper only resolves paths and turns
// globs into regular expressions; Kea passes absolute directories and literal ignore paths, never globs, so core talks
// to the binding itself and ships only the `.node` file (tools/build.ts, as for better-sqlite3: `native_modules/`
// beside core.cjs, unpacked from the asar in a packaged app, and signed with it on macOS).
//
// What the binding was measured to do, and this file's callers rely on:
//   · `subscribe` resolves in under a millisecond and crawls nothing; a missing directory rejects.
//   · `ignorePaths` are applied twice: by the kernel (at most L.watchExclusionsMax) and by the watcher's own
//     thread (string prefix).
//   · the callback gets `(err, events)`; a "must be re-scanned" error does not end the stream, any other does.
//   · a callback that throws is a fatal exception in the process: wrap it.
//   · `unsubscribe` needs the same directory, function and ignore paths as the `subscribe` it ends.
//
// On both systems the binding is the one built at install from Kea's patch of `@parcel/watcher` (`keaPatch` says
// so), the prebuild only where that build is missing. Its shared code takes the backend when a watcher is added to it,
// so a subscription made while the process's last one ends is heard, and reports a path made and removed
// within one of its batches as removed. macOS's FSEvents backend is upstream's own.
//
// On Linux: inotify, one watch per directory, the tree walked on the backend's thread. The patched `subscribe`
// resolves with the entries the tree holds, rejects at once when the backend cannot start, and reports an
// overflow as "must be re-scanned" and new directories with what they hold. With the prebuild the watch service
// guards its first subscription (watcher.ts). Every call names the `inotify` backend (the default would look for
// watchman by starting a child).

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { isAvailable } from '@kea/protocol'
import { coreOs } from '../../os/index.ts'
import { NATIVE_MODULES_DIR } from '../db/native.ts'

export type NativeEventType = 'create' | 'update' | 'delete'
export interface NativeEvent {
  path: string
  type: NativeEventType
}
export type NativeCallback = (err: Error | null, events: NativeEvent[]) => void
export interface NativeOptions {
  ignorePaths: string[]
  /** The backend named (the OS layer's `watcher.backend`; absent: the binding's default, FSEvents on macOS). */
  backend?: string
}

/** The binding's calls Kea uses. Tests pass their own (a start that hangs, an injected error, the prebuild on Linux). */
export interface NativeWatcher {
  /** Resolves with the entries the subscribed tree holds where the binding reports them (Kea's patch), else null. */
  subscribe(dir: string, fn: NativeCallback, opts: NativeOptions): Promise<unknown>
  unsubscribe(dir: string, fn: NativeCallback, opts: NativeOptions): Promise<unknown>
  /** The revision of Kea's patch the binding was built from; absent for a prebuild. */
  readonly keaPatch?: unknown
}

/** Built from Kea's patch: it rejects when its backend cannot start, and frees the watches of a subscribe that failed. */
export function isPatched(native: NativeWatcher): boolean {
  return typeof native.keaPatch === 'number'
}

const OS_WATCHER = isAvailable(coreOs.watcher) ? coreOs.watcher : null
/** The binding package of this system and architecture (the OS layer's `watcher`); null where it has none. */
const PACKAGE = OS_WATCHER ? OS_WATCHER.bindingPackage(process.arch) : null
const BINDING = 'watcher.node'
const PARCEL = '@parcel/watcher'

/** The options of every call for a stream that leaves `ignorePaths` out: the backend too where the system names one. */
export function nativeOptions(ignorePaths: string[]): NativeOptions {
  return OS_WATCHER?.backend ? { ignorePaths, backend: OS_WATCHER.backend } : { ignorePaths }
}

function unpacked(file: string): string {
  const u = file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return u !== file && fs.existsSync(u) ? u : file
}

/**
 * The `.node` to load: the build's copy beside the bundle when core runs bundled, else the installed package's. Where
 * the system builds Kea's patch (both do), the patched build first, in either place; then the prebuild.
 */
export function watcherBindingPath(): string | null {
  if (PACKAGE === null) return null
  const patched = OS_WATCHER?.patchedBuild ?? null
  const bundle = typeof __filename === 'string' ? __filename : null
  if (bundle) {
    const modules = path.join(path.dirname(bundle), NATIVE_MODULES_DIR)
    for (const rel of [...(patched ? [path.join(PARCEL, patched)] : []), path.join(PACKAGE, BINDING)]) {
      const built = unpacked(path.join(modules, rel))
      if (fs.existsSync(built)) return built
    }
  }
  try {
    const req = createRequire(bundle ?? import.meta.url)
    const parcel = req.resolve(PARCEL)
    if (patched) {
      const file = path.join(path.dirname(parcel), patched)
      if (fs.existsSync(file)) return file
    }
    // the binding package is a dependency of `@parcel/watcher`, not of core: resolve it from there
    const file = path.join(path.dirname(createRequire(parcel).resolve(`${PACKAGE}/package.json`)), BINDING)
    return fs.existsSync(file) ? file : null
  } catch {
    return null
  }
}

/** The prebuilt binding, without Kea's patch (tests: Linux's interim guard); null where there is none. */
export function prebuiltBindingPath(): string | null {
  if (PACKAGE === null) return null
  try {
    const parcel = createRequire(import.meta.url).resolve(PARCEL)
    const file = path.join(path.dirname(createRequire(parcel).resolve(`${PACKAGE}/package.json`)), BINDING)
    return fs.existsSync(file) ? file : null
  } catch {
    return null
  }
}

/** Load the binding at `file` (tests: the prebuild beside the patched one). */
export function loadBindingAt(file: string): NativeWatcher {
  const binding = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)(file) as Partial<NativeWatcher>
  if (typeof binding.subscribe !== 'function' || typeof binding.unsubscribe !== 'function') throw new Error(`${file} is not the watcher binding`)
  return binding as NativeWatcher
}

let loaded: NativeWatcher | null = null

/** The binding, loaded on first use. Throws when it is missing or does not load: the caller falls back to polling. */
export function loadNativeWatcher(): NativeWatcher {
  if (loaded) return loaded
  const file = watcherBindingPath()
  if (!file) throw new Error(`${PACKAGE} is not installed`)
  loaded = loadBindingAt(file)
  return loaded
}

/** The watcher lost events for this stream, which keeps running: everything below the root may have changed. */
export function isMustRescan(err: Error): boolean {
  return /must be re-?scanned/i.test(err.message)
}
