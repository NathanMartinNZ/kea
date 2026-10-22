// The installed `cmd`'s static answers (`--version`, `--help`, `--list-models` and `status --json`), captured once per
// installed binary and cached, the way claude-cli.ts does it for Claude Code. A cache hit runs nothing, and a miss runs
// nothing either unless this capture was asked for: the real CLI is launched only on purpose.
//
//   which binary   KEA_CONTRACT_CMD when set (an absolute path), else the first `cmd` on this process's PATH
//   cache          node_modules/.cache/kea-contract/commandcode-<key>.json (KEA_CONTRACT_CACHE: another folder), the key
//                  a hash of the binary's resolved path, size and mtime and of its package's version: npm replaces the
//                  package's files on every update, and the record names the version it read
//   capture        only with KEA_CONTRACT_CAPTURE_CM=1 (`pnpm test:contract:capture:cmd`, run on purpose and counted: 4
//                  launches). The variable is Command Code's own: Claude's capture command launches no `cmd`, and this
//                  one no `claude`. Without it a miss skips the installed CLI's half of commandcode.test.ts, naming the
//                  version and the command
//   where it runs  only inside tools/recorder's world: sandbox-exec with the world's profile (the real home
//                  write-protected, the real ~/.commandcode unreadable, no network but the local sinkhole), HOME inside
//                  the world, telemetry and the update check off. Not local-only: these are the answers a person's own
//                  CLI gives (the catalog's models, the signed-out status), and the sandbox refuses the network anyway.
//                  The sinkhole's refused attempts are kept with the capture.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { COMMAND } from '../../../packages/adapters/src/commandcode/contract.ts'
import { findOnPath } from '../../../packages/adapters/src/kit/env.ts'
import { cacheDir, runInWorld, type RunResult } from './claude-cli.ts'

/** The command that captures a missing contract (4 launches inside the recorder's world); run when asked, and counted. */
export const CM_CAPTURE_COMMAND = 'pnpm test:contract:capture:cmd'
/** What that command sets. Not Claude's KEA_CONTRACT_CAPTURE: neither capture may launch the other's CLI. */
export const CM_CAPTURE_ENV = 'KEA_CONTRACT_CAPTURE_CM'

export function cmCaptureAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CM_CAPTURE_ENV] === '1'
}

/** The four static runs, in order (each one launch). */
export const CM_RUNS = [['--version'], ['--help'], ['--list-models'], ['status', '--json']] as const

export interface CmCapture {
  v: 1
  /** The binary as found, and as resolved (npm links `cmd` to the package's entry file). */
  path: string
  realpath: string
  size: number
  mtimeMs: number
  /** `version` of the package.json beside the entry file's folder, when it is laid out as npm does. */
  packageVersion: string | null
  capturedAt: number
  version: RunResult
  help: RunResult
  models: RunResult
  status: RunResult
  /** What the sinkhole refused during the four runs (attempts to leave the machine). */
  refused: string[]
}

/** The `cmd` to check, or null when none is installed. */
export function installedCommandCode(env: NodeJS.ProcessEnv = process.env): string | null {
  const o = env.KEA_CONTRACT_CMD
  return findOnPath(COMMAND, env.PATH, o && path.isAbsolute(o) ? o : null)
}

/** The version npm installed (`<package>/dist/index.mjs` → `<package>/package.json`), read from disk: nothing is run. */
export function packageVersion(realpath: string): string | null {
  for (const dir of [path.dirname(realpath), path.dirname(path.dirname(realpath))]) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }
      if (typeof p.version === 'string' && /^\d+\.\d+\.\d+/.test(p.version)) return p.version
    } catch {
      // not there: one folder up, then none
    }
  }
  return null
}

/** The cache file of a binary (its resolved path, size, mtime and package version) in `dir`. */
export function cmCacheFile(bin: string, dir: string = cacheDir()): { file: string; realpath: string; size: number; mtimeMs: number; packageVersion: string | null } {
  const realpath = fs.realpathSync(bin)
  const st = fs.statSync(realpath)
  const version = packageVersion(realpath)
  const key = createHash('sha256').update(JSON.stringify([realpath, st.size, Math.trunc(st.mtimeMs), version])).digest('hex').slice(0, 24)
  return { file: path.join(dir, `commandcode-${key}.json`), realpath, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), packageVersion: version }
}

/** The cached capture of `bin` in `dir`, if any. */
export function cmCached(bin: string, dir: string = cacheDir()): CmCapture | null {
  try {
    const c = JSON.parse(fs.readFileSync(cmCacheFile(bin, dir).file, 'utf8')) as CmCapture
    return c.v === 1 ? c : null
  } catch {
    return null
  }
}

const REFUSED = 'network attempt refused: '

/**
 * The cached capture of `bin`; on a miss, a new one (four launches, in the world) written to the cache only when the
 * capture was asked for (`allow`, by default `cmCaptureAllowed()`); otherwise nothing is launched and `skipped` says why
 * and how to capture.
 */
export async function captureCommandCode(bin: string, o: { cacheDir?: string; allow?: boolean } = {}): Promise<{ capture: CmCapture | null; ran: boolean; leftovers: string[]; skipped?: string }> {
  const dir = o.cacheDir ?? cacheDir()
  const hit = cmCached(bin, dir)
  if (hit) return { capture: hit, ran: false, leftovers: [] }
  const k = cmCacheFile(bin, dir)
  if (!(o.allow ?? cmCaptureAllowed())) {
    return { capture: null, ran: false, leftovers: [], skipped: `no cached contract for Command Code ${k.packageVersion ?? '(version unknown)'} at ${k.realpath}, and nothing was launched: capture it with \`${CM_CAPTURE_COMMAND}\` (${CM_RUNS.length} launches of that binary inside the recorder's world)` }
  }
  const { results, leftovers } = await runInWorld(k.realpath, CM_RUNS, { agent: 'commandcode', localOnly: false })
  const [version, help, models, status] = results as [RunResult, RunResult, RunResult, RunResult]
  const c: CmCapture = { v: 1, path: bin, realpath: k.realpath, size: k.size, mtimeMs: k.mtimeMs, packageVersion: k.packageVersion, capturedAt: Date.now(), version, help, models, status, refused: leftovers.filter((l) => l.startsWith(REFUSED)).map((l) => l.slice(REFUSED.length)) }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(k.file, `${JSON.stringify(c, null, 2)}\n`)
  return { capture: c, ran: true, leftovers: leftovers.filter((l) => !l.startsWith(REFUSED)) }
}
