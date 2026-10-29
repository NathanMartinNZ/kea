// The window's three columns: sidebar, file panel and main, as data. Widths are what the person chose, clamped to each
// column's range; what is drawn also keeps the main column at least `main-min` wide (the file panel gives way first,
// then the sidebar, never below their minimums), and the file panel collapses by itself below `tree-autocollapse` and
// comes back when the window is widened. Hiding is separate from width, so a hidden column comes back at its width.
// Double-click on a divider resets that column; arrows move it by one grid step.
//
// On a session the main column can hold two panes side by side (the split): the work pane (terminals and files) and the
// agent pane. It is drawn while the person keeps the agent beside (`agentBeside`) and the main column holds both panes
// at their minimums, which are columns of the terminal font (`cellWidth`, measured for the saved font settings).
//
// The sidebar's minimum holds the header's controls: on macOS the traffic lights and the new-session button. Where the
// window's own buttons sit on the left of a Linux title bar (the Window Controls Overlay), the minimum grows to hold
// them and the header's two buttons (`sidebarFloor`); the layout functions take that floor as an argument.
//
// Persisted per window as JSON in the window's local storage, so the first frame is laid out before core answers;
// window bounds are main's (window-state.json). Every size is a token.

import { L } from '@kea/protocol'
import { SIZE_PX, SPACE_PX } from '@kea/ui/tokens'

export type Column = 'sidebar' | 'tree'

/** The file panel's mode: Files or Changes. */
export type PanelMode = 'files' | 'changes'

export interface Layout {
  sidebarWidth: number
  treeWidth: number
  /** Toggle Sidebar, `⌘B`. */
  sidebarHidden: boolean
  /** `⌘⇧E` pressed again with the panel focused, or Toggle File Panel. */
  treeHidden: boolean
  panelMode: PanelMode
  /** The agent beside the work pane on a session, where the window is wide enough (the View menu's toggle). */
  agentBeside: boolean
  /** The agent pane's width once its divider was dragged, px; null: `agent_first_share` of the main column. */
  agentWidth: number | null
  /** A terminal cell's width at the saved font settings, as last measured; null before the first measurement. */
  cellWidth: number | null
}

export const RANGE: Readonly<Record<Column, { min: number; max: number; default: number }>> = {
  sidebar: { min: SIZE_PX['sidebar-min'], max: SIZE_PX['sidebar-max'], default: SIZE_PX.sidebar },
  tree: { min: SIZE_PX['tree-min'], max: SIZE_PX['tree-max'], default: SIZE_PX.tree },
}

/** One keyboard step on a divider: one unit of the spacing grid (`--space-1`). */
export const STEP = SPACE_PX[0]

export const DEFAULT_LAYOUT: Layout = { sidebarWidth: RANGE.sidebar.default, treeWidth: RANGE.tree.default, sidebarHidden: false, treeHidden: false, panelMode: 'files', agentBeside: true, agentWidth: null, cellWidth: null }

/**
 * The sidebar's minimum where the window controls take `overlayLeft` px at the left of the title bar: the controls,
 * then the header's two buttons (the menu button and New Session), each in its cluster, with the header's gaps and the
 * column's border; never below the token. 0 (controls on the right, or none): the token.
 */
export function sidebarFloor(overlayLeft: number): number {
  if (!(overlayLeft > 0)) return RANGE.sidebar.min
  const cluster = SIZE_PX.row + 2 * SPACE_PX[1]
  return Math.max(RANGE.sidebar.min, Math.ceil(overlayLeft + 2 * cluster + 2 * SPACE_PX[0] + SIZE_PX.hairline))
}

/** The sidebar divider's range at a floor (`sidebarFloor`). */
export function sidebarRange(floor: number): { min: number; max: number } {
  return { min: Math.max(RANGE.sidebar.min, floor), max: RANGE.sidebar.max }
}

