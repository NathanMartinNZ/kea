// The file panel's data for the session on screen, outside rune state: the window's copies of `tree:<sessionId>` and
// `git:<sessionId>`, which folders are open, the tree's flat rows, the folder roll-up, the Changes list, and the
// panel's own state (selection, scroll, mode) kept per session through `files.saveUi`. One session at a time: the
// stores exist in core only while the session is shown, so moving to another session lets go of everything here before
// the next one is followed, and a window showing no session holds nothing.
//
// The views read it through `panel` (state.svelte.ts): one counter in rune state that moves once per frame in which
// anything here changed. Nothing here is a rune.
//
//   follow(sessionId)   visible.set → subscribe both stores → `files.open` (the expanded folders and the panel state
//                       core kept). Nothing is drawn until that call has answered, so the first rows are the
//                       session's own, at its scroll position (P-FT-1).
//   a store delta       marks the rows stale; they are flattened again (rows.ts) when next read, once per frame.
//   expand              asks core for the folder, and follows a chain of single-child folders so it becomes one
//                       compact row `a/b/c` (rows.ts `compactChild`).

import { changesOrder, gitEntry, gitHead, L, treeDir, treeHead, type DiffScope, type GitEntry, type GitHead, type GitRow, type TreeHead, type TreeRow } from '@kea/protocol'
import { nextFrame } from '../../lib/frameStore.ts'
import { call } from '../../lib/rpc.ts'
import { followSessionStore } from '../sessions/visible.ts'
import { ancestors, classOf, Rollup, type StatusClass } from './rollup.ts'
import { NO_UI, parsePanelUi, type PanelMode, type PanelUi } from './panelUi.ts'
import { compactChild, flattenTree, type FlatRow } from './rows.ts'

const EMPTY_TREE: ReadonlyMap<string, TreeRow> = new Map()
const EMPTY_GIT: ReadonlyMap<string, GitRow> = new Map()
const NO_ROWS: readonly FlatRow[] = []
const NO_CHANGES: readonly GitEntry[] = []

/** A row's decoration: a changed file's letter, or a folder's strongest change below it. */
export interface Decoration {
  cls: StatusClass
  /** A file's status letter; null for a folder (it shows a dot). */
  letter: string | null
}

export class FilesModel {
  sessionId: string | null = null
  /** `files.open` has answered for `sessionId`: the expansion and the panel state are the session's. */
  opened = false
  ui: PanelUi = NO_UI
  /** Bumped by `reveal`: the tree should take the keyboard and bring `ui.files.sel` into view. */
  revealed = 0
  /** When the last `tree:` or `git:` snapshot or delta arrived (`performance.now()`); the perf probes read it (resources.ts). */
  deltaAt = 0

  private tree: ReadonlyMap<string, TreeRow> = EMPTY_TREE
  private git: ReadonlyMap<string, GitRow> = EMPTY_GIT
  // bounded: the folders open in the session on screen (core caps what it persists: L.sessionUiMaxBytes); emptied on a
  // switch, as every collection of this class is
  private readonly expanded = new Set<string>()
  // bounded: one per expand in flight (a folder the user opened whose single-child chain is being followed)
  private readonly chase = new Set<string>()
  // bounded: one per `files.expand` in flight
  private readonly asked = new Set<string>()
  private readonly rollup = new Rollup()
  // bounded: the tree's rows, their compact chains and labels (≤ L.dirCacheEntriesMax per session); rebuilt with them
  private rowsCache: readonly FlatRow[] | null = null
  private indexCache: Map<string, number> | null = null
  private labelsCache: string[] | null = null
  // bounded: the changed paths of the session on screen (≤ L.gitStatusEntriesMax); rebuilt with the status
  private changesCache: readonly GitEntry[] | null = null
  private changeIndexCache: Map<string, number> | null = null
  /** Files opened lately in this session, most recent first (the finder's recency boost). */
  recent: string[] = [] // bounded: L.finderRecentMax; emptied on a switch
  /** A path to select once its row exists (`reveal`). */
  private wanted: string | null = null
  private snapshots = 0
  private offs: (() => void)[] = [] // bounded: the two stores followed (`tree:`, `git:`), emptied on a switch
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private queued = false
  // bounded: the panel's bridge to rune state, and the resource report (one each)
  private readonly listeners = new Set<() => void>()
  /** Moves with every change the views could show. */
  version = 0

