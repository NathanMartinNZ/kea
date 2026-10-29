// The window's layout state: the persisted Layout (layout.ts) plus the window's width, and the commands that change it:
// Toggle Sidebar (⌘B), Show Files (⌘⇧E), Show Changes (⌘⇧G), Toggle File Panel. ⌘⇧E and ⌘⇧G show the file panel in
// their mode and focus it; pressed again while the panel has focus in that mode, they hide it. While the keyboard is in
// the panel, its key scope applies (`file panel`). A runes store: `layoutState.layout`, `.width` and `.resizing` are
// each their own state, and `.split` is what a session's main column draws (the panes' widths, or null for one column),
// decided with hysteresis from the mode it drew last. The terminal cell's width is measured for the saved font
// settings at start, when they change and when the window moves to a display of another scale. `.sidebarFloor` is the
// sidebar's minimum now: the token, or more where the window's own buttons sit on the left of a Linux title bar (read
// from the Window Controls Overlay, and again whenever the desktop moves them).

import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { commands } from '../features/commands/registry.ts'
import { provideKeyScope } from '../features/commands/scope.ts'
import { filesModel } from '../features/files/model.ts'
import { measureCell, measureCellNow } from '../features/terminal/cell.ts'
import { prefs } from '../features/terminal/prefs.ts'
import { followOverlay } from './overlay.ts'
import { protocolOs } from '@kea/protocol'
import { AGENT_PANE_TOO_NARROW, agentPaneToggle, drawn, loadLayout, mainWidth, RANGE, saveLayout, setAgentBeside, setCellWidth, setPanelMode, setTreeHidden, sidebarCompactAt, splitMode, splitWidths, toggleSidebar, type Drawn, type KeyValue, type Layout, type PanelMode, type Split, type SplitWas } from './layout.ts'

function storage(): KeyValue | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The cell width before the first measurement is kept: one measured now, with whichever face the canvas has. */
let firstCell: number | null = null

/** The cell width the split's minimums use. */
export function cellWidth(l: Layout): number {
  if (l.cellWidth !== null) return l.cellWidth
  firstCell ??= measureCellNow(prefs.get()) ?? prefs.get().fontSize
  return firstCell
}

// the split's mode at the last evaluation, drawn and chosen; null before the window's first frame (no band then)
let lastSplit: SplitWas | null = null

class LayoutState {
  layout = $state.raw<Layout>(loadLayout(storage()))
  width = $state(window.innerWidth)
  /** A divider is being dragged: no width transition (only a collapse or an expand animates), and no change of mode. */
  resizing = $state(false)
  /** The sidebar's minimum now (`sidebarFloor`). */
  sidebarFloor = $state(RANGE.sidebar.min)
  /** The split as a session's main column draws it, or null: one column. */
  split: Split | null = $derived.by(() => {
    const l = this.layout
    const main = mainWidth(l, this.width, this.sidebarFloor)
    const cell = cellWidth(l)
    const on = splitMode(l, main, cell, lastSplit, this.resizing)
    lastSplit = { drew: on, chose: l.agentBeside }
    return on ? splitWidths(l, main, cell) : null
  })
}

export const layoutState = new LayoutState()

/** What the window draws now. */
export function drawnNow(): Drawn {
  return drawn(layoutState.layout, layoutState.width, layoutState.sidebarFloor)
}

/** The sidebar is drawn narrower than `--size-sidebar-compact`: its rows drop their secondary text. */
export function sidebarCompact(): boolean {
  return sidebarCompactAt(drawnNow().sidebar)
}

/** The main column's width now. */
export function mainNow(): number {
  return mainWidth(layoutState.layout, layoutState.width, layoutState.sidebarFloor)
}

/** Change the layout and persist it. */
export function setLayout(fn: (l: Layout) => Layout): void {
  const cur = layoutState.layout
  const next = fn(cur)
  if (next === cur) return
  layoutState.layout = next
  saveLayout(storage(), next)
  commands.changed()
}

/** The file panel element (focus target of ⌘⇧E / ⌘⇧G). */
let panelEl: HTMLElement | null = null
export function setPanelElement(el: HTMLElement | null): void {
  panelEl = el
}

