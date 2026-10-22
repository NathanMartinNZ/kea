// The file viewer and diff: what crosses to it. `viewer.open` is the one way a file or a diff is opened — the tree, the
// Changes list, the finder, a `⌘`-click on a path in a terminal, the viewer's own `File · Diff` switch and
// `]` / `[` all run it with an OpenRequest.
//
// What the viewer asks of core (`viewerApi`), each for the session the asking window shows and a path inside its
// working directory (core resolves it there and checks its real path stays inside):
//   viewer.read      the file as bytes with what core found out about it
//   viewer.diff      the two sides of the session's change to it
//   viewer.changes   its changed line ranges, for the gutter
//   viewer.follow    wait until it, or the session's git state, changes
// File contents cross as bytes and are decoded in the window; core keeps nothing after sending them.
//
// Local images reach the window through `kea-file://`, served by main: `keaFileUrl` / `keaFilePath`.

import { z } from 'zod'
import { zDiffScope, zWorktreePath, GIT_CODES } from './files.ts'
import { defineApi } from './rpc.ts'
import { zSessionId } from './terminal.ts'

/** What a tab shows: the file's contents, or what the session changed in it. */
export const VIEW_MODES = ['file', 'diff'] as const
export type ViewMode = (typeof VIEW_MODES)[number]
export const zViewMode = z.enum(VIEW_MODES)

/**
 * The argument of `viewer.open`. A session has one tab per path: opening a path that has a tab shows that tab, in
 * `mode` (so `File · Diff` is this request with the other mode and the line to keep). A diff carries no scope:
 * it follows the session's active scope, read from `git:<sessionId>` (files.ts).
 */
export const zOpenRequest = z.object({
  sessionId: zSessionId,
  path: zWorktreePath,
  mode: zViewMode,
  /** Where to land, 1-based; in a diff, a line of the new side. */
  line: z.number().int().min(1).optional(),
  col: z.number().int().min(1).optional(),
  /** Open pinned. Default: a preview tab, which the next preview reuses. */
  pin: z.boolean().optional(),
  /** Default true: the keyboard moves to the tab. False: `Space` in the tree, which previews without moving focus. */
  focus: z.boolean().optional(),
})
export type OpenRequest = z.infer<typeof zOpenRequest>

// ── reading ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** UTF-8 unless a byte-order mark says UTF-16. */
export const TEXT_ENCODINGS = ['utf8', 'utf16le', 'utf16be'] as const
export type TextEncoding = (typeof TEXT_ENCODINGS)[number]

/** A file's line endings; `lf` also for a file with none, `mixed` for more than one kind. */
export const LINE_ENDINGS = ['lf', 'crlf', 'cr', 'mixed'] as const
export type LineEnding = (typeof LINE_ENDINGS)[number]

/** A file's text as it is on disk: the window decodes it (`TextDecoder`, which drops the byte-order mark). */
export const zTextBytes = z.object({
  bytes: z.instanceof(Uint8Array),
  encoding: z.enum(TEXT_ENCODINGS),
  /** Not valid in its encoding; shown with replacement characters and a notice. */
  invalid: z.boolean(),
  /** Reported in the header when not `lf`; the view keeps them (a copy has the file's own line endings). */
  eol: z.enum(LINE_ENDINGS),
})
export type TextBytes = z.infer<typeof zTextBytes>

/** The types the image view shows, by extension (lower case). */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'svg'] as const
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number]

/** The image extension of a path, or null: `a/Logo.PNG` → `png`. */
export function imageExtension(path: string): ImageExtension | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? (ext as ImageExtension) : null
}

/**
 * What a path turned out to be:
 *   text        `text` holds it
 *   image       an image type by its extension: `image` says whether it may be decoded; shown through `kea-file://`
 *   binary      a NUL byte in its first bytes: the one-line placeholder
 *   large       over L.viewerMaxBytes: not read
 *   missing     no such file (deleted), or one that cannot be read
 *   directory   a directory
 *   outside     a symlink whose target is outside the working directory: `link` is the target, nothing is read
 */
