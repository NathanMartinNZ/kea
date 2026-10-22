// tools/pack's OS layer: what building, packaging and `pnpm kea:install` need of the system they run on.
// Callers (this folder's modules, tools/install.ts, tools/build.ts) import this file only; `select.ts` picks
// `darwin.ts` or `linux.ts` once, at start.
import type { NotAvailable, System } from '../../../../packages/protocol/src/platform.ts'

/** The system tools packaging and the install run on macOS, each by its absolute path (argv only, never a shell). */
export type MacTool = 'codesign' | 'ditto' | 'lsregister' | 'plutil' | 'lipo' | 'lsappinfo' | 'open' | 'security' | 'strip'
/** The tools the Linux packages are made and checked with. */
export type LinuxTool = 'dpkg-deb' | 'rpmbuild' | 'rpm' | 'tar' | 'apparmor_parser' | 'desktop-file-validate' | 'lintian' | 'rpmlint' | 'strip'
export type PackTool = MacTool | LinuxTool

/** `packTools`: where this system keeps them. */
export interface PackTools {
  /** The tool's absolute path; throws for a tool of the other system. */
  path(tool: PackTool): string
}

/** `installPlace`: where a build is installed for use, and the folders kept for it. */
export interface InstallPlace {
  /** Why this machine cannot take the build, or null. */
  refusal(arch: string): string | null
  /** The one path a build named `appName` is installed at for use. */
  installedApp(appName: string): string
  /** The system's and the user's folders of installed apps, as written. */
  folders(home: string): string[]
  /** How to create the signing certificate `identity` once, as the install prints it. */
  certificateSteps(identity: string): string
}

/** `nativeAddons`: the native files a build carries for this system. */
export interface NativeAddons {
  /** better-sqlite3's prebuilt addon, relative to its package (`prebuilds/<system>-<arch>.node`). */
  sqlitePrebuild(arch: string): string
  /** `@parcel/watcher`'s binding package for this system and architecture. */
  watcherPackage(arch: string): string
  /**
   * Kea's patched build of `@parcel/watcher`, relative to that package, where `pnpm install` builds it (both systems),
   * copied beside the prebuild when it is there; core loads it first (app/core/src/platform/watch/native.ts). Null
   * where the prebuild is used as it is.
   */
  readonly watcherPatchedBuild: string | null
}

/** `devDesktop`: what `pnpm dev` sets up on this system before it runs the dev build. */
export interface DevDesktop {
  /**
   * The dev build's desktop file: where it goes and its text, which starts this checkout's dev build with `electron`;
   * null where none is needed (macOS: a notification's click reaches the running app itself).
   */
  file(o: { home: string; env: NodeJS.ProcessEnv; root: string; electron: string }): { path: string; text: string } | null
  /** Why Chromium's sandbox cannot start for `electron` here, with the commands that fix it; null when it can. */
  sandboxProblem(electron: string): string | null
}

/** `rust`: where cargo may be when it is not on PATH, and how to install Rust when it is nowhere. */
export interface RustPlaces {
  cargo(home: string): string[]
  readonly installHint: string
}

export interface PackOs {
  readonly system: System
  readonly tools: PackTools | NotAvailable
  readonly rust: RustPlaces
  readonly installPlace: InstallPlace | NotAvailable
  readonly nativeAddons: NativeAddons | NotAvailable
  readonly devDesktop: DevDesktop
}

export { packOs } from './select.ts'
