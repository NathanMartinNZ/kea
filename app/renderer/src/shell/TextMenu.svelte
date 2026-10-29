<!--
The text menu (features/commands/textMenu.ts): a right-click on a text field, a document the viewer shows or other
selected text opens Cut, Copy, Paste and Select All as they apply there. A right-click another menu took (a terminal,
a row, a chip: each prevents the event's default) never opens it, nor does one with nothing to offer. Cut, Copy and
Paste are the Edit menu's roles, which main runs on the element the menu was opened on once it has the keyboard back;
Select All selects a field's text, or the document's through the viewer. The keyboard's Menu key opens it on a field
too, where Chromium sends a `contextmenu`. Mounted once by the window. Locatable as `role=menu` "Text menu".
-->
<script lang="ts">
  import { protocolOs } from '@kea/protocol'
  import { Menu, type MenuItem } from '@kea/ui'
  import { textMenuItems, type TextRole, type TextTarget } from '../features/commands/textMenu.ts'
  import { viewerTextAt, type ViewerText } from '../features/viewer/textTarget.ts'
  import { editRole } from '../lib/bridge.ts'

  /** The input types whose text can be selected and edited. */
  const FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number'])

  let open = $state.raw<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null)
  /** What the open menu acts on: plain values, never rune state. */
  let field: HTMLElement | null = null
  let doc: ViewerText | null = null

  const pageSelection = (): boolean => {
    const s = window.getSelection()
    return !!s && !s.isCollapsed && s.toString() !== ''
  }

  function targetOf(el: Element): { target: TextTarget; field: HTMLElement | null; doc: ViewerText | null } {
    const input = el.closest('input, textarea')
    if (input instanceof HTMLTextAreaElement || (input instanceof HTMLInputElement && FIELD_TYPES.has(input.type))) {
      const selected = input.selectionStart !== null && input.selectionStart !== input.selectionEnd
      return { target: { kind: 'field', editable: !input.readOnly && !input.disabled, hasSelection: selected, secret: input.type === 'password' }, field: input, doc: null }
    }
    const editable = el.closest('[contenteditable]')
    if (editable instanceof HTMLElement && editable.isContentEditable) return { target: { kind: 'field', editable: true, hasSelection: pageSelection(), secret: false }, field: editable, doc: null }
    const d = viewerTextAt(el)
    if (d) return { target: { kind: 'document', editable: false, hasSelection: d.hasSelection, secret: false }, field: null, doc: d }
    return { target: { kind: 'text', editable: false, hasSelection: pageSelection(), secret: false }, field: null, doc: null }
  }

  $effect(() => {
    const onMenu = (e: MouseEvent): void => {
      if (e.defaultPrevented || !(e.target instanceof Element)) return
      const t = targetOf(e.target)
      const items = textMenuItems(t.target, protocolOs.system, protocolOs.keys)
      if (items.length === 0) return
      e.preventDefault()
      field = t.field
      doc = t.doc
      open = { at: { x: e.clientX, y: e.clientY }, items }
    }
    document.addEventListener('contextmenu', onMenu)
    return () => document.removeEventListener('contextmenu', onMenu)
  })

  /** The pick, which runs once the menu has closed (`close` lets the target go once it has run). */
  function pick(id: string): void {
    const role = id as TextRole
    const f = field
    const d = doc
    if (d) {
      if (role === 'selectAll') return d.selectAll()
      d.focus()
      return editRole(role)
    }
    f?.focus()
    if (role === 'selectAll' && (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) return f.select()
    editRole(role)
  }

  function close(): void {
    open = null
    queueMicrotask(() => {
      if (open) return
      field = null
      doc = null
    })
  }
</script>

{#if open}
  <Menu label="Text menu" items={open.items} at={open.at} onPick={pick} onClose={close} />
{/if}
