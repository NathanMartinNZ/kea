// Core's OS layer: the system capabilities that core owns. Callers import this file only; `select.ts` picks `darwin.ts`
// or `linux.ts` once, at start. An implementation imports nothing from core's features but their types and pure leaf
// modules that never import this layer (no cycle through `select.ts`). Core's `src/platform/` is its infrastructure
// (db, rpc, watch), not OS code.
import type { runProcess } from '@kea/kit'
import type { NotAvailable, System } from '@kea/protocol'
import type { TerminalAppId } from '../editor/catalog.ts'
import type { GitProbePaths } from '../worktrees/git.ts'

/** A command as core runs it through kit's `runProcess`: an absolute file, its arguments and the environment it needs. */
export type Command = { file: string; args: string[]; env?: Record<string, string> }

/**
 * `editors`: where this system's editors and terminal apps are, and how a file or an app is opened. macOS
 * finds app bundles (`bundles`); Linux finds commands and desktop entries (`commands`).
 */
export type Editors = BundleEditors | CommandEditors

/** What both systems say of opening a file. */
interface OpenRules {
  /** File types (lower case, no dot) never handed to `open` on this system, beyond those every system refuses. */
  readonly neverOpened: readonly string[]
  /** The file manager as titles name it: "Reveal in <this>". */
  readonly fileManager: string
  /** The terminal apps this system offers, in Automatic's order: `general.terminalApp`'s choices here. */
  readonly terminalApps: readonly TerminalAppId[]
}

/** macOS: app bundles in application folders, found by Spotlight or by name, opened with `open -a`. */
export interface BundleEditors extends OpenRules {
  readonly kind: 'bundles'
  /** The folders searched for an app by name when the system's index has no answer, in order of preference. */
  appDirs(home: string): string[]
  /** The system's app index lookup (`mdfind`), or null: none. */
  readonly mdfind: string | null
  /** The tool that opens a file or an app (`open`). */
  readonly open: string
}

/** Linux: commands on the login PATH and in known places, and desktop entries; `xdg-open`. */
export interface CommandEditors extends OpenRules {
  readonly kind: 'commands'
  /** Where `command` is looked for after the login PATH: the places its packages put it, absolute, in order. */
  knownPlaces(command: string, home: string): string[]
  /** The XDG data folders whose `applications` hold desktop entries, in precedence order, for the environment `env`. */
  dataDirs(env: Readonly<Record<string, string | undefined>>, home: string): string[]
  /** `xdg-open`: a file with its default app, an editor's URL with its scheme's handler. */
  readonly open: string
}

/** `trash`: the system's tool that moves a file to the trash, and how it is told which. */
export interface Trash {
  readonly tool: string
  /** The arguments that move `file` (absolute) to the trash (macOS `trash -s <file>`; Linux `gio trash -- <file>`). */
  args(file: string): string[]
  /** What Discard's refusal adds when the tool is not there; null: the refusal says it all (macOS). */
  readonly missing: string | null
}

/** `mounts`: the mounted volumes, and where this system mounts them. */
export interface Mounts {
  /** The mounted volumes, as text `networkMount` reads (macOS: `mount`'s output; Linux: `/proc/self/mountinfo`). */
  read(): Promise<string>
  /** The mount point of the network volume `root` lies on, from `read()`'s text; null: a local disk. */
  networkMount(text: string, root: string): string | null
  /**
   * The folders this system mounts volumes in for this user: each `<folder>/<name>` is one volume, a place of its own
   * for the link checks.
   */
  volumeRoots(): readonly string[]
}

/** `portRange`: the ports session blocks are allocated from on this system, both ends included. */
export interface PortRange {
  /** Read once, at start. */
  range(): { start: number; end: number }
  /**
   * What cuts the range short here, for the banner: the setting and the ephemeral range's low end; null:
   * nothing.
   */
  cut(): { setting: string; low: number } | null
}

/** `backupExclude`: marks paths as excluded from the system's backups. */
export interface BackupExclude {
  mark(paths: readonly string[]): Promise<{ code: number | null; stderr: string }>
}

/** `gitProbe`: the system's git stub, if any, and how to tell whether the real git is behind it. */
export interface GitProbe {
  /** The stub and `xcode-select` (macOS); null where every `git` is the real one (Linux). */
  readonly paths: GitProbePaths | null
  /** What the person is told when only the stub is there. */
  readonly installHint: string
  /** What the person is told when no git is found at all. */
  readonly notFound: string
}

