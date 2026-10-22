// What the harnesses read of a process, from `kea-helper procs`: the reader Kea itself and `pnpm kea:install`
// use, so a harness sees a process as core does, on macOS and on Linux. Each look runs a kea-helper this checkout
// built: the newest copy the test harness handed out (`target/test-helper`, never replaced once made), else cargo's
// release or debug build.
//
// Where `/proc` hides holders (`hidepid`) a holder is not listed, so a harness cannot tell it is still that
// process and leaves it alone; the hidepid test's runner (tools/test-hidepid.ts) gives the run its own pid namespace,
// whose end takes them with it.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseProcs, type ProcRow } from '../../../packages/protocol/src/procs.ts'

const TARGET = path.resolve(import.meta.dirname, '../../../native/kea-helper/target')
const PROCS_MAX_BYTES = 64 * 1024 * 1024 // a full listing with every argument
/** A cargo build may be replacing cargo's own output as it starts: a few tries, then the error. */
const ATTEMPTS = 3

/** The kea-helper a look runs (see the top of this file). Throws when this checkout has none built. */
export function procsHelper(): string {
  const copies = path.join(TARGET, 'test-helper')
  let newest: { file: string; mtime: number } | null = null
  for (const build of fs.existsSync(copies) ? fs.readdirSync(copies) : []) {
    const file = path.join(copies, build, 'kea-helper') // tests/support/holders.ts `stableCopy`: <profile>-<hash>/kea-helper
    const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? -1
    if (mtime >= 0 && (newest === null || mtime > newest.mtime)) newest = { file, mtime }
  }
  const found = newest?.file ?? [path.join(TARGET, 'release/kea-helper'), path.join(TARGET, 'debug/kea-helper')].find((f) => fs.existsSync(f))
  if (!found) throw new Error('no kea-helper is built in this checkout: run `pnpm helper:build`')
  return found
}

/** `kea-helper procs`: this user's processes, or only `pids` among them (a pid that is gone has no row). */
export function procs(pids: readonly number[] = [], o: { args?: boolean } = {}): ProcRow[] {
  const argv = ['procs', ...(o.args ? ['--args'] : []), ...pids.map(String)]
  for (let attempt = 1; ; attempt++) {
    try {
      return parseProcs(execFileSync(procsHelper(), argv, { encoding: 'utf8', env: {}, maxBuffer: PROCS_MAX_BYTES, stdio: ['ignore', 'pipe', 'ignore'] }))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if ((code !== 'ENOENT' && code !== 'ETXTBSY') || attempt >= ATTEMPTS) throw e
    }
  }
}

/** One process's row, or null when it is gone (or not this user's, or hidden from this user). */
export function procRow(pid: number): ProcRow | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  return procs([pid]).find((r) => r.pid === pid) ?? null
}
