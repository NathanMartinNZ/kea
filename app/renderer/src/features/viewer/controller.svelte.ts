// What a viewer mount shows, and how it gets there. One controller per mounted `Viewer.svelte`; it reads the tab's file
// or diff from core, puts it in the window's editors (`editor.ts`, `merge.ts`), follows it while it is on screen, and
// tells the component the little it draws around the text (`ui`: plain data in rune state — the document, its tokens
// and the editors are never there).
//
//   show      a tab came on screen: follow it (`viewer.follow`), then read it (`viewer.read` + `viewer.changes`, or
//             `viewer.diff`). The follow is asked for first, so nothing that changes between the read and the follow
//             is missed. A file that was shown a moment ago comes from the document cache at once and is read again
//             all the same; what differs is applied as a reload.
//   reload    the follow answered (at most L.viewerReloadPerS times a second, core's throttle): the file changed →
//             read again and apply only the lines that differ, keeping the first visible line where it is and the
//             folds around unchanged lines; the git state changed → the gutter's lines, or the diff.
//   highlight the text is on screen before any tokenising is asked for; a request ends with its document's
//             visibility.
//   leave     the tab is hidden: its request is cancelled, a file's document goes to the cache, or to the unsaved
//             registry (`unsaved.svelte.ts`, with its undo history) when its text is not on disk, and the editors
//             hold nothing. The tab's own state (scroll, selection, folds) was handed to the strip as it changed
//             (`onview`).
//   edit      an editable file's text is the user's to change; `saving.ts` follows whether it differs from the file
//             and saves it with `viewer.save`. A change on disk under unsaved text is merged in (`rebase.ts`), never
//             put over it.
//
// A restarted core ends the follow with `closed`: it is asked for again on the new port, and the tab is read
// again as after any change.

import { tick } from 'svelte'
import { getSearchQuery } from '@codemirror/search'
import { indentLess, indentMore, redo, undo } from '@codemirror/commands'
import { EditorSelection, Text, Transaction, type ChangeSet, type EditorState } from '@codemirror/state'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import { foldEffect, unfoldEffect } from '@codemirror/language'
import { changesOrder, gitEntry, gitHead, imageExtension, keaFileUrl, RpcError, type DiffRead, type FileRead, type FileReadResult, type GitCode, type SameRead, type GitEntry, type GitHead, type GitRow, type HandedDocument, type LineChanges, type TextBytes, type SaveResult, type ViewMode } from '@kea/protocol'
import { call } from '../../lib/rpc.ts'
import { commands } from '../commands/registry.ts'
import { diffHeader, type LineCounts } from '../files/changes.ts'
import { copyText } from '../sessions/actions.ts'
import { sessions } from '../sessions/state.svelte.ts'
import { followSessionStore } from '../sessions/visible.ts'
import { goTo, openFindBar, openGotoBar, openReplaceBar } from './bars.ts'
import type { HighlightHandle } from './client.ts'
import { decodeText, encodingNote, splitLines } from './decode.ts'
import { DocCache } from './docCache.ts'
import { hasUnsaved, type FileDocument } from './document.ts'
import { indentStringOf, setFileLineEnding, type EditingOptions } from './editing.ts'
import { fileState, hideFile, restoreScroll, reveal, scrollOf, setEditable, setEditorHooks, setWrap, showFile, type EditorHooks } from './editor.ts'
import { staleFoldEffects } from './folding.ts'
import { changedRegions, setLineChanges } from './gutter.ts'
import { tokensArrived } from './highlight.ts'
import { highlighter, tokenizeInto } from './highlighter.ts'
import { applyFromDisk, historyBytes, historyClearedForMemory } from './history.ts'
import { languageOf } from './language.ts'
import { defaultIndent, languageAids } from './languageAids.ts'
import { keepYours, marksOf, setMarks, useTheFiles } from './marks.ts'
import { chunkCount, diffCounts, goToChunk, hideDiff, originalOf, showDiff, type DiffLayout, type ShownDiff } from './merge.ts'
import { textStats, viewPolicy } from './policy.ts'
import { showPreview } from './preview.ts'
import { isFromDisk } from './readonly.ts'
import { merge } from './rebase.ts'
import { reference, selectedLines } from './reference.ts'
import { reloadChanges } from './reload.ts'
import { showOldestUnsaved } from './review.svelte.ts'
import { EditTokens } from './editTokens.ts'
import { DocSave, saveText, type SaveAnswer, type SaveCall, type SaveFacts } from './saving.ts'
import { EMPTY_VIEW, type TabPosition, type TabViewState, type ViewerTab } from './tab.ts'
import { TokenStore } from './tokens.ts'
import { capReason, dropUnsaved, isUnsaved, moveUnsaved, setHistoryWeigher, trackUnsaved, unsavedDoc, windowGoing, type UnsavedEntry } from './unsaved.svelte.ts'
import { captureView, positionOf } from './viewState.ts'
import { DEFAULT_WRAP, isMarkdown, toggledWrap, wrapFor, type WrapFlags } from './wrap.ts'
import { L } from '@kea/protocol/limits'

// ── what the component draws ───────────────────────────────────────────────────────────────────────

export type NoteAction = 'editor' | 'default' | 'reveal'

/** What the notice line under the header offers about an editable file's text. */
export type NoticeAction = 'compare' | 'useFile' | 'keepMine' | 'retry' | 'save' | 'copyAll' | 'dontSave' | 'show'

/** The one line about an editable file's text (a conflict, a failed save, the file gone…), with what can be done. */
export interface EditNotice {
  text: string
  actions: readonly NoticeAction[]
}

export type Body =
  | { kind: 'loading' }
  /** The file view's editor is on screen. */
  | { kind: 'text' }
  /** The Markdown preview. */
  | { kind: 'preview' }
  | { kind: 'image'; url: string; width: number | null; height: number | null }
  /** The diff instance is on screen. */
  | { kind: 'diff' }
  /** An image diff: old and new side by side. */
  | { kind: 'images'; old: string | null; new: string | null }
  /** One line (binary, large, a link that leads out, a folder), with what can be done about it. */
  | { kind: 'note'; text: string; actions: readonly NoteAction[] }

export interface ViewerUi {
  body: Body
  path: string
  mode: ViewMode
  language: string | null
  /** The encoding and line ending when they are not UTF-8 and LF. */
  encoding: string | null
  /** Where a symlink leads (inside the worktree). */
  link: string | null
  /** One line under the header. */
  notices: readonly string[]
  /** The file is gone; its last content stays, dimmed. */
  deleted: boolean
  /** The path's entry in the file panel's scope: the `File · Diff` switch. */
  entry: GitEntry | null
  /** The diff header's status letter and `+n −n`, which say one thing (`diffHeader`): the entry's, or the diff on screen's where the status has no entry. */
  letter: GitCode | null
  counts: LineCounts | null
  size: number | null
  wrap: boolean
  canWrap: boolean
  /** A Markdown file that may be previewed, and whether the preview is on. */
  canPreview: boolean
  preview: boolean
  /** An SVG: shown as an image or as its source. */
  canSource: boolean
  source: boolean
  layout: DiffLayout
  /** Changed regions (file view) or hunks (diff) to step through. */
  changes: number
  /** The file's text can be edited now. */
  editable: boolean
  /** Why a text file cannot be edited: the header's "Read-only" and its tooltip. Null for one that can, and for what is not text. */
  readOnly: string | null
  /** The document has text that is not on disk (the tab's dot). */
  unsaved: boolean
  /** The line about the document's text and what can be done about it. */
  editNotice: EditNotice | null
}

function blank(path: string, mode: ViewMode): ViewerUi {
  return { body: { kind: 'loading' }, path, mode, language: null, encoding: null, link: null, notices: [], deleted: false, entry: null, letter: null, counts: null, size: null, wrap: false, canWrap: false, canPreview: false, preview: false, canSource: false, source: false, layout, changes: 0, editable: false, readOnly: null, unsaved: false, editNotice: null }
}

/** `12.3 KB`, as Finder writes sizes. */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`
}

function fileType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'Binary file'
}

const MIME: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml' }

/** An image's bytes as a `data:` URL (the CSP's `img-src` allows it; nothing is fetched). */
function dataUrl(bytes: Uint8Array, ext: string): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${MIME[ext] ?? 'application/octet-stream'};base64,${btoa(s)}`
}

// ── the window's viewer state (plain module state) ────────────────────────────────────────────────

setHistoryWeigher((doc) => (doc.state ? historyBytes(doc.state) : 0))

const cache = new DocCache<FileDocument>({
  maxDocs: L.viewerDocCache,
  maxBytes: L.viewerDocCacheBytes,
  onDrop: (key, doc) => {
    doc.colours?.dispose()
    highlighter().forget(key)
  },
})
// bounded: one per file tab of the session on screen showing its other view (a Markdown preview, an SVG's source):
// at most 1 + L.viewerPinnedTabsMax, plus the tabs the pinned cap keeps for their unsaved changes (at most
// L.viewerUnsavedMax + 1), cleared with the session
const otherView = new Set<string>()
let cacheSession: string | null = null
/** Word wrap, Markdown's and code's, for the window (wrap.ts). */
let wrapFlags: WrapFlags = { ...DEFAULT_WRAP }
let layout: DiffLayout = 'unified'
let current: ViewerController | null = null
let visible = 0
let reads = 0
let follows = 0

const docKey = (sessionId: string, path: string) => `${sessionId}\n${path}`

/**
 * The session on screen changed (or the cache's session is no longer shown): the cache keeps no document of another
 * session. Unsaved documents stay in the unsaved registry, whatever their session.
 */
export function forgetDocuments(sessionId: string | null = null): void {
  if (sessionId !== null && sessionId === cacheSession) return
  cache.clear()
  otherView.clear()
  cacheSession = sessionId
}

