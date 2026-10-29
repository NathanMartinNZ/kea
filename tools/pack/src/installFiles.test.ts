// How a package records its install kind and version, and the macOS updater's feed file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTALL_KINDS } from '../../../packages/protocol/src/updates.ts'
import { linuxInstallKind, macResourceFiles, updateConfigYml } from './installFiles.ts'
import { rootFiles, stageRoot, type PackageMeta } from './os/linuxPackage.ts'

const meta: PackageMeta = { version: '1.2.3', description: 'Run many coding-agent CLI sessions side by side.', maintainer: 'Kea <kea-app@invalid>', repository: 'some-owner/kea', keyFile: null }
const FEED = 'https://github.com/some-owner/kea/releases/latest/download/'

describe('install kind, version and update feed files', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  // The macOS app: `mac`, its version, and the feed file only with a repository; the feed file names the generic
  // provider, the latest release's folder and the updater's own cache folder. Linux: one install kind per archive at
  // the same path in the app's resources, the version in every archive; each archive stages only its own kind.
  it('U-PACK-52 · each package records how it was installed and its version beside the app’s resources; the macOS release app names its feed', () => {
    expect(updateConfigYml(FEED)).toBe(['provider: generic', `url: ${FEED}`, 'updaterCacheDirName: kea-updater', ''].join('\n'))
    expect(macResourceFiles({ version: '1.2.3', feed: FEED })).toEqual([
      { name: 'install-kind', text: 'mac\n' },
      { name: 'kea-version', text: '1.2.3\n' },
      { name: 'app-update.yml', text: updateConfigYml(FEED) },
    ])
    expect(macResourceFiles({ version: '1.2.3', feed: null }).map((f) => f.name), 'no repository, no feed').toEqual(['install-kind', 'kea-version'])
    expect((['deb', 'rpm', 'tar.gz'] as const).map(linuxInstallKind)).toEqual(['deb', 'rpm', 'tarball'])
    for (const k of ['mac', 'deb', 'rpm', 'tarball']) expect(INSTALL_KINDS as readonly string[], `main reads ${k}`).toContain(k)

    const files = rootFiles({ meta, icons: '/i', fonts: '/f', launcher: '/l', licences: '/w' })
    expect(files.filter((f) => f.path === '/opt/Kea/resources/install-kind')).toEqual([
      { path: '/opt/Kea/resources/install-kind', mode: 0o644, text: 'deb\n', only: ['deb'] },
      { path: '/opt/Kea/resources/install-kind', mode: 0o644, text: 'rpm\n', only: ['rpm'] },
      { path: '/opt/Kea/resources/install-kind', mode: 0o644, text: 'tarball\n', only: ['tar.gz'] },
    ])
    expect(files.filter((f) => f.path === '/opt/Kea/resources/kea-version')).toEqual([{ path: '/opt/Kea/resources/kea-version', mode: 0o644, text: '1.2.3\n' }])
    expect(files.some((f) => f.path === '/opt/Kea/resources/version'), "Electron's own version file stays Electron's").toBe(false)

    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-installfiles-'))
    dirs.push(d)
    const app = path.join(d, 'app')
    fs.mkdirSync(path.join(app, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(app, 'resources', 'version'), '44.5.1')
    const own = files.filter((f) => f.path.startsWith('/opt/Kea/'))
    for (const [format, kind] of [['deb', 'deb'], ['rpm', 'rpm'], ['tar.gz', 'tarball']] as const) {
      const root = path.join(d, format)
      const staged = stageRoot(root, { app, files: own, format })
      expect(staged.filter((f) => f.path === '/opt/Kea/resources/install-kind'), format).toEqual([{ path: '/opt/Kea/resources/install-kind', mode: 0o644, dir: false }])
      expect(fs.readFileSync(path.join(root, 'opt/Kea/resources/install-kind'), 'utf8'), format).toBe(`${kind}\n`)
      expect(fs.readFileSync(path.join(root, 'opt/Kea/resources/kea-version'), 'utf8'), format).toBe('1.2.3\n')
      expect(fs.readFileSync(path.join(root, 'opt/Kea/resources/version'), 'utf8'), format).toBe('44.5.1')
    }
  })
})
