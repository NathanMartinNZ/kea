// Replacing the installed app in place. The bundle path never changes (macOS keeps privacy grants and
// notification permission for the same path and signature), and the target is never a half-copied app:
//
//   stage    the new build is copied to `<target>.installing` and its signature verified there, while the old app is
//            untouched (and may still be running);
//   swap     `<target>` → `<target>.previous`, then `<target>.installing` → `<target>`: two renames in the same
//            folder, one after the other, with SIGINT, SIGTERM and SIGHUP held back for their duration (one that
//            came meanwhile is sent again once the event loop has turned: `holdSignals`);
//   finish   `<target>.previous` is deleted.
//
// What a run that was killed leaves, and what `recover` (run first, every time) does about it:
//   during stage     a partial `.installing`; the app as it was          → `.installing` deleted
//   between renames  no app; `.previous` (the old app, whole) and `.installing` (the new one, whole)
//                                                                        → `.previous` put back, `.installing` deleted
//   during finish    the new app in place; part of `.previous`           → `.previous` deleted
// So only a kill between the two renames (SIGKILL or power loss: the catchable signals are held) leaves no app at the
// path, and then the old one is one rename away: `mv <target>.previous <target>`.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { need } from '../../../packages/protocol/src/platform.ts'
import { packOs } from './os/index.ts'

export interface Sides {
  /** The new build, being copied or waiting for the swap. */
  installing: string
  /** The old app, moved aside by the swap. */
  previous: string
}

export function sides(target: string): Sides {
  return { installing: `${target}.installing`, previous: `${target}.previous` }
}

const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

const remove = (p: string) => fs.rmSync(p, { recursive: true, force: true })

/** What `recover` will do about an interrupted install, in words, without doing it (the plan is said first). */
export function leftovers(target: string): string[] {
  const { installing, previous } = sides(target)
  const will: string[] = []
  if (!exists(target) && exists(previous)) will.push(`An earlier install was interrupted between moving the old app aside and moving the new one in: the old app, now at ${previous}, is put back at ${target} first.`)
  else if (exists(previous)) will.push(`${previous}, the old app an earlier install had not finished deleting, is removed first.`)
  if (exists(installing)) will.push(`${installing}, the copy an earlier install had not finished, is removed first.`)
  return will
}

/** Put right what an interrupted install left (see above). Returns what was done, in words; empty when nothing was left. */
export function recover(target: string): string[] {
  const { installing, previous } = sides(target)
  const did: string[] = []
  if (!exists(target) && exists(previous)) {
    fs.renameSync(previous, target)
    did.push(`An earlier install was interrupted between moving the old app aside and moving the new one in: the old app is back at ${target}.`)
  }
  if (exists(previous)) {
    remove(previous)
    did.push(`Removed ${previous}, the old app an earlier install had not finished deleting.`)
  }
  if (exists(installing)) {
    remove(installing)
    did.push(`Removed ${installing}, the copy an earlier install had not finished.`)
  }
  return did
}

export interface StageDeps {
  /** Copy the bundle `from` to `to` with everything a signature covers (`ditto`). Throws when it fails. */
  copy(from: string, to: string): void
  /** Why the bundle at `app` must not be installed (its signature does not verify), or null. */
  verify(app: string): string | null
}

/** Copy `built` beside `target` and verify the copy. The target is not touched; a copy that fails is removed. */
export function stage(built: string, target: string, deps: StageDeps): string {
  const { installing } = sides(target)
  remove(installing)
  try {
    deps.copy(built, installing)
    const why = deps.verify(installing)
    if (why) throw new Error(`the copy at ${installing} does not verify, so nothing was replaced: ${why}`)
  } catch (e) {
    remove(installing)
    throw e
  }
  return installing
}

/** Run a command to its end and answer its exit status (null: it did not run, or a signal ended it) and all it printed. */
export type Exec = (file: string, args: string[]) => { status: number | null; out: string }