/** Whether a session has a tab for a path: the strip's answer (`commands.ts` gives it); every path until then. */
let hasTab: (sessionId: string, path: string) => boolean = () => true

export function setTabOracle(fn: ((sessionId: string, path: string) => boolean) | null): void {
  hasTab = fn ?? (() => true)
}

/**
 * The strip's tabs changed: nothing is kept for a tab that is gone — closed, a preview tab that shows another file now,
 * a pinned tab closed by a pin over L.viewerPinnedTabsMax — not its cached document, nor which of its two views it
 * showed. The unsaved registry is not touched: a tab with unsaved changes is never a preview or closed by the cap, and
 * closing it asks first.
 */
export function forgetClosedTabs(): void {
  const open = (key: string) => {
    const at = key.indexOf('\n')
    return hasTab(key.slice(0, at), key.slice(at + 1))
  }
  cache.prune(open)
  for (const key of [...otherView]) if (!open(key)) otherView.delete(key)
}

/** The viewer that has the screen, for the commands (`commands.ts`). */
export function currentViewer(): ViewerController | null {
  return current
}

/** For the resource report and the leak tests. */
export function viewerStats(): { cachedDocs: number; cachedBytes: number; otherViews: number; reads: number; follows: number; viewers: number } {
  return { cachedDocs: cache.size, cachedBytes: cache.bytes, otherViews: otherView.size, reads, follows, viewers: visible }
}

const codeOf = (e: unknown): string => (e instanceof RpcError ? e.code : '')

// ── editing: what a read says, and what the notice line says ────────────────────────────────────────

/** A UTF-8 file's bytes start with a byte-order mark (a UTF-16 file is told by its mark, so it always has one). */
function hasBom(t: TextBytes): boolean {
  if (t.encoding !== 'utf8') return true
  const b = t.bytes
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
}

/** What a save needs from a read of the file. */
function factsOf(r: FileRead, t: TextBytes): SaveFacts {
  return { version: r.version ?? null, eol: t.eol, encoding: t.encoding, bom: hasBom(t), mode: r.mode ?? null }
}

/** A document that can be edited for as long as it stays as it loaded: text within the full-feature size, valid, with one line ending. */
export function editableAtLoad(r: FileRead, t: TextBytes): boolean {
  return r.size <= L.viewerFullBytes && !t.invalid && t.eol !== 'mixed'
}

/** Why a document that was never editable is not: the header's tooltip. */
export function readOnlyAtLoad(doc: FileDocument): string | null {
  if (doc.size > L.viewerFullBytes) return `over ${sizeText(L.viewerFullBytes)}`
  if (doc.invalid) return doc.encoding === 'utf8' ? 'not valid UTF-8' : 'not valid UTF-16'
  if (doc.eol === 'mixed') return 'mixed line endings'
  return null
}

/** The reason a clean document whose file was deleted is read-only, until the file is there again. */
const DELETED = 'deleted on disk'

/** Why the file cannot be written back, as a read says. */
export function unwritableReason(r: FileRead | SameRead): string | null {
  const w = r.writable
  if (w === 'permission' || w === undefined) return 'no permission'
  if (w === 'git') return 'inside .git'
  if (w === 'hard-linked') return 'hard-linked'
  return null
}

/**
 * Why an editable document cannot be edited now, most pressing first: it is closing (set aside by Don't Save, or the
 * window is going), the file stopped being text, it cannot be written back, or the window holds too many unsaved files.
 */
export function readOnlyNow(doc: FileDocument, sessionId: string, path: string): string | null {
  if (doc.closing || windowGoing()) return 'Closing…'
  if (doc.notText !== null) return `the file is now ${doc.notText}`
  return doc.unwritable ?? capReason(sessionId, path)
}

/** The words for what a file became, under a document with unsaved text. */
function notTextWords(r: FileRead): string {
  switch (r.kind) {
    case 'binary':
      return 'a binary file'
    case 'image':
      return 'an image'
    case 'large':
      return `over ${sizeText(L.viewerMaxBytes)}`
    case 'directory':
      return 'a folder'
    case 'outside':
      return 'a link out of this folder'
    default:
      return 'unreadable'
  }
}

/** The options of an editable document; its Save and its Esc ask whoever shows it now. */
function editingFor(doc: FileDocument, text: Text): EditingOptions {
  return {
    eol: doc.eol,
    indent: indentStringOf(text, defaultIndent(doc.lang?.id ?? null)),
    aids: languageAids(doc.lang?.id ?? null),
    host: { unsaved: () => hasUnsaved(doc), save: () => current?.saveFile() },
  }
}

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The line about an editable document's text, most pressing first. */
function editNoticeOf(doc: FileDocument, state: EditorState, path: string): EditNotice | null {
  if (!doc.save) return null
  if (doc.closing || windowGoing()) return { text: 'Closing…', actions: [] }
  if (doc.notText !== null) return { text: `${fileName(path)} is now ${doc.notText}: your changes can’t be saved there`, actions: ['copyAll', 'dontSave'] }
  const marked = marksOf(state).length
  if (marked > 0) return { text: `Changed on disk where you edited (${marked === 1 ? '1 place' : `${marked} places`})`, actions: ['compare', 'useFile', 'keepMine'] }
  if (doc.save.phase === 'failed') return { text: `Not saved · ${doc.save.failure ?? 'It could not be written'}`, actions: ['retry'] }
  if (doc.save.deleted) return { text: 'Deleted on disk · Save to create it again', actions: ['save'] }
  if (historyClearedForMemory(state)) return { text: 'Earlier undo steps were cleared to save memory', actions: [] }
  if (doc.readOnly !== null && doc.readOnly.endsWith('unsaved changes')) return { text: `Read-only · ${doc.readOnly}`, actions: ['show'] }
  return null
}

/** A save's answer as the document's save state takes it. */
function answerOf(r: SaveResult): SaveAnswer {
  switch (r.kind) {
    case 'saved':
      return { kind: 'saved', version: r.version }
    case 'changed':
      return { kind: 'changed' }
    case 'missing':
      return { kind: 'missing' }
    case 'refused':
      return { kind: 'refused', reason: r.reason, ...(r.detail !== undefined ? { detail: r.detail } : {}) }
  }
}

/** The pending wait for an answer, or none after L.viewerSaveTimeoutMs. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/**
 * Save `doc` of `sessionId`'s `path` and settle it. The answer goes to the document wherever it is by then: on screen a
 * `changed` answer is merged at once and the save made again; hidden, the file's text waits for the document to be
 * shown. Resolves when this save, and any made again after a merge or queued behind it, has settled; a save asked for
 * while one is out is queued behind it and resolves with it.
 */
function saveDocument(sessionId: string, path: string, doc: FileDocument, again = false): Promise<void> {
  const save = doc.save
  const state = doc.state
  if (!save || !state) return Promise.resolve()
  const c = save.begin(state.doc, again)
  noteSave(sessionId, path, doc)
  if (!c) return (save.phase === 'saving' && save.running) || Promise.resolve()
  const run = sendSave(sessionId, path, doc, save, state, c)
  save.running = run
  const done = (): void => {
    if (save.running === run) save.running = null
  }
  run.then(done, done)
  return run
}

/** One `viewer.save` and what its answer leads to: a merge and the save made again, the queued save, the read after it. */
async function sendSave(sessionId: string, path: string, doc: FileDocument, save: DocSave, state: EditorState, c: SaveCall): Promise<void> {
  saving++
  let answer: SaveAnswer
  let current_: (TextBytes & { version: string }) | null = null
  try {
    const r = await withTimeout(call('viewer.save', { sessionId, path, text: c.text, base: c.base, eol: c.eol, ...(c.create ? { create: c.create } : {}) }), L.viewerSaveTimeoutMs)
    if (r === null) answer = { kind: 'lost', why: 'Kea’s core did not answer' }
    else {
      answer = answerOf(r)
      if (r.kind === 'changed') current_ = r.current
    }
  } catch (e) {
    // the error's own words are for a developer: the notice says what happened to the save
    answer = { kind: 'lost', why: codeOf(e) === 'closed' ? 'Kea’s core restarted' : 'Kea’s core could not save it' }
  } finally {
    saving--
  }
  const next = save.settle(c.id, answer, (doc.state ?? state).doc)
  const shower = current?.showing(doc) ? current : null
  if (next === 'merge') {
    if (current_) {
      const disk = Text.of(splitLines(decodeText(current_)))
      const facts: SaveFacts = { version: current_.version, eol: current_.eol, encoding: current_.encoding, bom: hasBom(current_), mode: save.facts.mode }
      if (shower) {
        shower.mergeFromSave(disk, facts)
        noteSave(sessionId, path, doc)
        // merged (not waiting for an input method to finish) with nothing marked: saved again over the file's version
        if (doc.state && !doc.pendingDisk && marksOf(doc.state).length === 0) return saveDocument(sessionId, path, doc, true)
        return
      }
      doc.pendingDisk = { text: disk, facts, again: true }
    } else shower?.reread()
  }
  noteSave(sessionId, path, doc)
  // every answer is followed by a read asked for now: reads that landed while the save was out were dropped, and after
  // a lost answer the file says whether the write landed (one asked before the answer, as the follow's own when core
  // restarts, is dropped as stale)
  if (answer.kind !== 'changed') shower?.reread()
  if (save.takeQueued()) return saveDocument(sessionId, path, doc)
}

/** The document's save state changed: the registry, and the viewer that shows it. */
function noteSave(sessionId: string, path: string, doc: FileDocument): void {
  trackUnsaved(sessionId, path, doc)
  if (current?.showing(doc)) current.saveStateChanged()
}

let saving = 0

