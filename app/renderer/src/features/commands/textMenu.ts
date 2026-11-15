// The text menu: a right-click on a text field, or on a document the viewer shows that can be edited, opens Cut, Copy,
// Paste and Select All; on a read-only document, Copy and Select All; on other selected text in the window, Copy. On a
// web address in a viewer document, Open Link and Copy Link come first. Its text items are the Edit menu's roles, not
// commands of the table, each with the key a field has for it on this system (`⌘X`, `Ctrl+X`). Pure, so a test can
// give either system; `shell/TextMenu.svelte` finds the target and runs the pick.

import type { KeyLabels, System } from '@kea/protocol'
import type { MenuItem } from '@kea/ui'

export type TextRole = 'cut' | 'copy' | 'paste' | 'selectAll'
/** What a pick of the menu runs: an Edit role, or one of a link's items. */
export type TextPick = TextRole | 'openLink' | 'copyLink'

/** A link in a viewer document: its text as it reads, and the address it opens (null: one that is offered for copying only). */
export type TextLink = { kind: 'url'; text: string; url: string | null }

/** What a right-click landed on. */
export interface TextTarget {
  /** A field (`input`, `textarea`, an editable element), a document the viewer shows, or other text in the window. */
  kind: 'field' | 'document' | 'text'
  /** The field or document takes typing: neither read-only nor disabled. */
  editable: boolean
  /** Text is selected there. */
  hasSelection: boolean
  /** A password field, whose text is never cut or copied. */
  secret: boolean
  /** The link under the pointer (or at the cursor, from the keyboard), in a viewer document. */
  link?: TextLink | null
  /** Only the link's items: a click on an address that is not opened, or Follow Link at one. */
  linkOnly?: boolean
}

const LABEL: Readonly<Record<TextRole, string>> = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' }
const KEY: Readonly<Record<TextRole, string>> = { cut: 'x', copy: 'c', paste: 'v', selectAll: 'a' }

/** A link's items: Open Link (for an address that opens) and Copy Link. */
function linkItems(link: TextLink): MenuItem[] {
  return [...(link.url !== null ? [{ id: 'openLink', label: 'Open Link' }] : []), { id: 'copyLink', label: 'Copy Link' }]
}

/** The menu's items for `t`; none where there is nothing to offer (text with nothing selected). */
export function textMenuItems(t: TextTarget, system: System, keys: KeyLabels): MenuItem[] {
  const own = roleItems(t, system, keys)
  if (!t.link) return own
  if (t.linkOnly) return [{ id: 'copyLink', label: 'Copy Link' }]
  return [...linkItems(t.link), ...(own.length > 0 ? [{ id: 'sep:link', label: '', separator: true }] : []), ...own]
}

function roleItems(t: TextTarget, system: System, keys: KeyLabels): MenuItem[] {
  const item = (role: TextRole, reason?: string): MenuItem => ({
    id: role,
    label: LABEL[role],
    // a field's own key: the Edit menu's on macOS, the field's Ctrl one on Linux
    shortcut: keys.label({ cmd: system === 'darwin', ctrl: system !== 'darwin', alt: false, shift: false, key: KEY[role] }),
    ...(reason ? { disabled: true, reason } : {}),
  })
  const copyReason = t.secret ? 'A password is not copied' : t.hasSelection ? undefined : 'Nothing is selected'
  if (t.kind === 'field') {
    const typing = t.editable ? undefined : 'This field is read-only'
    return [item('cut', typing ?? copyReason), item('copy', copyReason), item('paste', typing), item('selectAll')]
  }
  if (t.kind === 'document') {
    // an editable document offers what a field does
    if (t.editable) return [item('cut', copyReason), item('copy', copyReason), item('paste'), item('selectAll')]
    return [item('copy', copyReason), item('selectAll')]
  }
  return t.hasSelection ? [item('copy')] : []
}

/** What a key event reads: its key and modifiers. */
export interface MenuKeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** The keyboard's menu key in a viewer document: the Menu key alone, or `⇧F10`. No system fact is needed: a Mac keyboard has no Menu key. */
export function menuKey(e: MenuKeyLike): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false
  return (e.key === 'ContextMenu' && !e.shiftKey) || (e.key === 'F10' && e.shiftKey)
}

/**
 * A `contextmenu` that came from the pointer, so it opens where the pointer is with the link under it: the right
 * button, or on macOS a `⌃`-click (a left press with `ctrlKey`, as the terminal menu reads it). Anything else came from
 * the keyboard.
 */
export function pointerMenu(e: { button: number; ctrlKey: boolean }, system: System): boolean {
  return e.button === 2 || (system === 'darwin' && e.button === 0 && e.ctrlKey)
}
