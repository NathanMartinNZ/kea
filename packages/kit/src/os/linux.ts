// Linux's side of the kit's OS layer (index.ts).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { L } from '@kea/protocol/limits'
import { toDisposable, type Disposable } from '../disposable.ts'
import { ensurePrivateDir } from '../privateDir.ts'
import type { KitOs } from './index.ts'

/**
 * `$XDG_RUNTIME_DIR` when it is the user's own: absolute, a real directory (by `lstat`) owned by this user and
 * closed to everyone else, as the XDG spec requires; the helper's `os::runtime_dir` is the same rule.
 */
export function xdgRuntimeDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.XDG_RUNTIME_DIR
  if (!dir || !path.isAbsolute(dir)) return null
  try {
    const st = fs.lstatSync(dir)
    return st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0 ? dir : null
  } catch {
    return null
  }
}

// ── instanceLock ────────────────────────────────────────────────────────────────────────────

/** util-linux's `flock(1)`, in every distribution Kea supports; `/bin` where `/usr` is not merged. */
const FLOCK_TOOLS = ['/usr/bin/flock', '/bin/flock']
/** `flock --nonblock`'s exit status when another open file description holds the lock (its `--conflict-exit-code`). */
const FLOCK_CONFLICT = 1
/** The lock's descriptor in `flock`'s process: the first after stdin, stdout and stderr. */
const LOCK_FD = 3

/**
 * A `flock` on the file `lockPath` (created 0600 if missing, never written, never removed), in a directory that must be
 * this user's and closed to everyone else (`ensurePrivateDir`, the run dir's check: no other user can make or take the
 * file). Node has no `flock`, but a `flock` belongs to the open file description, not to the process that took it: this
 * process opens the file (close-on-exec, so no child of Kea's ever shares it), `flock -n -x 3` locks that description
 * through the descriptor it is handed and exits, and the lock lives as long as this process's own descriptor: until
 * disposed, or until the process ends, however it ends. Null when another open file description, this process's or
 * another's, holds it. Deleting the file while another process waits on its path would split the lock, so it stays. One
 * short child at start, run synchronously and not through `runProcess` (the only child Kea starts that way): the lock
 * must be held before anything else runs, and the child needs the descriptor as its fd 3.
 */
function tryLock(lockPath: string): Disposable | null {
  ensurePrivateDir(path.dirname(lockPath))
  const tool = FLOCK_TOOLS.find((f) => fs.existsSync(f))
  if (!tool) throw new Error(`the instance lock needs util-linux's flock (${FLOCK_TOOLS.join(' or ')})`)
  const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
  let r: ReturnType<typeof spawnSync>
  try {
    r = spawnSync(tool, ['--nonblock', '--exclusive', String(LOCK_FD)], { stdio: ['ignore', 'ignore', 'pipe', fd], env: {}, timeout: L.instanceLockTimeoutMs, killSignal: 'SIGKILL' })
  } catch (err) {
    fs.closeSync(fd)
    throw err
  }
  if (r.status === 0) return toDisposable(() => fs.closeSync(fd))
  fs.closeSync(fd)
  if (r.status === FLOCK_CONFLICT) return null
  throw new Error(`${tool} on ${lockPath}: ${r.error?.message ?? (r.stderr?.toString().trim() || `exit ${r.status}, signal ${r.signal}`)}`)
}

// ── holderVisibility ──────────────────────────────────────────────────────────────────────

/** `hidepid` values that show every process (the kernel's default). */
const HIDEPID_OFF = new Set(['0', 'off'])

/**
 * `/proc/self/mountinfo` → the `hidepid` of the mount at `/proc` (the last one listed: an over-mount hides those below),
 * when it hides a user's non-dumpable processes from it; null when it shows them or no `proc` is mounted there.
 * A line: `id parent major:minor root mountpoint options [optional…] - type source superoptions`.
 */
export function procHidepid(mountinfo: string): string | null {
  let hidden: string | null = null
  for (const line of mountinfo.split('\n')) {
    const sep = line.indexOf(' - ')
    if (sep < 0 || line.slice(0, sep).split(' ')[4] !== '/proc') continue
    const [type, , options] = line.slice(sep + 3).split(' ')
    if (type !== 'proc') continue
    const v = options?.split(',').find((o) => o.startsWith('hidepid='))?.slice('hidepid='.length)
    hidden = v !== undefined && !HIDEPID_OFF.has(v) ? v : null
  }
  return hidden
}

// ── backgroundIo ─────────────────────────────────────────────────────────────────────────

/** util-linux's `ionice` (essential on every supported distribution); without it kit's trash uses `fs.rm`. */
const IONICE = '/usr/bin/ionice'
/** `ionice -c 3`: the idle I/O scheduling class, which an unprivileged user may choose. */
const IONICE_IDLE = '3'

/** Read once: a mount option does not change under a running Kea that matters to it. */
let hidepid: string | null | undefined

export const linux: KitOs = {
  system: 'linux',
  instanceLock: { tryLock },
  holderVisibility: {
    hidden: () => {
      if (hidepid === undefined) {
        try {
          hidepid = procHidepid(fs.readFileSync('/proc/self/mountinfo', 'utf8'))
        } catch {
          hidepid = null
        }
      }
      return hidepid
    },
  },
  // util-linux's `ionice`, idle class: the command's I/O waits for everyone else's (as `taskpolicy -b` on macOS)
  backgroundIo: { argv: (file, args) => ({ file: IONICE, args: ['-c', IONICE_IDLE, file, ...args] }) },
  // ext4 and btrfs keep a name's bytes: file operations use the name as stored, NFC only as a key
  nameKey: { key: (name) => name.normalize('NFC'), fileName: (name) => name, asStored: true },
  // Electron's appData is the XDG config folder (base::nix's: an absolute `$XDG_CONFIG_HOME`, else `$HOME/.config`)
  paths: {
    appData: (o, name) => {
      const xdg = o.env.XDG_CONFIG_HOME
      return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(o.env.HOME || o.accountHome, '.config'), name)
    },
  },
  // the user's own tmpfs, not aged by systemd-tmpfiles as /tmp is
  runtimeDir: { dir: () => xdgRuntimeDir() },
}