/** The real `Exec`: nothing of the command reaches the terminal but through the answer. */
export const execQuiet: Exec = (file, args) => {
  const r = spawnSync(file, args, { encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * The copy and the check `pnpm kea:install` stages with: `ditto` (everything a signature covers), then
 * `codesign --verify --deep --strict` on the copy. A copy that fails throws, like a check that fails: it never ends
 * the run by itself, so `stage` removes the partial copy and the tool says the app is as it was (`stageFailure`).
 */
export function stageDeps(exec: Exec = execQuiet): StageDeps {
  return {
    copy: (from, to) => {
      const r = exec(need(packOs.tools).path('ditto'), [from, to])
      if (r.status !== 0) throw new Error(`the build could not be copied to ${to}, so nothing was replaced: ${r.out.trim() || (r.status === null ? 'ditto did not run' : `ditto exit ${r.status}`)}`)
    },
    verify: (app) => {
      const r = exec(need(packOs.tools).path('codesign'), ['--verify', '--deep', '--strict', app])
      return r.status === 0 ? null : r.out.trim() || `codesign exit ${r.status}`
    },
  }
}

/** What the tool says when `stage` threw: why, and what the plan promises of every failure before the swap. */
export function stageFailure(e: unknown, target: string): string {
  return `${e instanceof Error ? e.message : String(e)}\n${target} is as it was.`
}

/**
 * What the tool says when the swap failed. `quit`: Kea ran from the app and was asked to quit for the swap; it has
 * quit by then, and a run that fails does not open it again.
 */
export function swapFailure(target: string, e: unknown, o: { quit: boolean }): string {
  const said = `${target} could not be replaced (${e instanceof Error ? e.message : String(e)}). It is as it was.`
  return o.quit ? `${said}\nKea has quit for this install and is not opened again: open it yourself. Its sessions kept running, and it reattaches every one.` : said
}

/** Drop a staged copy (the install stops before the swap). */
export function discardStage(target: string): void {
  remove(sides(target).installing)
}

const HELD: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Run `fn` (synchronous) with the catchable termination signals held back; one that arrived meanwhile is raised again
 * once it has been heard.
 *
 * A signal that arrives while `fn` runs is caught at once (it no longer ends the run), but its listener here is called
 * only when the event loop next turns, which is after `fn` and after everything synchronous that follows it. So the
 * hold does not let go when `fn` returns: it stays through one whole turn of the loop (two `setImmediate`s: the
 * first may run before the loop has looked for signals again, the second cannot), then stops listening and sends the
 * signal it heard again, now with nothing in its way. A hold that let go at `fn`'s return would leave the signal
 * caught, heard by nobody and lost. A run that ends before that turn (`process.exit` after a failed swap) ends anyway.
 */
export function holdSignals<T>(fn: () => T): T {
  let got: NodeJS.Signals | null = null
  const note = (s: NodeJS.Signals) => {
    got ??= s
  }
  for (const s of HELD) process.on(s, note)
  const release = (): void => {
    for (const s of HELD) process.off(s, note)
    if (got) process.kill(process.pid, got)
  }
  try {
    return fn()
  } finally {
    setImmediate(() => setImmediate(release))
  }
}

/**
 * The swap: the old app aside, the staged one in. `between` is a test's seam for the moment between the two renames.
 * If the second rename fails, the old app is put back and the error thrown: the target is then as it was.
 */
export function swap(target: string, o: { between?: () => void } = {}): void {
  const { installing, previous } = sides(target)
  if (!exists(installing)) throw new Error(`nothing is staged at ${installing}`)
  if (exists(previous)) throw new Error(`${previous} is in the way (recover first)`)
  holdSignals(() => {
    const had = exists(target)
    if (had) fs.renameSync(target, previous)
    o.between?.()
    try {
      fs.renameSync(installing, target)
    } catch (e) {
      if (had) fs.renameSync(previous, target)
      throw e
    }
  })
}

/** Delete the old app the swap moved aside. A failure is not the install's: the new app is in place, and the next run removes the rest. */
export function finish(target: string): { removed: boolean; error: string | null } {
  const { previous } = sides(target)
  if (!exists(previous)) return { removed: false, error: null }
  try {
    remove(previous)
    return { removed: true, error: null }
  } catch (e) {
    return { removed: false, error: (e as Error).message }
  }
}
