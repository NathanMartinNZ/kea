// Linux's side of core's OS layer (index.ts). `backupExclude` is not available here on purpose: no Linux backup tool
// honours one marker.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { L, notAvailable } from '@kea/protocol'
import { LINUX_TERMINAL_APP_DEFS } from '../editor/catalog.ts'
import type { CommandEditors, CoreOs, WatchLimitKind, WatchLimits } from './index.ts'

// ── editors ──────────────────────────────────────────────────────────────────────────────

/** Where an editor's packages put its command when it is not on the login PATH, by command. */
function knownPlaces(command: string, home: string): string[] {
  switch (command) {
    case 'code':
      return ['/usr/share/code/bin/code', '/snap/bin/code']
    case 'code-insiders':
      return ['/usr/share/code-insiders/bin/code-insiders', '/snap/bin/code-insiders']
    case 'zed':
      return [path.join(home, '.local', 'bin', 'zed')]
    case 'zeditor':
      return ['/usr/bin/zeditor']
    default:
      return []
  }
}

/** The XDG base directories' data folders (`$XDG_DATA_HOME`, then `$XDG_DATA_DIRS`, with the spec's defaults). */
function dataDirs(env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  const own = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  const system = (env.XDG_DATA_DIRS ?? '').split(':').filter((d) => path.isAbsolute(d))
  return [...new Set([own, ...(system.length ? system : ['/usr/local/share', '/usr/share'])])]
}

const linuxEditors: CommandEditors = {
  kind: 'commands',
  knownPlaces,
  dataDirs,
  open: '/usr/bin/xdg-open',
  // the viewer's deny-list on Linux: what a desktop runs, installs or adds when it is opened
  neverOpened: ['desktop', 'appimage', 'run', 'deb', 'rpm', 'snap', 'flatpak', 'flatpakref'],
  fileManager: 'File Manager',
  terminalApps: LINUX_TERMINAL_APP_DEFS.map((d) => d.id),
}

// ── portRange ─────────────────────────────────────────────────────────────────────────────

/** The sysctl that sets the ephemeral range, as the banner names it. */
const PORT_RANGE_SETTING = 'net.ipv4.ip_local_port_range'

/** `/proc/sys/net/ipv4/ip_local_port_range`: `<low>\t<high>`; null when it does not read as two ports, low first. */
export function parseLocalPortRange(text: string): { low: number; high: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text)
  if (!m) return null
  const low = Number(m[1])
  const high = Number(m[2])
  return low >= 1 && low <= high && high <= 0xffff ? { low, high } : null
}

/**
 * The port range, cut to end below `low` (the ephemeral range's first port); the whole range when it is
 * unknown.
 */
export function allocatableRange(low: number | null): { start: number; end: number } {
  return { start: L.portRangeStart, end: low === null ? L.portRangeEnd : Math.min(L.portRangeEnd, low - 1) }
}

/** Read once: Kea allocates from what the range was when it started. */
let ephemeral: { low: number; high: number } | null | undefined

function ephemeralRange(): { low: number; high: number } | null {
  if (ephemeral === undefined) {
    try {
      ephemeral = parseLocalPortRange(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'))
    } catch {
      ephemeral = null
    }
  }
  return ephemeral
}

// ── trash ─────────────────────────────────────────────────────────────────────────────────

/** GLib's `gio` (present wherever GNOME or GTK is); never trash-cli's `trash`, whose flags differ. */
const GIO = '/usr/bin/gio'

// ── mounts ────────────────────────────────────────────────────────────────────────────────

/** File system types of network volumes in `/proc/self/mountinfo`. */
const NETWORK_TYPES = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'fuse.sshfs', '9p', 'afs', 'ceph'])

/** A field of `mountinfo` with the kernel's octal escapes (`\040` space, `\011` tab, `\012` newline, `\134` `\`) undone. */
function unescapeMountField(f: string): string {
  return f.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

/**
 * `/proc/self/mountinfo` (proc(5)): each mount's point and file system type, in the order listed. A line:
 * `id parent major:minor root mountpoint options [optional…] - type source superoptions`.
 */
export function parseMountinfo(text: string): { point: string; type: string }[] {
  const out: { point: string; type: string }[] = []
  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ')
    if (sep < 0) continue
    const point = line.slice(0, sep).split(' ')[4]
    const type = line.slice(sep + 3).split(' ')[0]
    if (!point?.startsWith('/') || !type) continue
    out.push({ point: unescapeMountField(point), type })
  }
  return out
}