/** `shellDefaults`: the shell, the PATH and the locale when the login shell says nothing. */
export interface ShellDefaults {
  /** The shell when neither the login environment nor Kea's own names one (Linux: the passwd entry's, else `/bin/sh`). */
  readonly shell: string
  /** PATH when there is none at all. */
  readonly path: string
  /** Folders added to a fallback PATH: where package managers put their tools. */
  extraPath(home: string): string[]
  /** LANG for a terminal whose environment has none (macOS `en_US.UTF-8`; Linux that when installed, else `C.UTF-8`). */
  lang(): string
}

/** What holds a listening port: a process of this user's, by its name; another user's, which cannot be named. */
export type PortHolder = { kind: 'process'; pid: number; name: string } | { kind: 'otherUser' }

/** `portOwner`: who holds a listening port. */
export interface PortOwner {
  /**
   * What holds `port` (read only); null when nothing could say. `helper` is the `kea-helper` core runs (Linux asks its
   * `ports --all`), `run` the way core starts a child (a test's stand-in).
   */
  holder(port: number, o: { helper: string | null; run: typeof runProcess }): Promise<PortHolder | null>
}

/** inotify's two per-user limits (`/proc/sys/fs/inotify/max_user_*`). */
export interface InotifyMax {
  watches: number
  instances: number
}

/** Which of inotify's limits stopped a subscription. */
export type WatchLimitKind = 'watches' | 'instances'

/** `watcher.limits`: inotify's limits and their use, read again at each call. */
export interface WatchLimits {
  /** `max_user_watches` and `max_user_instances` now, or the user namespace's own when lower (`/proc/sys/user/max_inotify_*`); null when they cannot be read. */
  max(): Promise<InotifyMax | null>
  /** This user's inotify instances: the `anon_inode:inotify` descriptors of its processes (one that cannot be read counts none). */
  userInstances(): Promise<number>
  /** The watches this process holds, from its own `fdinfo`. */
  ownWatches(): Promise<number>
  /** The limit a watcher's error names: `ENOSPC` from `inotify_add_watch` (it has no `code`: known by its message), or the backend's start at the instance limit; null for any other. */
  limitOf(message: string): WatchLimitKind | null
  /** The `sysctl` setting of a limit (`fs.inotify.max_user_watches`). */
  setting(kind: WatchLimitKind): string
  /** The banner's fix: the command that raises the limit, and how to keep it raised. */
  fix(kind: WatchLimitKind): string
}

/** `watcher`: `@parcel/watcher`'s binding for this system and architecture, and its kernel's limits. */
export interface Watcher {
  /** The prebuilt binding's package (`watcher.node` in it): the unpatched binding, used only when the patched build is missing. */
  bindingPackage(arch: string): string
  /** The binding built at install from Kea's patch, relative to `@parcel/watcher`'s folder, tried first (both systems); null: the system runs the prebuild. */
  readonly patchedBuild: string | null
  /** The backend every call names (`inotify`: never watchman, which the binding's default would look for by starting a child); null: the binding's default (FSEvents). */
  readonly backend: string | null
  /** `single.ts` may follow a missing file from an ancestor watched recursively (macOS); never on Linux, where a recursive `fs.watch` walks on core's thread with one watch per file and per directory. */
  readonly recursiveFsWatch: boolean
  /** inotify's limits (Linux); null where the system has none that core meets (FSEvents). */
  readonly limits: WatchLimits | null
  /**
   * At most this many kernel exclusions per stream: FSEvents' `L.watchExclusionsMax` (one more turns every one off);
   * null: no limit (inotify's ignore paths).
   */
  readonly exclusionsMax: number | null
}

/**
 * `spoolLock`: the `open` flag that takes the lock `kea-helper hook` holds while it appends to a
 * spool (`flock(2)`'s `LOCK_EX`) with the open itself, without waiting, so core renames a spool only under it.
 */
export interface SpoolLock {
  readonly openFlag: number
}

/** The platform report's facts that core gives; today the `system` line of Copy Diagnostics. */
export interface Report {
  /** Kernel name, release and architecture (`Darwin 27.0.0 arm64`). */
  systemLine(): string
}

export interface CoreOs {
  readonly system: System
  readonly editors: Editors | NotAvailable
  readonly trash: Trash | NotAvailable
  readonly mounts: Mounts | NotAvailable
  readonly portRange: PortRange
  readonly backupExclude: BackupExclude | NotAvailable
  readonly gitProbe: GitProbe | NotAvailable
  readonly shellDefaults: ShellDefaults | NotAvailable
  readonly portOwner: PortOwner | NotAvailable
  readonly watcher: Watcher | NotAvailable
  readonly spoolLock: SpoolLock | NotAvailable
  readonly report: Report
}

export { coreOs } from './select.ts'
