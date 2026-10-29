// The file system calls core makes on paths inside a session's folder. Core runs as an Electron utility process, whose
// `node:fs` is patched for Electron's archives: its `lstat` and `stat` take a `*.asar` file for a folder. Electron's
// `original-fs` is the same module without the patch, so a session's `app.asar` is the file the listing says it is.
// Outside Electron (Node, the tests) it is `node:fs`. The stat of the session's folder itself, and reads through a
// handle already open, need neither.

import fs from 'node:fs'
import { createRequire } from 'node:module'

export type FsModule = typeof fs

/**
 * Which `fs` to use: `original-fs` where `versions` says Electron runs this, loaded through `load` (a bundle's
 * `require`, which esbuild leaves alone); `node:fs` otherwise, or when it cannot be loaded.
 */
export function chooseFs(versions: Readonly<Record<string, string | undefined>>, load: (id: string) => unknown): FsModule {
  if (!versions.electron) return fs
  try {
    const plain = load('original-fs') as FsModule | undefined
    return plain && typeof plain.promises?.lstat === 'function' ? plain : fs
  } catch {
    return fs
  }
}

// `__filename` is the bundle (core.cjs) when core runs bundled, where `import.meta` is empty; under Node's type
// stripping it is undefined and `import.meta.url` names this file
const load = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

/** The `fs` for paths inside a session's folder. */
export const sessionFs: FsModule = chooseFs(process.versions, load)
