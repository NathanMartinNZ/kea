// The warning before unsaved changes are lost, and the reviews that ask it. Closing a tab whose file has unsaved changes
// asks about that file; an action that closes many (deleting a session, removing a project, quitting, closing or
// reloading the window) asks about each of them in turn, the file put on screen first: Save, Don't Save or Cancel, never
// all at once. Cancel stops the review and the action.
//
// Don't Save for an action sets the document aside ("Closing…", read-only, still counted) until the action has
// happened, which drops it, or has not, which gives it back. Main's requests (quit, close, reload, restart, the menu
// bar) come through the bridge; while one this window answered `proceed` is out, every document is read-only, so
// nothing typed after the answer goes unasked.

import { tick } from 'svelte'
import type { HandedDocuments, ReviewReason } from '@kea/protocol'
import { L } from '@kea/protocol/limits'
import { answerReview, coreConnected, onCoreConnection, setReviewHost, setUnsavedCount, takeDocuments } from '../../lib/bridge.ts'
import { fileTabsOf, fileTabsState, setFileTabs } from '../../shell/fileTabs.svelte.ts'
import { closeFileTab, fileTabId, openFileTab } from '../../shell/tabs.ts'
import { commands } from '../commands/registry.ts'
import { panel } from '../files/state.svelte.ts'
import { copyText } from '../sessions/actions.ts'
import { activeSessionId, selectSession, sessions, showToast, ui } from '../sessions/state.svelte.ts'
import { currentViewer, discardDocument, documentFromHand, handedDocument, saveUnsaved } from './controller.svelte.ts'
import { hasUnsaved } from './document.ts'
import { refusalText, saveText } from './saving.ts'
import { asideFor, isUnsaved, onUnsavedCount, orphanUnsaved, setAside, setWindowGoing, trackUnsaved, unsavedEntries, unsavedEntry, type UnsavedEntry } from './unsaved.svelte.ts'

/** What a review asks about: the window's files, some sessions', one file, a path and what is under it, or the orphans. */
export type ReviewScope =
  | { kind: 'window' }
  | { kind: 'sessions'; ids: ReadonlySet<string> }
  | { kind: 'file'; sessionId: string; path: string }
  | { kind: 'under'; sessionId: string; path: string }
  | { kind: 'orphans' }

/** The warning's answer; Copy All is Don't Save after the text is copied; Anyway hands the file over as it is on disk. */
export type UnsavedAnswer = 'save' | 'dontSave' | 'copyAll' | 'anyway' | 'cancel'

/** What reads the file from disk: the agent (Send Reference), the clipboard (Copy Reference), the editor, the browser. */
export type HandOff = 'send' | 'copy' | 'open' | 'browse'

/** What the warning asks about. */
export interface UnsavedAsk {
  sessionId: string
  path: string
  /** Why Save is not offered (Copy All replaces it); null when it is. */
  cannotSave: string | null
  /** The file's session is gone. */
  orphan: boolean
  /** The question before the file is handed over as it is on disk; absent for the warning before it is closed. */
  handOff?: HandOff
}

class ReviewView {
  /** The warning on screen. */
  ask = $state.raw<UnsavedAsk | null>(null)
  /** Main's watchdog skipped this window's reload for its unsaved files: the banner. */
  lowMemory = $state(false)
}

export const reviewView = new ReviewView()

let answer: ((a: UnsavedAnswer) => void) | null = null
/** Bumped by every review: an older one still running stops at its next file. */
let reviews = 0
/** Kea's core is connected: as it is when this module loads, then as every port and every going-away tells. */
let coreUp = coreConnected()
let actions = 0

onCoreConnection((up) => {
  coreUp = up
})

/** The user answered the warning (its buttons, its Esc, a navigation the review did not make). */
export function answerUnsaved(a: UnsavedAnswer): void {
  const done = answer
  answer = null
  reviewView.ask = null
  done?.(a)
}

function inScope(e: UnsavedEntry, scope: ReviewScope): boolean {
  if (scope.kind === 'window') return true
  if (scope.kind === 'sessions') return scope.ids.has(e.sessionId)
  if (scope.kind === 'orphans') return e.orphan
  if (scope.kind === 'under') return e.sessionId === scope.sessionId && (e.path === scope.path || e.path.startsWith(`${scope.path}/`))
  return e.sessionId === scope.sessionId && e.path === scope.path
}

/** The document on screen first, then its session's, then the others' (oldest first within each). */
function ordered(list: readonly UnsavedEntry[]): UnsavedEntry[] {
  const shown = fileTabsState.shown
  const active = activeSessionId()
  const rank = (e: UnsavedEntry): number => (shown?.mode === 'file' && shown.sessionId === e.sessionId && shown.path === e.path ? 0 : e.sessionId === active ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b))
}

