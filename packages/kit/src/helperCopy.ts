// A build's own copy of kea-helper under Kea's home, `<KEA_HOME>/bin/<version>-<hash>/kea-helper`: named after the Kea
// version and a hash of the binary, so an update never replaces an executable something still runs and a rebuilt
// helper is never taken for an earlier build's copy. Main makes this run's copy at start; core finds it in place.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The executable every copy holds. */
const HELPER_EXECUTABLE = 'kea-helper'

/**
 * The folder name of a build's helper copy: the Kea version and a hash of the binary, so a rebuilt helper is never
 * taken for an earlier build's copy with the same version.
 */
export function helperCopyName(source: string, keaVersion: string): string {
  return `${keaVersion}-${createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 12)}`
}

/** `<home>/bin/<version>-<sha256(binary)[:12]>/kea-helper`, copied there from `source` if absent; returns its path. */
export function installHookHelper(source: string, home: string, keaVersion: string): string {
  const dir = path.join(home, 'bin', helperCopyName(source, keaVersion))
  const dest = path.join(dir, HELPER_EXECUTABLE)
  if (fs.existsSync(dest)) return dest
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${dest}.${process.pid}.tmp`
  fs.copyFileSync(source, tmp)
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, dest)
  return dest
}
