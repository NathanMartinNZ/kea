// Where sockets live. A socket path must fit L.socketPathMaxBytes, macOS's limit (104 bytes with the NUL,
// within Linux's 108), so when `<home>/run/<ptyId>.sock` would not fit, sockets go to `<runtime>/kea/<fnv1a64(home)>`
// when the system offers the user a runtime folder (Linux's `$XDG_RUNTIME_DIR`) and that fits, else to
// `/tmp/kea-<uid>/<fnv1a64(home)>`.
// Implemented identically in native/kea-helper (Rust); golden cases in fixtures/protocol/holder-golden.json (`runDir`).

import fs from 'node:fs'
import { L } from '@kea/protocol/limits'
import { fnv1a64 } from './fnv.ts'
import { ensurePrivateDir, UnsafePathError } from './privateDir.ts'
import { kitOs } from './os/index.ts'

export { ensurePrivateDir, fnv1a64, UnsafePathError }

/** The longest socket path Kea will create under `dir`: `<dir>/` + ptyId + `.sock`. */
function socketPathBytes(dir: string): number {
  return Buffer.byteLength(`${dir}/`) + L.ptyIdLength + Buffer.byteLength('.sock')
}

/**
 * The socket directory for `home` (KEA_HOME, absolute, no trailing slash): `<home>/run` when a socket path in it fits
 * L.socketPathMaxBytes, else `<runtime>/kea/<fnv1a64(home)>` when that fits (`runtime`: the user's own runtime folder,
 * by default the OS layer's), else `/tmp/kea-<uid>/<fnv1a64(home)>`.
 */
export function runDir(home: string, uid: number = process.getuid?.() ?? 0, runtime: string | null = kitOs.runtimeDir.dir()): string {
  const preferred = `${home}/run`
  if (socketPathBytes(preferred) <= L.socketPathMaxBytes) return preferred
  const hash = fnv1a64(home)
  const own = runtime === null ? null : `${runtime.replace(/\/+$/, '')}/kea/${hash}`
  return own !== null && socketPathBytes(own) <= L.socketPathMaxBytes ? own : `/tmp/kea-${uid}/${hash}`
}

/** `<runDir>/<ptyId>.sock`. */
export function socketPath(dir: string, id: string): string {
  return `${dir}/${id}.sock`
}

const myUid = () => process.getuid?.() ?? 0

/** A holder socket Kea may connect to: lstat says a socket (not a symlink to one) owned by this user. */
export function isOwnSocket(sock: string): boolean {
  try {
    const st = fs.lstatSync(sock)
    return st.isSocket() && st.uid === myUid()
  } catch {
    return false
  }
}
