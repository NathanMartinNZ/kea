// The licences file, one version, a release build's rules, the repository's URLs and macOS's feed.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRepository, RELEASE_REPOSITORY, releaseUrls } from '../../../packages/protocol/src/release.ts'
import { MAC_BUNDLES } from './audit.ts'
import { bundledPackages, crates, licenceFiles, licencesText, npmDependency, PACKAGE_LICENCES, repositoryOf, type Dependency } from './licences.ts'
import { latestMacYml, zipName } from './macZip.ts'
import { cargoVersion, installScriptStep, releaseProblems, VERSION_RE, versionProblems } from './release.ts'

const root = path.resolve(import.meta.dirname, '..', '..', '..')

describe('licences, versions and releases', () => {
  // The licences cover every bundled dependency: a crate's normal dependencies only (not build or dev ones); under a
  // licence choice that offers MIT, its MIT text; a package with no licence file takes one from its repository (a
  // monorepo's addon from the main package), and one with neither fails the build.
  it('U-PACK-39 · the licences file: every bundled package and crate with its licence text; none missing', () => {
    const meta = {
      packages: [
        { id: 'root', name: 'kea-helper', version: '0.1.0', license: null, manifest_path: '/k/Cargo.toml' },
        { id: 'libc', name: 'libc', version: '0.2.1', license: 'MIT OR Apache-2.0', manifest_path: '/c/libc/Cargo.toml', repository: 'https://github.com/rust-lang/libc' },
        { id: 'memchr', name: 'memchr', version: '2.8.3', license: 'Unlicense OR MIT', manifest_path: '/c/memchr/Cargo.toml' },
        { id: 'cc', name: 'cc', version: '1.0.0', license: 'MIT', manifest_path: '/c/cc/Cargo.toml' },
        { id: 'tempfile', name: 'tempfile', version: '3.0.0', license: 'MIT', manifest_path: '/c/tempfile/Cargo.toml' },
      ],
      resolve: {
        root: 'root',
        nodes: [
          { id: 'root', deps: [{ pkg: 'libc', dep_kinds: [{ kind: null }] }, { pkg: 'cc', dep_kinds: [{ kind: 'build' }] }, { pkg: 'tempfile', dep_kinds: [{ kind: 'dev' }] }] },
          { id: 'libc', deps: [{ pkg: 'memchr', dep_kinds: [{ kind: null }] }] },
          { id: 'memchr', deps: [] },
        ],
      },
    }
    expect(crates(meta).map((c) => `${c.name} ${c.dir} ${c.repository}`)).toEqual(['libc /c/libc rust-lang/libc', 'memchr /c/memchr null'])
    expect(licenceFiles({ licence: 'MIT OR Apache-2.0' }, ['LICENSE-APACHE', 'LICENSE-MIT', 'README.md'])).toEqual(['LICENSE-MIT'])
    expect(licenceFiles({ licence: 'Unlicense OR MIT' }, ['COPYING', 'LICENSE-MIT', 'UNLICENSE'])).toEqual(['LICENSE-MIT'])
    expect(licenceFiles({ licence: 'Apache-2.0' }, ['LICENSE', 'NOTICE', 'license.md'])).toEqual(['LICENSE', 'NOTICE', 'license.md'])
    expect(repositoryOf('https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit')).toBe('xtermjs/xterm.js')
    expect(repositoryOf({ url: 'git+https://github.com/WiseLibs/better-sqlite3.git' })).toBe('wiselibs/better-sqlite3')
    expect(repositoryOf('git@github.com:a/b.git')).toBe('a/b')
    expect(repositoryOf(undefined)).toBeNull()

    const deps: Dependency[] = [
      { name: 'zod', version: '4.0.0', licence: 'MIT', dir: '/n/zod', repository: 'colinhacks/zod' },
      { name: '@xterm/xterm', version: '6.0.0', licence: 'MIT', dir: '/n/xterm', repository: 'xtermjs/xterm.js' },
      { name: '@xterm/headless', version: '6.0.0', licence: 'MIT', dir: '/n/headless', repository: 'xtermjs/xterm.js' },
    ]
    const files: Record<string, string[]> = { '/n/zod': ['LICENSE', 'index.js'], '/n/xterm': ['LICENSE'], '/n/headless': ['package.json'] }
    const text = licencesText({ product: 'Kea', version: '0.1.0', deps, notices: [{ title: 'Electron — MIT', text: 'electron licence' }], texts: {}, files: (d) => files[d] ?? [], read: (f) => `text of ${f}\n` })
    expect(text.split('\n').slice(0, 2)).toEqual(['Kea 0.1.0: the licences of the software it is made of.', "Chromium's credits are in LICENSES.chromium.html, in Kea's folder (macOS: Kea.app/Contents/Resources)."])
    const sections = text.split(`${'-'.repeat(78)}\n`).slice(1).map((s) => s.trim())
    expect(sections).toEqual([
      'Electron — MIT\n\nelectron licence',
      '@xterm/headless@6.0.0 — MIT (the licence of @xterm/xterm, from the same repository)\n\ntext of /n/xterm/LICENSE',
      '@xterm/xterm@6.0.0 — MIT\n\ntext of /n/xterm/LICENSE',
      'zod@4.0.0 — MIT\n\ntext of /n/zod/LICENSE',
    ])
    expect(() => licencesText({ product: 'Kea', version: '1', deps: [{ ...deps[2]!, repository: 'other/repo' }], notices: [], texts: {}, files: (d) => files[d] ?? [], read: () => '' })).toThrow(/no licence text for @xterm\/headless@6.0.0/)
  })

  // Each system's file lists the packages of the bundles it ships: Linux's leave out the macOS updater's, but for a
  // package another bundle holds too; the old flat list is refused. A package that ships no licence file and has no
  // sibling to borrow from takes its text from PACKAGE_LICENCES, pinned to its version: lazy-val, which the updater
  // bundles, is one, and the installed lazy-val still ships none and declares MIT under the author the text names.
  it('U-PACK-53 · the licences per bundle: Linux’s leave out the macOS updater’s packages; a package without a licence file takes the text pinned for its version', () => {
    const byBundle = { 'main.cjs': ['/n/zod'], 'core.cjs': ['/n/zod', '/n/debug'], 'updater.cjs': ['/n/debug', '/n/lazy-val', '/n/fs-extra'], native_modules: ['/n/better-sqlite3'] }
    expect(bundledPackages(byBundle, [])).toEqual(['/n/better-sqlite3', '/n/debug', '/n/fs-extra', '/n/lazy-val', '/n/zod'])
    expect(bundledPackages(byBundle, MAC_BUNDLES), 'debug stays: core holds it too').toEqual(['/n/better-sqlite3', '/n/debug', '/n/zod'])
    for (const bad of [['/n/zod'], null, { 'main.cjs': '/n/zod' }]) expect(() => bundledPackages(bad, []), JSON.stringify(bad)).toThrow(/build again with tools\/build\.ts --packages-out/)

    const lazy: Dependency = { name: 'lazy-val', version: '1.0.5', licence: 'MIT', dir: '/n/lazy-val', repository: 'develar/lazy-val' }
    const text = licencesText({ product: 'Kea', version: '1', deps: [lazy], notices: [], texts: PACKAGE_LICENCES, files: () => ['package.json', 'out'], read: () => '' })
    expect(text).toContain(`lazy-val@1.0.5 — MIT\n\n${PACKAGE_LICENCES['lazy-val@1.0.5']}`)
    expect(PACKAGE_LICENCES['lazy-val@1.0.5']).toMatch(/^MIT License\n\nCopyright \(c\) Vladimir Krivosheev\n\nPermission is hereby granted/)
    expect(() => licencesText({ product: 'Kea', version: '1', deps: [{ ...lazy, version: '1.0.6' }], notices: [], texts: PACKAGE_LICENCES, files: () => [], read: () => '' })).toThrow(/no licence text for lazy-val@1\.0\.6: add the licence its package\.json declares to PACKAGE_LICENCES/)
    // the one installed: still without a licence file, MIT, by the author the text names
    const installed = npmDependency(path.dirname(createRequire(createRequire(path.join(root, 'app/main/package.json')).resolve('electron-updater/package.json')).resolve('lazy-val/package.json')))
    expect(`${installed.name}@${installed.version}`).toBe('lazy-val@1.0.5')
    expect(installed.licence).toBe('MIT')
    expect(licenceFiles(installed, fs.readdirSync(installed.dir))).toEqual([])
    expect((JSON.parse(fs.readFileSync(path.join(installed.dir, 'package.json'), 'utf8')) as { author: string }).author).toBe('Vladimir Krivosheev')
  })

  // One version: package.json's, semver or a release candidate, and the helper's Cargo.toml the same (true of this
  // tree). A release build is refused while the repository is not named, the key is missing, or it is signed ad hoc.
  // The repository's URLs, and macOS's feed naming the zip by its versioned release URL (by its name while no
  // repository is named).
  // install.sh pins the repository's key. Until the key exists a release is the macOS zip alone, installed by hand,
  // as the release check allows; a Linux release cannot go without it (its packages install the key for apt).
  it('U-PACK-47 · install.sh is built once the repository and its key are named; without the key a build and a macOS release go without it, a Linux release is refused', () => {
    const repository = 'some-owner/kea'
    for (const system of ['darwin', 'linux'] as const) {
      expect(installScriptStep({ system, release: true, repository, key: true }), system).toEqual({ kind: 'build' })
      expect(installScriptStep({ system, release: false, repository, key: false }).kind, system).toBe('skip')
    }
    const mac = installScriptStep({ system: 'darwin', release: true, repository, key: false })
    expect(mac).toMatchObject({ kind: 'skip' })
    expect(mac.kind === 'skip' ? mac.note : '').toMatch(/installed by hand/)
    expect(installScriptStep({ system: 'linux', release: true, repository, key: false })).toMatchObject({ kind: 'refuse' })
    // the release check before the build agrees: a macOS release asks for no key, a Linux release does
    expect(releaseProblems({ repository, key: true, adhoc: false, version: '1.0.0' })).toEqual([])
    expect(releaseProblems({ repository, key: false, adhoc: false, version: '1.0.0' })).toHaveLength(1)
  })

  it('U-PACK-40 · one version; a release needs the repository, its key and the certificate; the feed names the zip by its release URL', () => {
    for (const v of ['0.1.0', '0.2.0', '0.2.0-rc.1', '10.20.30-rc.12']) expect(VERSION_RE.test(v), v).toBe(true)
    for (const v of ['0.2', '0.2.0-beta.1', '01.2.3', '0.2.0-rc.01', '0.2.0+meta', 'v0.2.0']) expect(VERSION_RE.test(v), v).toBe(false)
    expect(cargoVersion('[package]\nname = "kea-helper"\nversion = "0.1.0"\n\n[dependencies]\nversion = "9"\n')).toBe('0.1.0')
    expect(cargoVersion('[dependencies]\nlibc = "0.2"\n')).toBeNull()
    expect(versionProblems(root), 'this tree: package.json and the helper agree').toEqual([])

    if (RELEASE_REPOSITORY !== null) expect(parseRepository(RELEASE_REPOSITORY), 'the named repository is owner/name').not.toBeNull()
    expect(releaseProblems({ repository: null, key: false, adhoc: true, version: '0.2.0-beta' })).toHaveLength(4)
    expect(releaseProblems({ repository: 'some-owner/kea', key: true, adhoc: false, version: '0.2.0' })).toEqual([])

    expect(parseRepository('some-owner/kea')).toEqual({ owner: 'some-owner', name: 'kea' })
    for (const bad of ['kea', 'a/b/c', '-a/kea', 'a-/kea', 'a--b/kea', 'a/..', 'a b/kea', '/kea']) expect(parseRepository(bad), bad).toBeNull()
    const urls = releaseUrls('Some-Owner/kea')
    expect(urls.latest).toBe('https://github.com/Some-Owner/kea/releases/latest/download/')
    expect(urls.file('0.2.0', 'Kea-0.2.0-arm64-mac.zip')).toBe('https://github.com/Some-Owner/kea/releases/download/v0.2.0/Kea-0.2.0-arm64-mac.zip')
    expect(urls.rpmBase).toBe('https://some-owner.github.io/kea/rpm/$basearch')
    expect(() => releaseUrls('nope')).toThrow(/not a GitHub repository/)

    expect(zipName('0.2.0')).toBe('Kea-0.2.0-arm64-mac.zip')
    const yml = latestMacYml({ version: '0.2.0', zip: 'Kea-0.2.0-arm64-mac.zip', sha512: 'abc==', size: 42, repository: 'some-owner/kea', releaseDate: '2026-10-21T12:00:00.000Z' })
    expect(yml).toBe(
      [
        'version: 0.2.0',
        'files:',
        '  - url: https://github.com/some-owner/kea/releases/download/v0.2.0/Kea-0.2.0-arm64-mac.zip',
        '    sha512: abc==',
        '    size: 42',
        'path: https://github.com/some-owner/kea/releases/download/v0.2.0/Kea-0.2.0-arm64-mac.zip',
        'sha512: abc==',
        "releaseDate: '2026-10-21T12:00:00.000Z'",
        '',
      ].join('\n'),
    )
    expect(latestMacYml({ version: '0.2.0', zip: 'Kea-0.2.0-arm64-mac.zip', sha512: 'abc==', size: 42, repository: null, releaseDate: 'd' })).toContain('  - url: Kea-0.2.0-arm64-mac.zip\n')
  })
})
