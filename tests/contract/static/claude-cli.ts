// The installed `claude`'s static answers (`--version`, `--help` and `auth status`), captured once per installed binary
// and cached. A cache hit runs nothing, and a miss runs nothing either unless a capture was asked for: the real CLI is
// launched only on purpose.
//
//   which binary   KEA_CONTRACT_CLAUDE when set (an absolute path), else the first `claude` on this process's PATH
//   cache          node_modules/.cache/kea-contract/claude-<key>.json (KEA_CONTRACT_CACHE: another folder), the key a hash
//                  of the binary's resolved path, size and mtime: the installer keeps each version in its own file
//                  (…/claude/versions/<version>), so a new version is a new key, and the record names the version it read
//   capture        only with KEA_CONTRACT_CAPTURE=1 (`pnpm test:contract:capture`, run on purpose and counted: 3
//                  launches); without it a miss skips the installed CLI's half of claude.test.ts, naming the version
//                  and that command
//   where it runs  only inside tools/recorder's world: sandbox-exec with the world's profile (the real home
//                  write-protected, the real ~/.claude unreadable, network to the local sinkhole only), HOME and
//                  CLAUDE_CONFIG_DIR inside the world, telemetry and updates off, a dummy key, the model URL the sinkhole
//                  (nothing here calls a model); the world is swept and removed afterwards, and what the CLI added under
//                  /tmp/claude-<uid>/ for the world's directories is deleted
//
// The help parser reads commander's layout (`  -r, --resume [value]   description…`, continuation lines indented).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findOnPath } from '../../../packages/adapters/src/kit/env.ts'
import { runProcess } from '../../../packages/kit/src/index.ts'
import { agentEnv, makeWorld, startSinkhole, type WorldAgent } from '../../../tools/recorder/src/world.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const CACHE_DIR = path.join(repoRoot, 'node_modules/.cache/kea-contract')

/** The cache folder: KEA_CONTRACT_CACHE when set (an absolute path), else CACHE_DIR. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const o = env.KEA_CONTRACT_CACHE
  return o && path.isAbsolute(o) ? o : CACHE_DIR
}

/** The command that captures a missing contract (3 launches inside the recorder's world); run when asked, and counted. */
export const CAPTURE_COMMAND = 'pnpm test:contract:capture'

/** A capture was asked for: KEA_CONTRACT_CAPTURE=1, which CAPTURE_COMMAND sets. */
export function captureAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KEA_CONTRACT_CAPTURE === '1'
}

/** How long one capture run may take, and how much of its output is kept. */
const RUN_TIMEOUT_MS = 30_000
const RUN_MAX_BYTES = 4 << 20

export interface RunResult {
  code: number | null
  out: string
  err: string
}

export interface CliCapture {
  v: 1
  /** The binary as found, and as resolved. */
  path: string
  realpath: string
  size: number
  mtimeMs: number
  capturedAt: number
  version: RunResult
  help: RunResult
  auth: RunResult
}

/** The `claude` to check, or null when none is installed. */
export function installedClaude(): string | null {
  const o = process.env.KEA_CONTRACT_CLAUDE
  return findOnPath('claude', process.env.PATH, o && path.isAbsolute(o) ? o : null)
}

/** The cache file of a binary (its resolved path, size and mtime) in `dir`. */
export function cacheFile(bin: string, dir: string = cacheDir()): { file: string; realpath: string; size: number; mtimeMs: number } {
  const realpath = fs.realpathSync(bin)
  const st = fs.statSync(realpath)
  const key = createHash('sha256').update(JSON.stringify([realpath, st.size, Math.trunc(st.mtimeMs)])).digest('hex').slice(0, 24)
  return { file: path.join(dir, `claude-${key}.json`), realpath, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) }
}

/** The cached capture of `bin` in `dir`, if any. */
export function cached(bin: string, dir: string = cacheDir()): CliCapture | null {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(bin, dir).file, 'utf8')) as CliCapture
    return c.v === 1 ? c : null
  } catch {
    return null
  }
}

/** Entries of the CLI's own temp root (`/tmp/claude-<uid>`, and /private/tmp's spelling of it). */
function tmpClaudeRoots(): string[] {
  const uid = process.getuid?.() ?? 0
  return [...new Set([`/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`].map((d) => (fs.existsSync(d) ? fs.realpathSync(d) : d)))]
}

function listing(): Set<string> {
  const out = new Set<string>()
  for (const r of tmpClaudeRoots()) if (fs.existsSync(r)) for (const e of fs.readdirSync(r)) out.add(path.join(r, e))
  return out
}

/**
 * Run `bin` with each argv inside a fresh recorder world, then remove the world and what the runs added under
 * /tmp/claude-<uid>/ for it (entries named after the world's directories only; anything else is reported, never
 * touched). Every run is one launch of the binary. `agent`: whose switches the world's environment carries (world.ts;
 * Command Code's static answers are a person's own CLI's, so `localOnly: false`: the sandbox still refuses the network).
 */
