// Kea's Linux packages: one package root, every file at the path it is installed at with its owner (root)
// and mode, from which the .deb (`dpkg-deb`), the .rpm (`rpmbuild`) and the tarball (`tar`) are made. This module is
// the file list and the text of every generated file: the desktop file, the AppArmor profile, the scripts that run
// after install and after removal, the deb's control file and the rpm's spec. Pure but for `stageRoot`, which writes
// the root; tools/package.ts runs the archivers. The launcher is `kea-app.sh` beside it.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { L } from '../../../../packages/protocol/src/generated/limits.ts'
import { LINUX_REPO_FILES } from '../../../../packages/protocol/src/os/linux.ts'
import { debArch as debArchOf, releaseFileNames, releaseUrls, rpmArch as rpmArchOf } from '../../../../packages/protocol/src/release.ts'
import { DESKTOP_FILE, LINUX_NAME, PRODUCT_NAME, type Target } from '../config.ts'
import { INSTALL_KIND_FILE, linuxInstallKind, VERSION_FILE } from '../installFiles.ts'

/** Where the app's tree goes: `/opt/Kea` (the launcher's default). */
export const INSTALL_DIR = `/opt/${PRODUCT_NAME}`
const APP_ID = DESKTOP_FILE.replace(/\.desktop$/, '')
/** The PNG sizes that go to hicolor: the folder names hicolor's index lists, up to 512 px. */
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const
/** Where the profile ships (installed to `/etc/apparmor.d/kea-app` by the script after install, when it parses). */
export const PROFILE_SOURCE = `${INSTALL_DIR}/resources/apparmor-profile`
export const PROFILE = `/etc/apparmor.d/${LINUX_NAME}`
export const APT_SOURCE = LINUX_REPO_FILES.aptSource
export const APT_KEY = `/usr/share/keyrings/${LINUX_NAME}.gpg`
/** Where the deb carries the key, which its script copies to `APT_KEY` (so `apt remove` leaves the source working). */
export const APT_KEY_SOURCE = `${INSTALL_DIR}/resources/${LINUX_NAME}.gpg`
export const RPM_REPO = LINUX_REPO_FILES.rpmRepo
export const DEFAULTS = LINUX_REPO_FILES.defaults
export const DOC_DIR = `/usr/share/doc/${LINUX_NAME}`
/** The terminal's default font on Linux: the weights the terminal draws with (xterm's defaults: 400, and 700
 * for bold text), where fontconfig gives them to Chromium. No italic: the design uses none, and Chromium slants the
 * regular face where a program asks. */
export const FONT_DIR = `/usr/share/fonts/${LINUX_NAME}`
export const TERMINAL_FONTS = ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf'] as const
/** Kea's folders outside its tree: the package owns them (listed, removed with it); every other folder is the system's. */
export const OWN_FOLDERS = [DOC_DIR, FONT_DIR] as const
/** Whether a folder is the package's own: `/opt/Kea`, a folder in it, or one of `OWN_FOLDERS`. */
export function ownsFolder(p: string): boolean {
  return p === INSTALL_DIR || p.startsWith(`${INSTALL_DIR}/`) || (OWN_FOLDERS as readonly string[]).includes(p)
}
/** Present where this system's AppArmor reads the profile's `abi <abi/4.0>` (Ubuntu 24.04, Debian 13 and later). */
export const APPARMOR_ABI_4 = '/etc/apparmor.d/abi/4.0'

const GLIBC_MIN = `${L.glibcMinMajor}.${L.glibcMinMinor}`
const GIT_MIN = `${L.gitMinMajor}.${L.gitMinMinor}`
/**
 * The deb's dependencies: Debian's and Ubuntu's names (the `t64` ones since 24.04 and trixie, the old ones
 * before); glibc at Kea's floor.
 */
