// The files a package puts in the app's resources folder that say how Kea was installed and where it updates from,
// which main reads at start: `install-kind` (`mac`, `deb`, `rpm` or `tarball`), `kea-version` (the release's version:
// on Linux Electron's own `version` file beside it holds Electron's) and, in a release's macOS app only,
// `app-update.yml`, the macOS updater's feed. An app from `pnpm kea:install` carries none of them, so nothing updates it.
import type { InstallKind } from '../../../packages/protocol/src/updates.ts'

export const INSTALL_KIND_FILE = 'install-kind'
export const VERSION_FILE = 'kea-version'
export const UPDATE_CONFIG_FILE = 'app-update.yml'
/** The macOS updater's download cache, `~/Library/Caches/<name>` (`install.sh --uninstall` removes it). */
export const UPDATER_CACHE = 'kea-updater'

/** What a package records; `user` (a tarball under the home folder) is read at run time from where the tree is. */
export type PackagedKind = Exclude<InstallKind, 'user'>

export function linuxInstallKind(format: 'deb' | 'rpm' | 'tar.gz'): PackagedKind {
  return format === 'tar.gz' ? 'tarball' : format
}

/**
 * `app-update.yml` for the feed at `feed` (`releases/latest/download/`): electron-updater's generic provider, and the
 * cache folder it downloads into, which it reads from this file even when the feed is set in code.
 */
export function updateConfigYml(feed: string): string {
  return ['provider: generic', `url: ${feed}`, `updaterCacheDirName: ${UPDATER_CACHE}`, ''].join('\n')
}

/** The files `pnpm package` writes into a macOS app's `Contents/Resources` before signing; `feed` null: no repository, no feed. */
export function macResourceFiles(o: { version: string; feed: string | null }): { name: string; text: string }[] {
  return [
    { name: INSTALL_KIND_FILE, text: 'mac\n' },
    { name: VERSION_FILE, text: `${o.version}\n` },
    ...(o.feed === null ? [] : [{ name: UPDATE_CONFIG_FILE, text: updateConfigYml(o.feed) }]),
  ]
}
