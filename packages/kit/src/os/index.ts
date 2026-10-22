// @kea/kit's OS layer: the OS capabilities the kit owns, for main, core and ptyhost. Callers import this
// file only; `select.ts` picks `darwin.ts` or `linux.ts` once, at start.
import type { NotAvailable, System } from '@kea/protocol/platform'
import type { Disposable } from '../disposable.ts'

/** `instanceLock`: one core and one ptyhost per KEA_HOME. */
export interface InstanceLock {
  /**
   * Takes the lock `path` names (`<KEA_HOME>/run/<name>.lock`), a `flock` on that file. It lasts until disposed or until
   * the process ends, however it ends; null when another process, or this one, holds it. Linux refuses a run directory
   * that is not this user's alone.
   */
  tryLock(path: string): Disposable | null
}

/** `backgroundIo`: a command run at background I/O priority, as kit's trash deletes. */
export interface BackgroundIo {
  /** The argv that runs `file args…` at background priority. */
  argv(file: string, args: readonly string[]): { file: string; args: string[] }
}

/**
 * `nameKey`: how a file name is compared and how file operations take it. APFS ignores Unicode normalisation, so macOS
 * uses NFC for both, as Kea always has; ext4 and btrfs keep a name's bytes as stored, so on Linux every file operation
 * uses the name as stored and NFC is only the key it is compared and searched by.
 */
export interface NameKey {
  /** The key two names are compared and searched by: NFC on both systems. */
  key(name: string): string
  /** A name or path as file operations and the views take it: macOS NFC; Linux the name as stored, untouched. */
  fileName(name: string): string
  /** `fileName` keeps names as stored (Linux): a search then indexes the key and answers with the stored name. */
  readonly asStored: boolean
}

/** `paths`: where Electron keeps an app's own data for a user. */
export interface Paths {
  /**
   * The folder of the app named `name`, as Electron finds it for a process started with `env`: on macOS under the
   * account's home folder, whatever HOME says; on Linux under `$XDG_CONFIG_HOME`, else `$HOME/.config`.
   */
  appData(o: { accountHome: string; env: Readonly<Record<string, string | undefined>> }, name: string): string
}

/**
 * `runtimeDir`: the user's own runtime folder, where the holders' sockets go when `<home>/run` would make a socket path
 * too long (`<dir>/kea/<hash>`); the helper's `os::runtime_dir` checks the same way.
 */
export interface RuntimeDir {
  /** The folder, or null when this system offers none or it is not the user's own (then `/tmp/kea-<uid>` serves). */
  dir(): string | null
}

/**
 * `holderVisibility`: whether `/proc` hides this user's own non-dumpable holders from it (mounted with `hidepid`), so
 * that a holder `kea-helper procs` does not list may still be running.
 */
export interface HolderVisibility {
  /** `hidepid`'s value when it hides them (`invisible`, `2`, `noaccess`, `1`, `ptraceable`, `4`), else null. */
  hidden(): string | null
}

export interface KitOs {
  readonly system: System
  readonly instanceLock: InstanceLock | NotAvailable
  readonly holderVisibility: HolderVisibility
  readonly backgroundIo: BackgroundIo | NotAvailable
  readonly nameKey: NameKey | NotAvailable
  readonly paths: Paths | NotAvailable
  readonly runtimeDir: RuntimeDir
}

export { kitOs } from './select.ts'
