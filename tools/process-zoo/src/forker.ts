// forker's build and output. forker itself is C (`forker.c`): Node cannot fork, setsid or setpgid, and a tree of real
// forks starts in about a millisecond without a Node runtime per process. It is compiled on demand with the system C
// compiler (`$CC`, else /usr/bin/cc) into tools/process-zoo/build/ (gitignored), keyed by a hash of the source and
// flags, so an edit rebuilds it and parallel test workers never see a half-written binary.
//
//   node tools/process-zoo/src/forker.ts      builds if needed and prints the binary's path

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORKER_SOURCE = fileURLToPath(new URL('./forker.c', import.meta.url))
export const ZOO_BUILD_DIR = fileURLToPath(new URL('../build/', import.meta.url))

const CFLAGS = ['-std=c11', '-D_DARWIN_C_SOURCE', '-D_DEFAULT_SOURCE', '-O2', '-Wall', '-Wextra']

function compiler(): string {
  return process.env.CC || '/usr/bin/cc' // os-ok: in /usr/bin on both systems
}

/** Why forker cannot be built here, or null when it can. */
export function forkerUnavailable(): string | null {
  const cc = compiler()
  if (!existsSync(cc)) return `forker needs a C compiler: ${cc} not found (install the Xcode Command Line Tools: xcode-select --install)`
  if (process.platform === 'darwin' && cc === '/usr/bin/cc') { // os-ok: Xcode's cc stub, macOS only
    // /usr/bin/cc is a shim that pops up an installer when the tools are missing; ask xcode-select instead
    try {
      execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }) // os-ok: Xcode's cc stub, macOS only
    } catch {
      return 'forker needs a C compiler: the Xcode Command Line Tools are not installed (xcode-select --install)'
    }
  }
  return null
}

/** Path of the compiled forker, building it first if the cached binary is missing or stale. */
export function forkerBinary(): string {
  const source = readFileSync(FORKER_SOURCE)
  const cc = compiler()
  const key = createHash('sha256').update(source).update(JSON.stringify([cc, CFLAGS])).digest('hex').slice(0, 12)
  const bin = join(ZOO_BUILD_DIR, `forker-${key}`)
  if (existsSync(bin)) return bin
  const why = forkerUnavailable()
  if (why) throw new Error(why)
  mkdirSync(ZOO_BUILD_DIR, { recursive: true })
  const tmp = `${bin}.${process.pid}.tmp`
  try {
    execFileSync(cc, [...CFLAGS, '-o', tmp, FORKER_SOURCE], { stdio: ['ignore', 'pipe', 'pipe'] })
    chmodSync(tmp, 0o755)
    renameSync(tmp, bin) // atomic: a concurrent build of the same source just replaces it with an identical file
  } catch (e) {
    rmSync(tmp, { force: true })
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? ''
    throw new Error(`building forker failed: ${(e as Error).message}\n${stderr}`)
  }
  // drop binaries of older sources (running ones keep working: unlinking does not touch a running image)
  for (const f of readdirSync(ZOO_BUILD_DIR)) if (/^forker-[0-9a-f]{12}$/.test(f) && join(ZOO_BUILD_DIR, f) !== bin) rmSync(join(ZOO_BUILD_DIR, f), { force: true })
  return bin
}

export interface ForkerProc {
  role: 'parent' | 'child' | 'middle' | 'grandchild'
  index: number
  pid: number
  ppid: number
  pgid: number
  sid: number
}

export interface ForkerSignal {
  role: ForkerProc['role']
  index: number
  pid: number
  signal: string
  action: 'exit' | 'ignore' | 'report'
}

export interface ForkerReaped {
  pid: number
  by: number
  code: number | null
  signal: string | null
}

export interface ForkerOutput {
  procs: ForkerProc[]
  /** pids from the ready line (null until it has been printed): every process still running after set-up. */
  ready: number[] | null
  signals: ForkerSignal[]
  reaped: ForkerReaped[]
  lifetime: number[]
}

/** Parse forker's JSON lines (stdout or --log). Lines that are not forker's are ignored; a partial last line too. */
export function parseForkerOutput(text: string): ForkerOutput {
  const out: ForkerOutput = { procs: [], ready: null, signals: [], reaped: [], lifetime: [] }
  for (const line of text.split('\n').slice(0, -1)) {
    const s = line.replace(/^\r+|\r+$/g, '')
    if (!s.startsWith('{"forker":')) continue
    let r: Record<string, unknown>
    try {
      r = JSON.parse(s) as Record<string, unknown>
    } catch {
      continue
    }
    const { forker, ...rest } = r
    if (forker === 'proc') out.procs.push(rest as unknown as ForkerProc)
    else if (forker === 'ready') out.ready = rest.pids as number[]
    else if (forker === 'signal') out.signals.push(rest as unknown as ForkerSignal)
    else if (forker === 'reaped') out.reaped.push(rest as unknown as ForkerReaped)
    else if (forker === 'lifetime') out.lifetime.push(rest.pid as number)
  }
  return out
}

if (import.meta.main) {
  try {
    process.stdout.write(`${forkerBinary()}\n`)
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    process.exit(1)
  }
}
