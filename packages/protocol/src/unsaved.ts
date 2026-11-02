// A window's unsaved files as they cross main: why main asks a window to review them before something closes them, and
// the documents a window rebuilt on Wayland hands the one made in its place. Main checks the hand-over on the way
// through and keeps it in memory only, never in a file.

import { z } from 'zod'
import { zWorktreePath } from './files.ts'
import { L } from './generated/limits.ts'
import { zSessionId } from './terminal.ts'
import { LINE_ENDINGS, TEXT_ENCODINGS, zVersion } from './viewer.ts'

/**
 * What main is about to do when it asks a window to review its unsaved files: quit Kea, close the window, reload it,
 * restart Kea (an update, or files replaced under it), or close every window to keep Kea in the menu bar.
 */
export const REVIEW_REASONS = ['quit', 'close', 'reload', 'restart', 'menuBar'] as const
export type ReviewReason = (typeof REVIEW_REASONS)[number]

export function isReviewReason(v: unknown): v is ReviewReason {
  return typeof v === 'string' && (REVIEW_REASONS as readonly string[]).includes(v)
}

/** A place in a document's text, in UTF-16 code units. */
const zOffset = z.number().int().min(0).max(L.viewerMaxBytes)
const zSpan = z.object({ from: zOffset, to: zOffset })

/**
 * One unsaved document as a window hands it over: its text and the text it was read as (`base`, with that read's
 * `version`, line ending, encoding, byte-order mark and permission bits), its session and path, its selection, the
 * places marked where the file changed under it (each with its range in `base`), and its save state (a save under way
 * is handed over as `dirty`, with the text it sent kept in `sent`). No undo history crosses.
 */
export const zHandedDocument = z.object({
  sessionId: zSessionId,
  path: zWorktreePath,
  text: z.string().max(L.viewerMaxBytes),
  base: z.string().max(L.viewerMaxBytes),
  version: zVersion.nullable(),
  eol: z.enum(LINE_ENDINGS),
  encoding: z.enum(TEXT_ENCODINGS),
  bom: z.boolean(),
  mode: z.number().int().min(0).nullable(),
  selection: z.array(z.object({ anchor: zOffset, head: zOffset })).max(L.viewerCursorMax),
  marks: z.array(z.object({ doc: zSpan, base: zSpan })).max(L.viewerMarksMax),
  state: z.enum(['dirty', 'failed']),
  /** The file was gone when it was handed over: a save makes it again. */
  deleted: z.boolean(),
  sent: z.string().max(L.viewerMaxBytes).nullable(),
  /** The document on screen in the old window. */
  active: z.boolean(),
})
export type HandedDocument = z.infer<typeof zHandedDocument>

/**
 * What a window hands the one main rebuilds in its place: every document it holds unsaved (at most L.viewerUnsavedMax
 * kept aside and the one on screen).
 */
export const zHandedDocuments = z.object({ documents: z.array(zHandedDocument).max(L.viewerUnsavedMax + 1) })
export type HandedDocuments = z.infer<typeof zHandedDocuments>