/** Save a document wherever it is: the viewer's own Save when it is on screen; nothing while places are marked. */
export function saveUnsaved(sessionId: string, path: string, doc: FileDocument): Promise<void> {
  if (current?.showing(doc)) return current.saveFile()
  if (!doc.save || !doc.state || doc.closing || doc.notText !== null || marksOf(doc.state).length > 0) return Promise.resolve()
  return saveDocument(sessionId, path, doc)
}

/** Don't Save: the document's unsaved text goes; on screen, the file is read again as it is. */
export function discardDocument(sessionId: string, path: string): void {
  const doc = unsavedDoc(sessionId, path)
  dropUnsaved(sessionId, path)
  if (!doc) return
  doc.closing = false
  if (current?.showing(doc) || current?.comparing(doc)) current.discardText()
  else {
    doc.colours?.dispose()
    doc.colours = null
    doc.save = null
    doc.state = null
  }
}

/**
 * Files of `sessionId` moved or were renamed in the file tree (`map`: a path to where it is now): their unsaved
 * documents go with them, the one on screen included.
 */
export function moveDocuments(sessionId: string, map: (path: string) => string): void {
  moveUnsaved(sessionId, map)
  current?.moved(sessionId, map)
}

/** An unsaved document as a window hands it to the one rebuilt in its place: no undo history. */
export function handedDocument(e: UnsavedEntry, active: boolean): HandedDocument {
  const { doc } = e
  const save = doc.save as DocSave
  const state = doc.state as EditorState
  return {
    sessionId: e.sessionId,
    path: e.path,
    text: state.doc.toString(),
    base: save.base.toString(),
    version: save.facts.version,
    eol: save.facts.eol,
    encoding: save.facts.encoding,
    bom: save.facts.bom,
    mode: save.facts.mode,
    selection: state.selection.ranges.slice(0, L.viewerCursorMax).map((r) => ({ anchor: r.anchor, head: r.head })),
    marks: marksOf(state, save.base)
      .slice(0, L.viewerMarksMax)
      .map((m) => ({ doc: { from: m.doc.from, to: m.doc.to }, base: { from: m.base.from, to: m.base.to } })),
    state: save.phase === 'failed' ? 'failed' : 'dirty',
    deleted: save.deleted,
    sent: save.sent?.toString() ?? null,
    active,
  }
}

/** A handed-over document as this window keeps it: unsaved, with its selection and marks, and a fresh undo history. */
export function documentFromHand(d: HandedDocument): FileDocument {
  const lines = splitLines(d.text)
  const stats = textStats(d.text.length, lines)
  const policy = viewPolicy(stats)
  const lang = policy.highlight === 'none' ? null : languageOf(d.path, lines[0])
  const store = lang ? new TokenStore() : null
  const text = Text.of(lines)
  const save = new DocSave(Text.of(splitLines(d.base)), { version: d.version, eol: d.eol, encoding: d.encoding, bom: d.bom, mode: d.mode })
  const doc: FileDocument = {
    state: null,
    store,
    policy,
    lang,
    eol: d.eol,
    encoding: d.encoding,
    invalid: false,
    size: d.text.length,
    link: null,
    changes: null,
    longest: stats.longestLine,
    tokenised: lang ? 0 : -1,
    stoppedAt: null,
    bytes: d.text.length,
    save,
    readOnly: null,
    unwritable: null,
    notText: null,
    pendingDisk: null,
    closing: false,
    colours: null,
  }
  if (lang && store) doc.colours = new EditTokens({ doc: docKey(d.sessionId, d.path), lang: lang.id, store, budgetMs: policy.budgetMs, onTokens: () => (doc.tokenised = store.lines) })
  const at = (n: number): number => Math.min(n, text.length)
  const state = fileState({ path: d.path, lines, eol: d.eol, policy, store, wrap: wrapFor(lang?.id, wrapFlags, policy.wrap), changes: null, edit: editingFor(doc, text) }, EMPTY_VIEW, null)
  const ranges = d.selection.map((r) => EditorSelection.range(at(r.anchor), at(r.head)))
  doc.state = state.update({
    ...(ranges.length > 0 ? { selection: EditorSelection.create(ranges) } : {}),
    effects: setMarks.of(d.marks.map((m) => ({ doc: { from: at(m.doc.from), to: at(m.doc.to) }, base: m.base }))),
    annotations: Transaction.addToHistory.of(false),
  }).state
  save.handedOver(text, d.state === 'failed', d.deleted, d.sent === null ? null : Text.of(splitLines(d.sent)))
  return doc
}

export interface ViewerHost {
  /** Where the editors go. */
  editor(): HTMLElement | null
  /** Where the Markdown preview goes. */
  preview(): HTMLElement | null
  /** The viewer has the keyboard (so a document that arrives takes it). */
  focused(): boolean
  onview(view: TabViewState): void
  /** The keyboard to the notice line's first action (Save while places are marked). */
  focusNotice?(): void
}

type Shown =
  | { kind: 'none' }
  | { kind: 'file'; view: EditorView; doc: FileDocument; text: string | null; job: HighlightHandle | null }
  | { kind: 'diff'; diff: ShownDiff; oldStore: TokenStore | null; newStore: TokenStore | null; jobs: { old: HighlightHandle | null; new: HighlightHandle | null }; read: DiffRead }
  /** Compare: an editable document's text against the file's, in the diff instance; `back` is where the document was. */
  | { kind: 'compare'; diff: ShownDiff; doc: FileDocument; back: TabViewState }

export class ViewerController {
  /** What the component draws: plain data, replaced whole. */
  ui = $state.raw<ViewerUi>(blank('', 'file'))

  private readonly host: ViewerHost
  private sessionId = ''
  private path = ''
  private mode: ViewMode = 'file'
  /** The diff on screen as its header reads it: which sides are there, the lines that differ (null: not text). Null: none read for this tab yet. */
  private seen: { old: boolean; new: boolean; counts: LineCounts | null } | null = null
  private key = ''
  /** Changes with every tab shown: an answer for an older one is dropped. */
  private gen = 0
  private kept: TabViewState = { scroll: null, selection: null, folds: [] }
  private pendingGoto: TabPosition | null = null
  private shown: Shown = { kind: 'none' }
  private loading = false
  private again: { file: boolean; git: boolean } | null = null
  /** The file changed while Compare was on screen: it is read, and merged, once Compare ends. */
  private afterCompare = false
  private git: ReadonlyMap<string, GitRow> = new Map()
  private offGit: (() => void) | null = null
  private gitSession: string | null = null
  private stopPreview: (() => void) | null = null
  private saveQueued = false
  /** Save was asked for while an input method composed: it runs when the composition ends. */
  private saveAfterComposing = false
  private disposed = false
  private readonly hooks: EditorHooks = { update: (u) => this.updated(u), scrolled: () => this.queueSave() }

  constructor(host: ViewerHost) {
    this.host = host
    visible++
    highlighter().setVisible(true)
  }

  // ── tabs ─────────────────────────────────────────────────────────────────────────────────────────

  /** `tab` of `sessionId` is on screen now. */
  show(sessionId: string, tab: ViewerTab): void {
    if (this.disposed) return
    this.leave()
    current = this
    this.gen++
    this.sessionId = sessionId
    this.path = tab.path
    this.mode = tab.mode
    this.seen = null
    this.key = docKey(sessionId, tab.path)
    this.kept = tab.view
    this.pendingGoto = tab.goto
    this.again = null
    this.loading = false
    forgetDocuments(sessionId)
    this.ui = { ...blank(tab.path, tab.mode), ...this.gitFacts() }
    this.followGit(sessionId)
    // the follow first: whatever changes after the read is then seen
    void this.follow(this.gen)
    if (tab.mode === 'file') {
      // a document with unsaved text is the registry's, with its undo history; another one may be in the cache
      const cached = unsavedDoc(sessionId, tab.path) ?? cache.take(this.key)
      if (cached?.state) this.showFileDocument(cached, cached.state, null, true)
      else if (cached) highlighter().forget(this.key)
    }
    void this.load(this.gen, { file: true, git: true })
    commands.changed()
  }

  /** The tab on screen was opened again at a position. */
  goto(p: TabPosition): void {
    const view = this.textView()
    if (!view) {
      this.pendingGoto = p
      return
    }
    goTo(view, p)
    this.save()
  }

