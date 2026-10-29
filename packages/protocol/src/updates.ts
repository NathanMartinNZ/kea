// What main knows about updates, as it sends it to the window (`kea:updateState`): how this Kea is updated, what the
// last check found, and whether the one-time line saying Kea checks for updates is still to be shown. Main owns it;
// the window draws it in Settings › About and the sidebar footer and checks it here before using it.

import { z } from 'zod'

/** How Kea was installed: what `<resources>/install-kind` records (`user`: a tarball under the home folder). */
export const INSTALL_KINDS = ['mac', 'deb', 'rpm', 'tarball', 'user'] as const
export type InstallKind = (typeof INSTALL_KINDS)[number]

/**
 * Who updates this Kea: Kea's own updater (macOS), the system's package manager (a deb with Kea's apt source), a
 * command the person runs (install.sh), or nothing (a build not from a release).
 */
export const UPDATE_MODES = ['updater', 'packageManager', 'command', 'none'] as const
export type UpdateMode = (typeof UPDATE_MODES)[number]

const zVersion = z.string().regex(/^\d+\.\d+\.\d+$/)

/** What the last check found, or what is happening now. */
export const zUpdatePhase = z.discriminatedUnion('k', [
  z.object({ k: z.literal('idle') }),
  z.object({ k: z.literal('checking') }),
  z.object({ k: z.literal('current'), version: zVersion }),
  z.object({ k: z.literal('available'), version: zVersion }),
  z.object({ k: z.literal('downloading'), version: zVersion, percent: z.number().int().min(0).max(100) }),
  z.object({ k: z.literal('ready'), version: zVersion }),
  z.object({ k: z.literal('upgraded'), version: zVersion.nullable() }),
  z.object({ k: z.literal('removed') }),
  z.object({ k: z.literal('didNotInstall'), version: zVersion }),
  z.object({ k: z.literal('failed'), reason: z.string().max(200) }),
])
export type UpdatePhase = z.infer<typeof zUpdatePhase>

export const zUpdateState = z.object({
  mode: z.enum(UPDATE_MODES),
  /** Kea checks by itself here (the About switch is shown); false where something else updates it, or nothing does. */
  auto: z.boolean(),
  /** The command that installs a newer version here, for Copy Command; null where none applies. */
  command: z.string().max(300).nullable(),
  /** Why the macOS updater is not used here (a folder Kea cannot write, another home), for About; null otherwise. */
  why: z.string().max(200).nullable(),
  phase: zUpdatePhase,
  /** When the last check ended, ms since the epoch; null before the first. */
  lastChecked: z.number().int().nonnegative().nullable(),
  /** The one-time line saying Kea checks for updates is still to be shown. */
  notice: z.boolean(),
})
export type UpdateState = z.infer<typeof zUpdateState>

/** The state before main has said anything: nothing to show. */
export const NO_UPDATE_STATE: UpdateState = { mode: 'none', auto: false, command: null, why: null, phase: { k: 'idle' }, lastChecked: null, notice: false }

/**
 * What main keeps across launches in `<userData>/updates.json`: the one-time line was shown; the version Squirrel had
 * ready and how many starts it was not the running one; versions never downloaded again. A field that does not parse
 * reads as its default.
 */
export const zUpdateMarks = z.object({
  noticeShown: z.boolean().catch(false),
  expected: z.object({ version: zVersion, attempts: z.number().int().nonnegative() }).nullable().catch(null),
  skip: z.array(zVersion).max(16).catch([]),
})
export type UpdateMarks = z.infer<typeof zUpdateMarks>

export const NO_UPDATE_MARKS: UpdateMarks = { noticeShown: false, expected: null, skip: [] }