export const DEB_DEPENDS = [`libc6 (>= ${GLIBC_MIN})`, 'libgtk-3-0t64 | libgtk-3-0', 'libnss3', 'libasound2t64 | libasound2', 'libgbm1', 'xdg-utils'] as const
export const DEB_RECOMMENDS = [`git (>= 1:${GIT_MIN})`, 'libglib2.0-bin'] as const
/** The same with Fedora's names; `git-core` and `glib2` (for `gio`) as weak dependencies. */
export const RPM_REQUIRES = ['gtk3', 'nss', 'alsa-lib', 'mesa-libgbm', 'xdg-utils'] as const
export const RPM_RECOMMENDS = [`git-core >= ${GIT_MIN}`, 'glib2'] as const

export interface PackageMeta {
  /** Kea's version as `package.json` has it (semver). */
  version: string
  description: string
  maintainer: string
  /** `owner/name`, or null: no repository is added and no URL is named. */
  repository: string | null
  /** The repository key's binary (dearmored) form, or null while there is none. */
  keyFile: string | null
}

/** Debian's and rpm's spelling of a version: a pre-release sorts before its release with `~` (`0.2.0~rc.1`). */
export function packageVersion(version: string): string {
  return version.replace('-', '~')
}

export function debArch(target: Target): string {
  return debArchOf(target.arch)
}

export function rpmArch(target: Target): string {
  return rpmArchOf(target.arch)
}

/** The artifacts' names (packages/protocol's, which main's update check reads back from a release). */
export function artifactNames(version: string, target: Target): { deb: string; rpm: string; tarball: string; tarDir: string } {
  const { deb, rpm, tarball, tarDir } = releaseFileNames(version, target.arch)
  return { deb, rpm, tarball, tarDir }
}

const repositoryOf = (m: PackageMeta) => (m.repository !== null && m.keyFile !== null ? m.repository : null)

/** The apt source, as the deb's script and install.sh write it (the same bytes). */
export function aptSourceText(repository: string): string {
  return ['Types: deb', `URIs: ${releaseUrls(repository).latest}`, 'Suites: ./', `Signed-By: ${APT_KEY}`, ''].join('\n')
}

/** dnf's repository file, as the rpm carries it and install.sh writes it; `enabled` false for `--no-repo`. */
export function rpmRepoText(repository: string, enabled: boolean): string {
  const urls = releaseUrls(repository)
  return [`[${LINUX_NAME}]`, `name=${PRODUCT_NAME}`, `baseurl=${urls.rpmBase}`, `enabled=${enabled ? 1 : 0}`, 'gpgcheck=1', 'repo_gpgcheck=1', `gpgkey=${urls.key}`, ''].join('\n')
}

/** The same repository in zypper's own form, which install.sh writes on openSUSE (`/etc/zypp/repos.d`). */
export function zypperRepoText(repository: string): string {
  const urls = releaseUrls(repository)
  return [`[${LINUX_NAME}]`, `name=${PRODUCT_NAME}`, 'enabled=1', 'autorefresh=1', `baseurl=${urls.rpmBase}`, 'type=rpm-md', 'gpgcheck=1', 'repo_gpgcheck=1', 'pkg_gpgcheck=1', `gpgkey=${urls.key}`, ''].join('\n')
}