/** Why the warning offers Copy All instead of Save. */
function cannotSave(e: UnsavedEntry): string | null {
  if (!coreUp) return 'Kea’s core is restarting'
  if (e.orphan || !sessions.get(e.sessionId)) return 'Its session is gone'
  // set aside by Don't Save while its action runs: no save starts for it
  if (e.doc.closing) return 'It is being closed'
  if (e.doc.notText !== null) return `It is now ${e.doc.notText}`
  if (e.doc.save?.failure === refusalText('no-folder')) return 'Its folder is gone'
  return null
}

/** The file's session on screen and its tab active, when it has a session. */
async function putOnScreen(e: UnsavedEntry): Promise<void> {
  if (e.orphan || !sessions.get(e.sessionId)) return
  if (activeSessionId() !== e.sessionId) {
    selectSession(e.sessionId)
    await tick()
  }
  const req = { sessionId: e.sessionId, path: e.path, mode: 'file', pin: true }
  // the session's pane registers `viewer.open` once it is mounted, which may take a frame more
  if (!commands.run('viewer.open', req)) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    commands.run('viewer.open', req)
  }
  await tick()
}

function ask(e: UnsavedEntry): Promise<UnsavedAnswer> {
  answerUnsaved('cancel')
  return new Promise((resolve) => {
    answer = resolve
    reviewView.ask = { sessionId: e.sessionId, path: e.path, cannotSave: cannotSave(e), orphan: e.orphan }
  })
}

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Every other sheet is answered Cancel before a review asks anything. */
function closeOtherSheets(): void {
  answerUnsaved('cancel')
  ui.sheet = null
  panel.discard = null
  panel.trash = null
  panel.copyIn = null
}

/**
 * Ask about each unsaved file of `scope` in turn. Save saves it (one that does not end saved, with places marked or a
 * failure, stays on screen with its notice and counts as Cancel); Don't Save and Copy All hand it to `dontSave`.
 * Resolves true when every file was answered, false on Cancel.
 */
export async function reviewUnsaved(scope: ReviewScope, dontSave: (e: UnsavedEntry) => void): Promise<boolean> {
  closeOtherSheets()
  const id = ++reviews
  // bounded: the files of this review, at most the registry's
  const asked = new Set<UnsavedEntry['doc']>()
  for (;;) {
    if (id !== reviews) return false
    const next = ordered(unsavedEntries().filter((e) => inScope(e, scope) && !asked.has(e.doc)))[0]
    if (!next) return true
    asked.add(next.doc)
    await putOnScreen(next)
    if (id !== reviews) return false
    // the user may have saved it, or closed it some other way, on the way here
    if (!isUnsaved(next.sessionId, next.path) && !next.doc.closing) continue
    const a = await ask(next)
    if (a === 'cancel') return false
    if (a === 'save') {
      await saveUnsaved(next.sessionId, next.path, next.doc)
      if (hasUnsaved(next.doc)) {
        await putOnScreen(next)
        return false
      }
      continue
    }
    if (a === 'copyAll' && next.doc.state) {
      if (!(await copyText(saveText(next.doc.state.doc, next.doc.eol)))) return false
    }
    dontSave(next)
  }
}

/**
 * Before the file is handed to what reads it from disk with unsaved changes: Save and Send (Copy, Open), the default;
 * Send (Copy, Open) Anyway; or Cancel. Resolves whether to hand it over; a save that does not end saved is Cancel.
 */
export async function askHandOff(kind: HandOff, sessionId: string, path: string): Promise<boolean> {
  const e = unsavedEntry(sessionId, path)
  if (!e || e.orphan) return true
  closeOtherSheets()
  ++reviews
  const a = await new Promise<UnsavedAnswer>((resolve) => {
    answer = resolve
    reviewView.ask = { sessionId, path, cannotSave: cannotSave(e), orphan: false, handOff: kind }
  })
  if (a === 'anyway') return true
  if (a !== 'save') return false
  await saveUnsaved(sessionId, path, e.doc)
  return !hasUnsaved(e.doc)
}

/** Don't Save at once: the document's text goes (closing its tab, the low-memory banner). */
function dropNow(e: UnsavedEntry): void {
  discardDocument(e.sessionId, e.path)
}

/**
 * Close a file tab, asking first when its file has unsaved changes: `close` runs after Save or Don't Save, never after
 * Cancel.
 */
export async function closeAsking(sessionId: string, path: string, close: () => void): Promise<void> {
  if (!isUnsaved(sessionId, path)) {
    close()
    return
  }
  if (await reviewUnsaved({ kind: 'file', sessionId, path }, dropNow)) close()
}

