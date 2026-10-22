// Linux's side of core's OS layer where it is pure enough to check on any system, against what an Ubuntu 24.04
// VM gave (fixtures/os/linux/), beside macOS's answers to the same questions. The parts that need Linux
// itself (its passwd shell, its locales, a process's name in /proc) run only there.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryLogger, runProcess } from '@kea/kit'
import { L, need, serverHintText } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { backupWriter, excludeFromBackup } from '../worktrees/backup.ts'
import { findGit } from '../worktrees/git.ts'
import { blockBases, portBlocksBanner } from '../server/ports.ts'
import { gitExclusions, pickExclusions, WORKTREE_EXCLUSIONS } from '../platform/watch/exclusions.ts'
import { darwin } from './darwin.ts'
import { coreOs } from './index.ts'
import { allocatableRange, linux, localeArchiveNames, mountinfoNetworkMount, parseLocalPortRange, parseMountinfo, portHolderOf } from './linux.ts'

const FIXTURES = path.resolve(import.meta.dirname, '../../../../fixtures/os/linux')
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

/** A glibc `locale-archive` holding `names` (struct locarhead, then the name hash table, then the strings), with one empty slot. */
function localeArchive(names: string[]): Buffer {
  const HEAD = 8 * 4
  const slots = names.length + 1
  const hashOffset = HEAD
  const stringOffset = hashOffset + slots * 12
  const strings = Buffer.from(names.map((n) => `${n}\0`).join(''), 'utf8')
  const b = Buffer.alloc(stringOffset + strings.length)
  ;[0xde020109, 0, hashOffset, names.length, slots, stringOffset, strings.length, strings.length].forEach((w, i) => b.writeUInt32LE(w, i * 4))
  let at = 0
  names.forEach((n, i) => {
    const slot = hashOffset + (i + 1) * 12 // slot 0 stays empty: a record offset of 0
    b.writeUInt32LE(i + 1, slot)
    b.writeUInt32LE(stringOffset + at, slot + 4)
    b.writeUInt32LE(0x1000 * (i + 1), slot + 8)
    at += Buffer.byteLength(n) + 1
  })
  strings.copy(b, stringOffset)
  return b
}

const readerOf = (b: Buffer) => (position: number, length: number) => b.subarray(position, position + length)

