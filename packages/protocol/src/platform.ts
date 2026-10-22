// The OS layer's shared vocabulary: the systems Kea runs on, how a capability one system lacks says so, and the
// platform report that main and core assemble. Every `os/` folder (main, core, ptyhost, kit, tools/pack, this
// package) implements its capabilities against these types.
import { z } from 'zod'

/** The systems Kea runs on, named as Node's `process.platform` names them. */
export const SYSTEMS = ['darwin', 'linux'] as const
export type System = (typeof SYSTEMS)[number]

/** `process.platform` as a `System`; every `os/select.ts` picks its implementation with it, once at start. */
export function systemOf(platform: string): System {
  if (platform === 'darwin' || platform === 'linux') return platform
  throw new Error(`Kea runs on macOS and Linux only, not on ${platform || 'an unknown system'}`)
}

/**
 * A capability this system lacks, with the one sentence the feature shows where it would have been: never an
 * `undefined` a caller must guess at.
 */
export type NotAvailable = { readonly available: false; readonly reason: string }

export function notAvailable(reason: string): NotAvailable {
  return { available: false, reason }
}

export function isAvailable<T extends object>(capability: T | NotAvailable): capability is T {
  return !('available' in capability && capability.available === false)
}

/** Thrown by `need` for a capability this system lacks; its message is the capability's reason. */
export class NotAvailableError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'NotAvailableError'
    this.reason = reason
  }
}

/** The capability, for a caller with nothing else to show: a missing one throws its reason (`NotAvailableError`). */
export function need<T extends object>(capability: T | NotAvailable): T {
  if (isAvailable(capability)) return capability
  throw new NotAvailableError(capability.reason)
}

/** What an OS layer lacks: each capability that is not available, with its reason. */
export function unavailable(layer: { readonly system: System }): { capability: string; reason: string }[] {
  return Object.entries(layer).flatMap(([capability, c]: [string, unknown]) =>
    capability !== 'system' && typeof c === 'object' && c !== null && !isAvailable(c) ? [{ capability, reason: (c as NotAvailable).reason }] : [],
  )
}

/**
 * The desktop file ids Kea runs as on Linux, which are also its `desktopName`, Wayland app id and X11
 * window class: the packages' `dev.kea.app`, and the dev build's own, so a dev build never takes an installed Kea's
 * dock icon, notifications or window grouping.
 */
export const DESKTOP_IDS = { packaged: 'dev.kea.app', dev: 'dev.kea.app.dev' } as const

// ── the platform report ────────────────────────────────────────────────────────────────────

/** The report's lines, in the order Settings › About shows them; a system leaves out the lines that do not apply to it. */
export const PLATFORM_LINES = [
  'desktop',
  'installKind',
  'holderDetach',
  'admission',
  'holderVisibility',
  'logout',
  'rendererSandbox',
  'terminalRenderer',
  'trayHost',
  'notifications',
  'idle',
  'inotify',
  'updateChannel',
] as const
export type PlatformLineId = (typeof PLATFORM_LINES)[number]

export const zPlatformLine = z.object({
  id: z.enum(PLATFORM_LINES),
  label: z.string().min(1),
  value: z.string().min(1),
  /** One sentence that makes the line the full answer; null when it already is. */
  fix: z.string().min(1).nullable(),
})
export type PlatformLine = z.infer<typeof zPlatformLine>

export const zPlatformReport = z
  .object({
    system: z.enum(SYSTEMS),
    /** The system's own version (`macOS 27.0.0`; on Linux os-release's name and the kernel, `Ubuntu 24.04.5 LTS (Linux 6.8.0-45-generic)`). */
    version: z.string().min(1),
    arch: z.string().min(1),
    lines: z.array(zPlatformLine).max(PLATFORM_LINES.length),
  })
  .refine((r) => new Set(r.lines.map((l) => l.id)).size === r.lines.length, { message: 'a line appears twice' })
export type PlatformReport = z.infer<typeof zPlatformReport>

/** The report's first line: the system's version and the architecture (`macOS 27.0.0 · arm64`). */
export function platformSystemText(r: PlatformReport): string {
  return `${r.version} · ${r.arch}`
}

/** One line as text (Copy Diagnostics): `<label>: <value>`, and its fix after it when the line is not the full answer. */
export function platformLineText(l: PlatformLine): string {
  return `${l.label}: ${l.value}${l.fix ? `. Fix: ${l.fix}` : ''}`
}

/**
 * Copy Diagnostics' `Platform` section, heading included: the system, then each line as `platformLineText`
 * writes it, each through `part` (the text's scrubber, or the identity with file paths included). Null: main has not
 * sent the report yet.
 */
export function platformSection(r: PlatformReport | null, part: (text: string) => string): string[] {
  const out = ['## Platform']
  if (!r) return [...out, 'not known yet: main has not sent the platform report']
  return [...out, part(platformSystemText(r)), ...r.lines.map((l) => part(platformLineText(l)))]
}

/** The report with every text that could name a path through `scrub` (a status report's copy). */
export function scrubbedReport(r: PlatformReport, scrub: (text: string) => string): PlatformReport {
  return { ...r, version: scrub(r.version), lines: r.lines.map((l) => ({ ...l, value: scrub(l.value), fix: l.fix === null ? null : scrub(l.fix) })) }
}