/** A sidebar drawn this wide is compact: its rows drop their secondary text (`sidebar-compact`). 0: hidden. */
export function sidebarCompactAt(width: number): boolean {
  return width > 0 && width < SIZE_PX['sidebar-compact']
}

/** A column's width within its range; the sidebar's minimum is `floor` (`sidebarFloor`), the token unless given. */
export function clampWidth(c: Column, w: number, floor: number = RANGE.sidebar.min): number {
  const r = RANGE[c]
  const min = c === 'sidebar' ? Math.max(r.min, floor) : r.min
  if (!Number.isFinite(w)) return Math.max(min, r.default)
  return Math.round(Math.min(Math.max(r.max, min), Math.max(min, w)))
}

const key = (c: Column): 'sidebarWidth' | 'treeWidth' => (c === 'sidebar' ? 'sidebarWidth' : 'treeWidth')

/** A stored layout, checked field by field: anything missing or wrong takes its default. */
export function parseLayout(raw: unknown): Layout {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, c: Column) => (typeof v === 'number' ? clampWidth(c, v) : RANGE[c].default)
  const bool = (v: unknown) => v === true
  const px = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  return {
    sidebarWidth: num(o.sidebarWidth, 'sidebar'),
    treeWidth: num(o.treeWidth, 'tree'),
    sidebarHidden: bool(o.sidebarHidden),
    treeHidden: bool(o.treeHidden),
    panelMode: o.panelMode === 'changes' ? 'changes' : 'files',
    agentBeside: typeof o.agentBeside === 'boolean' ? o.agentBeside : DEFAULT_LAYOUT.agentBeside,
    agentWidth: px(o.agentWidth) === null ? null : Math.round(px(o.agentWidth)!),
    cellWidth: px(o.cellWidth),
  }
}

export interface Drawn {
  /** 0 when hidden. */
  sidebar: number
  tree: number
  /** The file panel is collapsed because the window is narrow, not by choice. */
  treeAuto: boolean
}

/** What is drawn in a window `windowWidth` wide; `floor` is the sidebar's minimum (`sidebarFloor`). */
export function drawn(l: Layout, windowWidth: number, floor: number = RANGE.sidebar.min): Drawn {
  const treeAuto = !l.treeHidden && windowWidth < SIZE_PX['tree-autocollapse']
  const sidebarMin = Math.max(RANGE.sidebar.min, floor)
  let sidebar = l.sidebarHidden ? 0 : Math.max(sidebarMin, l.sidebarWidth)
  let tree = l.treeHidden || treeAuto ? 0 : l.treeWidth
  // the main column keeps main-min: the file panel gives way first, then the sidebar, down to their minimums
  let over = sidebar + tree + SIZE_PX['main-min'] - windowWidth
  if (over > 0 && tree > 0) {
    const give = Math.min(over, tree - RANGE.tree.min)
    tree -= give
    over -= give
  }
  if (over > 0 && sidebar > 0) sidebar -= Math.max(0, Math.min(over, sidebar - sidebarMin))
  return { sidebar, tree, treeAuto }
}

/** The main column's width as drawn. */
export function mainWidth(l: Layout, windowWidth: number, floor: number = RANGE.sidebar.min): number {
  const d = drawn(l, windowWidth, floor)
  return windowWidth - d.sidebar - d.tree
}

/**
 * A drag on a column's right divider: `from` is its drawn width when the drag began, `dx` the pointer's travel. It never
 * pushes the main column below `mainMin`: `main-min`, or the split's need while the split is drawn.
 */
export function dragTo(l: Layout, c: Column, from: number, dx: number, windowWidth: number, mainMin: number = SIZE_PX['main-min'], floor: number = RANGE.sidebar.min): Layout {
  const d = drawn(l, windowWidth, floor)
  const other = c === 'sidebar' ? d.tree : d.sidebar
  const room = windowWidth - Math.max(mainMin, SIZE_PX['main-min']) - other
  const w = clampWidth(c, Math.min(from + dx, Math.max(RANGE[c].min, room)), floor)
  return w === l[key(c)] ? l : { ...l, [key(c)]: w }
}