export function desktopEntry(description: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${PRODUCT_NAME}`,
    `Comment=${description.replace(/\.$/, '')}`,
    // through the launcher, which checks the sandbox before Chromium starts
    `Exec=/usr/bin/${LINUX_NAME} %U`,
    `Icon=${APP_ID}`,
    'Terminal=false',
    'Categories=Development;',
    // the window's class and Wayland app id (Electron's desktopName), so docks group the window under this file
    `StartupWMClass=${APP_ID}`,
    'StartupNotify=true',
    '',
  ].join('\n')
}

/** User namespaces for Kea's executable only, where AppArmor restricts them (Ubuntu 23.10 and later). */
export function apparmorProfile(): string {
  return [
    `# Kea's AppArmor profile: ${INSTALL_DIR}/${LINUX_NAME} may make the user namespaces`,
    "# Chromium's sandbox needs where AppArmor restricts them. It confines nothing else.",
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile ${LINUX_NAME} ${INSTALL_DIR}/${LINUX_NAME} flags=(unconfined) {`,
    '  userns,',
    '',
    `  include if exists <local/${LINUX_NAME}>`,
    '}',
    '',
  ].join('\n')
}

/** The live AppArmor steps are skipped in a chroot (an image being made) and where AppArmor is off. */
const APPARMOR_LIVE = `[ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ] && ! { command -v ischroot >/dev/null 2>&1 && ischroot; }`

/**
 * After install or upgrade: the .deb's `postinst` (`configure`) and the .rpm's `%post` (1 or 2). Installs the AppArmor
 * profile where this system's AppArmor can read it (AppArmor 4: not Ubuntu 22.04, which needs none) and loads it; on
 * Debian and Ubuntu adds Kea's apt repository unless `/etc/default/kea-app` says `add_repository=no` (as VS
 * Code's package does), only where none is set up yet, and puts the key the source names beside it from the package's
 * tree, whoever made the source: every upgrade refreshes it, and `apt remove` leaves it with the source.
 * Nothing here fails the install.
 */
export function afterInstall(m: PackageMeta, format: 'deb' | 'rpm'): string {
  const repo = format === 'deb' ? repositoryOf(m) : null
  const lines = [
    '#!/bin/sh',
    `# ${PRODUCT_NAME}, after install: the AppArmor profile${repo ? " and Kea's apt repository" : ''}.`,
    'set -e',
    '',
    `if command -v apparmor_parser >/dev/null 2>&1 && [ -d /etc/apparmor.d ]; then`,
    `  if apparmor_parser --skip-kernel-load --debug ${PROFILE_SOURCE} >/dev/null 2>&1; then`,
    `    cp -f ${PROFILE_SOURCE} ${PROFILE}`,
    `    if ${APPARMOR_LIVE}; then`,
    `      apparmor_parser --replace ${PROFILE} || echo "${LINUX_NAME}: AppArmor did not load ${PROFILE}; it loads at the next start" >&2`,
    '    fi',
    '  else',
    `    echo "${LINUX_NAME}: this AppArmor cannot read Kea's profile; Kea's window uses chrome-sandbox instead" >&2`,
    '  fi',
    'fi',
  ]
  if (repo) {
    lines.push(
      '',
      `if [ "$1" = configure ] && ! grep -qs '^add_repository=no' ${DEFAULTS} && [ ! -e ${APT_SOURCE} ]; then`,
      `  cat > ${APT_SOURCE} <<'EOF'`,
      aptSourceText(repo).replace(/\n$/, ''),
      'EOF',
      'fi',
      `if [ "$1" = configure ] && ! grep -qs '^add_repository=no' ${DEFAULTS} && [ -e ${APT_SOURCE} ]; then`,
      `  install -D -m 0644 ${APT_KEY_SOURCE} ${APT_KEY}`,
      'fi',
    )
  }
  lines.push('exit 0', '')
  return lines.join('\n')
}

/**
 * After removal: the .deb's `postrm` and the .rpm's `%postun`. On an upgrade (deb `upgrade`, rpm 1) nothing is removed:
 * the new package's script keeps the profile. On removal the profile is unloaded and deleted with AppArmor's cache of
 * it; the apt source and its key go on `purge` only, so a reinstall finds them (what the person chose stays chosen).
 */
export function afterRemove(): string {
  return [
    '#!/bin/sh',
    `# ${PRODUCT_NAME}, after removal: the AppArmor profile and its cache, and on purge the apt source and its key.`,
    'set -e',
    'case "$1" in',
    '  remove|purge|0) ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
    `if [ -f ${PROFILE} ]; then`,
    `  if command -v apparmor_parser >/dev/null 2>&1 && ${APPARMOR_LIVE}; then`,
    `    apparmor_parser --remove ${PROFILE} >/dev/null 2>&1 || true`,
    '  fi',
    `  rm -f ${PROFILE}`,
    'fi',
    `rm -f /var/cache/apparmor/*/${LINUX_NAME} /etc/apparmor.d/cache/${LINUX_NAME}`,
    `if [ "$1" = purge ]; then rm -f ${APT_SOURCE} ${APT_KEY}; fi`,
    'exit 0',
    '',
  ].join('\n')
}

