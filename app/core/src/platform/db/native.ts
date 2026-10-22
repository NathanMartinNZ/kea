// Where better-sqlite3's native addon is loaded from. Under plain Node (tests) it is the package's own
// `prebuilds/<system>-<arch>.node`; in a build (tools/build.ts) the package's runtime files sit beside core.cjs in
// `native_modules/better-sqlite3/`, and in a packaged app the `.node` is unpacked from the asar (`app.asar.unpacked/…`;
// on macOS it is signed with the app). Core logs the path it loaded, so the native smoke check can tell which copy a
// build uses.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { coreOs } from '../../os/index.ts'

/** The runtime files of a native package in a build, relative to the bundle (tools/build.ts writes them). */
export const NATIVE_MODULES_DIR = 'native_modules'
const PREBUILD = path.join('prebuilds', `${coreOs.system}-${process.arch}.node`)

/** In an asar archive, the unpacked copy of `file` when there is one (Electron loads that one for a `.node` anyway). */
function unpacked(file: string): string {
  const u = file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return u !== file && fs.existsSync(u) ? u : file
}

/**
 * The `.node` to load: the build's copy beside the bundle when core runs bundled, else the package's prebuild. Null
 * when neither exists (better-sqlite3 then reports its own error).
 */
export function sqliteBindingPath(): string | null {
  // `__filename` is the bundle (core.cjs) when core runs bundled; under Node's ESM type stripping it is undefined
  const bundle = typeof __filename === 'string' ? __filename : null
  if (bundle) {
    const built = unpacked(path.join(path.dirname(bundle), NATIVE_MODULES_DIR, 'better-sqlite3', PREBUILD))
    if (fs.existsSync(built)) return built
  }
  try {
    const pkg = createRequire(bundle ?? import.meta.url).resolve('better-sqlite3/package.json')
    const file = path.join(path.dirname(pkg), PREBUILD)
    return fs.existsSync(file) ? file : null
  } catch {
    return null
  }
}