  /** The mount is going. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.leave()
    this.offGit?.()
    this.offGit = null
    visible--
    if (visible === 0) highlighter().setVisible(false)
    if (current === this) {
      current = null
      // nothing of this window follows a file now
      void call('viewer.unfollow', {}).catch(() => undefined)
      commands.changed()
    }
  }

  /** The tab on screen is hidden: what it showed is let go. */
  private leave(): void {
    this.gen++
    // a document shown again is read again: what changed under Compare comes in then
    this.afterCompare = false
    this.stopPreview?.()
    this.stopPreview = null
    const s = this.shown
    this.shown = { kind: 'none' }
    if (s.kind === 'file' || s.kind === 'compare') {
      if (s.kind === 'file') s.job?.cancel()
      s.doc.colours?.hide()
      const doc = s.doc
      // a save asked for while one was in flight is not made once its document has left the screen
      doc.save?.dropQueued()
      const { sessionId, path, key } = this
      if (hasUnsaved(doc) || doc.closing) {
        // kept, with its undo history, in the unsaved registry (never the cache); its colours, and the worker's
        // states, are asked for again when it is shown
        trackUnsaved(sessionId, path, doc)
        // its tokens and the worker's line states go (the registry keeps text, not colours); they are asked for again
        // when it is shown
        doc.store?.clear()
        doc.tokenised = doc.lang ? 0 : -1
        doc.stoppedAt = null
        highlighter().forget(key)
        doc.colours?.dropped()
      } else {
        // The most recently viewed documents stay for an instant flip back (`doc.state` is the editor's state as
        // of its last update; the editor itself may already show another mount's document). A deleted file's, one of
        // a session that is no longer the one on screen, and one whose tab is gone (there is nothing to flip back to)
        // are not kept
        doc.bytes = doc.size + (doc.store?.bytes ?? 0) + (doc.state ? historyBytes(doc.state) : 0)
        const deleted = this.ui.deleted
        const settle = (): void => {
          if (!deleted && cacheSession === sessionId && hasTab(sessionId, path)) cache.put(key, doc)
          else {
            doc.colours?.dispose()
            // (unless a mount shows that document again by now: its marks are that mount's)
            if (current?.key !== key) highlighter().forget(key)
          }
        }
        // a mount that is being taken down still reads the strip's tabs as they were before the change that takes it
        // down (Svelte runs teardowns with the old state), so its own tab would always seem to be there: ask afterwards
        if (this.disposed) queueMicrotask(settle)
        else settle()
      }
      if (current === this) {
        this.park()
        if (s.kind === 'file') hideFile()
        else hideDiff()
      }
    } else if (s.kind === 'diff') {
      s.jobs.old?.cancel()
      s.jobs.new?.cancel()
      highlighter().forget(`${this.key}\nold`)
      highlighter().forget(`${this.key}\nnew`)
      if (current === this) {
        this.park()
        hideDiff()
      }
    }
    if (current === this) setEditorHooks(null)
  }

  // ── git facts ────────────────────────────────────────────────────────────────────────────────────

  private followGit(sessionId: string): void {
    if (this.gitSession === sessionId) return
    this.offGit?.()
    this.gitSession = sessionId
    this.git = new Map()
    this.offGit = followSessionStore<GitRow>('git', sessionId, (data) => {
      this.git = data
      if (this.disposed) return
      const next = this.gitFacts()
      const cur = this.ui
      if (next.entry !== cur.entry || next.letter !== cur.letter || next.counts?.added !== cur.counts?.added || next.counts?.removed !== cur.counts?.removed) {
        this.ui = { ...cur, ...next }
        commands.changed()
      }
    })
  }

  private gitFacts(): Pick<ViewerUi, 'entry' | 'letter' | 'counts'> {
    const entry = gitEntry(this.git, this.path)
    return { entry, ...diffHeader(entry, this.mode === 'diff' ? this.seen : null) }
  }

  /** The Changes list's order. */
  changedFiles(): GitEntry[] {
    return changesOrder(this.git)
  }

  /** The session's git status as a whole (its scope, its base, its state); null before the first one. */
  head(): GitHead | null {
    return gitHead(this.git)
  }

  // ── following and loading ────────────────────────────────────────────────────────────────────────

  private async follow(gen: number): Promise<void> {
    let seen = 0
    follows++
    try {
      for (;;) {
        let r
        try {
          r = await call('viewer.follow', { sessionId: this.sessionId, path: this.path, seen })
        } catch (e) {
          if (gen !== this.gen) return
          // core restarted. On its new port the window has said what it shows; follow again and read again
          if (codeOf(e) !== 'closed') return
          seen = 0
          void this.load(gen, { file: true, git: true })
          continue
        }
        if (gen !== this.gen || r.ended) return
        seen = r.rev
        void this.load(gen, { file: r.file, git: r.git })
      }
    } finally {
      follows--
    }
  }

  /** Read what `what` says changed. One read at a time: a change that arrives meanwhile is read right after. */
  private async load(gen: number, what: { file: boolean; git: boolean }): Promise<void> {
    if (gen !== this.gen) return
    if (what.file && this.shown.kind === 'compare') {
      // Compare goes on showing what it began with; the document takes the change when it is on screen again
      if (!this.afterCompare) {
        this.afterCompare = true
        this.compareNotice()
      }
      if (!what.git) return
      what = { file: false, git: true }
    }
    if (this.loading) {
      this.again = { file: (this.again?.file ?? false) || what.file, git: (this.again?.git ?? false) || what.git }
      return
    }
    this.loading = true
    reads++
    try {
      if (this.mode === 'diff') await this.loadDiff(gen)
      else await this.loadFile(gen, what)
    } catch (e) {
      if (gen === this.gen && codeOf(e) !== 'closed') this.note(e instanceof Error ? e.message : String(e), [])
    } finally {
      reads--
      if (gen === this.gen) {
        this.loading = false
        const again = this.again
        this.again = null
        if (again) void this.load(gen, again)
      }
    }
  }

  private args(): { sessionId: string; path: string } {
    return { sessionId: this.sessionId, path: this.path }
  }

  private cwd(): string {
    return (sessions.get(this.sessionId)?.cwd ?? '').replace(/\/+$/, '')
  }

  // ── file view ────────────────────────────────────────────────────────────────────────────────────

  private async loadFile(gen: number, what: { file: boolean; git: boolean }): Promise<void> {
    const source = otherView.has(this.key) && imageExtension(this.path) === 'svg'
    // the gutter's lines are asked for at the same time but marked only once the file is shown: they can be answered
    // first, before there is a document to mark
    const changes = call('viewer.changes', this.args()).catch(() => null)
    if (what.file) {
      // a document on screen names the version it has: an unchanged file is answered `same`, with no bytes
      const shown = this.shown.kind === 'file' ? this.shown.doc : null
      const version = shown?.save?.facts.version ?? null
      const stamp = shown?.save?.readStamp() ?? 0
      const r = await call('viewer.read', { ...this.args(), ...(source ? { source: true } : {}), edit: version !== null ? { ifNotVersion: version } : {} })
      if (gen !== this.gen) return
      this.gotFile(r, stamp)
    }
    const c = await changes
    if (c && gen === this.gen) this.gotChanges(c)
  }

  private gotFile(r: FileReadResult, stamp: number): void {
    const shown = this.shown
    if (shown.kind === 'compare') {
      // a read asked for before Compare began: Compare goes on showing what it began with, and the document reads the
      // file again once it is on screen. What a `same` answer says (the bytes it holds are the file's) applies when it
      // is shown again
      if (r.kind === 'same') {
        if (shown.doc.save) shown.doc.save.facts = { ...shown.doc.save.facts, mode: r.mode }
        shown.doc.unwritable = unwritableReason(r)
        shown.doc.notText = null
      } else if (!this.afterCompare) {
        this.afterCompare = true
        this.compareNotice()
      }
      return
    }
    if (r.kind === 'same') {
      // the text is as it was; whether it can be written and its mode may not be (a chmod, the file there again after
      // it was deleted, or the file's bytes put back as they were after it stopped being text)
      const s = shown
      if (s.kind !== 'file' || !s.doc.save) return
      s.doc.save.facts = { ...s.doc.save.facts, mode: r.mode }
      const unwritable = unwritableReason(r)
      if (unwritable === s.doc.unwritable && s.doc.notText === null) return
      s.doc.unwritable = unwritable
      s.doc.notText = null
      this.setReadOnly(s, readOnlyNow(s.doc, this.sessionId, this.path))
      this.fileUi(s.doc)
      return
    }
    const base = { ...blank(this.path, 'file'), ...this.gitFacts(), size: r.size, link: r.kind === 'outside' ? null : r.link, canSource: imageExtension(this.path) === 'svg', source: otherView.has(this.key) && imageExtension(this.path) === 'svg' }
    if (r.kind === 'text' && r.text) {
      this.gotText(r, r.text, stamp)
      return
    }
    const s = this.shown
    if (s.kind === 'file' && hasUnsaved(s.doc)) {
      // the user's text is never dropped for what the file became: it stays, and says so
      if (r.kind === 'missing') {
        s.doc.save?.goneOnDisk()
        noteSave(this.sessionId, this.path, s.doc)
      } else this.notTextAnyMore(s, notTextWords(r))
      return
    }
    if (r.kind === 'missing' && s.kind === 'file') {
      // Deleted while open — the last content stays, dimmed, and read-only until the file is there again
      s.job?.cancel()
      if (s.doc.save) {
        s.doc.unwritable = DELETED
        this.setReadOnly(s, readOnlyNow(s.doc, this.sessionId, this.path))
        this.fileUi(s.doc)
        return
      }
      this.ui = { ...this.ui, deleted: true, notices: ['Deleted'], editable: false }
      commands.changed()
      return
    }
    this.dropText()
    switch (r.kind) {
      case 'image': {
        const img = r.image
        if (!img?.decodable) this.ui = { ...base, body: { kind: 'note', text: `Image · ${sizeText(r.size)}${img?.width ? ` · ${img.width} × ${img.height}` : ''} · too large to show`, actions: r.openable ? ['default', 'reveal'] : ['reveal'] } }
        else this.ui = { ...base, body: { kind: 'image', url: keaFileUrl(`${this.cwd()}/${this.path}`, Math.trunc(r.mtimeMs)), width: img.width, height: img.height } }
        break
      }
      case 'binary':
        this.ui = { ...base, body: { kind: 'note', text: `${fileType(this.path)} · ${sizeText(r.size)}`, actions: r.openable ? ['default', 'reveal'] : ['reveal'] } }
        break
      case 'large':
        this.ui = { ...base, body: { kind: 'note', text: `Large file · ${sizeText(r.size)}`, actions: ['editor', 'reveal'] } }
        break
      case 'directory':
        this.ui = { ...base, body: { kind: 'note', text: 'A folder', actions: ['reveal'] } }
        break
      case 'outside':
        this.ui = { ...base, body: { kind: 'note', text: `A link to ${r.link ?? 'a file outside this folder'}`, actions: [] } }
        break
      default:
        this.ui = { ...base, deleted: true, body: { kind: 'note', text: base.entry?.code === 'D' ? 'Deleted' : 'No such file', actions: [] } }
    }
    this.landed()
  }

