// Kea's Linux packages: the files and their modes, the scripts, the control file and the spec.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TARGETS } from '../config.ts'
import {
  afterInstall,
  afterRemove,
  apparmorProfile,
  aptSourceText,
  beforeRemove,
  artifactNames,
  debControl,
  desktopEntry,
  md5sums,
  packageVersion,
  ownsFolder,
  rootFiles,
  rpmRepoFile,
  rpmRepoText,
  rpmSpec,
  stageRoot,
  treeMode,
  zypperRepoText,
  type PackageMeta,
} from './linuxPackage.ts'
import { ACCEPTED_RPMLINT, lintProblems } from './linuxLint.ts'

const meta: PackageMeta = { version: '0.2.0-rc.1', description: 'Run many coding-agent CLI sessions side by side.', maintainer: 'Kea <kea-app@invalid>', repository: null, keyFile: null }
const withRepo: PackageMeta = { ...meta, repository: 'some-owner/kea', keyFile: '/k/kea-app.gpg' }
const arm = TARGETS['linux-arm64']
const x64 = TARGETS['linux-x64']

describe("Kea's Linux packages", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-lpkg-'))
    dirs.push(d)
    return d
  }

  // Every file outside the app's tree with its path and mode (the terminal's font among them); the repository's
  // files only with a repository and its key (rpm: the repo file; deb: the key, the source being the script's); names
  // and versions as the packages need them.
  it('U-PACK-33 · the file list: launcher, desktop file, icons, the terminal font, licences at their paths and modes; the repository’s files only when it is named', () => {
    const files = rootFiles({ meta, icons: '/i', fonts: '/f', launcher: '/l/kea-app.sh', licences: '/w/licenses.txt' })
    const by = new Map(files.map((f) => [f.path, f]))
    expect(by.get('/usr/bin/kea-app')).toEqual({ path: '/usr/bin/kea-app', mode: 0o755, from: '/l/kea-app.sh' })
    expect(by.get('/usr/share/applications/dev.kea.app.desktop')?.mode).toBe(0o644)
    for (const n of [16, 24, 32, 48, 64, 128, 256, 512]) expect(by.get(`/usr/share/icons/hicolor/${n}x${n}/apps/dev.kea.app.png`)).toEqual({ path: `/usr/share/icons/hicolor/${n}x${n}/apps/dev.kea.app.png`, mode: 0o644, from: `/i/png/${n}x${n}.png` })
    expect(by.get('/usr/share/icons/hicolor/scalable/apps/dev.kea.app.svg')?.from).toBe('/i/kea.svg')
    expect(files.filter((f) => f.path.includes('/fonts/')).length, 'the weights Kea uses, not the family').toBe(2)
    for (const f of ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf']) expect(by.get(`/usr/share/fonts/kea-app/${f}`)).toEqual({ path: `/usr/share/fonts/kea-app/${f}`, mode: 0o644, from: `/f/${f}` })
    expect(by.get('/usr/share/doc/kea-app/copyright')).toEqual({ path: '/usr/share/doc/kea-app/copyright', mode: 0o644, from: '/w/licenses.txt' })
    expect(files.some((f) => f.path.startsWith('/etc/'))).toBe(false)
    expect(rpmRepoFile(meta)).toBeNull()
    expect(rpmRepoFile({ ...meta, repository: 'some-owner/kea' }), 'a repository without its key adds nothing').toBeNull()

    const repo = rootFiles({ meta: withRepo, icons: '/i', fonts: '/f', launcher: '/l', licences: '/w' })
    expect(repo.find((f) => f.path === '/etc/yum.repos.d/kea-app.repo')).toMatchObject({ mode: 0o644, only: ['rpm'] })
    // the deb carries the key in its tree, and its script puts it where the source names it: a key that were the
    // package's own file would go with `apt remove` and leave the source naming a key that is gone (apt update fails)
    expect(repo.find((f) => f.path === '/opt/Kea/resources/kea-app.gpg')).toEqual({ path: '/opt/Kea/resources/kea-app.gpg', mode: 0o644, from: '/k/kea-app.gpg', only: ['deb'] })
    expect(repo.some((f) => f.path === '/usr/share/keyrings/kea-app.gpg')).toBe(false)
    expect(rpmRepoFile(withRepo)).toBe(
      ['[kea-app]', 'name=Kea', 'baseurl=https://some-owner.github.io/kea/rpm/$basearch', 'enabled=1', 'gpgcheck=1', 'repo_gpgcheck=1', 'gpgkey=https://github.com/some-owner/kea/releases/latest/download/kea-app.asc', ''].join('\n'),
    )
    // install.sh writes the same bytes, and zypper's own form of the repository
    expect(rpmRepoText('some-owner/kea', true)).toBe(rpmRepoFile(withRepo))
    expect(rpmRepoText('some-owner/kea', false)).toBe(rpmRepoFile(withRepo)!.replace('enabled=1', 'enabled=0'))
    expect(aptSourceText('some-owner/kea')).toBe(['Types: deb', 'URIs: https://github.com/some-owner/kea/releases/latest/download/', 'Suites: ./', 'Signed-By: /usr/share/keyrings/kea-app.gpg', ''].join('\n'))
    expect(zypperRepoText('some-owner/kea')).toBe(
      ['[kea-app]', 'name=Kea', 'enabled=1', 'autorefresh=1', 'baseurl=https://some-owner.github.io/kea/rpm/$basearch', 'type=rpm-md', 'gpgcheck=1', 'repo_gpgcheck=1', 'pkg_gpgcheck=1', 'gpgkey=https://github.com/some-owner/kea/releases/latest/download/kea-app.asc', ''].join('\n'),
    )

    expect(packageVersion('0.2.0-rc.1')).toBe('0.2.0~rc.1')
    expect(packageVersion('0.2.0')).toBe('0.2.0')
    expect(artifactNames('0.2.0', arm)).toEqual({ deb: 'kea-app_0.2.0_arm64.deb', rpm: 'kea-app-0.2.0-1.aarch64.rpm', tarball: 'kea-app-0.2.0-linux-arm64.tar.gz', tarDir: 'kea-app-0.2.0-linux-arm64' })
    expect(artifactNames('0.2.0', x64)).toEqual({ deb: 'kea-app_0.2.0_amd64.deb', rpm: 'kea-app-0.2.0-1.x86_64.rpm', tarball: 'kea-app-0.2.0-linux-x64.tar.gz', tarDir: 'kea-app-0.2.0-linux-x64' })
  })

  // The app's tree under /opt/Kea: chrome-sandbox 4755, executables (ELF or any x bit) 0755, the rest 0644, folders
  // 0755, whatever the build tree had; the profile beside its resources; a link in the tree is refused.
  it('U-PACK-34 · stageRoot: /opt/Kea with the packages’ modes, chrome-sandbox set-uid, the profile, each archive’s own files; links refused', () => {
    expect(treeMode('chrome-sandbox', { elf: true, executable: true })).toBe(0o4755)
    expect(treeMode('kea-app', { elf: true, executable: false })).toBe(0o755)
    expect(treeMode('resources/kea-helper', { elf: false, executable: true })).toBe(0o755)
    expect(treeMode('resources/app.asar', { elf: false, executable: false })).toBe(0o644)
    for (const so of ['libffmpeg.so', 'libvulkan.so.1', 'resources/app.asar.unpacked/native_modules/better-sqlite3/prebuilds/linux-arm64.node']) expect(treeMode(so, { elf: true, executable: true }), so).toBe(0o644)

    const d = tmp()
    const app = path.join(d, 'app')
    fs.mkdirSync(path.join(app, 'resources', 'app.asar.unpacked'), { recursive: true })
    fs.writeFileSync(path.join(app, 'kea-app'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))
    fs.chmodSync(path.join(app, 'kea-app'), 0o700)
    fs.writeFileSync(path.join(app, 'chrome-sandbox'), 'x')
    fs.chmodSync(path.join(app, 'chrome-sandbox'), 0o755)
    fs.writeFileSync(path.join(app, 'resources', 'app.asar'), 'asar')
    fs.chmodSync(path.join(app, 'resources', 'app.asar'), 0o600)
    fs.chmodSync(path.join(app, 'resources'), 0o700)
    const files = rootFiles({ meta: withRepo, icons: '/unused', fonts: '/unused', launcher: path.join(d, 'launcher'), licences: path.join(d, 'lic') })
    fs.writeFileSync(path.join(d, 'launcher'), '#!/bin/sh\n')
    fs.writeFileSync(path.join(d, 'lic'), 'licences\n')
    fs.writeFileSync(path.join(d, 'key'), 'key')
    const some = files.filter((f) => !f.path.includes('/icons/') && !f.path.includes('/fonts/')).map((f) => (f.path.endsWith('.gpg') ? { ...f, from: path.join(d, 'key') } : f))
    expect(stageRoot(path.join(d, 'deb-root'), { app, files: some, format: 'deb' }).some((f) => f.path === '/opt/Kea/resources/kea-app.gpg'), "the deb's key, in its tree").toBe(true)
    const root = path.join(d, 'root')
    const staged = stageRoot(root, { app, files: some, format: 'rpm' })
    const modes = Object.fromEntries(staged.map((f) => [f.path, f.mode.toString(8)]))
    expect(modes).toMatchObject({ '/opt/Kea': '755', '/opt/Kea/kea-app': '755', '/opt/Kea/chrome-sandbox': '4755', '/opt/Kea/resources': '755', '/opt/Kea/resources/app.asar': '644', '/opt/Kea/resources/apparmor-profile': '644', '/usr/bin/kea-app': '755', '/etc/yum.repos.d/kea-app.repo': '644' })
    expect(Object.keys(modes)).not.toContain('/opt/Kea/resources/kea-app.gpg') // the deb's
    // Kea's own folders outside its tree are listed, so removing the package removes them (rpm removes only what it
    // lists, so an unlisted font folder would stay behind); the system's folders above them never are
    expect(staged.filter((f) => f.dir && !f.path.startsWith('/opt/Kea')).map((f) => f.path)).toEqual(['/usr/share/doc/kea-app'])
    expect(['/opt/Kea', '/opt/Kea/resources', '/usr/share/doc/kea-app', '/usr/share/fonts/kea-app'].every(ownsFolder)).toBe(true)
    expect(['/usr/share/doc', '/usr/share/fonts', '/usr/bin', '/opt', '/usr/share/fonts/truetype'].some(ownsFolder)).toBe(false)
    for (const f of staged) expect((fs.statSync(path.join(root, f.path)).mode & 0o7777).toString(8), f.path).toBe(f.mode.toString(8))
    expect(fs.statSync(path.join(root, 'usr', 'bin')).mode & 0o777, 'folders the system has are made 0755 and not listed').toBe(0o755)
    expect(staged.some((f) => f.path === '/usr/bin' || f.path === '/usr')).toBe(false)
    expect(fs.readFileSync(path.join(root, 'opt/Kea/resources/apparmor-profile'), 'utf8')).toBe(apparmorProfile())
    expect(md5sums(root, staged).split('\n')).toContain(`${createHash('md5').update('asar').digest('hex')}  opt/Kea/resources/app.asar`)

    fs.symlinkSync('kea-app', path.join(app, 'link'))
    expect(() => stageRoot(path.join(d, 'root2'), { app, files: [], format: 'deb' })).toThrow(/is a link/)
  })

  // The scripts: valid sh; after install, the profile only where this AppArmor parses it, loaded only where AppArmor
  // runs outside a chroot, and the apt source only with a repository and its key, never over an existing one, never
  // when /etc/default/kea-app says add_repository=no; after removal nothing on an upgrade (deb `upgrade`, rpm 1).
  it('U-PACK-35 · the scripts after install and after removal: the profile when it parses, the apt source unless add_repository=no, nothing removed on an upgrade', () => {
    const d = tmp()
    for (const [name, text] of [['postinst', afterInstall(withRepo, 'deb')], ['post', afterInstall(meta, 'rpm')], ['postrm', afterRemove()]] as const) {
      fs.writeFileSync(path.join(d, name), text)
      expect(spawnSync('/bin/sh', ['-n', path.join(d, name)]).status, name).toBe(0)
      expect(text, `${name}: electron-builder's macros never reach it`).not.toMatch(/\$\{[A-Za-z]+\}/)
    }
    const deb = afterInstall(withRepo, 'deb')
    expect(deb).toContain('apparmor_parser --skip-kernel-load --debug /opt/Kea/resources/apparmor-profile')
    expect(deb).toContain('cp -f /opt/Kea/resources/apparmor-profile /etc/apparmor.d/kea-app')
    expect(deb).toMatch(/enabled 2>\/dev\/null\)" = Y \] && ! \{ command -v ischroot .* ischroot; \}; then\n\s+apparmor_parser --replace \/etc\/apparmor.d\/kea-app/)
    expect(deb).toContain(`if [ "$1" = configure ] && ! grep -qs '^add_repository=no' /etc/default/kea-app && [ ! -e /etc/apt/sources.list.d/kea-app.sources ]; then`)
    expect(deb).toContain(['Types: deb', 'URIs: https://github.com/some-owner/kea/releases/latest/download/', 'Suites: ./', 'Signed-By: /usr/share/keyrings/kea-app.gpg'].join('\n'))
    // the key where the source names it, from the package's tree, whoever made the source (install.sh, the script):
    // refreshed by every upgrade, left by `apt remove` (so apt update keeps working), removed by `apt purge`
    expect(deb).toContain(`if [ "$1" = configure ] && ! grep -qs '^add_repository=no' /etc/default/kea-app && [ -e /etc/apt/sources.list.d/kea-app.sources ]; then\n  install -D -m 0644 /opt/Kea/resources/kea-app.gpg /usr/share/keyrings/kea-app.gpg\nfi`)
    expect(afterInstall(meta, 'deb'), 'no repository named: no source').not.toContain('sources.list.d')
    expect(afterInstall(withRepo, 'rpm'), 'the rpm carries its repository as a file').not.toContain('sources.list.d')
    expect(afterInstall({ ...withRepo, keyFile: null }, 'deb'), 'no key: no source').not.toContain('sources.list.d')

    // an upgrade's removal step touches nothing: run it with an upgrade's arguments, with no AppArmor or apt around
    for (const arg of ['upgrade', '1', 'failed-upgrade', 'abort-install']) {
      const r = spawnSync('/bin/sh', ['-x', path.join(d, 'postrm'), arg], { encoding: 'utf8' })
      expect(r.status, arg).toBe(0)
      expect(r.stderr, `${arg}: nothing after the case`).not.toMatch(/rm |apparmor_parser/)
    }
    const rm = afterRemove()
    expect(rm).toContain('remove|purge|0) ;;')
    expect(rm).toContain('apparmor_parser --remove /etc/apparmor.d/kea-app')
    expect(rm).toContain('rm -f /var/cache/apparmor/*/kea-app /etc/apparmor.d/cache/kea-app')
    expect(rm).toContain('if [ "$1" = purge ]; then rm -f /etc/apt/sources.list.d/kea-app.sources /usr/share/keyrings/kea-app.gpg; fi')
  })

  // Before the package is removed (not upgraded: deb `upgrade`, rpm 1), the same short note install.sh's
  // --uninstall gives: ~/.kea stays with what it holds, running terminals keep running, and the order for removing
  // everything. It prints only, on stderr, and never fails the removal.
  it('U-PACK-41 · the note before removal: what ~/.kea holds and stays, running terminals, the order; nothing on an upgrade', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'prerm'), beforeRemove())
    expect(spawnSync('/bin/sh', ['-n', path.join(d, 'prerm')]).status).toBe(0)
    for (const arg of ['remove', '0']) {
      const r = spawnSync('/bin/sh', [path.join(d, 'prerm'), arg], { encoding: 'utf8', env: { PATH: '/nonexistent' } })
      expect(r.status, arg).toBe(0)
      expect(r.stdout, arg).toBe('')
      for (const w of ['~/.kea', 'uncommitted work', 'keep running', 'Stop All and Quit', 'delete ~/.kea']) expect(r.stderr, `${arg}: ${w}`).toContain(w)
    }
    for (const arg of ['upgrade', '1', 'deconfigure', 'failed-upgrade']) {
      const r = spawnSync('/bin/sh', [path.join(d, 'prerm'), arg], { encoding: 'utf8', env: { PATH: '/nonexistent' } })
      expect(r.status, arg).toBe(0)
      expect(r.stdout + r.stderr, arg).toBe('')
    }
    expect(beforeRemove(), 'no rm, no command at all').not.toMatch(/\brm\b|apparmor|apt|dnf/)
    expect(beforeRemove().split('\n')[1], "set -e, as lintian asks of every maintainer script (maintainer-script-ignores-errors)").toBe('set -e')
    const spec = rpmSpec(meta, arm, { root: '/w/root', files: [], post: '#!/bin/sh\necho post\n', postun: '#!/bin/sh\necho postun\n', preun: beforeRemove(), licence: 'x' })
    expect(spec).toContain(`%preun\n${beforeRemove().replace(/^#!.*\n/, '')}`)
    // rpmlint reads the note's ~/.kea as the script using the home folder (it only prints it): accepted, with why
    expect(lintProblems('kea-app.aarch64: E: use-of-home-in-%preun', ACCEPTED_RPMLINT)).toEqual([])
  })

  // The deb's control file and the rpm's spec: the dependencies in each family's names, the version with `~`,
  // the architecture names, every staged file listed in the spec and the app's folders owned, no dependency scan.
  // The desktop file starts Kea through the launcher with the window's class; the profile grants userns to Kea only.
  it('U-PACK-36 · control, spec, desktop file and profile', () => {
    const control = debControl(withRepo, arm, 123456)
    expect(control.split('\n').slice(0, 11)).toEqual([
      'Package: kea-app',
      'Version: 0.2.0~rc.1',
      'Architecture: arm64',
      'Maintainer: Kea <kea-app@invalid>',
      'Installed-Size: 123456',
      'Depends: libc6 (>= 2.35), libgtk-3-0t64 | libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, xdg-utils',
      'Recommends: git (>= 1:2.40), libglib2.0-bin',
      'Section: devel',
      'Priority: optional',
      'Homepage: https://github.com/some-owner/kea',
      'Description: Run many coding-agent CLI sessions side by side',
    ])
    const long = control.split('\n').filter((l) => l.startsWith(' '))
    expect(long.length).toBeGreaterThan(1)
    for (const l of long) expect(l.length, l).toBeLessThanOrEqual(80)
    expect(debControl(meta, x64, 1)).toContain('Architecture: amd64')
    expect(debControl(meta, x64, 1)).not.toContain('Homepage:')

    const files = [
      { path: '/opt/Kea', mode: 0o755, dir: true },
      { path: '/opt/Kea/kea-app', mode: 0o755, dir: false },
      { path: '/opt/Kea/odd name %{x}', mode: 0o644, dir: false },
      { path: '/usr/bin/kea-app', mode: 0o755, dir: false },
      { path: '/usr/share/fonts/kea-app', mode: 0o755, dir: true },
      { path: '/usr/share/fonts/kea-app/JetBrainsMono-Regular.ttf', mode: 0o644, dir: false },
    ]
    const spec = rpmSpec(meta, arm, { root: '/w/root', files, post: '#!/bin/sh\necho post\n', postun: '#!/bin/sh\necho postun\n', licence: 'LicenseRef-x' })
    for (const l of ['Name: kea-app', 'Version: 0.2.0~rc.1', 'Release: 1', 'License: LicenseRef-x', 'Group: Development/Tools', 'Packager: Kea <kea-app@invalid>', 'BuildArch: aarch64', 'AutoReqProv: no', 'Requires: gtk3', 'Requires: nss', 'Requires: alsa-lib', 'Requires: mesa-libgbm', 'Requires: xdg-utils', 'Recommends: git-core >= 2.40', 'Recommends: glib2', '%define _build_id_links none', 'cp -a "/w/root/." "%{buildroot}/"', '%defattr(-,root,root,-)', '%dir "/opt/Kea"', '%dir "/usr/share/fonts/kea-app"', '"/opt/Kea/kea-app"', '"/opt/Kea/odd name %%{x}"', '"/usr/bin/kea-app"']) expect(spec.split('\n'), l).toContain(l)
    expect(spec).toContain('%post\necho post\n')
    expect(spec).toContain('%postun\necho postun\n')
    expect(rpmSpec(meta, x64, { root: '/r', files: [], post: '', postun: '', licence: 'x' })).toContain('BuildArch: x86_64')
    // the repository's file is a configuration file: an upgrade keeps it as the person (or install.sh --no-repo) left
    // it, and rpmlint refuses a file in /etc that is not one (non-conffile-in-etc)
    const repoSpec = rpmSpec(withRepo, arm, { root: '/w/root', files: [{ path: '/etc/yum.repos.d/kea-app.repo', mode: 0o644, dir: false }], post: '', postun: '', licence: 'x' })
    expect(repoSpec.split('\n')).toContain('%config(noreplace) "/etc/yum.repos.d/kea-app.repo"')
    expect(() => rpmSpec(meta, x64, { root: '/r', files: [{ path: '/opt/Kea/"', mode: 0o644, dir: false }], post: '', postun: '', licence: 'x' })).toThrow(/cannot be listed/)

    const desktop = desktopEntry(meta.description).split('\n')
    expect(desktop).toEqual(['[Desktop Entry]', 'Type=Application', 'Name=Kea', 'Comment=Run many coding-agent CLI sessions side by side', 'Exec=/usr/bin/kea-app %U', 'Icon=dev.kea.app', 'Terminal=false', 'Categories=Development;', 'StartupWMClass=dev.kea.app', 'StartupNotify=true', ''])
    const profile = apparmorProfile()
    expect(profile).toContain('profile kea-app /opt/Kea/kea-app flags=(unconfined) {\n  userns,\n')
    expect(profile).toContain('abi <abi/4.0>,')
    // the launcher finds it loaded by this name
    expect(fs.readFileSync(path.join(import.meta.dirname, 'kea-app.sh'), 'utf8')).toContain("grep -q '^kea-app ' /sys/kernel/security/apparmor/profiles")
  })
})
