// Fast removal of big directories: a removed worktree and rebuildable folders. `moveToTrash` is a same-volume rename
// into a trash directory — instant, atomic, and the original path is free at once — and the actual deletion happens
// later, asynchronously, at background I/O priority. A rename that would cross volumes fails with `CrossDeviceError`;
// it is never silently turned into a copy.

import fs from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { isAvailable } from '@kea/protocol/platform'
import { ulid, ULID_RE } from './ids.ts'
import { kitOs } from './os/index.ts'
import { runProcess, SpawnError } from './runProcess.ts'

const RM = '/bin/rm'

/** The path and the trash directory are on different volumes (EXDEV). */
export class CrossDeviceError extends Error {
  readonly code = 'EXDEV'
  readonly path: string
  readonly trashDir: string
  constructor(path: string, trashDir: string, cause: unknown) {
    super(`moveToTrash: ${path} and ${trashDir} are on different volumes (EXDEV); refusing to copy`, { cause })
    this.name = 'CrossDeviceError'
    this.path = path
    this.trashDir = trashDir
  }
}

/** Make `trashDir` (0700) if it is not there; true when this call made it. */
async function ensureTrashDir(trashDir: string): Promise<boolean> {
  const created = await fs.promises.mkdir(trashDir, { recursive: true, mode: 0o700 })
  if (created === undefined) return false
  await fs.promises.chmod(trashDir, 0o700)
  return true
}

export interface MoveToTrashOptions {
  /**
   * Told when this move made `trashDir` (it was not there): core marks a worktree root's trash for Time Machine then.
   */
  made?: (trashDir: string) => void
}

/**
 * Rename `path` into `trashDir/<ulid>` (creating `trashDir` 0700) and return the new path.
 * Throws `CrossDeviceError` if the two are on different volumes, and the rename's own error otherwise.
 */
export async function moveToTrash(path: string, trashDir: string, opts: MoveToTrashOptions = {}): Promise<string> {
  if (await ensureTrashDir(trashDir)) opts.made?.(trashDir)
  const dest = join(trashDir, ulid())
  try {
    await fs.promises.rename(path, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') throw new CrossDeviceError(path, trashDir, err)
    throw err
  }
  return dest
}

function assertDeletable(path: string): void {
  const n = normalize(path)
  if (!isAbsolute(path) || n !== path.replace(/\/+$/, '') || n.split('/').filter(Boolean).length < 2) {
    throw new Error(`emptyTrashEntry: refusing to delete "${path}" (must be an absolute, normalised path at least two levels deep)`)
  }
}

/**
 * Delete a trash entry recursively at low I/O priority: `rm -rf` through the OS layer's `backgroundIo` (macOS
 * `taskpolicy -b`, Linux `ionice -c 3`) on the `other` pool, falling back to `fs.rm` when that is unavailable or fails.
 */
export async function emptyTrashEntry(path: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
  assertDeletable(path)
  const bg = isAvailable(kitOs.backgroundIo) ? kitOs.backgroundIo.argv(RM, ['-rf', '--', path]) : null
  if (bg) {
    try {
      const res = await runProcess(bg.file, bg.args, {
        pool: 'other',
        collect: false,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      if (res.cancelled) return
      if (res.code === 0 && !fs.existsSync(path)) return
    } catch (err) {
      if (!(err instanceof SpawnError)) throw err
    }
  }
  await fs.promises.rm(path, { recursive: true, force: true })
}

/**
 * Delete what `moveToTrash` left in `trashDir` (launch-time cleanup): its ULID-named entries only, so a directory that
 * is not Kea's own (a root set to a folder with a trash of its own) loses nothing else. Returns how many.
 */
export async function emptyTrash(trashDir: string, opts: { signal?: AbortSignal } = {}): Promise<number> {
  let names: string[]
  try {
    names = await fs.promises.readdir(trashDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  let n = 0
  for (const name of names) {
    if (opts.signal?.aborted) break
    if (!ULID_RE.test(name)) continue
    await emptyTrashEntry(join(trashDir, name), opts)
    n++
  }
  return n
}