function panelHasFocus(): boolean {
  return !!panelEl && panelEl.contains(document.activeElement)
}

/**
 * Where the keyboard goes in the file panel: what its body marks with `data-panel-focus` (the tree or the Changes
 * list), else the header's mode button.
 */
export function panelFocusTarget(el: HTMLElement | null = panelEl): HTMLElement | null {
  return el?.querySelector<HTMLElement>('.panel-body [data-panel-focus]') ?? el?.querySelector<HTMLElement>('[data-panel-focus]') ?? null
}

function showPanel(mode: PanelMode): void {
  const { layout } = layoutState
  const shown = drawnNow().tree > 0
  if (shown && layout.panelMode === mode && panelHasFocus()) {
    setLayout((l) => setTreeHidden(l, true))
    return
  }
  setLayout((l) => setPanelMode(setTreeHidden(l, false), mode))
  requestAnimationFrame(() => panelFocusTarget()?.focus())
}

/** The main column holds the split's need now (whether or not it is chosen). */
function toggle(): { title: string; fits: boolean } {
  const l = layoutState.layout
  return agentPaneToggle(l, layoutState.width, cellWidth(l), layoutState.sidebarFloor)
}

/** Measure the cell width for the saved font settings and keep it (it changes the split's need, never the zoom). */
function measure(): void {
  const { fontFamily, fontSize } = prefs.get()
  void measureCell({ fontFamily, fontSize }).then((w) => {
    if (w !== null) setLayout((l) => setCellWidth(l, w))
  })
}

export function registerLayoutCommands(): Disposable {
  const onResize = () => {
    layoutState.width = window.innerWidth
  }
  window.addEventListener('resize', onResize)
  // Linux: the overlay's buttons at the left of the title bar widen the sidebar's minimum (macOS has no overlay)
  const offOverlay = followOverlay(protocolOs.window.menuButton ? navigator.windowControlsOverlay : undefined, (floor) => {
    layoutState.sidebarFloor = floor
  })
  measure()
  let font = `${prefs.get().fontSize} ${prefs.get().fontFamily}`
  const offPrefs = prefs.subscribe(() => {
    const now = `${prefs.get().fontSize} ${prefs.get().fontFamily}`
    if (now === font) return
    font = now
    measure()
  })
  // a display of another scale rounds the cell to other device pixels: one media query, re-armed at each new ratio
  let dpr: MediaQueryList | null = null
  const onDpr = () => {
    dpr?.removeEventListener('change', onDpr)
    dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dpr.addEventListener('change', onDpr)
    measure()
  }
  dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dpr.addEventListener('change', onDpr)
  // bindings marked "(file panel)" apply while the keyboard is in the panel, but not in a field there (the tree's name
  // field keeps its keys, copy and paste included)
  const withdraw = provideKeyScope(() => (panelHasFocus() && !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) ? 'file panel' : null))
  const ds = [
    commands.register('view.toggleSidebar', { run: () => setLayout(toggleSidebar) }),
    // the agent beside the terminals or as a tab: the person's choice, kept while the window is too narrow for it
    commands.register('view.toggleAgentPane', {
      run: () => setLayout((l) => setAgentBeside(l, !l.agentBeside)),
      title: () => toggle().title,
      when: () => toggle().fits,
      unavailableReason: () => AGENT_PANE_TOO_NARROW,
    }),
    commands.register('files.togglePanel', { run: () => setLayout((l) => setTreeHidden(l, !l.treeHidden)) }),
    commands.register('files.showFiles', { run: () => showPanel('files') }),
    // A folder that is not a git repository has no Changes
    commands.register('files.showChanges', { run: () => showPanel('changes'), when: () => filesModel.isGit, unavailableReason: () => 'This folder is not a git repository' }),
  ]
  return {
    dispose: () => {
      window.removeEventListener('resize', onResize)
      offOverlay()
      offPrefs()
      dpr?.removeEventListener('change', onDpr)
      withdraw()
      disposeAll(ds)
    },
  }
}
