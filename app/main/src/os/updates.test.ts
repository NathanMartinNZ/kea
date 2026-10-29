// How each install is updated, on both systems: the macOS updater where it can replace the bundle, install.sh with the
// reason otherwise; on Linux the system's updates for a deb with Kea's apt source, install.sh for everything else
// (an rpm while its repository is not published), read from temp roots; os-release's ids; the install kind with
// `--user`; the package watch settling after a rename; the report's update line.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAvailable, L } from '@kea/protocol'
import { LINUX_REPO_FILES } from '@kea/protocol/os/linux'
import { updateChannelLine } from '../platformLines.ts'
import { darwin, macUpdateHow } from './darwin.ts'
import type { UpdateHowInput } from './index.ts'
import { linux, linuxUpdateHow, osReleaseIds, packageFamily, readLinuxInstallKind } from './linux.ts'

const REPO = 'NathanMartinNZ/kea'
const SH = 'curl -fsSL https://github.com/NathanMartinNZ/kea/releases/latest/download/install.sh | sh'
const input = (o: Partial<UpdateHowInput>): UpdateHowInput => ({ kind: null, repository: REPO, defaultHome: true, resourcesDir: '/x/resources', ...o })

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
  vi.useRealTimers()
})
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-os-updates-'))
  dirs.push(d)
  return d
}
/** A system root with these files. */
function root(files: Record<string, string>): string {
  const r = tmp()
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true })
    fs.writeFileSync(path.join(r, f), text)
  }
  return r
}

describe('how a Mac install is updated', () => {
  it('U-DST-32 · the updater for a release app in a folder Kea can change, for the default home; install.sh with the reason otherwise; nothing for a build not from a release', () => {
    const ok = { writable: true, translocated: false }
    expect(macUpdateHow(input({ kind: 'mac' }), ok)).toEqual({ mode: 'updater', auto: true, command: SH, why: null })
    expect(macUpdateHow(input({ kind: 'mac' }), { writable: false, translocated: false })).toMatchObject({ mode: 'command', auto: true, command: SH, why: expect.stringMatching(/cannot change the folder/) })
    expect(macUpdateHow(input({ kind: 'mac' }), { writable: true, translocated: true })).toMatchObject({ mode: 'command', why: expect.stringMatching(/move Kea to Applications/) })
    expect(macUpdateHow(input({ kind: 'mac', defaultHome: false }), ok)).toMatchObject({ mode: 'command', auto: false, why: expect.stringMatching(/home of its own/) })
    for (const o of [{ kind: null }, { kind: 'mac' as const, repository: null }]) expect(macUpdateHow(input(o), ok)).toEqual({ mode: 'none', auto: false, command: null, why: null })
    expect(darwin.updates.releaseFile('mac')).toBe('zip')
    expect(darwin.updates.releaseFile(null)).toBeNull()
    expect(isAvailable(darwin.packageWatch), 'a watch that follows nothing').toBe(true)
  })
})