/**
 * Before removal: the .deb's `prerm` (`remove`) and the .rpm's `%preun` (0), never on an upgrade. The same
 * short note as `install.sh --uninstall`, on stderr, with the shell's own printf: it starts nothing, so it never fails
 * the removal.
 */
export function beforeRemove(): string {
  return [
    '#!/bin/sh',
    'set -e',
    `# ${PRODUCT_NAME}, before removal: what stays.`,
    'case "$1" in',
    '  remove|0) ;;',
    '  *) exit 0 ;;',
    'esac',
    // printf is the shell's own: the note starts no program, so nothing in it can fail the removal
    `printf '%s\\n' \\`,
    `  "${PRODUCT_NAME}'s data stays in ~/.kea: the sessions' worktrees, which may hold uncommitted work, their" \\`,
    '  "scrollback and your settings. Terminals still running keep running after Kea is gone." \\',
    '  "To remove everything: in Kea, Stop All and Quit; then remove the package; then delete ~/.kea once you have" \\',
    '  "checked its worktrees." >&2',
    'exit 0',
    '',
  ].join('\n')
}

/** The rpm's repository file, when there is a repository. */
export function rpmRepoFile(m: PackageMeta): string | null {
  const repo = repositoryOf(m)
  return repo ? rpmRepoText(repo, true) : null
}

/** One file of the package root outside the app's tree. */
export interface RootFile {
  /** As installed (absolute). */
  path: string
  mode: number
  from?: string
  text?: string
  /** Only in these archives (default: all). */
  only?: readonly ('deb' | 'rpm' | 'tar.gz')[]
}

/**
 * Every file of the package beside the app's tree: the launcher, the desktop file, the icons, the terminal's font, the
 * licences, how Kea was installed and its version (in `/opt/Kea/resources`, one install kind per archive), and the
 * repository's files when there is a repository. `icons`: `assets/icon`; `fonts`: `assets/fonts/jetbrains-mono`.
 */
export function rootFiles(o: { meta: PackageMeta; icons: string; fonts: string; launcher: string; licences: string }): RootFile[] {
  const files: RootFile[] = [
    { path: `/usr/bin/${LINUX_NAME}`, mode: 0o755, from: o.launcher },
    { path: `/usr/share/applications/${DESKTOP_FILE}`, mode: 0o644, text: desktopEntry(o.meta.description) },
    ...ICON_SIZES.map((n) => ({ path: `/usr/share/icons/hicolor/${n}x${n}/apps/${APP_ID}.png`, mode: 0o644, from: path.join(o.icons, 'png', `${n}x${n}.png`) })),
    { path: `/usr/share/icons/hicolor/scalable/apps/${APP_ID}.svg`, mode: 0o644, from: path.join(o.icons, 'kea.svg') },
    // a system font, so Chromium finds it through fontconfig as it finds any other (the systems' fontconfig triggers
    // refresh the cache); the distributions' own JetBrains Mono packages use other folders, so the two never collide
    ...TERMINAL_FONTS.map((f) => ({ path: `${FONT_DIR}/${f}`, mode: 0o644, from: path.join(o.fonts, f) })),
    // Debian's place for a package's licences; the same file for the rpm and the tarball
    { path: `${DOC_DIR}/copyright`, mode: 0o644, from: o.licences },
    // what main reads to tell who updates this Kea, and which version a package upgrade put in place under a running
    // one (`kea-version`: Electron's own `version` file beside it holds Electron's)
    ...(['deb', 'rpm', 'tar.gz'] as const).map((f) => ({ path: `${INSTALL_DIR}/resources/${INSTALL_KIND_FILE}`, mode: 0o644, text: `${linuxInstallKind(f)}\n`, only: [f] })),
    { path: `${INSTALL_DIR}/resources/${VERSION_FILE}`, mode: 0o644, text: `${o.meta.version}\n` },
  ]
  const repo = rpmRepoFile(o.meta)
  if (repo) files.push({ path: RPM_REPO, mode: 0o644, text: repo, only: ['rpm'] })
  if (repositoryOf(o.meta) && o.meta.keyFile) files.push({ path: APT_KEY_SOURCE, mode: 0o644, from: o.meta.keyFile, only: ['deb'] })
  return files
}

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