export async function runInWorld(bin: string, runs: readonly (readonly string[])[], o: { agent?: WorldAgent; localOnly?: boolean } = {}): Promise<{ results: RunResult[]; leftovers: string[] }> {
  const sink = await startSinkhole()
  const world = makeWorld({ repo: '/nonexistent-kea-contract', trusted: false, ports: [Number(new URL(sink.url).port)] })
  const before = listing()
  const results: RunResult[] = []
  const leftovers: string[] = []
  try {
    const cwd = path.join(world.root, 'cwd')
    fs.mkdirSync(cwd)
    const env = agentEnv(world, { mockUrl: sink.url, proxyUrl: sink.url, ...(o.agent ? { agent: o.agent } : {}), ...(o.localOnly !== undefined ? { localOnly: o.localOnly } : {}) })
    for (const args of runs) {
      // not a blocking spawn: the sinkhole lives in this process, and must answer (and count) while the CLI runs
      try {
        // os-ok: contract capture runs only on macOS, inside sandbox-exec
        const r = await runProcess('/usr/bin/sandbox-exec', ['-f', world.profile, bin, ...args], { pool: 'other', env, cwd, timeoutMs: RUN_TIMEOUT_MS, maxBytes: RUN_MAX_BYTES, stderrMaxBytes: RUN_MAX_BYTES })
        results.push({ code: r.code, out: r.stdout?.toString('utf8') ?? '', err: r.timedOut ? `timed out after ${RUN_TIMEOUT_MS} ms\n${r.stderr}` : r.stderr })
      } catch (e) {
        results.push({ code: null, out: '', err: String(e) })
      }
    }
    if (sink.hits.length) leftovers.push(...sink.hits.map((h) => `network attempt refused: ${h}`))
  } finally {
    const slug = path.basename(world.root)
    for (const e of listing()) {
      if (before.has(e)) continue
      if (path.basename(e).includes(slug)) fs.rmSync(e, { recursive: true, force: true })
      else leftovers.push(`left alone (not the world's): ${e}`)
    }
    world.dispose()
    await sink.close()
  }
  return { results, leftovers }
}

/** The version an installed binary's resolved path names (the installer keeps each in …/claude/versions/<version>), or null. */
export function installedVersion(realpath: string): string | null {
  const v = path.basename(realpath)
  return /^\d+\.\d+\.\d+/.test(v) ? v : null
}

/**
 * The cached capture of `bin`; on a miss, a new one (three launches, in the world) written to the cache only when a
 * capture was asked for (`allow`, by default `captureAllowed()`); otherwise nothing is launched and `skipped` says why
 * and how to capture.
 */
export async function capture(bin: string, o: { cacheDir?: string; allow?: boolean } = {}): Promise<{ capture: CliCapture | null; ran: boolean; leftovers: string[]; skipped?: string }> {
  const dir = o.cacheDir ?? cacheDir()
  const hit = cached(bin, dir)
  if (hit) return { capture: hit, ran: false, leftovers: [] }
  const k = cacheFile(bin, dir)
  if (!(o.allow ?? captureAllowed())) {
    const v = installedVersion(k.realpath)
    return { capture: null, ran: false, leftovers: [], skipped: `no cached contract for claude ${v ?? '(version unknown)'} at ${k.realpath}, and nothing was launched: capture it with \`${CAPTURE_COMMAND}\` (3 launches of that binary inside the recorder's world)` }
  }
  const { results, leftovers } = await runInWorld(k.realpath, [['--version'], ['--help'], ['auth', 'status']])
  const [version, help, auth] = results as [RunResult, RunResult, RunResult]
  const c: CliCapture = { v: 1, path: bin, realpath: k.realpath, size: k.size, mtimeMs: k.mtimeMs, capturedAt: Date.now(), version, help, auth }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(k.file, `${JSON.stringify(c, null, 2)}\n`)
  return { capture: c, ran: true, leftovers }
}

// ── the help text ───────────────────────────────────────────────────────────────────────────────

export interface HelpOption {
  /** Every spelling of the option (`-r`, `--resume`). */
  names: string[]
  /** Its description, the continuation lines joined. */
  text: string
}

/** Commander's option list: a line `  -x, --name <arg>  text…`, continued by lines indented past the names column. */
export function parseHelp(help: string): HelpOption[] {
  const out: HelpOption[] = []
  let cur: HelpOption | null = null
  for (const line of help.split('\n')) {
    const m = /^ {2}((?:-[A-Za-z0-9?], )?--?[A-Za-z0-9][\w-]*)((?: [<[][^>\]]*[>\]])*)(?: {2,}(.*))?$/.exec(line)
    if (m) {
      cur = { names: m[1]!.split(', ').map((s) => s.trim()), text: (m[3] ?? '').trim() }
      out.push(cur)
      continue
    }
    if (cur && /^ {10,}\S/.test(line)) cur.text = `${cur.text} ${line.trim()}`.trim()
    else if (line.trim() === '' || !line.startsWith(' ')) cur = null
  }
  return out
}

/** Every flag spelled in the help's option list. */
export function helpFlags(help: string): Set<string> {
  return new Set(parseHelp(help).flatMap((o) => o.names))
}

/** An option's description, by any of its names. */
export function optionText(help: string, flag: string): string | null {
  return parseHelp(help).find((o) => o.names.includes(flag))?.text ?? null
}

/** `(choices: "a", "b", default: "a")` → ['a', 'b']. */
export function choicesOf(text: string): string[] {
  const m = /\(choices: ([^)]*)\)/.exec(text)
  if (!m) return []
  return [...m[1]!.split(/,\s*default:/)[0]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)
}

/** The last parenthesised list of words in a description (`(low, medium, high)`). */
export function listOf(text: string): string[] {
  const all = [...text.matchAll(/\(([a-z]+(?:, [a-z]+)+)\)/g)]
  return all.length ? all.at(-1)![1]!.split(', ') : []
}
