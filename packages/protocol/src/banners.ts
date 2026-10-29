// App-level banners: one core store carries every banner of the window's banner strip except the settings error,
// which stays in `settings.status`. Each banner names its source and is cleared by it: git missing by core's
// git lookup, ptyhost's `pty.banner` notes when a new ptyhost connects or, for the disk-full one, by its
// `pty.bannerCleared`. The session-mode banner (Linux without a systemd user manager to give terminals a
// scope of their own) is shown once per KEA_HOME. On Linux core's watch service says when inotify's limits stop
// it following a worktree, and its port blocks when too few lie below the system's ephemeral range. A window's
// one-time hints are kept the same way: core says once per KEA_HOME that a hint is to show (`hints.once`).
import { z } from 'zod'
import { defineApi } from './rpc.ts'

export const BANNERS_STORE = 'banners'

/** What raised the banner (and so clears it). */
export const BANNER_SOURCES = ['git', 'ptyhost', 'watch', 'ports'] as const
/**
 * One kind per condition: git is missing, holders could not detach, kea-helper is missing, the disk is full, holders
 * run in session mode, inotify's watch limit is reached, too few port blocks are left.
 */
export const BANNER_KINDS = ['gitMissing', 'notDetached', 'helperMissing', 'diskFull', 'sessionMode', 'watchLimit', 'portBlocks'] as const
export type BannerKind = (typeof BANNER_KINDS)[number]

/** One banner, keyed by its kind (at most one of each). */
export const zBanner = z.object({
  kind: z.enum(BANNER_KINDS),
  source: z.enum(BANNER_SOURCES),
  severity: z.enum(['warning', 'error']),
  message: z.string(),
  /** The fix, in words ("Install Xcode Command Line Tools: xcode-select --install"); null when the message says it. */
  fix: z.string().nullable(),
  at: z.number().int(),
})
export type Banner = z.infer<typeof zBanner>

/**
 * The one-time hints a window shows the first time their moment comes in this KEA_HOME. `ctrlCopy`: on Linux, Ctrl+C
 * pressed in a terminal with text selected, which sends an interrupt rather than copying.
 */
export const HINTS = ['ctrlCopy'] as const
export type Hint = (typeof HINTS)[number]

/** The key-value row that records a hint as shown in this KEA_HOME. */
export const hintShownKey = (hint: Hint): string => `hint.${hint}.shown`

export const hintsApi = defineApi({
  /** A hint's moment came: whether to show it (true the first time in this KEA_HOME, which is then recorded). */
  'hints.once': { args: z.object({ hint: z.enum(HINTS) }), result: z.object({ show: z.boolean() }) },
})

