// The installed `agy`'s static answers (`--version`, `--help`, and `models`), captured once per installed binary and
// cached, the way claude-cli.ts and commandcode-cli.ts do for their CLIs. A cache hit runs nothing, and a miss runs
// nothing either unless this capture was explicitly asked for: the real CLI is launched only on purpose.
//
//   which binary   KEA_CONTRACT_AGY when set (an absolute path), else the first `agy` on this process's PATH
//   cache          node_modules/.cache/kea-contract/antigravity.json (KEA_CONTRACT_CACHE: another folder), keyed by the
//                  binary's resolved path, size and mtimeMs
//   capture        only with KEA_CONTRACT_CAPTURE_AG=1 (`pnpm test:contract:capture:agy`, 3 launches). Neither
//                  Claude's KEA_CONTRACT_CAPTURE nor Command Code's KEA_CONTRACT_CAPTURE_CM may launch `agy`. Without
//                  KEA_CONTRACT_CAPTURE_AG=1, a cache miss spawns zero processes and skips the installed CLI's checks,
//                  naming the binary and the capture command
//   where it runs  only inside tools/recorder's world (`agent: 'antigravity'`, `seedAntigravity`): sandbox-exec with
//                  the world's profile (real home write-protected, real ~/.gemini unreadable, /usr/bin/security denied,
//                  no outbound network except the local sinkhole), HOME inside the world, telemetry off

import fs from 'node:fs'
import path from 'node:path'
import { COMMAND, FLAGS, SUBCOMMANDS } from '../../../packages/adapters/src/antigravity/contract.ts'
import { findOnPath } from '../../../packages/adapters/src/kit/env.ts'
import { runProcess } from '../../../packages/kit/src/index.ts'
import { agentEnv, makeWorld, seedAntigravity, startSinkhole } from '../../../tools/recorder/src/world.ts'
import { cacheDir, type RunResult } from './claude-cli.ts'

/** The command that captures a missing contract (3 launches inside the recorder's world); run when asked, and counted. */
export const AG_CAPTURE_COMMAND = 'pnpm test:contract:capture:agy'
/** What that command sets. Distinct from KEA_CONTRACT_CAPTURE and KEA_CONTRACT_CAPTURE_CM. */
export const AG_CAPTURE_ENV = 'KEA_CONTRACT_CAPTURE_AG'

export function agCaptureAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AG_CAPTURE_ENV] === '1'
}

/** The three static runs, in order (each one launch). */
export const AG_RUNS = [[FLAGS.version], [FLAGS.help], [SUBCOMMANDS.models]] as const

export interface AgCapture {
  v: 1
  /** The binary as found, and as resolved. */
  path: string
  realpath: string
  size: number
  mtimeMs: number
  capturedAt: number
  version: RunResult
  help: RunResult
  models: RunResult
  /** What the sinkhole refused during the three runs (attempts to leave the machine). */
  refused: string[]
}

/** The `agy` binary to check, or null when none is installed. */
export function installedAntigravity(env: NodeJS.ProcessEnv = process.env): string | null {
  const o = env.KEA_CONTRACT_AGY
  return findOnPath(COMMAND, env.PATH, o && path.isAbsolute(o) ? o : null)
}

/** The cache file and key metadata (`{ realpath, size, mtimeMs }`) for `bin` in `dir`. */
export function agCacheFile(
  bin: string,
  dir: string = cacheDir(),
): { file: string; realpath: string; size: number; mtimeMs: number } {
  const realpath = fs.realpathSync(bin)
  const st = fs.statSync(realpath)
  return {
    file: path.join(dir, 'antigravity.json'),
    realpath,
    size: st.size,
    mtimeMs: Math.trunc(st.mtimeMs),
  }
}

