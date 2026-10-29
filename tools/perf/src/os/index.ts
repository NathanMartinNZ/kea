// The test harnesses' OS layer: what launching Kea for a test run, and measuring it, needs of the system
// it runs on. The harnesses (tools/perf, tests/support, tests/*) import this file only; `select.ts` picks `darwin.ts`
// or `linux.ts` once, at start. A tool one system lacks is "not available" with its reason, which the test that needs
// it skips by.
import type { NotAvailable, System } from '../../../../packages/protocol/src/platform.ts'

/**
 * `display`: where a harness's Kea draws. On macOS the person's own screen, so the harness keeps the window from ever
 * taking their keyboard (`--kea-perf`, the front guard, `assertUnfocused`). On Linux an X server of the run's own
 * (Xvfb), so no key of the person's can reach a test terminal and no window of a run shows on their desktop, whatever
 * the session (Wayland, X11, none over SSH or in CI).
 */
export interface HarnessDisplay {
  /**
   * Whether the display is the person's own: a run's window could then take their keyboard, and the harness checks at
   * every launch that it does not. False where the display is the run's own, which nobody else can type into.
   */
  readonly shared: boolean
  /**
   * Why a run's Kea has no menu-bar item (macOS) or tray icon (Linux) to run from with no window, or null where it has
   * one. On Linux a run has no session bus, so no tray host: closing the last window quits Kea, and the tests
   * of the menu-bar mode skip by name there.
   */
  readonly trayProblem: string | null
  /**
   * The switches and environment a launch adds. Linux: `--ozone-platform=x11` on the run's display, and
   * `--kea-perf-clipboard`, since that display's clipboard is the run's own (macOS's is the person's, never touched).
   */
  launch(): Promise<{ args: string[]; env: Record<string, string | undefined> }>
}

/** `front`: which app the system has in front, where it has that notion (macOS: `lsappinfo`). */
export interface Frontmost {
  /** The pid of the app in front, or null when it cannot be told. */
  pid(): number | null
}

/**
 * `keepAwake`: the command line that runs `argv` with the machine kept awake for a long run (`pnpm perf`,
 * `pnpm test:long`): macOS's `caffeinate -di` (on, too, the display, without which Electron's main keeps memory per
 * window); Linux's `systemd-inhibit` against idle and sleep, where logind grants it to this session (an SSH or CI
 * session is refused: the command then runs as it is, and the reason is the second value).
 */
export interface KeepAwake {
  wrap(argv: readonly string[]): { file: string; args: string[]; warning: string | null }
}

/** `cpu`: CPU time used so far, user and system, in seconds, by each pid still alive (one look for all). */
export interface CpuTimes {
  seconds(pids: readonly number[]): Promise<Map<number, number>>
}

/** `openFiles`: how many files a process has open now (macOS: `lsof -p`'s lines; Linux: `/proc/<pid>/fd`). */
export interface OpenFiles {
  count(pid: number): Promise<number>
}

/**
 * `unixSockets`: the sockets bound to a path (a holder's listening socket and each connection it accepted that is still
 * open), where a process's own descriptors cannot be read: a holder is not dumpable on Linux.
 */
export interface UnixSockets {
  at(path: string): Promise<number>
}

/** A small volume of its own for disk-full tests (C-RES-1): an APFS disk image on macOS, a size-limited tmpfs on Linux. */
export interface SmallVolumes {
  /** Why one cannot be mounted here, or null when it can (Linux: mounting needs root, through `sudo -n`). */
  problem(): Promise<string | null>
  /** Mount a fresh volume of `mb` MiB, this user's alone, on the empty folder `at`; resolves with its detach. */
  mount(at: string, mb: number, name: string): Promise<{ detach(): Promise<void> }>
}

/** `backupAttribute`: Time Machine's exclusion attribute on a path, as `xattr -p` reads it. */
export interface BackupAttribute {
  /** The attribute's value as hex (`xattr -px`), or null when the path does not carry it. */
  hex(p: string, attr: string): Promise<string | null>
}

/** `leaks`: macOS's leak checker, run with `-atExit` around a program (L-HLD-3). */
export interface Leaks {
  readonly file: string
}

/**
 * `powerLog`: the display's state from the system's power log (`pmset -g log`), for the window-cycle leak test
 * (L-TERM-5): with the display off, Electron's main keeps memory for each window made and closed.
 */
export interface PowerLog {
  display(since: number): Promise<{ on: boolean | null; offs: string[] }>
}

/** `ownedUnmapped`: main's owned unmapped memory blocks (`footprint -p`), for the window-cycle leak test (L-TERM-5). */
export interface OwnedUnmapped {
  blocks(pid: number): Promise<number>
}

/** `machine`: what a perf record says of the machine: model, system, power. */
export interface MachineFacts {
  model(): string | null
  system(release: string): string
  /** On AC power or battery; null when it cannot be told (a desktop or a VM has no battery). */
  power(): 'AC' | 'battery' | null
}

export interface HarnessOs {
  readonly system: System
  readonly display: HarnessDisplay
  readonly front: Frontmost | NotAvailable
  readonly keepAwake: KeepAwake
  readonly cpu: CpuTimes
  readonly openFiles: OpenFiles
  readonly unixSockets: UnixSockets | NotAvailable
  readonly smallVolumes: SmallVolumes
  readonly backupAttribute: BackupAttribute | NotAvailable
  readonly leaks: Leaks | NotAvailable
  readonly powerLog: PowerLog | NotAvailable
  readonly ownedUnmapped: OwnedUnmapped | NotAvailable
  readonly machine: MachineFacts
}

export { harnessOs } from './select.ts'
