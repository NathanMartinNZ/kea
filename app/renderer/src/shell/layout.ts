// The window's three columns: sidebar, file panel and main, as data. Widths are what the person chose, clamped to each
// column's range; what is drawn also keeps the main column at least `main-min` wide (the file panel gives way first,
// then the sidebar, never below their minimums), and the file panel collapses by itself below `tree-autocollapse` and
// comes back when the window is widened. Hiding is separate from width, so a hidden column comes back at its width.
// Double-click on a divider resets that column; arrows move it by one grid step.
//
// Persisted per window as JSON in the window's local storage, so the first frame is laid out before core answers;
// window bounds are main's (window-state.json). Every size is a token.

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
}

export const RANGE: Readonly<Record<Column, { min: number; max: number; default: number }>> = {
  sidebar: { min: SIZE_PX['sidebar-min'], max: SIZE_PX['sidebar-max'], default: SIZE_PX.sidebar },
  tree: { min: SIZE_PX['tree-min'], max: SIZE_PX['tree-max'], default: SIZE_PX.tree },
}

/** One keyboard step on a divider: one unit of the spacing grid (`--space-1`). */
export const STEP = SPACE_PX[0]

export const DEFAULT_LAYOUT: Layout = { sidebarWidth: RANGE.sidebar.default, treeWidth: RANGE.tree.default, sidebarHidden: false, treeHidden: false, panelMode: 'files' }

export function clampWidth(c: Column, w: number): number {
  const r = RANGE[c]
  if (!Number.isFinite(w)) return r.default
  return Math.round(Math.min(r.max, Math.max(r.min, w)))
}

const key = (c: Column): 'sidebarWidth' | 'treeWidth' => (c === 'sidebar' ? 'sidebarWidth' : 'treeWidth')

/** A stored layout, checked field by field: anything missing or wrong takes its default. */
export function parseLayout(raw: unknown): Layout {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, c: Column) => (typeof v === 'number' ? clampWidth(c, v) : RANGE[c].default)
  const bool = (v: unknown) => v === true
  return {
    sidebarWidth: num(o.sidebarWidth, 'sidebar'),
    treeWidth: num(o.treeWidth, 'tree'),
    sidebarHidden: bool(o.sidebarHidden),
    treeHidden: bool(o.treeHidden),
    panelMode: o.panelMode === 'changes' ? 'changes' : 'files',
  }
}

export interface Drawn {
  /** 0 when hidden. */
  sidebar: number
  tree: number
  /** The file panel is collapsed because the window is narrow, not by choice. */
  treeAuto: boolean
}

/** What is drawn in a window `windowWidth` wide. */
export function drawn(l: Layout, windowWidth: number): Drawn {
  const treeAuto = !l.treeHidden && windowWidth < SIZE_PX['tree-autocollapse']
  let sidebar = l.sidebarHidden ? 0 : l.sidebarWidth
  let tree = l.treeHidden || treeAuto ? 0 : l.treeWidth
  // the main column keeps main-min: the file panel gives way first, then the sidebar, down to their minimums
  let over = sidebar + tree + SIZE_PX['main-min'] - windowWidth
  if (over > 0 && tree > 0) {
    const give = Math.min(over, tree - RANGE.tree.min)
    tree -= give
    over -= give
  }
  if (over > 0 && sidebar > 0) sidebar -= Math.min(over, sidebar - RANGE.sidebar.min)
  return { sidebar, tree, treeAuto }
}

/** A drag on a column's right divider: `from` is its drawn width when the drag began, `dx` the pointer's travel. */
export function dragTo(l: Layout, c: Column, from: number, dx: number, windowWidth: number): Layout {
  const d = drawn(l, windowWidth)
  const other = c === 'sidebar' ? d.tree : d.sidebar
  // never push the main column below its minimum by dragging
  const room = windowWidth - SIZE_PX['main-min'] - other
  const w = clampWidth(c, Math.min(from + dx, Math.max(RANGE[c].min, room)))
  return w === l[key(c)] ? l : { ...l, [key(c)]: w }
}

/** Double-click: the column's default width. */
export function resetWidth(l: Layout, c: Column): Layout {
  return l[key(c)] === RANGE[c].default ? l : { ...l, [key(c)]: RANGE[c].default }
}

/** Arrow keys on a focused divider: one grid step narrower (-1) or wider (1). */
export function stepWidth(l: Layout, c: Column, dir: -1 | 1, windowWidth: number): Layout {
  return dragTo(l, c, drawn(l, windowWidth)[c], dir * STEP, windowWidth)
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

// ── focus regions ────────────────────────────────────────────────────────────────────────────

/** The window's focus regions in focus order: sidebar, file panel, header, the main pane (terminal or prompt). */
export const REGIONS = ['sidebar', 'files', 'header', 'main'] as const
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