/** The cached capture of `bin` in `dir` when its `{ realpath, size, mtimeMs }` matches, else null. */
export function agCached(bin: string, dir: string = cacheDir()): AgCapture | null {
  try {
    const k = agCacheFile(bin, dir)
    const c = JSON.parse(fs.readFileSync(k.file, 'utf8')) as AgCapture
    return c.v === 1 && c.realpath === k.realpath && c.size === k.size && c.mtimeMs === k.mtimeMs ? c : null
  } catch {
    return null
  }
}

const RUN_TIMEOUT_MS = 30_000
const RUN_MAX_BYTES = 4 << 20
const REFUSED = 'network attempt refused: '

async function runAntigravityInWorld(
  bin: string,
  runs: readonly (readonly string[])[],
): Promise<{ results: RunResult[]; leftovers: string[] }> {
  const sink = await startSinkhole()
  const world = makeWorld({ repo: '/nonexistent-kea-contract', trusted: false, ports: [Number(new URL(sink.url).port)] })
  seedAntigravity(world)
  const results: RunResult[] = []
  const leftovers: string[] = []
  try {
    const cwd = path.join(world.root, 'cwd')
    fs.mkdirSync(cwd)
    const env = agentEnv(world, { mockUrl: sink.url, proxyUrl: sink.url, agent: 'antigravity' })
    for (const args of runs) {
      try {
        // os-ok: contract capture runs only on macOS, inside sandbox-exec
        const r = await runProcess('/usr/bin/sandbox-exec', ['-f', world.profile, bin, ...args], {
          pool: 'other',
          env,
          cwd,
          timeoutMs: RUN_TIMEOUT_MS,
          maxBytes: RUN_MAX_BYTES,
          stderrMaxBytes: RUN_MAX_BYTES,
        })
        results.push({
          code: r.code,
          out: r.stdout?.toString('utf8') ?? '',
          err: r.timedOut ? `timed out after ${RUN_TIMEOUT_MS} ms\n${r.stderr}` : r.stderr,
        })
      } catch (e) {
        results.push({ code: null, out: '', err: String(e) })
      }
    }
    if (sink.hits.length) leftovers.push(...sink.hits.map((h) => `${REFUSED}${h}`))
  } finally {
    world.dispose()
    await sink.close()
  }
  return { results, leftovers }
}

/**
 * Returns the cached capture of `bin`; on a cache miss, captures a new one (three launches inside the recorder's world)
 * ONLY when `allow` (by default `agCaptureAllowed()`) is true. When `allow` is false, spawns zero processes and returns
 * `capture: null` with `skipped` naming the binary and `pnpm test:contract:capture:agy`.
 */
export async function captureAntigravity(
  bin: string,
  o: { cacheDir?: string; allow?: boolean } = {},
): Promise<{ capture: AgCapture | null; ran: boolean; leftovers: string[]; skipped?: string }> {
  const dir = o.cacheDir ?? cacheDir()
  const hit = agCached(bin, dir)
  if (hit) return { capture: hit, ran: false, leftovers: [] }
  const k = agCacheFile(bin, dir)
  if (!(o.allow ?? agCaptureAllowed())) {
    return {
      capture: null,
      ran: false,
      leftovers: [],
      skipped: `no cached contract for Antigravity CLI at ${k.realpath}, and nothing was launched: capture it with \`${AG_CAPTURE_COMMAND}\` (${AG_RUNS.length} launches of that binary inside the recorder's world)`,
    }
  }
  const { results, leftovers } = await runAntigravityInWorld(k.realpath, AG_RUNS)
  const [version, help, models] = results as [RunResult, RunResult, RunResult]
  const c: AgCapture = {
    v: 1,
    path: bin,
    realpath: k.realpath,
    size: k.size,
    mtimeMs: k.mtimeMs,
    capturedAt: Date.now(),
    version,
    help,
    models,
    refused: leftovers.filter((l) => l.startsWith(REFUSED)).map((l) => l.slice(REFUSED.length)),
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(k.file, `${JSON.stringify(c, null, 2)}\n`)
  return { capture: c, ran: true, leftovers: leftovers.filter((l) => !l.startsWith(REFUSED)) }
}