/** The network volume `root` lies on, from `mountinfo`: the deepest mount point holding it (the last one listed wins). */
export function mountinfoNetworkMount(text: string, root: string): string | null {
  let best: { point: string; type: string } | null = null
  for (const m of parseMountinfo(text)) {
    const holds = root === m.point || root.startsWith(m.point === '/' ? '/' : `${m.point}/`)
    if (holds && (!best || m.point.length >= best.point.length)) best = m
  }
  return best && NETWORK_TYPES.has(best.type) ? best.point : null
}

/** Where volumes are mounted for this user, the link checks' places: udisks's two folders and `/mnt`. */
function volumeRoots(): string[] {
  let user: string | null = null
  try {
    user = os.userInfo().username
  } catch {
    // no passwd entry: only the folder every user shares
  }
  return [...(user ? [`/media/${user}`, `/run/media/${user}`] : []), '/mnt']
}

// ── shellDefaults ─────────────────────────────────────────────────────────────────────────

/** `struct locarhead`'s magic (glibc's `locarchive.h`). */
const LOCALE_ARCHIVE_MAGIC = 0xde020109
/** The header's words read: magic, serial, then the name hash table's and the string table's offset, used and size. */
const ARCHIVE_HEAD_WORDS = 8
const WORD = 4
/** One `struct namehashent`: hash value, name offset, locale record offset. */
const NAMEHASH_ENTRY_WORDS = 3

/**
 * The locales a glibc `locale-archive` holds (what `locale -a` lists from it), read through `readAt(position, length)`
 * in three reads: the header, the name hash table and the string table. Little-endian, as every Linux target of Kea.
 * Empty for anything that is not an archive or does not hold together.
 */
export function localeArchiveNames(readAt: (position: number, length: number) => Buffer, size: number): string[] {
  const head = readAt(0, ARCHIVE_HEAD_WORDS * WORD)
  if (head.length < ARCHIVE_HEAD_WORDS * WORD || head.readUInt32LE(0) !== LOCALE_ARCHIVE_MAGIC) return []
  const [hashOffset, , hashSize, stringOffset, stringUsed] = [2, 3, 4, 5, 6].map((i) => head.readUInt32LE(i * WORD)) as [number, number, number, number, number]
  const hashBytes = hashSize * NAMEHASH_ENTRY_WORDS * WORD
  if (hashOffset + hashBytes > size || stringOffset + stringUsed > size) return []
  const table = readAt(hashOffset, hashBytes)
  const strings = readAt(stringOffset, stringUsed)
  const names: string[] = []
  for (let at = 0; at + NAMEHASH_ENTRY_WORDS * WORD <= table.length; at += NAMEHASH_ENTRY_WORDS * WORD) {
    const nameOffset = table.readUInt32LE(at + WORD)
    const record = table.readUInt32LE(at + 2 * WORD)
    if (record === 0 || nameOffset < stringOffset || nameOffset >= stringOffset + stringUsed) continue
    const from = nameOffset - stringOffset
    const end = strings.indexOf(0, from)
    names.push(strings.toString('utf8', from, end < 0 ? strings.length : end))
  }
  return names
}

/** The locale glibc finds for `en_US.UTF-8` (its codeset normalised: `en_US.utf8`). */
const PREFERRED_LANG = 'en_US.UTF-8'
const PREFERRED_LOCALE = 'en_US.utf8'
/** Built into glibc since 2.35 (the glibc floor), so always there. */
const BUILTIN_LANG = 'C.UTF-8'
const LOCALE_DIR = '/usr/lib/locale'

