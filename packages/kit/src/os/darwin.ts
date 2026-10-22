// macOS's side of the kit's OS layer (index.ts).
import fs from 'node:fs'
import path from 'node:path'
import { toDisposable } from '../disposable.ts'
import type { Disposable } from '../disposable.ts'
import type { KitOs } from './index.ts'

/** Darwin's <fcntl.h> values; Node does not export O_EXLOCK. */
const DARWIN_O_EXLOCK = 0x20
const DARWIN_O_NONBLOCK = 0x4

const consts = fs.constants as typeof fs.constants & { O_EXLOCK?: number }

function lockFlags(): number {
  const exlock = consts.O_EXLOCK ?? DARWIN_O_EXLOCK
  const nonblock = consts.O_NONBLOCK ?? DARWIN_O_NONBLOCK
  return fs.constants.O_RDWR | fs.constants.O_CREAT | exlock | nonblock
}

/**
 * A BSD `flock` taken atomically at open (`O_EXLOCK | O_NONBLOCK`) on `path` (created 0600 if missing). It lives as
 * long as the file descriptor, so it is released when disposed or when the process dies, however it dies. Null when
 * another open file description (this process or another) holds it. The holder's pid is written into the file for
 * diagnostics.
 */
function tryLock(file: string): Disposable | null {
  let fd: number
  try {
    fd = fs.openSync(file, lockFlags(), 0o600)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return null
    throw err
  }
  try {
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, `${process.pid}\n`, 0)
  } catch {
    // The pid is only a diagnostic; the lock is what matters.
  }
  return toDisposable(() => fs.closeSync(fd))
}

const TASKPOLICY = '/usr/bin/taskpolicy'

export const darwin: KitOs = {
  system: 'darwin',
  instanceLock: { tryLock },
  // no /proc: `kea-helper procs` sees every process of the user
  holderVisibility: { hidden: () => null },
  // `taskpolicy -b`: background CPU and I/O priority for the command it runs
  backgroundIo: { argv: (file, args) => ({ file: TASKPOLICY, args: ['-b', file, ...args] }) },
  // APFS ignores normalisation: NFC for comparing and for file operations alike
  nameKey: { key: (name) => name.normalize('NFC'), fileName: (name) => name.normalize('NFC'), asStored: false },
  paths: { appData: (o, name) => path.join(o.accountHome, 'Library', 'Application Support', name) },
  // none: a long home's sockets go to /tmp/kea-<uid>
  runtimeDir: { dir: () => null },
}
