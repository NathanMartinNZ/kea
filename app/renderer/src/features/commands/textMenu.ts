// The text menu: a right-click on a text field opens Cut, Copy, Paste and Select All; on a document the viewer shows,
// Copy and Select All; on other selected text in the window, Copy. Its items are the Edit menu's roles, not commands of
// the table, each with the key a field has for it on this system (`⌘X`, `Ctrl+X`). Pure, so a test can give either
// system; `shell/TextMenu.svelte` finds the target and runs the pick.

import type { KeyLabels, System } from '@kea/protocol'
import type { MenuItem } from '@kea/ui'

export type TextRole = 'cut' | 'copy' | 'paste' | 'selectAll'

/** What a right-click landed on. */
export interface TextTarget {
  /** A field (`input`, `textarea`, an editable element), a document the viewer shows, or other text in the window. */
  kind: 'field' | 'document' | 'text'
  /** The field takes typing: neither read-only nor disabled. */
  editable: boolean
  /** Text is selected there. */
  hasSelection: boolean
  /** A password field, whose text is never cut or copied. */
  secret: boolean
}

const LABEL: Readonly<Record<TextRole, string>> = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' }
const KEY: Readonly<Record<TextRole, string>> = { cut: 'x', copy: 'c', paste: 'v', selectAll: 'a' }

/** The menu's items for `t`; none where there is nothing to offer (text with nothing selected). */
export function textMenuItems(t: TextTarget, system: System, keys: KeyLabels): MenuItem[] {
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
  if (t.kind === 'document') return [item('copy', copyReason), item('selectAll')]
  return t.hasSelection ? [item('copy')] : []
}
