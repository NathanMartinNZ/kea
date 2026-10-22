// The window's layout state: the persisted Layout (layout.ts) plus the window's width, and the commands that change it:
// Toggle Sidebar (⌘B), Show Files (⌘⇧E), Show Changes (⌘⇧G), Toggle File Panel. ⌘⇧E and ⌘⇧G show the file panel in
// their mode and focus it; pressed again while the panel has focus in that mode, they hide it. While the keyboard is in
// the panel, its key scope applies (`file panel`). A runes store: `layoutState.layout`, `.width` and `.resizing` are
// each their own state.

import type { Disposable } from '@kea/terminal'
import { disposeAll } from '@kea/terminal'
import { commands } from '../features/commands/registry.ts'
import { provideKeyScope } from '../features/commands/scope.ts'
import { filesModel } from '../features/files/model.ts'
import { drawn, loadLayout, saveLayout, setPanelMode, setTreeHidden, toggleSidebar, type KeyValue, type Layout, type PanelMode } from './layout.ts'

function storage(): KeyValue | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

class LayoutState {
  layout = $state.raw<Layout>(loadLayout(storage()))
  width = $state(window.innerWidth)
  /** A divider is being dragged: no width transition (only a collapse or an expand animates). */
  resizing = $state(false)
}

export const layoutState = new LayoutState()

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
  const { layout, width } = layoutState
  const shown = drawn(layout, width).tree > 0
  if (shown && layout.panelMode === mode && panelHasFocus()) {
    setLayout((l) => setTreeHidden(l, true))
    return
  }
  setLayout((l) => setPanelMode(setTreeHidden(l, false), mode))
  requestAnimationFrame(() => panelFocusTarget()?.focus())
}

export function registerLayoutCommands(): Disposable {
  const onResize = () => {
    layoutState.width = window.innerWidth
  }
  window.addEventListener('resize', onResize)
  // bindings marked "(file panel)" apply while the keyboard is in the panel
  const withdraw = provideKeyScope(() => (panelHasFocus() ? 'file panel' : null))
  const ds = [
    commands.register('view.toggleSidebar', { run: () => setLayout(toggleSidebar) }),
    commands.register('files.togglePanel', { run: () => setLayout((l) => setTreeHidden(l, !l.treeHidden)) }),
    commands.register('files.showFiles', { run: () => showPanel('files') }),
    // A folder that is not a git repository has no Changes
    commands.register('files.showChanges', { run: () => showPanel('changes'), when: () => filesModel.isGit, unavailableReason: () => 'This folder is not a git repository' }),
  ]
  return {
    dispose: () => {
      window.removeEventListener('resize', onResize)
      withdraw()
      disposeAll(ds)
    },
  }
}
