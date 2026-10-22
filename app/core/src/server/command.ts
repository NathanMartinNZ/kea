// What Run runs: the project's "Run command" if set, else `start.sh` in the session's working directory.
//
//   run command          `$SHELL -l -c '<command>'`: the user's own text is the script, one argv element, and nothing
//                        of Kea's is spliced into it (the one stated exception to "argv arrays only")
//   start.sh, executable `./start.sh`, directly
//   start.sh, not        the interpreter its `#!` line names, with that line's arguments; else `/bin/sh start.sh`
//
// The working directory is the worktree root, so the script is named relative to it.

import fs from 'node:fs'
import path from 'node:path'
import { L, type ProjectSettings, type ServerSource } from '@kea/protocol'
import type { Command } from '../terminal/spawn.ts'

/** The convention's file name. */
export const START_SCRIPT = 'start.sh'
const FALLBACK_INTERPRETER = '/bin/sh'

export interface StartScript {
  executable: boolean
  /** The `#!` line's words (interpreter first), or null without one. */
  shebang: string[] | null
}

export interface RunTarget {
  source: Exclude<ServerSource, 'none'>
  command: Command
  /** What the log line and the tab say was run. */
  label: string
}

/** The words of a `#!` line: the interpreter, then its arguments split at blanks, as the kernel splits them. */
export function parseShebang(head: string): string[] | null {
  if (!head.startsWith('#!')) return null
  const line = head.slice(2).split(/\r?\n/, 1)[0] ?? ''
  const words = line.trim().split(/[ \t]+/).filter(Boolean)
  return words.length ? words : null
}

/**
 * `start.sh` in `cwd` as it is now, or null when there is no such regular file (a directory of that name is not one).
 *
 * It runs on core's thread at every change of the session's root directory, so nothing in it may wait: the file is
 * opened where it really is (a link to the real script is followed, as running `./start.sh` would), without following
 * a link put there since and without waiting (`O_NONBLOCK`: opening a FIFO for reading waits for a writer), and what
 * was opened is looked at, not what the name pointed to a moment before (the viewer's `openForRead`, read.ts). Only a
 * regular file is read, and of it L.startScriptShebangBytes.
 */
export function inspectStartScript(cwd: string): StartScript | null {
  const file = path.join(cwd, START_SCRIPT)
  let fd: number | null = null
  try {
    fd = fs.openSync(fs.realpathSync(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    if (!fs.fstatSync(fd).isFile()) return null
    let executable = true
    try {
      fs.accessSync(file, fs.constants.X_OK)
    } catch {
      executable = false
    }
    const buf = Buffer.alloc(L.startScriptShebangBytes)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return { executable, shebang: parseShebang(buf.subarray(0, n).toString('utf8')) }
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** The command for a session, or null when there is nothing to run. `shell`: the user's (`$SHELL`). */
export function resolveRun(settings: Pick<ProjectSettings, 'runCommand'>, script: StartScript | null, shell: string): RunTarget | null {
  const configured = settings.runCommand?.trim()
  if (configured) return { source: 'runCommand', command: { argv: [shell, '-l', '-c', configured] }, label: configured }
  if (!script) return null
  if (script.executable) return { source: 'startScript', command: { argv: [`./${START_SCRIPT}`] }, label: START_SCRIPT }
  const argv = script.shebang ? [...script.shebang, START_SCRIPT] : [FALLBACK_INTERPRETER, START_SCRIPT]
  return { source: 'startScript', command: { argv }, label: START_SCRIPT }
}

/** What the control is shown for. */
export function runSource(settings: Pick<ProjectSettings, 'runCommand'>, script: StartScript | null): ServerSource {
  return settings.runCommand?.trim() ? 'runCommand' : script ? 'startScript' : 'none'
}