/** Double-click: the column's default width. */
export function resetWidth(l: Layout, c: Column): Layout {
  return l[key(c)] === RANGE[c].default ? l : { ...l, [key(c)]: RANGE[c].default }
}

/** Arrow keys on a focused divider: one grid step narrower (-1) or wider (1). */
export function stepWidth(l: Layout, c: Column, dir: -1 | 1, windowWidth: number, mainMin: number = SIZE_PX['main-min'], floor: number = RANGE.sidebar.min): Layout {
  return dragTo(l, c, drawn(l, windowWidth, floor)[c], dir * STEP, windowWidth, mainMin, floor)
}

export function toggleSidebar(l: Layout): Layout {
  return { ...l, sidebarHidden: !l.sidebarHidden }
}

export function setTreeHidden(l: Layout, hidden: boolean): Layout {
  return l.treeHidden === hidden ? l : { ...l, treeHidden: hidden }
}

export function setPanelMode(l: Layout, mode: PanelMode): Layout {
  return l.panelMode === mode ? l : { ...l, panelMode: mode }
}

// ── the split: the work pane and the agent pane side by side in the main column ──────────────────────────────

/** The panes' widths, px; the divider's 1 px line is inside the agent pane's. */
export interface Split {
  agent: number
  work: number
}

/** px for `cols` terminal columns of `cell` px: the terminal's padding, xterm's scrollbar track, and a border `line`. */
export function paneWidth(cols: number, cell: number, line = 0): number {
  return Math.ceil(cols * cell + 2 * SIZE_PX['terminal-pad-x'] + L.terminalScrollbarPx + line)
}

/** The columns a pane `width` px wide holds (the inverse of `paneWidth`). */
export function paneCols(width: number, cell: number, line = 0): number {
  return Math.max(0, Math.floor((width - 2 * SIZE_PX['terminal-pad-x'] - L.terminalScrollbarPx - line) / cell))
}

/** What the split needs of the main column: each pane at its minimum in columns, at the saved font's cell width. */
export function splitNeed(cell: number): { agent: number; work: number; total: number } {
  const agent = paneWidth(L.agentMinCols, cell, SIZE_PX.hairline)
  const work = paneWidth(L.workMinCols, cell)
  return { agent, work, total: agent + work }
}

/**
 * Whether the split is drawn in a main column `main` px wide: the person keeps the agent beside (`agentBeside`) and the
 * column holds the need. Drawn, it stays until the column falls below the need; one column becomes the split only at
 * the need plus `split-hysteresis`, so a live drag of the window's edge does not flap. A window's first frame (`was`
 * null) has no band. While a divider is dragged the mode does not change: it is decided on release.
 */
export function splitOn(l: Layout, main: number, cell: number, was: boolean | null, resizing: boolean): boolean {
  if (!l.agentBeside) return false
  if (resizing && was !== null) return was
  const need = splitNeed(cell).total
  if (was === true || was === null) return main >= need
  return main >= need + SIZE_PX['split-hysteresis']
}

/** What the split's mode was at the evaluation before: drawn or not, and chosen or not. */
export interface SplitWas {
  drew: boolean
  chose: boolean
}

/**
 * Whether the split is drawn now, from what it was at the evaluation before (`last`; null before the first frame). The
 * band is for a column that changes width: the split just chosen shows wherever the column holds the need, as on a
 * window's first frame.
 */
export function splitMode(l: Layout, main: number, cell: number, last: SplitWas | null, resizing: boolean): boolean {
  const was = last === null || (l.agentBeside && !last.chose) ? null : last.drew
  return splitOn(l, main, cell, was, resizing)
}

/** Why View ▸ Show Agent Beside Terminals is unavailable: the main column cannot hold the split. */
export const AGENT_PANE_TOO_NARROW = 'The window is too narrow to show the agent beside terminals'