/**
 * The viewer that has `doc` on screen, in the file view or under Compare (a review leaves Compare on screen: the tab it
 * puts on screen is the one already there).
 */
function viewerOf(doc: UnsavedEntry['doc']): ReturnType<typeof currentViewer> {
  const v = currentViewer()
  return v && (v.showing(doc) || v.comparing(doc)) ? v : null
}

/** Set a document aside for `action` (Don't Save while it runs): read-only, "Closing…". */
function putAside(e: UnsavedEntry, action: string): void {
  setAside(e.sessionId, e.path, action)
  trackUnsaved(e.sessionId, e.path, e.doc)
  viewerOf(e.doc)?.setClosing(true)
}

/** The documents set aside for `action`: dropped when it happened, given back otherwise. */
function settleAside(action: string, went: boolean): void {
  for (const e of asideFor(action)) {
    if (went) {
      discardDocument(e.sessionId, e.path)
      continue
    }
    setAside(e.sessionId, e.path, null)
    viewerOf(e.doc)?.setClosing(false)
    // its tab, if it went meanwhile, comes back (pinned)
    if (!e.orphan && sessions.get(e.sessionId) && !fileTabsOf(e.sessionId).tabs.some((t) => t.mode === 'file' && t.path === e.path))
      setFileTabs(e.sessionId, openFileTab(fileTabsOf(e.sessionId), { path: e.path, mode: 'file', pin: true }, L.viewerPinnedTabsMax, (p) => isUnsaved(e.sessionId, p)).tabs)
    trackUnsaved(e.sessionId, e.path, e.doc)
  }
}

/**
 * Run `action`, which closes the unsaved files of `scope` (a delete, a project's removal), after asking about each.
 * Refused while Kea's core is restarting. Don't Save's documents are set aside while it runs: dropped when it resolves
 * true, given back when it resolves false or rejects. Resolves whether the action ran and happened.
 */
export async function withDiscards(scope: ReviewScope, action: () => Promise<boolean>): Promise<boolean> {
  if (unsavedEntries().some((e) => inScope(e, scope))) {
    if (!coreUp) {
      showToast({ message: 'Kea’s core is restarting: nothing was closed. Try again once it is back.' })
      return false
    }
    const id = `local:${++actions}`
    const answered = await reviewUnsaved(scope, (e) => putAside(e, id))
    if (!answered) {
      settleAside(id, false)
      return false
    }
    let went = false
    try {
      went = await action()
    } catch {
      went = false
    }
    settleAside(id, went)
    return went
  }
  try {
    return await action()
  } catch {
    return false
  }
}

/**
 * The registry's cap reached: the oldest unsaved file other than the one on screen is put on screen; when it is an
 * orphan, which has no tab, the files of sessions that are gone are asked about instead.
 */
export function showOldestUnsaved(sessionId: string, path: string): void {
  const oldest = unsavedEntries().find((e) => !(e.sessionId === sessionId && e.path === path))
  if (oldest?.orphan) void reviewUnsaved({ kind: 'orphans' }, dropNow)
  else if (oldest) void putOnScreen(oldest)
}

/**
 * Sessions no longer listed (deleted in another window, an archived one whose worktree was cleaned) leave their unsaved
 * files without a folder: kept, counted, and named in a toast with Copy (several: Review, which offers Copy All).
 */
export function orphanUnsavedFiles(exists: (sessionId: string) => boolean): void {
  // a document set aside by this window's own delete goes with it and is not news
  const gone = orphanUnsaved(exists).filter((e) => e.aside === null)
  const first = gone[0]
  if (!first) return
  if (gone.length > 1) {
    showToast({ message: `${gone.length} files had unsaved changes in sessions that are gone`, action: { label: 'Review', run: () => void reviewUnsaved({ kind: 'orphans' }, dropNow) } })
    return
  }
  const text = first.doc.state ? saveText(first.doc.state.doc, first.doc.eol) : ''
  showToast({ message: `${fileName(first.path)} had unsaved changes in a session that is gone`, action: { label: 'Copy', run: () => void copyText(text) } })
}

/** The unsaved files of `sessionId` at `path` or, for a folder, under it. */
export function unsavedUnder(sessionId: string, path: string): UnsavedEntry[] {
  return unsavedEntries().filter((e) => e.sessionId === sessionId && (e.path === path || e.path.startsWith(`${path}/`)))
}

/** What a sheet that loses unsaved changes adds: "Your unsaved changes to login.ts will be lost." */
export function lostLine(sessionId: string, path: string): string | null {
  const lost = unsavedUnder(sessionId, path)
  if (lost.length === 0) return null
  return `Your unsaved changes to ${lost.length === 1 ? fileName((lost[0] as UnsavedEntry).path) : `${lost.length} files`} will be lost.`
}