  /** The file view's document is no longer what the tab shows. */
  private dropText(): void {
    this.stopPreview?.()
    this.stopPreview = null
    if (this.shown.kind !== 'file') return
    this.shown.job?.cancel()
    this.shown.doc.colours?.dispose()
    this.shown = { kind: 'none' }
    highlighter().forget(this.key)
    this.park()
    hideFile()
  }

  private gotText(r: FileRead, t: TextBytes, stamp: number): void {
    const text = decodeText(t)
    const lines = splitLines(text)
    const stats = textStats(r.size, lines)
    const policy = viewPolicy(stats)
    const lang = policy.highlight === 'none' ? null : languageOf(this.path, lines[0])
    const facts = factsOf(r, t)
    const s = this.shown
    if (s.kind === 'file' && s.view.state === s.doc.state && hasUnsaved(s.doc)) {
      // the user's text is merged with the file's, never replaced by it (and never rebuilt for another shape)
      if (t.invalid || t.eol === 'mixed') {
        this.notTextAnyMore(s, t.invalid ? `not valid ${t.encoding === 'utf8' ? 'UTF-8' : 'UTF-16'}` : 'a file with mixed line endings')
        return
      }
      const disk = Text.of(lines)
      if (s.doc.save?.landed(stamp, disk, facts, s.view.state.doc) === 'drop') return
      this.mergeDisk(s, disk, facts, text)
      if (s.doc.notText !== null && this.shown === s) {
        // text again: its changes can be saved there once more
        s.doc.notText = null
        this.setReadOnly(s, readOnlyNow(s.doc, this.sessionId, this.path))
        this.fileUi(s.doc)
      }
      return
    }
    if (s.kind === 'file' && s.view.state === s.doc.state && s.doc.policy.plain === policy.plain && s.doc.policy.folding === policy.folding && s.doc.lang?.id === lang?.id && s.doc.eol === t.eol && (s.doc.save !== null) === editableAtLoad(r, t)) {
      // the same document again: only what differs changes, kept out of the undo history (an undo never takes the
      // file's own text out)
      const doc = s.doc
      if (doc.save?.landed(stamp, Text.of(lines), facts, s.view.state.doc) === 'drop') return
      Object.assign(doc, { policy, encoding: t.encoding, invalid: t.invalid, size: r.size, link: r.link, longest: stats.longestLine })
      s.text = text
      const reload = reloadChanges(s.view.state.doc, lines)
      if (reload) this.applyReload(s.view, s.view.scrollDOM, reload)
      if (doc.save) {
        doc.save.adopt(s.view.state.doc, facts, s.view.state.doc)
        doc.unwritable = unwritableReason(r)
        this.setReadOnly(s, readOnlyNow(doc, this.sessionId, this.path))
      }
      const from = reload ? (doc.tokenised < 0 ? reload.firstLine : Math.min(reload.firstLine, doc.tokenised)) : doc.tokenised
      if (reload) doc.stoppedAt = null
      this.fileUi(doc)
      // a request still running for an unchanged text is left to finish; an edited document's colours follow its
      // changes by themselves
      if (!doc.colours && from >= 0 && doc.stoppedAt === null && (reload || !s.job)) this.tokenise(s, text, from)
      if (reload && this.ui.preview) this.renderPreview(text)
      return
    }
    // a document not shown yet (or one whose shape changed: another language, another size class)
    const kept = s.kind === 'file' ? this.capture(s.view, s.view.scrollDOM) : this.kept
    this.dropText()
    const store = lang ? new TokenStore() : null
    const editable = editableAtLoad(r, t)
    const doc: FileDocument = {
      state: null,
      store,
      policy,
      lang,
      eol: t.eol,
      encoding: t.encoding,
      invalid: t.invalid,
      size: r.size,
      link: r.link,
      changes: null,
      longest: stats.longestLine,
      tokenised: lang ? 0 : -1,
      stoppedAt: null,
      bytes: r.size,
      save: editable ? new DocSave(Text.of(lines), facts) : null,
      readOnly: null,
      unwritable: unwritableReason(r),
      notText: null,
      pendingDisk: null,
      closing: false,
      colours: null,
    }
    // an editable document's colours follow its changes (a read-only one's moment too: a merge changes its text)
    if (editable && store && lang) doc.colours = new EditTokens({ doc: this.key, lang: lang.id, store, budgetMs: policy.budgetMs, onTokens: () => (doc.tokenised = store.lines) })
    doc.readOnly = editable ? readOnlyNow(doc, this.sessionId, this.path) : null
    const edit = doc.save && doc.readOnly === null ? editingFor(doc, Text.of(lines)) : null
    const state = fileState({ path: this.path, lines, eol: t.eol, policy, store, wrap: wrapFor(lang?.id, wrapFlags, policy.wrap), changes: null, edit }, kept, this.pendingGoto)
    this.kept = kept
    this.showFileDocument(doc, state, text, false)
  }

  /** Put a file's document on screen: the text first, then where the tab was, then the colours. */
  private showFileDocument(doc: FileDocument, state: EditorState, text: string | null, cached: boolean): void {
    const host = this.host.editor()
    if (!host) return
    const view = showFile(host, state, this.hooks)
    doc.state = view.state
    const s: Shown = { kind: 'file', view, doc, text, job: null }
    this.shown = s
    const wrapped = wrapFor(doc.lang?.id, wrapFlags, doc.policy.wrap)
    if (wrapped !== view.lineWrapping) setWrap(view, wrapped)
    doc.state = view.state
    // a document kept while hidden may have become read-only or editable since (the registry's caps, its set-aside)
    if (doc.save) this.setReadOnly(s, readOnlyNow(doc, this.sessionId, this.path))
    const goto = this.pendingGoto
    if (goto) {
      this.pendingGoto = null
      if (cached) goTo(view, goto)
      else reveal(view, view.state.selection.main.head)
    } else if (this.kept.scroll) restoreScroll(view, this.kept.scroll)
    doc.state = view.state
    this.fileUi(doc)
    if (doc.colours) doc.colours.show(view)
    else if (text !== null && doc.tokenised >= 0) this.tokenise(s, text, doc.tokenised)
    else if (text === null && doc.tokenised >= 0 && doc.store && doc.store.lines === 0) this.tokenise(s, view.state.doc.toString(), 0)
    if (otherView.has(this.key) && this.ui.canPreview) this.setPreview(true)
    // the file's text that came while the document was hidden (a save's answer) is merged now
    const pending = doc.pendingDisk
    if (pending) {
      doc.pendingDisk = null
      this.mergePending(s, pending)
    }
    this.landed()
    if (goto) this.save()
  }

  /** The document is editable (`why` null) or read-only for `why`: its compartment follows. */
  private setReadOnly(s: Extract<Shown, { kind: 'file' }>, why: string | null): void {
    const doc = s.doc
    const was = s.view.state.readOnly
    doc.readOnly = why
    const now = why !== null || doc.save === null
    if (was !== now) {
      setEditable(s.view, now ? null : editingFor(doc, s.view.state.doc))
      doc.state = s.view.state
    }
  }

  private fileUi(doc: FileDocument): void {
    const notices: string[] = []
    if (doc.policy.plain) notices.push('Large file · shown as plain text')
    if (doc.stoppedAt !== null) notices.push(`Highlighting stopped at line ${doc.stoppedAt}`)
    if (doc.lang && doc.longest > L.viewerTokenLineMax) notices.push(`Lines over ${L.viewerTokenLineMax.toLocaleString('en-US')} characters are not highlighted`)
    if (doc.invalid) notices.push(doc.encoding === 'utf8' ? 'Not valid UTF-8 · some characters are replaced' : 'Not valid UTF-16 · some characters are replaced')
    const gone = doc.unwritable === DELETED
    if (gone) notices.push('Deleted')
    const markdown = isMarkdown(doc.lang?.id)
    const svg = imageExtension(this.path) === 'svg'
    const cur = this.ui
    const editable = doc.save !== null && doc.readOnly === null
    this.ui = {
      ...cur,
      ...this.gitFacts(),
      body: cur.preview && cur.body.kind === 'preview' ? cur.body : { kind: 'text' },
      language: doc.lang?.name ?? 'Plain Text',
      encoding: encodingNote(doc.encoding, doc.eol),
      link: doc.link,
      notices,
      deleted: doc.save?.deleted === true || gone,
      size: doc.size,
      wrap: wrapFor(doc.lang?.id, wrapFlags, doc.policy.wrap),
      canWrap: doc.policy.wrap,
      canPreview: markdown && doc.policy.preview,
      canSource: svg,
      source: svg,
      changes: this.shown.kind === 'file' ? changedRegions(this.shown.view.state).length : 0,
      editable,
      readOnly: editable ? null : (doc.readOnly ?? readOnlyAtLoad(doc)),
      unsaved: hasUnsaved(doc),
      editNotice: this.shown.kind === 'file' ? editNoticeOf(doc, this.shown.view.state, this.path) : null,
    }
    commands.changed()
  }

  private gotChanges(c: LineChanges): void {
    const s = this.shown
    if (s.kind !== 'file') return
    s.doc.changes = c
    s.view.dispatch({ effects: setLineChanges.of(c) })
    s.doc.state = s.view.state
    const n = changedRegions(s.view.state).length
    if (n !== this.ui.changes) {
      this.ui = { ...this.ui, changes: n }
      commands.changed()
    }
  }

