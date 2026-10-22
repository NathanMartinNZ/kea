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
//   leave     the tab is hidden: its request is cancelled, a file's document goes to the cache, the editors hold
//             nothing. The tab's own state (scroll, selection, folds) was handed to the strip as it changed (`onview`).
//
// A restarted core ends the follow with `closed`: it is asked for again on the new port, and the tab is read
// again as after any change.

import { tick } from 'svelte'
import { getSearchQuery } from '@codemirror/search'
import { EditorSelection, type EditorState } from '@codemirror/state'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import { foldEffect, unfoldEffect } from '@codemirror/language'
import { changesOrder, gitEntry, gitHead, imageExtension, keaFileUrl, RpcError, type DiffRead, type FileRead, type GitCode, type GitEntry, type GitHead, type GitRow, type LineChanges, type LineEnding, type TextBytes, type ViewMode } from '@kea/protocol'
import { call } from '../../lib/rpc.ts'
import { commands } from '../commands/registry.ts'
import { diffHeader, type LineCounts } from '../files/changes.ts'
import { sessions } from '../sessions/state.svelte.ts'
import { followSessionStore } from '../sessions/visible.ts'
import { goTo, openFindBar, openGotoBar } from './bars.ts'
import type { HighlightHandle } from './client.ts'
import { decodeText, encodingNote, splitLines } from './decode.ts'
import { DocCache } from './docCache.ts'
import { fileState, hideFile, restoreScroll, reveal, scrollOf, setEditorHooks, setWrap, showFile, type EditorHooks } from './editor.ts'
import { staleFoldEffects } from './folding.ts'
import { changedRegions, setLineChanges } from './gutter.ts'
import { tokensArrived } from './highlight.ts'
import { highlighter, tokenizeInto } from './highlighter.ts'
import { languageOf, type Language } from './language.ts'
import { chunkCount, diffCounts, goToChunk, hideDiff, originalOf, showDiff, type DiffLayout, type ShownDiff } from './merge.ts'
import { textStats, viewPolicy, type ViewPolicy } from './policy.ts'
import { showPreview } from './preview.ts'
import { fromDisk } from './readonly.ts'
import { reference, selectedLines } from './reference.ts'
import { reloadChanges } from './reload.ts'
import type { TabPosition, TabViewState, ViewerTab } from './tab.ts'
import { TokenStore } from './tokens.ts'
import { captureView, positionOf } from './viewState.ts'
import { L } from '@kea/protocol/limits'
import { Text } from '@codemirror/state'

// ── what the component draws ───────────────────────────────────────────────────────────────────────

export type NoteAction = 'editor' | 'default' | 'reveal'

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
}

