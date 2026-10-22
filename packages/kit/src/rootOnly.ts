// Whether only root can change a file: on Linux it decides whether holders check their client by its executable in full
// (ptyhost's `--client-exe`, else `--client-exe-unchecked`) and what the platform report says of session isolation.
// Plain POSIX ownership and modes, the same on every system.
import fs from 'node:fs'
import path from 'node:path'

/** The parts of `fs` the check reads (a test passes its own). */
export interface StatFs {
  realpathSync(p: string): string
  statSync(p: string): { uid: number; mode: number; isFile(): boolean; isDirectory(): boolean }
}

/** Owned by root and writable by no one else (no group or other write bit). */
const rootsAlone = (st: { uid: number; mode: number }): boolean => st.uid === 0 && (st.mode & 0o022) === 0

/**
 * `file`, by its real path, is a regular file root owns and no one else may write, and so is every folder from it up
 * to `/` (the holder's own check, `os::linux` `Chains`, is the same rule). Anything that cannot be read is no.
 */
export function rootOnlyFile(file: string, f: StatFs = fs): boolean {
  try {
    const real = f.realpathSync(file)
    const st = f.statSync(real)
    if (!st.isFile() || !rootsAlone(st)) return false
    for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
      const ds = f.statSync(dir)
      if (!ds.isDirectory() || !rootsAlone(ds)) return false
      if (dir === path.dirname(dir)) return true
    }
  } catch {
    return false
  }
}
