// The main area's tabs, as pure functions.
//
// A tab is a terminal (its ptyId; kinds agent, script, server, shell) or a file or diff view of one path (its id is
// `file:<path>`, never a ptyId's shape). The strip shows the terminals in their order, then the file tabs in the order
// they were opened; `⌘⇧]` / `⌘⇧[` step through that whole order.
//
// Terminals: a shell opened with ⌘T becomes active once core's `terminals` store lists it — the store's update can
// arrive before or after the `terminal.openShell` reply, and until it does the tab does not exist. Otherwise the active
// tab stays while it exists, and falls back to the last terminal. A pane that has shown no tab yet starts on the tab
// its session remembers (`TabMemory`, kept with the session so that it outlives the window), else on its Agent
// terminal.
//
// File tabs (a session has one per path, and a tab shows its path as a file or as a diff):
//   · an open without `pin` shows the path in the preview tab — the one unpinned tab, which the next such open
//     replaces in place; a path that already has a tab shows that tab
//   · pinning (a double-click, ↵, an open with `pin`) keeps it; at most L.viewerPinnedTabsMax are pinned, and pinning
//     one more closes the least recently viewed pinned tab
//   · a file tab that closes (Esc, ⌘W, a middle click, that cap) hands the pane back to the Agent terminal; in the
//     split, whose work pane has no Agent tab, to the tab before it (`afterClose`)
//   · a hidden tab keeps only `{path, mode, scroll, selection, folds}` (`features/viewer/tab.ts`)

import { L, type PtyKind, type ViewMode } from '@kea/protocol'
import { EMPTY_VIEW, type TabPosition, type TabViewState, type ViewerTab } from '../features/viewer/tab.ts'

/** What a tab is: a terminal by its PTY's kind, or a file or diff view. */
export type TabKind = PtyKind | ViewMode

export interface ActiveTab {
  active: string | null
  /** A shell just opened, waiting to appear in the list. */
  wanted: string | null
}

/**
 * `start`: where a pane that has shown no tab yet begins (`startTab`). With none named (the plain shells), and for a
 * tab that goes while it is the active one, the last terminal takes over.
 */
export function pickActive(tabs: readonly string[], cur: ActiveTab, start: string | null = null): ActiveTab {
  if (cur.wanted && tabs.includes(cur.wanted)) return { active: cur.wanted, wanted: null }
  if (cur.active && tabs.includes(cur.active)) return cur
  const first = cur.active === null && start !== null && tabs.includes(start) ? start : null
  return { active: first ?? tabs.at(-1) ?? null, wanted: cur.wanted }
}

// ── what a session remembers of its tabs ───────────────────────────────────────────────────────────

/**
 * The tab a session showed last, as the session itself remembers it (saved with its panel state, so a window closed and
 * reopened, a reload and a restart of Kea all find it). The Server and Setup tabs are named by their kind: a session
 * has one of each, and a re-run's Server tab is a new PTY. A shell is named by its PTY. Nothing is remembered for the
 * Agent terminal, which is where a session starts anyway, nor for a file or diff tab, which is the window's and goes
 * with it. `split` says it was chosen in the work pane of the split: one column does not restore it, so a shell picked
 * beside the agent never hides the agent in a narrow window.
 */
export type TabMemory = ({ kind: 'server' | 'script' } | { kind: 'shell'; ptyId: string }) & { split?: true }

/** What the session remembers while `active` is its tab on screen; null: nothing (its Agent terminal, a file tab, no tab). */
export function rememberTab(active: string | null, kindOf: (id: string) => PtyKind | undefined, split = false): TabMemory | null {
  if (active === null || isFileTabId(active)) return null
  const kind = kindOf(active)
  const mode = split ? { split: true as const } : {}
  if (kind === 'shell') return { kind, ptyId: active, ...mode }
  return kind === 'server' || kind === 'script' ? { kind, ...mode } : null
}

export function sameTabMemory(a: TabMemory | null, b: TabMemory | null): boolean {
  if (a === null || b === null) return a === b
  return a.kind === b.kind && a.split === b.split && (a.kind !== 'shell' || (b.kind === 'shell' && a.ptyId === b.ptyId))
}

/** The value of the `tabs` key of a session's saved panel state (`sessions.setUi`): null removes the key. */
export function savedTabs(m: TabMemory | null): { active: TabMemory } | null {
  return m ? { active: m } : null
}

/** The `tabs` key as read back (`sessions.getUi`); anything that is not a memory reads as nothing remembered. */
export function parseTabMemory(v: unknown): TabMemory | null {
  const a = v !== null && typeof v === 'object' ? (v as { active?: unknown }).active : null
  if (a === null || typeof a !== 'object') return null
  const { kind, ptyId, split } = a as { kind?: unknown; ptyId?: unknown; split?: unknown }
  // a memory saved before the split has no mode: one column's
  const mode = split === true ? { split: true as const } : {}
  if (kind === 'server' || kind === 'script') return { kind, ...mode }
  return kind === 'shell' && typeof ptyId === 'string' && ptyId !== '' ? { kind, ptyId, ...mode } : null
}

