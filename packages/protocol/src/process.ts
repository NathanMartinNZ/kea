// Messages between `main` and its utility processes (core, ptyhost) over Electron's `parentPort`. `main` only brokers:
// it hands out MessagePorts, runs the heartbeat and collects resource reports; all real traffic flows on the
// ports.

import { L } from './generated/limits.ts'
import { zPlatformReport, type PlatformReport } from './platform.ts'
import { isResourceReport, type ResourceReport } from './resources.ts'
import { SESSION_GLYPHS, type SessionGlyph } from './sessions.ts'
import { ON_QUIT } from './settings.ts'

/**
 * One line of the menu-bar item's menu: a session that needs you, or an account condition (one line for all
 * the sessions it holds). `id`: the session a click shows (a condition's oldest session); `title`: the session's
 * title, or the agent's name; `reason`: the label (`permission`, `question`, `failed`, `crashed`, `lost`, `finished`;
 * `limited`, `signed out`, `billing`); `glyph`: its status glyph.
 */
export type MenuBarSession = { id: string; title: string; reason: string; glyph: SessionGlyph }

/**
 * What main needs from core for `⌘Q`, the menu-bar item and the Dock badge: how many sessions keep running (an agent
 * live, or a session being created), the "On quit" setting, the sessions that need you in attention order with their
 * count (an account condition counts once), and whether the count is shown as a badge (`notifications.dockBadge`: on
 * the Dock icon, and as the menu-bar item's title).
 */
export type MenuBarState = { live: number; onQuit: (typeof ON_QUIT)[number]; count: number; sessions: MenuBarSession[]; badge: boolean }

/**
 * A notification for main to post or withdraw: core's notification policy decides; main only shows it. `tag`: at most
 * one live notification per tag — a session's (`s:<id>`), an account condition's (`c:<agent>`: its notice,
 * updated in place, then its reset notice), a burst's or the relaunch summary's. A post with a live tag replaces
 * it. `sessionId`: the session a click shows; null opens Kea as it is. `sound`: the system alert sound (only
 * for a session's first attention item, and only when switched on).
 */
export type NotificationOp =
  | { op: 'post'; tag: string; sessionId: string | null; title: string; subtitle: string; body: string; sound: boolean }
  | { op: 'withdraw'; tag: string }

/** main → core / ptyhost. A message that carries a port has it in `ports[0]`. */
export type MainToChild =
  /** Heartbeat; answered with `pong` carrying the same `n`. */
  | { k: 'ping'; n: number }
  /** The control port core ⇄ ptyhost (+ port). Replaces any previous one: the other side restarted. */
  | { k: 'control' }
  /** core: a window's RPC port (+ port). ptyhost: a renderer stream for one terminal (+ port). */
  | { k: 'rpc'; connId: number }
  | { k: 'stream'; connId: number; ptyId: string }
  /** The window `connId` went away (reload, crash, close): dispose its connection scope. */
  | { k: 'disconnect'; connId: number }
  /** Write checkpoints, close connections, exit 0 (app quit). */
  | { k: 'shutdown' }
  /** Send kit's resource report; answered with `report` carrying the same `id`. */
  | { k: 'report'; id: number }
  /** core: stop every session (Stop All and Quit); answered with `stoppedAll` carrying the same `id`. */
  | { k: 'stopAll'; id: number }
  /**
   * core: the first-quit sheet's non-destructive answer becomes the "On quit" setting. Not answered: a
   * `shutdown` after it waits for the write (main's shutdown grace bounds it).
   */
  | { k: 'onQuit'; onQuit: 'menuBar' | 'quit' }
  /** core: whether a Kea window has keyboard focus ("Only when Kea is not focused" reads it); sent on each change. */
  | { k: 'focus'; focused: boolean }
  /**
   * core: the platform report as main assembled it last, for Settings › About (`diagnostics.platform`), Copy
   * Diagnostics and status reports. Sent to each core once it is ready, and again when it changes.
   */
  | { k: 'platform'; report: PlatformReport }

