// What the editor launcher may touch on this machine: on macOS where app bundles are looked for, Spotlight's lookup
// tool and `open`; on Linux where commands and desktop entries are looked for and `xdg-open`; and the GitHub CLI. It is
// a parameter so that no test can launch a real editor, browser or terminal app: core's entry point passes the system's
// (below); a test passes stand-ins in a temp dir; a core built without one answers "unavailable" (open.ts).
//
// A dev build run by the test harness (`--kea-perf`, tests/support/app-child-hooks.cjs) gets `sandboxEditorHost`: it
// looks only under the run's own HOME, which the harness makes an empty folder of its own, so the editors installed on
// the machine are never found and the system's `open` (`xdg-open`) is never run.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isAvailable } from '@kea/protocol'
import { coreOs } from '../os/index.ts'
import type { Env } from '../terminal/shellEnv.ts'

export type EditorHost = BundleHost | CommandHost

/** macOS: app bundles in application folders, found by Spotlight or by name, opened with `open -a`. */
export interface BundleHost {
  readonly kind: 'bundles'
  /** The folders searched for an app bundle by name when Spotlight has no answer, in order of preference. */
  readonly appDirs: readonly string[]
  /** `mdfind`, or null: no Spotlight lookup. */
  readonly mdfind: string | null
  /** `open`. */
  readonly open: string
  /** The GitHub CLI for `env` (the login shell's environment), or null when it is not installed. */
  gh(env: Readonly<Env>): string | null
}

/**
 * Linux: an app is a command, found on the login PATH, in the places its packages put it, or through its desktop entry;
 * a file's default app and an editor's URL go to `xdg-open`.
 */
export interface CommandHost {
  readonly kind: 'commands'
  /** Whether the login shell's PATH is searched (the harness's world: never). */
  readonly searchPath: boolean
  /** Where `command` is looked for after the PATH, absolute, in order. */
  knownPlaces(command: string): readonly string[]
  /** The data folders whose `applications` hold desktop entries, in precedence order, for the login environment `env`. */
  dataDirs(env: Readonly<Env>): readonly string[]
  /** `xdg-open`. */
  readonly open: string
  /** The GitHub CLI for `env` (the login shell's environment), or null when it is not installed. */
  gh(env: Readonly<Env>): string | null
}

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A tool on `env`'s PATH, as the login shell would find it. */
export function onPath(tool: string, env: Readonly<Env>): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue
    const file = path.join(dir, tool)
    if (executable(file)) return file
  }
  return null
}

/**
 * This system's, from the OS layer's `editors`: on macOS Spotlight, `/Applications`, `~/Applications` and the system's
 * own utilities; on Linux the login PATH, the known places and the XDG data folders' desktop entries. Null where it has
 * none.
 */
export function systemEditorHost(home: string = os.homedir()): EditorHost | null {
  const e = coreOs.editors
  if (!isAvailable(e)) return null
  const gh = (env: Readonly<Env>): string | null => onPath('gh', env)
  if (e.kind === 'bundles') return { kind: 'bundles', appDirs: e.appDirs(home), mdfind: e.mdfind, open: e.open, gh }
  return { kind: 'commands', searchPath: true, knownPlaces: (command) => e.knownPlaces(command, home), dataDirs: (env) => e.dataDirs(env, home), open: e.open, gh }
}

/**
 * The harness's world, in this system's shape. macOS: app bundles only in `<root>/Applications`, `open` and `gh` only in
 * `<root>/bin`, no Spotlight. Linux: commands only in `<root>/bin` (never the PATH), desktop entries only in
 * `<root>/share/applications`, `xdg-open` and `gh` only in `<root>/bin`. With nothing put there, no editor is installed
 * and every launch fails to start.
 */
export function sandboxEditorHost(root: string): EditorHost {
  const ghFile = path.join(root, 'bin', 'gh')
  const gh = (): string | null => (executable(ghFile) ? ghFile : null)
  const e = coreOs.editors
  if (isAvailable(e) && e.kind === 'commands') {
    return { kind: 'commands', searchPath: false, knownPlaces: (command) => [path.join(root, 'bin', command)], dataDirs: () => [path.join(root, 'share')], open: path.join(root, 'bin', 'xdg-open'), gh }
  }
  return { kind: 'bundles', appDirs: [path.join(root, 'Applications')], mdfind: null, open: path.join(root, 'bin', 'open'), gh }
}