describe('how a Linux install is updated', () => {
  it('U-DST-33 · a deb with Kea’s apt source: the system’s updates; with add_repository=no, or without the source: install.sh --no-repo', () => {
    const apt = 'sudo apt update && sudo apt install --only-upgrade kea-app'
    expect(linuxUpdateHow(input({ kind: 'deb' }), root({ [LINUX_REPO_FILES.aptSource]: 'Types: deb' }))).toEqual({ mode: 'packageManager', auto: false, command: apt, why: null })
    expect(linuxUpdateHow(input({ kind: 'deb' }), root({ [LINUX_REPO_FILES.aptSource]: 'Types: deb', [LINUX_REPO_FILES.defaults]: '# Kea\nadd_repository=no\n' }))).toEqual({ mode: 'command', auto: true, command: `${SH} -s -- --no-repo`, why: null })
    expect(linuxUpdateHow(input({ kind: 'deb' }), root({}))).toMatchObject({ mode: 'command', command: `${SH} -s -- --no-repo` })
  })

  it('U-DST-34 · an rpm is install.sh --no-repo while the rpm repository is unpublished, whatever repository file is there; once published, dnf’s or zypper’s by the family os-release names', () => {
    const fedora = root({ '/etc/os-release': 'ID=fedora\n', [LINUX_REPO_FILES.rpmRepo]: '[kea-app]' })
    const suse = root({ '/usr/lib/os-release': 'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n', [LINUX_REPO_FILES.zypperRepo]: '[kea-app]' })
    const suseWithDnfFile = root({ '/etc/os-release': 'ID=opensuse-leap\nID_LIKE="suse opensuse"\n', [LINUX_REPO_FILES.rpmRepo]: '[kea-app]' })
    expect(linuxUpdateHow(input({ kind: 'rpm' }), fedora)).toMatchObject({ mode: 'command', auto: true, command: `${SH} -s -- --no-repo` })
    expect(linuxUpdateHow(input({ kind: 'rpm' }), fedora, true)).toEqual({ mode: 'packageManager', auto: false, command: 'sudo dnf upgrade kea-app', why: null })
    expect(linuxUpdateHow(input({ kind: 'rpm' }), suse, true)).toEqual({ mode: 'packageManager', auto: false, command: 'sudo zypper update kea-app', why: null })
    expect(linuxUpdateHow(input({ kind: 'rpm' }), suseWithDnfFile, true), 'zypper reads only zypp/repos.d').toMatchObject({ mode: 'command' })
  })

  it('U-DST-35 · a tarball is install.sh, a --user tree install.sh --user; a build not from a release, or no repository, nothing', () => {
    expect(linuxUpdateHow(input({ kind: 'tarball' }), root({}))).toEqual({ mode: 'command', auto: true, command: SH, why: null })
    expect(linuxUpdateHow(input({ kind: 'user' }), root({}))).toEqual({ mode: 'command', auto: true, command: `${SH} -s -- --user`, why: null })
    expect(linuxUpdateHow(input({ kind: null }), root({}))).toMatchObject({ mode: 'none' })
    expect(linuxUpdateHow(input({ kind: 'deb', repository: null }), root({}))).toMatchObject({ mode: 'none' })
    expect(linux.updates.releaseFile('user')).toBe('tarball')
    expect(linux.updates.releaseFile('deb')).toBe('deb')
    expect(linux.updates.loadUpdater('/dist')).toBeNull()
  })

  it('U-PLT-64 · os-release’s ID then ID_LIKE’s words, lower-cased and unquoted; the package family as install.sh reads it', () => {
    expect(osReleaseIds('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n')).toEqual(['ubuntu', 'debian'])
    expect(osReleaseIds('ID="Rocky"\nID_LIKE="rhel centos fedora"\n')).toEqual(['rocky', 'rhel', 'centos', 'fedora'])
    expect(osReleaseIds('# none\n')).toEqual([])
    expect(packageFamily(['linuxmint', 'ubuntu', 'debian'])).toBe('apt')
    expect(packageFamily(['rocky', 'rhel', 'centos', 'fedora'])).toBe('dnf')
    expect(packageFamily(['opensuse-tumbleweed', 'opensuse', 'suse'])).toBe('zypper')
    expect(packageFamily(['sles'])).toBe('zypper')
    expect(packageFamily(['arch'])).toBeNull()
  })

  it('U-PLT-65 · the install kind from resources/install-kind, a tarball under the home folder being --user’s; none for a dev build or a word it does not know', () => {
    const home = tmp()
    const inHome = path.join(home, '.local', 'share', 'kea-app', 'resources')
    fs.mkdirSync(inHome, { recursive: true })
    fs.writeFileSync(path.join(inHome, 'install-kind'), 'tarball\n')
    expect(readLinuxInstallKind(inHome, home)).toBe('user')
    const opt = tmp()
    fs.writeFileSync(path.join(opt, 'install-kind'), 'tarball')
    expect(readLinuxInstallKind(opt, home)).toBe('tarball')
    fs.writeFileSync(path.join(opt, 'install-kind'), 'deb')
    expect(readLinuxInstallKind(opt, home)).toBe('deb')
    for (const word of ['mac', 'snap', '']) {
      fs.writeFileSync(path.join(opt, 'install-kind'), word)
      expect(readLinuxInstallKind(opt, home), word).toBeNull()
    }
    expect(readLinuxInstallKind(tmp(), home)).toBeNull()
  })

  it('U-DST-36 · the package watch settles once after a package manager’s renames in resources/, and its end stops it', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'app.asar'), 'old')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const settled = vi.fn()
    const failed = vi.fn()
    const end = (linux.packageWatch as { watch: (d: string, s: () => void, f: (e: unknown) => void) => () => void }).watch(dir, settled, failed)
    fs.writeFileSync(path.join(dir, 'app.asar.dpkg-new'), 'new')
    fs.renameSync(path.join(dir, 'app.asar.dpkg-new'), path.join(dir, 'app.asar'))
    // the change has arrived once its settle timer is set; it settles after L.packageSettleMs with no further change
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
    expect(settled).not.toHaveBeenCalled()
    vi.advanceTimersByTime(L.packageSettleMs)
    expect(settled).toHaveBeenCalledTimes(1)
    end()
    fs.writeFileSync(path.join(dir, 'app.asar'), 'newer')
    vi.advanceTimersByTime(60_000)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    const missing = vi.fn()
    ;(linux.packageWatch as { watch: (d: string, s: () => void, f: (e: unknown) => void) => () => void }).watch(path.join(dir, 'nope'), settled, missing)
    expect(missing).toHaveBeenCalledTimes(1)
  })

  it('U-DST-37 · the report’s update line says who updates this Kea', () => {
    expect(updateChannelLine({ mode: 'updater', auto: true, command: SH, why: null })).toEqual({ id: 'updateChannel', label: 'Updates', value: 'Kea updates itself', fix: null })
    expect(updateChannelLine({ mode: 'packageManager', auto: false, command: 'x', why: null }).value).toMatch(/system's updates/)
    expect(updateChannelLine({ mode: 'command', auto: true, command: SH, why: null }).value).toBe('install.sh, run again; Kea checks for a newer version by itself')
    expect(updateChannelLine({ mode: 'none', auto: false, command: null, why: null }).value).toMatch(/not installed from a release/)
  })
})
