// Where `pnpm kea:install` puts the app: `/Applications/Kea.app` when no switch names another place, or `<dir>/Kea.app`
// for `--install-to <dir>`, the test target. The test target exists so that every test of the install step runs against
// a folder the test made: it is never an Applications folder, and only it accepts a perf-probe build.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { need } from '../../../packages/protocol/src/platform.ts'
import { packOs } from './os/index.ts'

export const APP_NAME = 'Kea.app'
/** What the packaged app is to macOS: its bundle id, under which LaunchServices keeps every path it was launched from. */
export const APP_ID = 'dev.kea.app'
/**
 * The one place a build is installed for use (the same path and signature keep macOS's grants). Asked when
 * needed, so the module also loads where `pnpm kea:install` has no place (Linux, which installs from packages).
 */
export function installedApp(): string {
  return need(packOs.installPlace).installedApp(APP_NAME)
}

export interface InstallTarget {
  /** The bundle path the install replaces. */
  app: string
  /** `--install-to`: a folder of a test's own. Kea is never opened again there, and its home is never `~/.kea`. */
  test: boolean
}

/** `p` with every symlink in its existing part resolved (the rest kept as written). */
export function resolveExisting(p: string): string {
  const abs = path.resolve(p)
  const rest: string[] = []
  for (let cur = abs; ; cur = path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync(cur), ...rest)
    } catch {
      if (path.dirname(cur) === cur) return abs
      rest.unshift(path.basename(cur))
    }
  }
}

const isInside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)

/** The Applications folders `--install-to` and `--out` must stay out of: the system's and the user's, as written and resolved. */
export function applicationsFolders(homedir: string = os.homedir()): string[] {
  const dirs = need(packOs.installPlace).folders(homedir)
  return [...new Set([...dirs, ...dirs.map(resolveExisting)])]
}

/**
 * What a path is, whatever it is called: its device and inode (`stat` only, symlinks followed). Null when nothing is
 * there. Read as bigints: the sealed system volume's inodes are past 2^53, where two folders round to the same number.
 */
function identity(p: string): string | null {
  try {
    const st = fs.statSync(p, { bigint: true })
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

/**
 * The Applications folder `p` is or lies in, or null. A name proves nothing here: `/applications` (a case-insensitive
 * volume) and `/System/Volumes/Data/Applications` (the data volume's own path) are /Applications itself and no
 * symlink, so nothing resolves them to it. Every folder on the way to `p`, as written and with its symlinks resolved,
 * is therefore compared with each Applications folder by device and inode; the names are compared too, for a folder
 * that is not there (yet). Only `stat` and `realpath` ever touch the folders.
 */
export function applicationsFolderOf(p: string, homedir: string = os.homedir()): string | null {
  const folders = applicationsFolders(homedir)
  const ids = new Map<string, string>()
  for (const f of folders) {
    const id = identity(f)
    if (id !== null && !ids.has(id)) ids.set(id, f)
  }
  for (const spelling of new Set([path.resolve(p), resolveExisting(p)])) {
    const named = folders.find((f) => isInside(spelling, f))
    if (named) return named
    for (let cur = spelling; ; cur = path.dirname(cur)) {
      const id = identity(cur)
      const same = id === null ? undefined : ids.get(id)
      if (same) return same
      if (path.dirname(cur) === cur) break
    }
  }
  return null
}

/** Why `dir` cannot be the folder of a test target, or null. An Applications folder is refused by any spelling (`applicationsFolderOf`). */
export function testTargetProblem(dir: string, homedir: string = os.homedir()): string | null {
  if (!path.isAbsolute(dir)) return 'it must be an absolute path'
  const spellings = [path.resolve(dir), resolveExisting(dir)]
  const apps = applicationsFolderOf(dir, homedir)
  if (apps) return `it is in ${apps}: only the default install (no switch) goes there`
  if (spellings.some((s) => s.split(path.sep).some((part) => part.endsWith('.app')))) return 'it is inside an app bundle'
  let st: fs.Stats
  try {
    st = fs.statSync(dir)
  } catch {
    return 'it does not exist (make the folder first: nothing is created for a test target)'
  }
  if (!st.isDirectory()) return 'it is not a folder'
  return null
}

/** The install target: the default, or the test target named by `--install-to`. Throws with the reason when that is refused. */
export function resolveTarget(installTo: string | null, homedir: string = os.homedir()): InstallTarget {
  if (installTo === null) return { app: installedApp(), test: false }
  const why = testTargetProblem(installTo, homedir)
  if (why) throw new Error(`--install-to ${installTo}: ${why}`)
  return { app: path.join(resolveExisting(installTo), APP_NAME), test: true }
}