export const FILE_KINDS = ['text', 'image', 'binary', 'large', 'missing', 'directory', 'outside'] as const
export type FileKind = (typeof FILE_KINDS)[number]

export const zImageInfo = z.object({
  /** Pixels, from the file's header; null when it could not be told (the view then learns them from the decoded image). */
  width: z.number().int().min(0).nullable(),
  height: z.number().int().min(0).nullable(),
  /** False over L.imageMaxBytes or L.imageMaxPixels: the image is not decoded, only described. */
  decodable: z.boolean(),
})
export type ImageInfo = z.infer<typeof zImageInfo>

export const zFileRead = z.object({
  kind: z.enum(FILE_KINDS),
  /** Bytes on disk; 0 when there is no file. */
  size: z.number().int().min(0),
  /** The file's modification time (ms); it tells one version of an image from the next (`keaFileUrl`). */
  mtimeMs: z.number(),
  /**
   * Where a symlink leads: relative to the working directory when its target is inside (the view shows the target),
   * absolute when it is outside (`outside`). Null for a path with no symlink on it.
   */
  link: z.string().nullable(),
  text: zTextBytes.nullable(),
  image: zImageInfo.nullable(),
  /** `viewer.openDefault` would open it: a regular file that is not executable and of no type that opening runs or installs. */
  openable: z.boolean(),
})
export type FileRead = z.infer<typeof zFileRead>

// ── diff ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One side of a diff. `exists` false: the file is not there on that side (an added file's old side, a deleted file's
 * new side). `text` is null unless the diff is `text`.
 */
export const zDiffSide = z.object({
  exists: z.boolean(),
  size: z.number().int().min(0),
  text: zTextBytes.nullable(),
  /** An image diff's old side as its bytes (the new side is the file itself, through `kea-file://`); null when over L.imageMaxBytes. */
  image: z.instanceof(Uint8Array).nullable(),
})
export type DiffSide = z.infer<typeof zDiffSide>

/**
 * `text` both sides are text within the limits; `large` a side is over them (nothing is sent); `binary` a side
 * is binary (sizes only); `image` an image type (old and new side by side).
 */
export const DIFF_KINDS = ['text', 'large', 'binary', 'image'] as const
export type DiffKind = (typeof DIFF_KINDS)[number]

export const zDiffRead = z.object({
  kind: z.enum(DIFF_KINDS),
  /** The scope the diff was taken in (the session's active one) and the commit compared against; null: none, so everything is new. */
  scope: zDiffScope,
  base: z.string().nullable(),
  /** The path's status letter in that scope, or null when the status has no entry for it (unchanged, or not known yet). */
  code: z.enum(GIT_CODES).nullable(),
  /** A rename's old path: the old side is that file. */
  origPath: zWorktreePath.nullable(),
  old: zDiffSide,
  new: zDiffSide,
  /** The new side's modification time (ms), for an image's URL. */
  mtimeMs: z.number(),
})
export type DiffRead = z.infer<typeof zDiffRead>

// ── changed lines ──────────────────────────────────────────────────────────────────────────────────────────────────

/** `added` / `modified`: lines `from`…`to` of the file (1-based, inclusive). `deleted`: lines were removed after line `from` (0: before the first); `to` equals `from`. */
export const CHANGE_KINDS = ['added', 'modified', 'deleted'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]
export const zLineChange = z.object({ kind: z.enum(CHANGE_KINDS), from: z.number().int().min(0), to: z.number().int().min(0) })
export type LineChange = z.infer<typeof zLineChange>

export const zLineChanges = z.object({
  scope: zDiffScope,
  base: z.string().nullable(),
  /** Ascending, never overlapping. Empty when nothing changed, when there is no base, and when `whole` or `truncated`. */
  changes: z.array(zLineChange),
  /** The whole file is new (untracked, or nothing to compare against): every line counts as added. */
  whole: z.boolean(),
  /** The diff was over its limits: no markers are shown rather than some. */
  truncated: z.boolean(),
})
export type LineChanges = z.infer<typeof zLineChanges>