  // ── following a session ───────────────────────────────────────────────────────────────────────

  /** Follow `id`'s stores (null: none). Whatever was held of another session is gone when this returns. */
  follow(id: string | null): void {
    if (id === this.sessionId) return
    this.flushSave()
    for (const off of this.offs.splice(0)) off()
    this.sessionId = id
    this.opened = false
    this.ui = NO_UI
    this.tree = EMPTY_TREE
    this.git = EMPTY_GIT
    this.expanded.clear()
    this.chase.clear()
    this.asked.clear()
    this.rollup.clear()
    this.wanted = null
    this.recent = []
    this.snapshots = 0
    this.stale()
    if (id !== null) {
      this.offs.push(
        followSessionStore<TreeRow>('tree', id, (data, changed) => this.onTree(id, data, changed)),
        followSessionStore<GitRow>('git', id, (data, changed) => this.onGit(id, data, changed)),
      )
      this.open(id)
    }
    // at once, not at the next frame: no row of the session left behind stays on screen
    this.emitNow()
  }

  private open(id: string): void {
    call('files.open', { sessionId: id }).then(
      (r) => {
        if (this.sessionId !== id) return
        this.expanded.clear()
        for (const p of r.expanded) if (p !== '') this.expanded.add(p)
        // the first answer for this session; a later one (core restarted) leaves the panel's state as it is now
        if (!this.opened) this.ui = parsePanelUi(r.ui)
        this.opened = true
        this.stale()
        this.emit()
      },
      () => {
        if (this.sessionId !== id || this.opened) return
        // core does not show the session (yet): the folders it sent are the open ones
        for (const k of this.tree.keys()) if (k.startsWith('/') && k.length > 1) this.expanded.add(k.slice(1))
        this.opened = true
        this.stale()
        this.emit()
      },
    )
  }

  private onTree(id: string, data: ReadonlyMap<string, TreeRow>, changed: readonly string[] | null): void {
    if (this.sessionId !== id) return
    this.deltaAt = performance.now()
    this.tree = data
    // a snapshot after the first: core restarted and reads the folders again when the panel opens the tree
    if (changed === null && this.snapshots++ > 0) this.open(id)
    this.followChains()
    this.stale()
    this.emit()
  }

  private onGit(id: string, data: ReadonlyMap<string, GitRow>, changed: readonly string[] | null): void {
    if (this.sessionId !== id) return
    this.deltaAt = performance.now()
    this.git = data
    if (changed === null) {
      this.rollup.clear()
      this.rollup.apply(changesOrder(data), [])
    } else {
      const set: GitEntry[] = []
      const del: string[] = []
      for (const k of changed) {
        if (!k.startsWith('/')) continue
        const e = data.get(k) as GitEntry | undefined
        if (e) set.push(e)
        else del.push(k.slice(1))
      }
      // a path whose letter changed class is taken out and put back
      this.rollup.apply(set, del)
    }
    this.changesCache = null
    this.changeIndexCache = null
    this.emit()
  }

  // ── what the views read ───────────────────────────────────────────────────────────────────────

  get treeHead(): TreeHead | null {
    return treeHead(this.tree)
  }

  get gitHead(): GitHead | null {
    return gitHead(this.git)
  }

  /** False only once core has said the folder is not a git work tree: no decorations, no Changes tab. */
  get isGit(): boolean {
    return this.treeHead?.git !== false
  }

  /** The tree, top to bottom. Empty until `files.open` has answered. */
  get rows(): readonly FlatRow[] {
    if (this.rowsCache) return this.rowsCache
    if (!this.opened) return NO_ROWS
    const rows = flattenTree(this.tree, this.expanded, { compact: true, showIgnored: this.ui.showIgnored })
    this.rowsCache = rows
    this.indexCache = null
    this.labelsCache = null
    return rows
  }

  /** What each row shows (type-ahead matches against it). */
  get labels(): readonly string[] {
    return (this.labelsCache ??= this.rows.map((r) => r.label))
  }