function isElf(file: string): boolean {
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(4)
    return fs.readSync(fd, b, 0, 4, 0) === 4 && b.equals(ELF_MAGIC)
  } finally {
    fs.closeSync(fd)
  }
}

/** A shared object by its name (`libffmpeg.so`, `libvulkan.so.1`, a native module's `.node`): loaded, never run. */
const SHARED_OBJECT = /\.(so(\.\d+)*|node)$/

/**
 * The mode a file of the app's tree gets: `chrome-sandbox` 4755 (set-uid root); a shared object 0644; an executable (an
 * ELF file, or one with any execute bit) 0755; any other 0644. Directories are 0755.
 */
export function treeMode(rel: string, o: { elf: boolean; executable: boolean }): number {
  if (rel === 'chrome-sandbox') return 0o4755
  if (SHARED_OBJECT.test(rel)) return 0o644
  return o.elf || o.executable ? 0o755 : 0o644
}

/**
 * Write the package root under `root` (which must not exist): the app's tree at `/opt/Kea` with `treeMode`'s modes, the
 * profile beside its resources, and `files`. Links in the app's tree are refused (Electron's Linux tree has none).
 * Returns every path written, as installed, with its mode, for the checks and the rpm's file list.
 */
export function stageRoot(root: string, o: { app: string; files: readonly RootFile[]; format: 'deb' | 'rpm' | 'tar.gz' }): { path: string; mode: number; dir: boolean }[] {
  const written: { path: string; mode: number; dir: boolean }[] = []
  const at = (p: string) => path.join(root, p)
  const mkdir = (p: string) => {
    fs.mkdirSync(at(p), { recursive: true })
    fs.chmodSync(at(p), 0o755)
  }
  fs.mkdirSync(root)
  const copyTree = (from: string, rel: string) => {
    const dest = rel ? `${INSTALL_DIR}/${rel}` : INSTALL_DIR
    mkdir(dest)
    written.push({ path: dest, mode: 0o755, dir: true })
    for (const e of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const src = path.join(from, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) throw new Error(`${src} is a link: the packages hold the app's tree as plain files`)
      if (e.isDirectory()) copyTree(src, r)
      else if (e.isFile()) {
        const mode = treeMode(r, { elf: isElf(src), executable: (fs.statSync(src).mode & 0o111) !== 0 })
        fs.copyFileSync(src, at(`${INSTALL_DIR}/${r}`))
        fs.chmodSync(at(`${INSTALL_DIR}/${r}`), mode)
        written.push({ path: `${INSTALL_DIR}/${r}`, mode, dir: false })
      } else throw new Error(`${src} is neither a file nor a folder`)
    }
  }
  copyTree(o.app, '')
  const extra: RootFile[] = [{ path: PROFILE_SOURCE, mode: 0o644, text: apparmorProfile() }, ...o.files.filter((f) => !f.only || f.only.includes(o.format))]
  for (const f of extra) {
    if (!f.path.startsWith(`${INSTALL_DIR}/`)) {
      // the folders above a file outside the app's tree are the system's (made here, never listed as the package's),
      // but for Kea's own (OWN_FOLDERS), which the package lists so that removing it removes them
      const dir = path.posix.dirname(f.path)
      fs.mkdirSync(at(dir), { recursive: true })
      if (ownsFolder(dir) && !written.some((w) => w.dir && w.path === dir)) written.push({ path: dir, mode: 0o755, dir: true })
    }
    if (f.from !== undefined) fs.copyFileSync(f.from, at(f.path))
    else fs.writeFileSync(at(f.path), f.text ?? '')
    fs.chmodSync(at(f.path), f.mode)
    written.push({ path: f.path, mode: f.mode, dir: false })
  }
  // every folder in the root 0755 (the system's ones too: they are made, not owned)
  const fix = (dir: string) => {
    fs.chmodSync(dir, 0o755)
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) fix(path.join(dir, e.name))
  }
  fix(root)
  return written
}

const fold = (text: string) => text.split('\n').map((l) => (l.trim() === '' ? ' .' : ` ${l}`)).join('\n')