  /** Ask the worker for the document's tokens from line `from`; they are drawn as they arrive. */
  private tokenise(s: Extract<Shown, { kind: 'file' }>, text: string, from: number): void {
    const doc = s.doc
    if (!doc.lang || !doc.store) return
    s.job?.cancel()
    const store = doc.store
    const gen = this.gen
    doc.tokenised = from
    s.job = tokenizeInto({
      doc: this.key,
      lang: doc.lang.id,
      text,
      from,
      budgetMs: doc.policy.budgetMs,
      store,
      onTokens: () => {
        if (gen !== this.gen || this.shown !== s) return
        doc.tokenised = store.lines
        s.view.dispatch({ effects: tokensArrived.of(null) })
        doc.state = s.view.state
      },
      onDone: (r) => {
        if (gen !== this.gen || this.shown !== s) return
        s.job = null
        doc.tokenised = r.stoppedAt === null && !r.failed ? -1 : doc.tokenised
        if (r.failed) doc.tokenised = -1
        if (r.stoppedAt !== null) {
          doc.stoppedAt = r.stoppedAt
          this.fileUi(doc)
        }
      },
    })
  }

  /**
   * Apply a reload, keeping the first visible line where it is, and open folds whose block changed. The file's text is
   * never an undo step: an undo never takes out what the agent wrote, and history is cleared where it would.
   */
  private applyReload(view: EditorView, scroller: HTMLElement, reload: NonNullable<ReturnType<typeof reloadChanges>>): void {
    const changes = view.state.changes(reload.changes)
    this.anchored(view, scroller, changes, () => applyFromDisk(view, { changes }))
  }

  /** Make a change from disk keeping the first visible line where it is; folds over replaced lines open. */
  private anchored(view: EditorView, scroller: HTMLElement, changes: ChangeSet | null, apply: () => void): void {
    const at = scrollOf(view, scroller)
    const anchor = (changes ?? view.state.changes([])).mapPos(view.state.doc.line(Math.min(at.line, view.state.doc.lines)).from, 1)
    apply()
    const stale = staleFoldEffects(view.state)
    if (stale.length > 0) view.dispatch({ effects: stale })
    restoreScroll(view, { line: view.state.doc.lineAt(Math.min(anchor, view.state.doc.length)).number, offset: at.offset, left: at.left }, scroller)
  }

  // ── editing ─────────────────────────────────────────────────────────────────────────────────────

  /** The document on screen is `doc`. */
  showing(doc: FileDocument): boolean {
    return this.shown.kind === 'file' && this.shown.doc === doc
  }

  /** `doc` is under Compare on screen. */
  comparing(doc: FileDocument): boolean {
    return this.shown.kind === 'compare' && this.shown.doc === doc
  }

  /** The file on screen stopped being text its unsaved changes can be saved to: they stay, read-only, saying what it is now. */
  private notTextAnyMore(s: Extract<Shown, { kind: 'file' }>, what: string): void {
    s.job?.cancel()
    s.doc.notText = what
    this.setReadOnly(s, readOnlyNow(s.doc, this.sessionId, this.path))
    this.fileUi(s.doc)
  }

  /**
   * The file's text merged into the document on screen, which has unsaved text: what only the file changed comes in,
   * places both changed differently are marked, and the document's `base` becomes the file's text. While an input
   * method composes, it waits; `again`: a save met the file's text, and is made again once it is merged.
   */
  private mergeDisk(s: Extract<Shown, { kind: 'file' }>, disk: Text, facts: SaveFacts, text: string | null, again = false): void {
    const { view, doc } = s
    const save = doc.save
    if (!save) return
    if (view.compositionStarted) {
      doc.pendingDisk = { text: disk, facts, again: again || (doc.pendingDisk?.again ?? false) }
      return
    }
    const r = merge({ base: save.base, doc: view.state.doc, disk, marks: marksOf(view.state, save.base) })
    this.anchored(view, view.scrollDOM, r.changes, () => applyFromDisk(view, { changes: r.changes ?? [], effects: [setMarks.of(r.marks)], agreed: r.agreed }))
    save.adopt(disk, facts, view.state.doc)
    // the file's own ending and encoding from now on (only they may have changed); copy and cut follow the ending
    const ending = doc.eol !== facts.eol
    doc.eol = facts.eol
    doc.encoding = facts.encoding
    if (ending) setFileLineEnding(view, facts.eol)
    doc.state = view.state
    if (this.shown === s && r.changes && !doc.colours && doc.tokenised >= 0) {
      let first = view.state.doc.lines
      r.changes.iterChangedRanges((_fa, _ta, fromB) => {
        first = Math.min(first, view.state.doc.lineAt(fromB).number - 1)
      })
      this.tokenise(s, text ?? view.state.doc.toString(), Math.min(first, doc.tokenised < 0 ? first : doc.tokenised))
    }
    if (r.changes && this.ui.preview) this.renderPreview(view.state.doc.toString())
    trackUnsaved(this.sessionId, this.path, doc)
    this.fileUi(doc)
  }

  /** What waited to be merged; a save that met it is made again once nothing is marked. */
  private mergePending(s: Extract<Shown, { kind: 'file' }>, pending: NonNullable<FileDocument['pendingDisk']>): void {
    this.mergeDisk(s, pending.text, pending.facts, null, pending.again)
    if (!pending.again || this.shown !== s || s.doc.pendingDisk || marksOf(s.view.state).length > 0) return
    s.doc.state = s.view.state
    void saveDocument(this.sessionId, this.path, s.doc, true)
  }

  /**
   * A save met the file changed, with its text: merged into the document on screen. While an input method composes the
   * merge waits, and the save is made again once it has been merged.
   */
  mergeFromSave(disk: Text, facts: SaveFacts): void {
    const s = this.shown
    if (s.kind === 'file') this.mergeDisk(s, disk, facts, null, true)
  }

  /** Read the file again now (after a save: the follow-up read naming the new version). */
  reread(): void {
    void this.load(this.gen, { file: true, git: false })
  }

  /** The document's save state changed (its dot, its notice, the commands); under Compare, Compare's line. */
  saveStateChanged(): void {
    const s = this.shown
    if (s.kind === 'compare') {
      this.compareNotice()
      return
    }
    if (s.kind !== 'file') return
    if (s.doc.save) this.setReadOnly(s, readOnlyNow(s.doc, this.sessionId, this.path))
    this.fileUi(s.doc)
  }

  /** Save the file on screen (⌘S, the notice's Save and Try Again). With places marked it saves nothing and shows them. */
  saveFile(): Promise<void> {
    const s = this.shown
    if (s.kind !== 'file' || !s.doc.save || s.doc.closing || s.doc.notText !== null) return Promise.resolve()
    if (marksOf(s.view.state).length > 0) {
      this.host.focusNotice?.()
      return Promise.resolve()
    }
    if (s.view.compositionStarted) {
      this.saveAfterComposing = true
      return Promise.resolve()
    }
    s.doc.state = s.view.state
    return saveDocument(this.sessionId, this.path, s.doc)
  }

  /**
   * The Edit menu's Undo or Redo, when the file document has the keyboard: its steps are CodeMirror's, which the
   * browser's own undo does not know. False when the keyboard is elsewhere.
   */
  historyStep(step: 'undo' | 'redo'): boolean {
    const s = this.shown
    if (s.kind !== 'file' || !s.view.hasFocus) return false
    if (step === 'undo') undo(s.view)
    else redo(s.view)
    return true
  }

  /** The document on screen can be edited. */
  editable(): boolean {
    return this.shown.kind === 'file' && this.ui.body.kind === 'text' && this.ui.editable
  }

  /** The document on screen has text that is not on disk. */
  unsaved(): boolean {
    return this.shown.kind === 'file' && hasUnsaved(this.shown.doc)
  }

  /** Indent Less / More (`⌘[` / `⌘]` in an editable file). */
  indent(dir: 1 | -1): void {
    const view = this.textView()
    if (view && this.editable()) (dir === 1 ? indentMore : indentLess)(view)
  }

  /** The find bar with its replace row (an editable file only). */
  replace(): void {
    const view = this.textView()
    if (view && this.editable()) openReplaceBar(view)
  }

  /** The notice's actions. */
  noticeAction(a: NoticeAction): void {
    const s = this.shown
    if (s.kind !== 'file' && s.kind !== 'compare') return
    const doc = s.doc
    // a document set aside, or in a window that is going, keeps its marks as they are
    const closing = doc.closing || windowGoing()
    switch (a) {
      case 'compare':
        this.compare()
        break
      case 'useFile':
        if (closing) break
        if (s.kind === 'compare') this.endCompare()
        if (this.shown.kind === 'file' && doc.save) useTheFiles(this.shown.view, doc.save.base)
        break
      case 'keepMine':
        if (closing) break
        if (s.kind === 'compare') this.endCompare()
        if (this.shown.kind === 'file') keepYours(this.shown.view)
        break
      case 'retry':
      case 'save':
        void this.saveFile()
        break
      case 'copyAll':
        if (doc.state) void copyText(saveText(doc.state.doc, doc.eol))
        break
      case 'dontSave':
        this.discardText()
        break
      case 'show':
        showOldestUnsaved(this.sessionId, this.path)
        break
    }
    if (this.shown.kind === 'file') {
      doc.state = this.shown.view.state
      trackUnsaved(this.sessionId, this.path, doc)
      this.fileUi(doc)
    }
  }

  /** Don't Save for the document on screen: its text goes, and the file is read again as it is. */
  discardText(): void {
    if (this.shown.kind === 'compare') this.endCompare()
    const s = this.shown
    if (s.kind !== 'file') return
    dropUnsaved(this.sessionId, this.path)
    const kept = this.capture(s.view, s.view.scrollDOM)
    s.doc.save = null
    this.dropText()
    this.kept = kept
    this.ui = { ...this.ui, body: { kind: 'loading' }, unsaved: false, editNotice: null }
    void this.load(this.gen, { file: true, git: true })
  }

