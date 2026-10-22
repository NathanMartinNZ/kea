// electron-builder's configuration for every target: one function per system over shared parts.
// electron-builder makes the app itself (its `dir` target: Kea.app, or Linux's `/opt/Kea` tree); the fuses, the
// signature and the archives (the macOS zip, the Linux packages and tarball) are this tool's own steps, so every
// file, owner and mode the packages hold is written in tools/pack and checked there. `pnpm kea:install` builds with the
// same configuration (`macConfig`) and signs and checks the same way; only `pnpm package` adds the licences file and
// strips the native modules' debug symbols, which a local install has no need of.
import fs from 'node:fs'
import path from 'node:path'
import { L } from '../../../packages/protocol/src/generated/limits.ts'
import { DESKTOP_IDS } from '../../../packages/protocol/src/platform.ts'
import { APP_ID } from './target.ts'

export const PRODUCT_NAME = 'Kea'
/** The app's copyright line (macOS shows it in Finder's Get Info and the About panel). */
export const COPYRIGHT = 'Copyright © 2026 The Kea contributors'
/** Linux's executable and package name; the macOS bundle's executable stays `Kea`. */
export const LINUX_NAME = 'kea-app'
/** The packaged app id on Linux: the desktop file's name, the window class, Electron's `desktopName`. */
export const DESKTOP_FILE = `${DESKTOP_IDS.packaged}.desktop`
export const HELPER_NAME = 'kea-helper'
/** The helper's signing identifier. */
export const HELPER_ID = 'dev.kea.helper'

/** The Electron fuses every build sets: `true` on, `false` off. */
export const FUSES: Readonly<Record<string, boolean>> = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  OnlyLoadAppFromAsar: true,
  EnableEmbeddedAsarIntegrityValidation: true,
  GrantFileProtocolExtraPrivileges: false, // the UI is served from kea://, never file://
}

export type Format = 'zip' | 'deb' | 'rpm' | 'tar.gz'
export type TargetName = 'mac-arm64' | 'linux-x64' | 'linux-arm64'

export interface Target {
  readonly name: TargetName
  readonly system: 'darwin' | 'linux'
  /** Node's name for the architecture (`process.arch`). */
  readonly arch: 'arm64' | 'x64'
  /** The helper's Rust target. */
  readonly triple: string
  /** What `--formats` may name, in the order they are built; all of them by default. */
  readonly formats: readonly Format[]
}

