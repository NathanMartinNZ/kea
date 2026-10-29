// Kea's files replaced or removed under the running Kea, as a Linux package manager does (`apt upgrade`, `dnf
// upgrade`): main keeps its own `app.asar` open and runs on, but a core or ptyhost started now would load the new
// files into the old Electron. Three signs, each enough:
//
// · A child from another build exits at once with L.childBuildMismatchExit (its bundle's build id is not main's).
// · Before any respawn, `app.asar` is compared with the file main started with (device and inode, read through
//   `original-fs`: Electron's `fs` makes up a new inode for an archive on every call).
// · The package watch (deb and rpm) settles after a change in `resources/`, and the same comparison runs.
//
// A new `app.asar` whose tree says the running version (the same release installed again) changes nothing; a missing
// one means Kea was removed. Once upgraded, no child starts again: a refused respawn restarts the whole of Kea into
// the new files, once per target version (`--kea-relaunched=<version>` on the new start's command line), and never
// once Kea was removed.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** The command-line marker a restart for an upgrade carries: the version it restarted for. */
export const RELAUNCHED = '--kea-relaunched='

/** What the guard reads and does. */
export interface UpgradeDeps {
  /** The running Kea's version. */
  running: string
  /** The version this start was restarted for (`RELAUNCHED`); null for a normal start. */
  relaunchedFor: string | null
  /** `app.asar`'s identity now (device and inode); null when it is missing. */
  identity(): string | null
  /** The version the tree on disk says (`resources/kea-version`); null when it says none. */
  treeVersion(): string | null
  upgraded(version: string | null): void
  removed(): void
  /** Restart Kea into the files on disk, for `target`. */
  relaunch(target: string): void
  log: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void }
}

export class UpgradeGuard {
  private readonly d: UpgradeDeps
  /** `app.asar` as main started with it; null where there is none (a dev build runs from a folder). */
  private readonly first: string | null
  private state: 'running' | 'upgraded' | 'removed' = 'running'

  constructor(d: UpgradeDeps) {
    this.d = d
    this.first = d.identity()
  }

  get now(): 'running' | 'upgraded' | 'removed' {
    return this.state
  }

  /** Compare `app.asar` with the one main started with (the watch settled, or a respawn is asked for). */
  check(): void {
    if (this.state !== 'running' || this.first === null) return
    const id = this.d.identity()
    if (id === this.first) return
    if (id === null) {
      this.state = 'removed'
      this.d.log.warn("Kea's files were removed under it")
      this.d.removed()
      return
    }
    const version = this.d.treeVersion()
    if (version !== null && version === this.d.running) return // the same release installed again
    this.mark(version)
  }

  /** The Supervisor's question before a respawn: false once Kea's files changed. */
  mayRespawn(): boolean {
    this.check()
    return this.state === 'running'
  }

  /** Kea's files are known to be replaced (the test hooks stand in for the watch with this). */
  replaced(version: string | null): void {
    if (this.state === 'running') this.mark(version)
  }

  /** A child exited with L.childBuildMismatchExit: the files on disk are another build's. */
  childFromOtherBuild(): void {
    if (this.state !== 'running') return
    this.mark(this.d.treeVersion())
  }

  /** A respawn was refused: restart Kea into the new files, unless it was removed or already restarted for them. */
  respawnRefused(): void {
    if (this.state === 'removed') return
    const target = this.d.treeVersion() ?? 'unknown'
    if (this.d.relaunchedFor === target) {
      this.d.log.warn('not restarting again for the same version', { target })
      return
    }
    this.d.log.info("restarting Kea into the files that replaced it", { target })
    this.d.relaunch(target)
  }

  private mark(version: string | null): void {
    this.state = 'upgraded'
    this.d.log.info("Kea's files were replaced under it", { version })
    this.d.upgraded(version)
  }
}

/** The arguments of a restart for `target`: this start's own (after the executable), without an earlier marker. */
export function relaunchArgs(argv: readonly string[], target: string): string[] {
  return [...argv.slice(1).filter((a) => !a.startsWith(RELAUNCHED)), `${RELAUNCHED}${target}`]
}

/** The version a start was restarted for, from its command line; null for a normal start. */
export function relaunchedFor(argv: readonly string[]): string | null {
  const a = argv.find((x) => x.startsWith(RELAUNCHED))
  return a ? a.slice(RELAUNCHED.length) || null : null
}

type StatSync = (p: string) => { dev: number; ino: number }

// `__filename` is the bundle (main.cjs) when main runs bundled; under Node's type stripping `import.meta.url` names this file
const load = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

/** `statSync` without Electron's archive layer: `original-fs`'s where Electron runs this, `node:fs`'s otherwise. */
export function plainStat(versions: Readonly<Record<string, string | undefined>> = process.versions): StatSync {
  if (versions.electron) {
    try {
      const plain = load('original-fs') as typeof fs | undefined
      if (plain && typeof plain.statSync === 'function') return (p) => plain.statSync(p)
    } catch {
      // node:fs below
    }
  }
  return (p) => fs.statSync(p)
}

/** `resources/app.asar`'s device and inode, or null when it is missing. */
export function asarIdentity(resourcesDir: string, stat: StatSync): string | null {
  try {
    const s = stat(path.join(resourcesDir, 'app.asar'))
    return `${s.dev}:${s.ino}`
  } catch {
    return null
  }
}

/** The version the tree on disk says (`resources/kea-version`); null when it says none. */
export function treeVersion(resourcesDir: string): string | null {
  try {
    const v = fs.readFileSync(path.join(resourcesDir, 'kea-version'), 'utf8').trim()
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null
  } catch {
    return null
  }
}