  /** Compare: the file's text against the document, in the diff instance, read-only. Esc returns. */
  private compare(): void {
    const s = this.shown
    const host = this.host.editor()
    if (s.kind !== 'file' || !s.doc.save || !host) return
    const base = s.doc.save.base
    const back = this.capture(s.view, s.view.scrollDOM)
    // read before the file view is emptied: the one editor shows nothing once hidden
    const lines = s.view.state.doc.toJSON()
    s.job?.cancel()
    s.doc.colours?.hide()
    this.park()
    hideFile()
    const doc = s.doc
    const diff = showDiff(host, layout, { path: this.path, oldLines: base.toJSON(), newLines: lines, oldEol: doc.eol, newEol: doc.eol, oldStore: null, newStore: null }, back, null, this.hooks)
    this.shown = { kind: 'compare', diff, doc, back }
    this.afterCompare = false
    // Compare's own line says what is on screen (`compareNotice`); the file's notices are not this view's
    this.ui = { ...this.ui, body: { kind: 'diff' }, changes: chunkCount(diff), notices: [] }
    this.compareNotice()
    this.focusDrawn()
  }

  /**
   * Compare's line: what it shows, whether the file has changed since, and the marked places' actions; "Closing…" with
   * none while the document is set aside or the window is going.
   */
  private compareNotice(): void {
    const s = this.shown
    if (s.kind !== 'compare') return
    const closing = s.doc.closing || windowGoing()
    const text = closing ? 'Closing…' : this.afterCompare ? 'Comparing with the file on disk, which has changed since · Esc returns' : 'Comparing with the file on disk · Esc returns'
    this.ui = { ...this.ui, editNotice: { text, actions: closing ? [] : ['useFile', 'keepMine'] } }
    commands.changed()
  }

  /** Leave Compare: the document again, where it was. */
  private endCompare(): void {
    const s = this.shown
    if (s.kind !== 'compare') return
    this.park()
    hideDiff()
    this.shown = { kind: 'none' }
    this.kept = s.back
    const state = s.doc.state
    if (state) this.showFileDocument(s.doc, state, null, true)
    if (this.afterCompare) {
      this.afterCompare = false
      void this.load(this.gen, { file: true, git: false })
    }
  }

  /** Esc the strip offers first: it leaves Compare. True when it was taken. */
  escape(): boolean {
    if (this.shown.kind !== 'compare') return false
    this.endCompare()
    return true
  }

  /**
   * Files moved (`map`; the unsaved registry has moved their documents already). The file on screen moved: the viewer
   * names it by its new path, so its document stays the same one. Another file moved onto the path on screen (its own
   * file gone): that file's unsaved document is the path's now, and is shown as a switch to its tab shows it, so typing
   * goes on in it and never replaces it.
   */
  moved(sessionId: string, map: (path: string) => string): void {
    if (sessionId !== this.sessionId) return
    const to = map(this.path)
    if (to !== this.path) {
      this.path = to
      this.key = docKey(sessionId, to)
    }
    const doc = this.mode === 'file' ? unsavedDoc(sessionId, this.path) : null
    const s = this.shown
    if (!doc?.state || ((s.kind === 'file' || s.kind === 'compare') && s.doc === doc)) return
    const head = doc.state.selection.main.head
    this.show(sessionId, { path: this.path, mode: 'file', pinned: true, view: captureView(doc.state, null), goto: null })
    // where its tab was scrolled is not known here: its cursor in view
    const now = this.shown
    if (now.kind === 'file' && now.doc === doc) reveal(now.view, head)
  }

  /** Set the document on screen, or under Compare, aside (Don't Save while an action runs) or put it back. */
  setClosing(closing: boolean): void {
    const s = this.shown
    if ((s.kind !== 'file' && s.kind !== 'compare') || !s.doc.save) return
    s.doc.closing = closing
    this.saveStateChanged()
  }

  // ── diff view ────────────────────────────────────────────────────────────────────────────────────

  private async loadDiff(gen: number): Promise<void> {
    const r = await call('viewer.diff', this.args())
    if (gen !== this.gen) return
    this.seen = { old: r.old.exists, new: r.new.exists, counts: null } // a text diff's lines are counted once it is on screen (`diffUi`)
    const base = { ...blank(this.path, 'diff'), ...this.gitFacts(), size: r.new.exists ? r.new.size : r.old.size }
    if (r.kind !== 'text') this.dropDiff()
    switch (r.kind) {
      case 'large':
        this.ui = { ...base, body: { kind: 'note', text: 'Large diff', actions: ['editor'] } }
        break
      case 'binary':
        this.ui = { ...base, body: { kind: 'note', text: `${fileType(this.path)} · ${r.old.exists ? sizeText(r.old.size) : 'not there'} → ${r.new.exists ? sizeText(r.new.size) : 'deleted'}`, actions: r.new.exists ? ['reveal'] : [] } }
        break
      case 'image': {
        const ext = imageExtension(r.origPath ?? this.path) ?? imageExtension(this.path) ?? ''
        this.ui = {
          ...base,
          body: { kind: 'images', old: r.old.exists && r.old.image ? dataUrl(r.old.image, ext) : null, new: r.new.exists && r.new.size <= L.imageMaxBytes ? keaFileUrl(`${this.cwd()}/${this.path}`, Math.trunc(r.mtimeMs)) : null },
          notices: [`${r.old.exists ? sizeText(r.old.size) : 'not there'} → ${r.new.exists ? sizeText(r.new.size) : 'deleted'}`],
        }
        break
      }
      default:
        this.gotDiff(r)
        return
    }
    this.landed()
  }

  private dropDiff(): void {
    const s = this.shown
    if (s.kind !== 'diff') return
    s.jobs.old?.cancel()
    s.jobs.new?.cancel()
    highlighter().forget(`${this.key}\nold`)
    highlighter().forget(`${this.key}\nnew`)
    this.shown = { kind: 'none' }
    this.park()
    hideDiff()
  }

  private gotDiff(r: DiffRead): void {
    const host = this.host.editor()
    if (!host) return
    const oldText = r.old.text ? decodeText(r.old.text) : ''
    const newText = r.new.text ? decodeText(r.new.text) : ''
    const oldLines = splitLines(oldText)
    const newLines = splitLines(newText)
    const s = this.shown
    if (s.kind === 'diff' && s.diff.layout === layout && originalOf(s.diff).eq(Text.of(oldLines))) {
      // the same old side: the new side's changes as a reload
      const reload = reloadChanges(s.diff.view.state.doc, newLines)
      s.read = r
      if (reload) {
        this.applyReload(s.diff.view, s.diff.scroller, reload)
        this.tokeniseDiff(s, 'new', newText, reload.firstLine)
      }
      this.diffUi(s)
      return
    }
    const kept = s.kind === 'diff' ? this.capture(s.diff.view, s.diff.scroller) : this.kept
    this.dropDiff()
    const oldLang = r.old.exists ? languageOf(r.origPath ?? this.path, oldLines[0]) : null
    const newLang = r.new.exists ? languageOf(this.path, newLines[0]) : null
    const oldStore = oldLang && layout === 'split' ? new TokenStore() : null
    const newStore = newLang ? new TokenStore() : null
    const diff = showDiff(host, layout, { path: this.path, oldLines, newLines, oldEol: r.old.text?.eol ?? 'lf', newEol: r.new.text?.eol ?? 'lf', oldStore, newStore }, kept, this.pendingGoto, this.hooks)
    const next: Shown = { kind: 'diff', diff, oldStore, newStore, jobs: { old: null, new: null }, read: r }
    this.shown = next
    const goto = this.pendingGoto
    this.pendingGoto = null
    if (goto) reveal(diff.view, diff.view.state.selection.main.head)
    else if (kept.scroll) restoreScroll(diff.view, kept.scroll, diff.scroller)
    this.kept = kept
    this.diffUi(next)
    if (newStore && newLang) this.tokeniseDiff(next, 'new', newText, 0, newLang.id)
    if (oldStore && oldLang) this.tokeniseDiff(next, 'old', oldText, 0, oldLang.id)
    this.landed()
    if (goto) this.save()
  }

  private diffUi(s: Extract<Shown, { kind: 'diff' }>): void {
    const r = s.read
    this.seen = { old: r.old.exists, new: r.new.exists, counts: diffCounts(s.diff) }
    const lang = r.new.exists ? languageOf(this.path) : languageOf(r.origPath ?? this.path)
    this.ui = {
      ...this.ui,
      ...this.gitFacts(),
      body: { kind: 'diff' },
      language: lang?.name ?? null,
      notices: [...(r.origPath ? [`Renamed from ${r.origPath}`] : !r.new.exists ? ['Deleted'] : r.base === null ? ['Nothing to compare against · shown as added'] : []), ...(isUnsaved(this.sessionId, this.path) ? ['Unsaved changes are not shown'] : [])],
      layout,
      changes: chunkCount(s.diff),
      size: r.new.exists ? r.new.size : r.old.size,
    }
    commands.changed()
  }

  private tokeniseDiff(s: Extract<Shown, { kind: 'diff' }>, side: 'old' | 'new', text: string, from: number, langId?: string): void {
    const store = side === 'old' ? s.oldStore : s.newStore
    const lang = langId ?? (side === 'new' ? languageOf(this.path, text.slice(0, text.indexOf('\n') >>> 0)) : null)?.id
    const view = side === 'old' ? s.diff.old : s.diff.view
    if (!store || !lang || !view) return
    const gen = this.gen
    const policy = viewPolicy({ bytes: text.length, lines: view.state.doc.lines, longestLine: 0 })
    if (policy.highlight === 'none') return
    s.jobs[side]?.cancel()
    const job = tokenizeInto({
      doc: `${this.key}\n${side}`,
      lang,
      text,
      from,
      budgetMs: policy.budgetMs,
      store,
      onTokens: () => {
        if (gen === this.gen && this.shown === s) view.dispatch({ effects: tokensArrived.of(null) })
      },
      onDone: () => {
        if (s.jobs[side] === job) s.jobs[side] = null
      },
    })
    s.jobs[side] = job
  }