/** Whether glibc has `en_US.UTF-8`: a folder of its own (Fedora's langpacks) or an entry of the archive (Debian, Ubuntu). */
function preferredLocaleInstalled(): boolean {
  if (fs.existsSync(path.join(LOCALE_DIR, PREFERRED_LOCALE))) return true
  let fd: number | null = null
  try {
    fd = fs.openSync(path.join(LOCALE_DIR, 'locale-archive'), 'r')
    const file = fd
    const size = fs.fstatSync(file).size
    const readAt = (position: number, length: number): Buffer => {
      const b = Buffer.alloc(length)
      return b.subarray(0, fs.readSync(file, b, 0, length, position))
    }
    return localeArchiveNames(readAt, size).some((n) => n === PREFERRED_LOCALE || n === PREFERRED_LANG)
  } catch {
    return false
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** Looked up once, the first time a terminal needs it. */
let defaultLang: string | undefined

/** The login shell when no environment names one: the passwd entry's, else `/bin/sh` (not zsh, which many lack). */
function passwdShell(): string {
  try {
    const shell = os.userInfo().shell
    if (shell && path.isAbsolute(shell)) return shell
  } catch {
    // no passwd entry
  }
  return '/bin/sh'
}

// ── watcher ───────────────────────────────────────────────────────────────────────────────

/** Where the kernel keeps inotify's per-user limits (the first user namespace's). */
const INOTIFY_SYSCTL = '/proc/sys/fs/inotify'
/** The same limits as the user namespace Kea runs in sets them (a container's, a sandbox's): the lower of the two holds. */
const USER_SYSCTL = '/proc/sys/user'
/** How a descriptor of an inotify instance reads (`readlink /proc/<pid>/fd/<n>`). */
const INOTIFY_LINK = 'anon_inode:inotify'
/** `ENOSPC` from `inotify_add_watch` at `max_user_watches`: the watcher's error is a plain `Error` with no `code`. */
const ENOSPC_ERROR = /^inotify_add_watch on '[\s\S]*' failed: No space left on device$/
/** The patched backend's start at `max_user_instances`: `inotify_init1` fails with `EMFILE`. */
const EMFILE_ERROR = /^Unable to initialize inotify: Too many open files$/

/** The watches an inotify descriptor's `fdinfo` lists (one `inotify wd:` line each). */
export function inotifyWatchesIn(fdinfo: string): number {
  let n = 0
  for (const line of fdinfo.split('\n')) if (line.startsWith('inotify wd:')) n++
  return n
}

/** Which of inotify's limits a watcher's error is at; null for any other error. */
export function watchLimitOf(message: string): WatchLimitKind | null {
  if (ENOSPC_ERROR.test(message)) return 'watches'
  if (EMFILE_ERROR.test(message)) return 'instances'
  return null
}

async function readCount(file: string): Promise<number | null> {
  const n = Number((await fs.promises.readFile(file, 'utf8').catch(() => '')).trim())
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** A process's inotify descriptors (`/proc/<pid>/fd`); none when they cannot be read (another user's, a non-dumpable holder's). */
async function inotifyFds(pid: string): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const fds = await fs.promises.readdir(dir).catch(() => [] as string[])
  const links = await Promise.all(fds.map((fd) => fs.promises.readlink(path.join(dir, fd)).then((l) => (l === INOTIFY_LINK ? fd : null), () => null)))
  return links.filter((fd): fd is string => fd !== null)
}

function inotifySetting(kind: WatchLimitKind): string {
  return kind === 'watches' ? 'fs.inotify.max_user_watches' : 'fs.inotify.max_user_instances'
}

/** The lower of two limits; one that cannot be read does not count. */
function lower(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b)
}

const inotifyLimits: WatchLimits = {
  max: async () => {
    const [watches, instances, nsWatches, nsInstances] = await Promise.all([
      readCount(`${INOTIFY_SYSCTL}/max_user_watches`),
      readCount(`${INOTIFY_SYSCTL}/max_user_instances`),
      readCount(`${USER_SYSCTL}/max_inotify_watches`),
      readCount(`${USER_SYSCTL}/max_inotify_instances`),
    ])
    const w = lower(watches, nsWatches)
    const i = lower(instances, nsInstances)
    return w === null || i === null ? null : { watches: w, instances: i }
  },
  userInstances: async () => {
    const uid = process.getuid?.()
    const pids = (await fs.promises.readdir('/proc').catch(() => [] as string[])).filter((p) => /^\d+$/.test(p))
    const counts = await Promise.all(
      pids.map(async (pid) => {
        const st = await fs.promises.stat(`/proc/${pid}`).catch(() => null)
        return st && st.uid === uid ? (await inotifyFds(pid)).length : 0
      }),
    )
    return counts.reduce((a, b) => a + b, 0)
  },
  ownWatches: async () => {
    const fds = await inotifyFds('self')
    const infos = await Promise.all(fds.map((fd) => fs.promises.readFile(`/proc/self/fdinfo/${fd}`, 'utf8').catch(() => '')))
    return infos.reduce((n, info) => n + inotifyWatchesIn(info), 0)
  },
  limitOf: watchLimitOf,
  setting: inotifySetting,
  fix: (kind) => {
    const value = kind === 'watches' ? L.inotifyWatchesSuggested : L.inotifyInstancesSuggested
    return `Raise it: sudo sysctl ${inotifySetting(kind)}=${value}, and add that line to a file in /etc/sysctl.d to keep it after a restart.`
  },
}

// ── portOwner ─────────────────────────────────────────────────────────────────────────────

/**
 * `kea-helper ports --all`'s lines for `port`: the first process of this user's that listens on it (its pid), else
 * `otherUser` when another user's process does (a line with `-` for its pid), else null.
 */
export function portHolderOf(out: string, port: number): { pid: number } | 'otherUser' | null {
  let other = false
  for (const line of out.split('\n')) {
    const w = line.trim().split(/\s+/)
    if (w.length !== 4 || (w[1] !== 'tcp4' && w[1] !== 'tcp6') || Number(w[3]) !== port) continue
    if (w[0] === '-') other = true
    else if (/^\d+$/.test(w[0] as string)) return { pid: Number(w[0]) }
  }
  return other ? 'otherUser' : null
}

/** A process's name as `lsof` gave it on macOS: its executable's file name, else its `comm` (15 characters at most). */
async function processName(pid: number): Promise<string> {
  try {
    return path.basename((await fs.promises.readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, ''))
  } catch {
    return (await fs.promises.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim()
  }
}

export const linux: CoreOs = {
  system: 'linux',
  editors: linuxEditors,
  trash: { tool: GIO, args: (file) => ['trash', '--', file], missing: `GLib's gio (${GIO}) is not installed: Kea moves files to the trash with gio trash` },
  mounts: {
    read: () => fs.promises.readFile('/proc/self/mountinfo', 'utf8').catch(() => ''),
    networkMount: mountinfoNetworkMount,
    volumeRoots,
  },
  // blocks only below the ephemeral range (by default 32768…): from L.portRangeStart up to its first port
  portRange: {
    range: () => allocatableRange(ephemeralRange()?.low ?? null),
    cut: () => {
      const r = ephemeralRange()
      return r && r.low <= L.portRangeEnd ? { setting: PORT_RANGE_SETTING, low: r.low } : null
    },
  },
  backupExclude: notAvailable('Linux has no system backup to keep Kea\'s folders out of.'),
  // `/usr/bin/git` is the real git: no stub to look behind
  gitProbe: { paths: null, installHint: `Install git ${L.gitMinMajor}.${L.gitMinMinor} or later with your package manager`, notFound: `Install git ${L.gitMinMajor}.${L.gitMinMinor} or later with your package manager` },
  shellDefaults: {
    get shell() {
      return passwdShell()
    },
    path: '/usr/local/bin:/usr/bin:/bin',
    extraPath: (home) => ['/usr/local/bin', `${home}/.local/bin`, `${home}/.cargo/bin`, '/home/linuxbrew/.linuxbrew/bin', '/snap/bin'],
    lang: () => (defaultLang ??= preferredLocaleInstalled() ? PREFERRED_LANG : BUILTIN_LANG),
  },
  // the helper scans every process of this user, as its port scan does one server's; `lsof` is often missing
  portOwner: {
    holder: async (port, o) => {
      if (o.helper === null) return null
      const res = await o.run(o.helper, ['ports', '--all'], { pool: 'ports', env: {}, timeoutMs: L.portHolderTimeoutMs, maxBytes: L.portScanMaxBytes })
      const found = portHolderOf(res.stdout?.toString('utf8') ?? '', port)
      if (found === null) return null
      return found === 'otherUser' ? { kind: 'otherUser' } : { kind: 'process', pid: found.pid, name: await processName(found.pid) }
    },
  },
  // inotify through the binding built from Kea's patch at install, else the prebuild with core's guard
  watcher: {
    bindingPackage: (arch) => `@parcel/watcher-linux-${arch}-glibc`,
    patchedBuild: 'build/Release/watcher.node',
    backend: 'inotify',
    recursiveFsWatch: false,
    limits: inotifyLimits,
    exclusionsMax: null,
  },
  spoolLock: notAvailable('Linux has no O_EXLOCK and Node no flock, so core renames a spool without the hook\'s lock: the hook looks again after its write instead.'),
  // the kernel's own words: the same calls answer on every system
  report: { systemLine: () => `${os.type()} ${os.release()} ${process.arch}` },
}
