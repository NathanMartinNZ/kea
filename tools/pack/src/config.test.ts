// electron-builder's configuration per system and which target a machine may build.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { L } from '../../../packages/protocol/src/generated/limits.ts'
import { builderConfig, builtApp, chooseTarget, fuseTarget, linuxConfig, macConfig, resourcesOf, TARGETS, type AppInputs } from './config.ts'

const inputs: AppInputs = { stage: 'dist/pack-app', output: '/o/.builder', electronDir: '/e', electronVersion: '44.5.1', helper: '/h/kea-helper', version: null, icons: '/a/icon', licences: null }
/** The config without its one function (the hook that drops Electron's default app). */
const data = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v !== 'function'))

describe('tools/pack config', () => {
  // The macOS configuration is the app `pnpm kea:install` and the zip share, with the icon, no source maps, the
  // copyright line and the oldest macOS Kea supports; a suffix build sets its version; the licences ship only when
  // given, with Chromium's credits on macOS. Linux: the executable `kea-app`, the packaged desktopName, no updater bundle.
  it('U-PACK-31 · one config per system over shared parts: macOS as kea:install built it, plus the icon; Linux’s executable and desktopName', () => {
    expect(data(macConfig(inputs))).toEqual({
      appId: 'dev.kea.app',
      productName: 'Kea',
      copyright: 'Copyright © 2026 The Kea contributors',
      directories: { app: 'dist/pack-app', output: '/o/.builder' },
      electronVersion: '44.5.1',
      electronDist: '/e/dist',
      asar: true,
      asarUnpack: ['**/*.node'],
      files: ['**/*', '!**/*.map'],
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
      extraResources: [{ from: '/h/kea-helper', to: 'kea-helper' }],
      publish: null,
      mac: { target: [{ target: 'dir', arch: ['arm64'] }], identity: null, hardenedRuntime: false, gatekeeperAssess: false, icon: '/a/icon/kea.icns', minimumSystemVersion: `${L.macosMinMajor}.0` },
    })
    expect(typeof macConfig(inputs).afterExtract).toBe('function')
    expect(macConfig({ ...inputs, version: '0.1.0-n1' }).extraMetadata).toEqual({ version: '0.1.0-n1' })
    expect(macConfig({ ...inputs, licences: '/w/licenses.txt' }).extraResources).toEqual([
      { from: '/h/kea-helper', to: 'kea-helper' },
      { from: '/w/licenses.txt', to: 'licenses.txt' },
      { from: '/e/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html' },
    ])

    const lx = linuxConfig(TARGETS['linux-x64'], { ...inputs, licences: '/w/licenses.txt' })
    expect(lx.executableName).toBe('kea-app')
    expect(lx.extraMetadata).toEqual({ desktopName: 'dev.kea.app.desktop' })
    expect(lx.linux).toEqual({ target: [{ target: 'dir', arch: ['x64'] }], executableName: 'kea-app' })
    expect(lx.extraResources, "Linux's tree has Chromium's credits at its root already").toEqual([
      { from: '/h/kea-helper', to: 'kea-helper' },
      { from: '/w/licenses.txt', to: 'licenses.txt' },
    ])
    expect(builderConfig(TARGETS['linux-arm64'], inputs).linux).toEqual({ target: [{ target: 'dir', arch: ['arm64'] }], executableName: 'kea-app' })
    for (const k of ['appId', 'productName', 'copyright', 'asar', 'asarUnpack', 'publish']) expect(lx[k], k).toEqual(macConfig(inputs)[k])
    expect(lx.files, "Linux's tree leaves out the macOS updater's bundle").toEqual(['**/*', '!**/*.map', '!updater.cjs'])

    // where the app lands, its resources and the file the fuses are in
    expect(builtApp(TARGETS['mac-arm64'], '/o')).toBe('/o/mac-arm64/Kea.app')
    expect(builtApp(TARGETS['linux-x64'], '/o')).toBe('/o/linux-unpacked')
    expect(builtApp(TARGETS['linux-arm64'], '/o')).toBe('/o/linux-arm64-unpacked')
    expect(resourcesOf(TARGETS['mac-arm64'], '/a/Kea.app')).toBe('/a/Kea.app/Contents/Resources')
    expect(resourcesOf(TARGETS['linux-arm64'], '/a')).toBe('/a/resources')
    expect(fuseTarget(TARGETS['mac-arm64'], '/a/Kea.app')).toBe('/a/Kea.app')
    expect(fuseTarget(TARGETS['linux-arm64'], '/a')).toBe('/a/kea-app')

    // the hook drops the copied Electron's default app on either system
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-cfg-'))
    try {
      fs.mkdirSync(path.join(dir, 'Kea.app/Contents/Resources'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'Kea.app/Contents/Resources/default_app.asar'), '')
      ;(macConfig(inputs).afterExtract as (c: { appOutDir: string }) => void)({ appOutDir: dir })
      expect(fs.existsSync(path.join(dir, 'Kea.app/Contents/Resources/default_app.asar'))).toBe(false)
      fs.mkdirSync(path.join(dir, 'resources'))
      fs.writeFileSync(path.join(dir, 'resources/default_app.asar'), '')
      ;(lx.afterExtract as (c: { appOutDir: string }) => void)({ appOutDir: dir })
      expect(fs.existsSync(path.join(dir, 'resources/default_app.asar'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // `--target` defaults to this machine's; a target of another system or architecture is refused, saying that native
  // modules and the helper are built where they run; `--formats` takes the target's own, built in its order, once each;
  // each target's helper is built for its own Rust triple.
  it('U-PACK-32 · --target and --formats: this machine’s by default; no cross-builds; formats of the target only', () => {
    const mac = { system: 'darwin', arch: 'arm64' }
    const arm = { system: 'linux', arch: 'arm64' }
    expect(chooseTarget({ target: null, formats: null }, mac)).toEqual({ target: TARGETS['mac-arm64'], formats: ['zip'] })
    expect(chooseTarget({ target: null, formats: null }, arm)).toEqual({ target: TARGETS['linux-arm64'], formats: ['deb', 'rpm', 'tar.gz'] })
    expect(chooseTarget({ target: null, formats: null }, { system: 'linux', arch: 'x64' }).target.name).toBe('linux-x64')
    expect(() => chooseTarget({ target: 'linux-arm64', formats: null }, mac)).toThrow(/built on a linux arm64 machine.*no cross|built where they run/)
    expect(() => chooseTarget({ target: 'linux-x64', formats: null }, arm)).toThrow(/linux x64 machine, not on this linux arm64/)
    expect(() => chooseTarget({ target: null, formats: null }, { system: 'darwin', arch: 'x64' })).toThrow(/not built for darwin on x64/)
    expect(() => chooseTarget({ target: 'win-x64', formats: null }, mac)).toThrow(/unknown target "win-x64"/)
    expect(chooseTarget({ target: 'linux-arm64', formats: 'tar.gz,deb,deb' }, arm).formats).toEqual(['deb', 'tar.gz'])
    expect(() => chooseTarget({ target: null, formats: 'zip' }, arm)).toThrow(/takes deb, rpm, tar.gz/)
    expect(() => chooseTarget({ target: null, formats: 'deb,' }, arm)).toThrow(/--formats/)
    expect(() => chooseTarget({ target: null, formats: 'dmg' }, mac)).toThrow(/takes zip/)
    expect(TARGETS['linux-x64'].triple).toBe('x86_64-unknown-linux-gnu')
    expect(TARGETS['linux-arm64'].triple).toBe('aarch64-unknown-linux-gnu')
    expect(TARGETS['mac-arm64'].triple).toBe('aarch64-apple-darwin')
  })
})
