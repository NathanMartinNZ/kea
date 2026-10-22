// The kea-helper copy agents' hooks run: one per build, `<KEA_HOME>/bin/<version>-<hash>/kea-helper`, so an update
// never replaces an executable a running agent's hooks call, and a rebuilt helper is never mistaken for an earlier
// build's copy. Holders start from another file, the newest helper at `<KEA_HOME>/bin/current/kea-helper` (ptyhost),
// which nothing here touches.
//
// The copies of earlier builds are removed here too (`HelperCopies`), since core is the process that reads the
// filesystem and knows what runs: a copy goes only when it is not this build's nor the one the agents' hooks were last
// handed (another build's once the helper was rebuilt under a running dev core), no process of this user runs from it
// (a hook in flight, or a holder an older build started from it) and no running terminal's command names it (an agent
// started by that build calls its hooks through that path for as long as it runs). Asked after each launch
// reconciliation and whenever a terminal ends; when nothing but this build's copy is there, nothing is asked at all.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runProcess, type Logger } from '@kea/kit'
import { L, parseProcs } from '@kea/protocol'

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
  const dest = path.join(dir, 'kea-helper')
  if (fs.existsSync(dest)) return dest
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${dest}.${process.pid}.tmp`
  fs.copyFileSync(source, tmp)
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, dest)
  return dest
}

/** What a helper copy's folder is called: `<version>-<12 hex digits>`. Nothing else in `bin/` is ever removed here. */
const COPY_NAME = /^.+-[0-9a-f]{12}$/

/** The executable of every process of this user, in full; throws when that cannot be told. */
export type RunningExecutables = () => Promise<string[]>

/**
 * The real answer: one `<helper> procs` run through `kit/runProcess` with L.processProbeTimeoutMs: each process by the
 * path it was started with (`argv[0]`, what `ps -o comm` printed), else by its executable file. Only this user's
 * processes: another user's cannot run from this home's copies. A path with bytes that are no UTF-8 names no file: the
 * prune then removes nothing (`pruneHelperCopies`).
 */
export function procsExecutables(helper: string): RunningExecutables {
  return async () => {
    const res = await runProcess(helper, ['procs'], { pool: 'other', env: {}, timeoutMs: L.processProbeTimeoutMs })
    if (res.timedOut || res.cancelled || res.truncated || res.code !== 0) throw new Error(`kea-helper procs did not answer: ${res.stderr.trim() || `exit ${res.code}`}`)
    return parseProcs(res.stdout?.toString('utf8') ?? '').flatMap((r) => r.argv[0] ?? r.exe ?? [])
  }
}

const fileKey = (p: string): string | null => {
  try {
    const st = fs.statSync(p)
    return st.isFile() ? `${st.dev}:${st.ino}` : null
  } catch {
    return null
  }
}

export interface PruneOptions {
  home: string
  /** This build's copy (its folder name in `bin/`), never removed. */
  current: string
  /**
   * The kea-helper the agents' hooks were last handed (`AgentService.hookHelperPath`): its copy is never removed,
   * whichever build's it is (a helper rebuilt under a running dev core makes it another build's), since a launch it went
   * to may not have a terminal yet. Read when the copies are judged, after the processes have been listed.
   */
  handedOut?: () => string | null
  executables: RunningExecutables
  /** The command of every terminal that still runs. */
  argvs: () => readonly (readonly string[])[]
  /**
   * The kea-helper executables one such command names, as the agents' adapters read it (`AdapterRegistry.helperPaths`:
   * a launch can carry the path where plain text does not show it). Default: none said.
   */
  helperPaths?: (argv: readonly string[]) => readonly string[]
  log: Logger
}

export interface PruneResult {
  /** Folder names removed from `<home>/bin`. */
  removed: string[]
  /** Folder names of earlier builds still in use, and by what. */
  kept: { name: string; why: 'process' | 'argv' }[]
}

/**
 * Remove the helper copies of earlier builds that nothing uses (see the module comment). This build's copy and the one
 * the agents' hooks were last handed never go. Any other copy stays while any process runs its `kea-helper` (compared
 * as the file on disk, so another spelling of the path is the same copy) or a running terminal's command names a path
 * in its folder: as the agents' adapters read the command (`helperPaths`), or as plain text in an argument. If the
 * processes cannot be listed, or one running `kea-helper` cannot be matched to a file that is there (so nothing says
 * which copy it runs from), nothing is removed. With no earlier build's copy in `bin/`, nothing is listed either.
 */
export async function pruneHelperCopies(o: PruneOptions): Promise<PruneResult> {
  const result: PruneResult = { removed: [], kept: [] }
  const bin = path.join(o.home, 'bin')
  // the folder in bin/ of the copy the agents' hooks were last handed, or null
  const handed = (): string | null => {
    const p = o.handedOut?.()
    return p && path.dirname(path.dirname(p)) === bin ? path.basename(path.dirname(p)) : null
  }
  let names: string[]
  try {
    const mine = handed()
    names = fs
      .readdirSync(bin, { withFileTypes: true })
      .filter((d) => d.isDirectory() && COPY_NAME.test(d.name) && d.name !== o.current && d.name !== mine)
      .map((d) => d.name)
  } catch {
    return result // no bin/ yet
  }
  if (names.length === 0) return result
  let running: Set<string>
  let unmatched = 0
  try {
    // each running kea-helper by the path it was started with and by the file that path names
    running = new Set((await o.executables()).filter((e) => path.basename(e) === HELPER_EXECUTABLE))
    for (const e of [...running]) {
      const key = fileKey(e)
      if (key) running.add(key)
      else unmatched++
    }
  } catch (e) {
    o.log.warn('helper copies not pruned: the running processes could not be listed', { error: String(e) })
    return result
  }
  if (unmatched > 0) {
    // A kea-helper whose path names no file (printed in a way that is not its path, relative to a folder that is not
    // core's, or deleted since it started) may be running from any copy here: which one cannot be told, so every
    // copy stays until it has ended (the next prune looks again).
    o.log.warn('helper copies not pruned: a running kea-helper names no file that is there', { processes: unmatched, copies: names.length })
    return result
  }
  const argvs = o.argvs()
  // what the running commands name: as their adapters say (by path and, while it is there, by the file itself), and
  // any argument that holds a path of the copy as plain text
  const named = new Set<string>()
  for (const argv of argvs) {
    for (const p of o.helperPaths?.(argv) ?? []) {
      named.add(p)
      const key = fileKey(p)
      if (key) named.add(key)
    }
  }
  // handed out while the processes were being listed: this run's as much as `current` (checked here, where nothing
  // awaits before the removal)
  const mine = handed()
  for (const name of names.sort()) {
    if (name === mine) continue
    const dir = path.join(bin, name)
    const exe = path.join(dir, HELPER_EXECUTABLE)
    const key = fileKey(exe)
    const inDir = (p: string) => p.startsWith(dir + path.sep)
    if (running.has(exe) || (key !== null && running.has(key))) result.kept.push({ name, why: 'process' })
    else if ((key !== null && named.has(key)) || [...named].some(inDir) || argvs.some((argv) => argv.some((a) => a.includes(dir + path.sep)))) result.kept.push({ name, why: 'argv' })
    else {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        result.removed.push(name)
      } catch (e) {
        o.log.warn('helper copy not removed', { name, error: String(e) })
      }
    }
  }
  if (result.removed.length || result.kept.length) o.log.info('helper copies of earlier builds', { removed: result.removed, kept: result.kept })
  return result
}

/**
 * The prune, as core runs it: one at a time, and one more afterwards if it was asked again meanwhile (a terminal that
 * ended while the processes were being listed). Without the helper Kea ships (`source` null) this build's own copy
 * cannot be named, so nothing is ever removed. This build's copy is named at the first look; the copy the agents'
 * hooks were last handed (`handedOut`) is kept too, which is another one once the helper was rebuilt under a running
 * dev core (U-HLD-16).
 */
export class HelperCopies {
  private readonly o: Omit<PruneOptions, 'current'> & { source: string | null; version: string }
  private current: string | null = null
  private running: Promise<PruneResult | null> | null = null
  private again = false
  private disposed = false

  constructor(o: HelperCopies['o']) {
    this.o = o
  }

  /** Ask for a prune; resolves with what the run that covers this request did (null: none could run). */
  prune(): Promise<PruneResult | null> {
    if (this.disposed || !this.o.source) return Promise.resolve(null)
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = null
      if (this.again && !this.disposed) {
        this.again = false
        void this.prune()
      }
    })
    return this.running
  }

  dispose(): void {
    this.disposed = true
  }

  private async run(): Promise<PruneResult | null> {
    try {
      this.current ??= helperCopyName(this.o.source as string, this.o.version)
      return await pruneHelperCopies({ home: this.o.home, current: this.current, ...(this.o.handedOut ? { handedOut: this.o.handedOut } : {}), executables: this.o.executables, argvs: this.o.argvs, ...(this.o.helperPaths ? { helperPaths: this.o.helperPaths } : {}), log: this.o.log })
    } catch (e) {
      this.o.log.warn('helper copies not pruned', { error: String(e) })
      return null
    }
  }
}

/** A launch file's name: one path element, nothing that leaves the folder. */
const FILE_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

/**
 * An adapter's launch files (its `launchFiles`: Command Code's session mod) in a folder of Kea's own,
 * `<home>/bin/agents/<id>-<sha256(files)[:12]>/`, written if absent or not as given (each file by rename, so an agent
 * never loads half of one). The folders of the adapter's earlier files (another build's) are removed, except one that
 * `inUse` says a running agent was started with: that agent's argv names its files for as long as it runs, and it loads
 * them again by itself (Command Code's `/reload`, its relaunch for an update of its own), so they stay where they are
 * until it has ended and go with a later launch. What is kept is therefore at most one folder per build that still has
 * an agent running. Returns the folder, or null with nothing to write. Throws when it cannot be written.
 */
export function installAgentFiles(home: string, id: string, files: readonly { name: string; content: string }[], inUse: (dir: string) => boolean = () => false): string | null {
  if (files.length === 0) return null
  const hash = createHash('sha256')
  for (const f of files) {
    if (!FILE_NAME.test(f.name)) throw new Error(`a launch file of ${id} has a name Kea does not write: ${JSON.stringify(f.name)}`)
    hash.update(`${f.name}\0${Buffer.byteLength(f.content)}\0${f.content}\0`)
  }
  const root = path.join(home, 'bin', 'agents')
  const dirName = `${id}-${hash.digest('hex').slice(0, 12)}`
  const dir = path.join(root, dirName)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const f of files) {
    const dest = path.join(dir, f.name)
    let same = false
    try {
      const st = fs.lstatSync(dest)
      same = st.isFile() && fs.readFileSync(dest, 'utf8') === f.content
    } catch {
      // not there yet
    }
    if (same) continue
    const tmp = `${dest}.${process.pid}.tmp`
    fs.rmSync(tmp, { force: true })
    fs.writeFileSync(tmp, f.content, { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, dest)
  }
  for (const e of fs.readdirSync(root)) {
    if (e === dirName || !e.startsWith(`${id}-`) || !/^[0-9a-f]{12}$/.test(e.slice(id.length + 1))) continue
    const earlier = path.join(root, e)
    if (inUse(earlier)) continue
    fs.rmSync(earlier, { recursive: true, force: true })
  }
  return dir
}
