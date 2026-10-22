// macOS's side of core's OS layer (index.ts).
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '@kea/kit'
import { L } from '@kea/protocol'
import { TERMINAL_APP_DEFS } from '../editor/catalog.ts'
import { lsofArgs, parseLsofHolder } from '../server/scan.ts'
import type { CoreOs } from './index.ts'

// ── backupExclude: Time Machine's sticky exclusion ───────────────────────────────────────────

/** The extended attribute that is Time Machine's sticky exclusion of an item: what `tmutil addexclusion <item>` sets. */
export const BACKUP_EXCLUDE_ATTR = 'com.apple.metadata:com_apple_backup_excludeItem'
/** Its value: the binary property list of the string `com.apple.backupd`, as `tmutil` writes it. */
const BACKUP_EXCLUDE_VALUE = Buffer.concat([
  Buffer.from('bplist00', 'latin1'),
  Buffer.from([0x5f, 0x10, 0x11]),
  Buffer.from('com.apple.backupd', 'latin1'),
  Buffer.from([0x08, 0, 0, 0, 0, 0, 0, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x1c]),
]).toString('hex')

/**
 * The attribute is written directly (`/usr/bin/xattr`), not by `tmutil addexclusion`: tmutil also waits for the backup
 * daemon, up to 11 s for each folder when that does not answer, and an archive waits for this.
 */
async function markExcluded(paths: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  return runProcess('/usr/bin/xattr', ['-wx', BACKUP_EXCLUDE_ATTR, BACKUP_EXCLUDE_VALUE, ...paths], { pool: 'other', collect: true }).catch((e: Error) => ({ code: null, stderr: e.message }))
}

// ── mounts: `mount`'s output ─────────────────────────────────────────────────────────────────

/** Volume types that are network ones in `mount`'s output. */
const NETWORK_TYPES = new Set(['smbfs', 'nfs', 'afpfs', 'webdav', 'cifs', 'ftp', 'macfuse', 'osxfuse', 'fuse', 'sshfs', 'autofs'])

/** Which mounted volume `root` lies on is a network one, from `mount`'s output; null: none, a local disk. */
export function mountOutputNetworkMount(mountOutput: string, root: string): string | null {
  let best: { point: string; type: string } | null = null
  for (const line of mountOutput.split('\n')) {
    // `<device> on <mount point> (<type>, <flag>, …)`; a mount point may hold spaces and " on "
    const open = line.lastIndexOf(' (')
    const on = line.indexOf(' on ')
    if (on < 0 || open < on) continue
    const type = line.slice(open + 2).split(/[,)]/, 1)[0]?.trim() ?? ''
    for (let at = on; at >= 0 && at < open; at = line.indexOf(' on ', at + 1)) {
      const point = line.slice(at + 4, open)
      if (!point.startsWith('/')) continue
      if ((root === point || root.startsWith(point === '/' ? '/' : `${point}/`)) && (!best || point.length > best.point.length)) best = { point, type }
    }
  }
  return best && NETWORK_TYPES.has(best.type) ? best.point : null
}

export const darwin: CoreOs = {
  system: 'darwin',
  // Spotlight, `/Applications`, `~/Applications` and the system's own utilities (Terminal)
  editors: {
    kind: 'bundles',
    appDirs: (home) => ['/Applications', path.join(home, 'Applications'), '/System/Applications/Utilities', '/System/Applications'],
    mdfind: '/usr/bin/mdfind',
    open: '/usr/bin/open',
    // the viewer's list is every system's (viewer/openable.ts); macOS adds none
    neverOpened: [],
    fileManager: 'Finder',
    terminalApps: TERMINAL_APP_DEFS.map((d) => d.id),
  },
  // macOS 15 and later; `-s`: say nothing
  trash: { tool: '/usr/bin/trash', args: (file) => ['-s', file], missing: null },
  mounts: {
    read: () =>
      runProcess('/sbin/mount', [], { pool: 'other', timeoutMs: L.watchStartTimeoutMs, collect: true })
        .then((r) => (r.stdout ?? Buffer.alloc(0)).toString('utf8'))
        .catch(() => ''),
    networkMount: mountOutputNetworkMount,
    volumeRoots: () => ['/Volumes'],
  },
  // the port range lies below macOS's ephemeral ports (49152…)
  portRange: { range: () => ({ start: L.portRangeStart, end: L.portRangeEnd }), cut: () => null },
  backupExclude: { mark: markExcluded },
  // macOS ships `/usr/bin/git` as a stub that opens the Command Line Tools installer when they are missing; it is used
  // only once `xcode-select -p` answers
  gitProbe: {
    paths: { stub: '/usr/bin/git', xcodeSelect: '/usr/bin/xcode-select' },
    installHint: 'Install Xcode Command Line Tools (xcode-select --install) to use git',
    notFound: 'git was not found on your login shell’s PATH',
  },
  shellDefaults: {
    shell: '/bin/zsh',
    path: '/usr/bin:/bin:/usr/sbin:/sbin',
    extraPath: (home) => ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`],
    lang: () => 'en_US.UTF-8',
  },
  // `lsof -nP -iTCP:<port> -sTCP:LISTEN`: the first process it names
  portOwner: {
    holder: async (port, o) => {
      const res = await o.run('/usr/sbin/lsof', lsofArgs(port), { pool: 'ports', env: { LC_ALL: 'C', PATH: '/usr/sbin:/usr/bin:/bin' }, timeoutMs: L.portHolderTimeoutMs, maxBytes: L.portScanMaxBytes })
      const named = parseLsofHolder(res.stdout?.toString('utf8') ?? '')
      return named ? { kind: 'process', ...named } : null
    },
  },
  // FSEvents through the binding built from Kea's patch at install (its fixes are of the shared code; the FSEvents
  // backend is as upstream wrote it), else the prebuild; no limit core meets
  watcher: { bindingPackage: (arch) => `@parcel/watcher-darwin-${arch}`, patchedBuild: 'build/Release/watcher.node', backend: null, recursiveFsWatch: true, limits: null, exclusionsMax: L.watchExclusionsMax },
  // O_EXLOCK (<fcntl.h>; Node does not export it)
  spoolLock: { openFlag: 0x20 },
  report: { systemLine: () => `${os.type()} ${os.release()} ${process.arch}` },
}