/**
 * View ▸ Show Agent Beside Terminals / Show Agent as a Tab: its title for the person's choice, and whether the main
 * column holds the split now (it is unavailable while not; the choice is kept, and the split appears once it does).
 */
export function agentPaneToggle(l: Layout, windowWidth: number, cell: number, floor: number = RANGE.sidebar.min): { title: string; fits: boolean } {
  return { title: l.agentBeside ? 'Show Agent as a Tab' : 'Show Agent Beside Terminals', fits: mainWidth(l, windowWidth, floor) >= splitNeed(cell).total }
}

/**
 * The panes' widths in the split: the agent's stored width (once its divider was dragged), else `agent_first_share`
 * of the main column; never narrower than its need, and giving way so the work pane keeps its own.
 */
export function splitWidths(l: Layout, main: number, cell: number): Split {
  const need = splitNeed(cell)
  const want = l.agentWidth ?? Math.round(main * L.agentFirstShare)
  const agent = Math.max(need.agent, Math.min(want, main - need.work))
  return { agent, work: main - agent }
}

/** A drag on the agent pane's divider: `from` is its drawn width when the drag began, `dx` the pointer's travel (left widens it). */
export function dragAgent(l: Layout, from: number, dx: number, main: number, cell: number): Layout {
  const need = splitNeed(cell)
  const w = Math.round(Math.max(need.agent, Math.min(from - dx, main - need.work)))
  return w === l.agentWidth ? l : { ...l, agentWidth: w }
}

/** Double-click on the agent pane's divider: its width is forgotten, `agent_first_share` again. */
export function resetAgentWidth(l: Layout): Layout {
  return l.agentWidth === null ? l : { ...l, agentWidth: null }
}

/** Arrow keys on the focused agent divider: ← moves it left (the agent wider), → right. */
export function stepAgent(l: Layout, dir: -1 | 1, main: number, cell: number): Layout {
  return dragAgent(l, splitWidths(l, main, cell).agent, dir * STEP, main, cell)
}

export function setAgentBeside(l: Layout, on: boolean): Layout {
  return l.agentBeside === on ? l : { ...l, agentBeside: on }
}

/** The cell width measured for the saved font settings (`measureCell`). */
export function setCellWidth(l: Layout, cell: number): Layout {
  return l.cellWidth === cell || !(cell > 0) ? l : { ...l, cellWidth: cell }
}

// ── focus regions ────────────────────────────────────────────────────────────────────────────

/**
 * The window's focus regions in focus order: sidebar, file panel, header, the main pane (the terminal, file or prompt
 * it shows; in the split, the work pane), and the agent pane while the split is drawn.
 */
export const REGIONS = ['sidebar', 'files', 'header', 'main', 'agent'] as const
export type Region = (typeof REGIONS)[number]

/** F6 / ⇧F6: the region `step` away from `current` that `can` take focus, wrapping; null when no other region can. */
export function cycleRegion(current: Region | null, step: 1 | -1, can: (r: Region) => boolean): Region | null {
  const n = REGIONS.length
  const from = current ? REGIONS.indexOf(current) : step === 1 ? -1 : n
  for (let k = 1; k <= n; k++) {
    const r = REGIONS[(((from + step * k) % n) + n) % n]!
    if (r === current) return null
    if (can(r)) return r
  }
  return null
}

// ── persistence ──────────────────────────────────────────────────────────────────────────────

export const LAYOUT_KEY = 'kea.layout'

export interface KeyValue {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

export function loadLayout(store: KeyValue | null): Layout {
  try {
    const s = store?.getItem(LAYOUT_KEY)
    return parseLayout(s ? JSON.parse(s) : null)
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function saveLayout(store: KeyValue | null, l: Layout): void {
  try {
    store?.setItem(LAYOUT_KEY, JSON.stringify(l))
  } catch {
    // storage full or unavailable: the layout still applies for this run
  }
}