export const TARGETS: Readonly<Record<TargetName, Target>> = {
  'mac-arm64': { name: 'mac-arm64', system: 'darwin', arch: 'arm64', triple: 'aarch64-apple-darwin', formats: ['zip'] },
  'linux-x64': { name: 'linux-x64', system: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-gnu', formats: ['deb', 'rpm', 'tar.gz'] },
  'linux-arm64': { name: 'linux-arm64', system: 'linux', arch: 'arm64', triple: 'aarch64-unknown-linux-gnu', formats: ['deb', 'rpm', 'tar.gz'] },
}

/**
 * The target and formats `--target` and `--formats` ask for, on a machine of `here`'s system and architecture.
 * A target of another system or architecture is refused: native modules and the helper are built where they run
 * (no cross-builds). Throws with the sentence to print.
 */
export function chooseTarget(o: { target: string | null; formats: string | null }, here: { system: string; arch: string }): { target: Target; formats: Format[] } {
  const native = Object.values(TARGETS).find((t) => t.system === here.system && t.arch === here.arch)
  const name = o.target ?? native?.name
  if (!name) throw new Error(`Kea is not built for ${here.system} on ${here.arch} (targets: ${Object.keys(TARGETS).join(', ')})`)
  const target = TARGETS[name as TargetName] as Target | undefined
  if (!target) throw new Error(`unknown target "${name}" (targets: ${Object.keys(TARGETS).join(', ')})`)
  if (target.system !== here.system || target.arch !== here.arch) {
    throw new Error(`${target.name} is built on a ${target.system} ${target.arch} machine, not on this ${here.system} ${here.arch} one: native modules and the helper are built where they run (no cross-builds)`)
  }
  if (o.formats === null) return { target, formats: [...target.formats] }
  const asked = o.formats.split(',').map((f) => f.trim())
  const wrong = asked.filter((f) => !target.formats.includes(f as Format))
  if (asked.length === 0 || wrong.length || asked.some((f) => f === '')) throw new Error(`--formats for ${target.name} takes ${target.formats.join(', ')} (got "${o.formats}")`)
  // built in the target's order, each once
  return { target, formats: target.formats.filter((f) => asked.includes(f)) }
}

export interface AppInputs {
  /** The release bundles (`tools/build.ts --release`): the app's package.json and code. */
  stage: string
  /** electron-builder's output folder. */
  output: string
  /** The pinned Electron already on disk (no download). */
  electronDir: string
  electronVersion: string
  /** The release `kea-helper` this build ships. */
  helper: string
  /** The app's version when it is not the stage's own (`--version-suffix` builds), else null. */
  version: string | null
  /** `assets/icon`. */
  icons: string
  /** The licences file, shipped as `resources/licenses.txt` with Chromium's credits; null: neither ships. */
  licences: string | null
}

/** Where electron-builder leaves the app it built. */
export function builtApp(target: Target, output: string): string {
  if (target.system === 'darwin') return path.join(output, `mac-${target.arch}`, `${PRODUCT_NAME}.app`)
  return path.join(output, target.arch === 'x64' ? 'linux-unpacked' : `linux-${target.arch}-unpacked`)
}

/** The app's resources folder inside what `builtApp` names. */
export function resourcesOf(target: Target, app: string): string {
  return target.system === 'darwin' ? path.join(app, 'Contents', 'Resources') : path.join(app, 'resources')
}

/** The Electron executable the fuses live in (@electron/fuses takes the bundle on macOS, the binary on Linux). */
export function fuseTarget(target: Target, app: string): string {
  return target.system === 'darwin' ? app : path.join(app, LINUX_NAME)
}

function shared(target: Target, i: AppInputs, metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    copyright: COPYRIGHT,
    directories: { app: i.stage, output: i.output },
    electronVersion: i.electronVersion,
    electronDist: path.join(i.electronDir, 'dist'), // the pinned Electron already on disk: no download
    // a copied (not downloaded) Electron keeps its default_app.asar; drop it before asar integrity is computed
    afterExtract: (ctx: { appOutDir: string }) => {
      if (target.system === 'linux') fs.rmSync(path.join(ctx.appOutDir, 'resources', 'default_app.asar'), { force: true })
      else for (const e of fs.readdirSync(ctx.appOutDir)) if (e.endsWith('.app')) fs.rmSync(path.join(ctx.appOutDir, e, 'Contents', 'Resources', 'default_app.asar'), { force: true })
    },
    asar: true,
    asarUnpack: ['**/*.node'], // native modules load from app.asar.unpacked (signed on macOS)
    files: ['**/*', '!**/*.map'], // no source maps ship: the packaged app never reads them
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    extraResources: [
      { from: i.helper, to: HELPER_NAME }, // process.resourcesPath/kea-helper (app/main)
      ...(i.licences === null ? [] : [{ from: i.licences, to: 'licenses.txt' }]),
      // Linux's tree has Electron's LICENSE and LICENSES.chromium.html at its root already; a Mac bundle has neither
      ...(i.licences !== null && target.system === 'darwin' ? [{ from: path.join(i.electronDir, 'dist', 'LICENSES.chromium.html'), to: 'LICENSES.chromium.html' }] : []),
    ],
    ...(Object.keys(metadata).length ? { extraMetadata: metadata } : {}),
    publish: null,
  }
}

/** Kea.app for an Apple silicon Mac, unsigned (the tool signs it inside out next). */
export function macConfig(i: AppInputs): Record<string, unknown> {
  const target = TARGETS['mac-arm64']
  return {
    ...shared(target, i, i.version ? { version: i.version } : {}),
    mac: { target: [{ target: 'dir', arch: ['arm64'] }], identity: null, hardenedRuntime: false, gatekeeperAssess: false, icon: path.join(i.icons, 'kea.icns'), minimumSystemVersion: `${L.macosMinMajor}.0` },
  }
}

/** `/opt/Kea`'s tree for a Linux target: the executable `kea-app`, the packaged `desktopName`. */
export function linuxConfig(target: Target, i: AppInputs): Record<string, unknown> {
  return {
    ...shared(target, i, { ...(i.version ? { version: i.version } : {}), desktopName: DESKTOP_FILE }),
    executableName: LINUX_NAME,
    linux: { target: [{ target: 'dir', arch: [target.arch] }], executableName: LINUX_NAME },
  }
}

export function builderConfig(target: Target, i: AppInputs): Record<string, unknown> {
  return target.system === 'darwin' ? macConfig(i) : linuxConfig(target, i)
}