  /** The row that shows `path`: its own, or the compact row whose chain it is part of. -1: none. */
  rowIndex(path: string | null): number {
    if (path === null) return -1
    if (!this.indexCache) {
      const m = new Map<string, number>()
      const rows = this.rows
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] as FlatRow
        m.set(r.path, i)
        for (const c of r.chain) m.set(c, i)
      }
      this.indexCache = m
    }
    return this.indexCache.get(path) ?? -1
  }

  /** The Changes list, in its one order (`changesOrder`: conflicts first, then by path). */
  get changes(): readonly GitEntry[] {
    if (this.sessionId === null) return NO_CHANGES
    return (this.changesCache ??= changesOrder(this.git))
  }

  changeIndex(path: string | null): number {
    if (path === null) return -1
    if (!this.changeIndexCache) this.changeIndexCache = new Map(this.changes.map((e, i) => [e.path, i]))
    return this.changeIndexCache.get(path) ?? -1
  }

  entry(path: string): GitEntry | null {
    return gitEntry(this.git, path)
  }

  /** How a tree row is decorated; null for an unchanged file and a folder with no change below it. */
  decoration(row: FlatRow): Decoration | null {
    if (row.kind === 'dir') {
      // a compact row stands for every folder of its chain: the outermost one's changes are all of them
      const cls = this.rollup.folder(row.chain[0] ?? row.path)
      return cls ? { cls, letter: null } : null
    }
    const e = this.entry(row.path)
    return e ? { cls: classOf(e.code), letter: e.submodule ? 'S' : e.code } : null
  }

  /** The count behind `Changes n`; null for none. */
  get changeCount(): number | null {
    const n = this.changes.length
    return n > 0 ? n : null
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path)
  }

  // ── what the views do ─────────────────────────────────────────────────────────────────────────

  /** Open a folder: its entries are asked of core, and a chain of single-child folders below it is followed. */
  expand(path: string): void {
    const id = this.sessionId
    if (id === null || path === '') return
    this.expanded.add(path)
    this.chase.add(path)
    this.ask(id, path)
    this.followChains()
    this.stale()
    this.emitNow()
  }

  /** Close a folder and every folder under it. */
  collapse(path: string): void {
    const id = this.sessionId
    if (id === null) return
    const prefix = `${path}/`
    for (const p of [...this.expanded]) if (p === path || p.startsWith(prefix)) this.expanded.delete(p)
    for (const p of [...this.chase]) if (p === path || p.startsWith(prefix)) this.chase.delete(p)
    void call('files.collapse', { sessionId: id, path }).catch(() => undefined)
    // the keyboard stays on the row: a row that was under the folder gives way to the folder itself
    const sel = this.ui.files.sel
    if (sel !== null && sel.startsWith(prefix)) this.ui = { ...this.ui, files: { ...this.ui.files, sel: path } }
    this.stale()
    this.emitNow()
    this.saveSoon()
  }

  /** A long folder's "Show all (n)" row: core is asked for all its entries. */
  showAll(dir: string): void {
    const id = this.sessionId
    if (id !== null) void call('files.showAll', { sessionId: id, path: dir }).catch(() => undefined)
  }

  private ask(id: string, path: string): void {
    if (this.asked.has(path)) return
    this.asked.add(path)
    call('files.expand', { sessionId: id, path }).then(
      (r) => {
        this.asked.delete(path)
        if (this.sessionId !== id || r.ok) return
        // not a folder (any more): it is not open
        this.expanded.delete(path)
        this.chase.delete(path)
        this.stale()
        this.emit()
      },
      () => void this.asked.delete(path),
    )
  }

  /** A folder the user opened that holds nothing but one folder: that one is opened too, and so on down. */
  private followChains(): void {
    const id = this.sessionId
    if (id === null || this.chase.size === 0) return
    const o = { compact: true, showIgnored: this.ui.showIgnored }
    for (const dir of [...this.chase]) {
      if (!treeDir(this.tree, dir)) continue // not here yet
      this.chase.delete(dir)
      const next = compactChild(this.tree, dir, o)
      if (next === null || this.expanded.has(next)) continue
      this.expanded.add(next)
      this.chase.add(next)
      this.ask(id, next)
    }
  }

  /**
   * After the rows were read for a frame: a folder that is open but whose entries core no longer holds (its directory
   * cache dropped them) is asked for again; a row waiting to be selected (`reveal`) is, once it exists.
   */
  settle(): void {
    const id = this.sessionId
    if (id === null || !this.opened) return
    for (const r of this.rows) if (r.loading && !this.asked.has(r.path)) this.ask(id, r.path)
    if (this.wanted !== null && this.rowIndex(this.wanted) >= 0) {
      const path = this.wanted
      this.wanted = null
      this.select('files', path)
      this.revealed++
      this.emit()
    }
  }

  /** Back from the viewer (`files.revealInTree`): open every folder above `path` and put the keyboard on its row. */
  reveal(path: string): void {
    const id = this.sessionId
    if (id === null) return
    for (const dir of ancestors(path).reverse()) {
      if (dir === '' || this.expanded.has(dir)) continue
      this.expanded.add(dir)
      this.ask(id, dir)
    }
    this.wanted = path
    this.stale()
    this.emit()
  }

  /** The keyboard is on `path` in the tree or the list (null: on no row). */
  select(list: PanelMode, path: string | null): void {
    if (this.ui[list].sel === path) return
    this.ui = { ...this.ui, [list]: { ...this.ui[list], sel: path } }
    this.emitNow()
    this.saveSoon()
  }

  /** A list was scrolled (saved, not announced: the view already shows it). */
  scrolled(list: PanelMode, top: number): void {
    const at = Math.max(0, Math.round(top))
    if (this.ui[list].top === at) return
    this.ui = { ...this.ui, [list]: { ...this.ui[list], top: at } }
    this.saveSoon()
  }

  /** Files or Changes, kept per session. */
  setMode(mode: PanelMode): void {
    if (this.sessionId === null || this.ui.mode === mode) return
    this.ui = { ...this.ui, mode }
    this.saveSoon()
  }

  /** The fsmonitor hint was closed: it is not offered again for this session. */
  closeHint(): void {
    if (this.sessionId === null || this.ui.hintClosed) return
    this.ui = { ...this.ui, hintClosed: true }
    this.emitNow()
    this.saveSoon()
  }

  /** A file or diff of this session came on screen in the main area: it leads the finder's empty query. */
  noteOpened(path: string): void {
    if (this.recent[0] === path) return
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, L.finderRecentMax)
  }

  toggleIgnored(): void {
    if (this.sessionId === null) return
    this.ui = { ...this.ui, showIgnored: !this.ui.showIgnored }
    this.stale()
    this.emitNow()
    this.saveSoon()
  }

  setScope(scope: DiffScope): void {
    const id = this.sessionId
    if (id !== null) void call('files.setScope', { sessionId: id, scope }).catch(() => undefined)
  }

  refresh(): void {
    const id = this.sessionId
    if (id !== null) void call('files.refresh', { sessionId: id }).catch(() => undefined)
  }

  // ── keeping the panel's state (per session) ───────────────────────────────────────────────────

  private saveSoon(): void {
    if (!this.opened || this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, L.panelSaveMs)
  }

  /** Now, when a save is waiting (the session is being left: core still takes it, `files.saveUi`). */
  flushSave(): void {
    if (this.saveTimer === null) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.save()
  }

  private save(): void {
    const id = this.sessionId
    if (id === null || !this.opened) return
    const { mode, showIgnored, hintClosed, files, changes } = this.ui
    void call('files.saveUi', { sessionId: id, ui: { ...(mode ? { mode } : {}), ...(showIgnored ? { showIgnored } : {}), ...(hintClosed ? { hintClosed } : {}), files, changes } }).catch(() => undefined)
  }

  // ── change notification ───────────────────────────────────────────────────────────────────────

  private stale(): void {
    this.rowsCache = null
    this.indexCache = null
    this.labelsCache = null
    this.changesCache = null
    this.changeIndexCache = null
  }

  /** Once per frame, however many deltas arrived in it. */
  private emit(): void {
    if (this.queued) return
    this.queued = true
    nextFrame(() => {
      if (!this.queued) return
      this.emitNow()
    })
  }

  private emitNow(): void {
    this.queued = false
    this.version++
    for (const l of [...this.listeners]) l()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** The resource report's rows (`renderer.filePanel`). */
  get counts(): { stores: number; treeDirs: number; rows: number; gitEntries: number; expanded: number; listeners: number; timers: number } {
    return {
      stores: this.offs.length,
      treeDirs: Math.max(0, this.tree.size - (this.treeHead ? 1 : 0)),
      rows: this.rowsCache?.length ?? 0,
      gitEntries: Math.max(0, this.git.size - (this.gitHead ? 1 : 0)),
      expanded: this.expanded.size,
      listeners: this.listeners.size,
      timers: this.saveTimer === null ? 0 : 1,
    }
  }
}

/** The window's file panel data. */
export const filesModel = new FilesModel()
