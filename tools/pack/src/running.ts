// The Kea that runs from the bundle about to be replaced: found, described and asked to quit.
//
// A process belongs to a bundle when its executable (`comm`: the path it was started by) lies inside that very folder:
// the same path, or another spelling of it (a symlinked parent) that is the same directory on disk. Nothing else is
// ever matched: not another Kea.app elsewhere, not a holder (those run from `<KEA_HOME>/bin/`, never from the bundle),
// not a process that merely names the bundle in its arguments.
//
// Quitting is the quit Kea already has: SIGTERM to its main process, which Electron turns into `app.quit()`, so main's
// `before-quit` runs the full quit (ptyhost writes its last checkpoints; holders and agents run on). The
// signal goes only to a main process of this bundle, after its pid, start time and executable were read again. Then
// the bundle must empty: the install goes on only once no process at all runs from it.

import fs from 'node:fs'
import path from 'node:path'
import { descendantsOf, sameProcess, type Proc } from './processes.ts'

/** The app's own executable inside its bundle (CFBundleExecutable). */
export const MAIN_EXECUTABLE = path.join('Contents', 'MacOS', 'Kea')
/** The executable every holder runs. */
export const HELPER_EXECUTABLE = 'kea-helper'

function sameDirectory(a: string, b: string): boolean {
  try {
    const x = fs.statSync(a)
    const y = fs.statSync(b)
    return x.isDirectory() && y.isDirectory() && x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/**
 * The spelling of `app` that `comm` lies in, or null when `comm` is not inside that bundle. A folder further up `comm`
 * counts only if it has the bundle's name and is the same directory on disk.
 */
export function bundleOf(comm: string, app: string): string | null {
  if (comm.startsWith(app + path.sep)) return app
  const name = path.basename(app)
  for (let dir = path.dirname(comm); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (path.basename(dir) === name && sameDirectory(dir, app)) return dir
  }
  return null
}

/** Every process whose executable lies inside the bundle `app`. */
export function bundleProcesses(table: readonly Proc[], app: string): Proc[] {
  return table.filter((p) => bundleOf(p.comm, app) !== null)
}

export interface RunningKea {
  main: Proc
  /** The `--kea-home=` it was started with; null: none, so the installed app's own home. */
  home: string | null
  /** A window is open: a renderer process runs below it (a closed window's renderer is gone). */
  window: boolean
  /** Holders that are not detached: they are this Kea's children and end with it. */
  held: Proc[]
}

const RENDERER = /^Kea Helper \(Renderer\)$/

/** `--kea-home=<path>` on a command line (`args` joins the words with spaces: the value runs to the next switch). */
export function homeSwitch(args: string): string | null {
  return /(?:^| )--kea-home=(.*?)(?= --|$)/.exec(args)?.[1] ?? null
}

/** A holder run as a child, not daemonised: `kea-helper pty … --no-detach` (the daemon's first word is `pty-daemon`). */
function isHeldHolder(p: Proc): boolean {
  return path.basename(p.comm) === HELPER_EXECUTABLE && / pty (?:.* )?--no-detach(?: |$)/.test(p.args.slice(p.args.indexOf(HELPER_EXECUTABLE)))
}

/** The Keas running from `app`: one per main process (one per KEA_HOME). */
export function runningKeas(table: readonly Proc[], app: string): RunningKea[] {
  const out: RunningKea[] = []
  for (const p of table) {
    const bundle = bundleOf(p.comm, app)
    if (bundle === null || p.comm !== path.join(bundle, MAIN_EXECUTABLE)) continue
    const below = descendantsOf(p.pid, table)
    out.push({ main: p, home: homeSwitch(p.args), window: below.some((c) => RENDERER.test(path.basename(c.comm)) && bundleOf(c.comm, app) !== null), held: below.filter(isHeldHolder) })
  }
  return out.sort((a, b) => a.main.pid - b.main.pid)
}

export interface HolderGroup {
  /**
   * The build that started them: the folder of the helper copy they run from (`<KEA_HOME>/bin/<build>`, where older
   * builds put it), or, for the newest helper's stable path (`bin/current`), the Kea version each was started
   * with (`--kea-version`) and that path.
   */
  build: string
  count: number
}

/** The folder in `<KEA_HOME>/bin` that holders start from (ptyhost's `CURRENT_HELPER_DIR`). */
const CURRENT = 'current'

/**
 * The holders alive under `home`, by the build that started them: the processes whose executable is
 * `<home>/bin/<build>/kea-helper` and that are a holder (`pty-daemon`, or `pty` when not detached).
 * Read from the process table alone: nothing under `home` is opened.
 */
export function holdersByBuild(table: readonly Proc[], home: string): HolderGroup[] {
  const bin = path.join(home, 'bin')
  const counts = new Map<string, number>()
  for (const p of table) {
    if (path.basename(p.comm) !== HELPER_EXECUTABLE || path.dirname(path.dirname(p.comm)) !== bin) continue
    const words = p.args.slice(p.args.indexOf(HELPER_EXECUTABLE)).split(' ')
    if (words[1] !== 'pty-daemon' && words[1] !== 'pty') continue
    const folder = path.basename(path.dirname(p.comm))
    const at = words.indexOf('--kea-version')
    const version = at > 0 ? words[at + 1] : undefined
    const build = folder !== CURRENT ? folder : version ? `${version} (bin/${CURRENT})` : `bin/${CURRENT}`
    counts.set(build, (counts.get(build) ?? 0) + 1)
  }
  return [...counts].map(([build, count]) => ({ build, count })).sort((a, b) => a.build.localeCompare(b.build))
}

export interface QuitDeps {
  /** The process table, read now. */
  table(): Proc[]
  /** Send SIGTERM to `pid`. */
  terminate(pid: number): void
  sleep(ms: number): Promise<void>
  /** Milliseconds on a clock that only moves forward. */
  now(): number
}

export interface QuitResult {
  /** No process runs from the bundle any more. */
  empty: boolean
  /** The main processes that were asked to quit. */
  asked: number[]
  /** Main processes found earlier that were not asked, and why. */
  skipped: { pid: number; why: string }[]
  /** What still runs from the bundle when the wait ended. */
  left: Proc[]
}

/**
 * Ask each of `keas` to quit completely and wait until nothing runs from `app`, at most `timeoutMs`. A Kea is asked
 * only if the process table still shows that very process (pid, start time, executable) as a main process of `app`;
 * one that changed since it was found is skipped, never signalled. Nothing else is signalled, ever: a process that does
 * not leave is reported in `left`, and the caller stops with the app as it was.
 */
export async function quitKeas(app: string, keas: readonly RunningKea[], deps: QuitDeps, o: { timeoutMs: number; pollMs: number }): Promise<QuitResult> {
  const asked: number[] = []
  const skipped: QuitResult['skipped'] = []
  const now = deps.table()
  for (const k of keas) {
    const cur = now.find((p) => p.pid === k.main.pid)
    if (!cur) continue // already gone
    const bundle = bundleOf(cur.comm, app)
    if (!sameProcess(k.main, cur) || bundle === null || cur.comm !== path.join(bundle, MAIN_EXECUTABLE)) {
      skipped.push({ pid: k.main.pid, why: 'it is not the process that was found (its start time or executable changed)' })
      continue
    }
    try {
      deps.terminate(cur.pid)
      asked.push(cur.pid)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') skipped.push({ pid: cur.pid, why: `it could not be signalled (${(e as Error).message})` })
    }
  }
  const deadline = deps.now() + o.timeoutMs
  for (;;) {
    const left = bundleProcesses(deps.table(), app)
    if (left.length === 0) return { empty: true, asked, skipped, left }
    if (deps.now() >= deadline) return { empty: false, asked, skipped, left }
    await deps.sleep(o.pollMs)
  }
}
