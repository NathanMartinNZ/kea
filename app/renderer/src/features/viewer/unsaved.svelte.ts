// The window's unsaved documents: every file document whose text is not on disk (dirty, saving, failed, or set aside
// by Don't Save while the action that closes it runs), on screen or not, with its undo history. It is the one place a
// window keeps file contents beyond the document on screen and the small cache, so it is capped: at
// L.viewerUnsavedMax documents or L.viewerUnsavedBytes (text, last saved text and undo history together) further files
// open read-only until some are saved or closed. The documents are plain module state; what the window draws from them
// (which sessions have unsaved files, how many) is rune state of strings and numbers.

import { L } from '@kea/protocol/limits'
import { hasUnsaved, unsavedWeight, type FileDocument } from './document.ts'

export interface UnsavedEntry {
  sessionId: string
  path: string
  doc: FileDocument
  /** Its session is gone (deleted in another window, its worktree removed): it has no tab and no folder to save into. */
  orphan: boolean
  /** Set aside by Don't Save for this action (a review's request, a delete): dropped when it happens, restored when not. */
  aside: string | null
}

// bounded: L.viewerUnsavedMax documents (a document opens editable only while the registry is under it and under
// L.viewerUnsavedBytes), plus the one on screen that became unsaved while the registry was full
const entries = new Map<string, UnsavedEntry>()

/** How much of a document's undo history counts (`history.ts`'s estimate); set by the controller. */
let historyOf: (doc: FileDocument) => number = () => 0

export function setHistoryWeigher(fn: (doc: FileDocument) => number): void {
  historyOf = fn
}


class UnsavedView {
  /** Sessions that have unsaved files: the sidebar's "unsaved". */
  sessions = $state.raw<ReadonlySet<string>>(new Set())
  /** The files, as `unsavedKey`s: their tabs' dots. */
  files = $state.raw<ReadonlySet<string>>(new Set())
  count = $state(0)
}

/** A file's key in `unsavedView.files`. */
export const unsavedKey = (sessionId: string, path: string): string => `${sessionId}\n${path}`

/** What the window draws from the registry. */
export const unsavedView = new UnsavedView()

let listener: ((count: number) => void) | null = null

/** Told the count whenever it changes (main's copy, for the edited dot and the watchdog). */
export function onUnsavedCount(fn: ((count: number) => void) | null): void {
  listener = fn
  fn?.(entries.size)
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x))

function changed(): void {
  const sessions = new Set<string>()
  for (const e of entries.values()) if (!e.orphan) sessions.add(e.sessionId)
  if (!sameSet(sessions, unsavedView.sessions)) unsavedView.sessions = sessions
  const files = new Set(entries.keys())
  if (!sameSet(files, unsavedView.files)) unsavedView.files = files
  if (unsavedView.count !== entries.size) {
    unsavedView.count = entries.size
    listener?.(entries.size)
  }
}

/**
 * The document of `sessionId`'s `path` has unsaved text (or no longer has): it is in the registry while it has. Called
 * on every change of its save state.
 */
export function trackUnsaved(sessionId: string, path: string, doc: FileDocument): void {
  const key = unsavedKey(sessionId, path)
  const had = entries.get(key)
  if (hasUnsaved(doc) || doc.closing) {
    if (had?.doc === doc) return
    entries.set(key, { sessionId, path, doc, orphan: had?.orphan ?? false, aside: had?.aside ?? null })
  } else if (had?.doc === doc) entries.delete(key)
  else return
  changed()
}

/** The unsaved document of a tab, if it has one. */
export function unsavedDoc(sessionId: string, path: string): FileDocument | null {
  return entries.get(unsavedKey(sessionId, path))?.doc ?? null
}

export function unsavedEntry(sessionId: string, path: string): UnsavedEntry | null {
  return entries.get(unsavedKey(sessionId, path)) ?? null
}

/** Whether a tab's document has unsaved text: the strip keeps such a tab (never evicted, never a preview). */
export function isUnsaved(sessionId: string, path: string): boolean {
  return entries.has(unsavedKey(sessionId, path))
}

/** Drop a document from the registry: saved elsewhere, Don't Save, or its tab closed after the warning. */
export function dropUnsaved(sessionId: string, path: string): void {
  if (entries.delete(unsavedKey(sessionId, path))) changed()
}

/** Every unsaved document, oldest first (the order they became unsaved). */
export function unsavedEntries(): UnsavedEntry[] {
  return [...entries.values()]
}

export function unsavedCount(): number {
  return entries.size
}

/** What the registry holds, for its cap and the resource report. */
export function unsavedBytes(): number {
  let n = 0
  for (const e of entries.values()) n += unsavedWeight(e.doc, historyOf(e.doc))
  return n
}

/**
 * Whether one more document may be edited: the registry is under both caps. A document already in it may always be
 * edited. Null when it may; otherwise the reason the header gives.
 */
export function capReason(sessionId: string, path: string): string | null {
  if (entries.has(unsavedKey(sessionId, path))) return null
  if (entries.size >= L.viewerUnsavedMax || unsavedBytes() >= L.viewerUnsavedBytes) return entries.size === 1 ? 'another file has unsaved changes' : `${entries.size} files have unsaved changes`
  return null
}

/** A file of `sessionId` moved from `from` to `to` (a folder: everything under it, by `map`): its document goes with it. */
export function moveUnsaved(sessionId: string, map: (path: string) => string): void {
  let moved = false
  for (const [key, e] of [...entries]) {
    if (e.sessionId !== sessionId) continue
    const to = map(e.path)
    if (to === e.path) continue
    entries.delete(key)
    entries.set(unsavedKey(sessionId, to), { ...e, path: to })
    moved = true
  }
  if (moved) changed()
}

/**
 * Sessions no longer listed leave their documents as orphans: kept and counted, with no tab and nowhere to save. Returns
 * the documents that just became orphans (the toast names them).
 */
export function orphanUnsaved(exists: (sessionId: string) => boolean): UnsavedEntry[] {
  const out: UnsavedEntry[] = []
  for (const e of entries.values()) {
    if (e.orphan || exists(e.sessionId)) continue
    e.orphan = true
    out.push(e)
  }
  if (out.length > 0) changed()
  return out
}

/** Set documents aside for `action` (Don't Save while it runs), or put them back (`null`). */
export function setAside(sessionId: string, path: string, action: string | null): void {
  const e = entries.get(unsavedKey(sessionId, path))
  if (!e) return
  e.aside = action
  e.doc.closing = action !== null
}

/** The documents set aside for `action`. */
export function asideFor(action: string): UnsavedEntry[] {
  return [...entries.values()].filter((e) => e.aside === action)
}

let goingAway = false

/**
 * Main's review was answered `proceed` and the action has not settled: every editable document is read-only
 * ("Closing…") until it has, so nothing typed after the answer goes unasked.
 */
export function setWindowGoing(on: boolean): void {
  goingAway = on
}

export function windowGoing(): boolean {
  return goingAway
}

/** For the resource report and the leak tests. */
export function unsavedStats(): { docs: number; bytes: number; saving: number } {
  let saving = 0
  for (const e of entries.values()) if (e.doc.save?.phase === 'saving') saving++
  return { docs: entries.size, bytes: unsavedBytes(), saving }
}
