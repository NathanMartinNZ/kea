// Finding editors and terminal apps where an app is a command (Linux): on the login shell's PATH, in the places
// their packages put them (the host's `knownPlaces`), and through their desktop entries in the XDG data folders. What
// is found is run by its path, with argv (argv.ts), never through a shell.
//
// Where a command may be, as for a macOS bundle: never inside a project's root or a session's working directory, by the
// place it was found at (its folders resolved) or by its real path. A PATH can name a repository's folder (a tool that
// adds `node_modules/.bin`), and a link anywhere can lead into one; neither is ever run.
//
// A desktop entry's `Exec` program is the app's window process: for an editor it may stay running as long as the
// editor does, so it only says where the editor is installed, and what is run is its command-line tool beside it
// (`LinuxEditorDef.cliFromExec`). A terminal app is started detached anyway, so its entry's program is run itself when
// it is one of its commands.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '@kea/kit'
import { L } from '@kea/protocol'
import type { Env } from '../terminal/shellEnv.ts'
import { EDITOR_DEFS, LINUX_TERMINAL_APP_DEFS, type EditorDef, type LinuxTerminalAppDef } from './catalog.ts'
import { execProgram, parseDesktopEntry } from './desktop.ts'
import type { CommandHost } from './host.ts'

const within = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep)

function executableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `file` as it may be run, or null: an executable file whose place (its folders resolved) and real path both lie outside
 * `off` (the projects' roots and the sessions' working directories, real paths). The file is run by the path it was
 * found at.
 */
export async function usableCommand(file: string, off: readonly string[]): Promise<string | null> {
  if (!path.isAbsolute(file) || !executableFile(file)) return null
  let real: string
  let place: string
  try {
    real = await fsp.realpath(file)
    place = path.join(await fsp.realpath(path.dirname(file)), path.basename(file))
  } catch {
    return null
  }
  return off.some((d) => within(d, place) || within(d, real)) ? null : file
}

/**
 * A desktop entry's text, or null when `file` is not a regular file of at most L.desktopEntryMaxBytes. It runs on
 * core's thread and the user's data folder is writable by any process of theirs, so nothing here may wait: the file is
 * opened where it really is (a link is followed, as Flatpak's exported entries are links), without following a link put
 * there since and without waiting (`O_NONBLOCK`: opening a FIFO for reading waits for a writer), and what was opened is
 * looked at (`inspectStartScript`'s way, server/command.ts).
 */
function readEntry(file: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(fs.realpathSync(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > L.desktopEntryMaxBytes) return null
    return fs.readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** The first `<dir>/applications/<id>.desktop` of `dataDirs` that is a readable entry (`readEntry`); null when none is. */
export function findDesktopEntry(dataDirs: readonly string[], id: string): { file: string; text: string } | null {
  for (const dir of dataDirs) {
    const file = path.join(dir, 'applications', `${id}.desktop`)
    const text = readEntry(file)
    if (text !== null) return { file, text }
  }
  return null
}

/** The program an installed, application-type desktop entry `id` starts (absolute), or null. */
function entryProgram(dataDirs: readonly string[], id: string): string | null {
  const found = findDesktopEntry(dataDirs, id)
  if (!found) return null
  const e = parseDesktopEntry(found.text)
  if (!e.application || e.hidden || !e.exec) return null
  if (e.tryExec !== null && path.isAbsolute(e.tryExec) && !executableFile(e.tryExec)) return null
  const program = execProgram(e.exec)
  // a program named without its folder is on the PATH, where the command itself is looked for first
  return program !== null && path.isAbsolute(program) ? program : null
}

export interface CommandsDetected {
  editors: { def: EditorDef; app: string }[]
  terminalApps: { def: LinuxTerminalAppDef; app: string }[]
}

/**
 * What a command host has installed: for each catalog entry, the first usable of its commands on the PATH, in its known
 * places, then what its desktop entries point at. `off` are real paths (the repositories).
 */
export async function detectCommands(host: CommandHost, env: Readonly<Env>, off: readonly string[], log?: Logger): Promise<CommandsDetected> {
  const dataDirs = host.dataDirs(env)
  const onPath = (command: string): string[] => {
    if (!host.searchPath) return []
    return (env.PATH ?? '')
      .split(path.delimiter)
      .filter((d) => path.isAbsolute(d))
      .map((d) => path.join(d, command))
  }
  const first = async (candidates: readonly string[]): Promise<string | null> => {
    for (const c of new Set(candidates)) {
      const ok = await usableCommand(c, off)
      if (ok !== null) return ok
    }
    return null
  }
  const commandCandidates = (commands: readonly string[]): string[] => commands.flatMap((c) => [...onPath(c), ...host.knownPlaces(c)])

  const editors: CommandsDetected['editors'] = []
  for (const def of EDITOR_DEFS) {
    const fromEntries: string[] = []
    for (const id of def.linux.desktopIds) {
      const program = entryProgram(dataDirs, id)
      if (program === null) continue
      const dir = path.dirname(await fsp.realpath(program).catch(() => program))
      for (const rel of def.linux.cliFromExec) fromEntries.push(path.resolve(dir, rel))
    }
    const app = await first([...commandCandidates(def.linux.commands), ...fromEntries])
    if (app !== null) editors.push({ def, app })
  }
  // every one found, not the first only: the setting may name any of them, and a change of it needs no new lookup
  const terminalApps: CommandsDetected['terminalApps'] = []
  for (const def of LINUX_TERMINAL_APP_DEFS) {
    const fromEntries = def.desktopIds.map((id) => entryProgram(dataDirs, id)).filter((p): p is string => p !== null && def.commands.includes(path.basename(p)))
    const app = await first([...commandCandidates(def.commands), ...fromEntries])
    if (app !== null) terminalApps.push({ def, app })
  }
  log?.debug('editor lookup (commands)', { editors: editors.length, terminalApps: terminalApps.length })
  return { editors, terminalApps }
}