/**
 * Where a session's pane starts when the window has not shown the session before: the tab it remembers while that tab
 * still exists, else `home`, its Agent terminal (in the split, no tab). One column restores only a tab chosen in one
 * column; the split's work pane restores either.
 */
export function startTab(terminals: readonly string[], kindOf: (id: string) => PtyKind | undefined, m: TabMemory | null, home: string | null, split = false): string | null {
  if (m === null || (m.split && !split)) return home
  if (m.kind === 'shell') return terminals.includes(m.ptyId) && kindOf(m.ptyId) === 'shell' ? m.ptyId : home
  return terminals.find((id) => kindOf(id) === m.kind) ?? home
}

// ── file tabs ──────────────────────────────────────────────────────────────────────────────────────

const FILE_TAB = 'file:'

export function fileTabId(path: string): string {
  return FILE_TAB + path
}

export function isFileTabId(id: string | null): id is string {
  return id !== null && id.startsWith(FILE_TAB)
}

export interface FileTab extends ViewerTab {
  id: string
  /** When it was last shown, as a value of `FileTabs.seq`: the least recently viewed pinned tab is the first to go. */
  seen: number
}

/** A session's file tabs in the order they were opened, and the count that orders their viewing. */
export interface FileTabs {
  readonly tabs: readonly FileTab[]
  readonly seq: number
}

export const NO_FILE_TABS: FileTabs = { tabs: [], seq: 0 }

/** The part of `viewer.open`'s request that concerns the tabs. */
export interface OpenFile {
  path: string
  mode: ViewMode
  line?: number | undefined
  col?: number | undefined
  pin?: boolean | undefined
}

/** A tab's title in the strip: the file's name (its whole path is the tab's tooltip). */
export function fileTabTitle(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** At most `max` pinned: the least recently viewed pinned tabs go, never `keep`. */
function capPinned(tabs: readonly FileTab[], keep: string, max: number): readonly FileTab[] {
  let out = tabs
  for (;;) {
    const pinned = out.filter((t) => t.pinned)
    if (pinned.length <= max) return out
    const oldest = pinned.filter((t) => t.id !== keep).reduce<FileTab | null>((a, t) => (a === null || t.seen < a.seen ? t : a), null)
    if (!oldest) return out
    out = out.filter((t) => t !== oldest)
  }
}

/**
 * Show `o.path` in a tab and say which. A path that has a tab keeps it (pinned stays pinned; `o.mode` becomes its mode,
 * which starts its view afresh); otherwise the preview tab is replaced in place, or a tab is added. The tab is the most
 * recently viewed. `o.line` is where to land.
 */
export function openFileTab(s: FileTabs, o: OpenFile, maxPinned: number = L.viewerPinnedTabsMax): { tabs: FileTabs; id: string } {
  const id = fileTabId(o.path)
  const seq = s.seq + 1
  const goto: TabPosition | null = o.line !== undefined ? { line: o.line, col: o.col ?? 1 } : null
  const had = s.tabs.find((t) => t.id === id)
  let tabs: readonly FileTab[]
  if (had) {
    const flipped = had.mode !== o.mode
    const next: FileTab = { ...had, mode: o.mode, pinned: had.pinned || o.pin === true, seen: seq, view: flipped ? EMPTY_VIEW : had.view, goto: goto ?? (flipped ? null : had.goto) }
    tabs = s.tabs.map((t) => (t === had ? next : t))
  } else {
    const fresh: FileTab = { id, path: o.path, mode: o.mode, pinned: o.pin === true, seen: seq, view: EMPTY_VIEW, goto }
    const preview = fresh.pinned ? -1 : s.tabs.findIndex((t) => !t.pinned)
    tabs = preview < 0 ? [...s.tabs, fresh] : s.tabs.map((t, i) => (i === preview ? fresh : t))
  }
  return { tabs: { tabs: capPinned(tabs, id, maxPinned), seq }, id }
}

/** The tab is on screen: it is the most recently viewed. */
export function viewFileTab(s: FileTabs, id: string): FileTabs {
  if (!s.tabs.some((t) => t.id === id)) return s
  const seq = s.seq + 1
  return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, seen: seq } : t)), seq }
}

