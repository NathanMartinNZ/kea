<!--
A confirmation sheet at the top of the main pane: title, body, buttons; the button marked
`data-default` is the safe default and has focus; Esc cancels; focus goes back where it was when the sheet closes.
Locatable as `role=alertdialog` named by its title (`role=dialog` for a sheet that confirms nothing, such as a log);
`label` names it otherwise (Settings says which page it shows), `class` adds to the frame's own.
-->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte'

  let p: { title: string; children: Snippet; buttons: Snippet; onCancel(): void; wide?: boolean; role?: 'alertdialog' | 'dialog'; label?: string; class?: string } = $props()
  let el: HTMLDivElement | undefined = $state()
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null

  $effect(() => {
    untrack(() => el?.querySelector<HTMLElement>('[data-default]')?.focus())
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  })
</script>

<!-- svelte-ignore a11y_interactive_supports_focus (focus moves to the default control inside; the sheet itself is not a tab stop) -->
<div
  bind:this={el}
  class="confirm-sheet{p.wide ? ' wide' : ''}{p.class ? ` ${p.class}` : ''}"
  role={p.role ?? 'alertdialog'}
  aria-label={p.label ?? p.title}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      p.onCancel()
    }
  }}
>
  <h2 class="sheet-title">{p.title}</h2>
  <div class="sheet-body">{@render p.children()}</div>
  <div class="sheet-buttons">{@render p.buttons()}</div>
</div>
