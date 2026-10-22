// Linux's side of tools/pack's OS layer (index.ts): the packaging tools, a build's native files, and what `pnpm dev`
// sets up (the dev build's desktop file, the sandbox check). Kea is installed on Linux by its packages, never by
// `pnpm kea:install`. The packages' own files are `linuxPackage.ts` and `kea-app.sh`.
import fs from 'node:fs'
import path from 'node:path'
import { DESKTOP_IDS, notAvailable } from '../../../../packages/protocol/src/platform.ts'
import type { LinuxTool, PackOs, PackTool } from './index.ts'

/** Where Debian, Ubuntu and Fedora keep the packaging tools (all three merged /usr). */
const TOOLS: Readonly<Record<LinuxTool, string>> = {
  'dpkg-deb': '/usr/bin/dpkg-deb',
  rpmbuild: '/usr/bin/rpmbuild',
  rpm: '/usr/bin/rpm',
  tar: '/usr/bin/tar',
  apparmor_parser: '/usr/sbin/apparmor_parser',
  'desktop-file-validate': '/usr/bin/desktop-file-validate',
  lintian: '/usr/bin/lintian',
  rpmlint: '/usr/bin/rpmlint',
  strip: '/usr/bin/strip',
}

/** Where the desktop looks for the user's own desktop entries (`$XDG_DATA_HOME`, else `~/.local/share`). */
export function userApplicationsDir(home: string, env: NodeJS.ProcessEnv): string {
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  return path.join(dataHome, 'applications')
}

/**
 * An `Exec` argument as the Desktop Entry spec writes one, in its two steps: Exec's quoting (in double quotes, `"`,
 * `` ` ``, `$` and `\` escaped, `%` doubled), then the string type's escapes over that (each `\` doubled; a newline,
 * tab or carriage return as `\n`, `\t`, `\r`), which a reader undoes first (U-PLT-57).
 */
export function execArg(a: string): string {
  const quoted = `"${a.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, '%%')}"`
  return quoted.replace(/[\\\n\t\r]/g, (c) => (c === '\\' ? '\\\\' : c === '\n' ? '\\n' : c === '\t' ? '\\t' : '\\r'))
}

/**
 * The dev build's desktop file. `NoDisplay` keeps it out of the app grid; GNOME activates it for a notification's
 * click, which runs `Exec` only when no Kea runs (a second launch then reaches the running one through the
 * single-instance lock). `StartupWMClass` ties the window to it on X11, as the app id does on Wayland.
 */
export function devDesktopFile(o: { home: string; env: NodeJS.ProcessEnv; root: string; electron: string }): { path: string; text: string } {
  const id = DESKTOP_IDS.dev
  const text = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Kea (dev)',
    `Comment=The dev build of Kea in ${o.root} (written by pnpm dev; pnpm dev --remove-desktop-file removes it)`,
    `Exec=${execArg(o.electron)} ${execArg(path.join(o.root, 'dist', 'app'))}`,
    'Terminal=false',
    'NoDisplay=true',
    `StartupWMClass=${id}`,
    '',
  ].join('\n')
  return { path: path.join(userApplicationsDir(o.home, o.env), `${id}.desktop`), text }
}

/** Ubuntu's AppArmor rule (23.10 on) that lets only programs a profile names make user namespaces. */
const USERNS_RESTRICTED = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
/** Debian's older switch for unprivileged user namespaces. */
const USERNS_CLONE = '/proc/sys/kernel/unprivileged_userns_clone'

function readNumber(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

/**
 * The sandbox check for a dev build: Chromium's sandbox needs user namespaces Electron may make (no AppArmor
 * restriction, none switched off), or npm's `chrome-sandbox` beside it owned by root with mode 4755. Kea never runs
 * with `--no-sandbox`.
 */
export function devSandboxProblem(electron: string, read: (file: string) => number | null = readNumber, stat: (file: string) => fs.Stats | null = statOrNull): string | null {
  const usernsOk = read(USERNS_RESTRICTED) !== 1 && read(USERNS_CLONE) !== 0
  if (usernsOk) return null
  const helper = path.join(path.dirname(electron), 'chrome-sandbox')
  const st = stat(helper)
  if (st && st.uid === 0 && (st.mode & 0o7777) === 0o4755) return null
  return [
    "Kea's window needs Chromium's sandbox, and here neither of its two ways works:",
    '  this system lets only programs an AppArmor profile names make user namespaces (Ubuntu 23.10 and later),',
    `  and npm's chrome-sandbox helper is not set-uid root: ${helper}`,
    'Make the helper set-uid root, once per Electron install (pnpm install puts it back as it was):',
    `  sudo chown root:root ${helper}`,
    `  sudo chmod 4755 ${helper}`,
    'Kea never runs with --no-sandbox.',
  ].join('\n')
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

export const linux: PackOs = {
  system: 'linux',
  rust: { cargo: (home) => [path.join(home, '.cargo', 'bin', 'cargo')], installHint: 'install Rust with rustup (rustup.rs)' },
  tools: {
    path: (tool: PackTool) => {
      if (!(tool in TOOLS)) throw new Error(`${tool} is a macOS tool: the macOS zip is built on a Mac`)
      return TOOLS[tool as LinuxTool]
    },
  },
  installPlace: notAvailable('Kea is installed on Linux by its packages or install.sh, not by pnpm kea:install.'),
  // better-sqlite3's glibc prebuild; the watcher's glibc binding package, and Kea's patched build where pnpm built it
  nativeAddons: {
    sqlitePrebuild: (arch) => `prebuilds/linux-${arch}.node`,
    watcherPackage: (arch) => `@parcel/watcher-linux-${arch}-glibc`,
    watcherPatchedBuild: path.join('build', 'Release', 'watcher.node'),
  },
  devDesktop: { file: devDesktopFile, sandboxProblem: (electron) => devSandboxProblem(electron) },
}