// ── following the open file ────────────────────────────────────────────────────────────────────────────────────────

export const zFollowResult = z.object({
  /** The follow's revision now; the next `viewer.follow` passes it as `seen`. */
  rev: z.number().int().min(0),
  /** What changed since `seen`: the file on disk, the session's git state (its scope, base or an entry). */
  file: z.boolean(),
  git: z.boolean(),
  /** The follow is over (another path is followed from this window, it stopped, or it shows another session): do not ask again. */
  ended: z.boolean(),
})
export type FollowResult = z.infer<typeof zFollowResult>

const zViewerPath = z.object({ sessionId: zSessionId, path: zWorktreePath })

/** Methods core serves to the renderer for the viewer. Each rejects (`not_visible`) for a session the asking window does not show. */
export const viewerApi = defineApi({
  /** `source`: read an image type as text (the SVG `Source` toggle). */
  'viewer.read': { args: zViewerPath.extend({ source: z.boolean().optional() }), result: zFileRead },
  'viewer.diff': { args: zViewerPath, result: zDiffRead },
  'viewer.changes': { args: zViewerPath, result: zLineChanges },
  /**
   * Resolves once the followed file is past revision `seen` (0: a new follow, which resolves at the first change), at
   * most L.viewerReloadPerS times a second. A window follows one path at a time: following another ends the one
   * before.
   */
  'viewer.follow': { args: zViewerPath.extend({ seen: z.number().int().min(0) }), result: zFollowResult },
  /** This window follows nothing now (its file tab was hidden). */
  'viewer.unfollow': { args: z.object({}), result: z.object({ ok: z.boolean() }) },
  /** "Open with default app": hand a regular, non-executable file of a type that is only shown to the system. `message`: why not. */
  'viewer.openDefault': { args: zViewerPath, result: z.object({ ok: z.boolean(), message: z.string().nullable() }) },
})

// ── kea-file:// ────────────────────────────────────────────────────────────────────────────────────────────────────

export const KEA_FILE_SCHEME = 'kea-file'
/** The one host of `kea-file://` URLs. */
export const KEA_FILE_HOST = 'f'

/**
 * The URL of a local image: `kea-file://f/<absolute path, each segment percent-encoded>?v=<version>`. The version
 * (the file's mtime) only makes a changed file a new URL; main ignores it and decides by the path alone.
 */
export function keaFileUrl(absPath: string, version?: number): string {
  const segs = absPath.split('/').filter((s) => s !== '').map(encodeURIComponent)
  return `${KEA_FILE_SCHEME}://${KEA_FILE_HOST}/${segs.join('/')}${version === undefined ? '' : `?v=${Math.trunc(version)}`}`
}

/**
 * The absolute path a `kea-file://` URL names, or null for anything that is not exactly such a URL: another scheme or
 * host, credentials or a port, an encoded `/` or NUL inside a segment, an empty, `.` or `..` segment (so no traversal
 * is ever resolved: the path is taken as written or refused). Syntax only: main still checks where the path really
 * leads before serving anything.
 */
export function keaFilePath(url: string): string | null {
  const prefix = `${KEA_FILE_SCHEME}://${KEA_FILE_HOST}/`
  if (!url.startsWith(prefix)) return null
  let rest = url.slice(prefix.length)
  const hash = rest.indexOf('#')
  if (hash >= 0) rest = rest.slice(0, hash)
  const query = rest.indexOf('?')
  if (query >= 0) rest = rest.slice(0, query)
  if (rest === '') return null
  const out: string[] = []
  for (const seg of rest.split('/')) {
    let s: string
    try {
      s = decodeURIComponent(seg)
    } catch {
      return null
    }
    if (s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\0')) return null
    out.push(s)
  }
  return `/${out.join('/')}`
}