  // ── one-line bodies ──────────────────────────────────────────────────────────────────────────────

  private note(text: string, actions: readonly NoteAction[]): void {
    this.dropText()
    this.dropDiff()
    this.ui = { ...blank(this.path, this.mode), ...this.gitFacts(), body: { kind: 'note', text, actions } }
    this.landed()
  }

  /** Something is on screen for the tab: a pending position that no editor could take is used up, and the commands follow. */
  private landed(): void {
    if (this.pendingGoto && !this.textView()) {
      this.pendingGoto = null
      this.save()
    }
    commands.changed()
    this.focusDrawn()
  }

  /** The tab's body: it is always drawn, so it can hold the keyboard while no editor can. */
  private bodyElement(): HTMLElement | null {
    return this.host.preview()?.parentElement ?? null
  }

  /** Before an editor that has the keyboard leaves the screen: the body takes it, so the tab keeps it (and its keys). */
  private park(): void {
    if (this.disposed || !this.host.focused()) return
    const body = this.bodyElement()
    if (body && document.activeElement !== body) body.focus()
  }

  /**
   * The keyboard goes to what the tab shows now, when the tab has it. An editor's place is hidden until the frame
   * has drawn the new body, and a hidden element cannot take the keyboard: the body holds it until then.
   */
  private focusDrawn(): void {
    if (!this.host.focused()) return
    this.focus()
    const gen = this.gen
    void tick().then(() => {
      if (gen === this.gen && !this.disposed && document.activeElement === this.bodyElement()) this.focus()
    })
  }

  // ── what the tab keeps ───────────────────────────────────────────────────────────────────────────

  private capture(view: EditorView, scroller: HTMLElement): TabViewState {
    return captureView(view.state, scrollOf(view, scroller))
  }

  private updated(u: ViewUpdate): void {
    const s = this.shown
    if (s.kind === 'file' && u.view === s.view) {
      s.doc.state = u.state
      s.doc.colours?.changed(u)
      if (u.docChanged && s.doc.save) this.typed(s, u)
      if (!u.view.compositionStarted && (this.saveAfterComposing || s.doc.pendingDisk)) {
        // what waited for an input method to finish runs once it has (never inside an update)
        queueMicrotask(() => {
          if (this.shown !== s || s.view.compositionStarted) return
          const pending = s.doc.pendingDisk
          s.doc.pendingDisk = null
          if (pending) this.mergePending(s, pending)
          if (this.saveAfterComposing) {
            this.saveAfterComposing = false
            void this.saveFile()
          }
        })
      }
    } else if (!((s.kind === 'diff' || s.kind === 'compare') && u.view === s.diff.view)) return
    if (u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)))) this.queueSave()
  }

  /** The user changed the document on screen: its save state and its tab (its colours follow by themselves). */
  private typed(s: Extract<Shown, { kind: 'file' }>, u: ViewUpdate): void {
    const doc = s.doc
    const save = doc.save
    if (!save || !u.transactions.some((tr) => tr.docChanged && !isFromDisk(tr))) return
    // as it was before this update (the document's state is already the new one)
    const was = save.unsaved || marksOf(u.startState).length > 0
    save.edited(u.state.doc)
    const now = hasUnsaved(doc)
    // a preview tab the user changes is pinned: a tab with unsaved changes is never a preview
    if (now && !was) queueMicrotask(() => commands.run('viewer.pinTab'))
    trackUnsaved(this.sessionId, this.path, doc)
    if (was !== now || this.ui.editNotice !== null) this.fileUi(doc)
  }

  /** Hand the strip the tab's state, once per turn of the event loop however much changed. */
  private queueSave(): void {
    if (this.saveQueued) return
    this.saveQueued = true
    const gen = this.gen
    queueMicrotask(() => {
      this.saveQueued = false
      if (gen === this.gen) this.save()
    })
  }

  private save(): void {
    const s = this.shown
    if (this.disposed) return
    if (s.kind === 'file') this.host.onview(this.capture(s.view, s.view.scrollDOM))
    else if (s.kind === 'diff') this.host.onview(this.capture(s.diff.view, s.diff.scroller))
    else if (s.kind === 'compare') this.host.onview(s.back)
    else this.host.onview(this.kept)
  }

  // ── what the commands do ─────────────────────────────────────────────────────────────────────────

  get session(): string {
    return this.sessionId
  }

  /** The editor that has the document's text: the file view's, or the diff's new side. Null under a preview, an image, a note. */
  textView(): EditorView | null {
    const s = this.shown
    if (s.kind === 'file') return this.ui.body.kind === 'text' ? s.view : null
    return s.kind === 'diff' || s.kind === 'compare' ? s.diff.view : null
  }

  focus(): void {
    const view = this.textView()
    if (view) {
      view.focus()
      if (view.hasFocus) return
    }
    // an image, a preview, a note (or an editor whose place is not drawn yet): the body takes the keyboard, so the
    // tab's keys still arrive
    this.bodyElement()?.focus()
  }

  /** The line a switch or an editor should land on: the cursor's when it is on screen, else the middle of the view. */
  position(): TabPosition | null {
    const view = this.textView()
    if (!view) return null
    const head = view.state.selection.main.head
    for (const r of view.visibleRanges) if (head >= r.from && head <= r.to) return positionOf(view.state.doc, head)
    const first = view.visibleRanges[0]
    const last = view.visibleRanges[view.visibleRanges.length - 1]
    return first && last ? { line: view.state.doc.lineAt((first.from + last.to) >> 1).number, col: 1 } : positionOf(view.state.doc, head)
  }

  /** `path:start-end` for the selected lines (the new side's, in a diff). */
  reference(): string | null {
    const view = this.textView()
    return view ? reference(this.path, selectedLines(view.state)) : null
  }

  find(): void {
    const view = this.textView()
    if (view) openFindBar(view)
  }

  goToLine(): void {
    const view = this.textView()
    if (view) openGotoBar(view)
  }

  toggleWrap(): void {
    const s = this.shown
    if (s.kind !== 'file' || !s.doc.policy.wrap) return
    // the kind on screen flips; a file of the other kind keeps its own
    wrapFlags = toggledWrap(s.doc.lang?.id, wrapFlags)
    const on = wrapFor(s.doc.lang?.id, wrapFlags, true)
    setWrap(s.view, on)
    this.ui = { ...this.ui, wrap: on }
    commands.changed()
  }

  /** The next or previous changed region (file view) or hunk (diff); around the ends. */
  stepChange(dir: 1 | -1): void {
    const s = this.shown
    if (s.kind === 'diff' || s.kind === 'compare') {
      if (!goToChunk(s.diff, dir) && chunkCount(s.diff) > 0) {
        // around the end: from the other one
        const doc = s.diff.view.state.doc
        s.diff.view.dispatch({ selection: EditorSelection.cursor(dir === 1 ? 0 : doc.length) })
        goToChunk(s.diff, dir)
      }
      return
    }
    if (s.kind !== 'file' || this.ui.body.kind !== 'text') return
    const regions = changedRegions(s.view.state)
    if (regions.length === 0) return
    const line = s.view.state.doc.lineAt(s.view.state.selection.main.head).number
    const next = dir === 1 ? (regions.find((r) => r.from > line) ?? regions[0]) : ([...regions].reverse().find((r) => r.to < line) ?? regions[regions.length - 1])
    if (next) goTo(s.view, { line: next.from, col: 1 })
  }

  toggleLayout(): void {
    layout = layout === 'unified' ? 'split' : 'unified'
    this.ui = { ...this.ui, layout }
    const s = this.shown
    if (s.kind === 'diff') {
      // the same diff in the other layout, at the same place
      const kept = this.capture(s.diff.view, s.diff.scroller)
      const r = s.read
      this.dropDiff()
      this.kept = kept
      this.gotDiff(r)
    }
    commands.changed()
  }

  /** Markdown: the preview or the source. An SVG: its source or the image. */
  toggleOther(): void {
    if (this.ui.canPreview) {
      this.setPreview(!this.ui.preview)
      return
    }
    if (!this.ui.canSource && imageExtension(this.path) !== 'svg') return
    if (otherView.has(this.key)) otherView.delete(this.key)
    else otherView.add(this.key)
    this.dropText()
    this.ui = { ...this.ui, body: { kind: 'loading' } }
    void this.load(this.gen, { file: true, git: false })
  }

  private setPreview(on: boolean): void {
    const s = this.shown
    if (s.kind !== 'file' || !this.ui.canPreview) return
    this.stopPreview?.()
    this.stopPreview = null
    if (!on) {
      otherView.delete(this.key)
      this.ui = { ...this.ui, preview: false, body: { kind: 'text' } }
      commands.changed()
      this.focusDrawn()
      return
    }
    otherView.add(this.key)
    this.ui = { ...this.ui, preview: true, body: { kind: 'preview' } }
    this.renderPreview(s.view.state.doc.toString())
    commands.changed()
    this.focusDrawn()
  }

  private renderPreview(source: string): void {
    const host = this.host.preview()
    if (!host) return
    this.stopPreview?.()
    const sessionId = this.sessionId
    this.stopPreview = showPreview(host, source, { cwd: this.cwd(), path: this.path }, { openFile: (path) => void commands.run('viewer.open', { sessionId, path, mode: 'file' }) })
  }

  /** What the find bar is looking for (probes). */
  query(): string {
    const view = this.textView()
    return view ? getSearchQuery(view.state).search : ''
  }
}
