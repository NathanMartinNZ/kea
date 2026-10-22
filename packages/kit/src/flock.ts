// One instance per KEA_HOME: core and ptyhost each hold an exclusive lock on `<KEA_HOME>/run/core.lock` /
// `ptyhost.lock` and exit if it is taken. The lock is the OS layer's `instanceLock` (os/; a `flock` on the file: on
// macOS taken atomically at open, on Linux through util-linux's `flock` on this process's own descriptor) and lives as
// long as the process holds it: it is released when the holder disposes it or dies, however it dies.

import { need } from '@kea/protocol/platform'
import type { Disposable } from './disposable.ts'
import { kitOs } from './os/index.ts'

/**
 * Take an exclusive, non-blocking lock on `path` (created 0600 if missing). Returns a Disposable
 * that releases it, or null when another open file description — this process or another — holds
 * it. On macOS the holder's pid is written into the file for diagnostics; on Linux it stays empty.
 */
export function tryLock(path: string): Disposable | null {
  return need(kitOs.instanceLock).tryLock(path)
}