/** core / ptyhost → main. */
export type ChildToMain =
  | { k: 'pong'; n: number }
  /** Startup finished (locks taken, listening); `main` may hand out ports. */
  | { k: 'ready' }
  /** Another instance holds this KEA_HOME's lock; the child exits after sending this. */
  | { k: 'locked'; path: string }
  /** The answer to main's `report` request `id`: kit's report of this process. */
  | { k: 'report'; id: number; report: ResourceReport }
  /** core: the menu-bar state changed; sent once ready, then at most once per store tick. */
  | ({ k: 'menuBar' } & MenuBarState)
  /** core: every session stopped, or tried to (main's `stopAll` request `id`). */
  | { k: 'stoppedAll'; id: number }
  /** core: post or withdraw a notification (the policy is core's, main shows it). */
  | ({ k: 'notify' } & NotificationOp)
  /**
   * core: the working directories of the sessions window `connId` shows (its visible set), absolute; empty when it
   * shows none. Sent on each change: of what the window shows, and of the shown session's directory. Main's
   * `kea-file://` handler serves a window only paths inside them.
   */
  | { k: 'visible'; connId: number; dirs: string[] }
  /**
   * core: its watcher holds one of inotify's limits, or no longer does; sent on each change. The platform
   * report's inotify line carries the sysctl fix while one is held, and main assembles it again.
   */
  | { k: 'watchLimit'; held: boolean }
  /** core: the `updates.check` setting, once ready and on each change (main checks for updates by itself only after it). */
  | { k: 'updates'; check: boolean }

export function isMainToChild(m: unknown): m is MainToChild {
  if (typeof m !== 'object' || m === null) return false
  const r = m as Record<string, unknown>
  switch (r.k) {
    case 'ping':
      return typeof r.n === 'number'
    case 'control':
    case 'shutdown':
      return true
    case 'rpc':
    case 'disconnect':
      return typeof r.connId === 'number'
    case 'stream':
      return typeof r.connId === 'number' && typeof r.ptyId === 'string'
    case 'report':
    case 'stopAll':
      return Number.isInteger(r.id)
    case 'focus':
      return typeof r.focused === 'boolean'
    case 'onQuit':
      return r.onQuit === 'menuBar' || r.onQuit === 'quit'
    case 'platform':
      return zPlatformReport.safeParse(r.report).success
  }
  return false
}

export function isChildToMain(m: unknown): m is ChildToMain {
  if (typeof m !== 'object' || m === null) return false
  const r = m as Record<string, unknown>
  switch (r.k) {
    case 'pong':
      return typeof r.n === 'number'
    case 'ready':
      return true
    case 'locked':
      return typeof r.path === 'string'
    case 'report':
      return Number.isInteger(r.id) && isResourceReport(r.report)
    case 'menuBar':
      return isMenuBarState(r)
    case 'stoppedAll':
      return Number.isInteger(r.id)
    case 'notify':
      return isNotificationOp(r)
    case 'visible':
      return Number.isInteger(r.connId) && Array.isArray(r.dirs) && r.dirs.every((d: unknown) => typeof d === 'string' && d.startsWith('/'))
    case 'watchLimit':
      return typeof r.held === 'boolean'
    case 'updates':
      return typeof r.check === 'boolean'
  }
  return false
}

/** A notification as core sends it (main checks what crosses): a tag, and for a post its texts. */
export function isNotificationOp(r: Record<string, unknown>): boolean {
  if (typeof r.tag !== 'string' || r.tag === '') return false
  if (r.op === 'withdraw') return true
  return r.op === 'post' && (r.sessionId === null || typeof r.sessionId === 'string') && typeof r.title === 'string' && typeof r.subtitle === 'string' && typeof r.body === 'string' && typeof r.sound === 'boolean'
}

/** A menu-bar state as core sends it (main checks what crosses): counts, the setting, the list, the badge switch. */
export function isMenuBarState(r: Record<string, unknown>): boolean {
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0
  if (!count(r.live) || !count(r.count) || !(ON_QUIT as readonly unknown[]).includes(r.onQuit) || !Array.isArray(r.sessions) || typeof r.badge !== 'boolean') return false
  return r.sessions.every((x: unknown) => {
    const s = x as Record<string, unknown> | null
    return typeof s === 'object' && s !== null && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.reason === 'string' && (SESSION_GLYPHS as readonly unknown[]).includes(s.glyph)
  })
}

