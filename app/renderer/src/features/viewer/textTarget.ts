// The viewer's part in the text menu: the document a right-click landed in (a CodeMirror view, the diff's two
// included), whether it can be edited and its text is selected, the web address under the pointer or at the cursor,
// and Select All, which is CodeMirror's own: in a read-only document the page's role would select the whole window.
// The window's text menu sets the opener here, so the viewer can open it for a link (`openTextMenu`).

import { selectAll } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import type { TextLink } from '../commands/textMenu.ts'
import { cursorPoint, linkAtCursor, linkAtPoint, textLinkOf } from './linkView.ts'

export interface ViewerText {
  /** The document can be edited (Cut and Paste apply). */
  readonly editable: boolean
  readonly hasSelection: boolean
  /** The keyboard to the document, so the Edit role's copy reaches its own copy handler. */
  focus(): void
  selectAll(): void
}

function viewOf(el: Element): EditorView | null {
  const root = el.closest('.cm-editor')
  return root instanceof HTMLElement ? EditorView.findFromDOM(root) : null
}

/** The document under `el`, or null where `el` is in none. */
export function viewerTextAt(el: Element): ViewerText | null {
  const view = viewOf(el)
  if (!view) return null
  return {
    editable: !view.state.readOnly,
    hasSelection: view.state.selection.ranges.some((r) => !r.empty),
    focus: () => view.focus(),
    selectAll: () => {
      selectAll(view)
      view.focus()
    },
  }
}

/** The web address under the point `(x, y)`, `el` being the element there, in a viewer document; null elsewhere. */
export function viewerLinkAt(el: Element, x: number, y: number): TextLink | null {
  const view = viewOf(el)
  const link = view ? linkAtPoint(view, x, y, el) : null
  return link ? textLinkOf(link) : null
}

/** Where the keyboard's menu opens in the viewer document `el` is in (under the main cursor), with the address there; null outside one. */
export function viewerCursorAt(el: Element): { at: { x: number; y: number }; link: TextLink | null } | null {
  const view = viewOf(el)
  if (!view) return null
  const link = linkAtCursor(view.state)
  return { at: cursorPoint(view), link: link ? textLinkOf(link) : null }
}

/** Opens the text menu for the document `el` is in, at a point, with a link (`linkOnly`: the link's items alone). */
export type TextMenuOpener = (el: Element, at: { x: number; y: number }, link: TextLink, linkOnly: boolean) => void

// bounded: one opener, the window's text menu
let opener: TextMenuOpener | null = null

/** The window's text menu, once mounted (null when it goes). */
export function setTextMenuOpener(fn: TextMenuOpener | null): void {
  opener = fn
}

/** The text menu with a link, for a viewer document; nothing before the window's menu is mounted. */
export function openTextMenu(el: Element, at: { x: number; y: number }, link: TextLink, linkOnly: boolean): void {
  opener?.(el, at, link, linkOnly)
}
