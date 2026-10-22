// Crash-safe file replacement: write a temp file in the same directory, fsync it, rename it over the
// target, then fsync the directory so the rename itself is durable. A reader sees the old content or
// the new, never a torn file; a failure leaves the target untouched and no temp file behind.
// (macOS `fsync` reaches the drive cache, not the platter; F_FULLFSYNC is not used — power-loss
// durability is not a goal, crash consistency is.)

import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export interface AtomicWriteOptions {
  /** File mode for the new file (e.g. 0o600). Default: the existing file's mode, else 0o666 & ~umask. */
  mode?: number
}

function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
}

function existingMode(path: string): number | undefined {
  try {
    return fs.statSync(path).mode & 0o7777
  } catch {
    return undefined
  }
}

async function existingModeAsync(path: string): Promise<number | undefined> {
  try {
    return (await fs.promises.stat(path)).mode & 0o7777
  } catch {
    return undefined
  }
}

function fsyncDirSync(dir: string): void {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const h = await fs.promises.open(dir, 'r')
  try {
    await h.sync()
  } finally {
    await h.close()
  }
}

/** Atomically replace `path` with `data` (synchronous). */
export function atomicWriteSync(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  const tmp = tempPathFor(path)
  const mode = opts.mode ?? existingMode(path)
  let fd: number | undefined
  try {
    fd = fs.openSync(tmp, 'wx', mode ?? 0o666)
    if (mode !== undefined) fs.fchmodSync(fd, mode)
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, path)
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // already failing
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      // never created, or already renamed
    }
    throw err
  }
  fsyncDirSync(dirname(path))
}

/** Atomically replace `path` with `data`. */
export async function atomicWrite(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): Promise<void> {
  const tmp = tempPathFor(path)
  const mode = opts.mode ?? (await existingModeAsync(path))
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(tmp, 'wx', mode ?? 0o666)
    if (mode !== undefined) await handle.chmod(mode)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.promises.rename(tmp, path)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fs.promises.unlink(tmp).catch(() => {})
    throw err
  }
  await fsyncDir(dirname(path))
}