/**
 * The id of a `report` answer whose report fails the checks (`isResourceReport`), so main can end that request
 * at once instead of waiting out its deadline; null for any other message.
 */
export function refusedReportId(m: unknown): number | null {
  if (typeof m !== 'object' || m === null) return null
  const r = m as Record<string, unknown>
  return r.k === 'report' && Number.isInteger(r.id) && !isResourceReport(r.report) ? (r.id as number) : null
}

/** argv flags main passes to a utility process (never secrets; they show in `ps`). */
/**
 * `perfBusy`: perf harness only (`--kea-perf`): block the event loop for `ms` every `everyMs`, standing in for a long
 * snapshot serialisation. Main passes it to ptyhost alone.
 */
export type ChildArgs = { home: string; version: string; dev: boolean; helper?: string; build?: string; perfBusy?: { ms: number; everyMs: number } }

export function childArgv(a: ChildArgs): string[] {
  return [
    `--kea-home=${a.home}`,
    `--kea-version=${a.version}`,
    ...(a.dev ? ['--dev'] : []),
    ...(a.helper ? [`--helper=${a.helper}`] : []),
    ...(a.build ? [`--kea-build=${a.build}`] : []),
    ...(a.perfBusy ? [`--kea-perf-busy=${a.perfBusy.ms}:${a.perfBusy.everyMs}`] : []),
  ]
}

/**
 * The V8 flags ptyhost runs with: its semi-space capped at L.ptyhostSemiSpaceMb, so a flood neither grows its
 * young generation to V8's default maximum nor leaves tens of MB of dead output buffers waiting for the next scavenge
 * (P-TERM-4). Main passes them inside `--js-flags=` (the one form a utility process honours); the perf probe
 * (tests/perf/ptyhost-probe.ts) passes them to Electron's Node as they are.
 */
export function ptyhostV8Flags(): string[] {
  return [`--max-semi-space-size=${L.ptyhostSemiSpaceMb}`]
}

/**
 * Every V8 flag main starts core or ptyhost with, inside `--js-flags=`: ptyhost's own, then the heap limit. The heap
 * limit caps V8's old space at the process's watchdog hard limit, in whole MiB as V8 takes it. A JavaScript heap that
 * reaches it ends the process with V8's out-of-memory error, and the Supervisor starts a new one, whether or not the
 * person is idle; without the flag V8's own default would let it grow to several GB. The watchdog does not depend on
 * it: it measures the whole footprint, of which the heap is a part.
 */
export function childV8Flags(name: 'core' | 'ptyhost'): string[] {
  const hard = name === 'core' ? L.watchdogHardCoreBytes : L.watchdogHardPtyhostBytes
  return [...(name === 'ptyhost' ? ptyhostV8Flags() : []), `--max-old-space-size=${Math.floor(hard / (1024 * 1024))}`]
}

/** `<ms>:<everyMs>` → the busy injection, or undefined when absent or malformed. */
export function parsePerfBusy(v: string | undefined): { ms: number; everyMs: number } | undefined {
  const m = v ? /^(\d{1,4}):(\d{1,6})$/.exec(v) : null
  if (!m) return undefined
  const ms = Number(m[1])
  const everyMs = Number(m[2])
  return ms > 0 && everyMs > ms ? { ms, everyMs } : undefined
}

export function parseChildArgv(argv: readonly string[]): ChildArgs {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const home = get('kea-home')
  if (!home) throw new Error('missing --kea-home')
  const helper = get('helper')
  const build = get('kea-build')
  const perfBusy = parsePerfBusy(get('kea-perf-busy'))
  return { home, version: get('kea-version') ?? '0.0.0', dev: argv.includes('--dev'), ...(helper ? { helper } : {}), ...(build ? { build } : {}), ...(perfBusy ? { perfBusy } : {}) }
}

/**
 * Whether a child built by another build than main's must stop: both sides know their build (bundled code), and they
 * differ. A package replaced under a running Kea makes a respawned child load the new files under the old main; it then
 * exits at once with L.childBuildMismatchExit, before it opens anything. Unbundled runs (the tests) know no build.
 */
export function buildMismatch(mine: string | undefined, mains: string | undefined): boolean {
  return !!mine && !!mains && mine !== mains
}