/**
 * Move to Trash or Discard Changes happened to `path`: its unsaved documents go. After Trash their tabs close; after
 * Discard Changes a document on screen shows the file as it is now, with nothing unsaved.
 */
export function dropUnsavedUnder(sessionId: string, path: string, closeTabs: boolean): void {
  for (const e of unsavedUnder(sessionId, path)) {
    discardDocument(e.sessionId, e.path)
    if (closeTabs) setFileTabs(sessionId, closeFileTab(fileTabsOf(sessionId), fileTabId(e.path)))
  }
}

/** Don't Save for every unsaved file, asking nothing (the test harness before it closes the window). */
export function discardUnsaved(): void {
  answerUnsaved('cancel')
  for (const e of unsavedEntries()) discardDocument(e.sessionId, e.path)
}

// ── main's requests ───────────────────────────────────────────────────────────────────────────────

// bounded: one per request of main's this window answered (or was counted) `proceed` and main has not settled; main
// asks one request at a time, and each settles exactly once
const tickets = new Set<number>()
/** Main's request this window is asking about now. */
let reviewing: number | null = null

const ticketAction = (reqId: number): string => `main:${reqId}`

function going(on: boolean): void {
  setWindowGoing(on)
  currentViewer()?.saveStateChanged()
}

async function mainReview(reqId: number, _reason: ReviewReason): Promise<void> {
  reviewing = reqId
  const answered = await reviewUnsaved({ kind: 'window' }, (e) => putAside(e, ticketAction(reqId)))
  if (reviewing !== reqId) {
    // main decided without the window meanwhile (`decided`): what this review set aside goes back
    settleAside(ticketAction(reqId), false)
    return
  }
  reviewing = null
  if (!answered) {
    settleAside(ticketAction(reqId), false)
    answerReview(reqId, 'cancel')
    return
  }
  tickets.add(reqId)
  going(true)
  answerReview(reqId, 'proceed')
}

setReviewHost({
  review: (reqId, reason) => {
    mainReview(reqId, reason).catch((e: unknown) => {
      // a review that broke keeps everything: nothing is set aside, and main is told not to go ahead
      console.warn('the review of unsaved files failed', e)
      if (reviewing === reqId) reviewing = null
      settleAside(ticketAction(reqId), false)
      answerReview(reqId, 'cancel')
    })
  },
  decided: (reqId, outcome) => {
    if (reviewing === reqId) {
      reviewing = null
      answerUnsaved('cancel')
    }
    if (outcome === 'proceed') {
      tickets.add(reqId)
      going(true)
    }
  },
  closeDone: (reqId, went) => {
    if (!tickets.delete(reqId)) return
    settleAside(ticketAction(reqId), went)
    if (tickets.size === 0) going(false)
  },
  lowMemory: () => {
    if (unsavedEntries().length > 0) reviewView.lowMemory = true
  },
  giveDocuments: (): HandedDocuments | null => {
    const list = unsavedEntries()
    if (list.length === 0) return null
    const shown = fileTabsState.shown
    return { documents: list.map((e) => handedDocument(e, shown?.mode === 'file' && shown.sessionId === e.sessionId && shown.path === e.path)) }
  },
})

onUnsavedCount((n) => {
  setUnsavedCount(n)
  if (n === 0) reviewView.lowMemory = false
  commands.changed()
})

/** The low-memory banner's Save Your Files: the review of every unsaved file, Don't Save dropping at once. */
export function saveYourFiles(): void {
  void reviewUnsaved({ kind: 'window' }, dropNow)
}

/** A window rebuilt in place of another takes the old one's unsaved documents, once, after it loads. */
export async function takeHandedDocuments(): Promise<void> {
  const handed = await takeDocuments()
  if (!handed) return
  let active: { sessionId: string; path: string } | null = null
  for (const d of handed.documents) {
    trackUnsaved(d.sessionId, d.path, documentFromHand(d))
    if (sessions.get(d.sessionId) && !fileTabsOf(d.sessionId).tabs.some((t) => t.mode === 'file' && t.path === d.path))
      setFileTabs(d.sessionId, openFileTab(fileTabsOf(d.sessionId), { path: d.path, mode: 'file', pin: true }, L.viewerPinnedTabsMax, (p) => isUnsaved(d.sessionId, p)).tabs)
    if (d.active) active = { sessionId: d.sessionId, path: d.path }
  }
  if (active) {
    const e = unsavedEntry(active.sessionId, active.path)
    if (e) await putOnScreen(e)
  }
}