function blank(path: string, mode: ViewMode): ViewerUi {
  return { body: { kind: 'loading' }, path, mode, language: null, encoding: null, link: null, notices: [], deleted: false, entry: null, letter: null, counts: null, size: null, wrap: wrapOn, canWrap: false, canPreview: false, preview: false, canSource: false, source: false, layout, changes: 0 }
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

/** What the cache keeps of a file's document. */
interface FileDocument {
  state: EditorState | null
  store: TokenStore | null
  policy: ViewPolicy
  lang: Language | null
  eol: LineEnding
  encoding: TextBytes['encoding']
  invalid: boolean
  size: number
  link: string | null
  changes: LineChanges | null
  /** The longest line, in characters (a line over L.viewerTokenLineMax is not tokenised). */
  longest: number
  /** Lines tokenised so far; -1: all of them. */
  tokenised: number
  stoppedAt: number | null
  bytes: number
}

const cache = new DocCache<FileDocument>({
  maxDocs: L.viewerDocCache,
  maxBytes: L.viewerDocCacheBytes,
  onDrop: (key) => highlighter().forget(key),
})
// bounded: one per file tab of the session on screen showing its other view (a Markdown preview, an SVG's source):
// at most 1 + L.viewerPinnedTabsMax, cleared with the session
const otherView = new Set<string>()
let cacheSession: string | null = null
let wrapOn = false
let layout: DiffLayout = 'unified'
let current: ViewerController | null = null
let visible = 0
let reads = 0
let follows = 0

const docKey = (sessionId: string, path: string) => `${sessionId}\n${path}`

/** The session on screen changed (or the cache's session is no longer shown): no document of another session is kept. */
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
 * a pinned tab closed by a pin over L.viewerPinnedTabsMax — not its document, nor which of its two views it showed.
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

export interface ViewerHost {
  /** Where the editors go. */
  editor(): HTMLElement | null
  /** Where the Markdown preview goes. */
  preview(): HTMLElement | null
  /** The viewer has the keyboard (so a document that arrives takes it). */
  focused(): boolean
  onview(view: TabViewState): void
}

type Shown =
  | { kind: 'none' }
  | { kind: 'file'; view: EditorView; doc: FileDocument; text: string | null; job: HighlightHandle | null }
  | { kind: 'diff'; diff: ShownDiff; oldStore: TokenStore | null; newStore: TokenStore | null; jobs: { old: HighlightHandle | null; new: HighlightHandle | null }; read: DiffRead }

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
  private git: ReadonlyMap<string, GitRow> = new Map()
  private offGit: (() => void) | null = null
  private gitSession: string | null = null
  private stopPreview: (() => void) | null = null
  private saveQueued = false
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
      const cached = cache.take(this.key)
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
    this.stopPreview?.()
    this.stopPreview = null
    const s = this.shown
    this.shown = { kind: 'none' }
    if (s.kind === 'file') {
      s.job?.cancel()
      // The most recently viewed documents stay for an instant flip back (`doc.state` is the editor's state as
      // of its last update; the editor itself may already show another mount's document). A deleted file's, one of a
      // session that is no longer the one on screen, and one whose tab is gone (there is nothing to flip back to)
      // are not kept
      const doc = s.doc
      doc.bytes = doc.size + (doc.store?.bytes ?? 0)
      const { sessionId, path, key } = this
      const deleted = this.ui.deleted
      const settle = (): void => {
        if (!deleted && cacheSession === sessionId && hasTab(sessionId, path)) cache.put(key, doc)
        // (unless a mount shows that document again by now: its marks are that mount's)
        else if (current?.key !== key) highlighter().forget(key)
      }
      // a mount that is being taken down still reads the strip's tabs as they were before the change that takes it
      // down (Svelte runs teardowns with the old state), so its own tab would always seem to be there: ask afterwards
      if (this.disposed) queueMicrotask(settle)
      else settle()
      if (current === this) {
        this.park()
        hideFile()
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
    // the gutter's lines are asked for at the same time, and arrive when they arrive
    const changes = call('viewer.changes', this.args()).then(
      (c) => {
        if (gen === this.gen) this.gotChanges(c)
      },
      () => undefined,
    )
    if (what.file) {
      const r = await call('viewer.read', { ...this.args(), ...(source ? { source: true } : {}) })
      if (gen !== this.gen) return
      this.gotFile(r)
    }
    await changes
  }

  private gotFile(r: FileRead): void {
    const base = { ...blank(this.path, 'file'), ...this.gitFacts(), size: r.size, link: r.kind === 'outside' ? null : r.link, canSource: imageExtension(this.path) === 'svg', source: otherView.has(this.key) && imageExtension(this.path) === 'svg' }
    if (r.kind === 'text' && r.text) {
      this.gotText(r, r.text)
      return
    }
    if (r.kind === 'missing' && this.shown.kind === 'file') {
      // Deleted while open — the last content stays, dimmed
      this.shown.job?.cancel()
      this.ui = { ...this.ui, deleted: true, notices: ['Deleted'] }
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
    this.shown = { kind: 'none' }
    highlighter().forget(this.key)
    this.park()
    hideFile()
  }

  private gotText(r: FileRead, t: TextBytes): void {
    const text = decodeText(t)
    const lines = splitLines(text)
    const stats = textStats(r.size, lines)
    const policy = viewPolicy(stats)
    const lang = policy.highlight === 'none' ? null : languageOf(this.path, lines[0])
    const s = this.shown
    if (s.kind === 'file' && s.view.state === s.doc.state && s.doc.policy.plain === policy.plain && s.doc.policy.folding === policy.folding && s.doc.lang?.id === lang?.id && s.doc.eol === t.eol) {
      // the same document again: only what differs changes
      const doc = s.doc
      Object.assign(doc, { policy, encoding: t.encoding, invalid: t.invalid, size: r.size, link: r.link, longest: stats.longestLine })
      s.text = text
      const reload = reloadChanges(s.view.state.doc, lines)
      if (reload) this.applyReload(s.view, s.view.scrollDOM, reload)
      const from = reload ? (doc.tokenised < 0 ? reload.firstLine : Math.min(reload.firstLine, doc.tokenised)) : doc.tokenised
      if (reload) doc.stoppedAt = null
      this.fileUi(doc)
      // a request still running for an unchanged text is left to finish
      if (from >= 0 && doc.stoppedAt === null && (reload || !s.job)) this.tokenise(s, text, from)
      if (reload && this.ui.preview) this.renderPreview(text)
      return
    }
    // a document not shown yet (or one whose shape changed: another language, another size class)
    const kept = s.kind === 'file' ? this.capture(s.view, s.view.scrollDOM) : this.kept
    this.dropText()
    const store = lang ? new TokenStore() : null
    const doc: FileDocument = { state: null, store, policy, lang, eol: t.eol, encoding: t.encoding, invalid: t.invalid, size: r.size, link: r.link, changes: null, longest: stats.longestLine, tokenised: lang ? 0 : -1, stoppedAt: null, bytes: r.size }
    const state = fileState({ path: this.path, lines, eol: t.eol, policy, store, wrap: wrapOn, changes: null }, kept, this.pendingGoto)
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
    if (wrapOn !== view.lineWrapping) setWrap(view, wrapOn && doc.policy.wrap)
    doc.state = view.state
    const goto = this.pendingGoto
    if (goto) {
      this.pendingGoto = null
      if (cached) goTo(view, goto)
      else reveal(view, view.state.selection.main.head)
    } else if (this.kept.scroll) restoreScroll(view, this.kept.scroll)
    doc.state = view.state
    this.fileUi(doc)
    if (text !== null && doc.tokenised >= 0) this.tokenise(s, text, doc.tokenised)
    if (otherView.has(this.key) && this.ui.canPreview) this.setPreview(true)
    this.landed()
    if (goto) this.save()
  }

  private fileUi(doc: FileDocument): void {
    const notices: string[] = []
    if (doc.policy.plain) notices.push('Large file · shown as plain text')
    if (doc.stoppedAt !== null) notices.push(`Highlighting stopped at line ${doc.stoppedAt}`)
    if (doc.lang && doc.longest > L.viewerTokenLineMax) notices.push(`Lines over ${L.viewerTokenLineMax.toLocaleString('en-US')} characters are not highlighted`)
    if (doc.invalid) notices.push(doc.encoding === 'utf8' ? 'Not valid UTF-8 · some characters are replaced' : 'Not valid UTF-16 · some characters are replaced')
    const markdown = doc.lang?.id === 'markdown' || doc.lang?.id === 'mdx'
    const svg = imageExtension(this.path) === 'svg'
    const cur = this.ui
    this.ui = {
      ...cur,
      ...this.gitFacts(),
      body: cur.preview && cur.body.kind === 'preview' ? cur.body : { kind: 'text' },
      language: doc.lang?.name ?? 'Plain Text',
      encoding: encodingNote(doc.encoding, doc.eol),
      link: doc.link,
      notices,
      deleted: false,
      size: doc.size,
      wrap: wrapOn && doc.policy.wrap,
      canWrap: doc.policy.wrap,
      canPreview: markdown && doc.policy.preview,
      canSource: svg,
      source: svg,
      changes: this.shown.kind === 'file' ? changedRegions(this.shown.view.state).length : 0,
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

  /** Apply a reload, keeping the first visible line where it is, and open folds whose block changed. */
  private applyReload(view: EditorView, scroller: HTMLElement, reload: NonNullable<ReturnType<typeof reloadChanges>>): void {
    const at = scrollOf(view, scroller)
    const changes = view.state.changes(reload.changes)
    const anchor = changes.mapPos(view.state.doc.line(Math.min(at.line, view.state.doc.lines)).from, 1)
    view.dispatch({ changes, annotations: fromDisk.of(true) })
    const stale = staleFoldEffects(view.state)
    if (stale.length > 0) view.dispatch({ effects: stale })
    restoreScroll(view, { line: view.state.doc.lineAt(anchor).number, offset: at.offset, left: at.left }, scroller)
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
      notices: r.origPath ? [`Renamed from ${r.origPath}`] : !r.new.exists ? ['Deleted'] : r.base === null ? ['Nothing to compare against · shown as added'] : [],
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
    if (s.kind === 'file' && u.view === s.view) s.doc.state = u.state
    else if (!(s.kind === 'diff' && u.view === s.diff.view)) return
    if (u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)))) this.queueSave()
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
    return s.kind === 'diff' ? s.diff.view : null
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
    wrapOn = !wrapOn
    setWrap(s.view, wrapOn)
    this.ui = { ...this.ui, wrap: wrapOn }
    commands.changed()
  }

  /** The next or previous changed region (file view) or hunk (diff); around the ends. */
  stepChange(dir: 1 | -1): void {
    const s = this.shown
    if (s.kind === 'diff') {
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