describe("core's OS layer on Linux", () => {
  it('U-PLT-50 · kernel exclusions per stream: FSEvents takes at most watch_exclusions_max (a ninth turns every one off); inotify’s ignore paths have no limit, so on Linux every candidate is excluded, a directory that does not exist yet too', () => {
    const mac = need(darwin.watcher).exclusionsMax
    const lin = need(linux.watcher).exclusionsMax
    expect([mac, lin]).toEqual([L.watchExclusionsMax, null])
    const all = WORKTREE_EXCLUSIONS.length
    expect(all).toBeGreaterThan(L.watchExclusionsMax)
    // every candidate a directory, then none there yet (`uv venv .venv` after the stream started)
    for (const kind of ['dir', 'none'] as const) {
      expect(pickExclusions('/w', WORKTREE_EXCLUSIONS, () => kind, mac), kind).toHaveLength(L.watchExclusionsMax)
      expect(pickExclusions('/w', WORKTREE_EXCLUSIONS, () => kind, lin), kind).toEqual(WORKTREE_EXCLUSIONS.map((n) => `/w/${n}`))
    }
    // a git work tree: `.git` and each candidate git ignores whole, uncut on Linux
    const ignored = WORKTREE_EXCLUSIONS.filter((n) => n !== '.git')
    expect(gitExclusions('/w', WORKTREE_EXCLUSIONS, ignored, () => 'dir', lin)).toHaveLength(all)
    expect(gitExclusions('/w', WORKTREE_EXCLUSIONS, ignored, () => 'dir', mac)).toHaveLength(L.watchExclusionsMax)
  })

  it("U-PLT-5 · ip_local_port_range → the blocks below the ephemeral range; fewer than port_blocks_min raises a banner naming the setting; macOS's range is whole, uncut", () => {
    const recorded = parseLocalPortRange(fixture('ip_local_port_range'))
    expect(recorded).toEqual({ low: 32768, high: 60999 })
    for (const bad of ['', '32768', 'a b', '0 60999', '60999 32768', '32768 70000']) expect(parseLocalPortRange(bad), bad).toBeNull()

    // the stock range: blocks from L.portRangeStart up to 32767, far more than the minimum, no banner
    const stock = allocatableRange(recorded!.low)
    expect(stock).toEqual({ start: L.portRangeStart, end: 32767 })
    expect(blockBases(stock.start, stock.end)).toHaveLength(Math.floor((32768 - L.portRangeStart) / L.portBlockSize))
    expect(blockBases(stock.start, stock.end).at(-1)! + L.portBlockSize - 1).toBeLessThan(recorded!.low)
    expect(portBlocksBanner(stock, { setting: 'net.ipv4.ip_local_port_range', low: recorded!.low })).toBeNull()

    // moved down: one block short of the minimum, then none at all; one more block and it is enough again
    const short = L.portRangeStart + (L.portBlocksMin - 1) * L.portBlockSize
    expect(portBlocksBanner(allocatableRange(short), { setting: 'net.ipv4.ip_local_port_range', low: short })).toEqual({
      kind: 'portBlocks',
      source: 'ports',
      severity: 'warning',
      message: `Only ${L.portBlocksMin - 1} port blocks fit below the system's ephemeral ports (from ${short}), so sessions past that many get no KEA_PORT.`,
      fix: 'Move the ephemeral range higher with sysctl net.ipv4.ip_local_port_range, then restart Kea.',
    })
    expect(portBlocksBanner(allocatableRange(1024), { setting: 'x', low: 1024 })?.message).toMatch(/^Only 0 port blocks/)
    expect(portBlocksBanner(allocatableRange(short + L.portBlockSize), { setting: 'x', low: short + L.portBlockSize })).toBeNull()
    // above the port range, or unknown: the whole range
    expect(allocatableRange(60000)).toEqual({ start: L.portRangeStart, end: L.portRangeEnd })
    expect(allocatableRange(null)).toEqual({ start: L.portRangeStart, end: L.portRangeEnd })

    expect(darwin.portRange.range()).toEqual({ start: L.portRangeStart, end: L.portRangeEnd })
    expect(darwin.portRange.cut()).toBeNull()
    if (coreOs.system === 'linux') {
      // this machine's own range: cut where its ephemeral ports begin
      const own = parseLocalPortRange(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'))!
      expect(linux.portRange.range()).toEqual(allocatableRange(own.low))
      expect(linux.portRange.cut()).toEqual(own.low <= L.portRangeEnd ? { setting: 'net.ipv4.ip_local_port_range', low: own.low } : null)
    }
  })

  it('U-PLT-7 · mountinfo: network file systems found by type (the deepest mount point holding a path wins), local ones not, escaped points read back; volumes under /media, /run/media and /mnt; macOS reads `mount` as before', () => {
    const recorded = fixture('mountinfo')
    const mounts = parseMountinfo(recorded)
    expect(mounts.find((m) => m.point === '/')).toEqual({ point: '/', type: 'ext4' })
    expect(mounts.at(-1), 'a point with spaces, written \\040 by the kernel').toEqual({ point: '/mnt/work on nfs', type: 'tmpfs' })
    expect(mounts.filter((m) => m.point === '/proc/sys/fs/binfmt_misc').map((m) => m.type), 'mounted twice, in order').toEqual(['autofs', 'binfmt_misc'])
    // nothing the VM had is a network volume
    for (const p of ['/', '/home/someone/repo', '/run/user/1001/gvfs/x', '/mnt/work on nfs/repo', '/snap/core24/2125']) expect(mountinfoNetworkMount(recorded, p), p).toBeNull()

    // the same table with network file systems mounted (lines as proc(5) writes them; the VM had no share to mount)
    const shares = [
      '700 617 0:70 / /mnt/nfs rw,relatime master:90 - nfs nas:/export rw,vers=3',
      '701 617 0:71 / /srv/team\\040share rw,relatime - nfs4 nas:/team rw,vers=4.2',
      '702 617 0:72 / /home/someone/smb rw,nosuid,nodev - cifs //nas/home rw,vers=3.1.1',
      '703 617 0:73 / /home/someone/smb3 rw - smb3 //nas/home rw',
      '704 617 0:74 / /home/someone/box rw,nosuid,nodev - fuse.sshfs someone@box: rw,user_id=1000',
      '705 617 0:75 / /mnt/host rw - 9p host rw,trans=virtio',
      '706 617 0:76 / /afs rw - afs AFS rw',
      '707 617 0:77 / /mnt/ceph rw - ceph 10.0.0.1:/ rw',
      '708 700 0:78 / /mnt/nfs/scratch rw - tmpfs tmpfs rw', // a local mount inside a share: local
    ].join('\n')
    const table = `${recorded}${shares}\n`
    expect(mountinfoNetworkMount(table, '/mnt/nfs/repo')).toBe('/mnt/nfs')
    expect(mountinfoNetworkMount(table, '/mnt/nfs')).toBe('/mnt/nfs')
    expect(mountinfoNetworkMount(table, '/srv/team share/repo')).toBe('/srv/team share')
    for (const p of ['/home/someone/smb/a', '/home/someone/smb3', '/home/someone/box/x', '/mnt/host/y', '/afs/cell', '/mnt/ceph/z']) expect(mountinfoNetworkMount(table, p), p).not.toBeNull()
    expect(mountinfoNetworkMount(table, '/mnt/nfs/scratch/x'), 'the deepest mount decides').toBeNull()
    expect(mountinfoNetworkMount(table, '/mnt/nfsx/repo'), 'a prefix is not a parent').toBeNull()
    expect(mountinfoNetworkMount(table, '/home/someone/repo')).toBeNull()

    // where volumes are mounted: the link checks' places
    const user = os.userInfo().username
    expect(need(linux.mounts).volumeRoots()).toEqual([`/media/${user}`, `/run/media/${user}`, '/mnt'])
    expect(need(darwin.mounts).volumeRoots()).toEqual(['/Volumes'])
    // macOS's `mount` output, read by its own parser
    const mac = ['/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)', 'nas:/export on /Volumes/work on nfs (nfs, nodev, nosuid, automounted)'].join('\n') // os-ok: test data
    expect(need(darwin.mounts).networkMount(mac, '/Volumes/work on nfs/repo')).toBe('/Volumes/work on nfs')
    expect(need(darwin.mounts).networkMount(mac, '/Users/someone/repo')).toBeNull()
  })

  it("U-PLT-25 · who holds a port: `kea-helper ports --all`'s lines name this user's process by its pid, another user's as `otherUser` (a hint of its own), nothing else as null; on Linux the process is named by its executable", async () => {
    const out = [`${process.pid} tcp4 127.0.0.1 4100`, '- tcp6 :: 22', '- tcp4 0.0.0.0 22', `${process.pid} tcp6 ::1 4101`, 'kea-helper: noise', '7 udp4 0.0.0.0 4102', ''].join('\n')
    expect(portHolderOf(out, 4100)).toEqual({ pid: process.pid })
    expect(portHolderOf(out, 4101)).toEqual({ pid: process.pid })
    expect(portHolderOf(out, 22)).toBe('otherUser')
    expect(portHolderOf(out, 4102), 'not a TCP listener').toBeNull()
    expect(portHolderOf(out, 9)).toBeNull()
    expect(portHolderOf(`- tcp4 0.0.0.0 5000\n42 tcp4 127.0.0.1 5000\n`, 5000), "this user's process wins over another's on the other address").toEqual({ pid: 42 })
    expect(serverHintText({ port: 22, holder: { kind: 'otherUser' } })).toBe("Port 22 is held by another user's process")

    // the capability, given a stand-in for the helper's run
    const runs: { file: string; args: readonly string[]; pool: unknown }[] = []
    const run = (async (file: string, args: readonly string[], o: { pool: unknown }) => {
      runs.push({ file, args, pool: o.pool })
      return { code: 0, stdout: Buffer.from(out), stderr: Buffer.alloc(0), timedOut: false, cancelled: false, signal: null }
    }) as unknown as typeof runProcess
    const holder = need(linux.portOwner).holder
    expect(await holder(4100, { helper: null, run })).toBeNull()
    expect(runs, 'no helper, no run').toEqual([])
    expect(await holder(22, { helper: '/kea/kea-helper', run })).toEqual({ kind: 'otherUser' })
    expect(await holder(9, { helper: '/kea/kea-helper', run })).toBeNull()
    expect(runs[0]).toEqual({ file: '/kea/kea-helper', args: ['ports', '--all'], pool: 'ports' })
    if (coreOs.system === 'linux') {
      // named as macOS's lsof names it: the executable's file name
      expect(await holder(4100, { helper: '/kea/kea-helper', run })).toEqual({ kind: 'process', pid: process.pid, name: path.basename(fs.realpathSync(process.execPath)) })
    }
  })

  it("U-PLT-26 · shell defaults: the passwd entry's shell, else /bin/sh; the fallback PATH and the tool folders; LANG en_US.UTF-8 when glibc has it (its locale archive or a folder), else C.UTF-8; macOS's as before", async () => {
    const sh = need(linux.shellDefaults)
    expect(sh.path).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(sh.extraPath('/home/k')).toEqual(['/usr/local/bin', '/home/k/.local/bin', '/home/k/.cargo/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin'])
    expect(sh.shell.startsWith('/')).toBe(true)
    const mac = need(darwin.shellDefaults)
    expect([mac.shell, mac.path, mac.extraPath('/Users/k'), mac.lang()]).toEqual(['/bin/zsh', '/usr/bin:/bin:/usr/sbin:/sbin', ['/opt/homebrew/bin', '/usr/local/bin', '/Users/k/.local/bin'], 'en_US.UTF-8'])

    // a locale archive, read as `locale -a` lists it
    const archive = localeArchive(['C.utf8', 'en_US.utf8', 'de_DE.utf8'])
    expect(localeArchiveNames(readerOf(archive), archive.length)).toEqual(['C.utf8', 'en_US.utf8', 'de_DE.utf8'])
    const notOne = Buffer.from(archive)
    notOne.writeUInt32LE(0x12345678, 0)
    expect(localeArchiveNames(readerOf(notOne), notOne.length), 'not an archive').toEqual([])
    expect(localeArchiveNames(readerOf(archive.subarray(0, 40)), 40), 'cut short').toEqual([])
    expect(localeArchiveNames(readerOf(Buffer.alloc(0)), 0)).toEqual([])

    if (coreOs.system === 'linux') {
      let passwd: string | null = null
      try {
        passwd = os.userInfo().shell
      } catch {
        // no passwd entry
      }
      expect(sh.shell).toBe(passwd && path.isAbsolute(passwd) ? passwd : '/bin/sh')
      // what glibc itself lists
      const r = await runProcess('/usr/bin/locale', ['-a'], { pool: 'other', collect: true, env: { PATH: '/usr/bin:/bin' } })
      const listed = (r.stdout?.toString('utf8') ?? '').split('\n')
      expect(sh.lang()).toBe(listed.includes('en_US.utf8') ? 'en_US.UTF-8' : 'C.UTF-8')
    }
  })

  it("U-PLT-28 · the trash is gio's `trash --` on Linux and a refusal without it names gio; nothing is marked for backups there (no writer for Kea's folders); git has no stub: the first git on the PATH is the one, and none says how to install it; macOS's trash, backups and git stub as before", async () => {
    const [lt, dt] = [need(linux.trash), need(darwin.trash)]
    expect([lt.tool, lt.args('/w/a b.txt')]).toEqual(['/usr/bin/gio', ['trash', '--', '/w/a b.txt']])
    expect(lt.missing).toBe("GLib's gio (/usr/bin/gio) is not installed: Kea moves files to the trash with gio trash")
    expect([dt.tool, dt.args('/w/a b.txt'), dt.missing]).toEqual(['/usr/bin/trash', ['-s', '/w/a b.txt'], null])

    // Linux has no backup to keep folders out of, so core gets no writer and never records `backup.excluded`
    const log = createMemoryLogger({ process: 'core' })
    expect(backupWriter(log) === null, 'no writer').toBe(coreOs.system === 'linux')
    if (coreOs.system === 'linux') expect(await excludeFromBackup('/nowhere', ['node_modules'], log), 'a worktree’s folders: nothing marked').toBe(0)

    const git = need(linux.gitProbe)
    expect(git).toEqual({ paths: null, installHint: 'Install git 2.40 or later with your package manager', notFound: 'Install git 2.40 or later with your package manager' })
    expect(need(darwin.gitProbe).paths).toEqual({ stub: '/usr/bin/git', xcodeSelect: '/usr/bin/xcode-select' })

    // without a stub to look behind, the first executable git is used wherever it is, and no xcode-select runs
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-plt-28-')))
    try {
      const [a, b] = ['a', 'b'].map((n) => path.join(tmp, n)) as [string, string]
      for (const d of [a, b]) fs.mkdirSync(d)
      fs.writeFileSync(path.join(a, 'git'), '#!/bin/sh\n', { mode: 0o644 })
      fs.writeFileSync(path.join(b, 'git'), '#!/bin/sh\n', { mode: 0o755 })
      expect(await findGit([a, b].join(':'), null)).toEqual({ binary: path.join(b, 'git'), missing: null })
      expect(await findGit(a, null)).toEqual({ binary: null, missing: need(coreOs.gitProbe).notFound })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