const LONG_DESCRIPTION = `Kea runs coding-agent CLIs (Claude Code, Command Code) side by side. Each
session gets its own git worktree, a real terminal, a live file tree and a dev
server one click away, and keeps running when Kea quits.`

/** The .deb's `DEBIAN/control`. `installedKb`: the root's size in KiB. */
export function debControl(m: PackageMeta, target: Target, installedKb: number): string {
  const repo = m.repository ? `https://github.com/${m.repository}` : null
  return [
    `Package: ${LINUX_NAME}`,
    `Version: ${packageVersion(m.version)}`,
    `Architecture: ${debArch(target)}`,
    `Maintainer: ${m.maintainer}`,
    `Installed-Size: ${installedKb}`,
    `Depends: ${DEB_DEPENDS.join(', ')}`,
    `Recommends: ${DEB_RECOMMENDS.join(', ')}`,
    'Section: devel',
    'Priority: optional',
    ...(repo ? [`Homepage: ${repo}`] : []),
    `Description: ${m.description.replace(/\.$/, '')}`,
    fold(LONG_DESCRIPTION),
    '',
  ].join('\n')
}

/** `md5sums` for the .deb: every file outside `DEBIAN`, relative to the root. */
export function md5sums(root: string, files: readonly { path: string; dir: boolean }[]): string {
  return files
    .filter((f) => !f.dir)
    .map((f) => `${createHash('md5').update(fs.readFileSync(path.join(root, f.path))).digest('hex')}  ${f.path.slice(1)}`)
    .join('\n')
    .concat('\n')
}

/** rpm reads `%` as a macro and a file name with spaces or brackets as a pattern: quote and escape each listed path. */
function rpmPath(p: string): string {
  if (/["\n]/.test(p)) throw new Error(`${p} cannot be listed in an rpm spec`)
  return `"${p.replace(/%/g, '%%')}"`
}

/**
 * The .rpm's spec: the root staged by `stageRoot` copied into the build root as it is (modes kept; root owns
 * everything), no dependency scan, no stripping or build-id links (the binaries are Electron's and the helper as built),
 * `afterInstall` and `afterRemove` as `%post` and `%postun`.
 */
export function rpmSpec(m: PackageMeta, target: Target, o: { root: string; files: readonly { path: string; mode: number; dir: boolean }[]; post: string; postun: string; preun?: string; licence: string }): string {
  const ownDirs = o.files.filter((f) => f.dir && ownsFolder(f.path))
  // the repository's file is configuration: an upgrade keeps it as the person left it
  const listed = [...ownDirs.map((f) => `%dir ${rpmPath(f.path)}`), ...o.files.filter((f) => !f.dir).map((f) => (f.path === RPM_REPO ? `%config(noreplace) ${rpmPath(f.path)}` : rpmPath(f.path)))]
  return [
    `Name: ${LINUX_NAME}`,
    `Version: ${packageVersion(m.version)}`,
    'Release: 1',
    `Summary: ${m.description.replace(/\.$/, '')}`,
    `License: ${o.licence}`,
    'Group: Development/Tools',
    `Packager: ${m.maintainer}`,
    ...(m.repository ? [`URL: https://github.com/${m.repository}`] : []),
    `BuildArch: ${rpmArch(target)}`,
    'AutoReqProv: no',
    ...RPM_REQUIRES.map((r) => `Requires: ${r}`),
    ...RPM_RECOMMENDS.map((r) => `Recommends: ${r}`),
    '%define _build_id_links none',
    '%define debug_package %{nil}',
    '%define __os_install_post %{nil}',
    '%define __arch_install_post %{nil}',
    '%define __strip /bin/true',
    '',
    '%description',
    LONG_DESCRIPTION,
    '',
    '%install',
    `cp -a "${o.root}/." "%{buildroot}/"`,
    '',
    '%post',
    o.post.replace(/^#!.*\n/, ''),
    ...(o.preun === undefined ? [] : ['%preun', o.preun.replace(/^#!.*\n/, '')]),
    '%postun',
    o.postun.replace(/^#!.*\n/, ''),
    '%files',
    '%defattr(-,root,root,-)',
    ...listed,
    '',
  ].join('\n')
}