/** Pin the preview tab (double-click, ↵). One pinned tab too many closes the least recently viewed other one. */
export function pinFileTab(s: FileTabs, id: string, maxPinned: number = L.viewerPinnedTabsMax): FileTabs {
  const t = s.tabs.find((x) => x.id === id)
  if (!t || t.pinned) return s
  return { tabs: capPinned(s.tabs.map((x) => (x === t ? { ...x, pinned: true } : x)), id, maxPinned), seq: s.seq }
}

export function closeFileTab(s: FileTabs, id: string): FileTabs {
  if (!s.tabs.some((t) => t.id === id)) return s
  return { tabs: s.tabs.filter((t) => t.id !== id), seq: s.seq }
}

/** The viewer's state of the tab, kept while it is hidden: the newest `maxFolds` folds; the landing position is used up. */
export function saveFileTabView(s: FileTabs, id: string, view: TabViewState, maxFolds: number = L.viewerTabFoldsMax): FileTabs {
  if (!s.tabs.some((t) => t.id === id)) return s
  const kept: TabViewState = { scroll: view.scroll, selection: view.selection, folds: view.folds.length > maxFolds ? view.folds.slice(-maxFolds) : view.folds }
  return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, view: kept, goto: null } : t)), seq: s.seq }
}

// ── the strip ──────────────────────────────────────────────────────────────────────────────────────

/** The strip's order: the terminals, then the file tabs. `⌘⇧]` / `⌘⇧[` step through it, around the ends. */
export function stripOrder(terminals: readonly string[], files: FileTabs): string[] {
  return [...terminals, ...files.tabs.map((t) => t.id)]
}

/**
 * The tab that takes over in the split's work pane when `id` closes while it is shown: the tab before it in the strip,
 * else the one after it, else none (the work pane's empty state).
 */
export function afterClose(strip: readonly string[], id: string): string | null {
  const i = strip.indexOf(id)
  if (i < 0) return null
  return strip[i - 1] ?? strip[i + 1] ?? null
}

/**
 * The tab the split's work pane shows once the one it showed, `gone`, has left its strip (a shell closed or exited): the
 * nearest tab before it in the strip it left (`before`, terminals then files) that is still there, else the nearest
 * after it; null when none is (the empty state), or when `gone` was not in that strip.
 */
export function afterGone(before: readonly string[], gone: string, now: readonly string[]): string | null {
  const i = before.indexOf(gone)
  if (i < 0) return null
  for (let j = i - 1; j >= 0; j--) if (now.includes(before[j]!)) return before[j]!
  for (let j = i + 1; j < before.length; j++) if (now.includes(before[j]!)) return before[j]!
  return null
}

/** The terminals of the split's work pane: every one but the Agent terminal, which the agent pane shows, in order. */
export function workTabs(terminals: readonly string[], kindOf: (id: string) => PtyKind | undefined): string[] {
  return terminals.filter((id) => kindOf(id) !== 'agent')
}

/**
 * The tab the work pane shows as the split is drawn: the one-column tab unless it is the Agent terminal; else the tab
 * the work pane showed when last split, while it exists; else its last terminal; else none (its last file tab, or its
 * empty state, by the pick).
 */
export function tabToSplit(active: string | null, agent: string | null, back: string | undefined, exists: (id: string) => boolean, work: readonly string[]): string | null {
  if (active !== null && active !== agent) return active
  return back !== undefined && exists(back) ? back : (work.at(-1) ?? null)
}

/**
 * The tab one column shows as the split goes: the work pane's when it had the keyboard (`workHad`); otherwise (the
 * agent pane had it, or nothing did) the Agent terminal, so a narrowed window never hides the agent that was being typed to.
 */
export function tabToColumn(active: string | null, agent: string | null, workHad: boolean): string | null {
  return workHad || agent === null ? active : agent
}

/** Where a closed file tab leaves the pane: the Agent terminal; a session without one, its first tab. */
export function homeTab(terminals: readonly string[], kindOf: (id: string) => PtyKind | undefined): string | null {
  return terminals.find((id) => kindOf(id) === 'agent') ?? terminals[0] ?? null
}

/**
 * `pickActive` for the whole strip. A shell just opened still takes the active tab once it is listed (C-RACE-7), also
 * from a file tab; an active file tab stays while it exists and hands over to `home` when it goes; a terminal that goes
 * falls back to the last terminal, never to a file tab. A pane that has shown no tab yet begins at `start` (`startTab`:
 * the Agent terminal unless the session remembers another tab), never at whichever is last.
 */
export function pickActiveTab(terminals: readonly string[], files: readonly string[], cur: ActiveTab, home: string | null, start: string | null = home): ActiveTab {
  if (cur.wanted && terminals.includes(cur.wanted)) return { active: cur.wanted, wanted: null }
  if (isFileTabId(cur.active)) return files.includes(cur.active) ? cur : { active: home, wanted: cur.wanted }
  return pickActive(terminals, cur, start)
}
