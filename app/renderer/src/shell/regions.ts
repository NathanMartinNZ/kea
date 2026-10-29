// F6 / ⇧F6: the window's focus regions, in focus order — sidebar, file panel, header, terminal (the main pane: the
// terminal on screen, or the composer's prompt; in the split, the work pane), and the agent pane while the split is drawn. `view.cycleFocus` moves the keyboard to the next or previous region
// that is shown and has something to focus; the router intercepts F6 everywhere, the terminal included. Which element
// of a region takes focus: the sidebar's current row, the file panel's tree or list (its mode button while the body has
// nothing to focus), the header's first control, the main pane's terminal, file viewer or prompt. `Esc` in the sidebar,
// the file panel or the header, when nothing there used it (a filter, a menu, a rename), sends the keyboard back to the
// main pane (the session's active pane in the split), and so does hiding the sidebar or the file panel while the
// keyboard is in it (`leaveHiddenColumns`).

import type { Disposable } from '@kea/terminal'
import { commands } from '../features/commands/registry.ts'
import { currentPane, terminals } from '../features/terminal/views.ts'
import { cycleRegion, REGIONS, type Region } from './layout.ts'
import { panelFocusTarget } from './layoutStore.svelte.ts'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]'

/** The region's element, if it is shown. */
function regionElement(r: Region): HTMLElement | null {
  const sel = { sidebar: 'aside.sidebar-column', files: 'section.file-panel', header: '.main-header', main: '.main-pane', agent: '.agent-pane' }[r]
  const el = document.querySelector<HTMLElement>(sel)
  return el && !el.hidden && el.closest('[hidden]') === null ? el : null
}

/** Where the keyboard goes in a region. */
function target(r: Region): HTMLElement | { focus(): void } | null {
  const el = regionElement(r)
  if (!el) return null
  switch (r) {
    case 'sidebar':
      return el.querySelector<HTMLElement>('.sidebar-tree [tabindex="0"]') ?? el.querySelector<HTMLElement>(FOCUSABLE)
    case 'files':
      return panelFocusTarget(el) ?? el.querySelector<HTMLElement>(FOCUSABLE)
    case 'header':
      return el.querySelector<HTMLElement>(FOCUSABLE)
    case 'main': {
      // in the split, the work pane; in one column, the whole pane
      const work = el.querySelector<HTMLElement>('.work-pane') ?? el
      const view = terminals.shown('work') ?? terminals.visible('work')
      if (view && work.querySelector('.terminal-area[data-pane="work"] .terminal-host.shown')) return view
      // a file or diff tab is the active one: the viewer's mount
      return work.querySelector<HTMLElement>('.viewer-mount') ?? el.querySelector<HTMLElement>('.composer-prompt') ?? work.querySelector<HTMLElement>(FOCUSABLE)
    }
    case 'agent':
      return terminals.shown('agent') ?? el.querySelector<HTMLElement>(FOCUSABLE)
  }
}

/** The region the keyboard is in now (the agent pane is inside the main pane: it is asked first). */
function currentRegion(): Region | null {
  const a = document.activeElement
  if (!(a instanceof HTMLElement)) return null
  return [...REGIONS].reverse().find((r) => regionElement(r)?.contains(a)) ?? null
}

/** The main pane's target: the session's active pane in the split. */
function mainTarget(): HTMLElement | { focus(): void } | null {
  return (currentPane() === 'agent' ? target('agent') : null) ?? target('main')
}

export function registerRegionCommands(): Disposable {
  return commands.register('view.cycleFocus', {
    run: (args) => {
      const step = (args as { step?: unknown } | undefined)?.step === -1 ? -1 : 1
      const next = cycleRegion(currentRegion(), step, (r) => target(r) !== null)
      if (next) target(next)?.focus()
    },
  })
}

/**
 * A column that stops being shown while the keyboard is in it (`⌘⇧E` / `⌘⇧G` pressed again in the file panel, Toggle
 * File Panel, `⌘B` in the sidebar, the file panel giving way to a narrow window) hands the keyboard to the main pane,
 * so nothing typed reaches a tree that is not on screen. `hidden`: the columns not shown now.
 */
export function leaveHiddenColumns(hidden: readonly ('sidebar' | 'files')[]): void {
  const a = document.activeElement
  if (!(a instanceof HTMLElement)) return
  const inHidden = hidden.some((r) => document.querySelector(r === 'sidebar' ? 'aside.sidebar-column' : 'section.file-panel')?.contains(a))
  if (inHidden) mainTarget()?.focus()
}

/**
 * The keyboard to the main pane — the terminal on screen, or the file tab or the composer's prompt where that is what
 * it shows. Where a command leaves the keyboard once it has run from the palette and opened nothing.
 */
export function focusMain(): void {
  mainTarget()?.focus()
}

/** `Esc` from a region other than the main pane, unless something there handled it, returns to the terminal. */
export function escapeToMain(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  const r = currentRegion()
  if (r === null || r === 'main' || r === 'agent') return
  const t = mainTarget()
  if (!t) return
  e.preventDefault()
  t.focus()
}
