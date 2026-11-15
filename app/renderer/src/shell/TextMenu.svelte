<!--
The text menu (features/commands/textMenu.ts): a right-click on a text field, a document the viewer shows or other
selected text opens Cut, Copy, Paste and Select All as they apply there: all four in a field or a document that can be
edited, Copy and Select All in a read-only document. On a web address in a viewer document, Open Link and Copy Link
come first (Copy Link alone for an address that is not opened). The viewer's document is looked for first, since an
editable one is a `contenteditable` too. A right-click another menu took (a terminal, a row, a chip: each prevents the
event's default) never opens it, nor does one with nothing to offer. Cut, Copy and Paste are the Edit menu's roles,
which main runs on the element the menu was opened on once it has the keyboard back; Select All selects a field's
text, or the document's through the viewer. The keyboard's Menu key opens it on a field too, where Chromium sends a
`contextmenu`; in a viewer document the Menu key and `⇧F10` are taken on keydown and open it at the main cursor, with
the address there. The viewer opens it for a link through the opener set here (`setTextMenuOpener`). Mounted once by
the window. Locatable as `role=menu` "Text menu".
-->
<script lang="ts">
  import { protocolOs } from '@kea/protocol'
  import { Menu, type MenuItem } from '@kea/ui'
  import { menuKey, pointerMenu, textMenuItems, type TextLink, type TextPick, type TextTarget } from '../features/commands/textMenu.ts'
  import { copyText, openWebLink } from '../features/sessions/actions.ts'
  import { setTextMenuOpener, viewerCursorAt, viewerLinkAt, viewerTextAt, type ViewerText } from '../features/viewer/textTarget.ts'
  import { editRole } from '../lib/bridge.ts'

  /** The input types whose text can be selected and edited. */
  const FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number'])

  let open = $state.raw<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null)
  /** What the open menu acts on: plain values, never rune state. */
  let field: HTMLElement | null = null
  let doc: ViewerText | null = null
  let link: TextLink | null = null

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
    // the viewer's document first: an editable one is a `contenteditable` too
    const d = viewerTextAt(el)
    if (d) return { target: { kind: 'document', editable: d.editable, hasSelection: d.hasSelection, secret: false }, field: null, doc: d }
    const editable = el.closest('[contenteditable]')
    if (editable instanceof HTMLElement && editable.isContentEditable) return { target: { kind: 'field', editable: true, hasSelection: pageSelection(), secret: false }, field: editable, doc: null }
    return { target: { kind: 'text', editable: false, hasSelection: pageSelection(), secret: false }, field: null, doc: null }
  }

  /** Open the menu for what `el` is, at `at`, with a viewer document's link; false when it has nothing to offer. */
  function show(el: Element, at: { x: number; y: number }, l: TextLink | null, linkOnly: boolean): boolean {
    const t = targetOf(el)
    const items = textMenuItems({ ...t.target, link: l, linkOnly }, protocolOs.system, protocolOs.keys)
    if (items.length === 0) return false
    field = t.field
    doc = t.doc
    link = l
    open = { at, items }
    return true
  }

  $effect(() => {
    const onMenu = (e: MouseEvent): void => {
      if (e.defaultPrevented || !(e.target instanceof Element)) return
      // in a viewer document: the address under the pointer, or (a menu the keyboard asked for) at the cursor
      const cursor = pointerMenu(e, protocolOs.system) ? null : viewerCursorAt(e.target)
      const at = cursor?.at ?? { x: e.clientX, y: e.clientY }
      if (show(e.target, at, cursor ? cursor.link : viewerLinkAt(e.target, e.clientX, e.clientY), false)) e.preventDefault()
    }
    // the Menu key and ⇧F10 in a viewer document: at the main cursor, and no `contextmenu` follows
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || !menuKey(e) || !(e.target instanceof Element)) return
      const cursor = viewerCursorAt(e.target)
      if (!cursor) return
      e.preventDefault()
      show(e.target, cursor.at, cursor.link, false)
    }
    document.addEventListener('contextmenu', onMenu)
    document.addEventListener('keydown', onKey)
    setTextMenuOpener((el, at, l, linkOnly) => void show(el, at, l, linkOnly))
    return () => {
      document.removeEventListener('contextmenu', onMenu)
      document.removeEventListener('keydown', onKey)
      setTextMenuOpener(null)
    }
  })

  /** The pick, which runs once the menu has closed (`close` lets the target go once it has run). */
  function pick(id: string): void {
    const p = id as TextPick
    const f = field
    const d = doc
    const l = link
    if (p === 'openLink') {
      if (l?.url) void openWebLink(l.url)
      return
    }
    if (p === 'copyLink') {
      if (l) void copyText(l.text)
      return
    }
    if (d) {
      if (p === 'selectAll') return d.selectAll()
      d.focus()
      return editRole(p)
    }
    f?.focus()
    if (p === 'selectAll' && (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) return f.select()
    editRole(p)
  }

  function close(): void {
    open = null
    queueMicrotask(() => {
      if (open) return
      field = null
      doc = null
      link = null
    })
  }
</script>

{#if open}
  <Menu label="Text menu" items={open.items} at={open.at} onPick={pick} onClose={close} />
{/if}
