<!--
A modal: title, body, buttons, centred over the whole window on its backdrop (shell/modals.ts); nothing behind it takes
a pointer, a key or a command while it is open. The button marked `data-default` is the safe default and has focus;
Esc, or a press and its release both on the backdrop, cancels; Tab and ⇧Tab stay inside; the keyboard goes back where
it was when it closes. Locatable as `role=alertdialog` named by its title (`role=dialog` for one that confirms nothing,
such as a log); `label` names it otherwise (Settings says which page it shows), `class` adds to the box's own, `kind`
says it is Settings (whose own keys still run while it is on top).
-->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { modals, type ModalKind } from '../../shell/modals.ts'

  let p: { title: string; children: Snippet; buttons: Snippet; onCancel(): void; wide?: boolean; role?: 'alertdialog' | 'dialog'; label?: string; class?: string; kind?: ModalKind } = $props()
  let box: HTMLDivElement | undefined = $state()
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
  /** The layer, once in the host; whether the pointer went down and came up on the backdrop itself. */
  let layerEl: HTMLDivElement | null = null
  let downOnBackdrop = false
  let upOnBackdrop = false

  /**
   * The layer draws in the window's modal host, not where the modal is declared: that place keeps the hidden anchor,
   * so the block that declares it removes its own nodes as usual, and the layer goes with this attachment.
   */
  const intoHost: Attachment<HTMLDivElement> = (layer) =>
    untrack(() => {
      layerEl = layer
      ;(modals.host ?? document.body).append(layer)
      const closed = modals.opened(p.kind ?? 'confirm', layer, () => p.onCancel(), before)
      layer.querySelector<HTMLElement>('[data-default]')?.focus({ preventScroll: true })
      return () => {
        layerEl = null
        layer.remove()
        closed()
      }
    })

  const TABBABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

  /** Tab and ⇧Tab go round the box's controls and never leave it. */
  function wrapTab(e: KeyboardEvent): void {
    if (!box) return
    const stops = [...box.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0)
    if (stops.length === 0) {
      e.preventDefault()
      return
    }
    const first = stops[0]!
    const last = stops[stops.length - 1]!
    const at = document.activeElement
    if (e.shiftKey && (at === first || at === box)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && at === last) {
      e.preventDefault()
      first.focus()
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) wrapTab(e)
    // an Esc that ends an input method's composition closes nothing
    if (e.key !== 'Escape' || e.isComposing) return
    e.preventDefault()
    e.stopPropagation()
    p.onCancel()
  }
</script>

<div class="modal-anchor" hidden>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop is a pointer's
    way to cancel; Esc is the keyboard's) -->
  <div
    class="modal-layer"
    {@attach intoHost}
    onpointerdown={(e) => (downOnBackdrop = e.target === layerEl)}
    onpointerup={(e) => (upOnBackdrop = e.target === layerEl)}
    onclick={(e) => {
      // a press in the box released on the backdrop (or the reverse) also clicks the layer, their common ancestor
      const both = downOnBackdrop && upOnBackdrop && e.target === layerEl
      downOnBackdrop = upOnBackdrop = false
      if (both) p.onCancel()
    }}
  >
    <div
      bind:this={box}
      class="confirm-sheet{p.wide ? ' wide' : ''}{p.class ? ` ${p.class}` : ''}"
      role={p.role ?? 'alertdialog'}
      aria-label={p.label ?? p.title}
      aria-modal="true"
      tabindex="-1"
      onkeydown={onKey}
    >
      <h2 class="sheet-title">{p.title}</h2>
      <div class="sheet-body">{@render p.children()}</div>
      <div class="sheet-buttons">{@render p.buttons()}</div>
    </div>
  </div>
</div>
