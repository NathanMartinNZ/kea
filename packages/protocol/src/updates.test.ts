// A release's file names, as tools/pack makes them and the update check reads them back from SHA256SUMS; versions
// compared; the update state the window is sent and the marks main keeps, checked as they cross.
import { describe, expect, it } from 'vitest'
import { compareVersions, offeredVersion, releaseFileNames, releaseUrls } from './release.ts'
import { NO_UPDATE_STATE, zUpdateMarks, zUpdateState } from './updates.ts'

/** A release's SHA256SUMS, as `pnpm release:sums` writes it (16 files). */
const SUMS = ['InRelease', 'Kea-1.0.2-arm64-mac.zip', 'Kea-1.0.2-arm64-mac.zip.blockmap', 'Packages', 'Packages.gz', 'Release', 'Release.gpg', 'install.sh', 'kea-app-1.0.2-1.aarch64.rpm', 'kea-app-1.0.2-1.x86_64.rpm', 'kea-app-1.0.2-linux-arm64.tar.gz', 'kea-app-1.0.2-linux-x64.tar.gz', 'kea-app.asc', 'kea-app_1.0.2_amd64.deb', 'kea-app_1.0.2_arm64.deb', 'latest-mac.yml']
  .map((name, i) => `${i.toString(16).padStart(64, '0')}  ${name}`)
  .join('\n')

describe('a release’s files', () => {
  it('U-DST-40 · each install’s own file in a release’s SHA256SUMS names the version offered, for every kind and architecture; the names are the ones the packages get', () => {
    for (const arch of ['x64', 'arm64'] as const) for (const kind of ['deb', 'rpm', 'tarball'] as const) expect(offeredVersion(SUMS, kind, arch), `${kind} ${arch}`).toBe('1.0.2')
    expect(offeredVersion(SUMS, 'zip', 'arm64')).toBe('1.0.2')
    const n = releaseFileNames('1.0.2', 'arm64')
    for (const name of [n.deb, n.rpm, n.tarball, n.zip]) expect(SUMS, name).toContain(`  ${name}`)
    expect(releaseFileNames('1.0.2', 'x64')).toMatchObject({ deb: 'kea-app_1.0.2_amd64.deb', rpm: 'kea-app-1.0.2-1.x86_64.rpm', tarball: 'kea-app-1.0.2-linux-x64.tar.gz', tarDir: 'kea-app-1.0.2-linux-x64' })
  })

  it('U-DST-41 · a prerelease (`-rc.1`, `~rc.1`) is never offered, a later rpm release number is, a file of another architecture or a line that is no checksum is not', () => {
    const line = (name: string) => `${'a'.repeat(64)}  ${name}`
    expect(offeredVersion(line('kea-app_1.1.0-rc.1_arm64.deb'), 'deb', 'arm64')).toBeNull()
    expect(offeredVersion(line('kea-app-1.1.0~rc.1-1.aarch64.rpm'), 'rpm', 'arm64')).toBeNull()
    expect(offeredVersion(line('kea-app-1.1.0-3.aarch64.rpm'), 'rpm', 'arm64')).toBe('1.1.0')
    expect(offeredVersion(line('kea-app_1.1.0_amd64.deb'), 'deb', 'arm64')).toBeNull()
    expect(offeredVersion(`${'a'.repeat(63)}  kea-app_1.1.0_arm64.deb`, 'deb', 'arm64')).toBeNull()
    expect(offeredVersion(`${'a'.repeat(64)} *kea-app_1.1.0_arm64.deb`, 'deb', 'arm64'), 'binary mode mark').toBe('1.1.0')
    expect(offeredVersion('', 'deb', 'arm64')).toBeNull()
  })

  it('U-DST-42 · versions compare part by part as numbers; a release page is named by its tag', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.2', '1.0.2')).toBe(0)
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.1.0-rc.1', '1.1.0'), 'a suffix is not part of the number').toBe(0)
    expect(releaseUrls('NathanMartinNZ/kea').tag('1.0.3')).toBe('https://github.com/NathanMartinNZ/kea/releases/tag/v1.0.3')
  })
})

describe('the update state as it crosses', () => {
  it('U-DST-43 · the window takes only a well-formed state; the marks read every field that parses and default the rest', () => {
    expect(zUpdateState.parse(NO_UPDATE_STATE)).toEqual(NO_UPDATE_STATE)
    const ready = { ...NO_UPDATE_STATE, mode: 'updater', auto: true, command: 'curl … | sh', phase: { k: 'downloading', version: '1.0.3', percent: 40 }, lastChecked: 1_700_000_000_000 }
    expect(zUpdateState.safeParse(ready).success).toBe(true)
    for (const bad of [
      { ...ready, phase: { k: 'downloading', version: '1.0.3', percent: 140 } },
      { ...ready, phase: { k: 'available', version: '1.0' } },
      { ...ready, phase: { k: 'failed', reason: 'x'.repeat(201) } },
      { ...ready, mode: 'snap' },
      { ...ready, command: 'x'.repeat(301) },
    ])
      expect(zUpdateState.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    expect(zUpdateMarks.parse({ noticeShown: true, expected: { version: '1.0.3', attempts: -1 }, skip: ['1.0.1', 'x'] })).toEqual({ noticeShown: true, expected: null, skip: [] })
    expect(zUpdateMarks.parse({})).toEqual({ noticeShown: false, expected: null, skip: [] })
  })
})
